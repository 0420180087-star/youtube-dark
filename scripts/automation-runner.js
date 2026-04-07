/**
 * 🤖 Automation Runner — GitHub Actions Pipeline
 * Fully autonomous: generates idea → script → voice → visuals → thumbnail → metadata → render → upload.
 * Runs as a standalone Node.js script via GitHub Actions cron — NO browser needed.
 */

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { renderVideo, cleanupTmp } from './videoRenderer.js';
import { refreshAccessToken, uploadVideoFile, uploadThumbnail } from './youtubeUploader.js';

// --- ENV ---
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  GEMINI_API_KEY,
  PEXELS_API_KEY,
  YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET,
  PROJECT_ID,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !GEMINI_API_KEY) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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
  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict?key=${GEMINI_API_KEY}`,
      {
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: '16:9' }
      }
    );
    return res.data.predictions?.[0]?.bytesBase64Encoded || null;
  } catch (err) {
    log('⚠️', `Image generation failed, skipping thumbnail: ${err.message}`);
    return null;
  }
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

  return audioPart.inlineData.data; // base64 audio
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

  const idea = await geminiGenerateJSON(prompt);
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

    const audioBase64 = await geminiWithRetry(() =>
      geminiTTS(text, projectData.defaultVoice || 'Fenrir', projectData.defaultTone || 'Cinematic')
    );

    audioChunks.push(Buffer.from(audioBase64, 'base64'));

    // Small delay between segments to avoid rate limits
    if (i < segments.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  if (audioChunks.length === 0) throw new Error('No audio generated for any segment');

  // Concatenate all audio buffers into one
  const combined = Buffer.concat(audioChunks);
  const combinedBase64 = combined.toString('base64');

  log('✅', `Voice generated: ${audioChunks.length} segments, ${(combined.length / 1024 / 1024).toFixed(1)}MB total`);
  return combinedBase64;
}

async function stepVisuals(script, projectData) {
  log('🎨', 'Step 4: Searching visuals...');
  const usedIds = new Set();
  const toneModifier = getToneModifier(projectData.defaultTone);
  const scenes = [];

  for (let i = 0; i < script.segments.length; i++) {
    const seg = script.segments[i];
    const prompts = seg.visualDescriptions || [];

    for (let j = 0; j < prompts.length; j++) {
      const query = `${prompts[j]} ${toneModifier}`.split(' ').slice(0, 4).join(' ');
      log('🔍', `  Searching: "${query}"`);

      let result = await searchPexels(query, usedIds);

      // Fallback: try without tone modifier
      if (!result) {
        const fallbackQuery = prompts[j].split(' ').slice(0, 3).join(' ');
        result = await searchPexels(fallbackQuery, usedIds);
      }

      // Fallback: niche-based
      if (!result) {
        result = await searchPexels(projectData.channelTheme || 'cinematic', usedIds);
      }

      scenes.push({
        segmentIndex: i,
        prompt: prompts[j],
        videoUrl: result?.videoUrl,
        imageUrl: result?.imageUrl || result?.thumbnailUrl,
      });

      // Rate limit
      if (i > 0 || j > 0) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  log('✅', `Found ${scenes.length} visual scenes`);
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

async function stepRenderVideo(scenes, script, audioBase64, thumbnailBase64, projectData) {
  log('🎬', 'Step 7: Rendering video with FFmpeg...');

  const tmpDir = path.join(os.tmpdir(), `autopost_${Date.now()}`);

  const visuals = scenes.map((s) => ({
    url: s.videoUrl || s.imageUrl,
    effect: s.effect || 'zoom-in',
  }));

  const videoPath = await renderVideo({
    visuals,
    segments: script.segments || [],
    audioBase64: audioBase64,
    musicUrl: null, // Music is handled via Pexels ambient or skipped on server
    thumbnailBase64: thumbnailBase64 || null,
    tmpDir,
  });

  log('✅', `Video rendered: ${videoPath}`);
  return { videoPath, tmpDir };
}

async function stepUploadYouTube(projectData, metadata, renderResult, thumbnailBase64) {
  log('📤', 'Step 8: Uploading to YouTube...');

  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET) {
    throw new Error('YouTube credentials not configured');
  }

  const refreshToken = projectData.youtubeRefreshToken;
  if (!refreshToken) {
    throw new Error('No YouTube refresh token found in project. Connect YouTube in the app first.');
  }

  try {
    const accessToken = await refreshAccessToken(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, refreshToken);
    log('🔑', 'Access token refreshed');

    const { videoUrl, videoId } = await uploadVideoFile(accessToken, renderResult.videoPath, metadata);

    // Upload thumbnail separately if we have one
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

  log('🚀', `Processing project: "${data.channelTheme}" (${projectId})`);

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

    // Step 3: Voice/Narration (NEW — was missing!)
    currentStep = 'voice';
    const audioBase64 = await stepVoice(script, data);

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
    const renderResult = await stepRenderVideo(scenes, script, audioBase64, thumbnailBase64, data);

    // Step 8: Upload
    currentStep = 'upload';
    const uploadResult = await stepUploadYouTube(data, metadata, renderResult, thumbnailBase64);

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
      video_title: metadata.title || idea.topic,
      video_url: uploadResult?.videoUrl || null,
      duration_seconds: duration,
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
      failed_step: currentStep,
      error_message: err.message,
      duration_seconds: duration,
    });

    return false;
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
  const eligible = projects.filter((p) => {
    const d = p.data;
    if (!d?.scheduleSettings?.autoGenerate) return false;

    // If specific project requested, skip schedule check
    if (PROJECT_ID) return true;

    // Check if it's time to run
    const nextRun = d.scheduleSettings?.nextScheduledRun
      ? new Date(d.scheduleSettings.nextScheduledRun)
      : new Date(0);
    return nextRun <= now;
  });

  log('📋', `Found ${projects.length} projects, ${eligible.length} eligible for processing`);

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
