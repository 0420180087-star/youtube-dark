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

// Shared visuals-resolution engine (Fase 2: unificação com o app). Same
// Pexels→Gemini logic, reuse-on-resume, and no-placeholder guarantee as the
// browser. Requires running this script with `tsx` (see package.json /
// auto-post.yml) since these are .ts files — plain `node` can't resolve them.
import { resolveVisualSlots } from '../src/services/visualsPipeline.ts';
import { setInjectedPexelsKey } from '../src/services/pexelsService.ts';
import { setInjectedGeminiKeys } from '../src/services/geminiCore.ts';
import { buildSlotVisualPrompt, collectPexelsIds, getSegmentVisualPrompts } from '../src/services/visualSceneService.ts';
import { generateVoiceover } from '../src/services/geminiCore.ts';

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
  automation_quota_events: true,
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

  // Tabela opcional (observabilidade de cota) — ausência não bloqueia o run.
  SCHEMA.automation_quota_events = await tableExists('automation_quota_events');


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
      .eq('id', String(projectId))
      .then(() => {});
  } catch (e) {
    log('⚠️', `Failed to release autopilot lock for ${projectId}: ${e.message}`);
  }
}

// O lock tem validade fixa (LOCK_MINUTES). Um projeto longo (render + upload)
// pode passar dessa janela: o lock cai, a execução seguinte pega o MESMO
// projeto e publica de novo. Renovar o prazo periodicamente enquanto o
// projeto processa elimina essa duplicata.
const LOCK_MINUTES = 45;
const LOCK_RENEW_MS = 5 * 60 * 1000;

async function renewLock(projectId) {
  try {
    await supabase
      .from('projects')
      .update({
        autopilot_locked_until: new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString(),
        autopilot_locked_by: 'github-actions',
      })
      .eq('id', String(projectId))
      .eq('autopilot_locked_by', 'github-actions');
  } catch { /* non-fatal — na pior hipótese o lock expira como antes */ }
}

