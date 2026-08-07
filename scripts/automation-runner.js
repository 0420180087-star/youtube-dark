/**
 * 🤖 Automation Runner — GitHub Actions Pipeline
 * Fully autonomous: generates idea → script → voice → visuals → thumbnail → metadata → render → upload.
 * Runs as a standalone Node.js script via GitHub Actions cron — NO browser needed.
 */

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import axios from 'axios';

// WebSocket polyfill para Node 20 (Node 22 tem nativo)
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = ws;
}
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawn } from 'child_process';
import { renderVideo, cleanupTmp } from './videoRenderer.js';
import { refreshAccessToken, uploadVideoFile, uploadThumbnail } from './youtubeUploader.js';

// --- ENV ---
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  VITE_SUPABASE_URL,
  GEMINI_API_KEY: ENV_GEMINI_API_KEY,
  VITE_GEMINI_API_KEY,
  PEXELS_API_KEY: ENV_PEXELS_API_KEY,
  VITE_PEXELS_API_KEY,
  YOUTUBE_CLIENT_ID: ENV_YOUTUBE_CLIENT_ID,
  VITE_GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET,
  PROJECT_ID,
} = process.env;

const ACTIVE_SUPABASE_URL = SUPABASE_URL || VITE_SUPABASE_URL;
const ACTIVE_SUPABASE_SERVICE_KEY = SUPABASE_SERVICE_KEY || SUPABASE_SERVICE_ROLE_KEY;
const YOUTUBE_CLIENT_ID = ENV_YOUTUBE_CLIENT_ID || GOOGLE_CLIENT_ID || VITE_GOOGLE_CLIENT_ID;

if (!ACTIVE_SUPABASE_URL || !ACTIVE_SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing required environment variables (SUPABASE_URL, SUPABASE_SERVICE_KEY)');
  process.exit(1);
}

const supabase = createClient(ACTIVE_SUPABASE_URL, ACTIVE_SUPABASE_SERVICE_KEY);

// --- SCHEMA PREFLIGHT ---
// The runner must never die because the database is incomplete. It probes each
// dependency once, prints a single actionable block, and degrades gracefully.
const SCHEMA = {
  projects: true,
  project_auth: true,
  user_settings: true,
  autopilot_logs: true,
  automation_heartbeat: true,
  lockRpc: true,
};

async function tableExists(name) {
  const { error } = await supabase.from(name).select('*').limit(1);
  if (!error) return true;
  const msg = (error.message || '').toLowerCase();
  // 42P01 = undefined_table, 42501/permission = missing GRANT — both mean "run bootstrap.sql"
  if (msg.includes('does not exist') || msg.includes('permission denied') || error.code === '42P01') return false;
  // Unknown error (network etc.) — assume present so we don't disable features wrongly
  return true;
}

async function preflight() {
  const missing = [];

  for (const name of ['projects', 'project_auth', 'user_settings', 'autopilot_logs', 'automation_heartbeat']) {
    SCHEMA[name] = await tableExists(name);
    if (!SCHEMA[name]) missing.push(`tabela ${name}`);
  }

  // Probe the lock RPC with a project id that cannot exist: a working RPC
  // returns false, a missing one returns a 404/undefined-function error.
  const { error: lockErr } = await supabase.rpc('acquire_autopilot_lock', {
    p_project_id: '__preflight_probe__',
    p_locked_by: 'preflight',
    p_lock_minutes: 1,
  });
  if (lockErr) {
    SCHEMA.lockRpc = false;
    missing.push('função acquire_autopilot_lock');
  }

  if (missing.length) {
    console.error('');
    console.error('════════════════════════════════════════════════════════════════');
    console.error('⚠️  PREFLIGHT FALHOU — schema incompleto no Supabase');
    console.error('    Faltando: ' + missing.join(', '));
    console.error('');
    console.error('    CORREÇÃO: abra o SQL Editor do Supabase e execute o arquivo');
    console.error('              supabase/bootstrap.sql (inteiro, é idempotente).');
    console.error('════════════════════════════════════════════════════════════════');
    console.error('');
  }

  if (!SCHEMA.projects) {
    console.error('❌ Sem a tabela "projects" o runner não tem o que processar. Abortando.');
    return false;
  }
  if (!SCHEMA.lockRpc) {
    log('🔁', 'Lock RPC ausente — usando lock por coluna (fallback degradado).');
  }
  if (!SCHEMA.user_settings) {
    log('🔁', 'Tabela user_settings ausente — usando chaves de API do ambiente.');
  }
  return true;
}

// --- DISTRIBUTED LOCK (com fallback sem RPC) ---

async function acquireLock(projectId, lockMinutes = 90) {
  if (SCHEMA.lockRpc) {
    const { data, error } = await supabase.rpc('acquire_autopilot_lock', {
      p_project_id: String(projectId),
      p_locked_by: 'github-actions',
      p_lock_minutes: lockMinutes,
    });
    if (!error) return { acquired: data === true, error: null };
    SCHEMA.lockRpc = false;
    log('🔁', `Lock RPC falhou (${error.message}) — caindo para lock por coluna.`);
  }

  // Fallback: conditional UPDATE on the lock columns (same semantics as the RPC).
  const nowIso = new Date().toISOString();
  const untilIso = new Date(Date.now() + lockMinutes * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('projects')
    .update({
      autopilot_locked_until: untilIso,
      autopilot_locked_by: 'github-actions',
      updated_at: nowIso,
    })
    .eq('id', String(projectId))
    .or(`autopilot_locked_until.is.null,autopilot_locked_until.lt.${nowIso}`)
    .select('id');

  if (error) {
    // Lock columns missing too — run unlocked rather than never running at all.
    log('⚠️', `Lock indisponível (${error.message}) — prosseguindo sem lock.`);
    return { acquired: true, error: null };
  }
  return { acquired: (data?.length || 0) > 0, error: null };
}

async function releaseLock(projectId) {
  try {
    if (SCHEMA.lockRpc) {
      const { error } = await supabase.rpc('release_autopilot_lock', { p_project_id: String(projectId) });
      if (!error) return;
    }
    await supabase
      .from('projects')
      .update({ autopilot_locked_until: null, autopilot_locked_by: null })
      .eq('id', String(projectId));
  } catch (e) {
    log('⚠️', `Failed to release autopilot lock for ${projectId}: ${e.message}`);
  }
}

// --- HEARTBEAT ---
// Lets the app prove the headless runner is alive. Without this, "enqueued for
// headless" is indistinguishable from "secrets missing, nothing ever runs".
async function writeHeartbeat(detail) {
  if (!SCHEMA.automation_heartbeat) return;
  try {
    await supabase.from('automation_heartbeat').upsert({
      runner: 'github-actions',
      last_seen_at: new Date().toISOString(),
      detail: String(detail || '').slice(0, 500),
    }, { onConflict: 'runner' });
  } catch { /* non-fatal */ }
}


// Per-run mutable keys — populated from user_settings before each project runs.
// Falls back to ENV if no per-user key is configured.
let GEMINI_API_KEY = ENV_GEMINI_API_KEY || VITE_GEMINI_API_KEY || '';
let GEMINI_API_KEYS = GEMINI_API_KEY ? [GEMINI_API_KEY] : [];
let GEMINI_KEY_INDEX = 0;
let PEXELS_API_KEY = ENV_PEXELS_API_KEY || VITE_PEXELS_API_KEY || '';

function rotateGeminiKey() {
  if (GEMINI_API_KEYS.length <= 1) return;
  GEMINI_KEY_INDEX = (GEMINI_KEY_INDEX + 1) % GEMINI_API_KEYS.length;
  GEMINI_API_KEY = GEMINI_API_KEYS[GEMINI_KEY_INDEX];
  log('🔁', `Rotated to Gemini key #${GEMINI_KEY_INDEX + 1}/${GEMINI_API_KEYS.length}`);
}

// E-mail do dono do projeto em execução — usado nos logs remotos (a coluna
// autopilot_logs.user_email é NOT NULL em bancos já existentes).
let CURRENT_USER_EMAIL = null;

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

async function loadUserKeys(userEmail) {
  const email = normalizeEmail(userEmail);
  if (!email) return;
  if (!SCHEMA.user_settings) return; // schema incompleto — segue com chaves do ENV

  const envGemini = ENV_GEMINI_API_KEY || VITE_GEMINI_API_KEY;
  const envPexels = ENV_PEXELS_API_KEY || VITE_PEXELS_API_KEY;

  try {
    let { data, error } = await supabase
      .from('user_settings')
      .select('gemini_api_keys, pexels_api_key')
      .eq('user_email', email)
      .maybeSingle();

    // Segunda tentativa: e-mail salvo com outra caixa/espaços.
    if (!error && !data) {
      const retry = await supabase
        .from('user_settings')
        .select('gemini_api_keys, pexels_api_key')
        .ilike('user_email', email)
        .maybeSingle();
      data = retry.data;
      error = retry.error;
    }

    if (error) {
      // NUNCA tratar erro de query como "usuário sem chave" — isso mascarou o
      // bug de colunas ausentes (gemini_api_keys) por várias execuções.
      log('⚠️', `Falha ao ler user_settings de ${email}: ${error.message}. Rode supabase/bootstrap.sql para criar/atualizar as colunas.`);
    } else if (data?.gemini_api_keys?.length) {
      GEMINI_API_KEYS = data.gemini_api_keys.filter(Boolean);
      GEMINI_KEY_INDEX = 0;
      GEMINI_API_KEY = GEMINI_API_KEYS[0];
      log('🔑', `Loaded ${GEMINI_API_KEYS.length} Gemini key(s) for ${email}`);
    } else {
      log('ℹ️', `Nenhuma chave Gemini salva em user_settings para ${email}${envGemini ? ' — usando a chave do ambiente.' : '.'}`);
    }

    if (!GEMINI_API_KEYS.length && envGemini) {
      GEMINI_API_KEYS = [envGemini];
      GEMINI_KEY_INDEX = 0;
      GEMINI_API_KEY = envGemini;
    }

    if (data?.pexels_api_key) {
      PEXELS_API_KEY = data.pexels_api_key;
      log('🔑', `Loaded Pexels key for ${email}`);
    } else if (envPexels) {
      PEXELS_API_KEY = envPexels;
    }
  } catch (e) {
    log('⚠️', `Failed to load user_settings for ${email}: ${e.message}`);
    if (!GEMINI_API_KEY && envGemini) {
      GEMINI_API_KEYS = [envGemini];
      GEMINI_API_KEY = envGemini;
    }
  }
}


// --- HELPERS ---

function log(emoji, msg) {
  console.log(`${emoji} [${new Date().toISOString()}] ${msg}`);
}

function makeProjectIdea(raw, status = 'new') {
  return {
    id: `idea_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    topic: String(raw?.topic || '').trim(),
    context: String(raw?.context || '').trim(),
    specificContext: String(raw?.specificContext || raw?.context || '').trim(),
    status,
    createdAt: new Date().toISOString(),
  };
}

function normalizeIdeaBatch(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.ideas) ? raw.ideas : raw ? [raw] : [];
  return list
    .map((i) => makeProjectIdea(i, 'new'))
    .filter((i) => i.topic.length > 0);
}

function runFfmpeg(args, label = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function normalizeAudioChunkToPcm(audioBuffer, mimeType, tmpDir, index) {
  const inputPath = path.join(tmpDir, `tts_${index}`);
  const outputPath = path.join(tmpDir, `tts_${index}.pcm`);
  fs.writeFileSync(inputPath, audioBuffer);
  const isRawPcm = !mimeType || mimeType.includes('pcm') || mimeType.includes('L16');

  if (isRawPcm) {
    return audioBuffer;
  }

  await runFfmpeg([
    '-y',
    '-i', inputPath,
    '-f', 's16le',
    '-ar', '24000',
    '-ac', '1',
    outputPath,
  ], `normalize tts ${index}`);

  return fs.readFileSync(outputPath);
}

// Teto de tempo padrão para chamadas de rede — nenhuma chamada do pipeline
// pode ficar pendurada até o timeout de 120 min do job do GitHub Actions.
const NET_TIMEOUT = {
  TEXT: 90_000,   // roteiro / ideia / metadados
  TTS: 60_000,    // narração por segmento
  IMAGE: 45_000,  // thumbnail / cena
  PEXELS: 12_000,
};

// Helper único de timeout — usado por TODA chamada de rede deste runner.
function raceTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} excedeu ${Math.round(ms / 1000)}s (timeout)`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function geminiGenerate(prompt, maxTokens = 4096) {
  const res = await raceTimeout(
    axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.9 },
      },
      { timeout: NET_TIMEOUT.TEXT }
    ),
    NET_TIMEOUT.TEXT + 5_000,
    'Gemini (texto)'
  );
  return res.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}


