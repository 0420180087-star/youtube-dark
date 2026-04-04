/**
 * 🤖 Automation Runner — GitHub Actions Pipeline
 * Executes the full video creation + YouTube upload pipeline.
 * Runs as a standalone Node.js script via GitHub Actions cron.
 */

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import path from 'path';
import os from 'os';
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

async function geminiGenerateJSON(prompt, maxTokens = 4096) {
  const raw = await geminiGenerate(prompt, maxTokens);
  // Extract JSON from markdown code blocks if present
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = match ? match[1].trim() : raw.trim();
  return JSON.parse(jsonStr);
}

async function geminiGenerateImage(prompt) {
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{ parts: [{ text: `Generate an image: ${prompt}` }] }],
      generationConfig: { maxOutputTokens: 1024 },
    }
  );
  // Return the text description as placeholder — actual image gen requires Imagen API
  return res.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
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
  const prompt = `Write a YouTube video script about "${topic}" for a ${projectData.defaultTone || 'Engaging'} channel about "${projectData.channelTheme}".
Target duration: ${projectData.defaultDuration || '5-8 minutes'}.
Language: ${projectData.language || 'en'}.

Return JSON with this structure:
{
  "title": "video title",
  "description": "brief summary",
  "segments": [
    {
      "sectionTitle": "Introduction",
      "narratorText": "full narration text for this section",
      "visualDescriptions": ["visual prompt 1", "visual prompt 2"]
    }
  ]
}

Create 4-6 segments. Each segment should have 2-3 visual descriptions.`;

  const script = await geminiGenerateJSON(prompt, 8192);
  log('✅', `Script generated: ${script.segments?.length || 0} segments`);
  return script;
}

async function stepVisuals(script, projectData) {
  log('🎨', 'Step 3: Searching visuals...');
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
  log('🖼️', 'Step 4: Generating thumbnail prompt...');

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

  const result = await geminiGenerateJSON(prompt);

  const fullPrompt = `YouTube thumbnail, ${toneStyle} style, text overlay "${result.clickbaitText}", ${result.imagePrompt}, high contrast, bold colors, professional design, 16:9 aspect ratio, no watermark`;

  log('✅', `Thumbnail: "${result.clickbaitText}"`);
  return { clickbaitText: result.clickbaitText, imagePrompt: fullPrompt };
}

async function stepMetadata(title, script, projectData) {
  log('📊', 'Step 5: Generating SEO metadata...');

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

  const metadata = await geminiGenerateJSON(prompt);
  log('✅', `Metadata: "${metadata.title}"`);
  return metadata;
}

async function stepRenderVideo(scenes, script, projectData) {
  log('🎬', 'Step 6: Rendering video with FFmpeg...');

  const tmpDir = path.join(os.tmpdir(), `autopost_${Date.now()}`);

  const visuals = scenes.map((s) => ({
    url: s.videoUrl || s.imageUrl,
    effect: s.effect || 'zoom-in',
  }));

  const videoPath = await renderVideo({
    visuals,
    segments: script.segments || [],
    audioBase64: projectData._audioBase64 || null,
    musicUrl: projectData.backgroundMusicUrl || null,
    thumbnailBase64: projectData._thumbnailBase64 || null,
    tmpDir,
  });

  log('✅', `Video rendered: ${videoPath}`);
  return { videoPath, tmpDir };
}

async function stepUploadYouTube(projectData, metadata, renderResult) {
  log('📤', 'Step 7: Uploading to YouTube...');

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

    // Upload thumbnail separately
    if (projectData._thumbnailBase64) {
      await uploadThumbnail(accessToken, videoId, projectData._thumbnailBase64);
    }

    return { uploaded: true, videoUrl };
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

    // Step 3: Visuals
    currentStep = 'visuals';
    const scenes = await stepVisuals(script, data);

    // Step 4: Thumbnail
    currentStep = 'thumbnail';
    const thumbnail = await stepThumbnail(idea.topic, script, data);

    // Step 5: Metadata
    currentStep = 'metadata';
    const metadata = await stepMetadata(idea.topic, script, data);

    // Step 6: Render Video
    currentStep = 'render';
    const renderResult = await stepRenderVideo(scenes, script, data);

    // Step 7: Upload
    currentStep = 'upload';
    const uploadResult = await stepUploadYouTube(data, metadata, renderResult);

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

    data.nextScheduledRun = nextRun.toISOString();

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
    const nextRun = d.nextScheduledRun ? new Date(d.nextScheduledRun) : new Date(0);
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