function startLockRenewal(projectId) {
  const timer = setInterval(() => { renewLock(projectId); }, LOCK_RENEW_MS);
  timer.unref?.();
  return () => clearInterval(timer);
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

// ─── Cota do Gemini: detecção, cooldown por chave e rotação ─────────────────
// Portado de src/services/geminiCore.ts (isQuotaError / getCooldownMs /
// keyCooldowns / isKeyReady) para o runner ter o MESMO comportamento do
// navegador. Não duplicar limiares: 503 → 15s, diária → 30min, RPM → 65s.

/** key -> { availableAt, reason, cooldownMs } */
const keyCooldowns = new Map();

function isQuotaError(err) {
  if (!err) return false;
  const status = err.response?.status || err.status || err.error?.code || err.code;
  if (status === 429 || status === '429' || status === 503 || status === '503') return true;

  const body = err.response?.data;
  const bodyStatus = String(body?.error?.status || '').toUpperCase();
  if (['RESOURCE_EXHAUSTED', 'TOO_MANY_REQUESTS', 'UNAVAILABLE'].includes(bodyStatus)) return true;
  const bodyCode = body?.error?.code;
  if (bodyCode === 429 || bodyCode === 503) return true;

  const msg = String(err.message || '').toLowerCase();
  return [
    'quota', 'rate_limit', 'rate limit', 'too many requests', 'resource_exhausted',
    'requests per', 'limit exceeded', 'exceeded your current quota', '429', '503',
    'unavailable', 'high demand', 'overloaded', 'try again later',
  ].some((kw) => msg.includes(kw));
}

/** Extrai o RetryInfo/retry-after quando o Google manda; senão heurística. */
function getCooldownMs(err) {
  const body = err?.response?.data;
  const retryAfter = err?.response?.headers?.['retry-after'];
  if (retryAfter) {
    const s = parseInt(retryAfter, 10);
    if (!isNaN(s) && s > 0) return s * 1000;
  }

  const details = body?.error?.details;
  if (Array.isArray(details)) {
    for (const d of details) {
      const delay = d?.retryDelay || d?.retry_delay;
      if (typeof delay === 'string') {
        const s = parseFloat(delay.replace('s', ''));
        if (!isNaN(s) && s > 0) return Math.ceil(s * 1000);
      }
    }
  }

  const status = err?.response?.status || body?.error?.code;
  const raw = `${err?.message || ''} ${JSON.stringify(body?.error?.message || '')}`.toLowerCase();

  if (status === 503 || raw.includes('unavailable') || raw.includes('high demand') || raw.includes('overloaded')) {
    return 15_000;
  }
  if (raw.includes('per-day') || raw.includes('per_day') || raw.includes('rpd') || raw.includes('daily')) {
    return 30 * 60 * 1000;
  }
  return 65_000;
}

function quotaReason(err) {
  const status = err?.response?.status || err?.response?.data?.error?.code;
  const raw = String(err?.message || '').toLowerCase();
  if (status === 503 || raw.includes('unavailable') || raw.includes('overloaded')) return 'Servidor sobrecarregado (503)';
  if (raw.includes('per-day') || raw.includes('rpd') || raw.includes('daily')) return 'Limite diário (RPD) atingido';
  return 'Limite por minuto (RPM/429) atingido';
}

function maskKey(key) {
  if (!key) return '(vazia)';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function isKeyReady(key) {
  const cd = keyCooldowns.get(key);
  if (!cd) return true;
  if (Date.now() >= cd.availableAt) {
    keyCooldowns.delete(key);
    return true;
  }
  return false;
}

/** Menor tempo restante até alguma chave voltar. null se alguma já está pronta. */
function shortestCooldownMs() {
  if (GEMINI_API_KEYS.some((k) => isKeyReady(k))) return null;
  let min = Infinity;
  for (const k of GEMINI_API_KEYS) {
    const cd = keyCooldowns.get(k);
    if (cd) min = Math.min(min, cd.availableAt - Date.now());
  }
  return min === Infinity ? null : Math.max(1000, min);
}

/** Registra o evento de cota no Supabase para o painel de Saúde ver. */
async function recordQuotaEvent(key, err, cooldownMs) {
  if (!SCHEMA.automation_quota_events) return;
  try {
    await supabase.from('automation_quota_events').insert({
      user_email: CURRENT_USER_EMAIL || 'unknown@runner',
      runner: 'github-actions',
      key_masked: maskKey(key),
      reason: quotaReason(err),
      cooldown_ms: cooldownMs,
    });
  } catch (e) {
    log('⚠️', `Falha ao registrar evento de cota: ${e.message}`);
  }
}

/** Coloca a chave atual em cooldown e persiste o evento. */
async function cooldownCurrentKey(err) {
  const key = GEMINI_API_KEY;
  const ms = getCooldownMs(err);
  keyCooldowns.set(key, { availableAt: Date.now() + ms, reason: quotaReason(err), cooldownMs: ms });
  log('🧊', `Chave ${maskKey(key)} em cooldown por ${Math.round(ms / 1000)}s — ${quotaReason(err)}`);
  await recordQuotaEvent(key, err, ms);
}

/** Move para a próxima chave PRONTA. Retorna false se todas estão em cooldown. */
function rotateGeminiKey() {
  if (!GEMINI_API_KEYS.length) return false;
  for (let i = 1; i <= GEMINI_API_KEYS.length; i++) {
    const idx = (GEMINI_KEY_INDEX + i) % GEMINI_API_KEYS.length;
    const candidate = GEMINI_API_KEYS[idx];
    if (isKeyReady(candidate)) {
      GEMINI_KEY_INDEX = idx;
      GEMINI_API_KEY = candidate;
      log('🔁', `Usando chave Gemini #${idx + 1}/${GEMINI_API_KEYS.length} (${maskKey(candidate)})`);
      return true;
    }
  }
  return false;
}

/** Erro sinalizando "todas as chaves em cooldown" — não gasta tentativa. */
class GeminiQuotaExhaustedError extends Error {
  constructor(waitMs, reason) {
    super(`Cota Gemini esgotada em todas as ${GEMINI_API_KEYS.length} chave(s) — ${reason}. Retomando em ${Math.ceil(waitMs / 60000)} min.`);
    this.name = 'GeminiQuotaExhaustedError';
    this.isQuotaExhausted = true;
    this.waitMs = waitMs;
    this.reason = reason;
  }
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
      keyCooldowns.clear();
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

let geminiRequestCount = 0;

async function geminiGenerate(prompt, maxTokens = 4096) {
  geminiRequestCount++;
  const res = await raceTimeout(
    axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
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


// Em erro de cota: cooldown na chave + rotação para a próxima PRONTA, sem
// gastar tentativa. Só falha quando TODAS as chaves estão em cooldown — e nesse
// caso lança GeminiQuotaExhaustedError (o vídeo é reagendado, não marcado como
// falha definitiva).
async function geminiWithRetry(fn, retries = 3) {
  let attempt = 0;
  let lastErr = null;

  // Garante que a chave atual está pronta antes de começar.
  if (!isKeyReady(GEMINI_API_KEY) && !rotateGeminiKey()) {
    const wait = shortestCooldownMs() || 65_000;
    throw new GeminiQuotaExhaustedError(wait, keyCooldowns.get(GEMINI_API_KEY)?.reason || 'cota');
  }

  while (attempt < retries) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isQuotaError(err)) throw err;

      await cooldownCurrentKey(err);

      if (rotateGeminiKey()) {
        log('⏭️', 'Erro de cota — trocando de chave sem gastar tentativa.');
        continue; // rotação não consome tentativa
      }

      const wait = shortestCooldownMs() || getCooldownMs(err);
      // Espera curta (RPM/503) pode ser absorvida aqui mesmo.
      if (wait <= 90_000 && attempt < retries - 1) {
        attempt++;
        log('⏳', `Todas as chaves em cooldown — aguardando ${Math.round(wait / 1000)}s (tentativa ${attempt + 1}/${retries}).`);
        await new Promise((r) => setTimeout(r, wait + 1000));
        for (const k of GEMINI_API_KEYS) isKeyReady(k); // expira cooldowns vencidos
        rotateGeminiKey();
        continue;
      }

      throw new GeminiQuotaExhaustedError(wait, quotaReason(err));
    }
  }

  throw lastErr || new Error('geminiWithRetry: falha desconhecida');
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

// Implementação própria (não usa geminiWithRetry): o fallback aqui é por
// MODELO, não por tentativa. Cada modelo é tentado com a chave atual e, em erro
// de cota, a chave entra em cooldown e o mesmo modelo é retentado com a próxima
// chave pronta. 400/403/404 = modelo indisponível → próximo modelo.
async function geminiGenerateImage(prompt) {
  const IMAGE_MODELS = [
    { model: 'imagen-3.0-generate-001', kind: 'imagen' },
    { model: 'gemini-2.5-flash-image', kind: 'flash' },
    { model: 'gemini-2.0-flash-preview-image-generation', kind: 'flash' },
  ];

  const callModel = async ({ model, kind }) => {
    geminiRequestCount++;
    if (kind === 'imagen') {
      const res = await raceTimeout(
        axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${GEMINI_API_KEY}`,
          { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '16:9' } },
          { timeout: NET_TIMEOUT.IMAGE }
        ),
        NET_TIMEOUT.IMAGE + 5_000,
        `Gemini (${model})`
      );
      return res.data.predictions?.[0]?.bytesBase64Encoded || null;
    }

    const res = await raceTimeout(
      axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: `Generate a 16:9 cinematic image: ${prompt}` }] }],
          generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
        },
        { timeout: NET_TIMEOUT.IMAGE }
      ),
      NET_TIMEOUT.IMAGE + 5_000,
      `Gemini (${model})`
    );
    const parts = res.data.candidates?.[0]?.content?.parts || [];
    return parts.find((p) => p.inlineData?.data)?.inlineData?.data || null;
  };

  for (const entry of IMAGE_MODELS) {
    // Uma volta por chave disponível para este modelo.
    for (let keyTry = 0; keyTry < Math.max(1, GEMINI_API_KEYS.length); keyTry++) {
      if (!isKeyReady(GEMINI_API_KEY) && !rotateGeminiKey()) break;
      try {
        const b64 = await callModel(entry);
        if (b64) {
          log('🖼️', `Imagem gerada via ${entry.model}`);
          return b64;
        }
        break; // respondeu sem imagem — trocar de modelo, não de chave
      } catch (err) {
        const code = err?.response?.status;
        if (isQuotaError(err)) {
          await cooldownCurrentKey(err);
          if (rotateGeminiKey()) continue; // mesma modelo, próxima chave
          break; // todas em cooldown — tenta o próximo modelo (pode ser mais barato)
        }
        if (code !== 400 && code !== 403 && code !== 404) {
          log('⚠️', `${entry.model} falhou: ${err.message}`);
        }
        break; // modelo indisponível → próximo modelo
      }
    }
  }

  if (shortestCooldownMs()) {
    throw new GeminiQuotaExhaustedError(shortestCooldownMs(), 'cota de imagem esgotada');
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

  // Node has no localStorage — inject the keys loadUserKeys() already
  // resolved for this project's user (same pattern as the visuals step).
  setInjectedGeminiKeys(GEMINI_API_KEYS);

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

      const arrayBuffer = await generateVoiceover(text, projectData.defaultVoice || 'Fenrir', projectData.defaultTone || 'Cinematic');
      geminiRequestCount++;

      const normalizedPcm = await normalizeAudioChunkToPcm(Buffer.from(arrayBuffer), 'audio/pcm', tmpDir, i);
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

// Safety net only (not a normal operating limit) — protects against a
// corrupted/pathological duration value, not against legitimate long-form
// videos. A 25-min "Deep Dive" at a 4s pace needs ~375 slots; this leaves
// comfortable headroom above that so Long/Deep-Dive videos are never
// silently truncated.
const VISUAL_MAX_SLOTS_TOTAL = 500;
const VISUAL_SLOT_TIMEOUT_MS = 90_000;
const VISUAL_CONCURRENCY = 3;

// raceTimeout é definido uma única vez no topo do arquivo (helper de timeout
// compartilhado por TODAS as chamadas de rede do runner).


async function stepVisuals(script, projectData, existingScenes) {
  log('🎨', 'Step 4: Searching visuals...');

  // Node has no localStorage — inject the keys loadUserKeys() already
  // resolved for this project's user before calling into the shared
  // (browser-authored) resolution engine.
  setInjectedPexelsKey(PEXELS_API_KEY || null);
  setInjectedGeminiKeys(GEMINI_API_KEYS);

  // Keep each media on screen at most this many seconds — configurable per-project.
  // This is the authoritative limit; slot count is derived from it below,
  // never the other way around.
  const MAX_MEDIA_DUR = Math.max(2, Number(projectData.maxMediaDurationSeconds) || 6);

  // 1. Plan all slots up front — same shape as before, now also tracking
  // startTime/narratorText/sectionTitle, which the shared resolver uses for
  // richer Pexels queries.
  const slots = [];
  let cursorTime = 0;
  for (let i = 0; i < script.segments.length; i++) {
    const seg = script.segments[i];
    const prompts = getSegmentVisualPrompts(seg);
    const segDur = Math.max(2, Number(seg.estimatedDuration) || 5);
    // No per-segment cap: however many slots it takes to keep every slot at
    // or under MAX_MEDIA_DUR is how many it gets. A previous fixed cap of 8
    // silently let a long segment's slots run longer than configured —
    // exactly the "images stay static too long" bug.
    const slotCount = Math.max(1, prompts.length, Math.ceil(segDur / MAX_MEDIA_DUR));
    const slotDur = segDur / slotCount;

    for (let j = 0; j < slotCount; j++) {
      if (slots.length >= VISUAL_MAX_SLOTS_TOTAL) break;
      const basePrompt = prompts[j % prompts.length];
      slots.push({
        segmentIndex: i,
        slotInSegment: j,
        duration: slotDur,
        startTime: cursorTime,
        narratorText: seg.narratorText || basePrompt,
        sectionTitle: seg.sectionTitle || `Section ${i}`,
        prompt: buildSlotVisualPrompt(seg, basePrompt, i, j, slotCount, projectData.channelTheme),
      });
      cursorTime += slotDur;
    }
  }

  const total = slots.length;
  const pexelsUsedIds = collectPexelsIds(existingScenes || []);
  const project = {
    visualSourceMix: projectData.visualSourceMix,
    defaultTone: projectData.defaultTone,
    channelTheme: projectData.channelTheme,
    defaultFormat: projectData.defaultFormat,
  };
  const video = { format: projectData.defaultFormat || 'Landscape 16:9' };

  // 2. Resolve every slot through the shared engine: Pexels → Gemini, with
  // throttling, reuse of `existingScenes` where still valid, and no
  // placeholder in the output unless Pexels+Gemini are both down for the
  // entire video (see visualsPipeline.ts).
  const scenes = await resolveVisualSlots({
    project,
    video,
    slots,
    pexelsUsedIds,
    existingScenes: existingScenes && existingScenes.length === total ? existingScenes : undefined,
    force: false,
    concurrency: VISUAL_CONCURRENCY,
    slotTimeoutMs: VISUAL_SLOT_TIMEOUT_MS,
    geminiThrottleMs: 6_000,
    onSlotResolved: ({ origin, reason, doneCount, total: t }) => {
      const suffix = reason ? ` — ${reason}` : '';
      log('🔍', `  Scene ${doneCount}/${t} ready (${origin}${suffix})`);
    },
  });

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
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(`Falha ao buscar auth do projeto: ${error.message}`);
    authRow = data?.[0] || null;

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
        signal: AbortSignal.timeout(30_000),
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
  // autopilot_logs.user_email é NOT NULL em bancos já existentes — sem isso
  // todos os logs remotos eram silenciosamente rejeitados.
  const row = { user_email: payload.user_email || CURRENT_USER_EMAIL || 'unknown@runner', ...payload };
  // Heartbeat por passo: um render de 40 min deixava o painel "Saúde da
  // Automação" acusando "sem sinal" mesmo com tudo funcionando. Cada log de
  // passo em andamento também renova o sinal de vida.
  if (payload.status === 'running') {
    await writeHeartbeat(`${payload.step || 'pipeline'}: ${payload.video_title || payload.project_id || ''} — ${payload.message || ''}`);
  }
  try {

    const { error } = await supabase.from('autopilot_logs').insert(row);
    if (!error) return;

    // Older databases may not have the new columns yet; keep logging non-fatal.
    if ((error.message || '').includes('video_title') || (error.message || '').includes('elapsed_ms') || (error.message || '').includes('runner')) {
      const fallback = { ...row };
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

async function persistProjectData(projectId, data, message = 'Project data persisted', attempts = 1) {
  for (let i = 0; i < Math.max(1, attempts); i++) {
    const { error } = await supabase
      .from('projects')
      .update({ data, updated_at: new Date().toISOString() })
      .eq('id', projectId);
    if (!error) return true;
    log('⚠️', `${message} failed (tentativa ${i + 1}/${attempts}): ${error.message}`);
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  return false;
}

async function updateRunnerVideo(projectId, data, videoId, updates, logMessage, attempts = 1) {
  if (!data.videos) data.videos = [];
  const idx = data.videos.findIndex((v) => v.id === videoId);
  if (idx === -1) return false;
  data.videos[idx] = lightVideoRecord({
    ...data.videos[idx],
    ...updates,
    updatedAt: new Date().toISOString(),
  });
  return persistProjectData(projectId, data, logMessage || `Video ${videoId} updated`, attempts);
}


// --- RETRY POLICY ---
// Transient failures (Gemini "OTHER", network timeouts, Pexels 429) must not
// require a human click. Backoff: 5 min → 20 min → 1 h → 4 h, then give up.
const MAX_AUTO_RETRIES = 4;
const RETRY_BACKOFF_MS = [5 * 60 * 1000, 20 * 60 * 1000, 60 * 60 * 1000, 4 * 60 * 60 * 1000];

// Teto para reagendamentos por cota (que não gastam tentativa): evita mascarar
// cota permanentemente insuficiente como retry infinito silencioso.
const MAX_QUOTA_SKIPS = 12;
const QUOTA_SKIP_WINDOW_MS = 48 * 60 * 60 * 1000;


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

  const { data: authRows } = await supabase
    .from('project_auth')
    .select('youtube_refresh_token, youtube_access_token, token_expires_at')
    .eq('project_id', projectId)
    .eq('user_email', userEmail)
    .order('updated_at', { ascending: false })
    .limit(1);
  const authRow = authRows?.[0] || null;


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
      signal: AbortSignal.timeout(30_000),
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

/**
 * Checks whether we already KNOW (from a persisted event, possibly written
 * by a PREVIOUS, separate process) that this user's Gemini key was rate
 * limited very recently. The in-memory `keyCooldowns` map only lives for the
 * duration of a single process — each GitHub Actions run starts a fresh
 * Node process, so without this check a run has no memory of a 429 that
 * happened 2 minutes ago in the *previous* run, and burns another request
 * just to rediscover the same rate limit. This is the cross-run memory.
 */
async function recentQuotaExhaustion(userEmail) {
  if (!SCHEMA.automation_quota_events || !userEmail) return null;
  try {
    const { data, error } = await supabase
      .from('automation_quota_events')
      .select('created_at, reason, cooldown_ms')
      .eq('user_email', userEmail)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error || !data?.length) return null;

    const last = data[0];
    const elapsedMs = Date.now() - new Date(last.created_at).getTime();
    // Respects the cooldown computed for that event, capped to a sane range:
    // long enough to actually avoid re-hammering a per-minute limit, short
    // enough that a transient blip doesn't stall the project for hours.
    const windowMs = Math.min(Math.max(last.cooldown_ms || 65_000, 60_000), 30 * 60 * 1000);
    return elapsedMs < windowMs ? { ...last, remainingMs: windowMs - elapsedMs } : null;
  } catch {
    return null;
  }
}

async function processProject(projectRow) {
  const projectId = projectRow.id;
  const data = projectRow.data || {};
  const startTime = Date.now();
  let videoTitle = data.channelTheme || projectId;
  // Pedido explícito do usuário ("Executar Agora" no app) — ignora janela de
  // horário e cooldown de cota, porque alguém está esperando o resultado.
  const forceRun = !!data.scheduleSettings?.forceRun || !!PROJECT_ID;
  let stopLockRenewal = () => {};

  // Acquire distributed lock — prevents browser scheduler from running
  // the same project at the same time as this GitHub Actions runner.
  const { acquired: lockAcquired } = await acquireLock(projectId, LOCK_MINUTES);

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

  // Renova o lock enquanto o projeto processa — sem isso, um render longo
  // deixaria o lock expirar e a execução seguinte publicaria o mesmo vídeo.
  stopLockRenewal = startLockRenewal(projectId);

  // Load per-user API keys (Gemini/Pexels) — owner of this project
  CURRENT_USER_EMAIL = normalizeEmail(projectRow.user_email);
  await loadUserKeys(projectRow.user_email);
  if (!GEMINI_API_KEY) {
    log('❌', `Nenhuma chave Gemini disponível para ${CURRENT_USER_EMAIL} (nem em user_settings, nem no ambiente). Pulando.`);
    if (!data.scheduleSettings) data.scheduleSettings = {};
    if (data.scheduleSettings.autoGenerate) {
      // Retry curto: não perder o dia inteiro por um problema de leitura de chave.
      data.scheduleSettings.nextScheduledRun = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await persistProjectData(projectId, data, 'Retry em 30 min — chave Gemini indisponível');
    }
    await safeInsertAutopilotLog({
      project_id: projectId,
      status: 'error',
      message: 'Chave Gemini indisponível. Verifique Configurações (user_settings) — se o log acima mostrar "Falha ao ler user_settings", rode supabase/bootstrap.sql.',
      step: 'idea',
      runner: 'github-actions',
    });
    stopLockRenewal();
    await releaseLock(projectId);
    return false;
  }

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

  // Publicar um vídeo já renderizado não gasta uma única chamada ao Gemini —
  // então o circuit breaker de cota NÃO pode barrar esse caso.
  const isPendingUploadOnly = isResume
    && resumeVideo.status === 'SCHEDULED'
    && String(resumeVideo.lastError || '').startsWith(PENDING_UPLOAD_MARK);

  // Cross-run circuit breaker (see recentQuotaExhaustion) — a persisted
  // 429/quota event from moments ago (even from a *previous*, already-
  // finished process) means this key almost certainly still has no
  // headroom; skip this project now rather than pay for rediscovering that.
  if (!isPendingUploadOnly && !forceRun) {
    const recentExhaustion = await recentQuotaExhaustion(CURRENT_USER_EMAIL);
    if (recentExhaustion) {
      const secondsAgo = Math.round((Date.now() - new Date(recentExhaustion.created_at).getTime()) / 1000);
      const waitMin = Math.ceil(recentExhaustion.remainingMs / 60_000);
      log('🧊', `Pulando "${data.channelTheme}" — cota Gemini reportada esgotada há ${secondsAgo}s (${recentExhaustion.reason}). Evitando bater na mesma chave de novo; próxima janela em ~${waitMin} min.`);
      await safeInsertAutopilotLog({
        project_id: projectId,
        status: 'retrying',
        message: `Pulado nesta execução: cota Gemini esgotada recentemente (${recentExhaustion.reason}) — evitando nova tentativa imediata`,
        step: 'idea',
        runner: 'github-actions',
      });
      stopLockRenewal();
      await releaseLock(projectId);
      return false;
    }
  }

  // Idempotência: se o vídeo retomado já tem URL do YouTube, o upload anterior
  // deu certo e só a gravação do status falhou. Re-renderizar publicaria uma
  // duplicata no canal — apenas finalizamos o registro.
  if (isResume && resumeVideo.youtubeUrl) {
    log('✅', `"${resumeVideo.title}" já está publicado (${resumeVideo.youtubeUrl}) — apenas concluindo o registro.`);
    await updateRunnerVideo(projectId, data, videoId, {
      status: 'PUBLISHED',
      retryCount: 0,
      nextRetryAt: undefined,
      standbyInfo: undefined,
      lastError: undefined,
    }, 'Published video reconciled', 3);
    await safeInsertAutopilotLog({
      project_id: projectId,
      status: 'success',
      message: `Já publicado: ${resumeVideo.youtubeUrl} — registro reconciliado sem novo upload`,
      step: 'upload',
      video_title: resumeVideo.title,
      runner: 'github-actions',
    });
    stopLockRenewal();
    await releaseLock(projectId);
    return true;
  }

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

    // Step 4: Visuals — existing scenes from a resumed video are reused
    // per-slot by the shared engine wherever still valid (finer-grained
    // than before: a video that had 18/20 good scenes only redoes the 2
    // that failed, instead of all-or-nothing).
    currentStep = 'visuals';
    await safeInsertAutopilotLog({ project_id: projectId, status: 'running', message: 'Buscando/gerando visuais', step: currentStep, video_title: videoTitle, runner: 'github-actions' });
    const scenes = await stepVisuals(script, data, isResume ? resumeVideo?.visualScenes : undefined);
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
      // Falha exclusivamente por cota do Gemini NÃO gasta tentativa — o vídeo é
      // reagendado para quando a cota virar. Teto de segurança: no máximo
      // MAX_QUOTA_SKIPS reagendamentos ou QUOTA_SKIP_WINDOW_MS desde o 1º 429;
      // depois disso volta ao fluxo normal de falha (cota insuficiente de fato).
      const prevSkips = resumeVideo?.quotaSkips || 0;
      const firstQuotaAt = resumeVideo?.firstQuotaAt || new Date().toISOString();
      const withinWindow = Date.now() - new Date(firstQuotaAt).getTime() < QUOTA_SKIP_WINDOW_MS;
      const isQuotaStall = !!err.isQuotaExhausted && prevSkips < MAX_QUOTA_SKIPS && withinWindow;

      if (isQuotaStall) {
        const waitMs = Math.min(Math.max(err.waitMs || 65_000, 60_000), 6 * 60 * 60 * 1000);
        const nextRetryAt = new Date(Date.now() + waitMs).toISOString();
        await updateRunnerVideo(projectId, data, videoId, {
          status: 'STANDBY',
          standbyInfo,
          retryCount: resumeVideo?.retryCount || 0, // tentativa preservada
          quotaSkips: prevSkips + 1,
          firstQuotaAt,
          nextRetryAt,
          lastError: `Cota Gemini esgotada — retomando às ${new Date(nextRetryAt).toLocaleString('pt-BR')}`,
        }, 'Quota standby saved');

        await safeInsertAutopilotLog({
          project_id: projectId,
          status: 'retrying',
          message: `Cota do Gemini esgotada em "${currentStep}" (${err.reason || 'cota'}). Retomando às ${new Date(nextRetryAt).toLocaleString('pt-BR')} sem gastar tentativa (${prevSkips + 1}/${MAX_QUOTA_SKIPS}).`,
          step: currentStep,
          video_title: videoTitle,
          elapsed_ms: duration * 1000,
          runner: 'github-actions',
        });

        log('🧊', `Cota esgotada — retomada agendada para ${nextRetryAt} (skip ${prevSkips + 1}/${MAX_QUOTA_SKIPS})`);
        return false;
      }

      // Auto-retry with backoff instead of waiting for a human click.
      const previousRetries = (resumeVideo?.retryCount || 0);
      const retryCount = previousRetries + 1;
      const exhausted = retryCount >= MAX_AUTO_RETRIES;
      const nextRetryAt = exhausted ? null : new Date(Date.now() + retryBackoffMs(previousRetries)).toISOString();
      const quotaCapped = !!err.isQuotaExhausted;

      await updateRunnerVideo(projectId, data, videoId, {
        status: 'STANDBY',
        standbyInfo,
        retryCount,
        nextRetryAt: nextRetryAt || undefined,
        quotaSkips: prevSkips,
        firstQuotaAt: resumeVideo?.firstQuotaAt,
        lastError: quotaCapped
          ? `Cota do Gemini insuficiente há mais de ${Math.round(QUOTA_SKIP_WINDOW_MS / 3600000)}h — aumente o limite ou adicione outra chave. ${err.message}`
          : err.message,
      }, 'Standby video saved');

      await safeInsertAutopilotLog({
        project_id: projectId,
        status: exhausted ? 'error' : 'retrying',
        message: quotaCapped
          ? `Cota do Gemini insuficiente de forma persistente (${prevSkips} reagendamentos em até ${Math.round(QUOTA_SKIP_WINDOW_MS / 3600000)}h). Adicione outra chave em Configurações ou aumente o limite no Google AI Studio.`
          : exhausted
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
    // Pedido explícito já foi atendido nesta execução — a marca não deve
    // sobreviver e forçar uma nova rodada imediata no próximo cron.
    if (data.scheduleSettings?.forceRun) {
      delete data.scheduleSettings.forceRun;
      await persistProjectData(projectId, data, 'forceRun consumido');
    }
    if (data.scheduleSettings?.autoGenerate && !data.scheduleSettings.nextScheduledRun) {
      data.scheduleSettings.nextScheduledRun = calculateNextRunIso(data.scheduleSettings);
      await persistProjectData(projectId, data, 'Next run saved');
    }
    // Always release the lock — even on crash — so the project isn't
    // permanently blocked from future runs.
    stopLockRenewal();
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
    log('🎯', `Execução forçada para o projeto: ${PROJECT_ID} (ignora autoGenerate e nextRun)`);
    query = query.eq('id', PROJECT_ID);
  } else {
    log('🗓️', 'Nenhum project_id informado — rodando apenas projetos com Auto-Pilot ligado e agendamento vencido. Para forçar um projeto, informe project_id no workflow_dispatch.');
  }

  const { data: projects, error } = await query;

  if (error) {
    log('❌', `Failed to fetch projects: ${error.message}`);
    await writeHeartbeat(`erro ao buscar projetos: ${error.message}`);
    process.exit(1);
  }

  if (!projects?.length) {
    // "encontrados=0" ≠ "elegíveis=0": aqui a QUERY não achou nada.
    log('📭', PROJECT_ID
      ? `Nenhum projeto com id="${PROJECT_ID}" (0 encontrados). Confira o id exato em projects.id — não é problema de agendamento.`
      : 'Nenhum projeto na tabela projects (0 encontrados).');
    await writeHeartbeat(PROJECT_ID ? `id não encontrado: ${PROJECT_ID}` : 'nenhum projeto encontrado');
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

  log('📋', `${projects.length} projeto(s) encontrados (query OK), ${eligible.length} elegível(is) (após filtro de agendamento)`);
  if (projects.length > 0 && eligible.length === 0) {
    log('ℹ️', 'Encontrou projeto(s) mas nenhum elegível: é agendamento/Auto-Pilot, não a query. Rode o workflow com project_id para forçar.');
  }


  let successCount = 0;
  let errorCount = 0;

  for (const project of eligible) {
    const ok = await processProject(project);
    if (ok) successCount++;
    else errorCount++;
  }

  await writeHeartbeat(`ciclo concluído: ${successCount} ok, ${errorCount} falha(s), ${eligible.length} elegível(is)`);
  log('📊', `Chamadas ao Gemini nesta execução: ${geminiRequestCount}`);
  log('🏁', `=== Done! ✅ ${successCount} success, ❌ ${errorCount} errors ===`);
}

main().catch(async (err) => {
  log('💀', `Fatal error: ${err.message}`);
  await writeHeartbeat(`erro fatal: ${err.message}`);
  process.exit(1);
});
