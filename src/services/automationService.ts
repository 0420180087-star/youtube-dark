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
import { buildSlotVisualPrompt, createFallbackVisualDataUrl, getSegmentVisualPrompts } from './visualSceneService';

const ANIMATION_EFFECTS: VisualEffect[] = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'zoom-in-fast'];

export interface PipelineCallbacks {
  onStepStart: (step: AutoPilotStep, message: string) => void;
  onStepComplete: (step: AutoPilotStep) => void;
  onProgress: (step: AutoPilotStep, detail: string) => void;
  addVideo: (projectId: string, topic: string, duration: any, format: any, context?: string) => Video;
  updateVideo: (projectId: string, videoId: string, updates: Partial<Video>) => void;
  updateIdeaStatus: (projectId: string, ideaId: string, status: 'used' | 'dismissed' | 'new') => void;
  getLatestProject: (projectId: string) => Project | undefined;
  // Persist freshly generated ideas immediately so concurrent runners don't repeat them.
  saveGeneratedIdeas?: (projectId: string, ideas: GeminiVideoIdea[]) => void;
  // Live token getter — read fresh on every use so long pipelines pick up refreshed tokens.
  // Falls back to legacy `youtubeAccessToken` field if provided.
  getYoutubeAccessToken?: () => string | null;
  refreshYoutubeAccessToken?: () => Promise<string | null>;
  youtubeAccessToken?: string;
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

  // Generate new ideas — retry with fresh angles, then synthesize a fallback so autopilot never stalls
  callbacks.onProgress('idea', 'Nenhuma ideia disponível, gerando novas...');
  const latestForIdeas = callbacks.getLatestProject(project.id) || project;
  const excludeList = latestForIdeas.videos.map(v => v.title);
  const libraryContext = project.library?.map(item => `[${item.type?.toUpperCase() || 'INFO'}] ${item.title}: ${item.content}`).join('\n') || '';

  const FRESH_ANGLES = ['untold history', 'modern mystery', 'shocking facts', 'hidden truth', 'expert insights', 'controversial take'];
  let ideas: GeminiVideoIdea[] = [];
  for (let attempt = 0; attempt < 3 && ideas.length === 0; attempt++) {
    try {
      const angle = attempt === 0 ? '' : FRESH_ANGLES[Math.floor(Math.random() * FRESH_ANGLES.length)];
      ideas = await generateVideoIdeas(project.channelTheme, project.description || '', project.defaultTone, project.language, excludeList, libraryContext, angle);
    } catch (e) {
      console.warn(`[autopilot] idea generation attempt ${attempt + 1} failed:`, e);
    }
    if (ideas.length === 0) callbacks.onProgress('idea', `Tentativa ${attempt + 1} sem ideias, retentando...`);
  }

  // Final fallback: never let autopilot stop just because brainstorm came back empty
  if (ideas.length === 0) {
    callbacks.onProgress('idea', 'IA não retornou ideias, criando fallback automático...');
    const seeds = ['The Untold Story of', 'What Nobody Tells You About', 'The Hidden Truth Behind', 'Why Everyone is Wrong About'];
    const seed = seeds[Math.floor(Math.random() * seeds.length)];
    ideas = [{
      topic: `${seed} ${project.channelTheme}`,
      context: `An exploration of ${project.channelTheme} from a fresh angle.`,
      specificContext: `Create an engaging deep-dive about ${project.channelTheme}. ${project.description || ''} Focus on a surprising, click-worthy perspective the audience hasn't seen before.`
    }];
  }

  // Persist ALL generated ideas immediately so a parallel runner won't regenerate them
  // and so the chosen one is marked 'used' atomically (prevents duplicate videos).
  callbacks.saveGeneratedIdeas?.(project.id, ideas);

  const best = ideas[0];

