import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { Project, Video, ProjectStatus, VideoDuration, VisualScene, VisualEffect, ProjectIdea, LibraryItem, LibraryItemType, VideoFormat, AutoPilotStep } from '../types';
import { get, set } from 'idb-keyval';
import { useAuth } from './AuthContext';
import { supabase } from '../lib/supabaseClient';
import { 
    generateVideoIdeas, 
    VideoIdea as GeminiVideoIdea
} from '../services/geminiService';
import { 
  runAutomationPipeline, 
  calculateNextRunTime, 
  PipelineCallbacks, 
  PipelineResult, 
  STEP_LABELS 
} from '../services/automationService';

export interface AutoPilotLogEntry {
  id: string;
  projectId: string;
  projectTitle: string;
  videoTitle?: string;
  status: 'running' | 'success' | 'error' | 'retrying';
  message: string;
  timestamp: string;
  step?: AutoPilotStep;
  elapsedMs?: number;
}

export interface AutoPilotProgress {
  isRunning: boolean;
  currentStep: AutoPilotStep | null;
  stepMessage: string;
  stepStartTime: number | null;
  pipelineStartTime: number | null;
}

interface ProjectContextType {
  projects: Project[];
  isLoading: boolean;
  
  addProject: (channelTheme: string, description?: string) => Project;
  updateProject: (id: string, updates: Partial<Project>) => void;
  getProject: (id: string) => Project | undefined;
  deleteProject: (id: string) => void;
  
  saveGeneratedIdeas: (projectId: string, ideas: GeminiVideoIdea[]) => void;
  updateIdeaStatus: (projectId: string, ideaId: string, status: 'used' | 'dismissed' | 'new') => void;
  markIdeaAsUsed: (id: string, idea: string) => void;
  removeIdeaFromHistory: (id: string, idea: string) => void;

  addLibraryItem: (projectId: string, title: string, type: LibraryItemType, content: string) => void;
  deleteLibraryItem: (projectId: string, itemId: string) => void;

  addVideo: (projectId: string, topic: string, duration: VideoDuration, format: VideoFormat, context?: string) => Video;
  updateVideo: (projectId: string, videoId: string, updates: Partial<Video>) => void;
  deleteVideo: (projectId: string, videoId: string) => void;
  getVideo: (projectId: string, videoId: string) => Video | undefined;

  autoPilotStatus: string;
  autoPilotLog: AutoPilotLogEntry[];
  autoPilotProgress: AutoPilotProgress;
  triggerAutoPilotNow: (projectId: string) => void;
  getNextAutoRunInfo: (projectId: string) => { nextRunDate: Date | null; isEligible: boolean };
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

export const ProjectProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [autoPilotStatus, setAutoPilotStatus] = useState<string>('Idle');
  const [autoPilotLog, setAutoPilotLog] = useState<AutoPilotLogEntry[]>([]);
  const [autoPilotProgress, setAutoPilotProgress] = useState<AutoPilotProgress>({
    isRunning: false, currentStep: null, stepMessage: '', stepStartTime: null, pipelineStartTime: null
  });
  
  const automationInterval = useRef<number | null>(null);
  const isRunningAutomation = useRef(false);
  const projectsRef = useRef(projects);

  const storageKey = user?.email ? `darkstream_projects_${user.email}` : 'darkstream_projects_guest';

  // Load projects — tries Supabase first, falls back to IndexedDB
  useEffect(() => {
    const loadProjects = async () => {
      setIsLoading(true);
      try {
        if (supabase && user?.email) {
          const { data, error } = await supabase
            .from("projects")
            .select("data")
            .eq("user_email", user.email);

          if (!error && data && data.length > 0) {
            const loaded = data.map((row: any) => row.data);
            setProjects(loaded);
            await set(storageKey, loaded);
            return;
          }
        }

        const loaded = await get(storageKey);
        if (!loaded || !Array.isArray(loaded)) setProjects([]);
        else setProjects(loaded);
      } catch (e) {
        console.error("Failed to load projects", e);
      } finally {
        setIsLoading(false);
      }
    };
    loadProjects();
  }, [storageKey, user?.email]);