async function geminiWithRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const isQuota = err?.response?.status === 429 ||
                      (err?.message || '').toLowerCase().includes('quota');
      if (isQuota && i < retries - 1) {
        const wait = (i + 1) * 30000;
        log('⏳', `Quota error, waiting ${wait/1000}s before retry ${i+2}/${retries}...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
}

async function geminiGenerateJSON(prompt, maxTokens = 4096) {
  const raw = await geminiWithRetry(() => geminiGenerate(prompt, maxTokens));
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  let jsonStr = match ? match[1].trim() : raw.trim();
  if (!match) {
    const firstObj = jsonStr.indexOf('{');
    const lastObj = jsonStr.lastIndexOf('}');
    const firstArr = jsonStr.indexOf('[');
    const lastArr = jsonStr.lastIndexOf(']');
    if (firstObj >= 0 && lastObj > firstObj) jsonStr = jsonStr.slice(firstObj, lastObj + 1);
    else if (firstArr >= 0 && lastArr > firstArr) jsonStr = jsonStr.slice(firstArr, lastArr + 1);
  }
  return JSON.parse(jsonStr);
}

async function geminiGenerateImage(prompt) {
  // 1️⃣ Try imagen-3 (allowlisted accounts)
  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict?key=${GEMINI_API_KEY}`,
      { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '16:9' } },
      { timeout: 45000 }
    );
    const b64 = res.data.predictions?.[0]?.bytesBase64Encoded;
    if (b64) return b64;
  } catch (err) {
    const code = err?.response?.status;
    if (code && code !== 403 && code !== 400 && code !== 404) {
      log('⚠️', `imagen-3 error ${code}: ${err.message}`);
    }
  }

  // 2️⃣ Fallback to Gemini image-generation models (no allowlist needed).
  // Apenas modelos que realmente devolvem inlineData — `gemini-2.0-flash-exp`
  // não gera imagem e só queimava cota.
  const FLASH_MODELS = [
    'gemini-2.5-flash-image',
    'gemini-2.0-flash-preview-image-generation',
  ];

  for (const model of FLASH_MODELS) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: `Generate a 16:9 cinematic image: ${prompt}` }] }],
          generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
        },
        { timeout: 45000 }
      );
      const parts = res.data.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find((p) => p.inlineData?.data);
      if (imgPart?.inlineData?.data) {
        log('🖼️', `Imagem gerada via ${model}`);
        return imgPart.inlineData.data;
      }
    } catch (err) {
      const code = err?.response?.status;
      if (code !== 400 && code !== 404) {
        log('⚠️', `${model} falhou: ${err.message}`);
      }
    }
  }

  log('⚠️', 'Todos os modelos de imagem falharam — usando fallback');
  return null;
}

