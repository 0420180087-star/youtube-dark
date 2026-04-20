/**
 * 🎬 Video Renderer — FFmpeg-based server-side rendering
 * Handles both video URLs (Pexels) and image URLs with Ken Burns effects.
 * Produces professional MP4 output with crossfade transitions.
 */

import ffmpeg from 'fluent-ffmpeg';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { pipeline } from 'stream';

const streamPipeline = promisify(pipeline);

// ─── Download file with retries and validation ───────────────────────────────
export async function downloadFile(url, destPath, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 30000,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await streamPipeline(res.body, fs.createWriteStream(destPath));

      // Validate: file must be > 10KB to be a real video/image
      const stat = fs.statSync(destPath);
      if (stat.size < 10000) throw new Error(`File too small: ${stat.size} bytes`);
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

// ─── Check if a file is a valid video (has video stream) ─────────────────────
function probeVideo(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) { resolve(false); return; }
      const hasVideo = metadata?.streams?.some(s => s.codec_type === 'video');
      resolve(hasVideo || false);
    });
  });
}

// ─── Get video duration ───────────────────────────────────────────────────────
function getVideoDuration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) { resolve(null); return; }
      resolve(metadata?.format?.duration || null);
    });
  });
}

// ─── Convert image to video clip with Ken Burns effect ────────────────────────
function imageToVideoClip(imagePath, outputPath, duration, effect = 'zoom-in') {
  return new Promise((resolve, reject) => {
    // Ken Burns zoom/pan filters
    const filters = {
      'zoom-in':      "scale=8000:-2,zoompan=z='min(zoom+0.0015,1.5)':d=FRAMES:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080,scale=1920:1080",
      'zoom-out':     "scale=8000:-2,zoompan=z='if(lte(zoom,1.0),1.5,max(1.001,zoom-0.0015))':d=FRAMES:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080,scale=1920:1080",
      'pan-right':    "scale=8000:-2,zoompan=z=1.3:x='min(x+1,iw-iw/zoom)':y='ih/2-(ih/zoom/2)':d=FRAMES:s=1920x1080,scale=1920:1080",
      'pan-left':     "scale=8000:-2,zoompan=z=1.3:x='max(x-1,0)':y='ih/2-(ih/zoom/2)':d=FRAMES:s=1920x1080,scale=1920:1080",
      'zoom-in-fast': "scale=8000:-2,zoompan=z='min(zoom+0.003,1.8)':d=FRAMES:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080,scale=1920:1080",
    };

    const frames = Math.ceil(duration * 25); // 25fps for zoompan
    const filterStr = (filters[effect] || filters['zoom-in']).replace(/FRAMES/g, frames);

    ffmpeg()
      .input(imagePath)
      .inputOptions(['-loop', '1'])
      .videoFilter(filterStr)
      .outputOptions([
        '-t', String(duration),
        '-r', '30',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-an',
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ─── Trim a video to exact duration, keeping full video motion ───────────────
function trimVideo(inputPath, outputPath, duration) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-t', String(duration),
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-r', '30',
        '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080',
        '-an',
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ─── Concatenate clips with crossfade transitions ────────────────────────────
function concatenateWithCrossfade(clipPaths, outputPath, crossfadeDuration = 0.5) {
  return new Promise((resolve, reject) => {
    if (clipPaths.length === 1) {
      // Single clip — just copy it
      fs.copyFileSync(clipPaths[0], outputPath);
      return resolve();
    }

    // Build xfade filter chain for smooth transitions
    // xfade applies a crossfade between clips
    const inputs = clipPaths.map(p => ffmpeg().input(p));
    const cmd = ffmpeg();
    clipPaths.forEach(p => cmd.input(p));

    // Build filter_complex for N clips with crossfade
    // We need to know durations to calculate offsets
    Promise.all(clipPaths.map(p => getVideoDuration(p))).then(durations => {
      let filterComplex = '';
      let currentStream = '[0:v]';
      let offset = 0;

      for (let i = 1; i < clipPaths.length; i++) {
        const prevDur = durations[i - 1] || 5;
        offset += prevDur - crossfadeDuration;
        const nextStream = i === clipPaths.length - 1 ? '[outv]' : `[v${i}]`;
        filterComplex += `${currentStream}[${i}:v]xfade=transition=fade:duration=${crossfadeDuration}:offset=${offset.toFixed(3)}${nextStream};`;
        currentStream = `[v${i}]`;
        if (i === clipPaths.length - 1) break;
      }

      // Remove trailing semicolon
      filterComplex = filterComplex.replace(/;$/, '');

      // Fallback: if filter is empty (2 clips), handle directly
      if (filterComplex === '' && clipPaths.length === 2) {
        const dur0 = durations[0] || 5;
        filterComplex = `[0:v][1:v]xfade=transition=fade:duration=${crossfadeDuration}:offset=${(dur0 - crossfadeDuration).toFixed(3)}[outv]`;
      }

      cmd
        .complexFilter(filterComplex)
        .outputOptions([
          '-map', '[outv]',
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '20',
          '-pix_fmt', 'yuv420p',
          '-r', '30',
          '-an',
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', (err) => {
          // Fallback: simple concat without crossfade
          console.warn('  ⚠️ Crossfade failed, using simple concat:', err.message);
          simpleConcat(clipPaths, outputPath).then(resolve).catch(reject);
        })
        .run();
    }).catch(reject);
  });
}

// ─── Simple concat fallback ───────────────────────────────────────────────────
function simpleConcat(clipPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const listFile = outputPath + '.txt';
    fs.writeFileSync(listFile, clipPaths.map(p => `file '${path.resolve(p)}'`).join('\n'));
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy', '-an'])
      .output(outputPath)
      .on('end', () => { try { fs.unlinkSync(listFile); } catch {} resolve(); })
      .on('error', reject)
      .run();
  });
}

// ─── Mix narration + background music ────────────────────────────────────────
function mixAudio(videoPath, voicePath, musicPath, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(videoPath).input(voicePath);

    if (musicPath && fs.existsSync(musicPath)) {
      cmd
        .input(musicPath)
        .complexFilter([
          '[1:a]volume=1.0[voice]',
          '[2:a]volume=0.12,aloop=loop=-1:size=2e+09[music]',
          '[voice][music]amix=inputs=2:duration=first:dropout_transition=2[audio]',
        ])
        .outputOptions(['-map', '0:v', '-map', '[audio]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest']);
    } else {
      cmd
        .complexFilter(['[1:a]volume=1.0[audio]'])
        .outputOptions(['-map', '0:v', '-map', '[audio]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest']);
    }

    cmd
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ─── Main render function ─────────────────────────────────────────────────────
export async function renderVideo({ visuals, segments, audioBase64, musicUrl, thumbnailBase64, tmpDir }) {
  fs.mkdirSync(tmpDir, { recursive: true });

  const processedClips = [];

  for (let i = 0; i < visuals.length; i++) {
    const visual = visuals[i];
    const segment = segments[i] || segments[segments.length - 1];
    const duration = Math.max(2, segment.estimatedDuration || 5);

    if (!visual?.url) {
      console.warn(`  ⚠️ Clipe ${i + 1}: sem URL, pulando`);
      continue;
    }

    console.log(`  🎬 Processando clipe ${i + 1}/${visuals.length} — ${duration.toFixed(1)}s...`);

    const rawPath = path.join(tmpDir, `raw_${i}`);
    const outPath = path.join(tmpDir, `clip_${i}.mp4`);

    try {
      // Download the file (video or image)
      await downloadFile(visual.url, rawPath);

      // Probe to check if it's a real video
      const isVideo = await probeVideo(rawPath);

      if (isVideo) {
        // It's a Pexels video — trim to needed duration, keep natural motion
        console.log(`    ✅ Vídeo real detectado — trimando para ${duration.toFixed(1)}s`);
        await trimVideo(rawPath, outPath, duration);
      } else {
        // It's an image — apply Ken Burns animation
        console.log(`    🖼️ Imagem detectada — aplicando Ken Burns`);
        // Rename to add extension so ffmpeg handles it correctly
        const imgPath = rawPath + '.jpg';
        fs.renameSync(rawPath, imgPath);
        await imageToVideoClip(imgPath, outPath, duration, visual.effect || 'zoom-in');
      }

      processedClips.push(outPath);
    } catch (err) {
      console.warn(`  ⚠️ Clipe ${i + 1} falhou: ${err.message}. Usando placeholder...`);
      // Generate a solid color placeholder clip instead of skipping
      try {
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input('color=c=black:s=1920x1080:r=30')
            .inputOptions(['-f', 'lavfi'])
            .outputOptions(['-t', String(duration), '-c:v', 'libx264', '-crf', '28', '-an'])
            .output(outPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });
        processedClips.push(outPath);
      } catch {}
    }
  }

  if (processedClips.length === 0) throw new Error('Nenhum clipe processado com sucesso');

  // Concatenate all clips with crossfade transitions
  console.log(`  🔗 Concatenando ${processedClips.length} clipes com crossfade...`);
  const concatPath = path.join(tmpDir, 'concat.mp4');
  await concatenateWithCrossfade(processedClips, concatPath, 0.4);

  // Save narration audio
  console.log('  🎙️ Adicionando narração...');
  const voicePath = path.join(tmpDir, 'voice.pcm');
  fs.writeFileSync(voicePath, Buffer.from(audioBase64, 'base64'));

  // Convert PCM to usable audio format
  const voiceConvPath = path.join(tmpDir, 'voice.mp3');
  await new Promise((resolve, reject) => {
    ffmpeg(voicePath)
      .inputOptions(['-f', 's16le', '-ar', '24000', '-ac', '1'])
      .outputOptions(['-c:a', 'libmp3lame', '-b:a', '128k'])
      .output(voiceConvPath)
      .on('end', resolve)
      .on('error', (err) => {
        // Try as raw audio if PCM conversion fails
        fs.copyFileSync(voicePath, voiceConvPath);
        resolve();
      })
      .run();
  });

  // Download background music if provided
  let musicPath = null;
  if (musicUrl) {
    try {
      musicPath = path.join(tmpDir, 'music.mp3');
      await downloadFile(musicUrl, musicPath);
      console.log('  🎵 Música de fundo adicionada');
    } catch {
      console.warn('  ⚠️ Música de fundo não disponível');
      musicPath = null;
    }
  }

  // Mix audio over video
  const mixedPath = path.join(tmpDir, 'mixed.mp4');
  await mixAudio(concatPath, voiceConvPath, musicPath, mixedPath);

  console.log('  ✅ Renderização concluída!');
  return { videoPath: mixedPath, tmpDir };
}

// Cleanup temp files
export function cleanupTmp(tmpDir) {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('  🧹 Arquivos temporários removidos');
  }
}
