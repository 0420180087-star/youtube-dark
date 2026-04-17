import { Video, VisualEffect } from "../types";
import { decodeAudioData } from "./geminiService";

const easeInOutCubic = (x: number): number =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

// ─── Scanlines overlay ───────────────────────────────────────────────────────
const drawScanlines = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
) => {
  ctx.save();
  ctx.globalAlpha = 0.04;
  ctx.fillStyle = "rgba(0,0,0,1)";
  for (let i = 0; i < height; i += 4) ctx.fillRect(0, i, width, 1);
  ctx.restore();
};

// ─── Ken Burns effect — images only ─────────────────────────────────────────
const applyKenBurns = (
  ctx: CanvasRenderingContext2D,
  effect: VisualEffect,
  progress: number,
  width: number,
  height: number
) => {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const p = easeInOutCubic(Math.min(1, Math.max(0, progress)));
  const cx = width / 2;
  const cy = height / 2;

  if (effect === "zoom-in") {
    const s = 1 + 0.1 * p;
    ctx.translate(cx, cy); ctx.scale(s, s); ctx.translate(-cx, -cy);
  } else if (effect === "zoom-out") {
    const s = 1.1 - 0.1 * p;
    ctx.translate(cx, cy); ctx.scale(s, s); ctx.translate(-cx, -cy);
  } else if (effect === "pan-right") {
    const s = 1.06;
    const ox = -width * 0.03 + width * 0.06 * p;
    ctx.translate(cx + ox, cy); ctx.scale(s, s); ctx.translate(-cx, -cy);
  } else if (effect === "pan-left") {
    const s = 1.06;
    const ox = width * 0.03 - width * 0.06 * p;
    ctx.translate(cx + ox, cy); ctx.scale(s, s); ctx.translate(-cx, -cy);
  } else {
    const s = 1 + 0.06 * p;
    ctx.translate(cx, cy); ctx.scale(s, s); ctx.translate(-cx, -cy);
  }
};

// ─── Scene type ──────────────────────────────────────────────────────────────
type LoadedScene = {
  startTime: number;
  duration: number;
  effect: VisualEffect;
  element: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;
  isVideo: boolean;
  ready: boolean;
  videoStarted: boolean;
  originalIndex: number;
};

// ─── Load scene — image only (video CORS is unreliable in canvas) ────────────
//
// KEY DESIGN DECISION: Pexels video URLs cannot be drawn to canvas reliably
// because the CDN blocks crossOrigin canvas access in many browsers.
// Instead we always use the thumbnail image (which IS accessible) and apply
// Ken Burns animation to it. This guarantees every scene renders correctly.
//
const loadSceneMedia = async (
  scene: {
    startTime: number;
    duration: number;
    effect: VisualEffect;
    videoUrl?: string;
    imageUrl: string;
  },
  index: number
): Promise<LoadedScene> => {
  // Always load as image — reliable, no CORS issues with canvas
  const img = new Image();
  img.crossOrigin = "anonymous";

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("image timeout")), 12000);
      img.onload = () => { clearTimeout(timeout); resolve(); };
      img.onerror = () => {
        clearTimeout(timeout);
        // Try without crossOrigin as fallback
        const img2 = new Image();
        img2.onload = () => { clearTimeout(timeout); resolve(); };
        img2.onerror = () => { clearTimeout(timeout); reject(new Error("image error")); };
        img2.src = scene.imageUrl;
        img.src = img2.src;
      };
      img.src = scene.imageUrl;
    });

    return {
      startTime: scene.startTime,
      duration: scene.duration,
      effect: scene.effect,
      element: img,
      isVideo: false,
      ready: true,
      videoStarted: false,
      originalIndex: index,
    };
  } catch {
    console.warn("⚠️ Imagem falhou, usando placeholder:", scene.imageUrl);
  }

  // Placeholder — gradient canvas
  const placeholder = document.createElement("canvas");
  placeholder.width = 1920;
  placeholder.height = 1080;
  const pCtx = placeholder.getContext("2d")!;
  const PLACEHOLDER_COLORS = [
    ["#0d1b2a", "#1b263b"],
    ["#1a0a2e", "#2d1b4e"],
    ["#0a1628", "#162032"],
    ["#1c0a0a", "#2e1515"],
  ];
  const [c1, c2] = PLACEHOLDER_COLORS[index % PLACEHOLDER_COLORS.length];
  const grad = pCtx.createLinearGradient(0, 0, 1920, 1080);
  grad.addColorStop(0, c1); grad.addColorStop(1, c2);
  pCtx.fillStyle = grad; pCtx.fillRect(0, 0, 1920, 1080);

  return {
    startTime: scene.startTime,
    duration: scene.duration,
    effect: scene.effect,
    element: placeholder,
    isVideo: false,
    ready: true,
    videoStarted: false,
    originalIndex: index,
  };
};