// ─── Generate a Node-side ambient music track via FFmpeg (no API needed) ─────
function generateAmbienceTrack(outputPath, durationSec, tone = '') {
  return new Promise((resolve, reject) => {
    const t = (tone || '').toLowerCase();
    // Map tone to a base sine frequency for the drone
    let freq = 110; // A2 default
    if (t.includes('horror') || t.includes('dark') || t.includes('suspense')) freq = 65;   // C2 deep drone
    else if (t.includes('motiv') || t.includes('energ')) freq = 220;                       // A3 brighter
    else if (t.includes('child') || t.includes('kid') || t.includes('cozy')) freq = 196;   // G3 warm
    else if (t.includes('tech') || t.includes('gaming')) freq = 87;                        // F2

    const dur = Math.max(30, Math.ceil(durationSec) + 5);

    // Mix: sine drone + perfect 5th + brown noise pad, lowpass for warmth, fade in/out
    const filter = [
      `sine=frequency=${freq}:duration=${dur}[s1]`,
      `sine=frequency=${Math.round(freq * 1.5)}:duration=${dur}[s2]`,
      `anoisesrc=color=brown:duration=${dur}:amplitude=0.4[n]`,
      `[s1][s2]amix=inputs=2:duration=longest[drone]`,
      `[drone][n]amix=inputs=2:weights=1.0 0.35:duration=longest,lowpass=f=900,volume=0.6,afade=t=in:st=0:d=2,afade=t=out:st=${dur - 2}:d=2[out]`,
    ].join(';');

    const args = [
      '-y',
      '-f', 'lavfi',
      '-i', `sine=frequency=${freq}:duration=${dur}`,
      '-f', 'lavfi',
      '-i', `sine=frequency=${Math.round(freq * 1.5)}:duration=${dur}`,
      '-f', 'lavfi',
      '-i', `anoisesrc=color=brown:duration=${dur}:amplitude=0.4`,
      '-filter_complex',
      `[0:a][1:a]amix=inputs=2:duration=longest[drone];[drone][2:a]amix=inputs=2:weights=1.0 0.35:duration=longest,lowpass=f=900,volume=0.6,afade=t=in:st=0:d=2,afade=t=out:st=${dur - 2}:d=2[out]`,
      '-map', '[out]',
      '-ac', '2',
      '-ar', '44100',
      '-b:a', '160k',
      outputPath,
    ];

    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) resolve(outputPath);
      else reject(new Error(`ffmpeg ambience exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/**
 * 🎙️ Generate TTS audio for a single text segment using Gemini TTS API.
 * Returns base64-encoded PCM/WAV audio.
 */
async function geminiTTS(text, voiceName = 'Fenrir', tone = 'Cinematic') {
  const SUPPORTED_VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'];
  const VOICE_MAPPING = { 'Aoede': 'Kore', 'Leda': 'Kore' };

  let finalVoice = voiceName;
  if (!SUPPORTED_VOICES.includes(voiceName)) {
    finalVoice = VOICE_MAPPING[voiceName] || 'Fenrir';
  }

  const t = (tone || '').toLowerCase();
  let styleInstruction = 'Read clearly and naturally.';
  if (t.includes('horror') || t.includes('dark') || t.includes('suspense')) {
    styleInstruction = 'Read in a low, tense, and ominous tone with dramatic pauses.';
  } else if (t.includes('child') || t.includes('kid')) {
    styleInstruction = 'Read in a warm, enthusiastic, and friendly tone.';
  } else if (t.includes('motiv') || t.includes('energ')) {
    styleInstruction = 'Read in an energetic, inspiring, and powerful tone.';
  }

  const ttsPrompt = `Style: ${styleInstruction}\n\nText to read: "${text}"`;

  const res = await raceTimeout(
    axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: ttsPrompt }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: finalVoice },
            },
          },
        },
      },
      { timeout: NET_TIMEOUT.TTS }
    ),
    NET_TIMEOUT.TTS + 5_000,
    'Gemini TTS'
  );


  const audioPart = res.data.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
  if (!audioPart?.inlineData?.data) {
    throw new Error('TTS returned no audio data');
  }

  // Retorna tanto o base64 quanto o mimeType para que o renderer
  // saiba se é PCM raw (audio/pcm) ou WAV (audio/wav / audio/L16)
  return {
    data: audioPart.inlineData.data,
    mimeType: audioPart.inlineData.mimeType || 'audio/pcm',
  };
}

async function searchPexels(query, usedIds, isVideo = true) {
  if (!PEXELS_API_KEY) return null;
  const endpoint = isVideo
    ? `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=15&orientation=landscape`
    : `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=15&orientation=landscape`;

  try {
    const res = await axios.get(endpoint, {
      headers: { Authorization: PEXELS_API_KEY },
      timeout: 12_000,
    });


    const items = isVideo ? res.data.videos : res.data.photos;
    if (!items?.length) return null;

    const unused = items.filter((i) => !usedIds.has(i.id));
    if (!unused.length) return null;

    const pick = unused[Math.floor(Math.random() * Math.min(unused.length, 5))];
    usedIds.add(pick.id);

    if (isVideo) {
      const file = pick.video_files?.find((f) => f.quality === 'hd') || pick.video_files?.[0];
      return { id: pick.id, videoUrl: file?.link, thumbnailUrl: pick.image };
    }
    return { id: pick.id, imageUrl: pick.src?.large || pick.src?.original };
  } catch (e) {
    log('⚠️', `Pexels search failed for "${query}": ${e.message}`);
    return null;
  }
}

// --- TONE MODIFIERS ---

const TONE_MODIFIERS = {
  'Suspenseful & Dark': 'dark fog abandoned',
  'Children\'s Story': 'colorful bright nature',
  'True Crime Analysis': 'urban serious documentary',
  'Educational & Explanatory': 'clean minimal office',
  'Documentary Style': 'landscape formal journalistic',
  'Fast-paced Facts': 'dynamic colorful impact',
  'Enthusiastic Vlog': 'people energy lifestyle',
  'Calm & Cozy': 'nature warm soft light',
  'Motivational & Energetic': 'sunset active determination',
  'Tech Reviewer': 'technology studio gadgets',
  'High-Energy Gaming': 'neon gaming action',
  'Professional Business': 'corporate meeting city',
  'Urban Legend Storyteller': 'forest mystery night',
};

const SLOT_VARIATIONS = [
  'wide establishing shot', 'close detail shot', 'dynamic movement shot',
  'symbolic cinematic insert', 'dramatic atmosphere shot', 'human perspective shot',
  'environment texture shot', 'high-energy transition shot'
];

function getSegmentVisualPrompts(segment) {
  const explicit = (segment.visualDescriptions || []).map(p => String(p || '').trim()).filter(Boolean);
  if (explicit.length) return explicit;
  const title = String(segment.sectionTitle || '').trim();
  const sentences = String(segment.narratorText || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.replace(/["“”]/g, '').trim())
    .filter(s => s.length > 20)
    .slice(0, 4);
  if (sentences.length) return sentences.map((s, idx) => `${title || 'Narrative beat'} — ${s.slice(0, 180)} — cinematic b-roll ${idx + 1}`);
  return [title || 'cinematic atmosphere for this narrative moment'];
}

function buildSlotVisualPrompt(segment, basePrompt, segmentIndex, slotIndex, totalSlots, channelTheme) {
  const variation = SLOT_VARIATIONS[(segmentIndex + slotIndex) % SLOT_VARIATIONS.length];
  const context = String(segment.narratorText || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  return [
    String(basePrompt || segment.sectionTitle || 'cinematic scene').trim(),
    `topic: ${channelTheme || 'general'}`,
    context ? `story context: ${context}` : '',
    `visual variation ${slotIndex + 1} of ${totalSlots}: ${variation}`,
    'must be visually distinct from previous shots',
  ].filter(Boolean).join('. ');
}

function createFallbackVisualDataUrl(prompt, seed = 0) {
  const palettes = [['#101826', '#0f766e'], ['#172033', '#b45309'], ['#111827', '#be123c'], ['#0f172a', '#2563eb']];
  const [bg, accent] = palettes[Math.abs(seed) % palettes.length];
  const label = String(prompt || 'cinematic scene').replace(/[<>&]/g, '').slice(0, 110);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="#020617"/></linearGradient><radialGradient id="r" cx="68%" cy="34%" r="55%"><stop offset="0" stop-color="${accent}" stop-opacity="0.55"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#r)"/><path d="M0 778 C 538 626, 998 929, 1920 691 L 1920 1080 L 0 1080 Z" fill="${accent}" opacity="0.28"/><text x="154" y="907" fill="#f8fafc" font-family="Arial,sans-serif" font-size="66" font-weight="700" opacity="0.82">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function getToneModifier(tone) {
  return TONE_MODIFIERS[tone] || 'cinematic atmospheric';
}

// --- PIPELINE STEPS ---

async function stepIdea(projectData) {
  log('💡', 'Step 1: Finding idea...');

  const ideas = projectData.ideas || [];
  const unused = ideas.find((i) => i.status === 'new');

  if (unused) {
    unused.status = 'used';
    log('✅', `Using existing idea: "${unused.topic}"`);
    return { topic: unused.topic, context: unused.context, specificContext: unused.specificContext, updatedIdeas: ideas };
  }

  log('🔄', 'No unused ideas, generating new brainstorm batch...');
  const usedTopics = [
    ...(projectData.ideas || []).map((i) => i.topic),
    ...(projectData.videos || []).map((v) => v.title),
  ].filter(Boolean).slice(-50);
  const prompt = `You are a YouTube content strategist. Generate 5 unique video ideas for a channel about "${projectData.channelTheme}".
Tone: ${projectData.defaultTone || 'Engaging'}.
Language: ${projectData.language || 'en'}.
Avoid these already-used topics: ${usedTopics.join(' | ') || 'none'}.

Return JSON: { "ideas": [{ "topic": "video title", "context": "brief description", "specificContext": "detailed angle" }] }`;

  let generatedIdeas = [];
  try {
    generatedIdeas = normalizeIdeaBatch(await geminiGenerateJSON(prompt));
    if (!generatedIdeas.length) throw new Error('AI returned no ideas');
  } catch (e) {
    // Fallback: never block autopilot just because brainstorm failed
    log('⚠️', `Brainstorm fallback (IA falhou: ${e.message}). Gerando ideia automática.`);
    const seeds = ['The Untold Story of', 'The Hidden Truth Behind', 'What Nobody Tells You About', 'Why Everyone is Wrong About'];
    generatedIdeas = seeds.slice(0, 3).map((seed) => makeProjectIdea({
      topic: `${seed} ${projectData.channelTheme}`,
      context: `An engaging deep-dive about ${projectData.channelTheme}.`,
      specificContext: `Explore ${projectData.channelTheme} from a fresh, click-worthy angle. ${projectData.description || ''}`.trim(),
    }, 'new'));
  }

  const existingTopics = new Set(ideas.map((i) => i.topic));
  const freshIdeas = generatedIdeas.filter((i) => !existingTopics.has(i.topic));
  const chosen = freshIdeas[0] || generatedIdeas[0];
  const updatedIdeas = [
    ...ideas,
    ...freshIdeas.map((i, idx) => ({ ...i, status: i.topic === chosen.topic && idx === 0 ? 'used' : 'new' })),
  ];

  log('✅', `Generated brainstorm batch (${freshIdeas.length}) and selected: "${chosen.topic}"`);
  return { topic: chosen.topic, context: chosen.context, specificContext: chosen.specificContext, updatedIdeas };
}

async function stepScript(topic, projectData) {
  log('📝', 'Step 2: Generating script...');
  
  const dur = (projectData.defaultDuration || 'Standard (5-8 min)').toLowerCase();
  let minWords, maxWords, segments;
  if (dur.includes('short') || dur.includes('< 3')) { minWords = 100; maxWords = 450; segments = 4; }
  else if (dur.includes('long') || dur.includes('10-15')) { minWords = 1500; maxWords = 2250; segments = 12; }
  else if (dur.includes('deep') || dur.includes('20+')) { minWords = 2250; maxWords = 3000; segments = 16; }
  else { minWords = 750; maxWords = 1200; segments = 7; }

  const prompt = `Write a YouTube video script about "${topic}" for a ${projectData.defaultTone || 'Engaging'} channel about "${projectData.channelTheme}".
Target duration: ${projectData.defaultDuration || 'Standard (5-8 min)'}.
Language: ${projectData.language || 'en'}.

WORD COUNT REQUIREMENT: Write narrator text totaling between ${minWords} and ${maxWords} words across all segments combined.
NUMBER OF SEGMENTS: Generate exactly ${segments} segments.
SPEAKING RATE: Assume 150 words per minute for narration timing. Each segment's estimatedDuration should reflect the word count of its narratorText at this rate.
CRITICAL: Each segment's narratorText MUST be a complete, detailed, word-for-word spoken paragraph. Do NOT write short summaries. Write the FULL narration script.

Return JSON with this structure:
{
  "title": "video title",
  "description": "brief summary",
  "segments": [
    {
      "sectionTitle": "Introduction",
      "narratorText": "full narration text for this section",
      "visualDescriptions": ["visual prompt 1", "visual prompt 2"],
      "estimatedDuration": 30
    }
  ]
}`;

  const script = await geminiWithRetry(() => geminiGenerateJSON(prompt, 16384));
  const totalWords = (script.segments || []).reduce((sum, s) => sum + (s.narratorText || '').split(/\s+/).filter(Boolean).length, 0);
  const estMin = (totalWords / 150).toFixed(1);
  log('✅', `Script generated: ${script.segments?.length || 0} segments, ~${totalWords} words (~${estMin} min)`);
  return script;
}

/**
 * 🎙️ Step 3: Generate voice narration for ALL segments using Gemini TTS.
 * Concatenates all segment audio into a single base64 buffer.
 * Returns the combined audio as a base64 string ready for the renderer.
 */
async function stepVoice(script, projectData) {
  log('🎙️', 'Step 3: Generating voice narration...');

  const segments = script.segments || [];
  if (segments.length === 0) throw new Error('No segments in script for TTS');

  const audioChunks = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopost_tts_'));

  try {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const text = seg.narratorText;
      if (!text || !text.trim()) {
        log('⚠️', `  Segment ${i + 1} has no text, skipping`);
        continue;
      }

      log('🎤', `  Generating TTS for segment ${i + 1}/${segments.length} (${text.length} chars)...`);

      const ttsResult = await geminiWithRetry(() =>
        geminiTTS(text, projectData.defaultVoice || 'Fenrir', projectData.defaultTone || 'Cinematic')
      );

      // ttsResult pode ser { data, mimeType } ou string (compatibilidade)
      const audioData = typeof ttsResult === 'string' ? ttsResult : ttsResult.data;
      const mimeType = typeof ttsResult === 'string' ? 'audio/pcm' : (ttsResult.mimeType || 'audio/pcm');

      const normalizedPcm = await normalizeAudioChunkToPcm(Buffer.from(audioData, 'base64'), mimeType, tmpDir, i);
      audioChunks.push(normalizedPcm);

      // Small delay between segments to avoid rate limits
      if (i < segments.length - 1) {
        const silence = Buffer.alloc(Math.floor(24000 * 2 * 0.35));
        audioChunks.push(silence);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (audioChunks.length === 0) throw new Error('No audio generated for any segment');

    // Concatenate normalized raw PCM buffers into one renderable stream.
    const combined = Buffer.concat(audioChunks);
    const combinedBase64 = combined.toString('base64');
    const mimeType = 'audio/pcm';

    log('✅', `Voice generated: ${(segments.length)} segments, ${(combined.length / 1024 / 1024).toFixed(1)}MB total, normalized=${mimeType}`);
    return { audioBase64: combinedBase64, mimeType };
  } finally {
    try { cleanupTmp(tmpDir); } catch {}
  }
}

const VISUAL_MAX_SLOTS_PER_SEGMENT = 8;
const VISUAL_MAX_SLOTS_TOTAL = 60;
const VISUAL_SLOT_TIMEOUT_MS = 90_000;
const VISUAL_CONCURRENCY = 3;

/** Rejects if the promise takes longer than ms — keeps the step from hanging forever. */
function raceTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}_timeout`)), ms)),
  ]);
}

