/**
 * Automation Pipeline Service
 * Modular, step-by-step video creation with STANDBY on failure.
 */

import { Project, Video, ProjectStatus, VisualScene, VisualEffect, AutoPilotStep, StandbyInfo } from '../types';
import {
  generateVideoIdeas,
  generateVideoScript,
  generateVideoMetadata,
  generateVoiceover,
  generateSceneImage,
  generateDarkAmbience,
  generateThumbnail,
  decodeAudioData,
  mergeAudioBuffers,
  audioBufferToBase64,
  VideoIdea as GeminiVideoIdea
} from './geminiService';
import { searchContextualMedia } from './pexelsService';
import { renderVideoHeadless } from './renderService';
import { uploadVideoToYouTube } from './youtubeService';

const ANIMATION_EFFECTS: VisualEffect[] = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'zoom-in-fast'];

export interface PipelineCallbacks {
  onStepStart: (step: AutoPilotStep, message: string) => void;
  onStepComplete: (step: AutoPilotStep) => void;
  onProgress: (step: AutoPilotStep, detail: string) => void;
  addVideo: (projectId: string, topic: string, duration: any, format: any, context?: string) => Video;
  updateVideo: (projectId: string, videoId: string, updates: Partial<Video>) => void;
  updateIdeaStatus: (projectId: string, ideaId: string, status: 'used' | 'dismissed' | 'new') => void;
  getLatestProject: (projectId: string) => Project | undefined;
}

export interface PipelineResult {
  success: boolean;
  videoId?: string;
  videoTitle?: string;
  failedStep?: AutoPilotStep;
  errorMessage?: string;
}

// --- INDIVIDUAL PIPELINE STEPS ---

export async function stepGenerateIdea(
  project: Project,
  callbacks: PipelineCallbacks
): Promise<{ topic: string; context: string; specificContext?: string; ideaId?: string }> {
  callbacks.onStepStart('idea', 'Buscando ideia no AI Brainstorm...');

  // Check for existing unused ideas first
  const unusedIdea = project.ideas?.find(i => i.status === 'new');
  if (unusedIdea) {
    // Mark as used immediately (Rule 5)
    callbacks.updateIdeaStatus(project.id, unusedIdea.id, 'used');
    callbacks.onStepComplete('idea');
    return { topic: unusedIdea.topic, context: unusedIdea.context, specificContext: unusedIdea.specificContext, ideaId: unusedIdea.id };
  }

  // Generate new ideas
  callbacks.onProgress('idea', 'Nenhuma ideia disponível, gerando novas...');
  const excludeList = project.videos.map(v => v.title);
  const libraryContext = project.library?.map(item => `[${item.type?.toUpperCase() || 'INFO'}] ${item.title}: ${item.content}`).join('\n') || '';
  const ideas = await generateVideoIdeas(project.channelTheme, project.description || '', project.defaultTone, project.language, excludeList, libraryContext);
  
  if (!ideas || ideas.length === 0) throw new Error('Nenhuma ideia gerada pela IA');
  
  const best = ideas[0];
  callbacks.onStepComplete('idea');
  return { topic: best.topic, context: best.context, specificContext: best.specificContext };
}

export async function stepGenerateScript(
  project: Project,
  video: Video,
  callbacks: PipelineCallbacks
) {
  callbacks.onStepStart('script', 'Escrevendo roteiro...');
  const libraryContext = project.library?.map(item => `[${item.type?.toUpperCase() || 'INFO'}] ${item.title}: ${item.content}`).join('\n') || '';
  
  const script = await generateVideoScript({
    topic: video.title,
    channelTheme: project.channelTheme,
    targetDuration: video.targetDuration,
    tone: project.defaultTone || 'Suspenseful',
    additionalContext: video.specificContext,
    language: project.language,
    libraryContext,
    visualPacing: project.visualPacing
  });
  
  callbacks.updateVideo(project.id, video.id, { script, status: ProjectStatus.SCRIPTING });
  callbacks.onStepComplete('script');
  return script;
}

