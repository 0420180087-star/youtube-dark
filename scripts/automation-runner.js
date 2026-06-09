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
  GEMINI_API_KEY: ENV_GEMINI_API_KEY,
  PEXELS_API_KEY: ENV_PEXELS_API_KEY,
  YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET,
  PROJECT_ID,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing required environment variables (SUPABASE_URL, SUPABASE_SERVICE_KEY)');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Per-run mutable keys — populated from user_settings before each project runs.
// Falls back to ENV if no per-user key is configured.
let GEMINI_API_KEY = ENV_GEMINI_API_KEY || '';
let GEMINI_API_KEYS = ENV_GEMINI_API_KEY ? [ENV_GEMINI_API_KEY] : [];
let GEMINI_KEY_INDEX = 0;
let PEXELS_API_KEY = ENV_PEXELS_API_KEY || '';

function rotateGeminiKey() {
  if (GEMINI_API_KEYS.length <= 1) return;
  GEMINI_KEY_INDEX = (GEMINI_KEY_INDEX + 1) % GEMINI_API_KEYS.length;
  GEMINI_API_KEY = GEMINI_API_KEYS[GEMINI_KEY_INDEX];
  log('🔁', `Rotated to Gemini key #${GEMINI_KEY_INDEX + 1}/${GEMINI_API_KEYS.length}`);
}

async function loadUserKeys(userEmail) {
  if (!userEmail) return;
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
    } else if (ENV_GEMINI_API_KEY) {
      GEMINI_API_KEYS = [ENV_GEMINI_API_KEY];
      GEMINI_API_KEY = ENV_GEMINI_API_KEY;
    }
    if (data?.pexels_api_key) {
      PEXELS_API_KEY = data.pexels_api_key;
      log('🔑', `Loaded Pexels key for ${userEmail}`);
    } else if (ENV_PEXELS_API_KEY) {
      PEXELS_API_KEY = ENV_PEXELS_API_KEY;
    }
  } catch (e) {
    log('⚠️', `Failed to load user_settings for ${userEmail}: ${e.message}`);
  }
}

// --- HELPERS ---