async function stepVisuals(script, projectData) {
  log('🎨', 'Step 4: Searching visuals...');
  const usedIds = new Set();
  const toneModifier = getToneModifier(projectData.defaultTone);

  // Keep each media on screen at most this many seconds — configurable per-project
  const MAX_MEDIA_DUR = Math.max(2, Number(projectData.maxMediaDurationSeconds) || 6);

  // 1. Plan all slots up front (capped so long segments can't explode).
  const slots = [];
  for (let i = 0; i < script.segments.length; i++) {
    const seg = script.segments[i];
    const prompts = getSegmentVisualPrompts(seg);
    const segDur = Math.max(2, Number(seg.estimatedDuration) || 5);
    const desired = Math.max(prompts.length, Math.ceil(segDur / MAX_MEDIA_DUR));
    const slotCount = Math.max(1, Math.min(desired, VISUAL_MAX_SLOTS_PER_SEGMENT));
    const slotDur = segDur / slotCount;

    for (let j = 0; j < slotCount; j++) {
      if (slots.length >= VISUAL_MAX_SLOTS_TOTAL) break;
      const basePrompt = prompts[j % prompts.length];
      slots.push({
        index: slots.length,
        segmentIndex: i,
        slotInSegment: j,
        duration: slotDur,
        prompt: buildSlotVisualPrompt(seg, basePrompt, i, j, slotCount, projectData.channelTheme),
      });
    }
  }

  const total = slots.length;
  const resolved = new Array(total).fill(null);
  let done = 0;

  const resolveSlot = async (slot) => {
    const { prompt, segmentIndex: i, slotInSegment: j } = slot;
    const query = `${prompt} ${toneModifier}`.split(' ').slice(0, 4).join(' ');

    let result = await searchPexels(query, usedIds);
    if (!result) result = await searchPexels(prompt.split(' ').slice(0, 3).join(' '), usedIds);
    if (!result) result = await searchPexels(projectData.channelTheme || 'cinematic', usedIds);
    if (!result) {
      result = await searchPexels(query, usedIds, false)
        || await searchPexels(projectData.channelTheme || 'cinematic', usedIds, false);
    }

    let generatedImageUrl = null;
    if (!result?.imageUrl && !result?.thumbnailUrl) {
      try {
        const b64 = await raceTimeout(
          geminiGenerateImage(`${prompt}. Cinematic video scene, no text, no watermark, 16:9.`),
          45_000,
          'scene_image',
        );
        if (b64) generatedImageUrl = `data:image/jpeg;base64,${b64}`;
      } catch (e) {
        log('⚠️', `  AI image failed (${e.message}) — using generated fallback`);
      }
    }

    return {
      segmentIndex: i,
      prompt,
      duration: slot.duration,
      videoUrl: result?.videoUrl,
      imageUrl: result?.imageUrl || result?.thumbnailUrl || generatedImageUrl
        || createFallbackVisualDataUrl(prompt, i * 100 + j),
      effect: ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'zoom-in-fast'][(i + j) % 5],
    };
  };

  const resolveSlotGuarded = async (slot) => {
    try {
      return await raceTimeout(resolveSlot(slot), VISUAL_SLOT_TIMEOUT_MS, 'slot');
    } catch (e) {
      log('⚠️', `  Scene ${slot.index + 1} timed out (${e.message}) — fallback visual`);
      return {
        segmentIndex: slot.segmentIndex,
        prompt: slot.prompt,
        duration: slot.duration,
        videoUrl: undefined,
        imageUrl: createFallbackVisualDataUrl(slot.prompt, slot.segmentIndex * 100 + slot.slotInSegment),
        effect: ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'zoom-in-fast'][(slot.segmentIndex + slot.slotInSegment) % 5],
      };
    }
  };

  // 2. Bounded-concurrency pool, order preserved by index.
  let cursor = 0;
  const worker = async () => {
    while (cursor < total) {
      const slot = slots[cursor++];
      resolved[slot.index] = await resolveSlotGuarded(slot);
      done++;
      log('🔍', `  Scene ${done}/${total} ready`);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(VISUAL_CONCURRENCY, Math.max(1, total)) }, worker)
  );

  const scenes = resolved.filter(Boolean);
  log('✅', `Found ${scenes.length} visual scenes (max ${MAX_MEDIA_DUR}s per media)`);
  return scenes;
}