  useEffect(() => { projectsRef.current = projects; }, [projects]);

  // Save projects
  useEffect(() => {
    if (!isLoading) {
      set(storageKey, projects).catch(e => console.error("Failed to save projects", e));
    }
  }, [projects, isLoading, storageKey]);

  // Load persisted log
  useEffect(() => {
    const loadLog = async () => {
      try {
        const saved = await get(`${storageKey}_autopilot_log`);
        if (Array.isArray(saved)) setAutoPilotLog(saved);
      } catch {}
    };
    loadLog();
  }, [storageKey]);

  // Persist log
  useEffect(() => {
    if (autoPilotLog.length > 0) {
      set(`${storageKey}_autopilot_log`, autoPilotLog).catch(() => {});
    }
  }, [autoPilotLog, storageKey]);

  const addLogEntry = (entry: Omit<AutoPilotLogEntry, 'id' | 'timestamp'>) => {
    setAutoPilotLog(prev => [{
      ...entry, id: crypto.randomUUID(), timestamp: new Date().toISOString()
    }, ...prev].slice(0, 100));
  };

  // --- SCHEDULER with persistent next-run ---
  const getNextAutoRunInfo = (projectId: string): { nextRunDate: Date | null; isEligible: boolean } => {
    const project = projects.find(p => p.id === projectId);
    if (!project?.scheduleSettings?.autoGenerate) return { nextRunDate: null, isEligible: false };
    
    // Use persisted nextScheduledRun if available
    if (project.scheduleSettings.nextScheduledRun) {
      const next = new Date(project.scheduleSettings.nextScheduledRun);
      return { nextRunDate: next, isEligible: next <= new Date() };
    }

    // Calculate from last video
    const sortedVideos = [...project.videos].sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const lastVideo = sortedVideos[0];
    const next = calculateNextRunTime(project.scheduleSettings, lastVideo?.createdAt);
    
    // Persist it
    updateProject(projectId, { 
      scheduleSettings: { ...project.scheduleSettings, nextScheduledRun: next.toISOString() } 
    });
    
    return { nextRunDate: next, isEligible: next <= new Date() };
  };

  const scheduleNextRun = (projectId: string) => {
    const project = projectsRef.current.find(p => p.id === projectId);
    if (!project?.scheduleSettings?.autoGenerate) return;
    
    const nextRun = calculateNextRunTime(project.scheduleSettings);
    updateProject(projectId, {
      scheduleSettings: { ...project.scheduleSettings, nextScheduledRun: nextRun.toISOString() }
    });
  };

  const triggerAutoPilotNow = (projectId: string) => {
    const project = projects.find(p => p.id === projectId);
    if (!project) return;
    if (isRunningAutomation.current) {
      setAutoPilotStatus("Já está em execução...");
      return;
    }
    runFullPipeline(project);
  };

  // --- AUTO-PILOT ENGINE ---
  useEffect(() => {
    if (automationInterval.current) clearInterval(automationInterval.current);
    
    automationInterval.current = window.setInterval(async () => {
      if (isRunningAutomation.current) return;
      
      const eligibleProject = projectsRef.current.find(p => {
        if (!p.scheduleSettings?.autoGenerate) return false;
        if (!p.isYoutubeConnected || !p.youtubeAccessToken) return false;
        
        const info = getNextAutoRunInfoFromRef(p);
        return info.isEligible;
      });

      if (eligibleProject) {
        await runFullPipeline(eligibleProject);
      }
    }, 60000);

    return () => { if (automationInterval.current) clearInterval(automationInterval.current); };
  }, [projects]);

  // Non-state version for interval callback
  const getNextAutoRunInfoFromRef = (project: Project) => {
    if (!project.scheduleSettings?.autoGenerate) return { nextRunDate: null, isEligible: false };
    
    if (project.scheduleSettings.nextScheduledRun) {
      const next = new Date(project.scheduleSettings.nextScheduledRun);
      return { nextRunDate: next, isEligible: next <= new Date() };
    }

    const sortedVideos = [...project.videos].sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const lastVideo = sortedVideos[0];
    const next = calculateNextRunTime(project.scheduleSettings, lastVideo?.createdAt);
    return { nextRunDate: next, isEligible: next <= new Date() };
  };

