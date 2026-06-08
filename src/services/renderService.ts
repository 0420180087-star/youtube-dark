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
  blobUrl?: string; // for cleanup after render
  // Poster image used as a fallback when the video element isn't ready
  // (buffering, decode glitch, or first-frame not yet decoded). Prevents
  // black frames during playback.
  poster?: HTMLImageElement | HTMLCanvasElement;
};

const createTimelinePlaceholder = (startTime: number, duration: number, index: number): LoadedScene => {
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext("2d")!;
  const palettes = [["#101826", "#0f766e"], ["#172033", "#b45309"], ["#111827", "#be123c"], ["#0f172a", "#2563eb"]];
  const [c1, c2] = palettes[index % palettes.length];
  const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  grad.addColorStop(0, c1);
  grad.addColorStop(1, "#020617");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = c2;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.ellipse(canvas.width * 0.68, canvas.height * 0.42, canvas.width * 0.28, canvas.height * 0.22, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  return {
    startTime,
    duration,
    effect: ["zoom-in", "pan-left", "pan-right", "zoom-out"][index % 4] as VisualEffect,
    element: canvas,
    isVideo: false,
    ready: true,
    videoStarted: false,
    originalIndex: -1,
  };
};

// ─── Load scene — tries video (via blob URL to bypass CORS), falls back to image
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

  // 1. Try to load Pexels video — fetch as blob to bypass canvas CORS taint
  if (scene.videoUrl) {
    try {
      // Fetch the video as a blob — this creates a local blob:// URL
      // that the canvas can draw without CORS taint issues
      const response = await fetch(scene.videoUrl, {
        mode: 'cors',
        headers: { 'Accept': 'video/*' },
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const videoBlob = await response.blob();
      const blobUrl = URL.createObjectURL(videoBlob);

      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.loop = true; // loop short clips so scene duration is always covered (no freeze/black at end)
      video.src = blobUrl; // Use local blob URL — no CORS taint

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("video load timeout")), 20000);
        const onReady = () => { clearTimeout(timeout); resolve(); };
        const onError = () => { clearTimeout(timeout); reject(new Error("video load error")); };
        video.onloadedmetadata = () => {
          if (video.readyState >= 3) { onReady(); return; }
          video.oncanplay = onReady;
        };
        video.oncanplaythrough = onReady;
        video.onerror = onError;
        video.load();
      });

      if (video.videoWidth === 0 || video.videoHeight === 0) {
        throw new Error("video dimensions 0");
      }

      video.currentTime = 0;

      // Preload the Pexels thumbnail as a poster fallback (best-effort).
      // If video.readyState drops below 2 during render, we draw this poster
      // instead of leaving a black frame on screen.
      let poster: HTMLImageElement | undefined;
      if (scene.imageUrl) {
        try {
          const p = new Image();
          p.crossOrigin = "anonymous";
          await new Promise<void>((res) => {
            const t = setTimeout(() => res(), 6000);
            p.onload = () => { clearTimeout(t); res(); };
            p.onerror = () => { clearTimeout(t); res(); };
            p.src = scene.imageUrl;
          });
          if (p.naturalWidth > 0) poster = p;
        } catch { /* ignore — poster is optional */ }
      }

      return {
        startTime: scene.startTime,
        duration: scene.duration,
        effect: scene.effect,
        element: video,
        isVideo: true,
        ready: true,
        videoStarted: false,
        originalIndex: index,
        blobUrl, // store to revoke later
        poster,
      } as LoadedScene;
    } catch (e) {
      console.warn("⚠️ Vídeo falhou (CORS/rede), usando thumbnail:", e);
    }
  }

  // 2. Load as image (thumbnail or Gemini-generated)
  const img = new Image();
  img.crossOrigin = "anonymous";

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("image timeout")), 12000);
      img.onload = () => { clearTimeout(timeout); resolve(); };
      img.onerror = () => {
        clearTimeout(timeout);
        // Try without crossOrigin
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
): boolean => {
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, alpha));

  if (scene.isVideo) {
    const vid = scene.element as HTMLVideoElement;

    // Start video playback on first draw — let it play naturally
    if (!scene.videoStarted) {
      vid.currentTime = 0;
      vid.play().catch(() => {});
      scene.videoStarted = true;
    }

    // If video isn't ready yet, draw the poster (thumbnail) so we never get
    // a black frame on screen. Apply Ken Burns to the poster for life.
    if (vid.readyState < 2) {
      if (scene.poster) {
        applyKenBurns(ctx, scene.effect, progress, width, height);
        ctx.filter = "saturate(110%) contrast(1.03)";
        const pw = (scene.poster as HTMLImageElement).naturalWidth || width;
        const ph = (scene.poster as HTMLImageElement).naturalHeight || height;
        const ps = Math.max(width / pw, height / ph);
        const pdw = pw * ps;
        const pdh = ph * ps;
        ctx.drawImage(scene.poster as CanvasImageSource, (width - pdw) / 2, (height - pdh) / 2, pdw, pdh);
        ctx.restore();
        return true;
      }
      ctx.restore();
      return false;
    }

    // Videos play naturally — NO currentTime manipulation
    // This preserves natural video motion (the whole point of using Pexels videos)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
  } else {
    // Images get Ken Burns + slight enhancement
    applyKenBurns(ctx, scene.effect, progress, width, height);
    ctx.filter = "saturate(110%) contrast(1.03)";
  }

  const { w, h } = getDims(scene.element);
  const scale = Math.max(width / w, height / h);
  const dw = w * scale;
  const dh = h * scale;
  const dx = (width - dw) / 2;
  const dy = (height - dh) / 2;

  ctx.drawImage(scene.element as CanvasImageSource, dx, dy, dw, dh);
  ctx.restore();
  return true;
};

