import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useProjects } from '../context/ProjectContext';
import { useAuth } from '../context/AuthContext';
import { ProjectStatus, VideoDuration, ProjectIdea, LibraryItemType, VideoFormat, VisualPacingStyle } from '../types';
import { generateVoiceover, decodeAudioData, generateVideoIdeas, VideoIdea } from '../services/geminiService';
import { 
    ArrowLeft, Film, Clock, FileText, Mic, Image as ImageIcon, 
    MoreVertical, Play, Calendar, Save, Trash2, AlertOctagon, 
    User, LogOut, CheckCircle, Youtube, Plus, X, Loader2, Volume2, Globe, Timer, BarChart3, MessageSquare, Sparkles, Lightbulb, ArrowRight, Ban, RefreshCw, History, BrainCircuit, Bot, BookOpen, Link as LinkIcon, File, UploadCloud, MonitorPlay, ChevronDown, ChevronUp, Zap
} from 'lucide-react';

const statusConfig = {
  [ProjectStatus.DRAFT]: { color: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-700/50', label: 'Draft' },
  [ProjectStatus.SCRIPTING]: { color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20', label: 'Scripting' },
  [ProjectStatus.AUDIO_GENERATED]: { color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/20', label: 'Audio Ready' },
  [ProjectStatus.VIDEO_GENERATED]: { color: 'text-pink-400', bg: 'bg-pink-500/10', border: 'border-pink-500/20', label: 'Video Ready' },
  [ProjectStatus.SCHEDULED]: { color: 'text-yellow-400', bg: 'bg-yellow-500/10', border: 'border-yellow-500/20', label: 'Scheduled' },
  [ProjectStatus.PUBLISHED]: { color: 'text-green-400', bg: 'bg-green-500/10', border: 'border-green-500/20', label: 'Published' },
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
    'Suspenseful & Dark (Horror)',
    'Children\'s Story (Kids/Fairy Tale)', // Added tone
    'True Crime Analysis (Serious)',
    'Educational & Explanatory (Clear)',
    'Documentary Style (Formal)',
    'Fast-paced Facts (Viral/Shorts)',
    'Enthusiastic Vlog (Personal)',
    'Calm & Cozy (ASMR/Relax)',
    'Motivational & Energetic (Coach)',
    'Tech Reviewer (Crisp & Critical)',
    'High-Energy Gaming (Loud)',
    'Professional Business (Corporate)',
    'Urban Legend Storyteller (Folklore)'
];

const LANGUAGE_OPTIONS = [
    'Portuguese (BR)',
    'English (US)',
    'English (UK)',
    'Spanish (ES)',
    'Spanish (MX)',
    'French',
    'German',
    'Italian',
    'Japanese',
    'Korean'
];

const FORMAT_OPTIONS: VideoFormat[] = [
    'Landscape 16:9',
    'Portrait 9:16 (Shorts)',
    'Square 1:1'
];

export const ProjectHub: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { getProject, updateProject, deleteProject, addVideo, deleteVideo, updateIdeaStatus, saveGeneratedIdeas, removeIdeaFromHistory, addLibraryItem, deleteLibraryItem } = useProjects();
  const { user, googleClientId, isLoading: isAuthLoading } = useAuth();
  
  const navigate = useNavigate();
  const project = getProject(id || '');
  
  const [activeTab, setActiveTab] = useState<'videos' | 'ideas' | 'library' | 'assets' | 'settings'>('videos');
  const [isVideoModalOpen, setIsVideoModalOpen] = useState(false);
  const [isLibraryModalOpen, setIsLibraryModalOpen] = useState(false);
  const [videoToDelete, setVideoToDelete] = useState<string | null>(null);
  const [isDeletingProject, setIsDeletingProject] = useState(false);
  const [libraryItemToDelete, setLibraryItemToDelete] = useState<string | null>(null);
  
  // Settings Edit State
  const [editTitle, setEditTitle] = useState(project?.title || '');
  const [editTheme, setEditTheme] = useState(project?.channelTheme || '');
  const [editTone, setEditTone] = useState(project?.defaultTone || 'Suspenseful and Dark');
  const [editVoice, setEditVoice] = useState(project?.defaultVoice || 'Fenrir');
  const [editLanguage, setEditLanguage] = useState(project?.language || 'Portuguese (BR)');
  const [editDuration, setEditDuration] = useState<VideoDuration>(project?.defaultDuration || 'Standard (5-8 min)');
  const [editFormat, setEditFormat] = useState<VideoFormat>(project?.defaultFormat || 'Landscape 16:9');
  const [editGeminiPercent, setEditGeminiPercent] = useState(project?.visualSourceMix?.geminiPercentage ?? 50);
  const [editPexelsPercent, setEditPexelsPercent] = useState(project?.visualSourceMix?.pexelsPercentage ?? 50);
  const [editMinImages, setEditMinImages] = useState(project?.visualPacing?.minImagesPer5Sec ?? 1);
  const [editMaxImages, setEditMaxImages] = useState(project?.visualPacing?.maxImagesPer5Sec ?? 2);
  const [editStyle, setEditStyle] = useState<VisualPacingStyle>(project?.visualPacing?.style ?? 'dynamic');
  
  // Schedule Edit State
  const [editFreq, setEditFreq] = useState(project?.scheduleSettings?.frequencyDays || 1);
  const [editTimeStart, setEditTimeStart] = useState(project?.scheduleSettings?.timeWindowStart || '13:00');
  const [editTimeEnd, setEditTimeEnd] = useState(project?.scheduleSettings?.timeWindowEnd || '15:00');
  const [editAutoGenerate, setEditAutoGenerate] = useState(project?.scheduleSettings?.autoGenerate || false);
  
  const [isSaving, setIsSaving] = useState(false);
  const [isPreviewingVoice, setIsPreviewingVoice] = useState(false);
  
  // UI State for Description
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);

  // New Video State
  const [newVideoTopic, setNewVideoTopic] = useState('');
  const [newVideoDuration, setNewVideoDuration] = useState<VideoDuration>('Standard (5-8 min)');
  const [newVideoFormat, setNewVideoFormat] = useState<VideoFormat>('Landscape 16:9');
  const [newVideoContext, setNewVideoContext] = useState('');

  // Library State
  const [newItemTitle, setNewItemTitle] = useState('');
  const [newItemType, setNewItemType] = useState<LibraryItemType>('text');
  const [newItemContent, setNewItemContent] = useState('');
  const [uploadingFile, setUploadingFile] = useState(false);

  // Idea Generation State
  const [isGeneratingIdeas, setIsGeneratingIdeas] = useState(false);

  // Derived State from Persisted Ideas
  const availableIdeas = project?.ideas?.filter(i => i.status === 'new') || [];
  const usedIdeas = project?.ideas?.filter(i => i.status === 'used') || [];
  const dismissedIdeas = project?.ideas?.filter(i => i.status === 'dismissed') || [];

  if (!project) return <div className="p-10 text-center text-slate-500">Project not found</div>;

  const handleOpenVideoModal = () => {
      setNewVideoDuration(project.defaultDuration || 'Standard (5-8 min)');
      setNewVideoFormat(project.defaultFormat || 'Landscape 16:9');
      setNewVideoContext('');
      setNewVideoTopic('');
      setIsVideoModalOpen(true);
  };

  const handleUseIdea = (idea: ProjectIdea) => {
      setNewVideoTopic(idea.topic);
      setNewVideoContext(idea.specificContext || idea.context);
      setNewVideoDuration(project.defaultDuration || 'Standard (5-8 min)');
      setNewVideoFormat(project.defaultFormat || 'Landscape 16:9');
      setIsVideoModalOpen(true);
  };

  const handleDismissIdea = (idea: ProjectIdea) => {
      updateIdeaStatus(project.id, idea.id, 'dismissed');
  };

  const handleRestoreIdea = (idea: ProjectIdea) => {
      updateIdeaStatus(project.id, idea.id, 'new');
  };

  const handleRemoveLegacyHistory = (ideaStr: string) => {
      removeIdeaFromHistory(project.id, ideaStr);
  };

  const handleGenerateIdeas = async () => {
      if (isGeneratingIdeas) return;
      setIsGeneratingIdeas(true);
      
      // Safety timeout to prevent UI hang
      const timeoutId = setTimeout(() => {
          setIsGeneratingIdeas(false);
      }, 45000); // 45s safety

      try {
          const excludeList = project.ideas 
            ? project.ideas.map(i => i.topic) 
            : (project.usedIdeas || []);
          
          // Gather Library Context
          const libraryContext = project.library?.map(item => {
            const prefix = item.type === 'youtube_channel' ? 'YOUTUBE_REFERENCE_CHANNEL' : item.type?.toUpperCase() || 'INFO';
            return `[${prefix}] ${item.title}: ${item.content}`;
        }).join('\n') || '';

          const ideas = await generateVideoIdeas(
              project.channelTheme, 
              project.description || '', 
              project.defaultTone,
              project.language, 
              excludeList,
              libraryContext // Pass library info
          );
          
          if (ideas && ideas.length > 0) {
              saveGeneratedIdeas(project.id, ideas);
          } else {
              alert("AI returned no new ideas. Try adding more context to your Library.");
          }
      } catch (e: any) {
          console.error("Failed to generate ideas", e);
          alert(`Could not generate ideas: ${e.message || 'Unknown error'}`);
      } finally {
          clearTimeout(timeoutId);
          setIsGeneratingIdeas(false);
      }
  };

    const handleGeminiPercentChange = (val: number) => {
        setEditGeminiPercent(val);
        setEditPexelsPercent(100 - val);
    };

    const handlePexelsPercentChange = (val: number) => {
        setEditPexelsPercent(val);
        setEditGeminiPercent(100 - val);
    };

    const handleSaveSettings = () => {
        setIsSaving(true);
        updateProject(project.id, {
            title: editTitle,
            channelTheme: editTheme,
            defaultTone: editTone,
            defaultVoice: editVoice,
            language: editLanguage,
            defaultDuration: editDuration,
            defaultFormat: editFormat,
            visualSourceMix: {
                geminiPercentage: editGeminiPercent,
                pexelsPercentage: editPexelsPercent
            },
            visualPacing: {
                minImagesPer5Sec: editMinImages,
                maxImagesPer5Sec: editMaxImages,
                style: editStyle
            },
            scheduleSettings: {
                frequencyDays: Number(editFreq),
                timeWindowStart: editTimeStart,
                timeWindowEnd: editTimeEnd,
                autoGenerate: editAutoGenerate
            }
        });
        setTimeout(() => setIsSaving(false), 500);
    };

  const handlePreviewVoice = async () => {
      if (isPreviewingVoice) return;
      setIsPreviewingVoice(true);
      try {
          const buffer = await generateVoiceover(`Esta é uma prévia da voz usando a API do Gemini.`, editVoice);
          const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
          const audioBuffer = await decodeAudioData(buffer, ctx);
          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(ctx.destination);
          source.start(0);
          
          source.onended = () => {
              setIsPreviewingVoice(false);
              ctx.close();
          };
      } catch (e) {
          console.error("Preview failed", e);
          setIsPreviewingVoice(false);
      }
  };

  const handleDeleteProject = () => {
      setIsDeletingProject(true);
  };

  const confirmDeleteProject = () => {
      deleteProject(project.id);
      navigate('/projects');
  };

  const handleDeleteVideo = (e: React.MouseEvent, videoId: string) => {
      e.preventDefault();
      e.stopPropagation();
      setVideoToDelete(videoId);
  };

  const confirmDeleteVideo = () => {
      if (videoToDelete) {
          deleteVideo(project.id, videoToDelete);
          setVideoToDelete(null);
      }
  };

  const handleCreateVideo = (e: React.FormEvent) => {
      e.preventDefault();
      if(!newVideoTopic) return;

      const video = addVideo(project.id, newVideoTopic, newVideoDuration, newVideoFormat, newVideoContext);
      setIsVideoModalOpen(false);
      setNewVideoTopic('');
      setNewVideoContext('');
      navigate(`/project/${project.id}/video/${video.id}/editor`);
  };

  const handleConnectChannel = async () => {
      if (!user) {
          alert("Faça login primeiro nas Configurações.");
          return;
      }
      const activeClientId = googleClientId?.trim();
      if (!activeClientId) {
          alert("Configure o Google Client ID nas Configurações primeiro.");
          return;
      }
      if (typeof (window as any).google === 'undefined') {
          alert("Google Scripts não carregados. Recarregue a página.");
          return;
      }
      const goog = (window as any).google;
      const client = goog.accounts.oauth2.initTokenClient({
          client_id: activeClientId,
          scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
          callback: async (tokenResponse: any) => {
              if (tokenResponse && tokenResponse.access_token) {
                  const token = tokenResponse.access_token;
                  try {
                      const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', {
                          headers: { Authorization: `Bearer ${token}` }
                      });
                      if (!res.ok) throw new Error("YouTube API Error");
                      const data = await res.json();
                      if (data.items?.length > 0) {
                          const ch = data.items[0];
                          const channelData = {
                              id: ch.id,
                              title: ch.snippet.title,
                              thumbnailUrl: ch.snippet.thumbnails.default.url,
                              subscriberCount: ch.statistics.subscriberCount
                          };
                          updateProject(project.id, { 
                              isYoutubeConnected: true, 
                              youtubeChannelData: channelData,
                              youtubeAccessToken: token
                          });
                      } else {
                          alert("Nenhum canal YouTube encontrado nesta conta Google.");
                      }
                  } catch (e) {
                      console.error(e);
                      alert("Falha ao buscar dados do canal.");
                  }
              }
          },
      });
      client.requestAccessToken();
  };
  
  const handleDisconnectChannel = () => {
      // Revoke token if possible
      const token = project.youtubeAccessToken;
      if (token && typeof (window as any).google !== 'undefined') {
          try { (window as any).google.accounts.oauth2.revoke(token, () => {}); } catch (e) {}
      }
      updateProject(project.id, { 
          isYoutubeConnected: false, 
          youtubeChannelData: undefined, 
          youtubeAccessToken: undefined 
      });
  };

  // LIBRARY HANDLERS
  const handleAddLibraryItem = (e: React.FormEvent) => {
      e.preventDefault();
      if (!newItemTitle || !newItemContent) return;
      addLibraryItem(project.id, newItemTitle, newItemType, newItemContent);
      setIsLibraryModalOpen(false);
      setNewItemTitle('');
      setNewItemContent('');
      setNewItemType('text');
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setUploadingFile(true);
      
      // Auto-set title from filename
      setNewItemTitle(file.name);

      const reader = new FileReader();
      reader.onload = (event) => {
          if (event.target?.result) {
              setNewItemContent(event.target.result as string);
              setUploadingFile(false);
          }
      };
      reader.onerror = () => {
          alert("Error reading file. Please ensure it is a text-based file (.txt, .md, .csv, .json, etc).");
          setUploadingFile(false);
      };
      reader.readAsText(file);
  };

  const handleDeleteLibraryItem = (itemId: string) => {
      setLibraryItemToDelete(itemId);
  };

  const confirmDeleteLibraryItem = () => {
      if (libraryItemToDelete) {
          deleteLibraryItem(project.id, libraryItemToDelete);
          setLibraryItemToDelete(null);
      }
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        
        {/* Header Section */}
        <div className="flex flex-col gap-4">
            <button onClick={() => navigate('/projects')} className="flex items-center gap-2 text-slate-500 hover:text-white transition-colors w-fit group">
                <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                Back to Library
            </button>
            
            <div className="flex flex-col md:flex-row justify-between items-start gap-4 border-b border-slate-800 pb-6">
                <div className="flex-1 min-w-0">
                    <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">{project.title}</h1>
                    
                    {/* Expandable Description */}
                    <div className="relative group">
                        <div 
                            className={`text-slate-400 text-sm leading-relaxed max-w-4xl transition-all duration-300 ${isDescriptionExpanded ? '' : 'line-clamp-3'}`}
                        >
                            {project.description || "No description provided."}
                        </div>
                        {project.description && project.description.length > 200 && (
                            <button 
                                onClick={() => setIsDescriptionExpanded(!isDescriptionExpanded)}
                                className="mt-1 text-xs font-bold text-orange-400 hover:text-orange-300 flex items-center gap-1 transition-colors"
                            >
                                {isDescriptionExpanded ? (
                                    <>Show Less <ChevronUp className="w-3 h-3" /></>
                                ) : (
                                    <>Read More <ChevronDown className="w-3 h-3" /></>
                                )}
                            </button>
                        )}
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 md:gap-4 text-xs md:text-sm text-slate-500 flex-shrink-0 mt-2 md:mt-0">
                    {project.language && (
                        <div className="flex items-center gap-1.5 bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-800 text-orange-200/80">
                            <Globe className="w-3.5 h-3.5 text-orange-500" />
                            {project.language}
                        </div>
                    )}
                    <div className="flex items-center gap-1.5 bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-800">
                        <Calendar className="w-3.5 h-3.5" />
                        Created: {new Date(project.createdAt).toLocaleDateString()}
                    </div>
                </div>
            </div>
        </div>

        {/* Content Tabs */}
        <div className="w-full overflow-x-auto custom-scrollbar">
            <div className="flex gap-6 border-b border-slate-800/50 min-w-max px-2">
                <button 
                    onClick={() => setActiveTab('videos')}
                    className={`pb-3 border-b-2 font-medium text-sm transition-colors ${activeTab === 'videos' ? 'border-orange-500 text-orange-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
                >
                    Videos
                </button>
                <button 
                    onClick={() => setActiveTab('ideas')}
                    className={`pb-3 border-b-2 font-medium text-sm transition-colors ${activeTab === 'ideas' ? 'border-orange-500 text-orange-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
                >
                    AI Brainstorming
                </button>
                <button 
                    onClick={() => setActiveTab('library')}
                    className={`pb-3 border-b-2 font-medium text-sm transition-colors ${activeTab === 'library' ? 'border-orange-500 text-orange-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
                >
                    Biblioteca
                </button>
                <button 
                    onClick={() => setActiveTab('assets')}
                    className={`pb-3 border-b-2 font-medium text-sm transition-colors ${activeTab === 'assets' ? 'border-orange-500 text-orange-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
                >
                    Channel Assets
                </button>
                <button 
                    onClick={() => setActiveTab('settings')}
                    className={`pb-3 border-b-2 font-medium text-sm transition-colors ${activeTab === 'settings' ? 'border-orange-500 text-orange-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
                >
                    Settings
                </button>
            </div>
        </div>

        {/* TAB CONTENT: VIDEOS */}
        {activeTab === 'videos' && (
            <div className="space-y-8 animate-in fade-in zoom-in duration-300">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    
                    {/* Create New Video Card */}
                    <button 
                        onClick={handleOpenVideoModal}
                        className="border border-dashed border-slate-800 rounded-xl flex flex-col items-center justify-center p-6 text-slate-600 hover:text-orange-400 hover:border-orange-500/30 hover:bg-slate-900/30 transition-all group h-full min-h-[250px]"
                    >
                        <div className="w-12 h-12 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                            <Plus className="w-6 h-6" />
                        </div>
                        <span className="font-medium text-sm">Create New Video</span>
                        <span className="text-xs opacity-50 mt-1">Add to {project.title}</span>
                    </button>

                    {/* List Videos */}
                    {project.videos.map((video) => {
                        const status = statusConfig[video.status];
                        const hasThumbnail = video.visualScenes && video.visualScenes.length > 0;
                        const thumbnail = hasThumbnail ? video.visualScenes![0].imageUrl : null;
                        const isShort = video.format && video.format.includes('9:16');

                        return (
                            <Link to={`/project/${project.id}/video/${video.id}/editor`} key={video.id} className="group relative bg-[#0F1629] border border-slate-800 rounded-xl overflow-hidden hover:border-orange-500/40 hover:shadow-xl transition-all duration-300">
                                <div className={`relative overflow-hidden bg-slate-950 ${isShort ? 'h-64 flex items-center justify-center' : 'h-40'}`}>
                                    {thumbnail ? (
                                        <img src={thumbnail} className={`w-full h-full object-cover opacity-60 group-hover:opacity-90 transition-opacity group-hover:scale-105 duration-700 ${isShort ? 'max-w-[50%]' : ''}`} />
                                    ) : (
                                        <div className="w-full h-full bg-gradient-to-br from-slate-900 via-orange-950/30 to-slate-900 flex items-center justify-center">
                                            <Film className="w-8 h-8 text-slate-700 group-hover:text-orange-500/50 transition-colors" />
                                        </div>
                                    )}
                                    <div className="absolute top-3 left-3">
                                        <span className={`px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider backdrop-blur-md border shadow-lg ${status.bg} ${status.color} ${status.border}`}>
                                            {status.label}
                                        </span>
                                    </div>
                                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-black/20 backdrop-blur-[1px]">
                                        <div className="w-10 h-10 bg-white/10 rounded-full flex items-center justify-center backdrop-blur-md border border-white/20 text-white shadow-lg">
                                            <Play className="w-4 h-4 fill-current ml-0.5" />
                                        </div>
                                    </div>
                                </div>
                                <div className="p-4">
                                    <div className="flex justify-between items-start mb-2">
                                        <h3 className="font-bold text-white text-lg leading-tight group-hover:text-orange-400 transition-colors line-clamp-2">{video.title}</h3>
                                        <button 
                                            onClick={(e) => handleDeleteVideo(e, video.id)}
                                            className="text-slate-600 hover:text-red-400 transition-colors p-1"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                    <div className="flex items-center gap-3 text-xs text-slate-500 mb-4">
                                        <span className="bg-slate-900 px-2 py-0.5 rounded border border-slate-800">{video.targetDuration.split(' ')[0]}</span>
                                        <span className="bg-slate-900 px-2 py-0.5 rounded border border-slate-800">{video.format ? video.format.split(' ')[0] : '16:9'}</span>
                                        <span>Edited {new Date(video.updatedAt).toLocaleDateString()}</span>
                                    </div>
                                    <div className="flex items-center gap-4 border-t border-slate-800 pt-3">
                                        <div className={`flex items-center gap-1.5 text-xs ${video.script ? 'text-orange-400' : 'text-slate-600'}`}>
                                            <FileText className="w-3.5 h-3.5" />
                                            <span>Script</span>
                                        </div>
                                        <div className={`flex items-center gap-1.5 text-xs ${video.audioUrl ? 'text-orange-400' : 'text-slate-600'}`}>
                                            <Mic className="w-3.5 h-3.5" />
                                            <span>Voice</span>
                                        </div>
                                        <div className={`flex items-center gap-1.5 text-xs ${video.visualScenes?.length ? 'text-orange-400' : 'text-slate-600'}`}>
                                            <ImageIcon className="w-3.5 h-3.5" />
                                            <span>Visuals</span>
                                        </div>
                                    </div>
                                </div>
                            </Link>
                        );
                    })}
                </div>
            </div>
        )}

        {/* ... (Ideas, Library, Assets tabs unchanged, keeping code implicit) */}
        {/* TAB CONTENT: IDEAS */}
        {activeTab === 'ideas' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
                {/* AI BRAINSTORMING SECTION */}
                <div className="bg-gradient-to-r from-orange-950/30 to-amber-950/30 border border-orange-500/20 rounded-2xl p-6 relative overflow-hidden transition-all duration-300 hover:shadow-[0_0_40px_-10px_rgba(249,115,22,0.15)]">
                    <div className="absolute top-0 right-0 w-64 h-64 bg-orange-500/5 rounded-full blur-[80px] -translate-y-1/2 translate-x-1/2"></div>
                    
                    <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6 relative z-10">
                        <div>
                            <h3 className="text-lg font-bold text-white flex items-center gap-2">
                                <BrainCircuit className="w-6 h-6 text-orange-400" />
                                AI Content Brainstorm
                            </h3>
                            <p className="text-sm text-slate-400 mt-1">Get fresh video concepts tailored to your niche. <span className="text-orange-400">Uses your Library context automatically.</span></p>
                        </div>
                        <button 
                            onClick={handleGenerateIdeas}
                            disabled={isGeneratingIdeas}
                            className="w-full md:w-auto flex items-center justify-center gap-2 bg-orange-600 hover:bg-orange-500 text-white px-4 py-2 rounded-xl text-sm font-bold shadow-lg shadow-orange-600/20 transition-all disabled:opacity-50 active:scale-95"
                        >
                            {isGeneratingIdeas ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                            {isGeneratingIdeas ? 'Thinking...' : availableIdeas.length > 0 ? 'Generate More' : 'Generate Ideas'}
                        </button>
                    </div>

                    {availableIdeas.length > 0 ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 relative z-10 animate-in fade-in slide-in-from-top-4 duration-300">
                            {availableIdeas.map((idea) => (
                                <div key={idea.id} className="bg-slate-900/80 backdrop-blur border border-slate-700/50 rounded-xl p-4 hover:border-orange-500/40 transition-colors group relative flex flex-col justify-between h-full">
                                    <div>
                                        <h4 className="font-bold text-slate-200 text-sm mb-2">{idea.topic}</h4>
                                        <p className="text-xs text-slate-400 leading-relaxed mb-4">{idea.context}</p>
                                    </div>
                                    <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                                        <button 
                                            onClick={() => handleDismissIdea(idea)}
                                            className="text-[10px] text-slate-500 hover:text-red-400 px-2 py-1 rounded hover:bg-red-500/10 transition-colors flex items-center gap-1"
                                            title="Dismiss this idea"
                                        >
                                            <Ban className="w-3 h-3" /> Dismiss
                                        </button>
                                        <button 
                                            onClick={() => handleUseIdea(idea)}
                                            className="text-[10px] bg-orange-500/10 text-orange-400 px-3 py-1.5 rounded border border-orange-500/20 hover:bg-orange-500 hover:text-white transition-all flex items-center gap-1 font-bold"
                                        >
                                            Use this Idea <ArrowRight className="w-3 h-3" />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        !isGeneratingIdeas && (
                            <div className="text-center py-8 text-slate-500 text-sm relative z-10">
                                <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-20" />
                                Press "Generate Ideas" to start brainstorming.
                            </div>
                        )
                    )}
                </div>

                {/* CONTROL BOX - HISTORY */}
                <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-6">
                    <div className="flex items-center gap-3 mb-6">
                        <div className="p-2 bg-slate-800 rounded-lg">
                            <History className="w-5 h-5 text-slate-400" />
                        </div>
                        <div>
                            <h3 className="text-lg font-bold text-white">History & Exclusions</h3>
                            <p className="text-sm text-slate-400">
                                These topics are marked as "Used" or "Dismissed" and will be <span className="text-red-400">excluded</span> from future AI suggestions.
                            </p>
                        </div>
                    </div>

                    {/* Combine usedIdeas from object array AND legacy array for complete view */}
                    {usedIdeas.length === 0 && dismissedIdeas.length === 0 && (!project.usedIdeas || project.usedIdeas.length === 0) ? (
                        <div className="text-center py-10 text-slate-500 text-sm italic border-2 border-dashed border-slate-800 rounded-xl">
                            No brainstorming history yet.
                        </div>
                    ) : (
                        <div className="overflow-x-auto rounded-xl border border-slate-800">
                            <table className="w-full text-left text-sm text-slate-400 min-w-[500px]">
                                <thead className="bg-slate-950 text-slate-200 uppercase text-xs font-bold tracking-wider">
                                    <tr>
                                        <th className="px-6 py-3">Topic</th>
                                        <th className="px-6 py-3">Status</th>
                                        <th className="px-6 py-3 text-right">Action</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800 bg-slate-900/50">
                                    {/* New Object History */}
                                    {[...usedIdeas, ...dismissedIdeas].map((idea) => (
                                        <tr key={idea.id} className="hover:bg-slate-800/50 transition-colors">
                                            <td className="px-6 py-3 font-medium text-slate-300">{idea.topic}</td>
                                            <td className="px-6 py-3">
                                                <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded ${idea.status === 'used' ? 'bg-orange-500/10 text-orange-400' : 'bg-red-500/10 text-red-400'}`}>
                                                    {idea.status}
                                                </span>
                                            </td>
                                            <td className="px-6 py-3 text-right">
                                                <button 
                                                    onClick={() => handleRestoreIdea(idea)}
                                                    className="text-xs text-slate-500 hover:text-white hover:underline flex items-center justify-end gap-1 ml-auto"
                                                    title="Restore to Available"
                                                >
                                                    <RefreshCw className="w-3 h-3" /> Restore
                                                </button>
                                            </td>
                                        </tr>
                                    ))}

                                    {/* Legacy Strings History */}
                                    {project.usedIdeas?.filter(legacyIdea => !project.ideas?.some(i => i.topic === legacyIdea)).map((idea, idx) => (
                                        <tr key={`legacy-${idx}`} className="hover:bg-slate-800/50 transition-colors">
                                            <td className="px-6 py-3 font-medium text-slate-300">{idea}</td>
                                            <td className="px-6 py-3">
                                                <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-slate-700 text-slate-400">
                                                    Legacy
                                                </span>
                                            </td>
                                            <td className="px-6 py-3 text-right">
                                                <button 
                                                    onClick={() => handleRemoveLegacyHistory(idea)}
                                                    className="text-xs text-red-400 hover:text-red-300 hover:underline flex items-center justify-end gap-1 ml-auto"
                                                    title="Remove from exclusion list"
                                                >
                                                    <Trash2 className="w-3 h-3" /> Remove
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        )}

        {/* TAB CONTENT: LIBRARY (NEW) */}
        {activeTab === 'library' && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                <div className="flex justify-between items-start">
                    <div>
                        <h2 className="text-xl font-bold text-white flex items-center gap-2">
                            <BookOpen className="w-6 h-6 text-orange-400" />
                            Knowledge Base & Library
                        </h2>
                        <p className="text-sm text-slate-400 mt-1 max-w-2xl">
                            Add reference materials, branding guidelines, and competitor channel analysis. 
                            The AI uses this context for brainstorming AND thumbnail visual identity.
                        </p>
                    </div>
                    <button 
                        onClick={() => setIsLibraryModalOpen(true)}
                        className="bg-orange-600 hover:bg-orange-500 text-white px-4 py-2 rounded-xl text-sm font-bold shadow-lg shadow-orange-600/20 transition-all flex items-center gap-2 flex-shrink-0"
                    >
                        <Plus className="w-4 h-4" /> Add Item
                    </button>
                </div>

                {/* Quick-add suggestions */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <button 
                        onClick={() => { setNewItemType('youtube_channel'); setNewItemTitle(''); setNewItemContent(''); setIsLibraryModalOpen(true); }}
                        className="flex items-center gap-3 p-3 bg-red-500/5 border border-red-500/20 rounded-xl hover:bg-red-500/10 transition-colors text-left group"
                    >
                        <div className="p-2 rounded-lg bg-red-500/10"><Youtube className="w-4 h-4 text-red-400" /></div>
                        <div>
                            <p className="text-sm font-bold text-slate-200 group-hover:text-white">Inspiração de Canal</p>
                            <p className="text-[10px] text-slate-500">Analise o estilo de outros canais para se inspirar</p>
                        </div>
                    </button>
                    <button 
                        onClick={() => { setNewItemType('reference'); setNewItemTitle('Identidade Visual'); setNewItemContent(''); setIsLibraryModalOpen(true); }}
                        className="flex items-center gap-3 p-3 bg-purple-500/5 border border-purple-500/20 rounded-xl hover:bg-purple-500/10 transition-colors text-left group"
                    >
                        <div className="p-2 rounded-lg bg-purple-500/10"><Sparkles className="w-4 h-4 text-purple-400" /></div>
                        <div>
                            <p className="text-sm font-bold text-slate-200 group-hover:text-white">Identidade Visual</p>
                            <p className="text-[10px] text-slate-500">Cores, fontes e estilo do canal para thumbnails</p>
                        </div>
                    </button>
                    <button 
                        onClick={() => { setNewItemType('text'); setNewItemTitle(''); setNewItemContent(''); setIsLibraryModalOpen(true); }}
                        className="flex items-center gap-3 p-3 bg-blue-500/5 border border-blue-500/20 rounded-xl hover:bg-blue-500/10 transition-colors text-left group"
                    >
                        <div className="p-2 rounded-lg bg-blue-500/10"><FileText className="w-4 h-4 text-blue-400" /></div>
                        <div>
                            <p className="text-sm font-bold text-slate-200 group-hover:text-white">Nota de Pesquisa</p>
                            <p className="text-[10px] text-slate-500">Adicione contexto para o brainstorming de ideias</p>
                        </div>
                    </button>
                </div>

                {!project.library || project.library.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 border border-dashed border-slate-800 rounded-xl bg-slate-900/20 text-slate-500">
                        <BookOpen className="w-10 h-10 mb-3 opacity-50" />
                        <p>Nenhum material de referência adicionado.</p>
                        <p className="text-xs mt-1">Adicione canais de inspiração, identidade visual ou notas de pesquisa.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {project.library.map((item) => (
                            <div key={item.id} className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-colors group">
                                <div className="flex justify-between items-start mb-2">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <div className={`p-1.5 rounded-lg flex-shrink-0 ${
                                            item.type === 'link' ? 'bg-blue-500/10 text-blue-400' :
                                            item.type === 'youtube_channel' ? 'bg-red-500/10 text-red-400' :
                                            item.type === 'book' ? 'bg-amber-500/10 text-amber-400' :
                                            item.type === 'file' ? 'bg-green-500/10 text-green-400' :
                                            item.type === 'reference' ? 'bg-purple-500/10 text-purple-400' :
                                            'bg-slate-700 text-slate-300'
                                        }`}>
                                            {item.type === 'link' ? <LinkIcon className="w-4 h-4" /> : 
                                             item.type === 'youtube_channel' ? <Youtube className="w-4 h-4" /> :
                                             item.type === 'book' ? <BookOpen className="w-4 h-4" /> : 
                                             item.type === 'file' ? <File className="w-4 h-4" /> :
                                             item.type === 'reference' ? <Sparkles className="w-4 h-4" /> :
                                             <FileText className="w-4 h-4" />}
                                        </div>
                                        <h4 className="font-bold text-slate-200 text-sm truncate">{item.title}</h4>
                                    </div>
                                    <button 
                                        onClick={() => handleDeleteLibraryItem(item.id)}
                                        className="text-slate-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                                <div className="text-xs text-slate-400 leading-relaxed line-clamp-4 bg-slate-950/50 p-2 rounded border border-slate-800/50 font-mono break-all">
                                    {item.content}
                                </div>
                                <div className="mt-2 flex justify-between items-center text-[10px]">
                                    <span className={`uppercase tracking-wider font-bold ${
                                        item.type === 'youtube_channel' ? 'text-red-500' :
                                        item.type === 'reference' ? 'text-purple-500' :
                                        'text-slate-600'
                                    }`}>
                                        {item.type === 'youtube_channel' ? '🎬 Inspiração' : 
                                         item.type === 'reference' ? '🎨 Branding' :
                                         item.type}
                                    </span>
                                    <span className="text-slate-600">{new Date(item.createdAt).toLocaleDateString()}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        )}

        {/* TAB CONTENT: ASSETS */}
        {activeTab === 'assets' && (
            <div className="flex flex-col items-center justify-center py-20 border border-dashed border-slate-800 rounded-xl bg-slate-900/20 text-slate-500 animate-in fade-in zoom-in duration-300">
                <ImageIcon className="w-10 h-10 mb-3 opacity-50" />
                <p>Channel Asset Library (Logos, Intros, Outros) coming soon.</p>
            </div>
        )}

        {/* TAB CONTENT: SETTINGS */}
        {activeTab === 'settings' && (
            <div className="max-w-3xl animate-in fade-in slide-in-from-right-4 duration-300 space-y-8">
                {/* Account Integration */}
                <div className="space-y-6 bg-slate-900/40 p-6 rounded-2xl border border-slate-800">
                    <h2 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
                        <User className="w-5 h-5 text-orange-400" />
                        Account Integration
                    </h2>
                    
                    <div className="p-4 rounded-xl border border-slate-800 bg-slate-950/50 flex flex-col md:flex-row md:items-center justify-between gap-6">
                        <div className="flex items-center gap-4">
                            <div className={`w-12 h-12 rounded-full flex items-center justify-center overflow-hidden flex-shrink-0 ${project.youtubeChannelData ? 'bg-black' : 'bg-slate-800'}`}>
                                {project.youtubeChannelData ? (
                                    <img src={project.youtubeChannelData.thumbnailUrl} alt={project.youtubeChannelData.title} className="w-full h-full object-cover" />
                                ) : (
                                    <Youtube className="w-6 h-6 text-slate-500" />
                                )}
                            </div>
                            <div>
                                <h3 className="font-bold text-white text-lg">YouTube Channel</h3>
                                {project.youtubeChannelData ? (
                                    <div className="flex flex-col">
                                        <div className="flex items-center gap-1 text-xs text-green-400 mt-1">
                                            <CheckCircle className="w-3 h-3" />
                                            <span>Connected: {project.youtubeChannelData.title}</span>
                                        </div>
                                        <span className="text-[10px] text-slate-500 mt-0.5">{project.youtubeChannelData.subscriberCount} Subscribers</span>
                                    </div>
                                ) : (
                                    <p className="text-sm text-slate-400">Conecte um canal exclusivo para este projeto.</p>
                                )}
                            </div>
                        </div>
                        
                        <div>
                            {project.youtubeChannelData ? (
                                <button 
                                    onClick={handleDisconnectChannel}
                                    className="flex items-center gap-2 px-4 py-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-lg text-sm font-medium transition-colors border border-red-500/20 w-full justify-center md:w-auto"
                                >
                                    <LogOut className="w-4 h-4" />
                                    Desconectar
                                </button>
                            ) : (
                                <button 
                                    onClick={handleConnectChannel}
                                    disabled={!user || isAuthLoading}
                                    className="flex items-center gap-2 px-6 py-2.5 bg-white text-black hover:bg-slate-200 rounded-lg text-sm font-bold transition-colors shadow-lg shadow-white/5 disabled:opacity-50 w-full justify-center md:w-auto"
                                >
                                    {isAuthLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Youtube className="w-4 h-4 text-red-600" />}
                                    Conectar Canal
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* Posting Schedule */}
                <div className="space-y-6 bg-slate-900/40 p-6 rounded-2xl border border-slate-800">
                    <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                        <BarChart3 className="w-5 h-5 text-orange-400" />
                        Posting Cadence
                    </h2>
                    <p className="text-sm text-slate-400 mb-6">Define how often you want to post videos. The scheduler will automatically pick random times within your window.</p>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Frequency</label>
                            <div className="relative">
                                <select 
                                    value={editFreq} 
                                    onChange={(e) => setEditFreq(Number(e.target.value))}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-white appearance-none focus:ring-2 focus:ring-orange-500 outline-none"
                                >
                                    <option value={1}>Every Day (Daily)</option>
                                    <option value={2}>Every 2 Days</option>
                                    <option value={3}>Every 3 Days</option>
                                    <option value={7}>Every Week (7 Days)</option>
                                </select>
                                <Clock className="w-4 h-4 text-slate-500 absolute right-4 top-3.5 pointer-events-none" />
                            </div>
                        </div>
                        
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Start Time Window</label>
                            <input 
                                type="time" 
                                value={editTimeStart}
                                onChange={(e) => setEditTimeStart(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-orange-500 outline-none"
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">End Time Window</label>
                            <input 
                                type="time" 
                                value={editTimeEnd}
                                onChange={(e) => setEditTimeEnd(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-orange-500 outline-none"
                            />
                        </div>
                    </div>

                    {/* Auto-Generation Toggle */}
                    <div className="flex items-center justify-between bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                        <div className="flex items-center gap-3">
                            <div className={`p-2 rounded-lg ${editAutoGenerate ? 'bg-orange-500/20 text-orange-400' : 'bg-slate-700 text-slate-400'}`}>
                                <Bot className="w-5 h-5" />
                            </div>
                            <div>
                                <div className="text-sm font-bold text-white">Auto-Generate & Post Videos</div>
                                <div className="text-xs text-slate-400">Automatically generate and post videos to YouTube based on your schedule.</div>
                            </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input 
                                type="checkbox" 
                                className="sr-only peer" 
                                checked={editAutoGenerate}
                                onChange={(e) => setEditAutoGenerate(e.target.checked)}
                            />
                            <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-orange-800 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-600"></div>
                        </label>
                    </div>
                </div>

                {/* General Settings */}
                <div className="space-y-6 bg-slate-900/40 p-6 rounded-2xl border border-slate-800">
                    <h2 className="text-lg font-bold text-white mb-4">Channel Configuration</h2>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-slate-400 mb-1.5">Project Title</label>
                            <input 
                                type="text" 
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-orange-500 outline-none" 
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-400 mb-1.5">Channel Theme / Niche</label>
                            <input 
                                type="text" 
                                value={editTheme}
                                onChange={(e) => setEditTheme(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-orange-500 outline-none" 
                            />
                        </div>
                    </div>

                    {/* CONSISTENCY SETTINGS */}
                     <div className="pt-4 border-t border-slate-800">
                        <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 block">Default Consistency Settings</label>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-slate-400 mb-1.5">
                                    <Globe className="w-3.5 h-3.5" /> Project Language
                                </label>
                                <select 
                                    value={editLanguage}
                                    onChange={(e) => setEditLanguage(e.target.value)}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-white focus:ring-2 focus:ring-orange-500 outline-none appearance-none"
                                >
                                    {LANGUAGE_OPTIONS.map(lang => (
                                        <option key={lang} value={lang}>{lang}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-slate-400 mb-1.5">
                                    <Timer className="w-3.5 h-3.5" /> Default Video Duration
                                </label>
                                <select 
                                    value={editDuration}
                                    onChange={(e) => setEditDuration(e.target.value as VideoDuration)}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-white focus:ring-2 focus:ring-orange-500 outline-none appearance-none"
                                >
                                    <option>Short (&lt; 3 min)</option>
                                    <option>Standard (5-8 min)</option>
                                    <option>Long (10-15 min)</option>
                                    <option>Deep Dive (20+ min)</option>
                                </select>
                            </div>
                            <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-slate-400 mb-1.5">
                                    <MonitorPlay className="w-3.5 h-3.5" /> Default Video Format
                                </label>
                                <select 
                                    value={editFormat}
                                    onChange={(e) => setEditFormat(e.target.value as VideoFormat)}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-white focus:ring-2 focus:ring-orange-500 outline-none appearance-none"
                                >
                                    {FORMAT_OPTIONS.map(fmt => (
                                        <option key={fmt} value={fmt}>{fmt}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-slate-400 mb-1.5">
                                    <FileText className="w-3.5 h-3.5" /> Default Narrative Tone
                                </label>
                                <select 
                                    value={editTone}
                                    onChange={(e) => setEditTone(e.target.value)}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-white focus:ring-2 focus:ring-orange-500 outline-none appearance-none"
                                >
                                    {TONE_OPTIONS.map(tone => (
                                        <option key={tone} value={tone}>{tone}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-slate-400 mb-1.5">
                                    <Mic className="w-3.5 h-3.5" /> Default Narrator Voice
                                </label>
                                <div className="flex gap-2">
                                    <select 
                                        value={editVoice}
                                        onChange={(e) => setEditVoice(e.target.value)}
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-white focus:ring-2 focus:ring-orange-500 outline-none appearance-none"
                                    >
                                        {VOICE_OPTIONS.map(v => (
                                            <option key={v.id} value={v.id}>{v.label}</option>
                                        ))}
                                    </select>
                                    <button 
                                        onClick={handlePreviewVoice}
                                        disabled={isPreviewingVoice}
                                        title="Preview Voice"
                                        className="px-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-slate-300 flex items-center justify-center transition-colors"
                                    >
                                        {isPreviewingVoice ? <Loader2 className="w-4 h-4 animate-spin" /> : <Volume2 className="w-4 h-4" />}
                                    </button>
                                </div>
                            </div>
                            
                            {/* Visual Source Mix */}
                            <div className="col-span-1 md:col-span-2 pt-4 border-t border-slate-800/50">
                               <div className="flex justify-between items-center mb-4">
                                   <label className="flex items-center gap-2 text-sm font-medium text-slate-400">
                                       <Sparkles className="w-3.5 h-3.5 text-orange-400" /> Visual Source Mix (AI vs Stock)
                                   </label>
                                   <div className="flex gap-4 text-[10px] font-bold uppercase tracking-widest">
                                       <span className="text-orange-400">Gemini: {editGeminiPercent}%</span>
                                       <span className="text-blue-400">Pexels: {editPexelsPercent}%</span>
                                   </div>
                               </div>
                               <div className="space-y-6">
                                   <div className="relative h-3 bg-slate-950 rounded-full overflow-hidden border border-slate-800 flex">
                                       <div 
                                           className="h-full bg-gradient-to-r from-orange-600 to-orange-400 transition-all duration-500" 
                                           style={{ width: `${editGeminiPercent}%` }}
                                       ></div>
                                       <div 
                                           className="h-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all duration-500" 
                                           style={{ width: `${editPexelsPercent}%` }}
                                       ></div>
                                   </div>
                                   <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                       <div className="space-y-3">
                                           <div className="flex justify-between text-xs">
                                               <span className="text-slate-500">Gemini AI Images</span>
                                               <span className="text-white font-mono">{editGeminiPercent}%</span>
                                           </div>
                                           <input 
                                               type="range" 
                                               min="0" 
                                               max="100" 
                                               step="5"
                                               value={editGeminiPercent}
                                               onChange={(e) => handleGeminiPercentChange(Number(e.target.value))}
                                               className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-orange-500"
                                           />
                                           <p className="text-[10px] text-slate-500 leading-tight">
                                               High-quality AI generated images based on script descriptions. Best for unique or abstract concepts.
                                           </p>
                                       </div>
                                       <div className="space-y-3">
                                           <div className="flex justify-between text-xs">
                                               <span className="text-slate-500">Pexels Stock Videos</span>
                                               <span className="text-white font-mono">{editPexelsPercent}%</span>
                                           </div>
                                           <input 
                                               type="range" 
                                               min="0" 
                                               max="100" 
                                               step="5"
                                               value={editPexelsPercent}
                                               onChange={(e) => handlePexelsPercentChange(Number(e.target.value))}
                                               className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                           />
                                           <p className="text-[10px] text-slate-500 leading-tight">
                                               Real cinematic stock footage. Best for documentary, lifestyle, or nature content.
                                           </p>
                                       </div>
                                   </div>
                               </div>
                            </div>
                        </div>
                            {/* Visual Pacing & Style - Only show if Gemini is being used */}
                            {editGeminiPercent > 0 && (
                                <div className="col-span-1 md:col-span-2 pt-4 border-t border-slate-800/50 animate-in fade-in slide-in-from-top-2 duration-300">
                                    <div className="flex justify-between items-center mb-4">
                                        <label className="flex items-center gap-2 text-sm font-medium text-slate-400">
                                            <Zap className="w-3.5 h-3.5 text-yellow-400" /> Visual Pacing & Style
                                        </label>
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                        <div className="space-y-4">
                                            <div className="flex justify-between items-center">
                                                <span className="text-xs text-slate-500">Images per 5 seconds</span>
                                                <div className="flex items-center gap-2 bg-slate-950 px-2 py-1 rounded border border-slate-800">
                                                    <input 
                                                        type="number" 
                                                        min="1" 
                                                        max="5"
                                                        value={editMinImages}
                                                        onChange={(e) => setEditMinImages(Number(e.target.value))}
                                                        className="w-8 bg-transparent text-center text-white text-xs outline-none"
                                                    />
                                                    <span className="text-slate-600">to</span>
                                                    <input 
                                                        type="number" 
                                                        min={editMinImages} 
                                                        max="10"
                                                        value={editMaxImages}
                                                        onChange={(e) => setEditMaxImages(Number(e.target.value))}
                                                        className="w-8 bg-transparent text-center text-white text-xs outline-none"
                                                    />
                                                </div>
                                            </div>
                                            <div className="space-y-2">
                                                <div className="flex justify-between text-[10px] text-slate-500 px-1">
                                                    <span>Slower</span>
                                                    <span>Faster</span>
                                                </div>
                                                <div className="relative h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                                    <div 
                                                        className="absolute h-full bg-yellow-500/50 transition-all duration-300"
                                                        style={{ 
                                                            left: `${(editMinImages - 1) * 10}%`, 
                                                            width: `${(editMaxImages - editMinImages) * 10 + 5}%` 
                                                        }}
                                                    ></div>
                                                </div>
                                            </div>
                                            <p className="text-[10px] text-slate-500 italic">
                                                Controls how often the visual changes. Higher values create more retention but use more API quota.
                                            </p>
                                        </div>
                                        
                                        <div className="space-y-3">
                                            <label className="text-xs text-slate-500">Visual Narrative Style</label>
                                            <div className="grid grid-cols-2 gap-2">
                                                {(['static', 'dynamic', 'fast-cuts', 'cinematic', 'minimalist', 'surreal', 'vintage', 'cyberpunk'] as VisualPacingStyle[]).map((style) => (
                                                    <button
                                                        key={style}
                                                        onClick={() => setEditStyle(style)}
                                                        className={`px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all border ${
                                                            editStyle === style 
                                                            ? 'bg-yellow-500/20 border-yellow-500 text-yellow-400 shadow-[0_0_10px_rgba(234,179,8,0.1)]' 
                                                            : 'bg-slate-900 border-slate-800 text-slate-500 hover:border-slate-700'
                                                        }`}
                                                    >
                                                        {style.replace('-', ' ')}
                                                    </button>
                                                ))}
                                            </div>
                                            <div className="min-h-[32px]">
                                                <p className="text-[10px] text-slate-500 leading-tight">
                                                    {editStyle === 'static' && "Longer, stable shots. Best for calm or educational content."}
                                                    {editStyle === 'dynamic' && "Balanced mix of movement and stability. Standard for most videos."}
                                                    {editStyle === 'fast-cuts' && "High-energy, rapid transitions. Best for viral or action content."}
                                                    {editStyle === 'cinematic' && "Focus on mood, lighting, and artistic composition."}
                                                    {editStyle === 'minimalist' && "Clean, simple, and uncluttered compositions with negative space."}
                                                    {editStyle === 'surreal' && "Dreamy, abstract, and unconventional visuals with strange perspectives."}
                                                    {editStyle === 'vintage' && "Old film look with grain, sepia tones, and nostalgic atmosphere."}
                                                    {editStyle === 'cyberpunk' && "Neon-drenched, dark, and futuristic gritty urban aesthetic."}
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                            
                            <p className="text-xs text-slate-600 mt-4">These settings will apply to all new videos created in this project.</p>
                        </div>

                        <div className="pt-2">
                            <button 
                                onClick={handleSaveSettings}
                                disabled={isSaving}
                                className="flex items-center gap-2 bg-orange-600 hover:bg-orange-500 text-white px-6 py-2.5 rounded-lg font-bold shadow-lg shadow-orange-600/20 transition-all disabled:opacity-50 w-full justify-center md:w-auto active:scale-95"
                            >
                                <Save className="w-4 h-4" />
                                {isSaving ? 'Saving...' : 'Save Changes'}
                            </button>
                        </div>

                        {/* Danger Zone */}
                        <div className="space-y-6 bg-red-900/10 p-6 rounded-2xl border border-red-500/20">
                            <h2 className="text-lg font-bold text-red-400 mb-4 flex items-center gap-2">
                                <AlertOctagon className="w-5 h-5" />
                                Danger Zone
                            </h2>
                            
                            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                                <div>
                                    <p className="text-white font-medium">Delete Project</p>
                                    <p className="text-sm text-red-200/60">Permanently remove this project and all videos.</p>
                                </div>
                                <button 
                                    onClick={handleDeleteProject}
                                    className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 rounded-lg text-sm font-bold transition-colors flex items-center gap-2 w-full justify-center md:w-auto"
                                >
                                    <Trash2 className="w-4 h-4" />
                                    Delete Project
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

        {/* Create Video Modal (Portal) */}
        {isVideoModalOpen && createPortal(
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => setIsVideoModalOpen(false)}></div>
                <div className="relative bg-[#0B1121] border border-slate-800 rounded-2xl w-full max-w-lg shadow-2xl shadow-black/50 overflow-hidden animate-in fade-in zoom-in duration-200 flex flex-col max-h-[90vh]">
                    <div className="bg-slate-900/50 p-6 border-b border-slate-800 flex justify-between items-center">
                        <h2 className="text-xl font-bold text-white">Create New Video</h2>
                        <button onClick={() => setIsVideoModalOpen(false)} className="text-slate-500 hover:text-white transition-colors"><X className="w-6 h-6" /></button>
                    </div>
                    <form onSubmit={handleCreateVideo} className="p-6 space-y-6 overflow-y-auto">
                        <div className="space-y-2">
                            <label className="text-sm font-semibold text-slate-300 ml-1">Video Topic</label>
                            <input type="text" value={newVideoTopic} onChange={e => setNewVideoTopic(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-orange-500 outline-none" placeholder="e.g. The Mystery of the Dyatlov Pass" autoFocus />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <label className="text-sm font-semibold text-slate-300 ml-1">Duration</label>
                                <div className="relative">
                                    <select value={newVideoDuration} onChange={(e) => setNewVideoDuration(e.target.value as VideoDuration)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-orange-500 outline-none appearance-none cursor-pointer">
                                        <option>Short (&lt; 3 min)</option>
                                        <option>Standard (5-8 min)</option>
                                        <option>Long (10-15 min)</option>
                                        <option>Deep Dive (20+ min)</option>
                                    </select>
                                    <Clock className="w-4 h-4 text-slate-500 absolute right-4 top-3.5 pointer-events-none" />
                                </div>
                            </div>
                            <div className="space-y-2">
                                <label className="text-sm font-semibold text-slate-300 ml-1">Format</label>
                                <div className="relative">
                                    <select value={newVideoFormat} onChange={(e) => setNewVideoFormat(e.target.value as VideoFormat)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-orange-500 outline-none appearance-none cursor-pointer">
                                        {FORMAT_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
                                    </select>
                                    <MonitorPlay className="w-4 h-4 text-slate-500 absolute right-4 top-3.5 pointer-events-none" />
                                </div>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm font-semibold text-slate-300 ml-1">Specific Context (Optional)</label>
                            <textarea 
                                value={newVideoContext}
                                onChange={(e) => setNewVideoContext(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-orange-500 outline-none h-24 resize-none placeholder-slate-600"
                                placeholder="Add specific details, dates, names, or key plot points..."
                            />
                        </div>
                        <div className="flex gap-3 pt-2">
                            <button type="button" onClick={() => setIsVideoModalOpen(false)} className="flex-1 px-4 py-3 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors">Cancel</button>
                            <button type="submit" disabled={!newVideoTopic} className="flex-1 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white px-6 py-3 rounded-xl font-bold shadow-lg transition-all active:scale-95">Create Video</button>
                        </div>
                    </form>
                </div>
            </div>,
            document.body
        )}

        {/* Create Library Item Modal (Portal) */}
        {isLibraryModalOpen && createPortal(
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => setIsLibraryModalOpen(false)}></div>
                <div className="relative bg-[#0B1121] border border-slate-800 rounded-2xl w-full max-w-lg shadow-2xl shadow-black/50 overflow-hidden animate-in fade-in zoom-in duration-200 flex flex-col max-h-[90vh]">
                    <div className="bg-slate-900/50 p-6 border-b border-slate-800 flex justify-between items-center">
                        <h2 className="text-xl font-bold text-white">Add Knowledge Base Item</h2>
                        <button onClick={() => setIsLibraryModalOpen(false)} className="text-slate-500 hover:text-white transition-colors"><X className="w-6 h-6" /></button>
                    </div>
                    <form onSubmit={handleAddLibraryItem} className="p-6 space-y-6 overflow-y-auto">
                        <div className="space-y-2">
                            <label className="text-sm font-semibold text-slate-300 ml-1">Type</label>
                            <select 
                                value={newItemType} 
                                onChange={(e) => {
                                    setNewItemType(e.target.value as LibraryItemType);
                                    setNewItemTitle('');
                                    setNewItemContent('');
                                }}
                                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-orange-500 outline-none appearance-none"
                            >
                                <option value="text">Text Note / Summary</option>
                                <option value="link">Link / URL</option>
                                <option value="youtube_channel">YouTube Channel Reference (Style/Themes)</option>
                                <option value="file">File Upload (Text/Doc)</option>
                                <option value="book">Book Reference</option>
                                <option value="reference">General Reference</option>
                            </select>
                        </div>

                        {newItemType === 'file' ? (
                            <div className="space-y-2">
                                <label className="text-sm font-semibold text-slate-300 ml-1">Upload File</label>
                                <div className="border-2 border-dashed border-slate-800 rounded-xl p-8 text-center bg-slate-900/30 hover:bg-slate-900/50 transition-colors relative">
                                    <input 
                                        type="file" 
                                        onChange={handleFileUpload}
                                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                        accept=".txt,.md,.csv,.json,.js,.ts,.html"
                                    />
                                    <UploadCloud className="w-10 h-10 text-slate-500 mx-auto mb-3" />
                                    <p className="text-sm text-slate-400 font-medium">
                                        {uploadingFile ? "Reading file..." : "Click to select a file"}
                                    </p>
                                    <p className="text-xs text-slate-600 mt-1">Supports text-based files (.txt, .md, .csv, etc)</p>
                                </div>
                            </div>
                        ) : null}

                        <div className="space-y-2">
                            <label className="text-sm font-semibold text-slate-300 ml-1">Title</label>
                            <input 
                                type="text" 
                                value={newItemTitle} 
                                onChange={e => setNewItemTitle(e.target.value)} 
                                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-orange-500 outline-none" 
                                placeholder={newItemType === 'file' ? "Filename..." : "e.g. Wikipedia Article about Aliens"} 
                                readOnly={newItemType === 'file' && !newItemTitle}
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-semibold text-slate-300 ml-1">Content / URL / Summary</label>
                            <textarea 
                                value={newItemContent}
                                onChange={(e) => setNewItemContent(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-orange-500 outline-none h-32 resize-none placeholder-slate-600 custom-scrollbar"
                                placeholder={newItemType === 'link' || newItemType === 'youtube_channel' ? "https://..." : "Paste summary or key facts here..."}
                                readOnly={newItemType === 'file'} // Make read-only if it was uploaded, or allow edit? Let's allow edit.
                            />
                            <p className="text-xs text-slate-500">This content will be fed to the AI during brainstorming.</p>
                        </div>

                        <div className="flex gap-3 pt-2">
                            <button type="button" onClick={() => setIsLibraryModalOpen(false)} className="flex-1 px-4 py-3 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors">Cancel</button>
                            <button type="submit" disabled={!newItemTitle || !newItemContent} className="flex-1 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white px-6 py-3 rounded-xl font-bold shadow-lg transition-all active:scale-95">Add Item</button>
                        </div>
                    </form>
                </div>
            </div>,
            document.body
        )}

        {/* Delete Video Confirmation Modal (Portal) */}
        {videoToDelete && createPortal(
            <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
                <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => setVideoToDelete(null)}></div>
                <div className="relative bg-[#0B1121] border border-red-500/20 rounded-2xl w-full max-w-md shadow-2xl shadow-black/50 overflow-hidden animate-in fade-in zoom-in duration-200">
                    <div className="p-6 text-center">
                        <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-4 border border-red-500/20">
                            <Trash2 className="w-8 h-8 text-red-500" />
                        </div>
                        <h2 className="text-xl font-bold text-white mb-2">Excluir Vídeo?</h2>
                        <p className="text-slate-400 text-sm mb-6">
                            Tem certeza que deseja excluir este vídeo? Esta ação não pode ser desfeita e todos os dados associados serão perdidos.
                        </p>
                        <div className="flex gap-3">
                            <button 
                                onClick={() => setVideoToDelete(null)} 
                                className="flex-1 px-4 py-3 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors font-medium"
                            >
                                Cancelar
                            </button>
                            <button 
                                onClick={confirmDeleteVideo} 
                                className="flex-1 bg-red-600 hover:bg-red-500 text-white px-6 py-3 rounded-xl font-bold shadow-lg transition-all active:scale-95"
                            >
                                Excluir
                            </button>
                        </div>
                    </div>
                </div>
            </div>,
            document.body
        )}

        {/* Delete Project Confirmation Modal (Portal) */}
        {isDeletingProject && createPortal(
            <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
                <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => setIsDeletingProject(false)}></div>
                <div className="relative bg-[#0B1121] border border-red-500/20 rounded-2xl w-full max-w-md shadow-2xl shadow-black/50 overflow-hidden animate-in fade-in zoom-in duration-200">
                    <div className="p-6 text-center">
                        <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-4 border border-red-500/20">
                            <AlertOctagon className="w-8 h-8 text-red-500" />
                        </div>
                        <h2 className="text-xl font-bold text-white mb-2">Excluir Projeto?</h2>
                        <p className="text-slate-400 text-sm mb-6">
                            Tem certeza que deseja excluir o projeto <span className="text-white font-bold">"{project.title}"</span>? Esta ação é irreversível e excluirá permanentemente todos os vídeos e dados associados.
                        </p>
                        <div className="flex gap-3">
                            <button 
                                onClick={() => setIsDeletingProject(false)} 
                                className="flex-1 px-4 py-3 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors font-medium"
                            >
                                Cancelar
                            </button>
                            <button 
                                onClick={confirmDeleteProject} 
                                className="flex-1 bg-red-600 hover:bg-red-500 text-white px-6 py-3 rounded-xl font-bold shadow-lg transition-all active:scale-95"
                            >
                                Excluir Projeto
                            </button>
                        </div>
                    </div>
                </div>
            </div>,
            document.body
        )}

        {/* Delete Library Item Confirmation Modal (Portal) */}
        {libraryItemToDelete && createPortal(
            <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
                <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => setLibraryItemToDelete(null)}></div>
                <div className="relative bg-[#0B1121] border border-orange-500/20 rounded-2xl w-full max-w-md shadow-2xl shadow-black/50 overflow-hidden animate-in fade-in zoom-in duration-200">
                    <div className="p-6 text-center">
                        <div className="w-16 h-16 bg-orange-500/10 rounded-full flex items-center justify-center mx-auto mb-4 border border-orange-500/20">
                            <BookOpen className="w-8 h-8 text-orange-500" />
                        </div>
                        <h2 className="text-xl font-bold text-white mb-2">Remover da Biblioteca?</h2>
                        <p className="text-slate-400 text-sm mb-6">
                            Deseja remover este item da sua base de conhecimento? O AI Brainstorming não terá mais acesso a este contexto.
                        </p>
                        <div className="flex gap-3">
                            <button 
                                onClick={() => setLibraryItemToDelete(null)} 
                                className="flex-1 px-4 py-3 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors font-medium"
                            >
                                Cancelar
                            </button>
                            <button 
                                onClick={confirmDeleteLibraryItem} 
                                className="flex-1 bg-orange-600 hover:bg-orange-500 text-white px-6 py-3 rounded-xl font-bold shadow-lg transition-all active:scale-95"
                            >
                                Remover
                            </button>
                        </div>
                    </div>
                </div>
            </div>,
            document.body
        )}
    </div>
  );
};