  // Try to mark the freshly-saved idea as used (best-effort, by topic match).
  try {
    const latest = callbacks.getLatestProject(project.id);
    const matched = latest?.ideas?.find(i => i.topic === best.topic && i.status === 'new');
    if (matched) callbacks.updateIdeaStatus(project.id, matched.id, 'used');
  } catch { /* non-fatal */ }

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

// Creates a silent AudioBuffer of given duration at 24000Hz
function createSilence(ctx: AudioContext, durationSeconds: number): AudioBuffer {
  const frameCount = Math.ceil(durationSeconds * 24000);
  const buf = ctx.createBuffer(1, Math.max(1, frameCount), 24000);
  // Buffer is already zeroed (silence) by default
  return buf;
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

  // Natural pause between segments (0.4s = realistic breath/transition)
  const SEGMENT_PAUSE = 0.4;

  try {
    for (let i = 0; i < script.segments.length; i++) {
      callbacks.onProgress('voice', `Gerando voz: segmento ${i + 1}/${script.segments.length}...`);
      const seg = script.segments[i];
      const tone = project.defaultTone || 'Cinematic';
      const primaryVoice = project.defaultVoice || 'Fenrir';
      const fallbackVoice = primaryVoice === 'Charon' ? 'Fenrir' : 'Charon';

      let ab: AudioBuffer | null = null;
      let lastErr: any = null;
      const attempts: Array<{ voice: string; label: string }> = [
        { voice: primaryVoice, label: 'principal' },
        { voice: primaryVoice, label: 'retry' },
        { voice: fallbackVoice, label: `fallback ${fallbackVoice}` },
      ];

      for (let t = 0; t < attempts.length; t++) {
        const { voice, label } = attempts[t];
        try {
          if (t > 0) {
            callbacks.onProgress('voice', `Segmento ${i + 1}: tentativa ${t + 1}/${attempts.length} (${label})...`);
            await new Promise(r => setTimeout(r, 700 * t + Math.random() * 400));
          }
          ab = await decodeAudioData(
            await generateVoiceover(seg.narratorText, voice, tone),
            ctx
          );
          break;
        } catch (err: any) {
          lastErr = err;
          // SAFETY / REFUSAL are terminal — do not waste retries
          const msg = String(err?.message || '');
          if (msg.includes('segurança') || msg.includes('Refusal')) break;
        }
      }

      if (!ab) {
        const preview = String(seg.narratorText || '').slice(0, 60).replace(/\s+/g, ' ');
        throw new Error(`Segmento ${i + 1}/${script.segments.length} falhou: ${lastErr?.message || 'desconhecido'} (texto: "${preview}...")`);
      }

      audioBuffers.push(ab);
      totalDur += ab.duration;

      if (i < script.segments.length - 1) {
        timestamps.push(totalDur);
        const silence = createSilence(ctx, SEGMENT_PAUSE);
        audioBuffers.push(silence);
        totalDur += SEGMENT_PAUSE;
      }
    }


    const finalAudio = mergeAudioBuffers(audioBuffers, ctx);
    const audioUrl = audioBufferToBase64(finalAudio);

    callbacks.updateVideo(project.id, video.id, { audioUrl, segmentTimestamps: timestamps, status: ProjectStatus.AUDIO_GENERATED });
    callbacks.onStepComplete('voice');
    return { audioUrl, timestamps, totalDuration: totalDur };
  } finally {
    // Always release AudioContext — prevents accumulation of Web Audio nodes
    // across pipeline runs, including on error paths.
    await ctx.close();
  }
}

interface VisualSlot {
  index: number;
  segmentIndex: number;
  prompt: string;
  narratorText: string;
  sectionTitle: string;
  startTime: number;
  duration: number;
  slotInSegment: number;
}

/** Caps so a long segment can't explode into dozens of AI calls. */
const MAX_SLOTS_PER_SEGMENT = 8;
const MAX_SLOTS_TOTAL = 60;
const SLOT_TIMEOUT_MS = 90_000;
const VISUALS_CONCURRENCY = 3;

export async function stepGenerateVisuals(
  project: Project,
  video: Video,
  script: any,
  timestamps: number[],
  totalDuration: number,
  callbacks: PipelineCallbacks
) {
  callbacks.onStepStart('visuals', 'Buscando imagens e vídeos...');
  const pexelsUsedIds = new Set<number>();

  // Max time any single image/video can stay on screen before being swapped.
  // Configurable per-project (defaults to 6s) — a target, not a hard rule.
  const MAX_MEDIA_DUR = Math.max(2, project.maxMediaDurationSeconds ?? 6);

  // ── 1. Build the full slot plan up front ────────────────────────────────
  const slots: VisualSlot[] = [];

  for (let i = 0; i < script.segments.length; i++) {
    const start = timestamps[i];
    const next = timestamps[i + 1] || totalDuration;
    const totalSegmentDur = Math.max(0.5, next - start);
    const seg = script.segments[i];
    const prompts: string[] = getSegmentVisualPrompts(seg);

    const desired = Math.max(prompts.length, Math.ceil(totalSegmentDur / MAX_MEDIA_DUR));
    const slotCount = Math.max(1, Math.min(desired, MAX_SLOTS_PER_SEGMENT));
    const slotDur = totalSegmentDur / slotCount;

    for (let j = 0; j < slotCount; j++) {
      if (slots.length >= MAX_SLOTS_TOTAL) break;
      const basePrompt = prompts[j % prompts.length];
      slots.push({
        index: slots.length,
        segmentIndex: i,
        prompt: buildSlotVisualPrompt(seg, basePrompt, i, j, slotCount, project.channelTheme),
        narratorText: seg.narratorText || basePrompt,
        sectionTitle: seg.sectionTitle || `Section ${i}`,
        startTime: start + j * slotDur,
        duration: slotDur,
        slotInSegment: j,
      });
    }
  }

  const total = slots.length;
  const resolved: (VisualScene | null)[] = new Array(total).fill(null);
  const pexelsChance = (project.visualSourceMix?.pexelsPercentage || 50) / 100;
  let done = 0;
  let geminiCalls = 0;

  const report = (origin: string, reason?: string) => {
    done++;
    const suffix = reason ? ` — ${reason}` : '';
    callbacks.onProgress('visuals', `Cena ${done}/${total} pronta (${origin}${suffix})`);
  };

  // Gemini fallback calls are spaced at least this far apart *globally*,
  // across all concurrent workers (mirrors the manual editor's own 6s
  // throttle). Without this, several slots that miss Pexels at the same
  // instant all hit the Gemini image API together, which is a common way
  // to trip rate limiting and cascade into even more fallbacks.
  const GEMINI_MIN_INTERVAL_MS = 6_000;
  let nextGeminiSlotAt = 0;
  const waitForGeminiSlot = async () => {
    const now = Date.now();
    const wait = Math.max(0, nextGeminiSlotAt - now);
    nextGeminiSlotAt = Math.max(now, nextGeminiSlotAt) + GEMINI_MIN_INTERVAL_MS;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };

  // Turns a thrown error into a short, readable reason for the Activity Log
  // (status/timeout/network) instead of a raw stack trace or nothing at all.
  const describeError = (e: unknown): string => {
    const msg = e instanceof Error ? e.message : String(e ?? '');
    if (/rate.?limit|429/i.test(msg)) return 'rate limit da API';
    if (/timeout/i.test(msg)) return 'timeout';
    if (/network|fetch|cors/i.test(msg)) return 'erro de rede';
    return msg.slice(0, 80) || 'erro desconhecido';
  };

  // ── 2. Resolve one slot, never blocking longer than SLOT_TIMEOUT_MS ─────
  const resolveSlot = async (
    slot: VisualSlot
  ): Promise<{ scene: VisualScene; origin: string; reason?: string }> => {
    let imgUrl = '';
    let videoUrl: string | undefined;
    let pexelsId: number | undefined;
    let origin = 'fallback';
    let pexelsReason: string | undefined;
    let iaReason: string | undefined;

    if (Math.random() < pexelsChance) {
      try {
        const result = await searchContextualMedia(
          slot.narratorText,
          slot.sectionTitle,
          project.defaultTone || 'Cinematic',
          project.channelTheme || '',
          pexelsUsedIds,
          video.format || project.defaultFormat
        );
        if (result) {
          videoUrl = result.videoUrl || undefined;
          imgUrl = result.thumbnailUrl;
          pexelsId = result.id;
          origin = 'Pexels';
        } else {
          pexelsReason = 'Pexels sem resultados';
        }
      } catch (e) {
        pexelsReason = `Pexels: ${describeError(e)}`;
        console.warn('[Visuals] Pexels falhou, caindo para IA', e);
      }
    }

    if (!imgUrl) {
      try {
        await waitForGeminiSlot();
        geminiCalls++;
        imgUrl = await generateSceneImage(
          slot.prompt,
          project.defaultTone,
          video.format,
          undefined,
          45_000,
        );
        origin = 'IA';
      } catch (e) {
        iaReason = `IA: ${describeError(e)}`;
        console.warn('[Visuals] Imagem IA falhou, usando fallback gerado', e);
        imgUrl = createFallbackVisualDataUrl(
          slot.prompt, project.defaultTone, video.format,
          slot.segmentIndex * 100 + slot.slotInSegment,
        );
      }
    }

    const reason = [pexelsReason, iaReason].filter(Boolean).join(' → ') || undefined;

    return {
      scene: {
        segmentIndex: slot.segmentIndex,
        imageUrl: imgUrl,
        videoUrl,
        pexelsId,
        prompt: slot.prompt,
        effect: ANIMATION_EFFECTS[(slot.segmentIndex + slot.slotInSegment) % ANIMATION_EFFECTS.length],
        startTime: slot.startTime,
        duration: slot.duration,
      },
      origin,
      // Pexels succeeding on the first try has nothing to explain.
      reason: origin === 'Pexels' ? undefined : reason,
    };
  };

  const resolveSlotGuarded = async (
    slot: VisualSlot
  ): Promise<{ scene: VisualScene; origin: string; reason?: string }> => {
    const fallback = (): VisualScene => ({
      segmentIndex: slot.segmentIndex,
      imageUrl: createFallbackVisualDataUrl(
        slot.prompt, project.defaultTone, video.format,
        slot.segmentIndex * 100 + slot.slotInSegment,
      ),
      videoUrl: undefined,
      pexelsId: undefined,
      prompt: slot.prompt,
      effect: ANIMATION_EFFECTS[(slot.segmentIndex + slot.slotInSegment) % ANIMATION_EFFECTS.length],
      startTime: slot.startTime,
      duration: slot.duration,
    });

    try {
      return await Promise.race([
        resolveSlot(slot),
        new Promise<{ scene: VisualScene; origin: string; reason?: string }>((_, rej) =>
          setTimeout(() => rej(new Error('slot_timeout')), SLOT_TIMEOUT_MS)
        ),
      ]);
    } catch (e) {
      console.warn(`[Visuals] Cena ${slot.index + 1} estourou o tempo limite — usando fallback`, e);
      return { scene: fallback(), origin: 'fallback', reason: 'tempo limite excedido' };
    }
  };

  // ── 3. Bounded-concurrency pool (order preserved by index) ──────────────
  let cursor = 0;
  const worker = async () => {
    while (cursor < total) {
      const slot = slots[cursor++];
      const { scene, origin, reason } = await resolveSlotGuarded(slot);
      resolved[slot.index] = scene;
      report(origin, reason);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(VISUALS_CONCURRENCY, Math.max(1, total)) }, worker)
  );

