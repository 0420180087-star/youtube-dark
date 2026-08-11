/**
 * Shared visual-slot resolution engine.
 *
 * This is the ONE place that turns a "slot" (a time window that needs a
 * visual) into an actual VisualScene via Pexels → Gemini, with:
 *   - a global throttle on Gemini fallback calls (avoids rate-limit bursts)
 *   - a per-slot timeout so one hung call can't stall the whole video
 *   - reuse of already-valid scenes from a previous attempt (resume support)
 *   - categorized failure reasons for the Activity Log
 *   - NO generic/placeholder images in the final result: if both Pexels and
 *     Gemini fail for a slot, we reuse the nearest already-resolved real
 *     scene from the same video instead. A synthetic placeholder is only
 *     ever used if literally nothing in the whole video succeeded (total
 *     Pexels+Gemini outage) — see buildFallbackScene below.
 *
 * Previously this logic was hand-duplicated in three places (the automatic
 * pipeline, "generate all visuals", and "regenerate this scene"), which is
 * how they drifted out of sync — e.g. one of them ignoring the user's
 * Pexels/IA mix slider. Slot *planning* (deciding where the cut points and
 * time windows are) intentionally stays with each caller, since that varies
 * by context; only slot *resolution* is unified here.
 */

import { Project, Video, VisualScene, VisualEffect } from '../types';
import { searchContextualMedia } from './pexelsService';
import { generateSceneImage } from './geminiService';
import { createFallbackVisualDataUrl } from './visualSceneService';

const ANIMATION_EFFECTS: VisualEffect[] = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'zoom-in-fast'];

export interface VisualSlotSpec {
  segmentIndex: number;
  slotInSegment: number;
  prompt: string;
  narratorText: string;
  sectionTitle: string;
  startTime: number;
  duration: number;
}

export type VisualOrigin = 'Pexels' | 'IA' | 'reused' | 'placeholder';

export interface ResolvedVisual {
  scene: VisualScene;
  origin: VisualOrigin;
  reason?: string;
}

/**
 * A real Pexels URL or a real Gemini-generated image is worth keeping on
 * resume/reuse; the generated SVG placeholder means the slot still needs
 * another try, so it must NOT be treated as "already resolved".
 */
export function isUsableVisualUrl(url?: string | null): boolean {
  if (!url) return false;
  if (/^https?:\/\//.test(url)) return true; // Pexels
  if (/^data:image\/(jpeg|jpg|png|webp);base64,/.test(url)) return true; // real Gemini image
  return false; // data:image/svg+xml placeholder, or anything else
}

function isSceneUsable(scene?: VisualScene | null): boolean {
  if (!scene) return false;
  if (scene.videoUrl) return isUsableVisualUrl(scene.videoUrl);
  return isUsableVisualUrl(scene.imageUrl);
}

function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  if (/rate.?limit|429/i.test(msg)) return 'rate limit da API';
  if (/timeout/i.test(msg)) return 'timeout';
  if (/network|fetch|cors/i.test(msg)) return 'erro de rede';
  return msg.slice(0, 80) || 'erro desconhecido';
}

export interface ResolveVisualSlotsOptions {
  project: Project;
  video: Video;
  slots: VisualSlotSpec[];
  pexelsUsedIds: Set<number>;
  /** Existing scene for each slot, same order/length as `slots`. Reused as-is when usable, unless `force`. */
  existingScenes?: (VisualScene | null | undefined)[];
  force?: boolean;
  /** Concurrent workers. 1 = strictly sequential/ordered (used by the manual editor). Default 1. */
  concurrency?: number;
  slotTimeoutMs?: number; // default 90_000
  geminiThrottleMs?: number; // default 6_000 — global spacing between Gemini image calls
  /** Passed through to generateSceneImage so callers that track a cancellable
   *  session (e.g. the manual editor cancelling on unmount) keep working. */
  geminiSessionId?: string;
  signal?: AbortSignal;
  onSlotResolved?: (result: ResolvedVisual & { doneCount: number; total: number }) => void;
}

