import { Video, VisualEffect } from "../types";
import { decodeAudioData } from "./geminiService";

const easeInOutCubic = (x: number): number => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

const drawScanlines = (ctx: CanvasRenderingContext2D, width: number, height: number, time: number) => {
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    const lineY = (time * 100) % height;
    ctx.fillRect(0, lineY, width, 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    for(let i=0; i<height; i+=4) ctx.fillRect(0, i, width, 1);
    ctx.restore();
};

const applyVisualFilter = (ctx: CanvasRenderingContext2D, filterType: string) => {
    if (filterType === 'saturate') ctx.filter = `saturate(140%) contrast(1.1)`;
    else if (filterType === 'bw') ctx.filter = 'grayscale(100%) contrast(1.2)';
    else if (filterType === 'invert') ctx.filter = 'invert(100%)';
    else ctx.filter = 'none';
};

const calculateTransform = (
    ctx: CanvasRenderingContext2D, effect: VisualEffect, rawProgress: number, 
    width: number, height: number, elapsedTime: number
) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const progress = easeInOutCubic(rawProgress); 
    const centerX = width / 2;
    const centerY = height / 2;

    const shakeX = (Math.sin(elapsedTime * 15) + Math.cos(elapsedTime * 42)) * 1.5;
    const shakeY = (Math.cos(elapsedTime * 12) + Math.sin(elapsedTime * 35)) * 1.5;
    ctx.translate(shakeX, shakeY);

    if (effect === 'zoom-in') {
        const scale = 1 + (0.5 * progress);
        ctx.translate(centerX, centerY); ctx.scale(scale, scale); ctx.translate(-centerX, -centerY);
    } else if (effect === 'pan-right') {
        const scale = 1.4; 
        const maxPan = width * 0.25; 
        const xOffset = -(maxPan / 2) + (maxPan * progress);
        ctx.translate(centerX + xOffset, centerY); ctx.scale(scale, scale); ctx.translate(-centerX, -centerY);
    } else {
        const scale = 1.5 - (0.5 * progress);
        ctx.translate(centerX, centerY); ctx.scale(scale, scale); ctx.translate(-centerX, -centerY);
    }
};

export const renderVideoHeadless = async (
    video: Video, 
    onProgress: (percent: number, status: string) => void
): Promise<Blob> => {
    if (!video.audioUrl || !video.visualScenes) throw new Error("Missing assets");

    onProgress(1, "Mastering Audio...");
    const sampleRate = 24000;
    const tempCtx = new AudioContext({sampleRate});
    
    const voiceBuffer = await decodeAudioData(new Uint8Array(atob(video.audioUrl).split('').map(c => c.charCodeAt(0))).buffer, tempCtx);
    let finalAudioBuffer = voiceBuffer;

    if (video.backgroundMusicUrl) {
        const musicBuffer = await decodeAudioData(new Uint8Array(atob(video.backgroundMusicUrl).split('').map(c => c.charCodeAt(0))).buffer, tempCtx);
        const offlineCtx = new OfflineAudioContext(1, voiceBuffer.duration * sampleRate, sampleRate);
        
        const vSrc = offlineCtx.createBufferSource(); vSrc.buffer = voiceBuffer; vSrc.connect(offlineCtx.destination); vSrc.start(0);
        
        const mSrc = offlineCtx.createBufferSource(); mSrc.buffer = musicBuffer; mSrc.loop = true; 
        const mGain = offlineCtx.createGain(); mGain.gain.value = 0.3;
        mSrc.connect(mGain); mGain.connect(offlineCtx.destination); mSrc.start(0);

        finalAudioBuffer = await offlineCtx.startRendering();
    }
    tempCtx.close();

    onProgress(10, "Loading Visuals...");
    const width = 1920; 
    const height = video.format?.includes('9:16') ? 3413 : (video.format?.includes('1:1') ? 1920 : 1080);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx2d = canvas.getContext('2d')!;

    const imageBitmaps = await Promise.all(video.visualScenes.map(async (scene) => {
        const img = new Image();
        img.crossOrigin = "anonymous"; 
        img.src = scene.imageUrl;
        await img.decode();
        return { ...scene, bitmap: img };
    }));

    onProgress(20, "Rendering...");
    const audioCtx = new AudioContext({sampleRate});
    const stream = canvas.captureStream(30);
    const audioDest = audioCtx.createMediaStreamDestination();
    const audioSrc = audioCtx.createBufferSource();
    audioSrc.buffer = finalAudioBuffer;
    audioSrc.connect(audioDest);
    stream.addTrack(audioDest.stream.getAudioTracks()[0]);

    const recorder = new MediaRecorder(stream, { 
        mimeType: 'video/webm; codecs=vp9',
        videoBitsPerSecond: 6000000 
    });
    
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    
    const renderPromise = new Promise<Blob>((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    });

    recorder.start();
    audioSrc.start(0);
    
    const startTime = performance.now();
    const duration = finalAudioBuffer.duration;

    return new Promise((resolve, reject) => {
        const renderLoop = () => {
            const elapsed = (performance.now() - startTime) / 1000;
            const progress = Math.min(100, Math.round((elapsed / duration) * 100));
            onProgress(20 + (progress * 0.8), `Rendering frame at ${elapsed.toFixed(1)}s`);

            if (elapsed >= duration + 0.5) { 
                recorder.stop();
                audioSrc.stop();
                audioCtx.close();
                renderPromise.then(resolve);
                return;
            }

            const currentScene = imageBitmaps.find(s => elapsed >= s.startTime && elapsed < (s.startTime + s.duration)) || imageBitmaps[imageBitmaps.length - 1];
            
            if (currentScene) {
                const sceneTime = elapsed - currentScene.startTime;
                const sceneProgress = Math.min(1, sceneTime / currentScene.duration);

                ctx2d.save();
                ctx2d.fillStyle = '#000';
                ctx2d.fillRect(0,0,width,height);
                
                calculateTransform(ctx2d, currentScene.effect, sceneProgress, width, height, elapsed);
                applyVisualFilter(ctx2d, 'saturate');

                const img = currentScene.bitmap;
                const scale = Math.max(width / img.width, height / img.height);
                const imgW = img.width * scale;
                const imgH = img.height * scale;
                const x = (width - imgW) / 2;
                const y = (height - imgH) / 2;
                
                ctx2d.drawImage(img, x, y, imgW, imgH);
                ctx2d.restore();
                
                drawScanlines(ctx2d, width, height, elapsed);
            }
            requestAnimationFrame(renderLoop);
        };
        renderLoop();
    });
};
