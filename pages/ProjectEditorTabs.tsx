/**
 * ProjectEditorTabs.tsx
 *
 * Contains the five tab sub-components extracted from ProjectEditor.
 * Each component receives only the props it actually needs — no god-object
 * "pass everything" pattern. The parent (ProjectEditor) owns all state and
 * handlers; these components are pure presentational + callback receivers.
 *
 * Tabs:
 *   ScriptTab   — storyboard cards, narrator editing, auto-fill
 *   AudioTab    — waveform player, regenerate, next step
 *   VisualsTab  — storyboard grid, per-segment regeneration
 *   StudioTab   — canvas preview player, music controls
 *   PublishTab  — export, thumbnail, metadata editor, YouTube upload
 */

import React from 'react';
import {
  FileText, Mic, Image as ImageIcon, Upload, Loader2, Play,
  Pause, Music, Download, Volume2, VolumeX, Wand2,
  RefreshCw, ArrowRight, Youtube, Film,
  Calendar, FileVideo, Video, Hash, Tag, ExternalLink, Copy,
  AlertCircle, HelpCircle, RotateCcw, CheckCircle, Eye, AlignLeft,
  Sparkles, X,
} from 'lucide-react';
import { Project, Video as VideoType, VisualEffect } from '../types';

// ── Local helpers (preview-only, not for render) ──────────────────────────────

const applyVisualFilter = (
  ctx: CanvasRenderingContext2D,
  filterType: 'none' | 'bw' | 'high-contrast' | 'sepia' | 'saturate'
) => {
  if (filterType === 'none') { ctx.filter = 'none'; return; }
  if (filterType === 'saturate') ctx.filter = 'saturate(150%) contrast(1.1)';
  else if (filterType === 'bw') ctx.filter = 'grayscale(100%) contrast(1.2)';
  else if (filterType === 'high-contrast') ctx.filter = 'contrast(1.5) saturate(1.2)';
  else if (filterType === 'sepia') ctx.filter = 'sepia(0.8) contrast(1.1)';
};

const formatTime = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const YOUTUBE_CATEGORIES = [
  { id: '24', name: 'Entertainment' }, { id: '1', name: 'Film & Animation' },
  { id: '10', name: 'Music' }, { id: '20', name: 'Gaming' },
  { id: '22', name: 'People & Blogs' }, { id: '25', name: 'News & Politics' },
  { id: '26', name: 'Howto & Style' }, { id: '27', name: 'Education' },
  { id: '28', name: 'Science & Technology' }, { id: '17', name: 'Sports' },
  { id: '19', name: 'Travel & Events' },
];

const EmptyState: React.FC<{
  icon: React.ElementType; title: string; description: string;
  actionLabel: string; onClick: () => void; isLoading?: boolean;
}> = ({ icon: Icon, title, description, actionLabel, onClick, isLoading }) => (
  <div className="flex flex-col items-center justify-center text-center p-12">
    <div className="w-24 h-24 bg-white/5 rounded-full flex items-center justify-center mb-6 border border-white/10">
      <Icon className="w-10 h-10 text-slate-500" />
    </div>
    <h3 className="text-2xl font-bold text-white mb-3">{title}</h3>
    <p className="text-slate-400 max-w-md mb-8 leading-relaxed text-base">{description}</p>
    <button onClick={onClick} disabled={isLoading}
      className="bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white px-8 py-4 rounded-xl font-bold flex items-center gap-2 active:scale-95">
      {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Wand2 className="w-5 h-5" />}
      {isLoading ? 'Processing...' : actionLabel}
    </button>
  </div>
);

// ── ScriptTab ─────────────────────────────────────────────────────────────────

export interface ScriptTabProps {
  video: VideoType;
  project: Project;
  isAutoFillingNarrator: boolean;
  generatingNarratorIndex: number | null;
  previewingSegmentAudio: number | null;
  onOpenConfig: () => void;
  onAutoFillNarrator: () => void;
  onGenerateSingleNarrator: (idx: number) => void;
  onPreviewSegment: (idx: number, text: string) => void;
  onUpdateScriptSegment: (idx: number, text: string) => void;
}