export async function resolveVisualSlots(opts: ResolveVisualSlotsOptions): Promise<VisualScene[]> {
  const {
    project, video, slots, pexelsUsedIds, existingScenes, force = false,
    concurrency = 1, slotTimeoutMs = 90_000, geminiThrottleMs = 6_000, geminiSessionId, signal, onSlotResolved,
  } = opts;

  const total = slots.length;
  const resolved: (VisualScene | null)[] = new Array(total).fill(null);
  const failReasons: (string | undefined)[] = new Array(total).fill(undefined);
  const pexelsChance = (project.visualSourceMix?.pexelsPercentage || 50) / 100;
  let doneCount = 0;

  // Gemini calls are spaced at least this far apart *globally*, across all
  // concurrent workers. Without this, several slots that miss Pexels at the
  // same instant all hit the Gemini image API together — a common way to
  // trip rate limiting and cascade into even more fallbacks.
  let nextGeminiSlotAt = 0;
  const waitForGeminiSlot = async () => {
    if (geminiThrottleMs <= 0) return;
    const now = Date.now();
    const wait = Math.max(0, nextGeminiSlotAt - now);
    nextGeminiSlotAt = Math.max(now, nextGeminiSlotAt) + geminiThrottleMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };

  const buildFallbackScene = (slot: VisualSlotSpec): VisualScene => ({
    segmentIndex: slot.segmentIndex,
    imageUrl: createFallbackVisualDataUrl(slot.prompt, project.defaultTone, video.format, slot.segmentIndex * 100 + slot.slotInSegment),
    videoUrl: undefined,
    pexelsId: undefined,
    videoOffset: 0,
    prompt: slot.prompt,
    effect: ANIMATION_EFFECTS[(slot.segmentIndex + slot.slotInSegment) % ANIMATION_EFFECTS.length],
    startTime: slot.startTime,
    duration: slot.duration,
  });

  const emit = (idx: number, scene: VisualScene, origin: VisualOrigin, reason?: string) => {
    resolved[idx] = scene;
    doneCount++;
    onSlotResolved?.({ scene, origin, reason, doneCount, total });
  };

  // Nearest already-resolved neighbor, searching outward from idx (prefers
  // the previous slot on a tie, so it reads as "holding" the last shot
  // rather than jumping ahead).
  const findDonor = (idx: number): number => {
    for (let d = 1; d < total; d++) {
      if (idx - d >= 0 && resolved[idx - d]) return idx - d;
      if (idx + d < total && resolved[idx + d]) return idx + d;
    }
    return -1;
  };

  const reuseDonor = (idx: number, donorIdx: number): VisualScene => {
    const donor = resolved[donorIdx]!;
    const slot = slots[idx];
    return {
      ...donor,
      segmentIndex: slot.segmentIndex,
      prompt: slot.prompt,
      startTime: slot.startTime,
      duration: slot.duration,
      // Different motion than the donor so the repeat is less obvious even
      // though the underlying image/video is the same.
      effect: ANIMATION_EFFECTS[(slot.segmentIndex + slot.slotInSegment + 1) % ANIMATION_EFFECTS.length],
    };
  };

  // Resolves ONE slot's own attempt. Returns null (never throws) if both
  // Pexels and Gemini failed — the caller decides how to fill the gap.
  const resolveOwn = async (slot: VisualSlotSpec, idx: number): Promise<ResolvedVisual | null> => {
    if (!force && isSceneUsable(existingScenes?.[idx])) {
      const ex = existingScenes![idx]!;
      return { scene: ex, origin: ex.pexelsId ? 'Pexels' : 'IA' };
    }

    let imgUrl = '';
    let videoUrl: string | undefined;
    let pexelsId: number | undefined;
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
        } else {
          pexelsReason = 'Pexels sem resultados';
        }
      } catch (e) {
        pexelsReason = `Pexels: ${describeError(e)}`;
      }
    }

    if (!imgUrl) {
      try {
        await waitForGeminiSlot();
        imgUrl = await generateSceneImage(slot.prompt, project.defaultTone, video.format, geminiSessionId, 45_000);
      } catch (e) {
        iaReason = `IA: ${describeError(e)}`;
      }
    }

    if (!imgUrl) {
      failReasons[idx] = [pexelsReason, iaReason].filter(Boolean).join(' → ') || undefined;
      return null;
    }

    const origin: VisualOrigin = pexelsId ? 'Pexels' : 'IA';
    return {
      scene: {
        segmentIndex: slot.segmentIndex,
        imageUrl: imgUrl,
        videoUrl,
        pexelsId,
        videoOffset: videoUrl ? Math.random() * 10 : 0,
        prompt: slot.prompt,
        effect: ANIMATION_EFFECTS[(slot.segmentIndex + slot.slotInSegment) % ANIMATION_EFFECTS.length],
        startTime: slot.startTime,
        duration: slot.duration,
      },
      origin,
      reason: origin === 'Pexels' ? undefined : pexelsReason,
    };
  };

  let cursor = 0;
  const worker = async () => {
    while (cursor < total) {
      if (signal?.aborted) return;
      const idx = cursor++;
      const slot = slots[idx];

      let result: ResolvedVisual | null;
      try {
        result = await Promise.race([
          resolveOwn(slot, idx),
          new Promise<null>((_, rej) => setTimeout(() => rej(new Error('slot_timeout')), slotTimeoutMs)),
        ]);
      } catch {
        result = null;
        failReasons[idx] = 'tempo limite excedido';
      }

      if (result) {
        emit(idx, result.scene, result.origin, result.reason);
        continue;
      }

      // Both sources failed — try to reuse whatever's already resolved
      // rather than ever showing a generic placeholder. If nothing is
      // resolved yet (early race with concurrency>1), this slot is left
      // for the gap-filling pass below, once more of the video is done.
      const donorIdx = findDonor(idx);
      if (donorIdx !== -1) {
        emit(idx, reuseDonor(idx, donorIdx), 'reused', `Pexels/IA falharam — reaproveitando cena ${donorIdx + 1}`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, total)) }, worker)
  );

  // Gap-filling pass — only reached by slots that had no resolved neighbor
  // at the moment they failed. A generated placeholder can ONLY still
  // appear here, and only if NOTHING in the entire video ever succeeded
  // (a full Pexels+Gemini outage) — that's a systemic problem worth a loud
  // log, not something normal operation should hit.
  for (let idx = 0; idx < total; idx++) {
    if (resolved[idx]) continue;
    const donorIdx = findDonor(idx);
    if (donorIdx !== -1) {
      emit(idx, reuseDonor(idx, donorIdx), 'reused', `Pexels/IA falharam — reaproveitando cena ${donorIdx + 1}`);
    } else {
      console.error(
        `[Visuals] Cena ${idx + 1}/${total}: Pexels e IA indisponíveis para todas as cenas resolvidas até aqui — usando placeholder genérico como último recurso.`
      );
      emit(idx, buildFallbackScene(slots[idx]), 'placeholder', failReasons[idx] || 'Pexels e IA indisponíveis');
    }
  }

  return resolved as VisualScene[];
}
