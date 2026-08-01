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

async function loadUserKeys(userEmail) {
  if (!userEmail) return;
  if (!SCHEMA.user_settings) return; // schema incompleto — segue com chaves do ENV

  try {
    const { data } = await supabase
      .from('user_settings')
      .select('gemini_api_keys, pexels_api_key')
      .eq('user_email', userEmail)
      .maybeSingle();
    if (data?.gemini_api_keys?.length) {
      GEMINI_API_KEYS = data.gemini_api_keys.filter(Boolean);
      GEMINI_KEY_INDEX = 0;
      GEMINI_API_KEY = GEMINI_API_KEYS[0];
      log('🔑', `Loaded ${GEMINI_API_KEYS.length} Gemini key(s) for ${userEmail}`);
    } else if (ENV_GEMINI_API_KEY || VITE_GEMINI_API_KEY) {
      GEMINI_API_KEYS = [ENV_GEMINI_API_KEY || VITE_GEMINI_API_KEY];
      GEMINI_API_KEY = GEMINI_API_KEYS[0];
    }
    if (data?.pexels_api_key) {
      PEXELS_API_KEY = data.pexels_api_key;
      log('🔑', `Loaded Pexels key for ${userEmail}`);
    } else if (ENV_PEXELS_API_KEY || VITE_PEXELS_API_KEY) {
      PEXELS_API_KEY = ENV_PEXELS_API_KEY || VITE_PEXELS_API_KEY;
    }
  } catch (e) {
    log('⚠️', `Failed to load user_settings for ${userEmail}: ${e.message}`);
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

async function geminiGenerate(prompt, maxTokens = 4096) {
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.9 },
    }
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

  // 2️⃣ Fallback to Gemini 2.0 Flash image-generation (no allowlist needed)
  const FLASH_MODELS = [
    'gemini-2.0-flash-preview-image-generation',
    'gemini-2.0-flash-exp',
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

  const res = await axios.post(
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
    }
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

async function stepVisuals(script, projectData) {
  log('🎨', 'Step 4: Searching visuals...');
  const usedIds = new Set();
  const toneModifier = getToneModifier(projectData.defaultTone);
  const scenes = [];

  // Keep each media on screen at most this many seconds — configurable per-project
  const MAX_MEDIA_DUR = Math.max(2, Number(projectData.maxMediaDurationSeconds) || 6);

  for (let i = 0; i < script.segments.length; i++) {
    const seg = script.segments[i];
    const prompts = getSegmentVisualPrompts(seg);

    const segDur = Math.max(2, Number(seg.estimatedDuration) || 5);
    // Split segment into N slots so no single media stays longer than MAX_MEDIA_DUR
    const slotCount = Math.max(prompts.length, Math.ceil(segDur / MAX_MEDIA_DUR));
    const useExactCut = slotCount === Math.ceil(segDur / MAX_MEDIA_DUR) && slotCount >= prompts.length;
    let currentStart = 0;

    for (let j = 0; j < slotCount; j++) {
      const basePrompt = prompts[j % prompts.length];
      const prompt = buildSlotVisualPrompt(seg, basePrompt, i, j, slotCount, projectData.channelTheme);
      const remaining = segDur - currentStart;
      const slotDur = useExactCut ? Math.min(MAX_MEDIA_DUR, remaining) : segDur / slotCount;
      const query = `${prompt} ${toneModifier}`.split(' ').slice(0, 4).join(' ');
      log('🔍', `  Searching (${j + 1}/${slotCount}): "${query}"`);

      let result = await searchPexels(query, usedIds);

      // Fallback: try without tone modifier
      if (!result) {
        const fallbackQuery = prompt.split(' ').slice(0, 3).join(' ');
        result = await searchPexels(fallbackQuery, usedIds);
      }

      // Fallback: niche-based
      if (!result) {
        result = await searchPexels(projectData.channelTheme || 'cinematic', usedIds);
      }

      // Final stock fallback: use Pexels photos before resorting to a generated placeholder.
      if (!result) {
        result = await searchPexels(query, usedIds, false)
          || await searchPexels(projectData.channelTheme || 'cinematic', usedIds, false);
      }

      let generatedImageUrl = null;
      if (!result?.imageUrl && !result?.thumbnailUrl) {
        const b64 = await geminiGenerateImage(`${prompt}. Cinematic video scene, no text, no watermark, 16:9.`);
        if (b64) generatedImageUrl = `data:image/jpeg;base64,${b64}`;
      }

      scenes.push({
        segmentIndex: i,
        prompt,
        duration: slotDur,
        videoUrl: result?.videoUrl,
        imageUrl: result?.imageUrl || result?.thumbnailUrl || generatedImageUrl || createFallbackVisualDataUrl(prompt, i * 100 + j),
        effect: ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'zoom-in-fast'][(i + j) % 5],
      });
      currentStart += slotDur;

      // Rate limit
      if (i > 0 || j > 0) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  log('✅', `Found ${scenes.length} visual scenes (max ${MAX_MEDIA_DUR}s per media)`);
  return scenes;
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

  const result = await geminiWithRetry(() => geminiGenerateJSON(prompt));

  const fullPrompt = `YouTube thumbnail, ${toneStyle} style, text overlay "${result.clickbaitText}", ${result.imagePrompt}, high contrast, bold colors, professional design, 16:9 aspect ratio, no watermark`;

  // Try to generate actual thumbnail image
  const thumbnailBase64 = await geminiWithRetry(() => geminiGenerateImage(fullPrompt));

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

async function processProject(projectRow) {
  const projectId = projectRow.id;
  const data = projectRow.data || {};
  const startTime = Date.now();
  let videoId = null;
  let videoTitle = data.channelTheme || projectId;

  // Acquire distributed lock — prevents browser scheduler from running
  // the same project at the same time as this GitHub Actions runner.
  const { data: lockAcquired, error: lockError } = await supabase
    .rpc('acquire_autopilot_lock', {
      p_project_id: String(projectId),
      p_locked_by: 'github-actions',
      p_lock_minutes: 90,
    });

  if (lockError) {
    log('❌', `Lock RPC error: ${lockError.message} — aplique as migrations 003 e 005 no Supabase`);
    await safeInsertAutopilotLog({
      project_id: projectId,
      status: 'error',
      message: `Lock RPC error: ${lockError.message}`,
      step: 'idea',
      runner: 'github-actions',
    });
    return false;
  }
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

  log('🚀', `Processing project: "${data.channelTheme}" (${projectId})`);
  await safeInsertAutopilotLog({
    project_id: projectId,
    status: 'running',
    message: 'Runner headless iniciou o pipeline',
    step: 'idea',
    runner: 'github-actions',
  });

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
    try { await supabase.rpc('release_autopilot_lock', { p_project_id: projectId }); } catch {}
    return false;
  }

  // Ensure projectId is accessible inside data for token lookup
  data.id = projectId;

  let currentStep = 'idea';
  try {
    // Step 1: Idea
    currentStep = 'idea';
    await safeInsertAutopilotLog({ project_id: projectId, status: 'running', message: 'Buscando/criando ideia no Brainstorm', step: currentStep, runner: 'github-actions' });
    const idea = await stepIdea(data);

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

    // Step 2: Script
    currentStep = 'script';
    await safeInsertAutopilotLog({ project_id: projectId, status: 'running', message: 'Gerando roteiro', step: currentStep, video_title: videoTitle, runner: 'github-actions' });
    const script = await stepScript(idea.topic, data);
    await updateRunnerVideo(projectId, data, videoId, { script, status: 'SCRIPTING' }, 'Script saved');

    // Step 3: Voice/Narration
    currentStep = 'voice';
    await safeInsertAutopilotLog({ project_id: projectId, status: 'running', message: 'Gerando narração', step: currentStep, video_title: videoTitle, runner: 'github-actions' });
    const voiceResult = await stepVoice(script, data);
    const audioBase64 = voiceResult.audioBase64;
    const audioMimeType = voiceResult.mimeType;
    await updateRunnerVideo(projectId, data, videoId, { audioUrl: '__runner_audio__', status: 'AUDIO_GENERATED' }, 'Voice state saved');

    // Step 4: Visuals
    currentStep = 'visuals';
    await safeInsertAutopilotLog({ project_id: projectId, status: 'running', message: 'Buscando/gerando visuais', step: currentStep, video_title: videoTitle, runner: 'github-actions' });
    const scenes = await stepVisuals(script, data);
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

    // Step 6: Metadata
    currentStep = 'metadata';
    await safeInsertAutopilotLog({ project_id: projectId, status: 'running', message: 'Gerando título, descrição e tags', step: currentStep, video_title: videoTitle, runner: 'github-actions' });
    const metadata = await stepMetadata(idea.topic, script, data);
    videoTitle = metadata.youtubeTitle || metadata.title || idea.topic;
    await updateRunnerVideo(projectId, data, videoId, { title: videoTitle, videoMetadata: {
      youtubeTitle: metadata.youtubeTitle || metadata.title || idea.topic,
      youtubeDescription: metadata.youtubeDescription || metadata.description || '',
      tags: metadata.tags || [],
      categoryId: metadata.categoryId || '22',
      visibility: 'public',
    } }, 'Metadata saved');

    // Step 7: Render Video (now receives audio!)
    currentStep = 'render';
    await safeInsertAutopilotLog({ project_id: projectId, status: 'running', message: 'Renderizando vídeo no runner headless', step: currentStep, video_title: videoTitle, runner: 'github-actions' });
    const renderResult = await stepRenderVideo(scenes, script, audioBase64, thumbnailBase64, data, audioMimeType);

    // Step 8: Upload
    currentStep = 'upload';
    await safeInsertAutopilotLog({ project_id: projectId, status: 'running', message: 'Enviando vídeo para o YouTube', step: currentStep, video_title: videoTitle, runner: 'github-actions' });
    const uploadResult = await stepUploadYouTube(data, metadata, renderResult, thumbnailBase64, projectRow.user_email);

    if (!data.scheduleSettings) data.scheduleSettings = {};
    data.scheduleSettings.nextScheduledRun = calculateNextRunIso(data.scheduleSettings);

    await updateRunnerVideo(projectId, data, videoId, {
      status: 'PUBLISHED',
      youtubeUrl: uploadResult?.videoUrl || null,
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
      await updateRunnerVideo(projectId, data, videoId, {
        status: 'STANDBY',
        standbyInfo,
      }, 'Standby video saved');
    } else {
      await persistProjectData(projectId, data, 'Standby project saved');
    }

    // Log error
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
    try {
      await supabase.rpc('release_autopilot_lock', { p_project_id: projectId });
    } catch (e) {
      log('⚠️', `Failed to release autopilot lock for ${projectId}: ${e.message}`);
    }
  }
}

// --- ENTRY POINT ---

async function main() {
  log('🤖', '=== Automation Runner Started ===');

  let query = supabase.from('projects').select('*');

  // If specific project ID provided, only process that one
  if (PROJECT_ID) {
    log('🎯', `Targeting specific project: ${PROJECT_ID}`);
    query = query.eq('id', PROJECT_ID);
  }

  const { data: projects, error } = await query;

  if (error) {
    log('❌', `Failed to fetch projects: ${error.message}`);
    process.exit(1);
  }

  if (!projects?.length) {
    log('📭', 'No projects found');
    process.exit(0);
  }

  // Filter eligible projects
  const now = new Date();

  log('🔍', `Verificando ${projects.length} projeto(s):`);
  for (const p of projects) {
    const d = p.data;
    const autoGen = d?.scheduleSettings?.autoGenerate;
    const nextRun = d?.scheduleSettings?.nextScheduledRun || 'nunca definido';
    log('   ', `"${d?.channelTheme || p.id}": autoGenerate=${autoGen}, nextRun=${nextRun}`);
  }

  const eligible = projects.filter((p) => {
    const d = p.data;
    if (PROJECT_ID) return true;
    if (!d?.scheduleSettings?.autoGenerate) {
      log('⏭️', `"${d?.channelTheme || p.id}" pulado: autoGenerate não está ativado`);
      return false;
    }
    const nextRun = d.scheduleSettings?.nextScheduledRun
      ? new Date(d.scheduleSettings.nextScheduledRun)
      : new Date(0);
    return nextRun <= now;
  });

  log('📋', `${projects.length} projeto(s) encontrados, ${eligible.length} elegível(is)`);

  let successCount = 0;
  let errorCount = 0;

  for (const project of eligible) {
    const ok = await processProject(project);
    if (ok) successCount++;
    else errorCount++;
  }

  log('🏁', `=== Done! ✅ ${successCount} success, ❌ ${errorCount} errors ===`);
}

main().catch((err) => {
  log('💀', `Fatal error: ${err.message}`);
  process.exit(1);
});
