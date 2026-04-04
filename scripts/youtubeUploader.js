/**
 * 📤 YouTube Uploader — Resumable upload via YouTube Data API v3
 * Used by the GitHub Actions automation runner.
 */

import fetch from 'node-fetch';
import fs from 'fs';
import FormData from 'form-data';

// Renova o access token usando o refresh token
export async function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Falha ao renovar token: ${JSON.stringify(data)}`);
  return data.access_token;
}

// Faz upload do vídeo para o YouTube (resumable upload)
export async function uploadVideoFile(accessToken, videoPath, metadata) {
  const fileSize = fs.statSync(videoPath).size;
  console.log(`  📤 Iniciando upload — ${(fileSize / 1024 / 1024).toFixed(1)}MB`);

  // Etapa 1: inicia o upload resumável
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(fileSize),
      },
      body: JSON.stringify({
        snippet: {
          title: metadata.youtubeTitle || metadata.title,
          description: metadata.youtubeDescription || metadata.description,
          tags: metadata.tags || [],
          categoryId: metadata.categoryId || '22',
        },
        status: {
          privacyStatus: metadata.visibility || 'public',
          selfDeclaredMadeForKids: false,
        },
      }),
    }
  );

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) {
    const errBody = await initRes.text();
    throw new Error(`YouTube não retornou URL de upload: ${initRes.status} ${errBody}`);
  }

  // Etapa 2: envia o arquivo
  const fileStream = fs.createReadStream(videoPath);
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(fileSize),
    },
    body: fileStream,
  });

  const result = await uploadRes.json();
  if (!result.id) throw new Error(`Upload falhou: ${JSON.stringify(result)}`);

  console.log(`  ✅ Upload concluído: https://youtube.com/watch?v=${result.id}`);
  return { videoUrl: `https://youtube.com/watch?v=${result.id}`, videoId: result.id };
}

// Faz upload da thumbnail para o vídeo já publicado
export async function uploadThumbnail(accessToken, videoId, thumbnailBase64) {
  if (!thumbnailBase64) return;
  try {
    const buffer = Buffer.from(thumbnailBase64, 'base64');
    const form = new FormData();
    form.append('image', buffer, { filename: 'thumbnail.jpg', contentType: 'image/jpeg' });

    await fetch(
      `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, ...form.getHeaders() },
        body: form,
      }
    );
    console.log('  🖼️ Thumbnail do YouTube atualizada');
  } catch (err) {
    console.warn('  ⚠️ Thumbnail upload falhou:', err.message);
  }
}
