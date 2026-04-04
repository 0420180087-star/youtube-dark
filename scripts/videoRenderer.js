/**
 * 🎬 Video Renderer — FFmpeg-based server-side rendering
 * Replaces browser Canvas+WebAudio rendering for GitHub Actions pipeline.
 */

import ffmpeg from 'fluent-ffmpeg';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { pipeline } from 'stream';

const streamPipeline = promisify(pipeline);

// Mapeia efeitos visuais para filtros FFmpeg
const EFFECT_FILTERS = {
  'zoom-in':      "scale=8000:-1,zoompan=z='min(zoom+0.0015,1.5)':d=125:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080",
  'zoom-out':     "scale=8000:-1,zoompan=z='if(lte(zoom,1.0),1.5,max(1.001,zoom-0.0015))':d=125:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080",
  'pan-left':     "scale=8000:-1,zoompan=z=1.3:x='if(gte(x,iw/10),x-2,iw/2)':y='ih/2-(ih/zoom/2)':d=125:s=1920x1080",
  'pan-right':    "scale=8000:-1,zoompan=z=1.3:x='if(lte(x,iw-iw/zoom),x+2,iw/2)':y='ih/2-(ih/zoom/2)':d=125:s=1920x1080",
  'zoom-in-fast': "scale=8000:-1,zoompan=z='min(zoom+0.003,1.8)':d=125:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080",
  'cinematic':    "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080",
  'default':      "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080",
};

// Baixa um arquivo de URL para o disco local
export async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar: ${url} — ${res.status}`);
  await streamPipeline(res.body, fs.createWriteStream(destPath));
}

// Corta um clipe de vídeo na duração exata
export function trimClip(inputPath, outputPath, duration) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setDuration(duration)
      .outputOptions(['-an', '-avoid_negative_ts', 'make_zero'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Aplica efeito de zoom/pan em um clipe
export function applyEffect(inputPath, outputPath, effect, duration) {
  const filter = EFFECT_FILTERS[effect] || EFFECT_FILTERS['default'];
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setDuration(duration)
      .videoFilter(filter)
      .outputOptions([
        '-r', '30',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-an',
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Concatena todos os clipes em um único vídeo
export function concatenateClips(clipPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const listFile = outputPath + '.txt';
    const content = clipPaths.map((p) => `file '${path.resolve(p)}'`).join('\n');
    fs.writeFileSync(listFile, content);

    ffmpeg()
      .input(listFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy', '-an'])
      .output(outputPath)
      .on('end', () => {
        fs.unlinkSync(listFile);
        resolve();
      })
      .on('error', reject)
      .run();
  });
}

// Mistura narração + música de fundo sobre o vídeo
export function mixAudio(videoPath, voicePath, musicPath, outputPath) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(videoPath).input(voicePath);

    if (musicPath && fs.existsSync(musicPath)) {
      command
        .input(musicPath)
        .complexFilter([
          '[1:a]volume=1.0[voice]',
          '[2:a]volume=0.15,aloop=loop=-1:size=2e+09[music]',
          '[voice][music]amix=inputs=2:duration=first[audio]',
        ])
        .outputOptions([
          '-map', '0:v',
          '-map', '[audio]',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-shortest',
        ]);
    } else {
      command
        .complexFilter(['[1:a]volume=1.0[audio]'])
        .outputOptions([
          '-map', '0:v',
          '-map', '[audio]',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-shortest',
        ]);
    }

    command
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Adiciona thumbnail como frame inicial de 2 segundos
export function addThumbnailIntro(thumbnailPath, videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(thumbnailPath)
      .inputOptions(['-loop', '1', '-t', '2', '-r', '30'])
      .input(videoPath)
      .complexFilter([
        '[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080[thumb]',
        '[thumb][1:v]concat=n=2:v=1:a=0[outv]',
      ])
      .outputOptions([
        '-map', '[outv]',
        '-map', '1:a',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-shortest',
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Função principal — orquestra toda a renderização
export async function renderVideo({ visuals, segments, audioBase64, musicUrl, thumbnailBase64, tmpDir }) {
  fs.mkdirSync(tmpDir, { recursive: true });

  const processedClips = [];

  // 1. Baixar e processar cada clipe
  for (let i = 0; i < visuals.length; i++) {
    const visual = visuals[i];
    const segment = segments[i] || segments[segments.length - 1];
    const duration = segment.estimatedDuration || 5;

    if (!visual?.url) continue;

    console.log(`  🎬 Processando clipe ${i + 1}/${visuals.length}...`);

    const rawPath = path.join(tmpDir, `raw_${i}.mp4`);
    const trimPath = path.join(tmpDir, `trim_${i}.mp4`);
    const fxPath = path.join(tmpDir, `fx_${i}.mp4`);

    try {
      await downloadFile(visual.url, rawPath);
      await trimClip(rawPath, trimPath, duration);
      await applyEffect(trimPath, fxPath, visual.effect || 'zoom-in', duration);
      processedClips.push(fxPath);
    } catch (err) {
      console.warn(`  ⚠️ Clipe ${i + 1} falhou, pulando: ${err.message}`);
    }
  }

  if (processedClips.length === 0) throw new Error('Nenhum clipe processado com sucesso');

  // 2. Concatenar todos os clipes
  console.log('  🔗 Concatenando clipes...');
  const concatPath = path.join(tmpDir, 'concat.mp4');
  await concatenateClips(processedClips, concatPath);

  // 3. Salvar áudio da narração
  console.log('  🎙️ Adicionando narração...');
  const voicePath = path.join(tmpDir, 'voice.mp3');
  fs.writeFileSync(voicePath, Buffer.from(audioBase64, 'base64'));

  // 4. Baixar música de fundo (se houver)
  let musicPath = null;
  if (musicUrl) {
    try {
      musicPath = path.join(tmpDir, 'music.mp3');
      await downloadFile(musicUrl, musicPath);
      console.log('  🎵 Música de fundo adicionada');
    } catch {
      console.warn('  ⚠️ Música de fundo não disponível, continuando sem ela');
    }
  }

  // 5. Mixar áudio
  const mixedPath = path.join(tmpDir, 'mixed.mp4');
  await mixAudio(concatPath, voicePath, musicPath, mixedPath);

  // 6. Adicionar thumbnail como intro (se houver)
  let finalPath = mixedPath;
  if (thumbnailBase64) {
    try {
      console.log('  🖼️ Adicionando thumbnail como intro...');
      const thumbPath = path.join(tmpDir, 'thumbnail.jpg');
      fs.writeFileSync(thumbPath, Buffer.from(thumbnailBase64, 'base64'));
      const withThumbPath = path.join(tmpDir, 'final_with_thumb.mp4');
      await addThumbnailIntro(thumbPath, mixedPath, withThumbPath);
      finalPath = withThumbPath;
    } catch {
      console.warn('  ⚠️ Thumbnail intro falhou, usando vídeo sem ela');
    }
  }

  console.log('  ✅ Renderização concluída!');
  return finalPath;
}

// Limpa todos os arquivos temporários
export function cleanupTmp(tmpDir) {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('  🧹 Arquivos temporários removidos');
  }
}
