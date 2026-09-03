/**
 * 📤 YouTube Uploader — Resumable upload via YouTube Data API v3
 * Used by the GitHub Actions automation runner.
 */

// fetch é nativo no Node 18+ — node-fetch removido
import fs from 'fs';

// Timeouts explícitos: nenhuma chamada de rede pode ficar pendurada até o
// limite de 120 min do job do GitHub Actions.
const TIMEOUT = {
  TOKEN: 30_000,
  INIT: 60_000,
  UPLOAD: 15 * 60_000,
  THUMBNAIL: 60_000,
};

const withTimeout = (ms) => AbortSignal.timeout(ms);

// Renova o access token usando o refresh token
export async function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: withTimeout(TIMEOUT.TOKEN),
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


// Reconciliação anti-duplicata: procura nos uploads recentes do canal um vídeo
// com o mesmo título. Usado quando um upload pode ter dado certo mas a gravação
// do youtubeUrl falhou — sem isso a retomada publicaria o vídeo duas vezes.
export async function findRecentUploadByTitle(accessToken, title) {
  const norm = (s) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const target = norm(title);
  if (!target) return null;

  const api = async (url) => {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: withTimeout(TIMEOUT.INIT),
    });
    if (!res.ok) throw new Error(`YouTube API ${res.status}: ${await res.text()}`);
    return res.json();
  };

  // uploads playlist do canal autenticado → últimos 25 vídeos (inclui privados)
  const channels = await api('https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true');
  const uploadsId = channels?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) return null;

  const list = await api(
    `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=25&playlistId=${uploadsId}`
  );
  const match = (list?.items || []).find((it) => norm(it?.snippet?.title) === target);
  if (!match) return null;

  const videoId = match.snippet?.resourceId?.videoId;
  if (!videoId) return null;
  return { videoId, videoUrl: `https://youtube.com/watch?v=${videoId}` };
}


export async function uploadVideoFile(accessToken, videoPath, metadata) {
  const fileSize = fs.statSync(videoPath).size;
  console.log(`  📤 Iniciando upload — ${(fileSize / 1024 / 1024).toFixed(1)}MB`);

  const rawVisibility = String(metadata.visibility || 'public').toLowerCase();
  const privacyStatus = ['public', 'private', 'unlisted'].includes(rawVisibility) ? rawVisibility : 'public';

  // Etapa 1: inicia o upload resumável
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      signal: withTimeout(TIMEOUT.INIT),
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
          privacyStatus,
          selfDeclaredMadeForKids: false,
        },
      }),
    }
  );

  if (!initRes.ok) {
    const errBody = await initRes.text().catch(() => '');
    throw new Error(`Falha ao iniciar upload YouTube: HTTP ${initRes.status} ${errBody}`);
  }

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) {
    const errBody = await initRes.text();
    throw new Error(`YouTube não retornou URL de upload: ${initRes.status} ${errBody}`);
  }

  // Etapa 2: envia o arquivo
  const fileBuffer = fs.readFileSync(videoPath);
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    signal: withTimeout(TIMEOUT.UPLOAD),
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(fileSize),
    },
    body: fileBuffer,
  });


  const uploadBody = await uploadRes.text().catch(() => '');
  let result = {};
  try { result = uploadBody ? JSON.parse(uploadBody) : {}; } catch { result = { error: uploadBody }; }
  if (!result.id) throw new Error(`Upload falhou: ${JSON.stringify(result)}`);

  console.log(`  ✅ Upload concluído: https://youtube.com/watch?v=${result.id}`);
  return { videoUrl: `https://youtube.com/watch?v=${result.id}`, videoId: result.id };
}

// Faz upload da thumbnail para o vídeo já publicado
export async function uploadThumbnail(accessToken, videoId, thumbnailBase64) {
  if (!thumbnailBase64) return;
  try {
    const cleanBase64 = thumbnailBase64.includes(',')
      ? thumbnailBase64.split(',').pop()
      : thumbnailBase64;
    const buffer = Buffer.from(cleanBase64, 'base64');

    const res = await fetch(
      `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`,
      {
        method: 'POST',
        signal: withTimeout(TIMEOUT.THUMBNAIL),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'image/jpeg',
          'Content-Length': String(buffer.length),
        },
        body: buffer,
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`  ⚠️ Thumbnail upload falhou: HTTP ${res.status} ${text.slice(0, 300)}`);
      return;
    }

    console.log('  🖼️ Thumbnail do YouTube atualizada');
  } catch (err) {
    console.warn('  ⚠️ Thumbnail upload falhou:', err.message);
  }
}