/** Rejeita se a promise passar de `ms` — impede travamento do passo. */
function withStepTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}_timeout`)), ms)),
  ]);
}

async function stepThumbnail(title, script, projectData) {
  log('🖼️', 'Step 5: Generating thumbnail...');

  const toneStyle = getToneModifier(projectData.defaultTone);
  const scriptSummary = script.segments
    .slice(0, 3)
    .map((s) => s.narratorText)
    .join(' ')
    .slice(0, 300);

  const prompt = `Generate a short clickbait text (max 5 words, in ${projectData.language || 'en'}) for a YouTube thumbnail about "${title}".
Tone: ${projectData.defaultTone}. Channel niche: ${projectData.channelTheme}.
Script summary: ${scriptSummary}
Return JSON: { "clickbaitText": "...", "imagePrompt": "full prompt for thumbnail image generation" }`;

  // Texto clickbait (25s de teto) — se falhar, deriva do título.
  let result;
  try {
    result = await withStepTimeout(geminiWithRetry(() => geminiGenerateJSON(prompt)), 25000, 'thumb_text');
  } catch (err) {
    log('⚠️', `Texto de thumbnail falhou (${err.message}), derivando do título`);
    result = {
      clickbaitText: title.split(' ').slice(0, 4).join(' ').toUpperCase(),
      imagePrompt: `dramatic scene about "${title}", one human face with extreme emotion looking at camera, ${toneStyle} atmosphere`,
    };
  }

  const fullPrompt = `YouTube thumbnail, ${toneStyle} style, text overlay "${result.clickbaitText}", ${result.imagePrompt}, high contrast, bold colors, professional design, 16:9 aspect ratio, no watermark`;

  // Imagem: teto total de 100s. Estourando, segue sem imagem (não bloqueia).
  let thumbnailBase64 = null;
  try {
    thumbnailBase64 = await withStepTimeout(geminiGenerateImage(fullPrompt), 100000, 'thumb_image');
  } catch (err) {
    log('⚠️', `Imagem de thumbnail falhou (${err.message}) — seguindo sem ela`);
  }

  log('✅', `Thumbnail: "${result.clickbaitText}" ${thumbnailBase64 ? '(image generated)' : '(text only, no image)'}`);
  return { clickbaitText: result.clickbaitText, imagePrompt: fullPrompt, thumbnailBase64 };
}


async function stepMetadata(title, script, projectData) {
  log('📊', 'Step 6: Generating SEO metadata...');

  const fullText = script.segments.map((s) => s.narratorText).join(' ');
  const prompt = `Generate YouTube SEO metadata for a video titled "${title}".
Channel: ${projectData.channelTheme}. Tone: ${projectData.defaultTone}. Language: ${projectData.language || 'en'}.
Script: ${fullText.slice(0, 1000)}

Return JSON:
{
  "title": "optimized YouTube title with light clickbait (max 70 chars)",
  "description": "3-layer description: hook (2 lines) + summary (3-5 sentences) + hashtags (8-12) and CTA",
  "tags": ["tag1", "tag2", "...up to 15 tags"]
}`;

  const metadata = await geminiWithRetry(() => geminiGenerateJSON(prompt));
  const rawVisibility = String(metadata.visibility || 'public').toLowerCase();
  metadata.visibility = ['public', 'private', 'unlisted'].includes(rawVisibility) ? rawVisibility : 'public';
  log('✅', `Metadata: "${metadata.title}"`);
  return metadata;
}

async function stepRenderVideo(scenes, script, audioBase64, thumbnailBase64, projectData, audioMimeType = 'audio/pcm') {
  log('🎬', 'Step 7: Rendering video with FFmpeg...');

  const tmpDir = path.join(os.tmpdir(), `autopost_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Build per-scene visuals with duration from scene data
  const visuals = scenes.map((s, i) => ({
    url: s.videoUrl || s.imageUrl,
    effect: s.effect || 'zoom-in',
    duration: s.duration || (script.segments[s.segmentIndex || i]?.estimatedDuration) || 5,
    isVideo: !!s.videoUrl,
  }));

  const clipSegments = visuals.map((v) => ({ estimatedDuration: v.duration }));

  // 🎵 Step 6.5: Generate procedural ambience to match total video duration
  const totalDuration = visuals.reduce((sum, v) => sum + (v.duration || 0), 0);
  let musicPath = null;
  try {
    musicPath = path.join(tmpDir, 'ambience.m4a');
    await generateAmbienceTrack(musicPath, totalDuration, projectData.defaultTone);
    log('🎵', `Ambience gerada (${totalDuration.toFixed(1)}s, tom: ${projectData.defaultTone || 'default'})`);
  } catch (e) {
    log('⚠️', `Falha ao gerar ambience: ${e.message} — continuando sem música`);
    musicPath = null;
  }

  const { videoPath } = await renderVideo({
    visuals,
    segments: clipSegments,
    audioBase64: audioBase64,
    audioMimeType: audioMimeType,
    musicUrl: musicPath,
    thumbnailBase64: thumbnailBase64 || null,
    tmpDir,
  });

  log('✅', `Video rendered: ${videoPath}`);
  return { videoPath, tmpDir };
}

async function stepUploadYouTube(projectData, metadata, renderResult, thumbnailBase64, userEmail) {
  log('📤', 'Step 8: Uploading to YouTube...');

  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET) {
    throw new Error('YouTube credentials not configured');
  }

  // Resolve refresh_token strictly from this project. Falling back to another
  // project can post to the wrong channel in multi-channel setups.
  const projectId = projectData.id || projectData.projectId || '';
  let authRow = null;

  if (projectId && userEmail) {
    const { data, error } = await supabase
      .from('project_auth')
      .select('youtube_refresh_token, youtube_access_token, token_expires_at, project_id, user_email')
      .eq('project_id', projectId)
      .eq('user_email', userEmail)
      .maybeSingle();
    if (error) throw new Error(`Falha ao buscar auth do projeto: ${error.message}`);
    authRow = data;
  }

  const refreshToken = authRow?.youtube_refresh_token;
  if (!refreshToken) {
    throw new Error('Nenhum refresh_token do YouTube encontrado para este projeto. Reconecte o canal na aba Settings do projeto.');
  }

  // Reuse cached access_token if it still has >5min of life
  let accessToken = null;
  if (authRow?.youtube_access_token && authRow?.token_expires_at) {
    const msLeft = new Date(authRow.token_expires_at).getTime() - Date.now();
    if (msLeft > 5 * 60 * 1000) {
      accessToken = authRow.youtube_access_token;
      log('🔑', `Reusing cached access token (expires in ${Math.round(msLeft / 60000)}min)`);
    }
  }

  try {
    if (!accessToken) {
      // Auto-login: exchange refresh_token → fresh access_token
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: YOUTUBE_CLIENT_ID,
          client_secret: YOUTUBE_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokens.access_token) {
        const needsReconnect = tokens.error === 'invalid_grant';
        throw new Error(
          needsReconnect
            ? 'YouTube refresh_token foi revogado pelo Google. Reconecte o canal no app.'
            : `Falha ao renovar token: ${JSON.stringify(tokens)}`
        );
      }
      accessToken = tokens.access_token;
      const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();
      log('🔑', 'Access token renovado via refresh_token (auto-login)');

      // Persist fresh access_token + expiry back to project_auth so o app
      // e próximas execuções reusem sem precisar revalidar
      if (authRow?.project_id && authRow?.user_email) {
        await supabase
          .from('project_auth')
          .update({
            youtube_access_token: accessToken,
            token_expires_at: expiresAt,
            updated_at: new Date().toISOString(),
          })
          .eq('project_id', authRow.project_id)
          .eq('user_email', authRow.user_email);
      }
    }

    const { videoUrl, videoId } = await uploadVideoFile(accessToken, renderResult.videoPath, metadata);

    if (thumbnailBase64) {
      await uploadThumbnail(accessToken, videoId, thumbnailBase64);
    }

    return { uploaded: true, videoUrl, videoId };
  } finally {
    cleanupTmp(renderResult.tmpDir);
  }
}

