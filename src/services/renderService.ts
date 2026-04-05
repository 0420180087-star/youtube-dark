import { Video, VisualEffect } from "../types";
import { decodeAudioData } from "./geminiService";

const easeInOutCubic = (x: number): number =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

const drawScanlines = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number
) => {
  ctx.save();
  ctx.globalCompositeOperation = "overlay";
  ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
  const lineY = (time * 100) % height;
  ctx.fillRect(0, lineY, width, 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.1)";
  for (let i = 0; i < height; i += 4) ctx.fillRect(0, i, width, 1);
  ctx.restore();
};

const applyVisualFilter = (
  ctx: CanvasRenderingContext2D,
  filterType: string
) => {
  if (filterType === "saturate") ctx.filter = `saturate(140%) contrast(1.1)`;
  else if (filterType === "bw") ctx.filter = "grayscale(100%) contrast(1.2)";
  else if (filterType === "invert") ctx.filter = "invert(100%)";
  else ctx.filter = "none";
};

const calculateTransform = (
  ctx: CanvasRenderingContext2D,
  effect: VisualEffect,
  rawProgress: number,
  width: number,
  height: number,
  elapsedTime: number
) => {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const progress = easeInOutCubic(rawProgress);
  const centerX = width / 2;
  const centerY = height / 2;

  const shakeX =
    (Math.sin(elapsedTime * 15) + Math.cos(elapsedTime * 42)) * 1.5;
  const shakeY =
    (Math.cos(elapsedTime * 12) + Math.sin(elapsedTime * 35)) * 1.5;
  ctx.translate(shakeX, shakeY);

  if (effect === "zoom-in") {
    const scale = 1 + 0.5 * progress;
    ctx.translate(centerX, centerY);
    ctx.scale(scale, scale);
    ctx.translate(-centerX, -centerY);
  } else if (effect === "pan-right") {
    const scale = 1.4;
    const maxPan = width * 0.25;
    const xOffset = -(maxPan / 2) + maxPan * progress;
    ctx.translate(centerX + xOffset, centerY);
    ctx.scale(scale, scale);
    ctx.translate(-centerX, -centerY);
  } else {
    const scale = 1.5 - 0.5 * progress;
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
};

const loadSceneMedia = async (scene: {
  startTime: number;
  duration: number;
  effect: VisualEffect;
  videoUrl?: string;
  imageUrl: string;
}): Promise<LoadedScene> => {
  // 1. Tenta carregar como vídeo
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
          () => reject(new Error("video timeout")),
          10000
        );
        video.oncanplaythrough = () => {
          clearTimeout(timeout);
          resolve();
        };
        video.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("video error"));
        };
        video.load();
      });

      return {
        startTime: scene.startTime,
        duration: scene.duration,
        effect: scene.effect,
        element: video,
        isVideo: true,
        ready: true,
      };
    } catch {
      console.warn("⚠️ Vídeo falhou, usando imagem de fallback:", scene.videoUrl);
    }
  }

  // 2. Fallback para imagem estática
  const img = new Image();
  img.crossOrigin = "anonymous";

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("image timeout")),
        8000
      );
      img.onload = () => {
        clearTimeout(timeout);
        resolve();
      };
      img.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("image error"));
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
    };
  } catch {
    console.warn("⚠️ Imagem também falhou, usando placeholder:", scene.imageUrl);
  }

  // 3. Placeholder — NUNCA frame preto vazio
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
  };
};

// ─── Desenha um frame de vídeo ou imagem no canvas ───────────────────────────

const drawMediaFrame = (
  ctx: CanvasRenderingContext2D,
  scene: LoadedScene,
  sceneProgress: number,
  elapsed: number,
  width: number,
  height: number
) => {
  ctx.save();

  if (scene.isVideo) {
    const videoEl = scene.element as HTMLVideoElement;
    const targetTime = elapsed - scene.startTime;
    if (Math.abs(videoEl.currentTime - targetTime) > 0.1) {
      videoEl.currentTime = Math.min(targetTime, videoEl.duration - 0.01);
    }
  }

  calculateTransform(ctx, scene.effect, sceneProgress, width, height, elapsed);
  applyVisualFilter(ctx, "saturate");

  const el = scene.element as HTMLImageElement;
  const scale = Math.max(width / el.width, height / el.height);
  const elW = el.width * scale;
  const elH = el.height * scale;
  const x = (width - elW) / 2;
  const y = (height - elH) / 2;

  ctx.drawImage(scene.element, x, y, elW, elH);
  ctx.restore();
};

// ─── Crossfade suave entre cenas ─────────────────────────────────────────────

const CROSSFADE_DURATION = 0.3;

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
      mGain.gain.value = 0.18;

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

  // Cobre gaps entre cenas
  for (let i = 0; i < loadedScenes.length - 1; i++) {
    const current = loadedScenes[i];
    const next = loadedScenes[i + 1];
    const gap = next.startTime - (current.startTime + current.duration);
    if (gap > 0) {
      current.duration += gap;
    }
  }

  // Última cena cobre até o fim do áudio
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
  const ctx2d = canvas.getContext("2d", { alpha: false })!;

  const bgGradient = ctx2d.createLinearGradient(0, 0, width, height);
  bgGradient.addColorStop(0, "#1a1a2e");
  bgGradient.addColorStop(1, "#16213e");
  ctx2d.fillStyle = bgGradient;
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
    videoBitsPerSecond: 8000000,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const renderPromise = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
  });

  recorder.start(100);
  await new Promise((r) => setTimeout(r, 200));
  audioSrc.start(0);

  const startTime = performance.now();
  const duration = finalAudioBuffer.duration;

  // ── LOOP DE RENDERIZAÇÃO ──────────────────────────────────────────────────

  return new Promise((resolve, reject) => {
    let lastScene: LoadedScene | null = null;

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
          try {
            audioSrc.stop();
          } catch {
            // already stopped
          }
          audioCtx.close();
          renderPromise.then(resolve).catch(reject);
          return;
        }

        const currentScene =
          loadedScenes.find(
            (s) => elapsed >= s.startTime && elapsed < s.startTime + s.duration
          ) || loadedScenes[loadedScenes.length - 1];

        const prevScene =
          currentScene !== lastScene && lastScene ? lastScene : null;

        if (currentScene) {
          const sceneTime = elapsed - currentScene.startTime;
          const sceneProgress = Math.min(1, sceneTime / currentScene.duration);

          if (prevScene) {
            const prevSceneTime = elapsed - prevScene.startTime;
            const prevProgress = Math.min(1, prevSceneTime / prevScene.duration);
            ctx2d.globalAlpha = 1;
            drawMediaFrame(ctx2d, prevScene, prevProgress, elapsed, width, height);
          }

          const alpha = getCrossfadeAlpha(currentScene, elapsed);
          ctx2d.globalAlpha = alpha;
          drawMediaFrame(ctx2d, currentScene, sceneProgress, elapsed, width, height);
          ctx2d.globalAlpha = 1;

          lastScene = currentScene;

          drawScanlines(ctx2d, width, height, elapsed);
        }

        requestAnimationFrame(renderLoop);
      } catch (err) {
        reject(err);
      }
    };

    renderLoop();
  });
};
