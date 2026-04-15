import { Video, VisualEffect } from "../types";
import { decodeAudioData } from "./geminiService";

const easeInOutCubic = (x: number): number =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

// Scanlines only — subtle, not aggressive
const drawScanlines = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number
) => {
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = "rgba(0,0,0,1)";
  for (let i = 0; i < height; i += 4) ctx.fillRect(0, i, width, 1);
  // Subtle moving line
  const lineY = Math.floor(time * 80) % height;
  ctx.globalAlpha = 0.08;
  ctx.fillRect(0, lineY, width, 2);
  ctx.restore();
};

// Apply zoom/pan ONLY to static images — never to Pexels videos
const calculateTransform = (
  ctx: CanvasRenderingContext2D,
  effect: VisualEffect,
  rawProgress: number,
  width: number,
  height: number
) => {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const progress = easeInOutCubic(rawProgress);
  const centerX = width / 2;
  const centerY = height / 2;

  if (effect === "zoom-in") {
    const scale = 1 + 0.12 * progress; // subtle zoom
    ctx.translate(centerX, centerY);
    ctx.scale(scale, scale);
    ctx.translate(-centerX, -centerY);
  } else if (effect === "pan-right") {
    const scale = 1.08;
    const maxPan = width * 0.04;
    const xOffset = -maxPan / 2 + maxPan * progress;
    ctx.translate(centerX + xOffset, centerY);
    ctx.scale(scale, scale);
    ctx.translate(-centerX, -centerY);
  } else if (effect === "pan-left") {
    const scale = 1.08;
    const maxPan = width * 0.04;
    const xOffset = maxPan / 2 - maxPan * progress;
    ctx.translate(centerX + xOffset, centerY);
    ctx.scale(scale, scale);
    ctx.translate(-centerX, -centerY);
  } else if (effect === "zoom-out") {
    const scale = 1.12 - 0.12 * progress;
    ctx.translate(centerX, centerY);
    ctx.scale(scale, scale);
    ctx.translate(-centerX, -centerY);
  } else {
    // zoom-in-fast and default — slight scale only
    const scale = 1 + 0.08 * progress;
    ctx.translate(centerX, centerY);
    ctx.scale(scale, scale);
    ctx.translate(-centerX, -centerY);
  }
};

// ─── Carrega mídia com timeout e fallback robusto ────────────────────────────

type LoadedScene = {
  startTime: number;
  duration: number;
  effect: VisualEffect;
  element: HTMLImageElement | HTMLVideoElement;
  isVideo: boolean;
  ready: boolean;
  videoStarted: boolean;
};

const loadSceneMedia = async (scene: {
  startTime: number;
  duration: number;
  effect: VisualEffect;
  videoUrl?: string;
  imageUrl: string;
}): Promise<LoadedScene> => {
  // 1. Try loading as video
  if (scene.videoUrl) {
    try {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = scene.videoUrl;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("video load timeout")),
          25000
        );

        const onReady = () => {
          clearTimeout(timeout);
          resolve();
        };
        const onError = () => {
          clearTimeout(timeout);
          reject(new Error("video load error"));
        };

        video.onloadedmetadata = () => {
          if (video.readyState >= 3) { onReady(); return; }
          video.oncanplay = onReady;
        };
        video.oncanplaythrough = onReady;
        video.onerror = onError;
        video.load();
      });

      if (video.videoWidth === 0 || video.videoHeight === 0) {
        throw new Error("video dimensions still 0 after load");
      }

      // Seek to beginning and pause — we control playback in render loop
      video.currentTime = 0;

      return {
        startTime: scene.startTime,
        duration: scene.duration,
        effect: scene.effect,
        element: video,
        isVideo: true,
        ready: true,
        videoStarted: false,
      };
    } catch (e) {
      console.warn("⚠️ Vídeo falhou, usando imagem de fallback:", scene.videoUrl, e);
    }
  }

  // 2. Fallback: static image
  const img = new Image();
  img.crossOrigin = "anonymous";

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("image timeout")), 10000);
      img.onload = () => { clearTimeout(timeout); resolve(); };
      img.onerror = () => { clearTimeout(timeout); reject(new Error("image error")); };
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
    };
  } catch {
    console.warn("⚠️ Imagem falhou, usando placeholder:", scene.imageUrl);
  }

  // 3. Placeholder gradient — never a black frame
  const placeholder = document.createElement("canvas");
  placeholder.width = 1920;
  placeholder.height = 1080;
  const pCtx = placeholder.getContext("2d")!;
  const gradient = pCtx.createLinearGradient(0, 0, 1920, 1080);
  gradient.addColorStop(0, "#1a1a2e");
  gradient.addColorStop(1, "#16213e");
  pCtx.fillStyle = gradient;
  pCtx.fillRect(0, 0, 1920, 1080);

  const placeholderImg = new Image();
  await new Promise<void>((resolve) => {
    placeholderImg.onload = () => resolve();
    placeholderImg.src = placeholder.toDataURL();
  });

  return {
    startTime: scene.startTime,
    duration: scene.duration,
    effect: scene.effect,
    element: placeholderImg,
    isVideo: false,
    ready: true,
    videoStarted: false,
  };
};