// --- MAIN ORCHESTRATOR ---


async function safeInsertAutopilotLog(payload) {
  try {
    const { error } = await supabase.from('autopilot_logs').insert(payload);
    if (!error) return;
    // Older databases may not have the new columns yet; keep logging non-fatal.
    if ((error.message || '').includes('video_title') || (error.message || '').includes('elapsed_ms') || (error.message || '').includes('runner')) {
      const fallback = { ...payload };
      delete fallback.video_title;
      delete fallback.elapsed_ms;
      delete fallback.runner;
      const retry = await supabase.from('autopilot_logs').insert(fallback);
      if (retry.error) log('⚠️', `Failed to write autopilot log: ${retry.error.message}`);
      return;
    }
    log('⚠️', `Failed to write autopilot log: ${error.message}`);
  } catch (e) {
    log('⚠️', `Failed to write autopilot log: ${e.message}`);
  }
}

function lightVideoRecord(video) {
  if (!video) return video;
  return {
    ...video,
    audioUrl: video.audioUrl ? '__runner_audio__' : undefined,
    backgroundMusicUrl: video.backgroundMusicUrl ? '__runner_music__' : undefined,
    thumbnailUrl: video.thumbnailUrl?.startsWith?.('data:') ? '__runner_thumbnail__' : video.thumbnailUrl,
    visualScenes: video.visualScenes?.map((scene) => ({
      ...scene,
      imageUrl: scene.imageUrl?.startsWith?.('data:') ? '__runner_image__' : scene.imageUrl,
    })),
  };
}

function calculateNextRunIso(settings = {}) {
  const freqDays = Math.max(1, Number(settings.frequencyDays) || 1);
  const [startH = 9, startM = 0] = String(settings.timeWindowStart || '09:00').split(':').map(Number);
  const [endH = 21, endM = 0] = String(settings.timeWindowEnd || '21:00').split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  const windowSize = Math.max(0, endMinutes - startMinutes);
  const offset = windowSize > 0 ? Math.floor(Math.random() * windowSize) : 0;
  const total = startMinutes + offset;
  const nextRun = new Date();
  nextRun.setDate(nextRun.getDate() + freqDays);
  nextRun.setHours(Math.floor(total / 60), total % 60, 0, 0);
  return nextRun.toISOString();
}

async function persistProjectData(projectId, data, message = 'Project data persisted') {
  const { error } = await supabase
    .from('projects')
    .update({ data, updated_at: new Date().toISOString() })
    .eq('id', projectId);
  if (error) log('⚠️', `${message} failed: ${error.message}`);
}

async function updateRunnerVideo(projectId, data, videoId, updates, logMessage) {
  if (!data.videos) data.videos = [];
  const idx = data.videos.findIndex((v) => v.id === videoId);
  if (idx === -1) return;
  data.videos[idx] = lightVideoRecord({
    ...data.videos[idx],
    ...updates,
    updatedAt: new Date().toISOString(),
  });
  await persistProjectData(projectId, data, logMessage || `Video ${videoId} updated`);
}

// --- RETRY POLICY ---
// Transient failures (Gemini "OTHER", network timeouts, Pexels 429) must not
// require a human click. Backoff: 5 min → 20 min → 1 h → 4 h, then give up.
const MAX_AUTO_RETRIES = 4;
const RETRY_BACKOFF_MS = [5 * 60 * 1000, 20 * 60 * 1000, 60 * 60 * 1000, 4 * 60 * 60 * 1000];

function retryBackoffMs(retryCount) {
  return RETRY_BACKOFF_MS[Math.min(retryCount, RETRY_BACKOFF_MS.length - 1)];
}

// A video is retryable when:
//   • está em STANDBY, com tentativas restantes e backoff vencido; ou
//   • está em SCHEDULED por falta de canal do YouTube (upload pendente) —
//     nesse caso é retomado sem gastar tentativa, assim que o token voltar.
const PENDING_UPLOAD_MARK = 'Upload pendente';

function findRetryableVideo(data, now = Date.now(), youtubeReady = false) {
  const videos = Array.isArray(data?.videos) ? data.videos : [];

  if (youtubeReady) {
    const pendingUpload = videos.find(
      (v) => v?.status === 'SCHEDULED' && String(v.lastError || '').startsWith(PENDING_UPLOAD_MARK)
    );
    if (pendingUpload) return pendingUpload;
  }

  return videos.find((v) => {
    if (v?.status !== 'STANDBY') return false;
    if ((v.retryCount || 0) >= MAX_AUTO_RETRIES) return false;
    if (!v.nextRetryAt) return true; // legacy standby video — retry on next cycle
    return new Date(v.nextRetryAt).getTime() <= now;
  }) || null;
}


// Artifacts persisted in Supabase are usable on resume; placeholders are not.
function isUsableUrl(url) {
  return typeof url === 'string' && /^https?:\/\//.test(url);
}

function reusableScenes(video) {
  const scenes = video?.visualScenes;
  if (!Array.isArray(scenes) || scenes.length === 0) return null;
  const allUsable = scenes.every((s) => isUsableUrl(s?.videoUrl) || isUsableUrl(s?.imageUrl));
  return allUsable ? scenes : null;
}

// --- YOUTUBE TOKEN HEALTH ---
// Checked BEFORE generating anything, so we never burn 10 minutes of compute
// only to discover the channel is disconnected.
async function checkYoutubeTokenHealth(projectId, userEmail) {
  if (!SCHEMA.project_auth || !projectId || !userEmail) {
    return { ok: false, reason: 'missing', message: 'Tabela project_auth indisponível.' };
  }
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET) {
    return { ok: false, reason: 'missing', message: 'GOOGLE_CLIENT_ID/YOUTUBE_CLIENT_SECRET não configurados nos secrets.' };
  }

  const { data: authRow } = await supabase
    .from('project_auth')
    .select('youtube_refresh_token, youtube_access_token, token_expires_at')
    .eq('project_id', projectId)
    .eq('user_email', userEmail)
    .maybeSingle();

  const persist = async (status, message) => {
    try {
      await supabase.from('project_auth').update({
        token_status: status,
        token_checked_at: new Date().toISOString(),
        token_error: message || null,
      }).eq('project_id', projectId).eq('user_email', userEmail);
    } catch { /* coluna pode não existir em bancos antigos */ }
  };

  if (!authRow?.youtube_refresh_token) {
    await persist('missing', 'Canal do YouTube não conectado neste projeto.');
    return { ok: false, reason: 'missing', message: 'Canal do YouTube não conectado neste projeto.' };
  }

  // A cached access token with >5 min of life proves the credential chain works.
  if (authRow.youtube_access_token && authRow.token_expires_at) {
    const msLeft = new Date(authRow.token_expires_at).getTime() - Date.now();
    if (msLeft > 5 * 60 * 1000) {
      await persist('ok', null);
      return { ok: true, reason: 'cached', accessToken: authRow.youtube_access_token };
    }
  }

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: YOUTUBE_CLIENT_ID,
        client_secret: YOUTUBE_CLIENT_SECRET,
        refresh_token: authRow.youtube_refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const tokens = await res.json();
    if (!tokens.access_token) {
      const revoked = tokens.error === 'invalid_grant';
      const message = revoked
        ? 'Refresh token revogado pelo Google. Reconecte o canal no app (e publique o app OAuth no Google Cloud).'
        : `Falha ao validar token: ${JSON.stringify(tokens).slice(0, 200)}`;
      await persist(revoked ? 'revoked' : 'unknown', message);
      return { ok: false, reason: revoked ? 'revoked' : 'unknown', message };
    }
    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();
    await supabase.from('project_auth').update({
      youtube_access_token: tokens.access_token,
      token_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }).eq('project_id', projectId).eq('user_email', userEmail);
    await persist('ok', null);
    return { ok: true, reason: 'refreshed', accessToken: tokens.access_token };
  } catch (e) {
    await persist('unknown', e.message);
    return { ok: false, reason: 'unknown', message: `Erro de rede ao validar token: ${e.message}` };
  }
}