  const scenes: VisualScene[] = resolved.filter((s): s is VisualScene => !!s);
  console.log(`[Visuals] ✅ ${scenes.length} cenas (${geminiCalls} chamadas de IA)`);

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

  // A thumbnail NUNCA deve travar ou derrubar o pipeline: teto de 2 min e
  // fallback silencioso (generateThumbnail já devolve canvas em caso de falha).
  let thumbnailUrl: string | undefined;
  try {
    thumbnailUrl = await Promise.race([
      generateThumbnail(video.title, project.defaultTone, scriptSummary, script, project.channelTheme, project.library),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('thumbnail_step_timeout')), 120_000)),
    ]);
  } catch (err: any) {
    console.warn('[Pipeline] Thumbnail falhou, seguindo sem ela:', err?.message);
    thumbnailUrl = undefined;
  }

  if (thumbnailUrl) callbacks.updateVideo(project.id, video.id, { thumbnailUrl });
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

  const fullText = script.segments.map((s: any) => s.narratorText).join(' ');
  const buildMetadata = () => generateVideoMetadata(
    video.title,
    fullText,
    project.defaultTone,
    project.language,
    script.segments,
    script,
    project.channelTheme,
    video.format || project.defaultFormat  // Pass format so isShorts is auto-detected
  );

  // Watchdog: metadados são o passo mais curto do pipeline. Se travar (fila do
  // Gemini em cooldown longo, resposta pendurada), seguimos com a descrição
  // determinística em vez de deixar o pipeline parado para sempre.
  let metadata: any;
  try {
    metadata = await Promise.race([
      buildMetadata(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('metadata_step_timeout')), 90_000)),
    ]);
  } catch (err: any) {
    console.warn('[Pipeline] Metadados por IA falharam, usando fallback determinístico:', err?.message);
    const { buildVideoDescription, buildTimestamps } = await import('./thumbnailDescriptionService');
    const descResult = buildVideoDescription({
      title: video.title,
      script,
      narrativeTone: project.defaultTone,
      niche: project.channelTheme || '',
      language: project.language,
    });
    const isShorts = !!((video.format || project.defaultFormat || '').includes('9:16'));
    metadata = {
      youtubeTitle: video.title,
      youtubeDescription: descResult.fullDescription + '\n\n📋 CAPÍTULOS:\n' + buildTimestamps(script.segments),
      tags: [],
      categoryId: isShorts ? '22' : '24',
      visibility: 'public' as const,
      isShorts,
    };
  }

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
  }, { maxMediaDurationSeconds: project.maxMediaDurationSeconds });

  // Detect actual format from blob type — use MP4 when available (faster YouTube processing)
  const blobType = blob.type || 'video/webm';
  const isMP4 = blobType.includes('mp4');
  const fileName = isMP4 ? 'video.mp4' : 'video.webm';
  const fileType = isMP4 ? 'video/mp4' : 'video/webm';
  const file = new File([blob], fileName, { type: fileType });
  console.log(`[Upload] File format: ${fileType} (${(blob.size / 1024 / 1024).toFixed(1)}MB)`);

  callbacks.onProgress('upload', 'Enviando para YouTube...');
  const liveToken = await resolveYoutubeAccessToken(callbacks);
  if (!liveToken) throw new Error('Token YouTube ausente no momento do upload (expirou durante o pipeline)');
  const ytbId = await uploadVideoToYouTube(liveToken, file, metadata, thumbnailUrl);

  callbacks.updateVideo(project.id, video.id, {
    status: ProjectStatus.PUBLISHED,
    youtubeUrl: `https://youtu.be/${ytbId}`
  });
  callbacks.onStepComplete('upload');
  return ytbId;
}