export async function stepGenerateVoice(
  project: Project,
  video: Video,
  script: any,
  callbacks: PipelineCallbacks
) {
  callbacks.onStepStart('voice', 'Sintetizando narração...');
  const audioBuffers: AudioBuffer[] = [];
  const timestamps = [0];
  let totalDur = 0;
  const ctx = new AudioContext({ sampleRate: 24000 });

  for (let i = 0; i < script.segments.length; i++) {
    callbacks.onProgress('voice', `Segmento ${i + 1}/${script.segments.length}`);
    const seg = script.segments[i];
    const ab = await decodeAudioData(await generateVoiceover(seg.narratorText, project.defaultVoice), ctx);
    audioBuffers.push(ab);
    totalDur += ab.duration;
    if (i < script.segments.length - 1) timestamps.push(totalDur);
  }

  const finalAudio = mergeAudioBuffers(audioBuffers, ctx);
  const audioUrl = audioBufferToBase64(finalAudio);

  callbacks.updateVideo(project.id, video.id, { audioUrl, segmentTimestamps: timestamps, status: ProjectStatus.AUDIO_GENERATED });
  callbacks.onStepComplete('voice');
  return { audioUrl, timestamps, totalDuration: totalDur };
}

export async function stepGenerateVisuals(
  project: Project,
  video: Video,
  script: any,
  timestamps: number[],
  totalDuration: number,
  callbacks: PipelineCallbacks
) {
  callbacks.onStepStart('visuals', 'Buscando imagens e vídeos...');
  const scenes: VisualScene[] = [];
  const pexelsUsedIds = new Set<number>();

  for (let i = 0; i < script.segments.length; i++) {
    const start = timestamps[i];
    const next = timestamps[i + 1] || totalDuration;
    const totalSegmentDur = next - start;
    const seg = script.segments[i];
    const prompts = seg.visualDescriptions || [];

    const weights = prompts.map(() => 0.5 + Math.random());
    const totalWeight = weights.reduce((a: number, b: number) => a + b, 0);
    const sceneDurations = weights.map((w: number) => (w / totalWeight) * totalSegmentDur);

    let currentSceneStart = start;

    for (let j = 0; j < prompts.length; j++) {
      callbacks.onProgress('visuals', `Segmento ${i + 1}, cena ${j + 1}/${prompts.length}`);
      const prompt = prompts[j];
      const dur = sceneDurations[j];

      if (i > 0 || j > 0) await new Promise(r => setTimeout(r, 6000));

      let imgUrl = '';
      let videoUrl = undefined;
      const pexelsChance = (project.visualSourceMix?.pexelsPercentage || 50) / 100;

      if (Math.random() < pexelsChance) {
        try {
          const result = await searchContextualMedia(
            seg.narratorText || prompt,
            seg.sectionTitle || `Section ${i}`,
            project.defaultTone || 'Cinematic',
            project.channelTheme || '',
            pexelsUsedIds,
            video.format || project.defaultFormat
          );
          if (result) {
            videoUrl = result.videoUrl;
            imgUrl = result.thumbnailUrl;
          }
        } catch (e) {
          console.warn('Pexels failed, falling back to Gemini', e);
        }
      }

      if (!imgUrl) {
        imgUrl = await generateSceneImage(prompt, project.defaultTone, video.format);
      }

      scenes.push({
        segmentIndex: i, imageUrl: imgUrl, videoUrl, prompt,
        effect: ANIMATION_EFFECTS[(i + j) % ANIMATION_EFFECTS.length],
        startTime: currentSceneStart,
        duration: dur
      });
      currentSceneStart += dur;
    }
  }

  callbacks.updateVideo(project.id, video.id, { visualScenes: scenes, status: ProjectStatus.VIDEO_GENERATED });
  callbacks.onStepComplete('visuals');
  return scenes;
}

export async function stepGenerateStudio(
  project: Project,
  video: Video,
  script: any,
  callbacks: PipelineCallbacks
) {
  callbacks.onStepStart('studio', 'Gerando música de fundo...');
  const musicUrl = await generateDarkAmbience(project.defaultTone || 'Dark');
  callbacks.updateVideo(project.id, video.id, { backgroundMusicUrl: musicUrl });
  callbacks.onStepComplete('studio');
  return musicUrl;
}