async function processProject(projectRow) {
  const projectId = projectRow.id;
  const data = projectRow.data || {};
  const startTime = Date.now();
  let videoTitle = data.channelTheme || projectId;

  // Acquire distributed lock — prevents browser scheduler from running
  // the same project at the same time as this GitHub Actions runner.
  const { acquired: lockAcquired } = await acquireLock(projectId, 90);

  if (!lockAcquired) {
    log('⏭️', `Lock não adquirido para "${data.channelTheme}" — já rodando em outro lugar`);
    await safeInsertAutopilotLog({
      project_id: projectId,
      status: 'retrying',
      message: 'Lock não obtido: outro runner está processando este projeto',
      step: 'idea',
      runner: 'github-actions',
    });
    return false;
  }

  // Load per-user API keys (Gemini/Pexels) — owner of this project
  await loadUserKeys(projectRow.user_email);
  if (!GEMINI_API_KEY) {
    log('❌', `No Gemini key configured for user ${projectRow.user_email}. Skipping.`);
    if (!data.scheduleSettings) data.scheduleSettings = {};
    if (data.scheduleSettings.autoGenerate) {
      data.scheduleSettings.nextScheduledRun = calculateNextRunIso(data.scheduleSettings);
      await persistProjectData(projectId, data, 'Next run saved after missing Gemini key');
    }
    await safeInsertAutopilotLog({
      project_id: projectId,
      status: 'error',
      message: 'Gemini API key ausente. Salve a chave em Configurações ou no GitHub Actions.',
      step: 'idea',
      runner: 'github-actions',
    });
    await releaseLock(projectId);
    return false;
  }

  // Ensure projectId is accessible inside data for token lookup
  data.id = projectId;

  // Proactive YouTube check — decides upfront whether this run can publish and
  // whether a video parked as "upload pendente" can now be finished.
  const tokenHealth = await checkYoutubeTokenHealth(projectId, projectRow.user_email);
  if (!tokenHealth.ok) {
    log('⚠️', `YouTube indisponível (${tokenHealth.reason}): ${tokenHealth.message} — o vídeo será gerado e ficará agendado.`);
    await safeInsertAutopilotLog({
      project_id: projectId,
      status: 'retrying',
      message: `YouTube não conectado (${tokenHealth.reason}): o vídeo será gerado e publicado automaticamente após a reconexão. ${tokenHealth.message}`,
      step: 'upload',
      runner: 'github-actions',
    });
  }

  // Resume mode: a previous run failed (backoff elapsed) or a finished video is
  // waiting for the channel to come back.
  const resumeVideo = findRetryableVideo(data, Date.now(), tokenHealth.ok);
  const isResume = !!resumeVideo;
  let videoId = resumeVideo?.id || null;

  log('🚀', isResume
    ? `Retomando "${resumeVideo.title}" (tentativa ${(resumeVideo.retryCount || 0) + 1}/${MAX_AUTO_RETRIES})`
    : `Processing project: "${data.channelTheme}" (${projectId})`);

  await safeInsertAutopilotLog({
    project_id: projectId,
    status: 'running',
    message: isResume
      ? `Retomando do passo "${resumeVideo.standbyInfo?.failedStep || 'upload'}" (tentativa ${(resumeVideo.retryCount || 0) + 1}/${MAX_AUTO_RETRIES})`
      : 'Runner headless iniciou o pipeline',
    step: resumeVideo?.standbyInfo?.failedStep || 'idea',
    video_title: isResume ? resumeVideo.title : undefined,
    runner: 'github-actions',
  });


  let currentStep = 'idea';
  try {
    let idea;

    if (isResume) {
      // Reuse the existing draft instead of consuming a new brainstorm idea.
      currentStep = 'idea';
      idea = {
        topic: resumeVideo.title,
        context: resumeVideo.specificContext || '',
        specificContext: resumeVideo.specificContext || '',
      };
      videoTitle = resumeVideo.title;
      await updateRunnerVideo(projectId, data, videoId, {
        status: 'DRAFT',
        standbyInfo: undefined,
      }, 'Retry started');
    } else {
      // Step 1: Idea
      currentStep = 'idea';
      await safeInsertAutopilotLog({ project_id: projectId, status: 'running', message: 'Buscando/criando ideia no Brainstorm', step: currentStep, runner: 'github-actions' });
      idea = await stepIdea(data);

      // Update ideas in Supabase
      if (idea.updatedIdeas) {
        data.ideas = idea.updatedIdeas;
        await persistProjectData(projectId, data, 'Brainstorm saved');
      }

      videoTitle = idea.topic;
      videoId = `auto_${Date.now()}`;
      if (!data.videos) data.videos = [];
      data.videos.unshift({
        id: videoId,
        projectId,
        title: idea.topic,
        status: 'DRAFT',
        targetDuration: data.defaultDuration || 'Standard (5-8 min)',
        format: data.defaultFormat || 'Landscape 16:9',
        specificContext: idea.specificContext || idea.context || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await persistProjectData(projectId, data, 'Draft video saved');
    }

    // Step 2: Script — reused on resume (already persisted, no need to pay again)
    currentStep = 'script';
    let script = isResume && resumeVideo.script?.segments?.length ? resumeVideo.script : null;
    if (script) {
      log('♻️', 'Roteiro reaproveitado do vídeo em standby');
    } else {
      await safeInsertAutopilotLog({ project_id: projectId, status: 'running', message: 'Gerando roteiro', step: currentStep, video_title: videoTitle, runner: 'github-actions' });
      script = await stepScript(idea.topic, data);
    }
    await updateRunnerVideo(projectId, data, videoId, { script, status: 'SCRIPTING' }, 'Script saved');


    // Step 3: Voice/Narration
    currentStep = 'voice';
    await safeInsertAutopilotLog({ project_id: projectId, status: 'running', message: 'Gerando narração', step: currentStep, video_title: videoTitle, runner: 'github-actions' });
    const voiceResult = await stepVoice(script, data);
    const audioBase64 = voiceResult.audioBase64;
    const audioMimeType = voiceResult.mimeType;
    await updateRunnerVideo(projectId, data, videoId, { audioUrl: '__runner_audio__', status: 'AUDIO_GENERATED' }, 'Voice state saved');

    // Step 4: Visuals — reused on resume when the persisted URLs are real
    currentStep = 'visuals';
    let scenes = isResume ? reusableScenes(resumeVideo) : null;
    if (scenes) {
      log('♻️', `Visuais reaproveitados (${scenes.length} cenas)`);
    } else {
      await safeInsertAutopilotLog({ project_id: projectId, status: 'running', message: 'Buscando/gerando visuais', step: currentStep, video_title: videoTitle, runner: 'github-actions' });
      scenes = await stepVisuals(script, data);
    }
    await updateRunnerVideo(projectId, data, videoId, { visualScenes: scenes, status: 'VIDEO_GENERATED' }, 'Visuals saved');

    // Step 5: Thumbnail (optional — does not break pipeline)
    currentStep = 'thumbnail';
    await safeInsertAutopilotLog({ project_id: projectId, status: 'running', message: 'Gerando thumbnail', step: currentStep, video_title: videoTitle, runner: 'github-actions' });
    let thumbnailBase64 = null;
    try {
      const thumbResult = await stepThumbnail(idea.topic, script, data);
      thumbnailBase64 = thumbResult?.thumbnailBase64 || null;
      if (thumbnailBase64) await updateRunnerVideo(projectId, data, videoId, { thumbnailUrl: `data:image/jpeg;base64,${thumbnailBase64}` }, 'Thumbnail saved');
      if (thumbnailBase64) log('🖼️', 'Thumbnail image generated');
      else log('⚠️', 'Thumbnail not generated, continuing without it');
    } catch {
      log('⚠️', 'Thumbnail failed, continuing without it');
    }

    // Step 6: Metadata — reused on resume
    currentStep = 'metadata';
    let metadata;
    if (isResume && resumeVideo.videoMetadata?.youtubeTitle) {
      metadata = { ...resumeVideo.videoMetadata, title: resumeVideo.videoMetadata.youtubeTitle };
      log('♻️', 'Metadados reaproveitados do vídeo em standby');
    } else {
      await safeInsertAutopilotLog({ project_id: projectId, status: 'running', message: 'Gerando título, descrição e tags', step: currentStep, video_title: videoTitle, runner: 'github-actions' });
      metadata = await stepMetadata(idea.topic, script, data);
    }
    videoTitle = metadata.youtubeTitle || metadata.title || idea.topic;
    await updateRunnerVideo(projectId, data, videoId, { title: videoTitle, videoMetadata: {
      youtubeTitle: metadata.youtubeTitle || metadata.title || idea.topic,
      youtubeDescription: metadata.youtubeDescription || metadata.description || '',
      tags: metadata.tags || [],
      categoryId: metadata.categoryId || '22',
      visibility: metadata.visibility || 'public',
    } }, 'Metadata saved');

    // Step 7: Render Video (now receives audio!)
    currentStep = 'render';
    await safeInsertAutopilotLog({ project_id: projectId, status: 'running', message: 'Renderizando vídeo no runner headless', step: currentStep, video_title: videoTitle, runner: 'github-actions' });
    const renderResult = await stepRenderVideo(scenes, script, audioBase64, thumbnailBase64, data, audioMimeType);

    if (!data.scheduleSettings) data.scheduleSettings = {};
    data.scheduleSettings.nextScheduledRun = calculateNextRunIso(data.scheduleSettings);

    // Step 8: Upload — skipped (not failed!) when the channel is disconnected.
    // The video stays SCHEDULED and publishes automatically after reconnection.
    if (!tokenHealth.ok) {
      currentStep = 'upload';
      cleanupTmp(renderResult.tmpDir);
      await updateRunnerVideo(projectId, data, videoId, {
        status: 'SCHEDULED',
        scheduledDate: new Date().toISOString(),
        retryCount: 0,
        nextRetryAt: undefined,
        standbyInfo: undefined,
        lastError: `Upload pendente: ${tokenHealth.message}`,
      }, 'Scheduled video saved (YouTube desconectado)');

      const waitDuration = Math.round((Date.now() - startTime) / 1000);
      await safeInsertAutopilotLog({
        project_id: projectId,
        status: 'success',
        message: `Vídeo pronto e agendado. Publicação automática assim que o canal for reconectado. (${tokenHealth.message})`,
        step: 'render',
        video_title: videoTitle,
        elapsed_ms: waitDuration * 1000,
        runner: 'github-actions',
      });
      log('🕒', `Vídeo pronto em ${waitDuration}s, aguardando reconexão do YouTube.`);
      return true;
    }

    currentStep = 'upload';
    await safeInsertAutopilotLog({ project_id: projectId, status: 'running', message: 'Enviando vídeo para o YouTube', step: currentStep, video_title: videoTitle, runner: 'github-actions' });
    const uploadResult = await stepUploadYouTube(data, metadata, renderResult, thumbnailBase64, projectRow.user_email);

    await updateRunnerVideo(projectId, data, videoId, {
      status: 'PUBLISHED',
      youtubeUrl: uploadResult?.videoUrl || null,
      retryCount: 0,
      nextRetryAt: undefined,
      standbyInfo: undefined,
      lastError: undefined,
    }, 'Published video saved');

    // Log success
    const duration = Math.round((Date.now() - startTime) / 1000);
    await safeInsertAutopilotLog({
      project_id: projectId,
      status: 'success',
      message: `Publicado: ${uploadResult?.videoUrl || 'sem URL'}`,
      step: 'upload',
      video_title: videoTitle,
      elapsed_ms: duration * 1000,
      runner: 'github-actions',
    });

    log('🎉', `Project complete! Duration: ${duration}s. Next run: ${data.scheduleSettings.nextScheduledRun}`);
    return true;
  } catch (err) {
    const duration = Math.round((Date.now() - startTime) / 1000);
    log('❌', `Failed at step "${currentStep}": ${err.message}`);

    const standbyInfo = {
      failedStep: currentStep,
      errorMessage: err.message,
      failedAt: new Date().toISOString(),
    };
    data.standbyInfo = standbyInfo;
    if (data.scheduleSettings?.autoGenerate) {
      data.scheduleSettings.nextScheduledRun = calculateNextRunIso(data.scheduleSettings);
    }

    if (videoId) {
      // Auto-retry with backoff instead of waiting for a human click.
      const previousRetries = (resumeVideo?.retryCount || 0);
      const retryCount = previousRetries + 1;
      const exhausted = retryCount >= MAX_AUTO_RETRIES;
      const nextRetryAt = exhausted ? null : new Date(Date.now() + retryBackoffMs(previousRetries)).toISOString();

      await updateRunnerVideo(projectId, data, videoId, {
        status: 'STANDBY',
        standbyInfo,
        retryCount,
        nextRetryAt: nextRetryAt || undefined,
        lastError: err.message,
      }, 'Standby video saved');

      await safeInsertAutopilotLog({
        project_id: projectId,
        status: exhausted ? 'error' : 'retrying',
        message: exhausted
          ? `Falhou ${retryCount}x em "${currentStep}" — aguardando ação manual. Último erro: ${err.message}`
          : `Falhou em "${currentStep}" (tentativa ${retryCount}/${MAX_AUTO_RETRIES}). Nova tentativa automática em ${new Date(nextRetryAt).toLocaleString('pt-BR')}. Erro: ${err.message}`,
        step: currentStep,
        video_title: videoTitle,
        elapsed_ms: duration * 1000,
        runner: 'github-actions',
      });

      log(exhausted ? '🛑' : '🔁', exhausted
        ? `Tentativas esgotadas para "${videoTitle}"`
        : `Retry agendado para ${nextRetryAt}`);
      return false;
    }

    await persistProjectData(projectId, data, 'Standby project saved');
    await safeInsertAutopilotLog({
      project_id: projectId,
      status: 'error',
      message: err.message,
      step: currentStep,
      video_title: videoTitle,
      elapsed_ms: duration * 1000,
      runner: 'github-actions',
    });

    return false;
  } finally {
    if (data.scheduleSettings?.autoGenerate && !data.scheduleSettings.nextScheduledRun) {
      data.scheduleSettings.nextScheduledRun = calculateNextRunIso(data.scheduleSettings);
      await persistProjectData(projectId, data, 'Next run saved');
    }
    // Always release the lock — even on crash — so the project isn't
    // permanently blocked from future runs.
    await releaseLock(projectId);
  }
}


// --- ENTRY POINT ---

async function main() {
  log('🤖', '=== Automation Runner Started ===');

  const ready = await preflight();
  await writeHeartbeat(ready ? 'ciclo iniciado' : 'ciclo iniciado com schema incompleto');
  if (!ready) {
    process.exit(1);
  }

  let query = supabase.from('projects').select('*');

  // If specific project ID provided, only process that one
  if (PROJECT_ID) {
    log('🎯', `Targeting specific project: ${PROJECT_ID}`);
    query = query.eq('id', PROJECT_ID);
  }

  const { data: projects, error } = await query;

  if (error) {
    log('❌', `Failed to fetch projects: ${error.message}`);
    await writeHeartbeat(`erro ao buscar projetos: ${error.message}`);
    process.exit(1);
  }

  if (!projects?.length) {
    log('📭', 'No projects found');
    await writeHeartbeat('nenhum projeto encontrado');
    process.exit(0);
  }

  // Filter eligible projects
  const now = new Date();
  const nowMs = now.getTime();

  log('🔍', `Verificando ${projects.length} projeto(s):`);
  for (const p of projects) {
    const d = p.data;
    const autoGen = d?.scheduleSettings?.autoGenerate;
    const nextRun = d?.scheduleSettings?.nextScheduledRun || 'nunca definido';
    log('   ', `"${d?.channelTheme || p.id}": autoGenerate=${autoGen}, nextRun=${nextRun}`);
  }

  const skippedOff = [];
  const eligible = projects.filter((p) => {
    const d = p.data;
    if (PROJECT_ID) return true;
    if (!d?.scheduleSettings?.autoGenerate) {
      skippedOff.push(d?.channelTheme || p.id);
      return false;
    }
    // A failed video whose backoff elapsed makes the project eligible right
    // away, independent of the normal publishing schedule.
    if (findRetryableVideo(d, nowMs, true)) return true;

    const nextRun = d.scheduleSettings?.nextScheduledRun
      ? new Date(d.scheduleSettings.nextScheduledRun)
      : new Date(0);
    return nextRun <= now;
  });

  if (skippedOff.length) {
    log('⏭️', `${skippedOff.length} projeto(s) com Auto-Pilot desligado: ${skippedOff.join(', ')}`);
  }

  log('📋', `${projects.length} projeto(s) encontrados, ${eligible.length} elegível(is)`);

  let successCount = 0;
  let errorCount = 0;

  for (const project of eligible) {
    const ok = await processProject(project);
    if (ok) successCount++;
    else errorCount++;
  }

  await writeHeartbeat(`ciclo concluído: ${successCount} ok, ${errorCount} falha(s), ${eligible.length} elegível(is)`);
  log('🏁', `=== Done! ✅ ${successCount} success, ❌ ${errorCount} errors ===`);
}

main().catch(async (err) => {
  log('💀', `Fatal error: ${err.message}`);
  await writeHeartbeat(`erro fatal: ${err.message}`);
  process.exit(1);
});