function log(emoji, msg) {
  console.log(`${emoji} [${new Date().toISOString()}] ${msg}`);
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
  const jsonStr = match ? match[1].trim() : raw.trim();
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

  log('🔄', 'No unused ideas, generating new one...');
  const prompt = `You are a YouTube content strategist. Generate 1 unique video idea for a channel about "${projectData.channelTheme}".
Tone: ${projectData.defaultTone || 'Engaging'}.
Language: ${projectData.language || 'en'}.

Return JSON: { "topic": "video title", "context": "brief description", "specificContext": "detailed angle" }`;

  let idea;
  try {
    idea = await geminiGenerateJSON(prompt);
    if (!idea || !idea.topic) throw new Error('AI returned no topic');
  } catch (e) {
    // Fallback: never block autopilot just because brainstorm failed
    log('⚠️', `Brainstorm fallback (IA falhou: ${e.message}). Gerando ideia automática.`);
    const seeds = ['The Untold Story of', 'The Hidden Truth Behind', 'What Nobody Tells You About', 'Why Everyone is Wrong About'];
    const seed = seeds[Math.floor(Math.random() * seeds.length)];
    idea = {
      topic: `${seed} ${projectData.channelTheme}`,
      context: `An engaging deep-dive about ${projectData.channelTheme}.`,
      specificContext: `Explore ${projectData.channelTheme} from a fresh, click-worthy angle. ${projectData.description || ''}`.trim(),
    };
  }

  log('✅', `Generated idea: "${idea.topic}"`);
  return { topic: idea.topic, context: idea.context, specificContext: idea.specificContext, updatedIdeas: ideas };
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

    if (i === 0) {
      // Guarda o mimeType do primeiro chunk para passar ao renderer
      audioChunks._mimeType = mimeType;
    }

    audioChunks.push(Buffer.from(audioData, 'base64'));

    // Small delay between segments to avoid rate limits
    if (i < segments.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  if (audioChunks.length === 0) throw new Error('No audio generated for any segment');

  // Concatenate all audio buffers into one
  const combined = Buffer.concat(audioChunks);
  const combinedBase64 = combined.toString('base64');
  const mimeType = audioChunks._mimeType || 'audio/pcm';

  log('✅', `Voice generated: ${audioChunks.length} segments, ${(combined.length / 1024 / 1024).toFixed(1)}MB total, mimeType=${mimeType}`);
  return { audioBase64: combinedBase64, mimeType };
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

  // ── Resolve refresh_token + cached access_token from project_auth ──
  // Priority:
  //  1. project-specific row (project_id + user_email)
  //  2. project-specific row (project_id only)
  //  3. most-recent row for this user_email (any project)
  const projectId = projectData.id || projectData.projectId || '';
  let authRow = null;

  if (projectId && userEmail) {
    const r = await supabase
      .from('project_auth')
      .select('youtube_refresh_token, youtube_access_token, token_expires_at, project_id, user_email')
      .eq('project_id', projectId)
      .eq('user_email', userEmail)
      .maybeSingle();
    authRow = r.data;
  }
  if (!authRow?.youtube_refresh_token && projectId) {
    const r = await supabase
      .from('project_auth')
      .select('youtube_refresh_token, youtube_access_token, token_expires_at, project_id, user_email')
      .eq('project_id', projectId)
      .not('youtube_refresh_token', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    authRow = r.data;
  }
  if (!authRow?.youtube_refresh_token && userEmail) {
    const r = await supabase
      .from('project_auth')
      .select('youtube_refresh_token, youtube_access_token, token_expires_at, project_id, user_email')
      .eq('user_email', userEmail)
      .not('youtube_refresh_token', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    authRow = r.data;
  }

  const refreshToken = authRow?.youtube_refresh_token || projectData.youtubeRefreshToken;
  if (!refreshToken) {
    throw new Error('No YouTube refresh token found. Open the app, go to Project Settings and reconnect YouTube to authorize offline access.');
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

async function processProject(projectRow) {
  const projectId = projectRow.id;
  const data = projectRow.data;
  const startTime = Date.now();

  // Acquire distributed lock — prevents browser scheduler from running
  // the same project at the same time as this GitHub Actions runner.
  const { data: lockAcquired, error: lockError } = await supabase
    .rpc('acquire_autopilot_lock', {
      p_project_id: String(projectId),
      p_locked_by: 'github-actions',
      p_lock_minutes: 90,
    });

  if (lockError) {
    log('❌', `Lock RPC error: ${lockError.message} — verifique se a migration 005 foi aplicada no Supabase`);
    return false;
  }
  if (!lockAcquired) {
    log('⏭️', `Lock não adquirido para "${data.channelTheme}" — já rodando em outro lugar`);
    return false;
  }

  log('🚀', `Processing project: "${data.channelTheme}" (${projectId})`);

  // Load per-user API keys (Gemini/Pexels) — owner of this project
  await loadUserKeys(projectRow.user_email);
  if (!GEMINI_API_KEY) {
    log('❌', `No Gemini key configured for user ${projectRow.user_email}. Skipping.`);
    try { await supabase.rpc('release_autopilot_lock', { p_project_id: projectId }); } catch {}
    return false;
  }

  // Ensure projectId is accessible inside data for token lookup
  data.id = projectId;

  let currentStep = 'idea';
  try {
    // Step 1: Idea
    currentStep = 'idea';
    const idea = await stepIdea(data);

    // Update ideas in Supabase
    if (idea.updatedIdeas) {
      data.ideas = idea.updatedIdeas;
    }

    // Step 2: Script
    currentStep = 'script';
    const script = await stepScript(idea.topic, data);

    // Step 3: Voice/Narration
    currentStep = 'voice';
    const voiceResult = await stepVoice(script, data);
    const audioBase64 = voiceResult.audioBase64;
    const audioMimeType = voiceResult.mimeType;

    // Step 4: Visuals
    currentStep = 'visuals';
    const scenes = await stepVisuals(script, data);

    // Step 5: Thumbnail (optional — does not break pipeline)
    currentStep = 'thumbnail';
    let thumbnailBase64 = null;
    try {
      const thumbResult = await stepThumbnail(idea.topic, script, data);
      thumbnailBase64 = thumbResult?.thumbnailBase64 || null;
      if (thumbnailBase64) log('🖼️', 'Thumbnail image generated');
      else log('⚠️', 'Thumbnail not generated, continuing without it');
    } catch {
      log('⚠️', 'Thumbnail failed, continuing without it');
    }

    // Step 6: Metadata
    currentStep = 'metadata';
    const metadata = await stepMetadata(idea.topic, script, data);

    // Step 7: Render Video (now receives audio!)
    currentStep = 'render';
    const renderResult = await stepRenderVideo(scenes, script, audioBase64, thumbnailBase64, data, audioMimeType);

    // Step 8: Upload
    currentStep = 'upload';
    const uploadResult = await stepUploadYouTube(data, metadata, renderResult, thumbnailBase64, projectRow.user_email);

    // Save video record into project data
    const newVideo = {
      id: `auto_${Date.now()}`,
      projectId,
      title: metadata.title || idea.topic,
      status: 'PUBLISHED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      youtubeUrl: uploadResult?.videoUrl || null,
    };

    if (!data.videos) data.videos = [];
    data.videos.push(newVideo);

    // Calculate next run
    const settings = data.scheduleSettings || {};
    const freqDays = settings.frequencyDays || 1;
    const startH = parseInt((settings.timeWindowStart || '09:00').split(':')[0]);
    const endH = parseInt((settings.timeWindowEnd || '21:00').split(':')[0]);
    const randomH = startH + Math.floor(Math.random() * (endH - startH));
    const randomM = Math.floor(Math.random() * 60);

    const nextRun = new Date();
    nextRun.setDate(nextRun.getDate() + freqDays);
    nextRun.setHours(randomH, randomM, 0, 0);

    if (!data.scheduleSettings) data.scheduleSettings = {};
    data.scheduleSettings.nextScheduledRun = nextRun.toISOString();

    // Save updated project data
    await supabase.from('projects').update({ data, updated_at: new Date().toISOString() }).eq('id', projectId);

    // Log success
    const duration = Math.round((Date.now() - startTime) / 1000);
    await supabase.from('autopilot_logs').insert({
      project_id: projectId,
      status: 'success',
      message: `Publicado: ${uploadResult?.videoUrl || 'sem URL'}`,
      step: 'upload',
      video_title: metadata.title || idea.topic,
      elapsed_ms: duration * 1000,
    });

    log('🎉', `Project complete! Duration: ${duration}s. Next run: ${nextRun.toISOString()}`);
    return true;
  } catch (err) {
    const duration = Math.round((Date.now() - startTime) / 1000);
    log('❌', `Failed at step "${currentStep}": ${err.message}`);

    // Save standby info
    data.standbyInfo = {
      failedStep: currentStep,
      errorMessage: err.message,
      failedAt: new Date().toISOString(),
    };
    await supabase.from('projects').update({ data, updated_at: new Date().toISOString() }).eq('id', projectId);

    // Log error
    await supabase.from('autopilot_logs').insert({
      project_id: projectId,
      status: 'error',
      message: err.message,
      step: currentStep,
      elapsed_ms: duration * 1000,
    });

    return false;
  } finally {
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
    if (!d?.scheduleSettings?.autoGenerate) {
      log('⏭️', `"${d?.channelTheme || p.id}" pulado: autoGenerate não está ativado`);
      return false;
    }
    if (PROJECT_ID) return true;
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