// ─── MAIN RENDER FUNCTION ────────────────────────────────────────────────────
export const renderVideoHeadless = async (
  video: Video,
  onProgress: (percent: number, status: string) => void,
  options: { maxMediaDurationSeconds?: number } = {}
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
  // Never stretch a scene past the configured media cut. If audio timing differs
  // from generated estimates, duplicate/cycle scenes instead of making one video
  // stay on screen too long.
  const configuredMaxMediaDur = Math.max(2, Number(options.maxMediaDurationSeconds) || 6);
  const normalizeSceneTiming = (baseScenes: LoadedScene[], totalDuration: number): LoadedScene[] => {
    if (baseScenes.length === 0) return [];
    const timed: LoadedScene[] = [];
    let cursor = 0;
    let idx = 0;

    while (cursor < totalDuration - 0.01) {
      const source = baseScenes[idx % baseScenes.length];
      const remaining = totalDuration - cursor;
      const duration = Math.min(remaining, configuredMaxMediaDur);
      timed.push({
        ...source,
        startTime: cursor,
        duration,
        videoStarted: false,
      });
      cursor += duration;
      idx += 1;
    }

    return timed;
  };

  const totalStoredDuration = sortedSceneInputs.reduce((sum, s) => sum + s.duration, 0);
  const maxStoredSceneDuration = Math.max(...sortedSceneInputs.map(s => Number(s.duration) || 0));
  const hasTimingGaps = sortedSceneInputs.some((scene, i) => {
    if (i === 0) return Math.abs(scene.startTime) > 0.01;
    const previous = sortedSceneInputs[i - 1];
    return Math.abs(scene.startTime - (previous.startTime + previous.duration)) > 0.01;
  });
  const lastInput = sortedSceneInputs[sortedSceneInputs.length - 1];
  const lastWouldExceedCap = lastInput ? audioDuration - lastInput.startTime > configuredMaxMediaDur + 0.01 : false;
  const needsRecalc = Math.abs(totalStoredDuration - audioDuration) > 0.25 || maxStoredSceneDuration > configuredMaxMediaDur + 0.01 || hasTimingGaps || lastWouldExceedCap;

  let renderScenes = loadedScenes;
  if (needsRecalc) {
    console.log(`[Render] Recalculating scene timing with ${configuredMaxMediaDur}s cap: stored=${totalStoredDuration.toFixed(1)}s, audio=${audioDuration.toFixed(1)}s`);
    renderScenes = normalizeSceneTiming(loadedScenes, audioDuration);
  }

  // Cover any gaps between scenes
  for (let i = 0; i < renderScenes.length - 1; i++) {
    const gap = renderScenes[i + 1].startTime - (renderScenes[i].startTime + renderScenes[i].duration);
    if (gap > 0.01) renderScenes[i].duration = Math.min(configuredMaxMediaDur, renderScenes[i].duration + gap);
  }

  // Last scene may extend only if it still respects the media-duration cap
  if (renderScenes.length > 0) {
    const last = renderScenes[renderScenes.length - 1];
    const end = last.startTime + last.duration;
    if (end < audioDuration && audioDuration - last.startTime <= configuredMaxMediaDur) last.duration = audioDuration - last.startTime;
  }

  console.log(`[Render] ${renderScenes.length} scenes loaded. Audio: ${audioDuration.toFixed(1)}s`);
  console.log("[Render] Scene timing:", renderScenes.map(s => `${s.startTime.toFixed(1)}-${(s.startTime+s.duration).toFixed(1)}s`).join(", "));

  onProgress(20, "Rendering video...");

  // ── CANVAS + RECORDER ──────────────────────────────────────────────────────
  // Canvas dimensions by format:
  //   Landscape 16:9  → 1920 × 1080  (standard HD)
  //   Portrait  9:16  → 1080 × 1920  (YouTube Shorts — NOT 1920×3413)
  //   Square    1:1   → 1080 × 1080
  // Using 1920×3413 for portrait was a bug: it's 3× heavier than needed
  // and exceeds what YouTube Shorts requires (max 1080×1920).
  const isPortrait = video.format?.includes('9:16');
  const isSquare   = video.format?.includes('1:1');
  const width  = isPortrait ? 1080 : 1920;
  const height = isPortrait ? 1920 : isSquare ? 1080 : 1080;

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

  // Prefer MP4/H.264 — YouTube processes it instantly vs hours for WebM/VP9
  // WebM from MediaRecorder has irregular timestamps that cause YouTube to hang
  const mimeType = MediaRecorder.isTypeSupported("video/mp4; codecs=avc1,mp4a.40.2")
    ? "video/mp4; codecs=avc1,mp4a.40.2"
    : MediaRecorder.isTypeSupported("video/mp4")
    ? "video/mp4"
    : MediaRecorder.isTypeSupported("video/webm; codecs=vp9")
    ? "video/webm; codecs=vp9"
    : MediaRecorder.isTypeSupported("video/webm; codecs=vp8")
    ? "video/webm; codecs=vp8"
    : "video/webm";

  console.log(`[Render] Using codec: ${mimeType}`);

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
          // Cleanup: revoke blob URLs and pause videos to free memory
          loadedScenes.forEach(s => {
            if (s.isVideo) {
              try { (s.element as HTMLVideoElement).pause(); } catch {}
            }
            if (s.blobUrl) {
              try { URL.revokeObjectURL(s.blobUrl); } catch {}
            }
          });
          renderPromise.then(resolve).catch(reject);
          return;
        }

        // Progress update
        onProgress(
          20 + Math.min(80, Math.round((elapsed / audioDuration) * 80)),
          `Rendering ${elapsed.toFixed(1)}s / ${audioDuration.toFixed(1)}s`
        );

        // Find current scene index
        let sceneIdx = renderScenes.findIndex(
          (s) => elapsed >= s.startTime && elapsed < s.startTime + s.duration
        );
        if (sceneIdx === -1) sceneIdx = renderScenes.length - 1;

        const scene = renderScenes[sceneIdx];
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
          const prev = renderScenes[sceneIdx - 1];
          const prevTime = elapsed - prev.startTime;
          const prevProgress = Math.min(1, prevTime / prev.duration);
          drawScene(ctx2d, prev, prevProgress, width, height, 1);
        }

        // Draw current scene. Never fade against the black canvas at the very
        // beginning/end — only fade when another scene exists underneath.
        const fadeInAlpha = sceneIdx > 0 && sceneTime < CROSSFADE ? sceneTime / CROSSFADE : 1;
        const timeLeft = scene.duration - sceneTime;
        const fadeOutAlpha = sceneIdx < renderScenes.length - 1 && timeLeft < CROSSFADE ? timeLeft / CROSSFADE : 1;
        const alpha = Math.min(fadeInAlpha, fadeOutAlpha);

        const drawn = drawScene(ctx2d, scene, sceneProgress, width, height, alpha);

        // If video not ready and no poster fallback was available, try the
        // previous scene (or next, if we're at index 0) to avoid any black frame.
        if (!drawn) {
          const fallback = sceneIdx > 0
            ? renderScenes[sceneIdx - 1]
            : renderScenes[Math.min(sceneIdx + 1, renderScenes.length - 1)];
          if (fallback) drawScene(ctx2d, fallback, 1, width, height, 1);
        }

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