export async function stepGenerateThumbnail(
  project: Project,
  video: Video,
  script: any,
  callbacks: PipelineCallbacks
) {
  callbacks.onStepStart('thumbnail', 'Gerando thumbnail com clickbait...');
  const scriptSummary = script.segments.slice(0, 3).map((s: any) => s.narratorText).join(' ').slice(0, 500);
  const thumbnailUrl = await generateThumbnail(video.title, project.defaultTone, scriptSummary, script, project.channelTheme, project.library);
  callbacks.updateVideo(project.id, video.id, { thumbnailUrl });
  callbacks.onStepComplete('thumbnail');
  return thumbnailUrl;
}

export async function stepGenerateMetadata(
  project: Project,
  video: Video,
  script: any,
  callbacks: PipelineCallbacks
) {
  callbacks.onStepStart('metadata', 'Otimizando SEO e descrição...');
  const metadata = await generateVideoMetadata(
    video.title,
    script.segments.map((s: any) => s.narratorText).join(' '),
    project.defaultTone,
    project.language,
    script.segments,
    script,
    project.channelTheme
  );
  callbacks.updateVideo(project.id, video.id, { videoMetadata: metadata });
  callbacks.onStepComplete('metadata');
  return metadata;
}

export async function stepUploadToYouTube(
  project: Project,
  video: Video,
  metadata: any,
  thumbnailUrl: string | undefined,
  callbacks: PipelineCallbacks
) {
  callbacks.onStepStart('upload', 'Renderizando e enviando para YouTube...');

  // Get latest video data for rendering
  const latestProject = callbacks.getLatestProject(project.id);
  const latestVideo = latestProject?.videos.find(v => v.id === video.id);
  if (!latestVideo) throw new Error('Vídeo não encontrado para renderização');

  callbacks.onProgress('upload', 'Renderizando vídeo...');
  const blob = await renderVideoHeadless(latestVideo, (pct, status) => {
    callbacks.onProgress('upload', status);
  });

  const file = new File([blob], 'video.webm', { type: 'video/webm' });

  callbacks.onProgress('upload', 'Enviando para YouTube...');
  const ytbId = await uploadVideoToYouTube(project.youtubeAccessToken!, file, metadata, thumbnailUrl);

  callbacks.updateVideo(project.id, video.id, {
    status: ProjectStatus.PUBLISHED,
    youtubeUrl: `https://youtu.be/${ytbId}`
  });
  callbacks.onStepComplete('upload');
  return ytbId;
}

// --- FULL PIPELINE ORCHESTRATOR ---