async function resolveYoutubeAccessToken(callbacks: PipelineCallbacks): Promise<string | null> {
  // Upload is the only step that truly needs YouTube. Always try a project-scoped
  // refresh first so long-running creation pipelines do not reuse an expired
  // access token captured at startup. Fall back to the cached token only if the
  // refresh path is unavailable.
  const refreshed = await callbacks.refreshYoutubeAccessToken?.();
  if (refreshed) return refreshed;
  return callbacks.getYoutubeAccessToken?.() || callbacks.youtubeAccessToken || null;
}

// --- FULL PIPELINE ORCHESTRATOR ---

export async function runAutomationPipeline(
  project: Project,
  callbacks: PipelineCallbacks
): Promise<PipelineResult> {
  // (removed legacy `steps` placeholder — pipeline is orchestrated explicitly below)
  
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
    console.warn('Ambience generation failed, continuing without background music:', e.message);
    callbacks.onProgress('studio', 'Ambiência indisponível, continuando sem música de fundo...');
    musicUrl = '';
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

  // Step 9: Auto-Shorts (non-blocking — failure never stops the main pipeline)
  if (project.autoGenerateShorts) {
    try {
      callbacks.onStepStart('shorts', '⚡ Gerando Short automático...');
      await stepGenerateAndUploadShort(project, video!, script, callbacks);
    } catch (e: any) {
      // Shorts failure is always non-blocking
      console.warn('[Auto-Shorts] Falha ignorada:', e.message);
    }
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

  // Guard: if window is inverted or zero-length, use start time as a fixed point
  // to avoid Math.random() receiving a negative or zero range, which produces
  // NaN/corrupt dates.
  const windowSize = endMinutes > startMinutes ? endMinutes - startMinutes : 0;

  const pickRandom = () => {
    const offset = windowSize > 0 ? Math.floor(Math.random() * windowSize) : 0;
    const total = startMinutes + offset;
    return { h: Math.floor(total / 60), m: total % 60 };
  };

  const { h: randomH, m: randomM } = pickRandom();

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
    nextDate = new Date(now);
    nextDate.setDate(now.getDate() + Math.max(1, settings.frequencyDays || 1));
    const { h: newH, m: newM } = pickRandom();
    nextDate.setHours(newH, newM, 0, 0);
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
  render: '🎬 Renderização',
  upload: '📤 Upload YouTube',
  shorts: '⚡ Auto-Shorts'
};

// ─── Picks the most emotionally engaging segment for the Short ───────────────
function pickBestSegmentForShort(script: any): number {
  if (!script?.segments?.length) return 0;
  
  // Score each segment by emotional density keywords
  const emotionKeywords = [
    'never', 'impossible', 'secret', 'revealed', 'shocking', 'truth',
    'never told', 'hidden', 'dark', 'terrifying', 'mysterious', 'incredible',
    // Portuguese equivalents
    'nunca', 'impossível', 'segredo', 'revelado', 'chocante', 'verdade',
    'escondido', 'sombrio', 'aterrorizante', 'misterioso', 'incrível',
    'jamais', 'oculto', 'surpreendente', 'descoberta', 'real',
  ];

  const scores = script.segments.map((seg: any, i: number) => {
    const text = (seg.narratorText || '').toLowerCase();
    // Prefer middle segments (not intro/outro)
    const positionBonus = i > 0 && i < script.segments.length - 1 ? 2 : 0;
    const emotionScore = emotionKeywords.filter(kw => text.includes(kw)).length;
    // Prefer segments with enough words for a 45-60s clip
    const words = text.split(/\s+/).length;
    const lengthScore = words >= 80 && words <= 200 ? 3 : words >= 50 ? 1 : 0;
    return { index: i, score: emotionScore + positionBonus + lengthScore };
  });

  scores.sort((a: any, b: any) => b.score - a.score);
  return scores[0].index;
}

// ─── Generates and uploads a Short from the best segment ────────────────────
export async function stepGenerateAndUploadShort(
  project: Project,
  video: Video,
  script: any,
  callbacks: PipelineCallbacks
): Promise<string | null> {
  callbacks.onStepStart('shorts', '⚡ Gerando Auto-Short...');

  try {
    // 1. Pick best segment
    const segIdx = pickBestSegmentForShort(script);
    const segment = script.segments[segIdx];
    callbacks.onProgress('shorts', `Segmento selecionado: "${segment.sectionTitle}" (mais impactante)`);

    // 2. Generate voice for just this segment
    const { decodeAudioData, mergeAudioBuffers, audioBufferToBase64, generateVoiceover } = await import('./geminiService');
    const ctx = new AudioContext({ sampleRate: 24000 });
    const audioBuffer = await decodeAudioData(
      await generateVoiceover(segment.narratorText, project.defaultVoice, project.defaultTone || 'Cinematic'),
      ctx
    );
    await ctx.close();
    
    // Cap at 58 seconds for Shorts compliance
    const shortDuration = Math.min(audioBuffer.duration, 58);
    const shortAudioUrl = audioBufferToBase64(audioBuffer);

    callbacks.onProgress('shorts', `Áudio do Short: ${shortDuration.toFixed(1)}s`);

    // 3. Pick visual scenes that overlap with this segment's time range
    const latestProject = callbacks.getLatestProject(project.id);
    const latestVideo = latestProject?.videos.find(v => v.id === video.id);
    const allScenes = latestVideo?.visualScenes || [];

    // Get timestamps for this segment
    const segTimestamps = latestVideo?.segmentTimestamps || [];
    const segStart = segTimestamps[segIdx] ?? 0;
    const segEnd = segTimestamps[segIdx + 1] ?? (segStart + shortDuration);

    // Filter scenes that belong to this segment, rescaled to start from 0
    let shortScenes = allScenes
      .filter(s => s.segmentIndex === segIdx || 
                   (s.startTime >= segStart - 0.5 && s.startTime < segEnd + 0.5))
      .map(s => ({
        ...s,
        startTime: Math.max(0, s.startTime - segStart),
        duration: Math.min(s.duration, shortDuration),
      }));

    // If no matching scenes, take first few scenes and rescale
    if (shortScenes.length === 0) {
      shortScenes = allScenes.slice(0, Math.min(4, allScenes.length)).map((s, i) => ({
        ...s,
        startTime: i * (shortDuration / Math.min(4, allScenes.length)),
        duration: shortDuration / Math.min(4, allScenes.length),
      }));
    }

    // Ensure last scene covers full short duration
    if (shortScenes.length > 0) {
      const last = shortScenes[shortScenes.length - 1];
      if (last.startTime + last.duration < shortDuration) {
        last.duration = shortDuration - last.startTime;
      }
    }

    callbacks.onProgress('shorts', 'Renderizando Short em 9:16...');

    // 4. Build a minimal Video object for the Short render
    const shortVideo: Video = {
      id: `short_${video.id}`,
      projectId: project.id,
      title: `${video.title} #Shorts`,
      status: ProjectStatus.VIDEO_GENERATED,
      targetDuration: 'Short (< 3 min)',
      format: 'Portrait 9:16 (Shorts)',
      specificContext: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      audioUrl: shortAudioUrl,
      visualScenes: shortScenes,
    };

    // 5. Render the Short
    const { renderVideoHeadless } = await import('./renderService');
    const shortBlob = await renderVideoHeadless(shortVideo, (pct, status) => {
      callbacks.onProgress('shorts', `Renderizando Short: ${status}`);
    }, { maxMediaDurationSeconds: project.maxMediaDurationSeconds });

    const shortBlobType = shortBlob.type || 'video/webm';
    const shortIsMP4 = shortBlobType.includes('mp4');
    const shortFile = new File([shortBlob], shortIsMP4 ? 'short.mp4' : 'short.webm', { type: shortIsMP4 ? 'video/mp4' : 'video/webm' });

    // 6. Build Shorts metadata
    const shortsMetadata = {
      youtubeTitle: `${segment.sectionTitle || video.title} #Shorts`.substring(0, 100),
      youtubeDescription: `#Shorts

${segment.narratorText?.substring(0, 300) || ''}

📺 Assista ao vídeo completo no canal!`,
      tags: ['shorts', 'viral', ...(latestVideo?.videoMetadata?.tags?.slice(0, 10) || [])],
      categoryId: '22',
      visibility: 'public' as const,
      isShorts: true,
    };

    callbacks.onProgress('shorts', 'Enviando Short para o YouTube...');

    // 7. Upload Short
    const { uploadVideoToYouTube } = await import('./youtubeService');
    const shortLiveToken = await resolveYoutubeAccessToken(callbacks);
    if (!shortLiveToken) throw new Error('Token YouTube ausente para upload do Short');
    const shortYtbId = await uploadVideoToYouTube(
      shortLiveToken,
      shortFile,
      shortsMetadata,
      latestVideo?.thumbnailUrl
    );

    callbacks.onStepComplete('shorts');
    callbacks.onProgress('shorts', `✅ Short publicado: https://youtu.be/${shortYtbId}`);

    return shortYtbId;
  } catch (err: any) {
    console.warn('[Auto-Shorts] Falha ao gerar Short (não bloqueia pipeline):', err.message);
    return null;
  }
}