  const runFullPipeline = async (project: Project) => {
    if (isRunningAutomation.current) return;
    if (!project.youtubeAccessToken || !project.youtubeChannelData) {
      setAutoPilotStatus("Auto-Pilot Pausado: YouTube não conectado");
      return;
    }

    isRunningAutomation.current = true;
    const pipelineStart = Date.now();
    
    setAutoPilotProgress({
      isRunning: true, currentStep: null, stepMessage: 'Iniciando...', 
      stepStartTime: pipelineStart, pipelineStartTime: pipelineStart
    });
    setAutoPilotStatus(`Iniciando Auto-Pilot: ${project.title}`);
    addLogEntry({ projectId: project.id, projectTitle: project.title, status: 'running', message: 'Pipeline iniciado' });

    const callbacks: PipelineCallbacks = {
      onStepStart: (step, message) => {
        setAutoPilotProgress(prev => ({
          ...prev, currentStep: step, stepMessage: message, stepStartTime: Date.now()
        }));
        setAutoPilotStatus(message);
        addLogEntry({ projectId: project.id, projectTitle: project.title, status: 'running', message, step });
      },
      onStepComplete: (step) => {
        const label = STEP_LABELS[step];
        addLogEntry({ projectId: project.id, projectTitle: project.title, status: 'success', message: `${label} concluído`, step });
      },
      onProgress: (step, detail) => {
        setAutoPilotProgress(prev => ({ ...prev, stepMessage: detail }));
        setAutoPilotStatus(detail);
      },
      addVideo,
      updateVideo,
      updateIdeaStatus,
      getLatestProject: (id) => projectsRef.current.find(p => p.id === id)
    };

    const result: PipelineResult = await runAutomationPipeline(project, callbacks);

    if (result.success) {
      setAutoPilotStatus("Auto-Pilot Completo!");
      addLogEntry({ 
        projectId: project.id, projectTitle: project.title, 
        videoTitle: result.videoTitle, status: 'success', 
        message: `Vídeo publicado: ${result.videoTitle}`,
        elapsedMs: Date.now() - pipelineStart
      });
    } else {
      const stepLabel = result.failedStep ? STEP_LABELS[result.failedStep] : 'desconhecido';
      setAutoPilotStatus(`STANDBY: Falha em ${stepLabel}`);
      addLogEntry({ 
        projectId: project.id, projectTitle: project.title,
        videoTitle: result.videoTitle, status: 'error',
        message: `Falha em ${stepLabel}: ${result.errorMessage}`,
        step: result.failedStep,
        elapsedMs: Date.now() - pipelineStart
      });
    }

    // Schedule next run regardless of success/failure
    scheduleNextRun(project.id);

    setAutoPilotProgress({
      isRunning: false, currentStep: null, stepMessage: '', stepStartTime: null, pipelineStartTime: null
    });
    isRunningAutomation.current = false;
    setTimeout(() => setAutoPilotStatus("Idle"), 5000);
  };


  // --- EXISTING ACTIONS ---
  const addProject = (channelTheme: string, description: string = '') => {
    const newProject: Project = {
      id: crypto.randomUUID(), title: channelTheme, channelTheme: channelTheme, description: description,
      createdAt: new Date().toISOString(), videos: [], usedIdeas: [], ideas: [], library: [],
      isYoutubeConnected: false, defaultTone: 'Suspenseful and Dark', defaultVoice: 'Fenrir',
      language: 'Portuguese (BR)', defaultDuration: 'Standard (5-8 min)', defaultFormat: 'Landscape 16:9',
      visualSourceMix: { geminiPercentage: 50, pexelsPercentage: 50 },
      visualPacing: { minImagesPer5Sec: 1, maxImagesPer5Sec: 2, style: 'dynamic' },
      scheduleSettings: { frequencyDays: 1, timeWindowStart: '12:00', timeWindowEnd: '18:00', autoGenerate: false }
    };
    setProjects(prev => [newProject, ...prev]);
    return newProject;
  };

