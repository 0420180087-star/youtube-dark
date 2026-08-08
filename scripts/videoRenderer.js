/**
 * 🎬 Video Renderer — FFmpeg-based server-side rendering
 * Handles both video URLs (Pexels) and image URLs with Ken Burns effects.
 * Produces professional MP4 output with crossfade transitions.
 */

import ffmpeg from 'fluent-ffmpeg';
// fetch é nativo no Node 18+ — node-fetch removido
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { pipeline, Readable } from 'stream';

const streamPipeline = promisify(pipeline);

// ─── Download file with retries and validation ───────────────────────────────
export async function downloadFile(url, destPath, retries = 3) {
  if (/^data:/i.test(url)) {
    // Aceita parâmetros no mime (ex.: data:image/svg+xml;charset=utf-8,...)
    const match = String(url).match(/^data:([^,]*?)(;base64)?,(.*)$/s);
    if (!match) throw new Error('Invalid data URL');
    const isBase64 = Boolean(match[2]);
    const payload = match[3] || '';
    const buffer = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    if (buffer.length < 100) throw new Error(`Data URL too small: ${buffer.length} bytes`);
    fs.writeFileSync(destPath, buffer);
    return;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = typeof res.body?.getReader === 'function' ? Readable.fromWeb(res.body) : res.body;
      await streamPipeline(body, fs.createWriteStream(destPath));

      // Validate: file must be non-empty. Some generated SVG/JPEG fallbacks are
      // legitimately small, so do not reject them solely for being under 10KB.
      const stat = fs.statSync(destPath);
      if (stat.size < 100) throw new Error(`File too small: ${stat.size} bytes`);
      return;
    } catch (err) {
      clearTimeout(timer);
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

function extensionForUrl(url, fallback = '.jpg') {
  const dataMime = String(url || '').match(/^data:([^;,]+)/i)?.[1]?.toLowerCase() || '';
  if (dataMime.includes('svg')) return '.svg';
  if (dataMime.includes('png')) return '.png';
  if (dataMime.includes('webp')) return '.webp';
  if (dataMime.includes('gif')) return '.gif';
  if (dataMime.includes('jpeg') || dataMime.includes('jpg')) return '.jpg';
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const ext = path.extname(pathname);
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.mp4', '.mov', '.webm'].includes(ext)) return ext;
  } catch {}
  return fallback;
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
    ffmpeg()
      .input(inputPath)
      .inputOptions(['-stream_loop', '-1'])
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

    const cmd = ffmpeg();
    clipPaths.forEach(p => cmd.input(p));

    Promise.all(clipPaths.map(p => getVideoDuration(p))).then(durations => {
      const dur = clipPaths.map((_, i) => Math.max(0.2, Number(durations[i]) || 5));

      // Offset cumulativo que nunca regride: cada transição usa um crossfade
      // seguro (mín. 0.15s, máx. 40% do menor clipe do par).
      let filterComplex = '';
      let currentStream = '[0:v]';
      let timeline = dur[0];

      for (let i = 1; i < clipPaths.length; i++) {
        const safeXfade = Math.max(0.15, Math.min(crossfadeDuration, Math.min(dur[i - 1], dur[i]) * 0.4));
        const offset = Math.max(0, timeline - safeXfade);
        const nextStream = i === clipPaths.length - 1 ? '[outv]' : `[v${i}]`;
        filterComplex += `${currentStream}[${i}:v]xfade=transition=fade:duration=${safeXfade.toFixed(3)}:offset=${offset.toFixed(3)}${nextStream};`;
        currentStream = nextStream;
        timeline = offset + safeXfade + dur[i] - safeXfade; // = offset + dur[i]
      }

      filterComplex = filterComplex.replace(/;$/, '');

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

// ─── Simple concat fallback (re-encode: stream copy trava com streams diferentes) ──
function simpleConcat(clipPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const listFile = outputPath + '.txt';
    fs.writeFileSync(listFile, clipPaths.map(p => `file '${path.resolve(p)}'`).join('\n'));
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-an'])
      .output(outputPath)
      .on('end', () => { try { fs.unlinkSync(listFile); } catch {} resolve(); })
      .on('error', reject)
      .run();
  });
}

// ─── Placeholder clip (gradiente animado) via FFmpeg direto ──────────────────
// fluent-ffmpeg rejeita `-f lavfi` (não aparece na lista de formatos dele),
// por isso o spawn direto do binário.
const PLACEHOLDER_COLORS = [
  ['0x152238', '0xd97706'], ['0x1f2937', '0x14b8a6'], ['0x111827', '0xef4444'], ['0x172554', '0xfacc15'],
  ['0x0f172a', '0x2563eb'], ['0x1c1917', '0xf97316'], ['0x0b2b26', '0x22c55e'], ['0x2e1065', '0xa855f7'],
  ['0x1e1b4b', '0x38bdf8'], ['0x450a0a', '0xfb7185'],
];

export function makePlaceholderClip(outputPath, duration, seed = 0) {
  const s = Math.abs(Math.trunc(Number(seed) || 0));
  const [c0, c1] = PLACEHOLDER_COLORS[s % PLACEHOLDER_COLORS.length];
  const layout = Math.floor(s / 10) % 4;
  const coords = [
    'x0=0:y0=0:x1=1920:y1=1080',
    'x0=1920:y0=0:x1=0:y1=1080',
    'x0=960:y0=0:x1=960:y1=1080',
    'x0=0:y0=540:x1=1920:y1=540',
  ][layout];
  const args = [
    '-y', '-f', 'lavfi',
    '-i', `gradients=s=1920x1080:r=30:c0=${c0}:c1=${c1}:${coords}:speed=0.015:duration=${duration}`,
    '-t', String(duration),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p', '-r', '30', '-an',
    outputPath,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += String(d).slice(0, 2000); });
    proc.on('error', reject);
    proc.on('close', code => code === 0
      ? resolve()
      : reject(new Error(`ffmpeg placeholder exit ${code}: ${stderr.slice(-300)}`)));
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
export async function renderVideo({ visuals, segments, audioBase64, audioMimeType = 'audio/pcm', musicUrl, thumbnailBase64, tmpDir }) {
  fs.mkdirSync(tmpDir, { recursive: true });

  const processedClips = [];

  for (let i = 0; i < visuals.length; i++) {
    const visual = visuals[i];
    const segment = segments[i] || segments[segments.length - 1] || {};
    const duration = Math.max(2, Number(visual.duration) || Number(segment.estimatedDuration) || 5);

    if (!visual?.url) {
      console.warn(`  ⚠️ Clipe ${i + 1}: sem URL, pulando`);
      continue;
    }

    console.log(`  🎬 Processando clipe ${i + 1}/${visuals.length} — ${duration.toFixed(1)}s...`);

    const rawPath = path.join(tmpDir, `raw_${i}`);
    const outPath = path.join(tmpDir, `clip_${i}.mp4`);

    const isSvg = /^data:image\/svg/i.test(visual.url) || extensionForUrl(visual.url, '') === '.svg';

    try {
      if (isSvg) {
        // FFmpeg normalmente é compilado sem librsvg — SVG não decodifica.
        // Gera um clipe animado equivalente direto no FFmpeg, variando por índice.
        console.log('    🎨 Fallback SVG detectado — gerando clipe de gradiente animado');
        await makePlaceholderClip(outPath, duration, i);
        processedClips.push(outPath);
        continue;
      }

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
        // Rename to add extension so ffmpeg handles the real image type correctly
        const imgPath = rawPath + extensionForUrl(visual.url, '.jpg');
        fs.renameSync(rawPath, imgPath);
        await imageToVideoClip(imgPath, outPath, duration, visual.effect || 'zoom-in');
      }

      processedClips.push(outPath);
    } catch (err) {
      console.warn(`  ⚠️ Clipe ${i + 1} falhou: ${err.message}. Usando placeholder visual...`);
      // Generate a non-black, varied placeholder clip instead of skipping
      try {
        await makePlaceholderClip(outPath, duration, i);
        processedClips.push(outPath);
      } catch (e2) { console.warn(`  ⚠️ Placeholder do clipe ${i + 1} falhou: ${e2.message}`); }
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

  // Converte áudio para MP3 — formato depende do mimeType retornado pelo Gemini TTS
  // audio/pcm ou audio/L16 → raw PCM s16le 24000Hz mono
  // audio/wav              → WAV padrão, FFmpeg detecta automaticamente
  const voiceConvPath = path.join(tmpDir, 'voice.mp3');
  const isRawPcm = !audioMimeType || audioMimeType.includes('pcm') || audioMimeType.includes('L16');

  await new Promise((resolve, reject) => {
    const cmd = ffmpeg(voicePath);
    if (isRawPcm) {
      cmd.inputOptions(['-f', 's16le', '-ar', '24000', '-ac', '1']);
    }
    cmd
      .outputOptions(['-c:a', 'libmp3lame', '-b:a', '128k'])
      .output(voiceConvPath)
      .on('end', resolve)
      .on('error', (err) => {
        console.warn('  ⚠️ Conversão de áudio falhou, tentando sem inputOptions:', err.message);
        // Fallback: tenta sem forçar formato de entrada
        ffmpeg(voicePath)
          .outputOptions(['-c:a', 'libmp3lame', '-b:a', '128k'])
          .output(voiceConvPath)
          .on('end', resolve)
          .on('error', () => { fs.copyFileSync(voicePath, voiceConvPath); resolve(); })
          .run();
      })
      .run();
  });

  // Background music: accept either a remote URL or a local file path already on disk
  let musicPath = null;
  if (musicUrl) {
    try {
      if (/^https?:\/\//i.test(musicUrl)) {
        musicPath = path.join(tmpDir, 'music.mp3');
        await downloadFile(musicUrl, musicPath);
        console.log('  🎵 Música de fundo (download) adicionada');
      } else if (fs.existsSync(musicUrl)) {
        musicPath = musicUrl;
        console.log('  🎵 Música de fundo (local) adicionada');
      } else {
        console.warn('  ⚠️ musicUrl inválido — sem música de fundo');
      }
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