// ─── Dimensões seguras ───────────────────────────────────────────────────────

const getMediaDimensions = (scene: LoadedScene): { w: number; h: number } => {
  if (scene.isVideo) {
    const vid = scene.element as HTMLVideoElement;
    const w = vid.videoWidth;
    const h = vid.videoHeight;
    if (w > 0 && h > 0) return { w, h };
    return { w: 1920, h: 1080 };
  }
  const img = scene.element as HTMLImageElement;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (w > 0 && h > 0) return { w, h };
  return { w: 1920, h: 1080 };
};

// ─── Desenha frame ────────────────────────────────────────────────────────────

const drawMediaFrame = (
  ctx: CanvasRenderingContext2D,
  scene: LoadedScene,
  sceneProgress: number,
  elapsed: number,
  width: number,
  height: number
): boolean => {
  ctx.save();

  if (scene.isVideo) {
    const videoEl = scene.element as HTMLVideoElement;

    if (videoEl.readyState < 2) {
      ctx.restore();
      return false;
    }

    // Start video playback exactly once when its scene begins
    if (!scene.videoStarted) {
      videoEl.currentTime = 0;
      videoEl.play().catch(() => {});
      scene.videoStarted = true;
    }

    // DO NOT manipulate currentTime — let video play naturally
    // This is the key fix: seeking during playback causes black frames

    // No transform, no filter for Pexels videos — play as-is
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";

    const { w: elW, h: elH } = getMediaDimensions(scene);
    const scale = Math.max(width / elW, height / elH);
    const dw = elW * scale;
    const dh = elH * scale;
    const dx = (width - dw) / 2;
    const dy = (height - dh) / 2;

    ctx.drawImage(videoEl, dx, dy, dw, dh);
    ctx.restore();
    return true;
  }

  // Static image — apply subtle Ken Burns effect
  calculateTransform(ctx, scene.effect, sceneProgress, width, height);

  // Subtle color enhancement for images only
  ctx.filter = "saturate(115%) contrast(1.05)";

  const { w: elW, h: elH } = getMediaDimensions(scene);
  const scale = Math.max(width / elW, height / elH);
  const dw = elW * scale;
  const dh = elH * scale;
  const dx = (width - dw) / 2;
  const dy = (height - dh) / 2;

  ctx.drawImage(scene.element, dx, dy, dw, dh);
  ctx.restore();
  return true;
};

// ─── Crossfade ────────────────────────────────────────────────────────────────

const CROSSFADE_DURATION = 0.5;

const getCrossfadeAlpha = (scene: LoadedScene, elapsed: number): number => {
  const sceneEnd = scene.startTime + scene.duration;
  const fadeInEnd = scene.startTime + CROSSFADE_DURATION;
  const fadeOutStart = sceneEnd - CROSSFADE_DURATION;

  if (elapsed < fadeInEnd) {
    return Math.min(1, (elapsed - scene.startTime) / CROSSFADE_DURATION);
  } else if (elapsed > fadeOutStart) {
    return Math.max(0, (sceneEnd - elapsed) / CROSSFADE_DURATION);
  }
  return 1;
};

