import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useParams, Link } from 'react-router-dom';
import { useProjects } from '../context/ProjectContext';
import { useAuth } from '../context/AuthContext';
import { ProjectStatus, VisualScene, VisualEffect } from '../types';
import { 
    generateVideoScript, generateVoiceover, generateSceneImage, 
    generateDarkAmbience, decodeAudioData, mergeAudioBuffers, 
    audioBufferToBase64, generateThumbnail, generateVideoMetadata,
    generateSingleNarratorText, generateMissingNarratorTexts,
    generateThumbnailHook, clearExhaustedKeys
} from '../services/geminiService';
import { searchContextualMedia } from '../services/pexelsService';
import { uploadVideoToYouTube } from '../services/youtubeService';
import { 
  FileText, Mic, Image as ImageIcon, Upload, Loader2, Play, CheckCircle, 
  Youtube, Film, ChevronRight, Wand2, RefreshCw, ArrowLeft, 
  Music, Download, Type, Volume2, VolumeX, Sliders, Activity, 
  LayoutTemplate, Sparkles, Clock, AlignLeft, Eye, Pause, RotateCcw, X, Settings, ArrowRight, Zap, Calendar, FileVideo, Video, Maximize2, Hash, Tag, ExternalLink, Copy, AlertTriangle, AlertCircle, HelpCircle, Shield, Globe, Check
} from 'lucide-react';

const steps = [
  { id: 'script', label: 'Script', icon: FileText, desc: 'Narrative' },
  { id: 'audio', label: 'Voice', icon: Mic, desc: 'Synthesis' },
  { id: 'video', label: 'Visuals', icon: ImageIcon, desc: 'Imagery' },
  { id: 'studio', label: 'Studio', icon: Film, desc: 'Preview' },
  { id: 'publish', label: 'Publish', icon: Upload, desc: 'Upload' },
];

const ANIMATION_EFFECTS: VisualEffect[] = [
    'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 
    'zoom-in-fast', 'crash-zoom', 'ken-burns-extreme',
    'handheld', 'vertigo', 'pulse-beat',
    'whip-pan-left', 'whip-pan-right', 'zoom-punch', 'speed-ramp',
    'hyperlapse', 'slow-motion'
];

const YOUTUBE_CATEGORIES = [
    { id: '24', name: 'Entertainment' },
    { id: '1', name: 'Film & Animation' },
    { id: '10', name: 'Music' },
    { id: '20', name: 'Gaming' },
    { id: '22', name: 'People & Blogs' },
    { id: '25', name: 'News & Politics' },
    { id: '26', name: 'Howto & Style' },
    { id: '27', name: 'Education' },
    { id: '28', name: 'Science & Technology' },
    { id: '17', name: 'Sports' },
    { id: '19', name: 'Travel & Events' },
];

// Improved Easing Functions for Snappy Movements
const easeInOutCubic = (x: number): number => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const easeOutExpo = (x: number): number => x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
// Elastic for Pulse
const easeElastic = (x: number): number => {
    const c4 = (2 * Math.PI) / 3;
    return x === 0 ? 0 : x === 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1;
};

// --- RENDER ENGINE HELPERS ---

// Applies filters like Grayscale, High Contrast, etc. for visual variety
const applyVisualFilter = (
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, 
    filterType: 'none' | 'bw' | 'high-contrast' | 'sepia' | 'saturate',
    intensity: number = 1
) => {
    if (filterType === 'none') {
        ctx.filter = 'none';
        return;
    }
    
    // Dopamine styling: High Saturation helps retention
    if (filterType === 'saturate') {
        ctx.filter = `saturate(${100 + (intensity * 100)}%) contrast(1.1)`;
    } else if (filterType === 'bw') {
        ctx.filter = 'grayscale(100%) contrast(1.2)';
    } else if (filterType === 'high-contrast') {
        ctx.filter = 'contrast(1.5) saturate(1.2)';
    } else if (filterType === 'sepia') {
        ctx.filter = 'sepia(0.8) contrast(1.1)';
    }
};

// Simulates Film Scanlines (Overlay)
const drawScanlines = (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, width: number, height: number, time: number) => {
    const isVideo = !!(ctx as any)._isDrawingVideo;
    if (isVideo) return; // Skip scanlines for stock videos to preserve quality

    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.15)'; // Subtler
    // Moving scanline
    const lineY = (time * 100) % height;
    ctx.fillRect(0, lineY, width, 1); // Thinner
    // Static Grid
    ctx.fillStyle = 'rgba(0, 0, 0, 0.05)'; // Subtler
    for(let i=0; i<height; i+=8) { // Wider gap
        ctx.fillRect(0, i, width, 1);
    }
    ctx.restore();
};

// Helper to draw effects on canvas (Used by both Studio Player and Renderer)
const calculateTransform = (
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, 
    effect: VisualEffect, 
    rawProgress: number, 
    width: number, 
    height: number,
    beatImpulse: number = 0,
    elapsedTime: number = 0
) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset
    
    const centerX = width / 2;
    const centerY = height / 2;

    // Static transform: just a slight scale to ensure full coverage, no movement
    const scale = 1.05; 
    ctx.translate(centerX, centerY); 
    ctx.scale(scale, scale); 
    ctx.translate(-centerX, -centerY);
};

const VOICE_OPTIONS = [
    { id: 'Fenrir', label: 'Brutus (Masculino - Voz Profunda & Grave)' },
    { id: 'Charon', label: 'César (Masculino - Narrador Sério)' },
    { id: 'Puck', label: 'Felipe (Masculino - Neutro & Explicativo)' },
    { id: 'Zephyr', label: 'André (Masculino - Rápido & Jornalístico)' },
    { id: 'Kore', label: 'Clara (Feminino - Suave & Misteriosa)' },
    { id: 'Aoede', label: 'Luna (Feminino - Infantil & Animada)' }, // Alias for Kids tone
    { id: 'Leda', label: 'Sofia (Feminino - Acolhedora & Storyteller)' }
];

const TONE_OPTIONS = [
    'Wendover Productions Style (Educational)', 'Suspenseful & Dark (Horror)', 'Children\'s Story (Kids/Fairy Tale)', 'True Crime Analysis (Serious)', 'Educational & Explanatory (Clear)', 'Documentary Style (Formal)',
    'Fast-paced Facts (Viral/Shorts)', 'Enthusiastic Vlog (Personal)', 'Calm & Cozy (ASMR/Relax)', 'Motivational & Energetic (Coach)',
    'Tech Reviewer (Crisp & Critical)', 'High-Energy Gaming (Loud)', 'Professional Business (Corporate)', 'Urban Legend Storyteller (Folklore)'
];

const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const EmptyState: React.FC<{ icon: React.ElementType; title: string; description: string; actionLabel: string; onClick: () => void; isLoading?: boolean; }> = ({ icon: Icon, title, description, actionLabel, onClick, isLoading }) => {
    return (
        <div className="flex flex-col items-center justify-center text-center p-12">
            <div className="w-24 h-24 bg-white/5 rounded-full flex items-center justify-center mb-6 border border-white/10 shadow-inner group">
                <Icon className="w-10 h-10 text-slate-500 group-hover:text-orange-400 transition-colors" />
            </div>
            <h3 className="text-2xl font-bold text-white mb-3">{title}</h3>
            <p className="text-slate-400 max-w-md mb-8 leading-relaxed text-base">{description}</p>
            <button onClick={onClick} disabled={isLoading} className="bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white px-8 py-4 rounded-xl font-bold shadow-[0_0_20px_rgba(249,115,22,0.3)] transition-all hover:scale-105 flex items-center gap-2 active:scale-95">
                {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Wand2 className="w-5 h-5" />}
                {isLoading ? 'Processing...' : actionLabel}
            </button>
        </div>
    );
};