export async function runAutomationPipeline(
  project: Project,
  callbacks: PipelineCallbacks
): Promise<PipelineResult> {
  const steps: { name: AutoPilotStep; fn: () => Promise<void> }[] = [];
  
  let idea: any;
  let video: Video;
  let script: any;
  let voiceResult: any;
  let scenes: any;
  let musicUrl: string;
  let thumbnailUrl: string | undefined;
  let metadata: any;

  // Step 1: Idea
  try {
    idea = await stepGenerateIdea(project, callbacks);
  } catch (e: any) {
    return { success: false, failedStep: 'idea', errorMessage: e.message };
  }

  // Step 2: Create video + Script
  try {
    video = callbacks.addVideo(
      project.id,
      idea.topic,
      project.defaultDuration || 'Standard (5-8 min)',
      project.defaultFormat || 'Landscape 16:9',
      idea.specificContext || idea.context
    );
    script = await stepGenerateScript(project, video, callbacks);
  } catch (e: any) {
    return { success: false, videoId: video!?.id, videoTitle: idea.topic, failedStep: 'script', errorMessage: e.message };
  }

  // Step 3: Voice
  try {
    voiceResult = await stepGenerateVoice(project, video!, script, callbacks);
  } catch (e: any) {
    markStandby(project.id, video!.id, 'voice', e.message, callbacks);
    return { success: false, videoId: video!.id, videoTitle: video!.title, failedStep: 'voice', errorMessage: e.message };
  }

  // Step 4: Visuals
  try {
    scenes = await stepGenerateVisuals(project, video!, script, voiceResult.timestamps, voiceResult.totalDuration, callbacks);
  } catch (e: any) {
    markStandby(project.id, video!.id, 'visuals', e.message, callbacks);
    return { success: false, videoId: video!.id, videoTitle: video!.title, failedStep: 'visuals', errorMessage: e.message };
  }

  // Step 5: Studio (music)
  try {
    musicUrl = await stepGenerateStudio(project, video!, script, callbacks);
  } catch (e: any) {
    markStandby(project.id, video!.id, 'studio', e.message, callbacks);
    return { success: false, videoId: video!.id, videoTitle: video!.title, failedStep: 'studio', errorMessage: e.message };
  }

  // Step 6: Thumbnail
  try {
    thumbnailUrl = await stepGenerateThumbnail(project, video!, script, callbacks);
  } catch (e: any) {
    // Thumbnail failure is non-blocking, continue
    console.warn('Thumbnail generation failed, continuing without:', e.message);
    thumbnailUrl = undefined;
  }

  // Step 7: Metadata
  try {
    metadata = await stepGenerateMetadata(project, video!, script, callbacks);
  } catch (e: any) {
    markStandby(project.id, video!.id, 'metadata', e.message, callbacks);
    return { success: false, videoId: video!.id, videoTitle: video!.title, failedStep: 'metadata', errorMessage: e.message };
  }

  // Step 8: Upload
  try {
    await stepUploadToYouTube(project, video!, metadata, thumbnailUrl, callbacks);
  } catch (e: any) {
    markStandby(project.id, video!.id, 'upload', e.message, callbacks);
    return { success: false, videoId: video!.id, videoTitle: video!.title, failedStep: 'upload', errorMessage: e.message };
  }

  return { success: true, videoId: video!.id, videoTitle: video!.title };
}

function markStandby(projectId: string, videoId: string, step: AutoPilotStep, error: string, callbacks: PipelineCallbacks) {
  const standbyInfo: StandbyInfo = {
    failedStep: step,
    errorMessage: error,
    failedAt: new Date().toISOString()
  };
  callbacks.updateVideo(projectId, videoId, {
    status: ProjectStatus.STANDBY,
    standbyInfo
  });
}

// --- SCHEDULER UTILITIES ---

export function calculateNextRunTime(settings: { frequencyDays: number; timeWindowStart: string; timeWindowEnd: string }, lastVideoDate?: string): Date {
  const now = new Date();
  const [startH, startM] = settings.timeWindowStart.split(':').map(Number);
  const [endH, endM] = settings.timeWindowEnd.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  // Random time within window
  const randomMinutes = startMinutes + Math.floor(Math.random() * (endMinutes - startMinutes));
  const randomH = Math.floor(randomMinutes / 60);
  const randomM = randomMinutes % 60;

  let nextDate: Date;
  
  if (lastVideoDate) {
    const last = new Date(lastVideoDate);
    nextDate = new Date(last);
    nextDate.setDate(nextDate.getDate() + settings.frequencyDays);
  } else {
    nextDate = new Date(now);
  }

  nextDate.setHours(randomH, randomM, 0, 0);

  // If the calculated time is in the past, move to next eligible day
  if (nextDate <= now) {
    nextDate.setDate(now.getDate() + 1);
    // Re-randomize time for next day
    const newRandom = startMinutes + Math.floor(Math.random() * (endMinutes - startMinutes));
    nextDate.setHours(Math.floor(newRandom / 60), newRandom % 60, 0, 0);
  }

  return nextDate;
}

export const STEP_LABELS: Record<AutoPilotStep, string> = {
  idea: '💡 Brainstorm',
  script: '📝 Script',
  voice: '🎙️ Narração',
  visuals: '🎨 Visuais',
  studio: '🎵 Música',
  thumbnail: '🖼️ Thumbnail',
  metadata: '📊 SEO/Metadata',
  upload: '📤 Upload YouTube'
};