// ─── RENDERIZAÇÃO PRINCIPAL ──────────────────────────────────────────────────

export const renderVideoHeadless = async (
  video: Video,
  onProgress: (percent: number, status: string) => void
): Promise<Blob> => {
  if (!video.audioUrl || !video.visualScenes)
    throw new Error("Missing assets");

  // ── ÁUDIO ──────────────────────────────────────────────────────────────────

  onProgress(1, "Mastering Audio...");
  const sampleRate = 44100;

  const audioBytes = new Uint8Array(
    atob(video.audioUrl)
      .split("")
      .map((c) => c.charCodeAt(0))
  ).buffer;

  const tempCtx = new AudioContext({ sampleRate });
  const voiceBuffer = await decodeAudioData(audioBytes, tempCtx);
  await tempCtx.close();

  const totalSamples = Math.ceil(voiceBuffer.duration * sampleRate);
  const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);

  const vSrc = offlineCtx.createBufferSource();
  vSrc.buffer = voiceBuffer;

  if (video.backgroundMusicUrl) {
    try {
      const musicBytes = new Uint8Array(
        atob(video.backgroundMusicUrl)
          .split("")
          .map((c) => c.charCodeAt(0))
      ).buffer;

      const musicTempCtx = new AudioContext({ sampleRate });
      const musicBuffer = await decodeAudioData(musicBytes, musicTempCtx);
      await musicTempCtx.close();

      const mSrc = offlineCtx.createBufferSource();
      mSrc.buffer = musicBuffer;
      mSrc.loop = true;

      const mGain = offlineCtx.createGain();
      mGain.gain.value = 0.15; // keep music subtle under voice

      const compressor = offlineCtx.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.knee.value = 30;
      compressor.ratio.value = 12;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;

      mSrc.connect(mGain);
      mGain.connect(compressor);
      compressor.connect(offlineCtx.destination);
      mSrc.start(0);
    } catch (e) {
      console.warn("⚠️ Música de fundo falhou, continuando só com narração");
    }
  }

  const vGain = offlineCtx.createGain();
  vGain.gain.value = 1.0;
  vSrc.connect(vGain);
  vGain.connect(offlineCtx.destination);
  vSrc.start(0);

  onProgress(5, "Processing Audio...");
  const finalAudioBuffer = await offlineCtx.startRendering();

  // ── VISUAIS: PRÉ-CARREGAMENTO COMPLETO ────────────────────────────────────

  onProgress(10, "Loading Visuals...");

  const width = 1920;
  const height = video.format?.includes("9:16")
    ? 3413
    : video.format?.includes("1:1")
    ? 1920
    : 1080;

  const loadedScenes = await Promise.all(
    video.visualScenes.map((scene, i) => {
      onProgress(
        10 + (i / video.visualScenes!.length) * 10,
        `Loading scene ${i + 1}/${video.visualScenes!.length}...`
      );
      return loadSceneMedia(scene);
    })
  );

  // Cover gaps between scenes
  for (let i = 0; i < loadedScenes.length - 1; i++) {
    const current = loadedScenes[i];
    const next = loadedScenes[i + 1];
    const gap = next.startTime - (current.startTime + current.duration);
    if (gap > 0) {
      current.duration += gap;
    }
  }

  // Last scene covers to end of audio
  if (loadedScenes.length > 0) {
    const last = loadedScenes[loadedScenes.length - 1];
    const audioEnd = finalAudioBuffer.duration;
    if (last.startTime + last.duration < audioEnd) {
      last.duration = audioEnd - last.startTime;
    }
  }

  onProgress(20, "Rendering...");

  // ── CANVAS E GRAVAÇÃO ─────────────────────────────────────────────────────

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  // alpha: false is CRITICAL — prevents transparency being captured as black by MediaRecorder
  const ctx2d = canvas.getContext("2d", { alpha: false })!;

  // Paint solid background before any scene
  ctx2d.fillStyle = "#0a0a0a";
  ctx2d.fillRect(0, 0, width, height);

  const audioCtx = new AudioContext({ sampleRate });
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }

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

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 12_000_000, // increased for better quality
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const renderPromise = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
  });

  recorder.start(1000); // 1s chunks for more regular keyframes
  await new Promise((r) => setTimeout(r, 100));
  audioSrc.start(0);

  const startTime = performance.now();
  const duration = finalAudioBuffer.duration;

  // ── LOOP DE RENDERIZAÇÃO ──────────────────────────────────────────────────

  return new Promise((resolve, reject) => {
    let lastDrawnScene: LoadedScene | null = null;
    let lastSceneRef: LoadedScene | null = null;

    const renderLoop = () => {
      try {
        const elapsed = (performance.now() - startTime) / 1000;
        const progress = Math.min(100, Math.round((elapsed / duration) * 100));
        onProgress(
          20 + progress * 0.8,
          `Rendering frame at ${elapsed.toFixed(1)}s / ${duration.toFixed(1)}s`
        );

        if (elapsed >= duration + 0.3) {
          recorder.stop();
          try { audioSrc.stop(); } catch { /* already stopped */ }
          audioCtx.close();
          renderPromise.then(resolve).catch(reject);
          return;
        }

        // Find current scene
        const currentScene =
          loadedScenes.find(
            (s) => elapsed >= s.startTime && elapsed < s.startTime + s.duration
          ) || loadedScenes[loadedScenes.length - 1];

        // ALWAYS paint solid background first to prevent alpha bleed-through
        ctx2d.globalAlpha = 1;
        ctx2d.globalCompositeOperation = "source-over";
        ctx2d.fillStyle = "#0a0a0a";
        ctx2d.fillRect(0, 0, width, height);

        if (currentScene) {
          const isNewScene = currentScene !== lastSceneRef;
          const sceneTime = elapsed - currentScene.startTime;
          const sceneProgress = Math.min(1, sceneTime / currentScene.duration);

          // Draw previous scene underneath for crossfade (only for image scenes)
          const prevScene = isNewScene && lastDrawnScene && lastDrawnScene !== currentScene
            ? lastDrawnScene
            : null;

          if (prevScene && !prevScene.isVideo && !currentScene.isVideo) {
            const prevSceneTime = elapsed - prevScene.startTime;
            const prevProgress = Math.min(1, prevSceneTime / prevScene.duration);
            ctx2d.globalAlpha = 1;
            drawMediaFrame(ctx2d, prevScene, prevProgress, elapsed, width, height);
          }

          // Draw current scene
          const alpha = (prevScene && !currentScene.isVideo) ? getCrossfadeAlpha(currentScene, elapsed) : 1;
          ctx2d.globalAlpha = alpha;
          const drawn = drawMediaFrame(ctx2d, currentScene, sceneProgress, elapsed, width, height);

          // Fallback: if video not ready, redraw last valid frame
          if (!drawn && lastDrawnScene) {
            ctx2d.globalAlpha = 1;
            const fallbackTime = elapsed - lastDrawnScene.startTime;
            const fallbackProgress = Math.min(1, fallbackTime / lastDrawnScene.duration);
            drawMediaFrame(ctx2d, lastDrawnScene, fallbackProgress, elapsed, width, height);
          }

          if (drawn) lastDrawnScene = currentScene;

          // Reset alpha BEFORE scanlines
          ctx2d.globalAlpha = 1;
          ctx2d.filter = "none";
          ctx2d.setTransform(1, 0, 0, 1, 0, 0);

          // Subtle scanlines overlay
          drawScanlines(ctx2d, width, height, elapsed);

          lastSceneRef = currentScene;
        }

        requestAnimationFrame(renderLoop);
      } catch (err) {
        reject(err);
      }
    };

    renderLoop();
  });
};