  const updateProject = (id: string, updates: Partial<Project>) => {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p));
  };

  const saveGeneratedIdeas = (projectId: string, ideas: GeminiVideoIdea[]) => {
    setProjects(prev => prev.map(p => {
      if (p.id === projectId) {
        const newProjectIdeas: ProjectIdea[] = ideas.map(i => ({
          id: crypto.randomUUID(), topic: i.topic, context: i.context, specificContext: i.specificContext,
          status: 'new', createdAt: new Date().toISOString()
        }));
        const existingTopics = new Set(p.ideas?.map(pi => pi.topic) || []);
        return { ...p, ideas: [...(p.ideas || []), ...newProjectIdeas.filter(ni => !existingTopics.has(ni.topic))] };
      }
      return p;
    }));
  };

  const updateIdeaStatus = (projectId: string, ideaId: string, status: 'used' | 'dismissed' | 'new') => {
    setProjects(prev => prev.map(p => {
      if (p.id === projectId && p.ideas) {
        return { ...p, ideas: p.ideas.map(i => i.id === ideaId ? { ...i, status } : i) };
      }
      return p;
    }));
  };

  const markIdeaAsUsed = (id: string, idea: string) => {}; 
  const removeIdeaFromHistory = (id: string, idea: string) => {};

  const addLibraryItem = (projectId: string, title: string, type: LibraryItemType, content: string) => {
    setProjects(prev => prev.map(p => {
      if (p.id === projectId) {
        const newItem: LibraryItem = { id: crypto.randomUUID(), title, type, content, createdAt: new Date().toISOString() };
        return { ...p, library: [newItem, ...(p.library || [])] };
      }
      return p;
    }));
  };

  const deleteLibraryItem = (projectId: string, itemId: string) => {
    setProjects(prev => prev.map(p => {
      if (p.id === projectId) return { ...p, library: (p.library || []).filter(item => item.id !== itemId) };
      return p;
    }));
  };

  const getProject = (id: string) => projects.find(p => p.id === id);
  const deleteProject = (id: string) => { setProjects(prev => prev.filter(p => p.id !== id)); };

  const addVideo = (projectId: string, topic: string, duration: VideoDuration, format: VideoFormat, context?: string) => {
    const newVideo: Video = {
      id: crypto.randomUUID(), projectId: projectId, title: topic, status: ProjectStatus.DRAFT,
      targetDuration: duration, format: format, specificContext: context || '', 
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    setProjects(prev => prev.map(p => {
      if (p.id === projectId) {
        const updatedIdeas = p.ideas?.map(i => i.topic === topic ? { ...i, status: 'used' as const } : i);
        return { ...p, videos: [newVideo, ...p.videos], ideas: updatedIdeas || p.ideas };
      }
      return p;
    }));
    return newVideo;
  };

  const updateVideo = (projectId: string, videoId: string, updates: Partial<Video>) => {
    setProjects(prev => prev.map(p => {
      if (p.id === projectId) {
        return { ...p, videos: p.videos.map(v => v.id === videoId ? { ...v, ...updates, updatedAt: new Date().toISOString() } : v) };
      }
      return p;
    }));
  };

  const deleteVideo = (projectId: string, videoId: string) => {
    setProjects(prev => prev.map(p => {
      if (p.id === projectId) return { ...p, videos: p.videos.filter(v => v.id !== videoId) };
      return p;
    }));
  };
  
  const getVideo = (projectId: string, videoId: string) => {
    const project = projects.find(p => p.id === projectId);
    return project?.videos.find(v => v.id === videoId);
  };

  return (
    <ProjectContext.Provider value={{ 
      projects, isLoading, autoPilotStatus, autoPilotLog, autoPilotProgress,
      addProject, updateProject, getProject, deleteProject, 
      saveGeneratedIdeas, updateIdeaStatus, markIdeaAsUsed, removeIdeaFromHistory,
      addLibraryItem, deleteLibraryItem,
      addVideo, updateVideo, deleteVideo, getVideo,
      triggerAutoPilotNow, getNextAutoRunInfo
    }}>
      {children}
    </ProjectContext.Provider>
  );
};

export const useProjects = () => {
  const context = useContext(ProjectContext);
  if (!context) throw new Error("useProjects must be used within a ProjectProvider");
  return context;
};