export const ScriptTab: React.FC<ScriptTabProps> = ({
  video, project, isAutoFillingNarrator, generatingNarratorIndex,
  previewingSegmentAudio, onOpenConfig, onAutoFillNarrator,
  onGenerateSingleNarrator, onPreviewSegment, onUpdateScriptSegment,
}) => {
  if (!video.script) {
    return (
      <div className="py-20 border border-dashed border-white/10 rounded-3xl bg-white/5">
        <EmptyState icon={FileText} title="Blueprint Missing"
          description="Configure your narrative parameters to generate the video script."
          actionLabel="Generate Script" onClick={onOpenConfig} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="bg-[#0F1629]/50 backdrop-blur border border-white/5 rounded-2xl p-6">
        <h2 className="text-xl font-bold text-white mb-2">{video.script.title}</h2>
        <p className="text-slate-400 leading-relaxed text-sm mb-4">{video.script.description}</p>
        {video.script.ambientMusicDescription && (
          <div className="bg-blue-500/5 border border-blue-500/10 rounded-xl p-4 flex items-start gap-3">
            <div className="bg-blue-500/20 p-2 rounded-lg"><Music className="w-4 h-4 text-blue-400" /></div>
            <div>
              <h4 className="text-[10px] font-bold text-blue-400 uppercase tracking-wider mb-1">Ambient Music Direction</h4>
              <p className="text-xs text-blue-200/70 italic">{video.script.ambientMusicDescription}</p>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-bold text-white">Storyboard & Script</h3>
          {video.script.estimatedDurationMinutes && (
            <span className={`text-[10px] font-mono px-2 py-1 rounded ${video.script.durationWarning ? 'bg-yellow-500/20 text-yellow-400' : 'bg-green-500/20 text-green-400'}`}>
              ~{video.script.estimatedDurationMinutes.toFixed(1)} min • {video.script.totalWords || '?'} palavras
            </span>
          )}
        </div>
        <button onClick={onAutoFillNarrator} disabled={isAutoFillingNarrator}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-xl border border-slate-700 flex items-center gap-2 transition-all">
          {isAutoFillingNarrator ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-orange-400" />}
          Auto-Fill Narration
        </button>
      </div>

      <div className="relative">
        <div className="flex overflow-x-auto gap-4 pb-8 custom-scrollbar snap-x px-1">
          <div className="flex-shrink-0 w-8" />
          {video.script.segments.map((segment, idx) => {
            const relatedScene = video.visualScenes?.find(s => s.segmentIndex === idx);
            return (
              <div key={idx} className="flex-shrink-0 w-[400px] snap-center flex flex-col group">
                <div className="bg-[#0F1629] border border-white/10 rounded-2xl overflow-hidden shadow-xl hover:border-orange-500/50 transition-all flex flex-col h-full">
                  <div className="bg-white/5 p-4 flex justify-between items-center border-b border-white/5">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono text-slate-500">#{String(idx + 1).padStart(2, '0')}</span>
                      <h4 className="font-bold text-white text-sm truncate max-w-[200px]">{segment.sectionTitle}</h4>
                    </div>
                    <span className="text-[10px] font-mono bg-black/40 px-2 py-1 rounded text-slate-400">{segment.estimatedDuration}s</span>
                  </div>
                  <div className="p-4 flex flex-col gap-4 flex-1">
                    <div className="bg-orange-500/5 border border-orange-500/10 rounded-xl p-3">
                      <div className="flex items-center gap-2 text-[10px] font-bold text-orange-400 uppercase tracking-wider mb-2">
                        <Eye className="w-3 h-3" /> Visual Prompt
                      </div>
                      {relatedScene && <img src={relatedScene.imageUrl} className="w-full h-32 rounded-lg object-cover border border-white/10 mb-2" alt="" />}
                      <div className="space-y-1">
                        {(segment.visualDescriptions || []).map((p, pIdx) => (
                          <p key={pIdx} className="text-[10px] text-orange-200/50 leading-tight italic line-clamp-1 border-l border-orange-500/20 pl-2">{p}</p>
                        ))}
                      </div>
                    </div>
                    <div className="relative flex-1">
                      <div className="flex justify-between items-center mb-1">
                        <div className="flex items-center gap-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                          <AlignLeft className="w-3 h-3" /> Narrator
                        </div>
                        <div className="flex items-center gap-1">
                          <button onClick={() => onGenerateSingleNarrator(idx)} disabled={generatingNarratorIndex === idx}
                            className="text-slate-500 hover:text-orange-400 p-1 transition-colors">
                            {generatingNarratorIndex === idx ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                          </button>
                          <button onClick={() => onPreviewSegment(idx, segment.narratorText)} disabled={previewingSegmentAudio === idx}
                            className="text-slate-500 hover:text-orange-400 p-1">
                            {previewingSegmentAudio === idx ? <Loader2 className="w-3 h-3 animate-spin" /> : <Volume2 className="w-3 h-3" />}
                          </button>
                        </div>
                      </div>
                      <textarea
                        className="w-full h-32 bg-transparent text-slate-300 text-sm leading-relaxed border border-slate-800 rounded-lg p-3 resize-none focus:border-orange-500/50 outline-none"
                        value={segment.narratorText}
                        onChange={e => onUpdateScriptSegment(idx, e.target.value)}
                        placeholder="Narrator text goes here..."
                      />
                    </div>
                    {segment.soundEffects && segment.soundEffects.length > 0 && (
                      <div className="bg-slate-800/30 rounded-xl p-3 border border-white/5">
                        <div className="flex items-center gap-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">
                          <Volume2 className="w-3 h-3" /> Sound Effects
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {segment.soundEffects.map((sfx, sfxIdx) => (
                            <span key={sfxIdx} className="text-[9px] bg-slate-800 text-slate-400 px-2 py-1 rounded-md border border-white/5">{sfx}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          <div className="flex-shrink-0 w-8" />
        </div>
      </div>
    </div>
  );
};

// ── AudioTab ──────────────────────────────────────────────────────────────────

export interface AudioTabProps {
  video: VideoType;
  isPlaying: boolean;
  playbackTime: number;
  totalDurationState: number;
  onPlay: () => void;
  onStop: () => void;
  onOpenConfig: () => void;
  onNextTab: () => void;
}

export const AudioTab: React.FC<AudioTabProps> = ({
  video, isPlaying, playbackTime, totalDurationState,
  onPlay, onStop, onOpenConfig, onNextTab,
}) => {
  if (!video.audioUrl) {
    return (
      <div className="py-20 border border-dashed border-white/10 rounded-3xl bg-white/5">
        <EmptyState icon={Mic} title="Audio Missing"
          description="Synthesize the AI narration based on your script."
          actionLabel="Generate Audio" onClick={onOpenConfig} />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center p-12 bg-gradient-to-br from-orange-900/10 via-[#0F1629] to-[#0F1629] border border-white/5 rounded-3xl shadow-2xl">
      <div className="w-24 h-24 bg-orange-500/20 rounded-full flex items-center justify-center mb-6 relative">
        <div className="absolute inset-0 border-2 border-orange-500/30 rounded-full animate-ping opacity-20" />
        <Mic className="w-10 h-10 text-orange-400" />
      </div>
      <h3 className="text-3xl font-bold text-white mb-2">Audio Mastered</h3>
      <p className="text-slate-400 mb-8">Voiceover track is ready.</p>
      <div className="bg-black/30 backdrop-blur rounded-2xl p-6 w-full max-w-xl border border-white/10 flex items-center gap-6 mb-8">
        <button onClick={isPlaying ? onStop : onPlay}
          className="w-14 h-14 rounded-full bg-orange-600 hover:bg-orange-500 text-white flex items-center justify-center shadow-lg shadow-orange-600/30 transition-all hover:scale-105 active:scale-95">
          {isPlaying ? <Pause className="w-6 h-6 fill-current" /> : <Play className="w-6 h-6 fill-current ml-1" />}
        </button>
        <div className="flex-1 space-y-2">
          <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
            <div className="h-full bg-orange-500 transition-all duration-100 ease-linear"
              style={{ width: `${totalDurationState > 0 ? (playbackTime / totalDurationState) * 100 : 0}%` }} />
          </div>
          <div className="flex justify-between text-xs font-mono text-slate-500">
            <span>{formatTime(playbackTime)}</span>
            <span>{formatTime(totalDurationState)}</span>
          </div>
        </div>
      </div>
      <div className="flex gap-4">
        <button onClick={onNextTab}
          className="px-8 py-3 bg-white text-black rounded-xl font-bold hover:bg-slate-200 transition-colors shadow-lg flex items-center gap-2">
          Next: Visuals <ArrowRight className="w-4 h-4" />
        </button>
        <button onClick={onOpenConfig}
          className="px-6 py-3 border border-white/10 text-slate-300 rounded-xl font-medium hover:bg-white/5 transition-colors">
          Regenerate
        </button>
      </div>
    </div>
  );
};

// ── VisualsTab ────────────────────────────────────────────────────────────────

export interface VisualsTabProps {
  video: VideoType;
  isShort: boolean;
  isGeneratingVisuals: boolean;
  onGenerateAll: () => void;
  onOpenStudio: () => void;
}

export const VisualsTab: React.FC<VisualsTabProps> = ({
  video, isShort, isGeneratingVisuals, onGenerateAll, onOpenStudio,
}) => {
  if (!video.visualScenes || video.visualScenes.length === 0) {
    return (
      <div className="py-20 border border-dashed border-white/10 rounded-3xl bg-white/5">
        <EmptyState icon={ImageIcon} title="Visuals Missing"
          description="Generate cinematic AI scenes for each segment."
          actionLabel="Generate All Scenes" onClick={onGenerateAll} isLoading={isGeneratingVisuals} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-end">
        <h3 className="text-xl font-bold text-white">Storyboard</h3>
        <button onClick={onOpenStudio}
          className="px-6 py-3 bg-orange-600 hover:bg-orange-500 text-white font-bold rounded-xl flex items-center gap-2 active:scale-95">
          <Play className="w-5 h-5" /> Open Studio
        </button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {video.visualScenes.map((scene, idx) => (
          <div key={idx} className={`bg-slate-900 rounded-xl overflow-hidden border border-white/10 relative group hover:border-orange-500/50 transition-all ${isShort ? 'aspect-[9/16]' : 'aspect-square'}`}>
            <img src={scene.imageUrl} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" alt="" />
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3">
              <p className="text-[10px] text-white line-clamp-2">{scene.prompt}</p>
            </div>
            <div className="absolute top-2 left-2 bg-black/60 px-2 py-0.5 rounded text-[10px] text-white font-mono">#{idx + 1}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ── StudioTab ─────────────────────────────────────────────────────────────────

export interface StudioTabProps {
  video: VideoType;
  isShort: boolean;
  isSquare: boolean;
  playerClass: string;
  isPlaying: boolean;
  playbackTime: number;
  totalDurationState: number;
  isMusicEnabled: boolean;
  musicVolume: number;
  isGeneratingMusic: boolean;
  currentSegmentIndex: number;
  lastValidImage: string | null;
  studioCanvasRef: React.RefObject<HTMLCanvasElement>;
  onPlay: () => void;
  onStop: () => void;
  onToggleMusic: () => void;
  onGenerateMusic: () => void;
}

export const StudioTab: React.FC<StudioTabProps> = ({
  video, isShort, isSquare, playerClass, isPlaying,
  playbackTime, totalDurationState, isMusicEnabled, isGeneratingMusic,
  currentSegmentIndex, lastValidImage, studioCanvasRef,
  onPlay, onStop, onToggleMusic, onGenerateMusic,
}) => (
  <div className="flex flex-col items-center">
    <div className={`${playerClass} bg-black relative rounded-t-2xl border-t border-x border-slate-700 shadow-2xl overflow-hidden group`}>
      <div className="absolute inset-0 flex items-center justify-center bg-black overflow-hidden isolate">
        <div className="absolute inset-0 pointer-events-none bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 z-20 mix-blend-overlay" />
        {lastValidImage && (
          <div className="absolute inset-0 z-10 bg-black">
            <img src={lastValidImage} className="w-full h-full object-cover blur-sm opacity-50 scale-105" alt="" />
          </div>
        )}
        <canvas
          ref={studioCanvasRef}
          width={isShort ? 1080 : 1920}
          height={isShort ? 1920 : 1080}
          className="w-full h-full object-contain z-10"
        />
        {video.script?.segments[currentSegmentIndex] && (
          <div className={`absolute bottom-10 left-0 right-0 p-8 text-center z-30 transition-all duration-500 ${isPlaying ? 'opacity-100' : 'opacity-0'}`}>
            <span className="bg-black/60 backdrop-blur-md px-6 py-3 rounded-xl text-white text-lg font-medium border border-white/10">
              {video.script.segments[currentSegmentIndex]?.narratorText}
            </span>
          </div>
        )}
      </div>
      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-40 bg-black/20">
        <button onClick={isPlaying ? onStop : onPlay}
          className="w-20 h-20 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center hover:bg-white/20 transition-all">
          {isPlaying ? <Pause className="w-8 h-8 fill-white text-white" /> : <Play className="w-8 h-8 fill-white text-white ml-1" />}
        </button>
      </div>
    </div>
    <div className="w-full max-w-5xl bg-[#0B1121] border border-slate-700 rounded-b-2xl p-4 flex items-center justify-between shadow-xl">
      <div className="flex items-center gap-4 text-slate-400">
        <div className="flex items-center gap-2 font-mono text-sm">
          <span className="text-white">{formatTime(playbackTime)}</span>
          <span className="opacity-50">/</span>
          <span>{formatTime(totalDurationState)}</span>
        </div>
      </div>
      <div className="flex items-center gap-4">
        <button onClick={onToggleMusic}
          className={`p-2 rounded-lg transition-colors ${isMusicEnabled ? 'text-orange-400 bg-orange-500/10' : 'text-slate-600'}`}>
          {isMusicEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
        </button>
        <button onClick={onGenerateMusic}
          className="text-xs font-bold text-slate-400 hover:text-white flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white/5 border border-transparent hover:border-white/10 transition-all">
          {isGeneratingMusic ? <Loader2 className="w-3 h-3 animate-spin" /> : <Music className="w-3 h-3" />} Ambience
        </button>
      </div>
    </div>
  </div>
);

// ── PublishTab ────────────────────────────────────────────────────────────────

export interface PublishTabProps {
  video: VideoType;
  project: Project;
  isRenderingVideo: boolean;
  renderStatus: string;
  renderProgress: number;
  isUploading: boolean;
  uploadProgress: number;
  uploadError: string | null;
  thumbnailError: string | null;
  isGeneratingThumbnail: boolean;
  isGeneratingMetadata: boolean;
  scheduledDate: string;
  onRenderAndDownload: () => void;
  onRealUpload: () => void;
  onGenerateThumbnail: () => void;
  onGenerateMetadata: () => void;
  onScheduledDateChange: (date: string) => void;
  onDismissUploadError: () => void;
  onDismissThumbnailError: () => void;
  onShowTroubleshooting: () => void;
  onShowThumbnailTroubleshooting: () => void;
  onUpdateVideoMetadata: (field: string, value: any) => void;
  onClearYoutubeUrl: () => void;
}

export const PublishTab: React.FC<PublishTabProps> = ({
  video, project, isRenderingVideo, renderStatus, renderProgress,
  isUploading, uploadProgress, uploadError, thumbnailError,
  isGeneratingThumbnail, isGeneratingMetadata, scheduledDate,
  onRenderAndDownload, onRealUpload, onGenerateThumbnail, onGenerateMetadata,
  onScheduledDateChange, onDismissUploadError, onDismissThumbnailError,
  onShowTroubleshooting, onShowThumbnailTroubleshooting,
  onUpdateVideoMetadata, onClearYoutubeUrl,
}) => (
  <div className="grid grid-cols-1 md:grid-cols-2 gap-8 py-8">
    {/* LEFT — LOCAL EXPORT */}
    <div className="bg-[#0F1629]/80 border border-white/5 rounded-3xl p-8 flex flex-col justify-between">
      <div>
        <div className="w-12 h-12 bg-orange-500/20 rounded-xl flex items-center justify-center mb-6">
          <Download className="w-6 h-6 text-orange-400" />
        </div>
        <h3 className="text-2xl font-bold text-white mb-2">Local Export</h3>
        <p className="text-slate-400 mb-6">Render the full video mix in-browser and download to your device.</p>
      </div>
      <div className="space-y-4">
        {/* Thumbnail */}
        {video.thumbnailUrl ? (
          <div className="relative group rounded-xl overflow-hidden border border-slate-700 shadow-lg aspect-video">
            <img src={video.thumbnailUrl} alt="Thumbnail" className="w-full h-full object-cover" />
            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
              <a href={video.thumbnailUrl} download={`${video.title}_thumb.jpg`}
                className="p-2 bg-white text-black rounded-full hover:scale-110 transition-transform">
                <Download className="w-5 h-5" />
              </a>
              <button onClick={onGenerateThumbnail} disabled={isGeneratingThumbnail}
                className="p-2 bg-white text-black rounded-full hover:scale-110 transition-transform">
                {isGeneratingThumbnail ? <Loader2 className="w-5 h-5 animate-spin" /> : <RefreshCw className="w-5 h-5" />}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <button onClick={onGenerateThumbnail} disabled={isGeneratingThumbnail}
              className="w-full py-3 rounded-xl border border-white/10 text-slate-300 hover:bg-white/5 font-bold flex items-center justify-center gap-2">
              {isGeneratingThumbnail ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4" />} Generate Thumb
            </button>
            {thumbnailError && (
              <div className="p-3 bg-orange-500/10 border border-orange-500/20 rounded-xl flex items-start gap-3">
                <AlertCircle className="w-4 h-4 text-orange-500 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-[10px] text-orange-400 font-medium">{thumbnailError}</p>
                  <div className="flex items-center gap-3 mt-1">
                    <button onClick={onDismissThumbnailError} className="text-[9px] text-orange-500/70 underline">Dispensar</button>
                    <button onClick={onShowThumbnailTroubleshooting} className="text-[9px] text-blue-400 font-bold flex items-center gap-1">
                      <HelpCircle className="w-3 h-3" /> Guia
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <button onClick={onRenderAndDownload} disabled={isRenderingVideo}
          className="w-full py-4 rounded-xl bg-white text-black font-bold hover:bg-slate-200 transition-colors flex flex-col items-center justify-center gap-1 shadow-lg">
          <div className="flex items-center gap-2">
            {isRenderingVideo ? <Loader2 className="w-5 h-5 animate-spin" /> : <Video className="w-5 h-5" />}
            <span>{isRenderingVideo ? 'Rendering Video...' : 'Download Master File'}</span>
          </div>
          {isRenderingVideo && <span className="text-[10px] font-mono text-slate-500">{renderStatus} ({renderProgress}%)</span>}
        </button>
      </div>
    </div>

    {/* RIGHT — YOUTUBE */}
    <div className="bg-gradient-to-br from-red-900/10 to-[#0F1629] border border-red-500/10 rounded-3xl p-8 flex flex-col justify-between">
      <div>
        <div className="w-12 h-12 bg-red-600/20 rounded-xl flex items-center justify-center mb-6">
          <Youtube className="w-6 h-6 text-red-500" />
        </div>
        <h3 className="text-2xl font-bold text-white mb-2">YouTube Sync</h3>
        <p className="text-slate-400 mb-6">Upload diretamente para o seu canal conectado.</p>

        {/* Checklist */}
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

        {/* Metadata editor */}
        <button onClick={onGenerateMetadata} disabled={isGeneratingMetadata}
          className="w-full py-2.5 mb-4 rounded-xl border border-white/10 text-slate-300 hover:bg-white/5 text-xs font-bold flex items-center justify-center gap-2">
          {isGeneratingMetadata ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-orange-400" />}
          {isGeneratingMetadata ? 'Gerando SEO...' : 'Gerar SEO com IA'}
        </button>

        {video.videoMetadata && (
          <div className="space-y-3 mb-4 p-4 bg-black/40 rounded-xl border border-white/5">
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Title</label>
                <span className={`text-[10px] ${video.videoMetadata.youtubeTitle.length > 100 ? 'text-red-500' : 'text-slate-600'}`}>{video.videoMetadata.youtubeTitle.length}/100</span>
              </div>
              <input className="w-full bg-transparent text-white font-bold text-sm border-b border-white/10 pb-1 focus:outline-none focus:border-orange-500 transition-colors"
                value={video.videoMetadata.youtubeTitle}
                onChange={e => onUpdateVideoMetadata('youtubeTitle', e.target.value)} />
            </div>
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Description</label>
                <span className={`text-[10px] ${video.videoMetadata.youtubeDescription.length > 5000 ? 'text-red-500' : 'text-slate-600'}`}>{video.videoMetadata.youtubeDescription.length}/5000</span>
              </div>
              <textarea className="w-full bg-transparent text-slate-400 text-xs h-24 resize-none focus:outline-none border border-transparent focus:border-orange-500/30 rounded p-1"
                value={video.videoMetadata.youtubeDescription}
                onChange={e => onUpdateVideoMetadata('youtubeDescription', e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 block">Visibility</label>
                <select className="w-full bg-slate-900 text-slate-300 text-xs rounded border border-white/10 p-1.5 focus:outline-none focus:border-orange-500"
                  value={video.videoMetadata.visibility || 'private'}
                  onChange={e => onUpdateVideoMetadata('visibility', e.target.value)}>
                  <option value="public">Public</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="private">Private</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 block">Category</label>
                <select className="w-full bg-slate-900 text-slate-300 text-xs rounded border border-white/10 p-1.5 focus:outline-none focus:border-orange-500"
                  value={video.videoMetadata.categoryId || '24'}
                  onChange={e => onUpdateVideoMetadata('categoryId', e.target.value)}>
                  {YOUTUBE_CATEGORIES.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 block">Format</label>
              <div className="flex items-center gap-2 h-[30px]">
                <button onClick={() => onUpdateVideoMetadata('isShorts', true)}
                  className={`flex-1 h-full rounded text-[10px] font-bold transition-colors ${video.videoMetadata?.isShorts ? 'bg-red-600 text-white' : 'bg-slate-800 text-slate-400'}`}>
                  SHORTS
                </button>
                <button onClick={() => onUpdateVideoMetadata('isShorts', false)}
                  className={`flex-1 h-full rounded text-[10px] font-bold transition-colors ${!video.videoMetadata?.isShorts ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400'}`}>
                  VIDEO
                </button>
              </div>
            </div>
            <div>
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                <Tag className="w-3 h-3" /> Tags
              </label>
              <input className="w-full bg-transparent text-slate-400 text-xs border-b border-white/10 pb-1 focus:outline-none focus:border-orange-500"
                value={video.videoMetadata.tags?.join(', ') || ''}
                onChange={e => onUpdateVideoMetadata('tags', e.target.value.split(',').map(t => t.trim()).filter(Boolean))}
                placeholder="tag1, tag2..." />
            </div>
          </div>
        )}

        {/* Upload progress */}
        {isUploading && (
          <div className="space-y-2 mb-4">
            <div className="flex justify-between text-[10px] text-slate-400 font-mono">
              <span className="flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                {isRenderingVideo ? 'Renderizando para Upload...' : 'Enviando para o YouTube...'}
              </span>
              <span>{isRenderingVideo ? renderProgress : uploadProgress}%</span>
            </div>
            <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-red-600 to-red-400 transition-all duration-300"
                style={{ width: `${isRenderingVideo ? renderProgress : uploadProgress}%` }} />
            </div>
          </div>
        )}

        {/* Upload error */}
        {uploadError && (
          <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3 mb-4">
            <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-xs text-red-400 font-medium">{uploadError}</p>
              <div className="flex items-center gap-3 mt-1">
                <button onClick={onDismissUploadError} className="text-[10px] text-red-500/70 underline">Dispensar</button>
                <button onClick={onShowTroubleshooting} className="text-[10px] text-blue-400 font-bold flex items-center gap-1">
                  <HelpCircle className="w-3 h-3" /> Guia de Solução
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Schedule input */}
        {!isUploading && !isRenderingVideo && (
          <div className="flex flex-col gap-1 mb-4">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1">
              <Calendar className="w-3 h-3" /> Agendar (Opcional)
            </label>
            <input type="datetime-local" value={scheduledDate} onChange={e => onScheduledDateChange(e.target.value)}
              className="bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-white text-xs w-full focus:outline-none focus:border-red-500 transition-colors" />
          </div>
        )}

        {/* Upload CTA */}
        {video.youtubeUrl ? (
          <div className="space-y-3">
            <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-xl flex flex-col items-center gap-3">
              <CheckCircle className="w-6 h-6 text-green-500" />
              <div className="text-center">
                <p className="text-green-400 font-bold text-sm">Postado com Sucesso!</p>
                <p className="text-[10px] text-green-500/70">Seu vídeo já está no YouTube.</p>
              </div>
              <div className="flex gap-2 w-full">
                <a href={video.youtubeUrl} target="_blank" rel="noopener noreferrer"
                  className="flex-1 py-2 bg-white text-black rounded-lg text-xs font-bold flex items-center justify-center gap-2 hover:bg-slate-200">
                  <ExternalLink className="w-3 h-3" /> Ver no YouTube
                </a>
                <button onClick={() => navigator.clipboard.writeText(video.youtubeUrl!)}
                  className="p-2 bg-white/10 text-white rounded-lg hover:bg-white/20" title="Copiar Link">
                  <Copy className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={onRealUpload} disabled={isUploading || isRenderingVideo}
                className="flex-1 py-3 rounded-xl border border-white/10 text-slate-500 hover:text-slate-300 text-xs font-medium">
                Postar Novamente
              </button>
              <button onClick={onClearYoutubeUrl}
                className="px-4 py-3 rounded-xl border border-white/10 text-slate-500 hover:text-red-400 text-xs font-medium">
                <RotateCcw className="w-4 h-4" />
              </button>
            </div>
          </div>
        ) : (
          <button onClick={onRealUpload} disabled={!project?.youtubeChannelData || isUploading || isRenderingVideo}
            className={`w-full py-4 rounded-xl font-bold shadow-lg transition-all active:scale-95 flex flex-col items-center justify-center gap-1 ${scheduledDate ? 'bg-orange-600 hover:bg-orange-500' : 'bg-red-600 hover:bg-red-500'} disabled:opacity-50`}>
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
);