// ─── Get dimensions safely ───────────────────────────────────────────────────
const getDims = (el: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement) => {
  if (el instanceof HTMLImageElement) {
    return { w: el.naturalWidth || el.width || 1920, h: el.naturalHeight || el.height || 1080 };
  }
  if (el instanceof HTMLCanvasElement) {
    return { w: el.width || 1920, h: el.height || 1080 };
  }
  const v = el as HTMLVideoElement;
  return { w: v.videoWidth || 1920, h: v.videoHeight || 1080 };
};

// ─── Draw a single scene frame ───────────────────────────────────────────────
const drawScene = (
  ctx: CanvasRenderingContext2D,
  scene: LoadedScene,
  progress: number,
  width: number,
  height: number,
  alpha: number
) => {
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, alpha));

  applyKenBurns(ctx, scene.effect, progress, width, height);
  ctx.filter = "saturate(110%) contrast(1.03)";

  const { w, h } = getDims(scene.element);
  const scale = Math.max(width / w, height / h);
  const dw = w * scale;
  const dh = h * scale;
  const dx = (width - dw) / 2;
  const dy = (height - dh) / 2;

  ctx.drawImage(scene.element as CanvasImageSource, dx, dy, dw, dh);
  ctx.restore();
};

// ─── MAIN RENDER FUNCTION ────────────────────────────────────────────────────
export const renderVideoHeadless = async (
  video: Video,
  onProgress: (percent: number, status: string) => void
): Promise<Blob> => {
  if (!video.audioUrl || !video.visualScenes || video.visualScenes.length === 0)
    throw new Error("Missing assets — audio or visual scenes not found");

  // ── AUDIO ───────────────────────────────────────────────────────────────────
  onProgress(1, "Processing Audio...");
  const sampleRate = 44100;

  const audioBytes = new Uint8Array(
    atob(video.audioUrl).split("").map((c) => c.charCodeAt(0))
  ).buffer;

  const tempCtx = new AudioContext({ sampleRate });
  const voiceBuffer = await decodeAudioData(audioBytes, tempCtx);
  await tempCtx.close();

  const totalSamples = Math.ceil(voiceBuffer.duration * sampleRate);
  const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);

  const vSrc = offlineCtx.createBufferSource();
  vSrc.buffer = voiceBuffer;

  // Background music mix
  if (video.backgroundMusicUrl) {
    try {
      const musicBytes = new Uint8Array(
        atob(video.backgroundMusicUrl).split("").map((c) => c.charCodeAt(0))
      ).buffer;
      const mTmpCtx = new AudioContext({ sampleRate });
      const musicBuffer = await decodeAudioData(musicBytes, mTmpCtx);
      await mTmpCtx.close();

      const mSrc = offlineCtx.createBufferSource();
      mSrc.buffer = musicBuffer;
      mSrc.loop = true;

      const mGain = offlineCtx.createGain();
      mGain.gain.value = 0.14;

      const comp = offlineCtx.createDynamicsCompressor();
      comp.threshold.value = -24; comp.ratio.value = 12;
      comp.attack.value = 0.003; comp.release.value = 0.25;

      mSrc.connect(mGain); mGain.connect(comp);
      comp.connect(offlineCtx.destination);
      mSrc.start(0);
    } catch {
      console.warn("⚠️ Background music failed, using narration only");
    }
  }

  const vGain = offlineCtx.createGain();
  vGain.gain.value = 1.0;
  vSrc.connect(vGain); vGain.connect(offlineCtx.destination);
  vSrc.start(0);

  onProgress(5, "Rendering audio mix...");
  const finalAudioBuffer = await offlineCtx.startRendering();
  const audioDuration = finalAudioBuffer.duration;

  // ── LOAD ALL SCENES AS IMAGES ───────────────────────────────────────────────
  onProgress(10, "Loading scenes...");

  // Sort scenes by startTime to ensure correct order
  const sortedSceneInputs = [...video.visualScenes].sort((a, b) => a.startTime - b.startTime);

  const loadedScenes: LoadedScene[] = await Promise.all(
    sortedSceneInputs.map((scene, i) => {
      onProgress(10 + (i / sortedSceneInputs.length) * 10, `Loading scene ${i + 1}/${sortedSceneInputs.length}...`);
      return loadSceneMedia(scene, i);
    })
  );

  // ── RECALCULATE SCENE TIMING based on actual audio duration ────────────────
  // This is the key fix: scenes must be evenly distributed across the FULL audio duration
  // The stored startTime values may be wrong (based on estimated duration, not real audio)
  
  const totalStoredDuration = sortedSceneInputs.reduce((sum, s) => sum + s.duration, 0);
  const needsRecalc = Math.abs(totalStoredDuration - audioDuration) > 2;

  if (needsRecalc) {
    console.log(`[Render] Recalculating scene timing: stored=${totalStoredDuration.toFixed(1)}s, audio=${audioDuration.toFixed(1)}s`);
    const scale = audioDuration / totalStoredDuration;
    let t = 0;
    for (const scene of loadedScenes) {
      scene.startTime = t;
      scene.duration = scene.duration * scale;
      t += scene.duration;
    }
  }

  // Cover any gaps between scenes
  for (let i = 0; i < loadedScenes.length - 1; i++) {
    const gap = loadedScenes[i + 1].startTime - (loadedScenes[i].startTime + loadedScenes[i].duration);
    if (gap > 0.01) loadedScenes[i].duration += gap;
  }

  // Last scene always extends to end of audio
  if (loadedScenes.length > 0) {
    const last = loadedScenes[loadedScenes.length - 1];
    const end = last.startTime + last.duration;
    if (end < audioDuration) last.duration = audioDuration - last.startTime;
  }

  console.log(`[Render] ${loadedScenes.length} scenes loaded. Audio: ${audioDuration.toFixed(1)}s`);
  console.log("[Render] Scene timing:", loadedScenes.map(s => `${s.startTime.toFixed(1)}-${(s.startTime+s.duration).toFixed(1)}s`).join(", "));

  onProgress(20, "Rendering video...");

  // ── CANVAS + RECORDER ──────────────────────────────────────────────────────
  const width = 1920;
  const height = video.format?.includes("9:16") ? 3413 : video.format?.includes("1:1") ? 1920 : 1080;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx2d = canvas.getContext("2d", { alpha: false })!;

  ctx2d.fillStyle = "#050505";
  ctx2d.fillRect(0, 0, width, height);

  const audioCtx = new AudioContext({ sampleRate });
  if (audioCtx.state === "suspended") await audioCtx.resume();

  const stream = canvas.captureStream(30);
  const audioDest = audioCtx.createMediaStreamDestination();
  const audioSrc = audioCtx.createBufferSource();
  audioSrc.buffer = finalAudioBuffer;
  audioSrc.connect(audioDest);
  stream.addTrack(audioDest.stream.getAudioTracks()[0]);

  const mimeType = MediaRecorder.isTypeSupported("video/webm; codecs=vp9")
    ? "video/webm; codecs=vp9"
    : MediaRecorder.isTypeSupported("video/webm; codecs=vp8")
    ? "video/webm; codecs=vp8"
    : "video/webm";

  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

  const renderPromise = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
  });

  recorder.start(1000);
  await new Promise((r) => setTimeout(r, 150));
  audioSrc.start(0);

  const wallStart = performance.now();
  const CROSSFADE = 0.5; // seconds

  // ── RENDER LOOP ────────────────────────────────────────────────────────────
  return new Promise((resolve, reject) => {
    const renderLoop = () => {
      try {
        const elapsed = (performance.now() - wallStart) / 1000;

        if (elapsed >= audioDuration + 0.5) {
          recorder.stop();
          try { audioSrc.stop(); } catch { /* ignore */ }
          audioCtx.close();
          renderPromise.then(resolve).catch(reject);
          return;
        }

        // Progress update
        onProgress(
          20 + Math.min(80, Math.round((elapsed / audioDuration) * 80)),
          `Rendering ${elapsed.toFixed(1)}s / ${audioDuration.toFixed(1)}s`
        );

        // Find current scene index
        let sceneIdx = loadedScenes.findIndex(
          (s) => elapsed >= s.startTime && elapsed < s.startTime + s.duration
        );
        if (sceneIdx === -1) sceneIdx = loadedScenes.length - 1;

        const scene = loadedScenes[sceneIdx];
        const sceneTime = elapsed - scene.startTime;
        const sceneProgress = Math.min(1, sceneTime / scene.duration);

        // Solid background — prevents alpha bleed-through
        ctx2d.globalAlpha = 1;
        ctx2d.globalCompositeOperation = "source-over";
        ctx2d.filter = "none";
        ctx2d.setTransform(1, 0, 0, 1, 0, 0);
        ctx2d.fillStyle = "#050505";
        ctx2d.fillRect(0, 0, width, height);

        // Draw previous scene for crossfade
        if (sceneIdx > 0 && sceneTime < CROSSFADE) {
          const prev = loadedScenes[sceneIdx - 1];
          const prevTime = elapsed - prev.startTime;
          const prevProgress = Math.min(1, prevTime / prev.duration);
          drawScene(ctx2d, prev, prevProgress, width, height, 1);
        }

        // Draw current scene — fade in if at start
        const fadeInAlpha = sceneTime < CROSSFADE ? sceneTime / CROSSFADE : 1;
        // Fade out if near end of scene
        const timeLeft = scene.duration - sceneTime;
        const fadeOutAlpha = timeLeft < CROSSFADE ? timeLeft / CROSSFADE : 1;
        const alpha = Math.min(fadeInAlpha, fadeOutAlpha);

        drawScene(ctx2d, scene, sceneProgress, width, height, alpha);

        // Reset transforms before scanlines
        ctx2d.globalAlpha = 1;
        ctx2d.filter = "none";
        ctx2d.setTransform(1, 0, 0, 1, 0, 0);

        drawScanlines(ctx2d, width, height);

        requestAnimationFrame(renderLoop);
      } catch (err) {
        reject(err);
      }
    };

    renderLoop();
  });
};