export const ProjectEditor: React.FC = () => {
  const { projectId, videoId } = useParams<{ projectId: string; videoId: string }>();
  const { getProject, getVideo, updateVideo, updateProject } = useProjects();
  const { googleClientId } = useAuth();
  
  const project = getProject(projectId || '');
  const video = getVideo(projectId || '', videoId || '');
  
  const [activeTab, setActiveTab] = useState(() => {
    if (!video) return 'script';
    if (video.visualScenes && video.visualScenes.length > 0) return 'studio'; 
    if (video.status === ProjectStatus.AUDIO_GENERATED) return 'video';
    if (video.status === ProjectStatus.SCRIPTING) return 'audio';
    return 'script';
  });
  
  // State
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [isGeneratingScript, setIsGeneratingScript] = useState(false);
  const [scriptTone, setScriptTone] = useState(project?.defaultTone || 'Suspenseful and Dark');
  const [scriptContext, setScriptContext] = useState(video?.specificContext || '');
  const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);
  const [generatingAudioIndex, setGeneratingAudioIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState(project?.defaultVoice || 'Fenrir');
  const [isPreviewingVoice, setIsPreviewingVoice] = useState(false);
  const [previewingSegmentAudio, setPreviewingSegmentAudio] = useState<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const [isGeneratingVisuals, setIsGeneratingVisuals] = useState(false);
  const [generatingIndex, setGeneratingIndex] = useState<number | null>(null);
  const [generatingNarratorIndex, setGeneratingNarratorIndex] = useState<number | null>(null);
  const [isAutoFillingNarrator, setIsAutoFillingNarrator] = useState(false);
  const [lastValidImage, setLastValidImage] = useState<string | null>(null);
  const [isGeneratingMusic, setIsGeneratingMusic] = useState(false);
  const [musicVolume, setMusicVolume] = useState(0.4);
  const [isMusicEnabled, setIsMusicEnabled] = useState(true);
  const bgMusicGainNodeRef = useRef<GainNode | null>(null);
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(0);
  const [currentSceneIndex, setCurrentSceneIndex] = useState(0);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [totalDurationState, setTotalDurationState] = useState(0);
  const animationFrameRef = useRef<number>(0);
  const [isGeneratingThumbnail, setIsGeneratingThumbnail] = useState(false);
  const [isGeneratingMetadata, setIsGeneratingMetadata] = useState(false);
  const studioCanvasRef = useRef<HTMLCanvasElement>(null);
  const [preloadedImages, setPreloadedImages] = useState<Map<string, HTMLImageElement>>(new Map());
  const [preloadedVideos, setPreloadedVideos] = useState<Map<string, HTMLVideoElement>>(new Map());
  
  // Rendering State
  const [isRenderingVideo, setIsRenderingVideo] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderStatus, setRenderStatus] = useState('');
  
  const [scheduledDate, setScheduledDate] = useState(video?.scheduledDate || '');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0); // NEW: Upload Progress
  const [showCorsHelp, setShowCorsHelp] = useState(false);
  const [showTroubleshooting, setShowTroubleshooting] = useState(false);
  const [showThumbnailTroubleshooting, setShowThumbnailTroubleshooting] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState<{videoId: string, url: string} | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [thumbnailError, setThumbnailError] = useState<string | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [generatedVideoBlob, setGeneratedVideoBlob] = useState<Blob | null>(null);
  const [generatedVideoUrl, setGeneratedVideoUrl] = useState<string | null>(null);

  // ... (Effects) ...
  useEffect(() => {
    if (bgMusicGainNodeRef.current && audioContextRef.current) {
        bgMusicGainNodeRef.current.gain.setTargetAtTime(isMusicEnabled ? musicVolume : 0, audioContextRef.current.currentTime, 0.1);
    }
  }, [musicVolume, isMusicEnabled]);

  useEffect(() => { return () => stopPlayback(); }, []);

  useEffect(() => {
    if (!video) return;
    const activeScene = video.visualScenes?.[currentSceneIndex];
    if (activeScene?.imageUrl) setLastValidImage(activeScene.imageUrl);
  }, [currentSceneIndex, video?.visualScenes]);

  useEffect(() => { return () => { if (generatedVideoUrl) URL.revokeObjectURL(generatedVideoUrl); }; }, []);

  // Preload images and videos for Studio Preview
  useEffect(() => {
    if (!video?.visualScenes) return;
    
    const loadAssets = async () => {
        if (!video?.visualScenes) return;
        const newImgMap = new Map<string, HTMLImageElement>();
        const newVidMap = new Map<string, HTMLVideoElement>();
        
        await Promise.all(video.visualScenes.map(async (scene) => {
            // Load Image
            if (!newImgMap.has(scene.imageUrl)) {
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.src = scene.imageUrl;
                try {
                    await img.decode();
                    newImgMap.set(scene.imageUrl, img);
                } catch (e) {
                    console.warn("Failed to preload image", scene.imageUrl);
                }
            }
            
            // Load Video if exists
            if (scene.videoUrl && !newVidMap.has(scene.videoUrl)) {
                const vid = document.createElement('video');
                vid.crossOrigin = "anonymous";
                vid.src = scene.videoUrl;
                vid.muted = true;
                vid.loop = true;
                vid.playsInline = true;
                vid.load();
                newVidMap.set(scene.videoUrl, vid);
            }
        }));
        
        setPreloadedImages(newImgMap);
        setPreloadedVideos(newVidMap);
    };
    
    loadAssets().catch(console.error);
  }, [video?.visualScenes]);

  useEffect(() => {
    if (!video || !video.visualScenes || isPlaying) return;
    
    const canvas = studioCanvasRef.current;
    const activeScene = video.visualScenes[currentSceneIndex];
    const img = preloadedImages.get(activeScene?.imageUrl);
    const vid = activeScene?.videoUrl ? preloadedVideos.get(activeScene.videoUrl) : null;
    
    if (canvas && (img || vid)) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
            const width = canvas.width;
            const height = canvas.height;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, width, height);
            
            const source = vid || img;
            if (source) {
                const sWidth = (source as any).videoWidth || (source as any).width;
                const sHeight = (source as any).videoHeight || (source as any).height;
                const scale = Math.max(width / sWidth, height / sHeight);
                const drawW = sWidth * scale;
                const drawH = sHeight * scale;
                const x = (width - drawW) / 2;
                const y = (height - drawH) / 2;
                ctx.drawImage(source as any, x, y, drawW, drawH);
            }
            
            // Vignette
            const gradient = ctx.createRadialGradient(width/2, height/2, width/3, width/2, height/2, width);
            gradient.addColorStop(0, 'rgba(0,0,0,0)');
            gradient.addColorStop(1, 'rgba(0,0,0,0.6)');
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, width, height);
        }
    }
  }, [video, currentSceneIndex, preloadedImages, preloadedVideos, isPlaying]);

  // --- HANDLERS ---
  const handleGenerateScript = async () => { 
    setIsConfigModalOpen(false); 
    setIsGeneratingScript(true); 
    try { 
      const libraryContext = project?.library?.map(item => `[${item.type?.toUpperCase() || 'INFO'}] ${item.title}: ${item.content}`).join('\n') || ''; 
      const script = await generateVideoScript({ 
        topic: video!.title, 
        channelTheme: project!.channelTheme, 
        targetDuration: video!.targetDuration, 
        tone: scriptTone, 
        additionalContext: scriptContext, 
        language: project!.language, 
        libraryContext,
        visualPacing: project!.visualPacing
      }); 
      updateVideo(project!.id, video!.id, { script, status: ProjectStatus.SCRIPTING }); 
    } catch (e:any) { 
      alert(e.message); 
    } finally { 
      setIsGeneratingScript(false); 
    } 
  };
  const handleUpdateScriptSegment = (index: number, newText: string) => { const updated = [...video!.script!.segments]; updated[index].narratorText = newText; updateVideo(project!.id, video!.id, { script: { ...video!.script!, segments: updated } }); };
  
  const handleGenerateSingleNarrator = async (index: number) => {
    if (generatingNarratorIndex !== null) return;
    setGeneratingNarratorIndex(index);
    try {
      const segment = video!.script!.segments[index];
      const text = await generateSingleNarratorText(
        video!.title,
        segment.sectionTitle,
        segment.visualDescriptions,
        scriptTone,
        project!.language
      );
      handleUpdateScriptSegment(index, text);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setGeneratingNarratorIndex(null);
    }
  };

  const handleAutoFillNarrator = async () => {
    if (isAutoFillingNarrator || !video?.script?.segments) return;
    setIsAutoFillingNarrator(true);
    try {
      const updatedSegments = await generateMissingNarratorTexts(
        video.title,
        video.script.segments,
        scriptTone,
        project!.language
      );
      updateVideo(project!.id, video.id, {
        script: { ...video.script, segments: updatedSegments }
      });
    } catch (e: any) {
      alert(e.message);
    } finally {
      setIsAutoFillingNarrator(false);
    }
  };

  const handlePreviewVoice = async () => { if(isPreviewingVoice) return; setIsPreviewingVoice(true); try { const b = await generateVoiceover("Preview.", selectedVoice, scriptTone); const ctx = new AudioContext({sampleRate:24000}); const ab = await decodeAudioData(b,ctx); const s = ctx.createBufferSource(); s.buffer=ab; s.connect(ctx.destination); s.start(0); s.onended=()=>{setIsPreviewingVoice(false); ctx.close();}; } catch(e){setIsPreviewingVoice(false);} };
  const handlePreviewSegment = async (idx:number, txt:string) => { if(previewingSegmentAudio!==null) return; setPreviewingSegmentAudio(idx); try { const b = await generateVoiceover(txt, selectedVoice, scriptTone); const ctx = new AudioContext({sampleRate:24000}); const ab = await decodeAudioData(b,ctx); const s = ctx.createBufferSource(); s.buffer=ab; s.connect(ctx.destination); s.start(0); s.onended=()=>{setPreviewingSegmentAudio(null); ctx.close();}; } catch(e){setPreviewingSegmentAudio(null);} };
  const handleGenerateAudio = async () => {
      setIsConfigModalOpen(false);
      setIsGeneratingAudio(true);
      const b: AudioBuffer[] = [];
      const ts = [0];
      let dur = 0;
      const ctx = new AudioContext({ sampleRate: 24000 });
      try {
          for (let i = 0; i < video!.script!.segments.length; i++) {
              setGeneratingAudioIndex(i);
              const s = video!.script!.segments[i];
              const buf = await generateVoiceover(s.narratorText || s.sectionTitle, selectedVoice, scriptTone);
              const ab = await decodeAudioData(buf, ctx);
              b.push(ab);
              dur += ab.duration;
              ts.push(dur); // ts will be [start0, end0, end1, ..., endN]
          }
          const fb = mergeAudioBuffers(b, ctx);
          updateVideo(project!.id, video!.id, { 
              status: ProjectStatus.AUDIO_GENERATED, 
              audioUrl: audioBufferToBase64(fb), 
              segmentTimestamps: ts 
          });
          setActiveTab('video');
      } catch (e: any) {
          alert(e.message);
      } finally {
          setIsGeneratingAudio(false);
          setGeneratingAudioIndex(null);
          ctx.close();
      }
  };
  const handleGenerateMusic = async () => { 
      setIsGeneratingMusic(true); 
      try { 
          const m = await generateDarkAmbience(video?.script?.ambientMusicDescription || scriptTone); 
          updateVideo(project!.id, video!.id, { backgroundMusicUrl: m }); 
      } catch(e){
          console.error(e);
      } finally { 
          setIsGeneratingMusic(false); 
      } 
  };
  
  const handleGenerateAllVisuals = async (force: boolean = false) => { 
      setIsGeneratingVisuals(true); 
      let scenes = (video!.visualScenes && !force) ? [...video!.visualScenes] : []; 
      
      if (force) {
          // Clear existing scenes if forcing
          updateVideo(project!.id, video!.id, { visualScenes: [] });
          scenes = [];
      }

      const pexelsUsedIds = new Set<number>();
      try { 
          const segs = video!.script!.segments; 
          let totDur = 0; 
          
          if (video!.audioUrl) { 
              const c = new AudioContext({sampleRate: 24000}); 
              const b = await decodeAudioData(new Uint8Array(atob(video!.audioUrl).split('').map(c => c.charCodeAt(0))).buffer, c); 
              totDur = b.duration; 
              c.close(); 
          } else {
              totDur = segs.reduce((a, b) => a + b.estimatedDuration, 0); 
          }
          
          const starts = video!.segmentTimestamps || segs.map((_, i) => i * (totDur / segs.length)); 
          
          for (let i = 0; i < segs.length; i++) { 
              const start = starts[i]; 
              const end = (starts[i + 1] !== undefined) ? starts[i + 1] : (video!.segmentTimestamps ? starts[i] + segs[i].estimatedDuration : totDur); 
              const totalSegmentDur = Math.max(1, end - start); 

              setGeneratingIndex(i); 
              setCurrentSegmentIndex(i); 
              
              const s = segs[i]; 
              const prompts = s.visualDescriptions || [];
              
              // Randomly divide duration among prompts for "dopamine release" quick cuts
              const weights = prompts.map(() => 0.5 + Math.random());
              const totalWeight = weights.reduce((a, b) => a + b, 0);
              const sceneDurations = weights.map(w => (w / totalWeight) * totalSegmentDur);
              
              let currentSceneStart = start;

              for (let j = 0; j < prompts.length; j++) {
                  const prompt = prompts[j];
                  const dur = sceneDurations[j];

                  // Check if we already have this specific scene
                  const existingScene = scenes.find(sc => sc.segmentIndex === i && sc.prompt === prompt);
                  if (existingScene && !force) {
                      currentSceneStart += dur;
                      continue;
                  }

                  // Slow down the loop significantly to prevent 429 Quota errors on Image Models
                  if (i > 0 || j > 0) await new Promise(r => setTimeout(r, 6000));
                  
                  let url = '';
                  let videoUrl = undefined;

                  // Try to get a stock video first to save Gemini API quota
                  const pexelsChance = (project?.visualSourceMix?.pexelsPercentage || 50) / 100;

                  if (Math.random() < pexelsChance) {
                      const pexelsResult = await searchContextualMedia(
                        s.narratorText || prompt,
                        s.sectionTitle || `Section ${i}`,
                        scriptTone,
                        project?.channelTheme || '',
                        pexelsUsedIds,
                        video!.format || 'Landscape 16:9'
                      );
                      if (pexelsResult) {
                          videoUrl = pexelsResult.videoUrl;
                          url = pexelsResult.thumbnailUrl;
                      }
                  }

                  if (!url) {
                      // Fallback to Gemini Image Generation if no stock video found or chosen
                      url = await generateSceneImage(prompt, scriptTone, video!.format || 'Landscape 16:9'); 
                  }
                  
                  setLastValidImage(url); 
                  
                  // Filter out any existing scene for this specific prompt to avoid duplicates
                  scenes = scenes.filter(sc => !(sc.segmentIndex === i && sc.prompt === prompt));

                  scenes.push({ 
                      segmentIndex: i, 
                      imageUrl: url, 
                      videoUrl: videoUrl,
                      videoOffset: videoUrl ? Math.random() * 10 : 0, // Random start point for stock videos
                      prompt: prompt, 
                      effect: ANIMATION_EFFECTS[Math.floor(Math.random() * ANIMATION_EFFECTS.length)], 
                      startTime: currentSceneStart, 
                      duration: dur 
                  }); 
                  
                  currentSceneStart += dur;
                  scenes.sort((a, b) => a.startTime - b.startTime); 
                  updateVideo(project!.id, video!.id, { visualScenes: scenes, status: (i === segs.length - 1 && j === prompts.length - 1) ? ProjectStatus.VIDEO_GENERATED : ProjectStatus.SCRIPTING }); 
              }
          } 
          setActiveTab('studio');
      } catch (e: any) { alert(e.message); } finally { setIsGeneratingVisuals(false); setGeneratingIndex(null); } 
  };

  // --- NEW: RENDER & DOWNLOAD LOGIC ---
  const handleRenderAndDownload = async (autoDownload: boolean = true) => {
      if (!video || !video.audioUrl || !video.visualScenes) return;
      setIsRenderingVideo(true);
      setRenderProgress(0);
      setRenderStatus('Preparing assets...');

      try {
          // 1. Prepare Audio (Offline Mixing)
          setRenderStatus('Mastering Audio...');
          const sampleRate = 24000;
          const tempCtx = new AudioContext({sampleRate});
          const voiceBuffer = await decodeAudioData(new Uint8Array(atob(video.audioUrl).split('').map(c => c.charCodeAt(0))).buffer, tempCtx);
          let finalAudioBuffer = voiceBuffer;

          // Mix Voice + Music if enabled
          if (video.backgroundMusicUrl && isMusicEnabled) {
              const musicBuffer = await decodeAudioData(new Uint8Array(atob(video.backgroundMusicUrl).split('').map(c => c.charCodeAt(0))).buffer, tempCtx);
              
              // Use OfflineAudioContext for mixing
              const duration = voiceBuffer.duration;
              const offlineCtx = new OfflineAudioContext(1, duration * sampleRate, sampleRate);
              
              // Voice Source
              const vSrc = offlineCtx.createBufferSource(); 
              vSrc.buffer = voiceBuffer; 
              vSrc.connect(offlineCtx.destination); 
              vSrc.start(0);
              
              // Music Source (Looped & Lower Volume)
              const mSrc = offlineCtx.createBufferSource(); 
              mSrc.buffer = musicBuffer; 
              mSrc.loop = true; 
              const mGain = offlineCtx.createGain(); 
              mGain.gain.value = musicVolume * 0.7; // Slightly reduce background for mix
              mSrc.connect(mGain); 
              mGain.connect(offlineCtx.destination); 
              mSrc.start(0);

              finalAudioBuffer = await offlineCtx.startRendering();
          }
          tempCtx.close();

          // 2. Prepare Canvas
          setRenderStatus('Loading Visuals...');
          const width = 1920; 
          const height = video.format?.includes('9:16') ? 3413 : (video.format?.includes('1:1') ? 1920 : 1080);
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx2d = canvas.getContext('2d')!;

          // Preload Images and Videos
          const assetBitmaps = await Promise.all(video.visualScenes.map(async (scene) => {
              const img = new Image();
              img.crossOrigin = "anonymous"; 
              img.src = scene.imageUrl;
              await img.decode();
              
              let vid: HTMLVideoElement | null = null;
              if (scene.videoUrl) {
                  vid = document.createElement('video');
                  vid.crossOrigin = "anonymous";
                  vid.src = scene.videoUrl;
                  vid.muted = true;
                  vid.playsInline = true;
                  await new Promise((resolve) => {
                      if (vid) {
                          vid.onloadeddata = resolve;
                          vid.onerror = resolve; // Continue even if video fails
                          vid.load();
                      } else {
                          resolve(null);
                      }
                  });
              }
              
              return { ...scene, bitmap: img, videoElement: vid };
          }));

          // 3. Setup Media Recorder with REAL-TIME AudioContext
          setRenderStatus('Rendering Video...');
          
          // CRITICAL: AudioContext for recording must be active
          const audioCtx = new AudioContext({sampleRate});
          if (audioCtx.state === 'suspended') {
              await audioCtx.resume();
          }

          const stream = canvas.captureStream(30); // 30 FPS
          const audioDest = audioCtx.createMediaStreamDestination();
          const audioSrc = audioCtx.createBufferSource();
          audioSrc.buffer = finalAudioBuffer;
          audioSrc.connect(audioDest);
          
          // Add audio track to stream
          const audioTrack = audioDest.stream.getAudioTracks()[0];
          stream.addTrack(audioTrack);

          const recorder = new MediaRecorder(stream, { 
              mimeType: 'video/webm; codecs=vp9',
              audioBitsPerSecond: 128000,
              videoBitsPerSecond: 25000000 
          });
          
          const chunks: Blob[] = [];
          recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
          
          const renderPromise = new Promise<Blob>((resolve) => {
              recorder.onstop = () => {
                  const blob = new Blob(chunks, { type: 'video/webm' });
                  resolve(blob);
              };
          });

          // 4. Start Real-time Render
          recorder.start();
          audioSrc.start(0);
          
          const startTime = performance.now();
          const duration = finalAudioBuffer.duration;

          const renderLoop = () => {
              const elapsed = (performance.now() - startTime) / 1000;
              setRenderProgress(Math.min(100, Math.round((elapsed / duration) * 100)));

              if (elapsed >= duration + 0.5) { 
                  recorder.stop();
                  audioSrc.stop();
                  return;
              }

              // Find active scene
              const currentSceneIdx = assetBitmaps.findIndex(s => elapsed >= s.startTime && elapsed < (s.startTime + s.duration));
              const currentScene = currentSceneIdx !== -1 ? assetBitmaps[currentSceneIdx] : assetBitmaps[assetBitmaps.length - 1];
              
              if (currentScene) {
                  // Cross-fade logic
                  const nextScene = assetBitmaps[currentSceneIdx + 1];
                  const transitionDuration = 0.4; // 0.4s crossfade
                  const timeToNext = currentScene.startTime + currentScene.duration - elapsed;
                  
                  const drawScene = (scene: any, alpha: number) => {
                      const sceneTime = elapsed - scene.startTime;
                      const sceneProgress = Math.min(1, sceneTime / scene.duration);
                      
                      const vid = scene.videoElement;
                      if (vid) {
                          const offset = scene.videoOffset || 0;
                          vid.currentTime = (offset + sceneTime) % vid.duration;
                      }

                      let visualFilter: any = 'none';
                      let subEffect = scene.effect;
                      let mirror = false;
                      
                      ctx2d.save();
                      (ctx2d as any)._isDrawingVideo = !!vid;
                      ctx2d.globalAlpha = alpha;
                      calculateTransform(ctx2d, subEffect, sceneProgress, width, height, 0, elapsed);
                      applyVisualFilter(ctx2d, visualFilter);
                      
                      const source = vid || scene.bitmap;
                      const sWidth = source.videoWidth || source.width;
                      const sHeight = source.videoHeight || source.height;
                      const scale = Math.max(width / sWidth, height / sHeight);
                      const drawW = sWidth * scale;
                      const drawH = sHeight * scale;
                      const x = (width - drawW) / 2;
                      const y = (height - drawH) / 2;
                      
                      ctx2d.drawImage(source, x, y, drawW, drawH);
                      
                      ctx2d.restore();
                  };

                  // Clear
                  ctx2d.filter = 'none';
                  ctx2d.globalCompositeOperation = 'source-over';
                  ctx2d.fillStyle = '#000';
                  ctx2d.fillRect(0, 0, width, height);

                  if (nextScene && timeToNext < transitionDuration) {
                      const nextAlpha = 1 - (timeToNext / transitionDuration);
                      drawScene(currentScene, 1);
                      drawScene(nextScene, nextAlpha);
                  } else {
                      drawScene(currentScene, 1);
                  }
                  
                  // Post-processing
                  const isVideoActive = !!(ctx2d as any)._isDrawingVideo;
                  if (!isVideoActive) {
                      drawScanlines(ctx2d, width, height, elapsed);
                  }
                  
                  const vignettePulse = isVideoActive ? 0.3 : (0.6 + (Math.sin(elapsed * 4) * 0.15)); 
                  const gradient = ctx2d.createRadialGradient(width/2, height/2, width/4, width/2, height/2, width);
                  gradient.addColorStop(0, 'rgba(0,0,0,0)');
                  gradient.addColorStop(1, `rgba(0,0,0,${vignettePulse})`);
                  ctx2d.fillStyle = gradient;
                  ctx2d.fillRect(0, 0, width, height);
              }

              requestAnimationFrame(renderLoop);
          };

          renderLoop();

          // Wait for render
          const blob = await renderPromise;
          const url = URL.createObjectURL(blob);
          setGeneratedVideoBlob(blob);
          setGeneratedVideoUrl(url);
          setVideoFile(new File([blob], `${video.title}.webm`, { type: 'video/webm' }));
          
          // Auto-download
          if (autoDownload) {
              const a = document.createElement('a');
              a.href = url;
              a.download = `${video.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.webm`;
              a.click();
          }

          setRenderStatus('Complete!');
          audioCtx.close();
          return blob;

      } catch (e: any) {
          console.error("Render error", e);
          setRenderStatus('Error: ' + e.message);
      } finally {
          setIsRenderingVideo(false);
      }
  };

  const handleRealUpload = async () => {
      if (!project?.youtubeChannelData || !project?.youtubeAccessToken) {
          alert("Por favor, conecte um canal YouTube neste projeto primeiro (aba Settings).");
          return;
      }

      if (!video || !project) {
          alert("Vídeo ou projeto não encontrado.");
          return;
      }
      
      let fileToUpload = videoFile;
      if (!fileToUpload && generatedVideoBlob) {
          fileToUpload = new File([generatedVideoBlob], `${video.title || 'video'}.webm`, { type: 'video/webm' });
      }

      // If no file, trigger render automatically
      if (!fileToUpload) {
          setRenderStatus('Renderizando vídeo automaticamente…');
          try {
              const blob = await handleRenderAndDownload(false);
              if (blob) {
                  fileToUpload = new File([blob], `${video.title || 'video'}.webm`, { type: 'video/webm' });
              }
          } catch (renderErr: any) {
              alert(`Erro ao renderizar vídeo: ${renderErr.message}`);
              return;
          }
      }

      if (!fileToUpload) {
          alert("Não foi possível gerar o vídeo para upload. Verifique se o roteiro e áudio estão prontos.");
          return;
      }

      if (fileToUpload.size === 0) {
          alert("O arquivo de vídeo está vazio. Tente renderizar novamente.");
          return;
      }
      
      setIsUploading(true);
      setUploadProgress(0);
      setUploadError(null);
      setRenderStatus('Preparando upload…');

      try {
          // Ensure metadata exists
          let currentMetadata = video.videoMetadata;
          if (!currentMetadata) {
              setRenderStatus('Gerando metadados…');
              const summary = video.script?.segments.slice(0, 3).map(s => s.narratorText).join(" ") || "";
              currentMetadata = await generateVideoMetadata(video.title, summary, scriptTone, project.language, video.script?.segments || [], video.script, project.channelTheme);
              updateVideo(project.id, video.id, { videoMetadata: currentMetadata });
          }

          // Validation & cleanup
          if (currentMetadata.youtubeTitle.length > 100) {
              currentMetadata = { ...currentMetadata, youtubeTitle: currentMetadata.youtubeTitle.substring(0, 100) };
          }
          if (currentMetadata.youtubeDescription.length > 5000) {
              currentMetadata = { ...currentMetadata, youtubeDescription: currentMetadata.youtubeDescription.substring(0, 5000) };
          }

          // Force isShorts if format is Portrait
          if (video.format === 'Portrait 9:16 (Shorts)' && !currentMetadata.isShorts) {
              currentMetadata = { ...currentMetadata, isShorts: true };
          }

          setRenderStatus('Enviando para o YouTube…');

          const videoId = await uploadVideoToYouTube(
              project.youtubeAccessToken!,
              fileToUpload,
              currentMetadata,
              video.thumbnailUrl,
              scheduledDate || undefined,
              (progress) => {
                  setUploadProgress(progress);
                  if (progress < 5) setRenderStatus('Iniciando upload…');
                  else if (progress < 90) setRenderStatus(`Enviando… ${progress}%`);
                  else if (progress < 100) setRenderStatus('Finalizando…');
                  else setRenderStatus('Upload completo!');
              }
          );
          
          const youtubeUrl = `https://youtu.be/${videoId}`;
          updateVideo(project.id, video.id, { 
              status: scheduledDate ? ProjectStatus.SCHEDULED : ProjectStatus.PUBLISHED,
              youtubeUrl: youtubeUrl
          });
          
          setShowSuccessModal({ videoId, url: youtubeUrl });
          setRenderStatus('Publicado com sucesso!');
      } catch (e: any) {
          console.error("[YouTube Upload] Error:", e);
          const msg = e.message || "Erro desconhecido durante o upload.";
          
          if (msg.includes('401') || msg.includes('Token expirou') || msg.includes('Token expirado')) {
              setUploadError("Sua sessão do YouTube expirou. Vá em Configurações → desconecte e reconecte seu canal.");
          } else if (msg.includes('CORS') || msg.includes('conexão') || msg.includes('Failed to fetch')) {
              setShowCorsHelp(true);
          } else {
              setUploadError(msg);
          }
      } finally {
          setIsUploading(false);
          setUploadProgress(0);
      }
  };

  const stopPlayback = () => { 
      if (audioContextRef.current) {
          try { audioContextRef.current.close().catch(() => {}); } catch(e) {}
      }
      audioContextRef.current = null;
      bgMusicGainNodeRef.current = null;
      if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
      }
      setIsPlaying(false); 
  };

  const playAudio = async () => { 
      if (isPlaying) return;
      if (!video || !video.audioUrl) return;

      try {
          const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
          audioContextRef.current = ctx;

          // 1. Decode Voiceover
          const voiceBytes = new Uint8Array(atob(video.audioUrl).split('').map(c => c.charCodeAt(0)));
          const voiceBuffer = await decodeAudioData(voiceBytes.buffer, ctx);
          const voiceSource = ctx.createBufferSource();
          voiceSource.buffer = voiceBuffer;
          voiceSource.connect(ctx.destination);

          // 2. Decode & Play Background Music
          if (video.backgroundMusicUrl) {
              try {
                  const musicBytes = new Uint8Array(atob(video.backgroundMusicUrl).split('').map(c => c.charCodeAt(0)));
                  const musicBuffer = await decodeAudioData(musicBytes.buffer, ctx);
                  const musicSource = ctx.createBufferSource();
                  musicSource.buffer = musicBuffer;
                  musicSource.loop = true;
                  
                  const musicGain = ctx.createGain();
                  musicGain.gain.value = isMusicEnabled ? musicVolume : 0;
                  bgMusicGainNodeRef.current = musicGain;
                  
                  musicSource.connect(musicGain);
                  musicGain.connect(ctx.destination);
                  musicSource.start(0);
              } catch (e) {
                  console.warn("Failed to play background music", e);
              }
          }

          voiceSource.start(0);
          setIsPlaying(true);
          setTotalDurationState(voiceBuffer.duration);

          const startTime = ctx.currentTime;

          const animate = () => {
              if (!audioContextRef.current) return;
              const elapsed = audioContextRef.current.currentTime - startTime;
              setPlaybackTime(elapsed);

              // Update active scene based on time
              if (video.visualScenes) {
                  const activeSceneIdx = video.visualScenes.findIndex((s, i) => {
                      const next = video.visualScenes![i+1];
                      return elapsed >= s.startTime && (!next || elapsed < next.startTime);
                  });
                  if (activeSceneIdx !== -1) {
                      setCurrentSceneIndex(activeSceneIdx);
                      const segIdx = video.visualScenes[activeSceneIdx].segmentIndex;
                      if (segIdx !== undefined) setCurrentSegmentIndex(segIdx);
                      
                      // DRAW TO STUDIO CANVAS
                      const canvas = studioCanvasRef.current;
                      if (canvas) {
                          const ctx = canvas.getContext('2d');
                          if (ctx) {
                              const width = canvas.width;
                              const height = canvas.height;
                              
                              const currentScene = video.visualScenes[activeSceneIdx];
                              const nextScene = video.visualScenes[activeSceneIdx + 1];
                              const transitionDuration = 0.4;
                              const timeToNext = currentScene.startTime + currentScene.duration - elapsed;

                              const drawSceneToStudio = (scene: any, alpha: number) => {
                                  const img = preloadedImages.get(scene.imageUrl);
                                  const vid = scene.videoUrl ? preloadedVideos.get(scene.videoUrl) : null;
                                  
                                  if (!img && !vid) return;

                                  const sceneTime = elapsed - scene.startTime;
                                  const sceneProgress = Math.min(1, sceneTime / scene.duration);
                                  
                                  if (vid) {
                                      // Sync video time with random offset
                                      const offset = scene.videoOffset || 0;
                                      vid.currentTime = (offset + sceneTime) % vid.duration;
                                  }
                                  
                                  let subEffect = scene.effect;
                                  let visualFilter: any = 'none';
                                  let mirror = false;
                                  
                                  ctx.save();
                                  ctx.globalAlpha = alpha;
                                  calculateTransform(ctx, subEffect, sceneProgress, width, height, 0, elapsed);
                                  applyVisualFilter(ctx, visualFilter);
                                  
                                  const source = vid || img;
                                  if (source) {
                                      const sWidth = (source as any).videoWidth || (source as any).width;
                                      const sHeight = (source as any).videoHeight || (source as any).height;
                                      const scale = Math.max(width / sWidth, height / sHeight);
                                      const drawW = sWidth * scale;
                                      const drawH = sHeight * scale;
                                      const x = (width - drawW) / 2;
                                      const y = (height - drawH) / 2;
                                      
                                      ctx.drawImage(source as any, x, y, drawW, drawH);
                                  }
                                  
                                  ctx.restore();
                              };

                              // Clear
                              ctx.filter = 'none';
                              ctx.setTransform(1, 0, 0, 1, 0, 0);
                              ctx.globalCompositeOperation = 'source-over';
                              ctx.fillStyle = '#000';
                              ctx.fillRect(0, 0, width, height);

                              if (nextScene && timeToNext < transitionDuration) {
                                  const nextAlpha = 1 - (timeToNext / transitionDuration);
                                  drawSceneToStudio(currentScene, 1);
                                  drawSceneToStudio(nextScene, nextAlpha);
                              } else {
                                  drawSceneToStudio(currentScene, 1);
                              }
                              
                              // Overlays
                              drawScanlines(ctx, width, height, elapsed);
                              const vignettePulse = 0.6 + (Math.sin(elapsed * 4) * 0.15); 
                              const gradient = ctx.createRadialGradient(width/2, height/2, width/4, width/2, height/2, width);
                              gradient.addColorStop(0, 'rgba(0,0,0,0)');
                              gradient.addColorStop(1, `rgba(0,0,0,${vignettePulse})`);
                              ctx.fillStyle = gradient;
                              ctx.fillRect(0, 0, width, height);
                          }
                      }
                  }
              } else if (video.segmentTimestamps) {
                  // Fallback to timestamps if no visuals generated
                  let activeIdx = video.segmentTimestamps.findIndex(t => t > elapsed);
                  if (activeIdx === -1) activeIdx = video.segmentTimestamps.length - 1; // Last segment or finished
                  else if (activeIdx > 0) activeIdx = activeIdx - 1; 
                  else activeIdx = 0;
                  setCurrentSegmentIndex(activeIdx);
              }

              if (elapsed < voiceBuffer.duration) {
                  animationFrameRef.current = requestAnimationFrame(animate);
              } else {
                  stopPlayback();
              }
          };
          
          animationFrameRef.current = requestAnimationFrame(animate);

      } catch (e: any) {
          console.error("Playback failed", e);
          setIsPlaying(false);
      }
  };

  const handleGenerateSingleVisual = async (idx: number) => {
      setGeneratingIndex(idx);
      try {
          const segment = video!.script!.segments[idx];
          const prompts = segment.visualDescriptions || [];
          
          let newScenes = video!.visualScenes ? [...video!.visualScenes] : [];
          // Remove all scenes for this segment
          newScenes = newScenes.filter(s => s.segmentIndex !== idx);

          let startTime = 0;
          let totalDuration = segment.estimatedDuration;

          if (video!.segmentTimestamps) {
              startTime = video!.segmentTimestamps[idx];
              const endTime = video!.segmentTimestamps[idx + 1] || (startTime + totalDuration);
              totalDuration = endTime - startTime;
          } else {
              const totalDur = video!.script!.segments.reduce((acc, s) => acc + s.estimatedDuration, 0);
              const perSeg = totalDur / video!.script!.segments.length;
              startTime = idx * perSeg;
              totalDuration = perSeg;
          }

          // Randomly divide duration
          const weights = prompts.map(() => 0.5 + Math.random());
          const totalWeight = weights.reduce((a, b) => a + b, 0);
          const sceneDurations = weights.map(w => (w / totalWeight) * totalDuration);

          let currentStart = startTime;

          for (let j = 0; j < prompts.length; j++) {
              const prompt = prompts[j];
              const dur = sceneDurations[j];
              
              if (j > 0) await new Promise(r => setTimeout(r, 6000));
              
              let url = '';
              let videoUrl = undefined;

              const isDocumentary = scriptTone.toLowerCase().includes('documentary') || scriptTone.toLowerCase().includes('wendover') || scriptTone.toLowerCase().includes('explainer');
              const pexelsChance = isDocumentary ? 0.7 : 0.4;
              const singleUsedIds = new Set<number>();

              if (Math.random() < pexelsChance) {
                  const pexelsResult = await searchContextualMedia(
                    segment.narratorText || prompt,
                    segment.sectionTitle || `Section ${idx}`,
                    scriptTone,
                    project?.channelTheme || '',
                    singleUsedIds,
                    video!.format || 'Landscape 16:9'
                  );
                  if (pexelsResult) {
                      videoUrl = pexelsResult.videoUrl;
                      url = pexelsResult.thumbnailUrl;
                  }
              }

              if (!url) {
                  url = await generateSceneImage(prompt, scriptTone, video!.format || 'Landscape 16:9');
              }
              
              newScenes.push({
                  segmentIndex: idx,
                  imageUrl: url,
                  videoUrl: videoUrl,
                  videoOffset: videoUrl ? Math.random() * 10 : 0, // Random start point for stock videos
                  prompt: prompt,
                  effect: ANIMATION_EFFECTS[Math.floor(Math.random() * ANIMATION_EFFECTS.length)],
                  startTime: currentStart,
                  duration: Math.max(1, dur)
              });
              
              currentStart += dur;
              setLastValidImage(url);
          }
          
          newScenes.sort((a, b) => a.startTime - b.startTime);
          updateVideo(project!.id, video!.id, { visualScenes: newScenes });
      } catch (e: any) {
          console.error(e);
          alert("Failed to generate visuals: " + e.message);
      } finally {
          setGeneratingIndex(null);
      }
  };

  const handleGenerateThumbnail = async () => {
      if (!video?.script?.segments?.length) {
          alert("Gere o roteiro primeiro para dar contexto à thumbnail.");
          return;
      }
      setIsGeneratingThumbnail(true);
      setThumbnailError(null);
      try {
          const scriptSummary = video!.script!.segments.slice(0, 3).map(s => s.narratorText).join(" ").slice(0, 500);
          
          // 1. Generate topic-related dramatic background (with intelligent prompts)
          const baseImageUrl = await generateThumbnail(video!.title, scriptTone, scriptSummary, video!.script, project!.channelTheme);
          
          // 2. Generate clickbait hook text with style recommendation
          const hookData = await generateThumbnailHook(video!.title, scriptTone, project!.language || 'Portuguese', scriptSummary, video!.script, project!.channelTheme);
          
          if (!baseImageUrl) throw new Error("Falha ao gerar a imagem base da thumbnail.");

          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error("Canvas context failed");

          const img = new Image();
          img.crossOrigin = "anonymous";
          img.src = baseImageUrl;
          
          await new Promise((resolve, reject) => {
              img.onload = resolve;
              img.onerror = reject;
          });

          canvas.width = 1280;
          canvas.height = 720;

          // Draw base image (cover fit)
          const scale = Math.max(canvas.width / img.width, canvas.height / img.height);
          const x = (canvas.width - img.width * scale) / 2;
          const y = (canvas.height - img.height * scale) / 2;
          ctx.drawImage(img, x, y, img.width * scale, img.height * scale);

          // Dramatic vignette
          const vignette = ctx.createRadialGradient(canvas.width/2, canvas.height/2, 100, canvas.width/2, canvas.height/2, canvas.width * 0.65);
          vignette.addColorStop(0, 'rgba(0,0,0,0)');
          vignette.addColorStop(1, 'rgba(0,0,0,0.7)');
          ctx.fillStyle = vignette;
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          // Bottom gradient for text readability
          const bottomGrad = ctx.createLinearGradient(0, canvas.height * 0.5, 0, canvas.height);
          bottomGrad.addColorStop(0, 'rgba(0,0,0,0)');
          bottomGrad.addColorStop(1, 'rgba(0,0,0,0.65)');
          ctx.fillStyle = bottomGrad;
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          if (hookData.style === 1) {
              // === TYPE 1: Bold Colored Box Style (MrBeast/Viral) ===
              const drawBoxText = (text: string, bx: number, by: number, fontSize: number, rotation: number, textColor: string, bgColor: string) => {
                  ctx.save();
                  ctx.translate(bx, by);
                  ctx.rotate(rotation * Math.PI / 180);
                  
                  ctx.font = `900 ${fontSize}px "Impact", "Arial Black", sans-serif`;
                  const metrics = ctx.measureText(text);
                  const padX = fontSize * 0.3;
                  const padY = fontSize * 0.15;
                  const w = metrics.width + padX * 2;
                  const h = fontSize * 1.2;

                  // Box shadow
                  ctx.shadowColor = 'rgba(0,0,0,0.95)';
                  ctx.shadowBlur = 30;
                  ctx.shadowOffsetX = 8;
                  ctx.shadowOffsetY = 8;
                  
                  // Colored box
                  ctx.fillStyle = bgColor;
                  const boxX = -padX;
                  const boxY = -fontSize * 0.85;
                  ctx.beginPath();
                  const r = 8;
                  ctx.roundRect(boxX, boxY, w, h + padY * 2, r);
                  ctx.fill();

                  // Reset shadow
                  ctx.shadowColor = 'transparent';
                  ctx.shadowBlur = 0;
                  ctx.shadowOffsetX = 0;
                  ctx.shadowOffsetY = 0;

                  // Text stroke
                  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
                  ctx.lineWidth = fontSize * 0.06;
                  ctx.lineJoin = 'round';
                  ctx.strokeText(text, 0, 0);
                  
                  // Text fill
                  ctx.fillStyle = textColor;
                  ctx.fillText(text, 0, 0);
                  
                  ctx.restore();
                  return h + padY;
              };

              const mainWords = hookData.mainText.split(' ');
              const rotation = -2.5 + Math.random() * 1;
              let currentY = 230;
              const startX = 70;
              const boxColors = ['#ef4444', '#fbbf24', '#ef4444', '#22c55e'];
              const textColors = ['#FFFFFF', '#000000', '#FFFFFF', '#FFFFFF'];

              mainWords.forEach((word, i) => {
                  const colorIdx = i % boxColors.length;
                  const fontSize = i === 0 ? 130 : 110;
                  const h = drawBoxText(word, startX, currentY, fontSize, rotation, textColors[colorIdx], boxColors[colorIdx]);
                  currentY += h * 0.85;
              });

              // Accent text (smaller, different color)
              if (hookData.accentText) {
                  drawBoxText(hookData.accentText, startX + 20, currentY + 10, 80, rotation, '#000000', '#fbbf24');
              }

          } else {
              // === TYPE 2: Cinematic Glow Text (Clean, Mysterious) ===
              const drawGlowText = (text: string, gx: number, gy: number, fontSize: number, color: string, glowColor: string) => {
                  ctx.save();
                  ctx.font = `900 ${fontSize}px "Impact", "Arial Black", sans-serif`;
                  ctx.textAlign = 'center';
                  
                  // Outer glow (multiple passes)
                  ctx.shadowColor = glowColor;
                  ctx.shadowBlur = 60;
                  ctx.fillStyle = glowColor + '40';
                  ctx.fillText(text, gx, gy);
                  ctx.fillText(text, gx, gy);
                  
                  // Inner glow
                  ctx.shadowBlur = 20;
                  ctx.shadowColor = color;
                  
                  // Stroke
                  ctx.strokeStyle = color;
                  ctx.lineWidth = fontSize * 0.04;
                  ctx.lineJoin = 'round';
                  ctx.strokeText(text, gx, gy);
                  
                  // Fill
                  ctx.fillStyle = color;
                  ctx.fillText(text, gx, gy);
                  
                  ctx.restore();
              };

              const centerX = canvas.width / 2;
              
              // Main text
              drawGlowText(hookData.mainText, centerX, 340, 120, '#FFFFFF', '#00aaff');
              
              // Accent text
              if (hookData.accentText) {
                  drawGlowText(hookData.accentText, centerX, 460, 90, '#ffcc00', '#ff4400');
              }
              
              // Subtle line separator
              ctx.save();
              const lineGrad = ctx.createLinearGradient(centerX - 200, 0, centerX + 200, 0);
              lineGrad.addColorStop(0, 'transparent');
              lineGrad.addColorStop(0.5, 'rgba(255,255,255,0.3)');
              lineGrad.addColorStop(1, 'transparent');
              ctx.strokeStyle = lineGrad;
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(centerX - 200, 380);
              ctx.lineTo(centerX + 200, 380);
              ctx.stroke();
              ctx.restore();
          }

          // Red accent dot/circle (visual anchor — proven to increase CTR)
          ctx.save();
          ctx.beginPath();
          ctx.arc(canvas.width - 90, 90, 35, 0, Math.PI * 2);
          ctx.fillStyle = '#ef4444';
          ctx.shadowColor = '#ef4444';
          ctx.shadowBlur = 25;
          ctx.fill();
          ctx.shadowBlur = 0;
          // Exclamation or question mark inside
          ctx.font = '900 40px "Impact", sans-serif';
          ctx.fillStyle = '#FFFFFF';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(hookData.mainText.includes('?') ? '?' : '!', canvas.width - 90, 90);
          ctx.restore();

          const finalUrl = canvas.toDataURL('image/jpeg', 0.92);
          updateVideo(project!.id, video!.id, { thumbnailUrl: finalUrl });
          alert("✅ Thumbnail clickbait gerada com sucesso!");
      } catch (e: any) {
          console.error("Thumbnail generation error", e);
          const msg = e.message || "Erro desconhecido";
          const isQuota = msg.includes("Cota esgotada") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("429");
          setThumbnailError(isQuota ? "Limite de cota atingido para geração de imagens." : msg);
      } finally {
          setIsGeneratingThumbnail(false);
      }
  };
  
  const handleGenerateMetadata = async () => { 
      if (!video?.script?.segments?.length) {
          alert("Please generate the script first to provide context for the metadata.");
          return;
      }
      setIsGeneratingMetadata(true); 
      try {
          const summary = video!.script?.segments.slice(0, 3).map(s => s.narratorText).join(" ") || "";
          const promptContext = scriptContext ? `Specific Details: ${scriptContext}. ` : '';
          const metadata = await generateVideoMetadata(video!.title, promptContext + summary, scriptTone, project!.language, video!.script?.segments || []); 
          updateVideo(project!.id, video!.id, { videoMetadata: metadata });
          alert("SEO Metadata generated successfully!");
      } catch (e: any) { 
          console.error("Metadata generation error", e); 
          alert("Failed to generate metadata: " + (e.message || "Unknown error"));
      } finally { 
          setIsGeneratingMetadata(false); 
      } 
  };

  if (!project || !video) return <div className="p-8 text-center text-slate-500">Project or Video not found</div>;
  const activeScene = video.visualScenes?.[currentSceneIndex];
  const isProcessing = isGeneratingScript || isGeneratingAudio || isGeneratingVisuals || isRenderingVideo || isUploading;
  const processingLabel = isGeneratingScript ? 'Thinking...' : isGeneratingAudio ? `Synthesizing...` : isGeneratingVisuals ? `Dreaming...` : isRenderingVideo ? `${renderStatus} (${renderProgress}%)` : isUploading ? `Uploading ${uploadProgress}%` : 'Processing';

  // DETERMINE PLAYER CLASS BASED ON FORMAT
  const isShort = video.format && video.format.includes('9:16');
  const isSquare = video.format && video.format.includes('1:1');
  
  let playerClass = "w-full max-w-5xl aspect-video"; // Default Landscape
  if (isShort) playerClass = "w-full max-w-sm aspect-[9/16]";
  if (isSquare) playerClass = "w-full max-w-2xl aspect-square";

  return (
    <div className="flex flex-col gap-8 relative pb-32 min-h-screen">
        {/* TOP HEADER */}
        <div className="flex flex-col gap-6">
            <div className="flex items-center gap-4">
                <Link to={`/project/${project.id}`} className="p-3 bg-white/5 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition-colors border border-white/5">
                    <ArrowLeft className="w-5 h-5" />
                </Link>
                <div>
                    <h2 className="text-2xl font-bold text-white mb-1 tracking-tight">{video.title}</h2>
                    <div className="flex items-center gap-2 text-sm text-slate-400 font-medium">
                        <span>{project.channelTheme}</span>
                        <div className="w-1 h-1 bg-slate-600 rounded-full"></div>
                        <span className="text-orange-400">{video.targetDuration}</span>
                        <div className="w-1 h-1 bg-slate-600 rounded-full"></div>
                        <span className="text-slate-500">{video.format || '16:9'}</span>
                    </div>
                </div>
            </div>

            {/* OPTIMIZED PROGRESS BAR */}
            <div className="w-full bg-[#0F1629]/80 backdrop-blur-xl border border-white/5 rounded-3xl p-6 shadow-2xl relative overflow-hidden">
                {/* Active Step Glow Background */}
                <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-r from-orange-500/5 via-transparent to-transparent opacity-50 pointer-events-none"></div>

                <div className="relative flex items-center justify-between px-4 md:px-12">
                    
                    {/* Track Lines Container */}
                    <div className="absolute top-1/2 left-0 right-0 h-1 -translate-y-1/2 -z-0 mx-10 md:mx-20">
                         {/* Inactive Track */}
                         <div className="w-full h-full bg-slate-800/80 rounded-full absolute top-0 left-0"></div>
                         {/* Active Progress Track */}
                         <div 
                            className="h-full bg-gradient-to-r from-orange-600 to-amber-500 rounded-full absolute top-0 left-0 transition-all duration-700 ease-out shadow-[0_0_12px_rgba(249,115,22,0.6)]"
                            style={{ width: `${(steps.findIndex(s => s.id === activeTab) / (steps.length - 1)) * 100}%` }}
                         ></div>
                    </div>

                    {steps.map((step, idx) => {
                        const activeIndex = steps.findIndex(s => s.id === activeTab);
                        const isActive = activeTab === step.id;
                        const isCompleted = idx < activeIndex;
                        
                        return (
                            <button 
                                key={step.id} 
                                onClick={() => setActiveTab(step.id as any)} 
                                className="group relative flex flex-col items-center gap-3 focus:outline-none z-10"
                            >
                                {/* Circle Container */}
                                <div className={`
                                    w-12 h-12 md:w-14 md:h-14 rounded-full flex items-center justify-center border-2 
                                    transition-all duration-500 ease-out relative shadow-xl
                                    ${isActive 
                                        ? 'bg-[#0F1629] border-orange-500 text-orange-400 scale-110 shadow-[0_0_30px_rgba(249,115,22,0.4)]' 
                                        : isCompleted 
                                            ? 'bg-[#0F1629] border-green-500/50 text-green-400' 
                                            : 'bg-[#0F1629] border-slate-800 text-slate-600 hover:border-slate-600 hover:text-slate-400'
                                    }
                                `}>
                                    {isCompleted && !isActive ? (
                                        <CheckCircle className="w-5 h-5 md:w-6 md:h-6" />
                                    ) : (
                                        <step.icon className={`w-5 h-5 md:w-6 md:h-6 transition-transform duration-300 ${isActive ? 'scale-110' : ''}`} />
                                    )}
                                    
                                    {/* Active Ripple */}
                                    {isActive && (
                                        <div className="absolute inset-0 rounded-full border border-orange-500 opacity-0 animate-ping"></div>
                                    )}
                                </div>

                                {/* Label Area */}
                                <div className={`flex flex-col items-center gap-0.5 transition-all duration-300 ${isActive ? '-translate-y-1' : ''}`}>
                                    <span className={`text-[10px] md:text-xs font-bold uppercase tracking-widest transition-colors duration-300 ${isActive ? 'text-white' : isCompleted ? 'text-slate-400' : 'text-slate-600'}`}>
                                        {step.label}
                                    </span>
                                    <span className={`text-[9px] font-medium hidden md:block transition-all duration-500 ${isActive ? 'text-orange-400 opacity-100 max-h-4' : 'opacity-0 max-h-0 overflow-hidden'}`}>
                                        {step.desc}
                                    </span>
                                </div>
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>

        {/* MAIN WORKSPACE */}
        <div className="w-full relative">
            
            {/* SCRIPT EDITOR */}
            {activeTab === 'script' && (
                !video.script ? (
                    <div className="py-20 border border-dashed border-white/10 rounded-3xl bg-white/5">
                        <EmptyState icon={FileText} title="Blueprint Missing" description="Configure your narrative parameters to generate the video script." actionLabel="Generate Script" onClick={() => setIsConfigModalOpen(true)} />
                    </div>
                ) : (
                    <div className="flex flex-col gap-6">
                        <div className="bg-[#0F1629]/50 backdrop-blur border border-white/5 rounded-2xl p-6">
                            <h2 className="text-xl font-bold text-white mb-2">{video.script.title}</h2>
                            <p className="text-slate-400 leading-relaxed text-sm mb-4">{video.script.description}</p>
                            
                            {video.script.ambientMusicDescription && (
                                <div className="bg-blue-500/5 border border-blue-500/10 rounded-xl p-4 flex items-start gap-3">
                                    <div className="bg-blue-500/20 p-2 rounded-lg">
                                        <Music className="w-4 h-4 text-blue-400" />
                                    </div>
                                    <div>
                                        <h4 className="text-[10px] font-bold text-blue-400 uppercase tracking-wider mb-1">Ambient Music Direction</h4>
                                        <p className="text-xs text-blue-200/70 italic">{video.script.ambientMusicDescription}</p>
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-lg font-bold text-white">Storyboard & Script</h3>
                            <div className="flex gap-2">
                                <button 
                                    onClick={handleAutoFillNarrator}
                                    disabled={isAutoFillingNarrator}
                                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-xl border border-slate-700 flex items-center gap-2 transition-all"
                                >
                                    {isAutoFillingNarrator ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-orange-400" />}
                                    Auto-Fill Narration
                                </button>
                            </div>
                        </div>
                        <div className="relative">
                            <div className="flex overflow-x-auto gap-4 pb-8 custom-scrollbar snap-x px-1">
                                <div className="flex-shrink-0 w-8"></div>
                                {video.script.segments.map((segment, idx) => {
                                    const relatedScene = video.visualScenes?.find(s => s.segmentIndex === idx);
                                    return (
                                        <div key={idx} className="flex-shrink-0 w-[400px] snap-center flex flex-col group">
                                            <div className="bg-[#0F1629] border border-white/10 rounded-2xl overflow-hidden shadow-xl hover:border-orange-500/50 transition-all hover:shadow-2xl flex flex-col h-full">
                                                <div className="bg-white/5 p-4 flex justify-between items-center border-b border-white/5">
                                                    <div className="flex items-center gap-3">
                                                        <span className="text-xs font-mono text-slate-500">#{String(idx + 1).padStart(2,'0')}</span>
                                                        <h4 className="font-bold text-white text-sm truncate max-w-[200px]">{segment.sectionTitle}</h4>
                                                    </div>
                                                    <span className="text-[10px] font-mono bg-black/40 px-2 py-1 rounded text-slate-400">{segment.estimatedDuration}s</span>
                                                </div>
                                                <div className="p-4 flex flex-col gap-4 flex-1">
                                                    <div className="bg-orange-500/5 border border-orange-500/10 rounded-xl p-3 relative group/visual">
                                                        <div className="flex justify-between items-start mb-2">
                                                            <div className="flex items-center gap-2 text-[10px] font-bold text-orange-400 uppercase tracking-wider"><Eye className="w-3 h-3" /> Visual Prompt</div>
                                                        </div>
                                                        <div className="flex flex-col gap-2">
                                                            {relatedScene && <img src={relatedScene.imageUrl} className="w-full h-32 rounded-lg object-cover border border-white/10" />}
                                                            <div className="space-y-1">
                                                                {(segment.visualDescriptions || []).map((p, pIdx) => (
                                                                    <p key={pIdx} className="text-[10px] text-orange-200/50 leading-tight italic line-clamp-1 hover:line-clamp-none transition-all border-l border-orange-500/20 pl-2">
                                                                        {p}
                                                                    </p>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className="relative flex-1">
                                                        <div className="flex justify-between items-center mb-1">
                                                            <div className="flex items-center gap-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider"><AlignLeft className="w-3 h-3" /> Narrator</div>
                                                            <div className="flex items-center gap-1">
                                                                <button 
                                                                    onClick={() => handleGenerateSingleNarrator(idx)} 
                                                                    disabled={generatingNarratorIndex === idx}
                                                                    className="text-slate-500 hover:text-orange-400 p-1 transition-colors"
                                                                    title="Generate Narrator Text"
                                                                >
                                                                    {generatingNarratorIndex === idx ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                                                                </button>
                                                                <button onClick={() => handlePreviewSegment(idx, segment.narratorText)} disabled={previewingSegmentAudio===idx} className="text-slate-500 hover:text-orange-400 p-1">{previewingSegmentAudio === idx ? <Loader2 className="w-3 h-3 animate-spin" /> : <Volume2 className="w-3 h-3" />}</button>
                                                            </div>
                                                        </div>
                                                        <textarea className="w-full h-32 bg-transparent text-slate-300 text-sm leading-relaxed border border-slate-800 rounded-lg p-3 resize-none focus:border-orange-500/50 focus:bg-slate-900/50 transition-all outline-none" value={segment.narratorText} onChange={(e) => handleUpdateScriptSegment(idx, e.target.value)} placeholder="Narrator text goes here..." />
                                                    </div>

                                                    {segment.soundEffects && segment.soundEffects.length > 0 && (
                                                        <div className="bg-slate-800/30 rounded-xl p-3 border border-white/5">
                                                            <div className="flex items-center gap-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">
                                                                <Volume2 className="w-3 h-3" /> Sound Effects
                                                            </div>
                                                            <div className="flex flex-wrap gap-2">
                                                                {segment.soundEffects.map((sfx, sfxIdx) => (
                                                                    <span key={sfxIdx} className="text-[9px] bg-slate-800 text-slate-400 px-2 py-1 rounded-md border border-white/5">
                                                                        {sfx}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                                <div className="flex-shrink-0 w-8"></div>
                            </div>
                        </div>
                    </div>
                )
            )}

            {/* AUDIO VIEW */}
            {activeTab === 'audio' && (
                 !video.audioUrl ? (
                    <div className="py-20 border border-dashed border-white/10 rounded-3xl bg-white/5">
                        <EmptyState icon={Mic} title="Audio Missing" description="Synthesize the AI narration based on your script." actionLabel="Generate Audio" onClick={() => setIsConfigModalOpen(true)} />
                    </div>
                 ) : (
                    <div className="flex flex-col items-center justify-center p-12 bg-gradient-to-br from-orange-900/10 via-[#0F1629] to-[#0F1629] border border-white/5 rounded-3xl shadow-2xl">
                        <div className="w-24 h-24 bg-orange-500/20 rounded-full flex items-center justify-center mb-6 relative"><div className="absolute inset-0 border-2 border-orange-500/30 rounded-full animate-ping opacity-20"></div><Mic className="w-10 h-10 text-orange-400" /></div>
                        <h3 className="text-3xl font-bold text-white mb-2">Audio Mastered</h3>
                        <p className="text-slate-400 mb-8">Voiceover track is ready.</p>
                        <div className="bg-black/30 backdrop-blur rounded-2xl p-6 w-full max-w-xl border border-white/10 flex items-center gap-6 mb-8">
                            <button onClick={() => isPlaying ? stopPlayback() : playAudio()} className="w-14 h-14 rounded-full bg-orange-600 hover:bg-orange-500 text-white flex items-center justify-center shadow-lg shadow-orange-600/30 transition-all hover:scale-105 active:scale-95">{isPlaying ? <Pause className="w-6 h-6 fill-current" /> : <Play className="w-6 h-6 fill-current ml-1" />}</button>
                            <div className="flex-1 space-y-2"><div className="h-2 bg-slate-800 rounded-full overflow-hidden w-full"><div className="h-full bg-orange-500 transition-all duration-100 ease-linear" style={{ width: `${totalDurationState > 0 ? (playbackTime / totalDurationState) * 100 : 0}%` }}></div></div><div className="flex justify-between text-xs font-mono text-slate-500"><span>{formatTime(playbackTime)}</span><span>{formatTime(totalDurationState)}</span></div></div>
                        </div>
                        <div className="flex gap-4"><button onClick={() => setActiveTab('video')} className="px-8 py-3 bg-white text-black rounded-xl font-bold hover:bg-slate-200 transition-colors shadow-lg shadow-white/10 flex items-center gap-2">Next: Visuals <ArrowRight className="w-4 h-4" /></button><button onClick={() => setIsConfigModalOpen(true)} className="px-6 py-3 border border-white/10 text-slate-300 rounded-xl font-medium hover:bg-white/5 transition-colors">Regenerate</button></div>
                    </div>
                 )
            )}

            {/* VIDEO/VISUALS VIEW */}
            {activeTab === 'video' && (
                !video.visualScenes || video.visualScenes.length === 0 ? (
                    <div className="py-20 border border-dashed border-white/10 rounded-3xl bg-white/5">
                        <EmptyState icon={ImageIcon} title="Visuals Missing" description="Generate cinematic AI scenes for each segment." actionLabel="Generate All Scenes" onClick={handleGenerateAllVisuals} isLoading={isGeneratingVisuals} />
                    </div>
                ) : (
                    <div className="flex flex-col gap-6">
                        <div className="flex justify-between items-end">
                            <h3 className="text-xl font-bold text-white">Storyboard</h3>
                            <div className="flex gap-3">
                                <button onClick={() => setActiveTab('studio')} className="px-6 py-3 bg-orange-600 hover:bg-orange-500 text-white font-bold rounded-xl shadow-lg shadow-orange-600/20 flex items-center gap-2 active:scale-95">
                                    <Play className="w-5 h-5" /> Open Studio
                                </button>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
                            {video.visualScenes.map((scene, idx) => (
                                <div key={idx} className={`bg-slate-900 rounded-xl overflow-hidden border border-white/10 relative group hover:border-orange-500/50 transition-all ${isShort ? 'aspect-[9/16]' : 'aspect-square'}`}>
                                    <img src={scene.imageUrl} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" />
                                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3">
                                        <p className="text-[10px] text-white line-clamp-2">{scene.prompt}</p>
                                    </div>
                                    <div className="absolute top-2 left-2 bg-black/60 px-2 py-0.5 rounded text-[10px] text-white font-mono">#{idx+1}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                )
            )}

            {/* STUDIO VIEW */}
            {(activeTab === 'studio' || (activeTab === 'video' && video.visualScenes?.length)) && (
                <div className="flex flex-col items-center">
                    <div className={`${playerClass} bg-black relative rounded-t-2xl border-t border-x border-slate-700 shadow-2xl overflow-hidden group`}>
                        <div className="absolute inset-0 flex items-center justify-center bg-black overflow-hidden isolate">
                            <div className="absolute inset-0 pointer-events-none bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 z-20 mix-blend-overlay"></div>
                            {lastValidImage && (
                                <div className="absolute inset-0 z-10 bg-black">
                                    <img 
                                        src={lastValidImage} 
                                        className="w-full h-full object-cover blur-sm opacity-50 scale-105 transition-opacity duration-700" 
                                        onLoad={(e) => (e.currentTarget.style.opacity = "0.5")}
                                        style={{ opacity: 0 }}
                                    />
                                </div>
                            )}
                            
                            {/* ACTIVE SCENE WITH VIRTUAL CUTS PREVIEW (CANVAS BASED) */}
                            <canvas 
                                ref={studioCanvasRef}
                                width={1920}
                                height={isShort ? 3413 : (isSquare ? 1920 : 1080)}
                                className="w-full h-full object-contain z-10"
                            />
                            
                            {video.script?.segments[currentSegmentIndex] && (<div className={`absolute bottom-10 left-0 right-0 p-8 text-center transition-all duration-500 z-30 ${isPlaying ? 'opacity-100' : 'opacity-0'}`}><span className="bg-black/60 backdrop-blur-md px-6 py-3 rounded-xl text-white text-lg font-medium shadow-2xl inline-block border border-white/10">{video.script?.segments[currentSegmentIndex]?.narratorText}</span></div>)}
                        </div>
                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-40 bg-black/20">
                            <button onClick={() => isPlaying ? stopPlayback() : playAudio()} className="w-20 h-20 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center hover:bg-white/20 hover:scale-105 transition-all">{isPlaying ? <Pause className="w-8 h-8 fill-white text-white" /> : <Play className="w-8 h-8 fill-white text-white ml-1" />}</button>
                        </div>
                    </div>
                    <div className="w-full max-w-5xl bg-[#0B1121] border border-slate-700 rounded-b-2xl p-4 flex items-center justify-between shadow-xl relative z-50">
                        <div className="flex items-center gap-4 text-slate-400"><div className="flex items-center gap-2 font-mono text-sm"><span className="text-white">{formatTime(playbackTime)}</span><span className="opacity-50">/</span><span>{formatTime(totalDurationState)}</span></div></div>
                        <div className="flex items-center gap-4"><button onClick={() => setIsMusicEnabled(!isMusicEnabled)} className={`p-2 rounded-lg transition-colors ${isMusicEnabled ? 'text-orange-400 bg-orange-500/10' : 'text-slate-600'}`}>{isMusicEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}</button><button onClick={handleGenerateMusic} className="text-xs font-bold text-slate-400 hover:text-white flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white/5 border border-transparent hover:border-white/10 transition-all">{isGeneratingMusic ? <Loader2 className="w-3 h-3 animate-spin" /> : <Music className="w-3 h-3" />} Ambience</button></div>
                    </div>
                </div>
            )}
            
            {/* Publish View */}
            {activeTab === 'publish' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 py-8">
                     {/* LEFT COLUMN: EXPORT */}
                     <div className="bg-[#0F1629]/80 border border-white/5 rounded-3xl p-8 flex flex-col justify-between">
                         <div>
                             <div className="w-12 h-12 bg-orange-500/20 rounded-xl flex items-center justify-center mb-6"><Download className="w-6 h-6 text-orange-400" /></div>
                             <h3 className="text-2xl font-bold text-white mb-2">Local Export</h3>
                             <p className="text-slate-400 mb-6">Render the full video mix in-browser and download to your device.</p>
                         </div>
                         
                         <div className="space-y-4">
                             {video.thumbnailUrl ? (
                                 <div className="space-y-2">
                                     <div className="relative group rounded-xl overflow-hidden border border-slate-700 shadow-lg aspect-video">
                                         <img src={video.thumbnailUrl} alt="Thumbnail" className="w-full h-full object-cover" />
                                         <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
                                             <a href={video.thumbnailUrl} download={`${video.title}_thumb.jpg`} className="p-2 bg-white text-black rounded-full hover:scale-110 transition-transform" title="Download Thumbnail"><Download className="w-5 h-5" /></a>
                                             <button onClick={handleGenerateThumbnail} disabled={isGeneratingThumbnail} className="p-2 bg-white text-black rounded-full hover:scale-110 transition-transform" title="Regenerate Thumbnail">
                                                 {isGeneratingThumbnail ? <Loader2 className="w-5 h-5 animate-spin" /> : <RefreshCw className="w-5 h-5" />}
                                             </button>
                                         </div>
                                     </div>
                                 </div>
                             ) : (
                                 <div className="space-y-3">
                                     <button onClick={handleGenerateThumbnail} disabled={isGeneratingThumbnail} className="w-full py-3 rounded-xl border border-white/10 text-slate-300 hover:bg-white/5 font-bold flex items-center justify-center gap-2">
                                         {isGeneratingThumbnail?<Loader2 className="w-4 h-4 animate-spin"/>:<ImageIcon className="w-4 h-4"/>} Generate Thumb
                                     </button>
                                     
                                     {thumbnailError && (
                                         <div className="p-3 bg-orange-500/10 border border-orange-500/20 rounded-xl flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
                                             <AlertCircle className="w-4 h-4 text-orange-500 flex-shrink-0 mt-0.5" />
                                             <div className="flex-1">
                                                 <p className="text-[10px] text-orange-400 font-medium">{thumbnailError}</p>
                                                 <div className="flex items-center gap-3 mt-1">
                                                     <button onClick={() => setThumbnailError(null)} className="text-[9px] text-orange-500/70 hover:text-orange-500 underline">Dispensar</button>
                                                     <button onClick={() => setShowThumbnailTroubleshooting(true)} className="text-[9px] text-blue-400 hover:text-blue-300 font-bold flex items-center gap-1">
                                                         <HelpCircle className="w-3 h-3" /> Guia de Solução
                                                     </button>
                                                 </div>
                                             </div>
                                         </div>
                                     )}
                                 </div>
                             )}

                             <button 
                                  onClick={() => handleRenderAndDownload(true)} 
                                 disabled={isRenderingVideo} 
                                 className="w-full py-4 rounded-xl bg-white text-black font-bold hover:bg-slate-200 transition-colors flex flex-col items-center justify-center gap-1 shadow-lg shadow-white/5"
                             >
                                 <div className="flex items-center gap-2">
                                     {isRenderingVideo ? <Loader2 className="w-5 h-5 animate-spin" /> : <Video className="w-5 h-5" />} 
                                     <span>{isRenderingVideo ? 'Rendering Video...' : 'Download Master File'}</span>
                                 </div>
                                 {isRenderingVideo && <span className="text-[10px] font-mono text-slate-500">{renderStatus} ({renderProgress}%)</span>}
                             </button>
                         </div>
                     </div>

                     {/* RIGHT COLUMN: YOUTUBE */}
                             <div className="bg-gradient-to-br from-red-900/10 to-[#0F1629] border border-red-500/10 rounded-3xl p-8 flex flex-col justify-between">
                                 <div>
                                     <div className="w-12 h-12 bg-red-600/20 rounded-xl flex items-center justify-center mb-6"><Youtube className="w-6 h-6 text-red-500" /></div>
                                     <h3 className="text-2xl font-bold text-white mb-2">YouTube Sync</h3>
                                     <p className="text-slate-400 mb-6">Upload diretamente para o seu canal conectado.</p>
                                     
                                     {/* Pre-upload Checklist */}
                                     <div className="grid grid-cols-2 gap-2 mb-6">
                                         {[
                                             { label: 'Script', done: !!video.script },
                                             { label: 'Áudio', done: !!video.audioUrl },
                                             { label: 'Cenas', done: !!video.visualScenes?.length },
                                             { label: 'Thumb', done: !!video.thumbnailUrl },
                                             { label: 'SEO', done: !!video.videoMetadata },
                                             { label: 'Canal', done: !!project?.youtubeChannelData },
                                         ].map((item, i) => (
                                             <div key={i} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[10px] font-bold uppercase tracking-wider transition-colors ${item.done ? 'bg-green-500/10 border-green-500/20 text-green-500' : 'bg-slate-900/40 border-white/5 text-slate-500'}`}>
                                                 {item.done ? <CheckCircle className="w-3 h-3" /> : <X className="w-3 h-3" />}
                                                 {item.label}
                                             </div>
                                         ))}
                                     </div>
                                     
                                     {project?.youtubeChannelData ? (
                                         <div className="flex flex-col gap-3 mb-4">
                                             <div className="flex items-center gap-3 bg-black/40 p-3 rounded-lg border border-white/10">
                                                 <img src={project.youtubeChannelData.thumbnailUrl} className="w-8 h-8 rounded-full" />
                                                 <div className="flex-1 min-w-0">
                                                     <span className="text-white font-medium text-sm truncate block">{project.youtubeChannelData.title}</span>
                                                     <span className="text-xs text-slate-500 block">{project.youtubeChannelData.subscriberCount} subs</span>
                                                 </div>
                                                 <div className="flex flex-col items-end gap-1">
                                                    <CheckCircle className="w-4 h-4 text-green-500" />
                                                 </div>
                                             </div>
                                             <button 
                                                 onClick={() => setShowCorsHelp(true)}
                                                 className="w-full py-2 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/20 rounded-xl text-[10px] font-bold flex items-center justify-center gap-2 transition-all"
                                             >
                                                 <Settings className="w-3 h-3" /> Configurar Google Cloud (CORS)
                                             </button>
                                         </div>
                                     ) : (
                                         <div className="flex flex-col gap-3 mb-4">
                                             <div className="text-sm text-yellow-500 bg-yellow-500/10 p-3 rounded-lg border border-yellow-500/20">
                                                 Nenhum canal conectado. Vá nas Settings do projeto para conectar.
                                             </div>
                                         </div>
                                     )}
                                 </div>
                         <div className="space-y-4">
                             <button onClick={handleGenerateMetadata} disabled={isGeneratingMetadata} className="w-full py-3 rounded-xl border border-white/10 text-slate-300 hover:bg-white/5 font-bold flex items-center justify-center gap-2 text-sm">
                                 {isGeneratingMetadata?<Loader2 className="w-4 h-4 animate-spin"/>:<Wand2 className="w-4 h-4"/>} Generate SEO Metadata
                             </button>
                             
                             {video.videoMetadata && (
                                <div className="space-y-3 mb-2 p-4 bg-black/40 rounded-xl border border-white/5">
                                    <div>
                                        <div className="flex justify-between items-center mb-1">
                                            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Title</label>
                                            <span className={`text-[10px] ${video.videoMetadata.youtubeTitle.length > 100 ? 'text-red-500' : 'text-slate-600'}`}>{video.videoMetadata.youtubeTitle.length}/100</span>
                                        </div>
                                        <input 
                                            className="w-full bg-transparent text-white font-bold text-sm border-b border-white/10 pb-1 mb-1 focus:outline-none focus:border-orange-500 transition-colors" 
                                            value={video.videoMetadata.youtubeTitle}
                                            onChange={(e) => updateVideo(project.id, video.id, { videoMetadata: { ...video.videoMetadata!, youtubeTitle: e.target.value } })}
                                        />
                                    </div>
                                    <div>
                                        <div className="flex justify-between items-center mb-1">
                                            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Description</label>
                                            <span className={`text-[10px] ${video.videoMetadata.youtubeDescription.length > 5000 ? 'text-red-500' : 'text-slate-600'}`}>{video.videoMetadata.youtubeDescription.length}/5000</span>
                                        </div>
                                        <textarea 
                                            className="w-full bg-transparent text-slate-400 text-xs h-24 resize-none focus:outline-none custom-scrollbar border border-transparent focus:border-orange-500/30 rounded p-1"
                                            value={video.videoMetadata.youtubeDescription}
                                            onChange={(e) => updateVideo(project.id, video.id, { videoMetadata: { ...video.videoMetadata!, youtubeDescription: e.target.value } })}
                                        />
                                    </div>
                                    <div className="grid grid-cols-2 gap-4">
                                         <div>
                                             <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                                                 <Eye className="w-3 h-3" /> Visibility
                                             </label>
                                             <select 
                                                 className="w-full bg-slate-900 text-slate-300 text-xs rounded border border-white/10 p-1.5 focus:outline-none focus:border-orange-500"
                                                 value={video.videoMetadata.visibility || 'private'}
                                                 onChange={(e) => updateVideo(project.id, video.id, { videoMetadata: { ...video.videoMetadata!, visibility: e.target.value as any } })}
                                             >
                                                 <option value="public">Public</option>
                                                 <option value="unlisted">Unlisted</option>
                                                 <option value="private">Private</option>
                                             </select>
                                         </div>
                                         <div>
                                             <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                                                 <Hash className="w-3 h-3" /> Category
                                             </label>
                                             <select 
                                                 className="w-full bg-slate-900 text-slate-300 text-xs rounded border border-white/10 p-1.5 focus:outline-none focus:border-orange-500"
                                                 value={video.videoMetadata.categoryId || '24'}
                                                 onChange={(e) => updateVideo(project.id, video.id, { videoMetadata: { ...video.videoMetadata!, categoryId: e.target.value } })}
                                             >
                                                 {YOUTUBE_CATEGORIES.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
                                             </select>
                                         </div>
                                     </div>
                                     <div className="grid grid-cols-1 gap-4">
                                         <div>
                                             <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                                                 <FileVideo className="w-3 h-3" /> Format
                                             </label>
                                             <div className="flex items-center gap-2 h-[30px]">
                                                 <button 
                                                     onClick={() => updateVideo(project.id, video.id, { videoMetadata: { ...video.videoMetadata!, isShorts: true } })}
                                                     className={`flex-1 h-full rounded text-[10px] font-bold transition-colors ${video.videoMetadata?.isShorts ? 'bg-red-600 text-white' : 'bg-slate-800 text-slate-400'}`}
                                                 >
                                                     SHORTS
                                                 </button>
                                                 <button 
                                                     onClick={() => updateVideo(project.id, video.id, { videoMetadata: { ...video.videoMetadata!, isShorts: false } })}
                                                     className={`flex-1 h-full rounded text-[10px] font-bold transition-colors ${!video.videoMetadata?.isShorts ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400'}`}
                                                 >
                                                     VIDEO
                                                 </button>
                                             </div>
                                         </div>
                                     </div>
                                    <div>
                                        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                                            <Tag className="w-3 h-3" /> Tags
                                        </label>
                                        <input
                                            className="w-full bg-transparent text-slate-400 text-xs border-b border-white/10 pb-1 focus:outline-none focus:border-orange-500"
                                            value={video.videoMetadata.tags?.join(', ') || ''}
                                            onChange={(e) => {
                                                const tagsArray = e.target.value.split(',').map(t => t.trim()).filter(Boolean);
                                                updateVideo(project.id, video.id, { videoMetadata: { ...video.videoMetadata!, tags: tagsArray } });
                                            }}
                                            placeholder="tag1, tag2..."
                                        />
                                    </div>
                                </div>
                             )}

                             {/* Upload Progress Bar */}
                             {isUploading && (
                                 <div className="space-y-2">
                                     <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                                         <span className="flex items-center gap-1">
                                             <Loader2 className="w-3 h-3 animate-spin" />
                                             {isRenderingVideo ? 'Renderizando para Upload...' : 'Enviando para o YouTube...'}
                                         </span>
                                         <span>{isRenderingVideo ? renderProgress : uploadProgress}%</span>
                                     </div>
                                     <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                                         <div className="h-full bg-gradient-to-r from-red-600 to-red-400 transition-all duration-300 ease-out" style={{ width: `${isRenderingVideo ? renderProgress : uploadProgress}%` }}></div>
                                     </div>
                                 </div>
                             )}

                             {uploadError && (
                                 <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
                                     <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                                     <div className="flex-1">
                                         <p className="text-xs text-red-400 font-medium">{uploadError}</p>
                                         <div className="flex items-center gap-3 mt-1">
                                             <button onClick={() => setUploadError(null)} className="text-[10px] text-red-500/70 hover:text-red-500 underline">Dispensar</button>
                                             <button onClick={() => setShowTroubleshooting(true)} className="text-[10px] text-blue-400 hover:text-blue-300 font-bold flex items-center gap-1">
                                                 <HelpCircle className="w-3 h-3" /> Guia de Solução
                                             </button>
                                         </div>
                                     </div>
                                 </div>
                             )}

                             <div className="space-y-3">
                                 {!isUploading && !isRenderingVideo && (
                                     <div className="flex flex-col gap-1">
                                         <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1">
                                             <Calendar className="w-3 h-3" /> Agendar (Opcional)
                                         </label>
                                         <input 
                                             type="datetime-local" 
                                             value={scheduledDate} 
                                             onChange={(e)=>setScheduledDate(e.target.value)} 
                                             className="bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-white text-xs w-full focus:outline-none focus:border-red-500 transition-colors" 
                                         />
                                     </div>
                                 )}

                                  {video.youtubeUrl ? (
                                      <div className="space-y-3">
                                          <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-xl flex flex-col items-center gap-3">
                                              <div className="w-10 h-10 bg-green-500/20 rounded-full flex items-center justify-center">
                                                  <CheckCircle className="w-6 h-6 text-green-500" />
                                              </div>
                                              <div className="text-center">
                                                  <p className="text-green-400 font-bold text-sm">Postado com Sucesso!</p>
                                                  <p className="text-[10px] text-green-500/70">Seu vídeo já está no YouTube.</p>
                                              </div>
                                              <div className="flex gap-2 w-full">
                                                  <a 
                                                      href={video.youtubeUrl} 
                                                      target="_blank" 
                                                      rel="noopener noreferrer"
                                                      className="flex-1 py-2 bg-white text-black rounded-lg text-xs font-bold flex items-center justify-center gap-2 hover:bg-slate-200"
                                                  >
                                                      <ExternalLink className="w-3 h-3" /> Ver no YouTube
                                                  </a>
                                                  <button 
                                                      onClick={() => {
                                                          navigator.clipboard.writeText(video.youtubeUrl!);
                                                          alert("Link copiado!");
                                                      }}
                                                      className="p-2 bg-white/10 text-white rounded-lg hover:bg-white/20"
                                                      title="Copiar Link"
                                                  >
                                                      <Copy className="w-4 h-4" />
                                                  </button>
                                              </div>
                                          </div>
                                          <div className="flex gap-2">
                                              <button 
                                                  onClick={handleRealUpload} 
                                                  disabled={isUploading || isRenderingVideo} 
                                                  className="flex-1 py-3 rounded-xl border border-white/10 text-slate-500 hover:text-slate-300 text-xs font-medium"
                                              >
                                                  Postar Novamente
                                              </button>
                                              <button 
                                                  onClick={() => updateVideo(project.id, video.id, { youtubeUrl: undefined })}
                                                  className="px-4 py-3 rounded-xl border border-white/10 text-slate-500 hover:text-red-400 text-xs font-medium"
                                                  title="Limpar Status"
                                              >
                                                  <RotateCcw className="w-4 h-4" />
                                              </button>
                                          </div>
                                      </div>
                                  ) : (
                                      <button 
                                          onClick={handleRealUpload} 
                                          disabled={!project?.youtubeChannelData || isUploading || isRenderingVideo} 
                                          className={`w-full py-4 rounded-xl font-bold shadow-lg transition-all active:scale-95 flex flex-col items-center justify-center gap-1 ${scheduledDate ? 'bg-orange-600 hover:bg-orange-500 shadow-orange-900/20' : 'bg-red-600 hover:bg-red-500 shadow-red-900/20'} disabled:opacity-50`}
                                      >
                                          <div className="flex items-center gap-2">
                                               {isUploading || isRenderingVideo ? <Loader2 className="w-5 h-5 animate-spin" /> : scheduledDate ? <Calendar className="w-5 h-5" /> : <Upload className="w-5 h-5" />} 
                                               <span>{isUploading ? (isRenderingVideo ? 'Renderizando...' : 'Enviando...') : scheduledDate ? 'Agendar no YouTube' : 'Postar no YouTube'}</span>
                                          </div>
                                          {!isUploading && !isRenderingVideo && <span className="text-[10px] opacity-70 font-normal">O vídeo será renderizado automaticamente</span>}
                                      </button>
                                  )}
                             </div>
                         </div>
                     </div>
                </div>
            )}
        </div>

        {/* FLOATING STATUS BAR */}
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
            <div className="bg-[#0B1121]/80 backdrop-blur-xl border border-white/10 rounded-full shadow-2xl px-6 py-2 flex items-center gap-4">
                 <div className="flex items-center gap-2 text-xs font-mono">
                     <div className={`w-2 h-2 rounded-full ${isProcessing ? 'bg-orange-500 animate-pulse' : 'bg-green-500'}`}></div>
                     <span className={isProcessing ? 'text-orange-300' : 'text-slate-400'}>{isProcessing ? processingLabel : 'System Ready'}</span>
                 </div>
                 <div className="h-4 w-px bg-white/10"></div>
                 <div className="flex items-center gap-2">
                     {activeTab==='script' && <button onClick={()=>setIsConfigModalOpen(true)} className="p-1.5 hover:bg-white/10 rounded-full text-slate-400 hover:text-white transition-colors"><Settings className="w-4 h-4"/></button>}
                     {activeTab==='studio' && <button onClick={()=>setIsConfigModalOpen(true)} className="p-1.5 hover:bg-white/10 rounded-full text-slate-400 hover:text-white transition-colors"><Music className="w-4 h-4"/></button>}
                 </div>
            </div>
        </div>

        {/* SUCCESS MODAL */}
        {showSuccessModal && (
            <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-in fade-in duration-300">
                <div className="bg-[#0B1121] border border-green-500/20 rounded-3xl p-8 max-w-md w-full shadow-2xl text-center space-y-6">
                    <div className="w-20 h-20 bg-green-500/10 rounded-full flex items-center justify-center mx-auto border border-green-500/20">
                        <CheckCircle className="w-10 h-10 text-green-500" />
                    </div>
                    <div>
                        <h2 className="text-2xl font-bold text-white">Vídeo Postado!</h2>
                        <p className="text-slate-400 text-sm mt-2">Seu vídeo foi enviado com sucesso para o YouTube.</p>
                    </div>
                    
                    <div className="bg-black/40 p-4 rounded-2xl border border-white/5 space-y-3">
                        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Link do Vídeo</p>
                        <div className="flex items-center gap-2 bg-slate-900 p-2 rounded-lg border border-white/5">
                            <span className="text-xs text-slate-300 truncate flex-1">{showSuccessModal.url}</span>
                            <button 
                                onClick={() => {
                                    navigator.clipboard.writeText(showSuccessModal.url);
                                    // Could add a temporary "Copied!" state here
                                }}
                                className="p-1.5 hover:bg-white/10 rounded-md text-slate-400 hover:text-white transition-colors"
                            >
                                <Copy className="w-4 h-4" />
                            </button>
                        </div>
                    </div>

                    <div className="flex flex-col gap-3">
                        <a 
                            href={showSuccessModal.url} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="w-full py-4 bg-white text-black rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-slate-200 transition-all"
                        >
                            <ExternalLink className="w-5 h-5" /> Abrir no YouTube
                        </a>
                        <button 
                            onClick={() => setShowSuccessModal(null)}
                            className="w-full py-3 text-slate-400 hover:text-white font-medium transition-colors"
                        >
                            Fechar
                        </button>
                    </div>
                </div>
            </div>
        )}

        {/* THUMBNAIL TROUBLESHOOTING MODAL */}
        {showThumbnailTroubleshooting && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-300">
                <div className="bg-[#0F1629] border border-white/10 rounded-3xl p-8 max-w-2xl w-full shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto custom-scrollbar">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <div className="p-3 bg-orange-500/10 rounded-2xl border border-orange-500/20">
                                <ImageIcon className="w-8 h-8 text-orange-400" />
                            </div>
                            <div>
                                <h2 className="text-2xl font-bold text-white">Diagnóstico de Thumbnail</h2>
                                <p className="text-slate-400 text-sm">Por que a geração da imagem pode falhar?</p>
                            </div>
                        </div>
                        <button onClick={() => setShowThumbnailTroubleshooting(false)} className="p-2 hover:bg-white/10 rounded-full transition-colors">
                            <X className="w-6 h-6 text-slate-400" />
                        </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="p-5 bg-black/40 rounded-2xl border border-white/5 space-y-3">
                            <h3 className="text-xs font-bold text-orange-400 uppercase tracking-widest flex items-center gap-2">
                                <Zap className="w-3 h-3" /> 1. Limites de Cota (Quota)
                            </h3>
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                                A geração de imagens consome mais cota da API Gemini. Se você gerou muitas imagens seguidas, pode ter atingido o limite temporário.
                            </p>
                            <div className="p-2 bg-orange-500/5 border border-orange-500/10 rounded-lg">
                                <p className="text-[10px] text-orange-300 italic">Dica: Aguarde alguns minutos ou use uma chave de API diferente.</p>
                            </div>
                        </div>

                        <div className="p-5 bg-black/40 rounded-2xl border border-white/5 space-y-3">
                            <h3 className="text-xs font-bold text-blue-400 uppercase tracking-widest flex items-center gap-2">
                                <Shield className="w-3 h-3" /> 2. Filtros de Segurança
                            </h3>
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                                O Google possui filtros rigorosos para imagens. Se o tema do vídeo for sensível (violência, política pesada, etc), a IA pode recusar a geração.
                            </p>
                            <p className="text-[10px] text-slate-500">Tente simplificar o título do vídeo para algo mais neutro.</p>
                        </div>

                        <div className="p-5 bg-black/40 rounded-2xl border border-white/5 space-y-3">
                            <h3 className="text-xs font-bold text-amber-400 uppercase tracking-widest flex items-center gap-2">
                                <Activity className="w-3 h-3" /> 3. Erro de Conexão
                            </h3>
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                                Imagens são arquivos grandes. Uma oscilação na internet ou timeout no servidor do Google pode interromper o processo.
                            </p>
                        </div>

                        <div className="p-5 bg-black/40 rounded-2xl border border-white/5 space-y-3">
                            <h3 className="text-xs font-bold text-green-400 uppercase tracking-widest flex items-center gap-2">
                                <RefreshCw className="w-3 h-3" /> 4. Formato de Resposta
                            </h3>
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                                O app espera uma imagem em Base64. Se a API retornar um erro inesperado ou formato inválido, a thumbnail não será montada.
                            </p>
                        </div>
                    </div>

                    <div className="p-5 bg-slate-900/50 rounded-2xl border border-white/5 space-y-4">
                        <h3 className="text-sm font-bold text-white">Checklist de Estilo (Clickbait Intermediário)</h3>
                        <div className="space-y-2">
                            <div className="flex items-center gap-3 text-[11px] text-slate-300">
                                <CheckCircle className="w-3 h-3 text-green-500" />
                                <span>Expressões faciais moderadas (sem exageros tipo "boca aberta").</span>
                            </div>
                            <div className="flex items-center gap-3 text-[11px] text-slate-300">
                                <CheckCircle className="w-3 h-3 text-green-500" />
                                <span>Fundo levemente desfocado para destacar o assunto principal.</span>
                            </div>
                            <div className="flex items-center gap-3 text-[11px] text-slate-300">
                                <CheckCircle className="w-3 h-3 text-green-500" />
                                <span>Cores vibrantes e alto contraste, mas com aspecto profissional.</span>
                            </div>
                        </div>
                    </div>

                    <div className="flex gap-3">
                        <button 
                            onClick={() => {
                                clearExhaustedKeys();
                                alert("Status das chaves resetado. Tente gerar a thumbnail novamente.");
                                setShowThumbnailTroubleshooting(false);
                            }}
                            className="flex-1 py-3 bg-orange-600 hover:bg-orange-700 text-white rounded-xl text-xs font-bold transition-all"
                        >
                            Resetar Chaves e Tentar Novamente
                        </button>
                        <button 
                            onClick={() => setShowThumbnailTroubleshooting(false)}
                            className="px-6 py-3 bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10 rounded-xl text-xs transition-all"
                        >
                            Fechar
                        </button>
                    </div>
                </div>
            </div>
        )}

        {/* TROUBLESHOOTING MODAL */}
        {showTroubleshooting && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-300">
                <div className="bg-[#0F1629] border border-white/10 rounded-3xl p-8 max-w-2xl w-full shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto custom-scrollbar">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <div className="p-3 bg-red-500/10 rounded-2xl border border-red-500/20">
                                <AlertTriangle className="w-8 h-8 text-red-400" />
                            </div>
                            <div>
                                <h2 className="text-2xl font-bold text-white">Diagnóstico de Upload</h2>
                                <p className="text-slate-400 text-sm">Por que o envio para o YouTube pode falhar?</p>
                            </div>
                        </div>
                        <button onClick={() => setShowTroubleshooting(false)} className="p-2 hover:bg-white/10 rounded-full transition-colors">
                            <X className="w-6 h-6 text-slate-400" />
                        </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="p-5 bg-black/40 rounded-2xl border border-white/5 space-y-3">
                            <h3 className="text-xs font-bold text-red-400 uppercase tracking-widest flex items-center gap-2">
                                <Shield className="w-3 h-3" /> 1. Permissões (Escopos)
                            </h3>
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                                Ao conectar seu canal, você <strong>DEVE</strong> marcar a caixa de seleção que autoriza o app a "Gerenciar seus vídeos do YouTube".
                            </p>
                            <div className="p-2 bg-red-500/5 border border-red-500/10 rounded-lg">
                                <p className="text-[10px] text-red-300 italic">Dica: Se não marcou, desconecte e conecte novamente nas Configurações.</p>
                            </div>
                        </div>

                        <div className="p-5 bg-black/40 rounded-2xl border border-white/5 space-y-3">
                            <h3 className="text-xs font-bold text-blue-400 uppercase tracking-widest flex items-center gap-2">
                                <Globe className="w-3 h-3" /> 2. Origens JavaScript (CORS)
                            </h3>
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                                No Google Cloud Console, este domínio deve estar listado em <strong>"Origens JavaScript autorizadas"</strong>.
                            </p>
                            <code className="text-[9px] block bg-black/60 p-2 rounded border border-white/10 text-blue-300 break-all">
                                {window.location.origin}
                            </code>
                        </div>

                        <div className="p-5 bg-black/40 rounded-2xl border border-white/5 space-y-3">
                            <h3 className="text-xs font-bold text-amber-400 uppercase tracking-widest flex items-center gap-2">
                                <Zap className="w-3 h-3" /> 3. Limites de Cota (Quota)
                            </h3>
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                                Projetos novos têm cota limitada (~10.000 unidades/dia). Um upload consome ~1.600 unidades.
                            </p>
                            <p className="text-[10px] text-slate-500">Se receber erro 403 Quota, você atingiu o limite diário do Google.</p>
                        </div>

                        <div className="p-5 bg-black/40 rounded-2xl border border-white/5 space-y-3">
                            <h3 className="text-xs font-bold text-green-400 uppercase tracking-widest flex items-center gap-2">
                                <CheckCircle className="w-3 h-3" /> 4. Status da Conta
                            </h3>
                            <ul className="text-[11px] text-slate-400 space-y-1 list-disc pl-4">
                                <li>Canal verificado por telefone?</li>
                                <li>Sem avisos de direitos autorais?</li>
                                <li>Funcionalidade de upload ativa?</li>
                            </ul>
                        </div>
                    </div>

                    <div className="p-5 bg-slate-900/50 rounded-2xl border border-white/5 space-y-4">
                        <h3 className="text-sm font-bold text-white">Checklist Prático</h3>
                        <div className="space-y-2">
                            <div className="flex items-center gap-3 text-[11px] text-slate-300">
                                <div className="w-4 h-4 rounded border border-white/20 flex items-center justify-center text-[8px]">1</div>
                                <span>O Client ID termina em <code>.apps.googleusercontent.com</code>?</span>
                            </div>
                            <div className="flex items-center gap-3 text-[11px] text-slate-300">
                                <div className="w-4 h-4 rounded border border-white/20 flex items-center justify-center text-[8px]">2</div>
                                <span>O escopo <code>youtube.upload</code> está ativo na biblioteca de APIs?</span>
                            </div>
                            <div className="flex items-center gap-3 text-[11px] text-slate-300">
                                <div className="w-4 h-4 rounded border border-white/20 flex items-center justify-center text-[8px]">3</div>
                                <span>O vídeo respeita os formatos aceitos (MP4, WebM)?</span>
                            </div>
                        </div>
                    </div>

                    <div className="flex gap-3">
                        <button 
                            onClick={() => {
                                if (project) updateProject(project.id, { isYoutubeConnected: false, youtubeChannelData: undefined, youtubeAccessToken: undefined });
                                alert("Sessão limpa. Reconecte o canal na aba Settings do projeto.");
                                setShowTroubleshooting(false);
                            }}
                            className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-bold transition-all"
                        >
                            Resetar Conexão e Tentar Novamente
                        </button>
                        <button 
                            onClick={() => setShowTroubleshooting(false)}
                            className="px-6 py-3 bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10 rounded-xl text-xs transition-all"
                        >
                            Fechar
                        </button>
                    </div>
                </div>
            </div>
        )}

        {/* CONFIG MODAL (Portal) */}
        {showCorsHelp && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-300">
                <div className="bg-[#0F1629] border border-white/10 rounded-3xl p-8 max-w-lg w-full shadow-2xl space-y-6">
                    <div className="flex items-center gap-4">
                        <div className="p-3 bg-red-500/10 rounded-2xl border border-red-500/20">
                            <AlertTriangle className="w-8 h-8 text-red-400" />
                        </div>
                        <div>
                            <h2 className="text-2xl font-bold text-white">Erro de CORS Detectado</h2>
                            <p className="text-slate-400 text-sm">O Google bloqueou a conexão do seu domínio.</p>
                        </div>
                    </div>

                    <div className="space-y-4 bg-black/40 p-5 rounded-2xl border border-white/5">
                        <div className="p-3 bg-blue-500/5 border border-blue-500/10 rounded-xl mb-4">
                            <p className="text-[10px] font-bold text-blue-400 uppercase tracking-widest mb-2">Diagnóstico de Configuração</p>
                            <div className="space-y-2">
                                <div>
                                    <label className="text-[9px] text-slate-500 block">Client ID em uso:</label>
                                    <div className="flex flex-col gap-1">
                                        <code className={`text-[10px] break-all bg-black/30 p-1 rounded ${googleClientId && !googleClientId.endsWith('.apps.googleusercontent.com') ? 'text-red-400 border border-red-500/20' : 'text-slate-300'}`}>
                                            {googleClientId || 'Não configurado'}
                                        </code>
                                        {googleClientId && !googleClientId.endsWith('.apps.googleusercontent.com') && (
                                            <p className="text-[8px] text-red-400 flex items-center gap-1">
                                                <AlertTriangle className="w-2 h-2" /> Este ID parece inválido. Deve terminar em .apps.googleusercontent.com
                                            </p>
                                        )}
                                    </div>
                                </div>
                                <p className="text-[9px] text-slate-400 italic">Certifique-se de que este Client ID é o mesmo onde você adicionou o domínio.</p>
                            </div>
                        </div>

                        <div className="space-y-3">
                            <p className="text-sm text-slate-300 leading-relaxed">
                                Para permitir o upload diretamente do seu navegador, você precisa autorizar este domínio no Console do Google Cloud:
                            </p>
                            
                            <ul className="text-[11px] text-slate-400 space-y-2 list-disc pl-4">
                                <li>Verifique se não há <strong>espaços em branco</strong> antes ou depois do domínio no Console.</li>
                                <li>Desative extensões de <strong>AdBlock</strong> ou <strong>Privacidade</strong> temporariamente.</li>
                                <li>O Google pode levar até <strong>5 minutos</strong> para aplicar as mudanças de CORS.</li>
                            </ul>
                        </div>
                        
                        <div className="pt-2">
                            <button 
                                onClick={() => {
                                    if (project) updateProject(project.id, { isYoutubeConnected: false, youtubeChannelData: undefined, youtubeAccessToken: undefined });
                                    alert("Sessão limpa. Reconecte o canal na aba Settings do projeto.");
                                    setShowCorsHelp(false);
                                }}
                                className="w-full py-2 bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10 rounded-xl text-[10px] transition-all"
                            >
                                Limpar Sessão e Tentar Novamente
                            </button>
                        </div>
                        
                        <div className="space-y-2">
                            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Seu Domínio Atual</label>
                            <div className="flex gap-2">
                                <input 
                                    readOnly 
                                    value={window.location.origin} 
                                    className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-green-400 font-mono text-xs"
                                />
                                <button 
                                    onClick={() => {
                                        navigator.clipboard.writeText(window.location.origin);
                                        alert("Copiado!");
                                    }}
                                    className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg border border-slate-700 transition-colors"
                                >
                                    <Copy className="w-4 h-4" />
                                </button>
                            </div>
                        </div>

                        <div className="pt-2">
                            <p className="text-xs text-slate-400 mb-3">
                                1. Vá em <a href="https://console.cloud.google.com/apis/credentials" target="_blank" className="text-blue-400 hover:underline">Google Cloud Console</a>.<br/>
                                2. Edite seu <b>ID do cliente OAuth 2.0</b>.<br/>
                                3. Adicione o domínio acima em <b>"Origens JavaScript autorizadas"</b>.<br/>
                                4. Clique em <b>Salvar</b> e aguarde 2-5 minutos.
                            </p>
                        </div>
                    </div>

                    <div className="flex gap-3">
                        <button 
                            onClick={() => setShowCorsHelp(false)}
                            className="flex-1 py-3 bg-white text-black font-bold rounded-xl hover:bg-slate-200 transition-colors"
                        >
                            Entendi, vou configurar
                        </button>
                    </div>
                </div>
            </div>
        )}

        {/* THUMBNAIL TROUBLESHOOTING MODAL */}
        {showThumbnailTroubleshooting && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-300">
                <div className="bg-[#0F1629] border border-white/10 rounded-3xl p-8 max-w-2xl w-full shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto custom-scrollbar">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <div className="p-3 bg-orange-500/10 rounded-2xl border border-orange-500/20">
                                <ImageIcon className="w-8 h-8 text-orange-400" />
                            </div>
                            <div>
                                <h2 className="text-2xl font-bold text-white">Erro na Thumbnail</h2>
                                <p className="text-slate-400 text-sm">Por que a geração de imagem falhou?</p>
                            </div>
                        </div>
                        <button onClick={() => setShowThumbnailTroubleshooting(false)} className="p-2 hover:bg-white/10 rounded-full transition-colors">
                            <X className="w-6 h-6 text-slate-400" />
                        </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="p-5 bg-black/40 rounded-2xl border border-white/5 space-y-3">
                            <h3 className="text-xs font-bold text-orange-400 uppercase tracking-widest flex items-center gap-2">
                                <Zap className="w-3 h-3" /> 1. Limite de Cota
                            </h3>
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                                A geração de imagens consome muito mais cota da API do que texto. Se você gerou muitas imagens seguidas, pode ter atingido o limite temporário.
                            </p>
                        </div>

                        <div className="p-5 bg-black/40 rounded-2xl border border-white/5 space-y-3">
                            <h3 className="text-xs font-bold text-red-400 uppercase tracking-widest flex items-center gap-2">
                                <Shield className="w-3 h-3" /> 2. Filtros de Segurança
                            </h3>
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                                A IA pode recusar gerar imagens que contenham temas sensíveis, violentos ou protegidos por direitos autorais. Tente ajustar o título do vídeo.
                            </p>
                        </div>

                        <div className="p-5 bg-black/40 rounded-2xl border border-white/5 space-y-3">
                            <h3 className="text-xs font-bold text-blue-400 uppercase tracking-widest flex items-center gap-2">
                                <Globe className="w-3 h-3" /> 3. Conexão e Timeout
                            </h3>
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                                Imagens são arquivos pesados. Se sua internet oscilar ou o servidor do Google demorar a responder, a requisição pode falhar.
                            </p>
                        </div>

                        <div className="p-5 bg-black/40 rounded-2xl border border-white/5 space-y-3">
                            <h3 className="text-xs font-bold text-green-400 uppercase tracking-widest flex items-center gap-2">
                                <CheckCircle className="w-3 h-3" /> 4. Formato de Resposta
                            </h3>
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                                O app espera uma imagem em Base64. Se a API retornar um erro estrutural, a thumbnail não poderá ser montada no canvas.
                            </p>
                        </div>
                    </div>

                    <div className="p-5 bg-slate-900/50 rounded-2xl border border-white/5 space-y-4">
                        <h3 className="text-sm font-bold text-white">Checklist do Estilo Intermediário</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {[
                                'Sujeito principal à direita',
                                'Lado esquerdo livre para texto',
                                'Expressão moderada (não exagerada)',
                                'Fundo com desfoque (bokeh)',
                                'Cores vibrantes e profissionais',
                                'Sem texto gerado pela IA'
                            ].map((item, i) => (
                                <div key={i} className="flex items-center gap-2 text-[10px] text-slate-400">
                                    <Check className="w-3 h-3 text-orange-500" />
                                    <span>{item}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="flex gap-3">
                        <button 
                            onClick={() => {
                                clearExhaustedKeys();
                                alert("Chaves de API resetadas. Tente gerar a thumbnail novamente.");
                                setShowThumbnailTroubleshooting(false);
                            }}
                            className="flex-1 py-3 bg-orange-600 hover:bg-orange-700 text-white rounded-xl text-xs font-bold transition-all"
                        >
                            Resetar Chaves e Tentar Novamente
                        </button>
                        <button 
                            onClick={() => setShowThumbnailTroubleshooting(false)}
                            className="px-6 py-3 bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10 rounded-xl text-xs transition-all"
                        >
                            Fechar
                        </button>
                    </div>
                </div>
            </div>
        )}

        {isConfigModalOpen && createPortal(
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setIsConfigModalOpen(false)}></div>
                <div className="relative bg-[#0F1629] border border-white/10 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
                    <div className="bg-white/5 p-4 border-b border-white/5 flex justify-between items-center">
                        <h3 className="font-bold text-white flex items-center gap-2"><Sliders className="w-4 h-4" /> Configuration</h3>
                        <button onClick={() => setIsConfigModalOpen(false)}><X className="w-4 h-4 text-slate-400" /></button>
                    </div>
                    <div className="p-6 space-y-4">
                        {activeTab === 'script' && (
                             <>
                                <label className="text-xs font-bold text-slate-400 uppercase">Tone</label>
                                <select value={scriptTone} onChange={(e) => setScriptTone(e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-white text-sm outline-none">{TONE_OPTIONS.map(t=><option key={t} value={t}>{t}</option>)}</select>
                                <label className="text-xs font-bold text-slate-400 uppercase">Context</label>
                                <textarea value={scriptContext} onChange={(e)=>setScriptContext(e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-white text-sm h-24 outline-none" />
                                <button onClick={handleGenerateScript} className="w-full bg-orange-600 text-white py-3 rounded-lg font-bold mt-2">Generate Script</button>
                             </>
                        )}
                        {(activeTab === 'audio') && (
                             <>
                                <label className="text-xs font-bold text-slate-400 uppercase">Voice</label>
                                <select value={selectedVoice} onChange={(e) => setSelectedVoice(e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-white text-sm outline-none">{VOICE_OPTIONS.map(v=><option key={v.id} value={v.id}>{v.label}</option>)}</select>
                                <button onClick={handleGenerateAudio} className="w-full bg-orange-600 text-white py-3 rounded-lg font-bold mt-2">Generate Audio</button>
                             </>
                        )}
                    </div>
                </div>
            </div>,
            document.body
        )}
    </div>
  );
};