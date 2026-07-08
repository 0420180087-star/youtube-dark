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
  runner?: string;
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
  isAutoPilotRunning: boolean;
  autoPilotLog: AutoPilotLogEntry[];
  autoPilotProgress: AutoPilotProgress;
  triggerAutoPilotNow: (projectId: string) => Promise<void>;
  getNextAutoRunInfo: (projectId: string) => { nextRunDate: Date | null; isEligible: boolean };
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

export const ProjectProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, accessToken, refreshYouTubeToken } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [autoPilotStatus, setAutoPilotStatus] = useState<string>('Idle');
  const [isAutoPilotRunning, setIsAutoPilotRunning] = useState(false);
  const [autoPilotLog, setAutoPilotLog] = useState<AutoPilotLogEntry[]>([]);
  const [autoPilotProgress, setAutoPilotProgress] = useState<AutoPilotProgress>({
    isRunning: false, currentStep: null, stepMessage: '', stepStartTime: null, pipelineStartTime: null
  });
  
  const automationInterval = useRef<number | null>(null);
  const isRunningAutomation = useRef(false);
  const projectsRef = useRef(projects);
  const userEmailRef = useRef<string>('');
  const accessTokenRef = useRef<string | null>(null);

  const storageKey = user?.email ? `darkstream_projects_${user.email}` : 'darkstream_projects_guest';

  const buildCloudProject = (project: Project) => {
    const { autopilotLockedUntil, autopilotLockedBy, ...domainProject } = project;
    return {
      ...domainProject,
      videos: project.videos.map(v => ({
        ...v,
        audioUrl: v.audioUrl ? '__has_audio__' : undefined,
        backgroundMusicUrl: v.backgroundMusicUrl ? '__has_music__' : undefined,
        visualScenes: v.visualScenes?.map(scene => ({
          ...scene,
          imageUrl: scene.imageUrl?.startsWith('data:') ? '__has_image__' : scene.imageUrl,
        })),
        thumbnailUrl: v.thumbnailUrl?.startsWith('data:') ? '__has_thumbnail__' : v.thumbnailUrl,
      })),
    };
  };

  const returnStatusToIdle = (delayMs = 5000) => {
    window.setTimeout(() => setAutoPilotStatus('Idle'), delayMs);
  };

  // Load projects — IndexedDB first (instant), then Supabase in background (sync)
  // This prevents blank pages while Supabase is slow to respond
  useEffect(() => {
    const loadProjects = async () => {
      setIsLoading(true);
      try {
        // STEP 1: Load from IndexedDB immediately — this is always fast (<50ms)
        // The UI becomes usable right away with local data
        const localData: Project[] = (await get(storageKey)) || [];
        if (Array.isArray(localData) && localData.length > 0) {
          setProjects(localData);
        }

        // STEP 2: Finish loading so UI renders even if Supabase is slow
        setIsLoading(false);

        // STEP 3: Sync with Supabase in background (non-blocking)
        if (supabase && user?.email) {
          let { data, error } = await supabase
            .from("projects")
            .select("data, autopilot_locked_until, autopilot_locked_by")
            .eq("user_email", user.email);

          if (error && (error.message || '').includes('column')) {
            const fallback = await supabase
              .from("projects")
              .select("data")
              .eq("user_email", user.email);
            data = fallback.data as any;
            error = fallback.error;
          }

          if (!error && data && data.length > 0) {
            const remoteProjects: Project[] = data.map((row: any) => ({
              ...row.data,
              autopilotLockedUntil: row.autopilot_locked_until ?? null,
              autopilotLockedBy: row.autopilot_locked_by ?? null,
            }));

            const mergeBlobs = (remote: Project, local: Project | undefined): Project => {
              if (!local) return remote;
              return {
                ...remote,
                videos: remote.videos.map((rv: Video) => {
                  const lv = local.videos?.find((l: Video) => l.id === rv.id);
                  if (!lv) return rv;
                  return {
                    ...rv,
                    audioUrl: rv.audioUrl === '__has_audio__' ? lv.audioUrl : rv.audioUrl,
                    backgroundMusicUrl: rv.backgroundMusicUrl === '__has_music__' ? lv.backgroundMusicUrl : rv.backgroundMusicUrl,
                    thumbnailUrl: rv.thumbnailUrl === '__has_thumbnail__' ? lv.thumbnailUrl : rv.thumbnailUrl,
                    visualScenes: rv.visualScenes?.map((rs: any) => {
                      const ls = lv.visualScenes?.find((s: any) =>
                        s.startTime === rs.startTime && s.segmentIndex === rs.segmentIndex
                      );
                      return {
                        ...rs,
                        imageUrl: rs.imageUrl === '__has_image__' && ls?.imageUrl ? ls.imageUrl : rs.imageUrl,
                      };
                    }),
                  };
                }),
              };
            };

            const merged = remoteProjects.map(remote => {
              const local = localData.find(l => l.id === remote.id);
              const mergedProject = mergeBlobs(remote, local);

              // Bug fix: include videos that exist on Supabase (created by GitHub Actions runner)
              // but don't exist in local IndexedDB. Without this, runner-created videos
              // never appear in the UI — the user sees no new videos despite the workflow succeeding.
              if (local) {
                const localVideoIds = new Set(local.videos?.map((v: Video) => v.id) || []);
                const runnerVideos = remote.videos.filter((rv: Video) => !localVideoIds.has(rv.id));
                if (runnerVideos.length > 0) {
                  mergedProject.videos = [...runnerVideos, ...(mergedProject.videos || [])];
                }
              }

              return mergedProject;
            });

            // Add local-only projects not yet on Supabase
            const remoteIds = new Set(remoteProjects.map((p: Project) => p.id));
            const localOnly = localData.filter((l: Project) => !remoteIds.has(l.id));

            const finalProjects = [...merged, ...localOnly];

            // Persist merged result to IndexedDB immediately so runner-created videos
            // survive a page reload without needing another Supabase round-trip
            set(storageKey, finalProjects).catch(() => {});

            setProjects(finalProjects);
          }
        }
      } catch (e) {
        console.error('Failed to load projects', e);
        setIsLoading(false);
        try {
          const fallback = await get(storageKey);
          setProjects(Array.isArray(fallback) ? fallback : []);
        } catch { setProjects([]); }
      }
    };
    loadProjects();
  }, [storageKey, user?.email]);

  useEffect(() => { projectsRef.current = projects; }, [projects]);
  useEffect(() => { userEmailRef.current = user?.email || ''; }, [user?.email]);
  useEffect(() => { accessTokenRef.current = accessToken; }, [accessToken]);

  // Save projects — local immediately; Supabase debounced + diffed to avoid request floods
  const lastSyncSnapshotRef = useRef<Map<string, string>>(new Map());
  const supabaseSyncTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (isLoading) return;

    // 1. Always save locally via IndexedDB (full data, no size limit)
    set(storageKey, projects).catch(e => console.error('Failed to save projects locally', e));

    // 2. Debounced Supabase sync — only upserts projects whose lightweight
    //    representation actually changed since the last sync. Prevents
    //    bursts of upserts when many small state changes happen rapidly.
    if (!supabase || !user?.email) return;

    if (supabaseSyncTimerRef.current) {
      clearTimeout(supabaseSyncTimerRef.current);
    }

    supabaseSyncTimerRef.current = window.setTimeout(async () => {
      for (const project of projects) {
        try {
          const lightProject = buildCloudProject(project);
          const signature = JSON.stringify(lightProject);
          const previous = lastSyncSnapshotRef.current.get(project.id);
          if (previous === signature) continue; // unchanged — skip

          await supabase.from('projects').upsert({
            id: project.id,
            user_email: user.email,
            data: lightProject,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'id' });

          lastSyncSnapshotRef.current.set(project.id, signature);
        } catch (err) {
          console.warn('[Supabase] Falha ao sincronizar projeto:', project.id, err);
        }
      }
    }, 1500);

    return () => {
      if (supabaseSyncTimerRef.current) {
        clearTimeout(supabaseSyncTimerRef.current);
        supabaseSyncTimerRef.current = null;
      }
    };
  }, [projects, isLoading, storageKey, user?.email]);

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
    
    if (project.scheduleSettings.nextScheduledRun) {
      const next = new Date(project.scheduleSettings.nextScheduledRun);
      return { nextRunDate: next, isEligible: next <= new Date() };
    }

    // nextScheduledRun not yet persisted — calculate on the fly.
    // Do NOT call updateProject here: this function is used during render
    // and a side-effect would trigger setProjects → re-render → infinite loop.
    // scheduleNextRun() is called explicitly after each pipeline run.
    const sortedVideos = [...project.videos].sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const next = calculateNextRunTime(project.scheduleSettings, sortedVideos[0]?.createdAt);
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

  const triggerAutoPilotNow = async (projectId: string) => {
    const project = projectsRef.current.find(p => p.id === projectId);
    if (!project) return;
    if (isRunningAutomation.current) {
      setAutoPilotStatus("Já está em execução...");
      returnStatusToIdle();
      return;
    }

    if (supabase && userEmailRef.current) {
      try {
        const queuedAt = new Date(Date.now() - 1000).toISOString();
        const queuedProject: Project = {
          ...project,
          scheduleSettings: {
            frequencyDays: project.scheduleSettings?.frequencyDays || 1,
            timeWindowStart: project.scheduleSettings?.timeWindowStart || '12:00',
            timeWindowEnd: project.scheduleSettings?.timeWindowEnd || '18:00',
            autoGenerate: true,
            nextScheduledRun: queuedAt,
          },
        };
        const updated = projectsRef.current.map(p => p.id === projectId ? queuedProject : p);
        projectsRef.current = updated;
        setProjects(updated);

        const { error } = await supabase.from('projects').upsert({
          id: queuedProject.id,
          user_email: userEmailRef.current,
          data: buildCloudProject(queuedProject),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'id' });
        if (error) throw error;

        await supabase.from('autopilot_logs').insert({
          project_id: queuedProject.id,
          status: 'running',
          message: 'Execução manual enfileirada para o runner headless. Pode sair da página; o GitHub Actions assumirá no próximo ciclo.',
          step: 'idea',
        }).then(({ error: logError }) => {
          if (logError) console.warn('[AutoPilot] Não foi possível registrar fila remota:', logError.message);
        });

        setAutoPilotStatus('Execução enfileirada para o runner headless');
        addLogEntry({
          projectId: queuedProject.id,
          projectTitle: queuedProject.title,
          status: 'retrying',
          message: 'Execução enfileirada. A automação continuará pelo GitHub Actions mesmo com a página fechada.',
          step: 'idea',
          runner: 'github-actions',
        });
        returnStatusToIdle();
        return;
      } catch (e) {
        console.warn('[AutoPilot] Falha ao enfileirar runner headless; usando execução local:', e);
        setAutoPilotStatus('Fila headless indisponível; executando localmente nesta aba');
      }
    }

    const latestProject = projectsRef.current.find(p => p.id === projectId) || project;
    runFullPipeline(latestProject);
  };

  // --- AUTO-PILOT ENGINE ---
  useEffect(() => {
    // Registered ONCE on mount. The callback always reads from projectsRef.current
    // (kept in sync by a separate effect) so it never needs [projects] as a dep.
    // Having [projects] here caused the interval to cancel+restart on every save,
    // resetting the 60s clock and potentially preventing the auto-pilot from ever firing.
    automationInterval.current = window.setInterval(async () => {
      if (isRunningAutomation.current) return;
      
      const eligibleProject = projectsRef.current.find(p => {
        if (!p.scheduleSettings?.autoGenerate) return false;
        return getNextAutoRunInfoFromRef(p).isEligible;
      });

      if (eligibleProject && !(supabase && userEmailRef.current)) {
        await runFullPipeline(eligibleProject);
      }
    }, 60000);

    return () => { if (automationInterval.current) clearInterval(automationInterval.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const repairYouTubeConnection = async (project: Project, token: string): Promise<Project> => {
    if (project.youtubeChannelData) return project;
    try {
      const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return project;
      const data = await res.json();
      const ch = data.items?.[0];
      if (!ch?.id) return project;
      const youtubeChannelData = {
        id: ch.id,
        title: ch.snippet?.title || '',
        thumbnailUrl: ch.snippet?.thumbnails?.default?.url || '',
        subscriberCount: ch.statistics?.subscriberCount || '',
      };
      const repaired = { ...project, isYoutubeConnected: true, youtubeChannelData };
      updateProject(project.id, { isYoutubeConnected: true, youtubeChannelData });
      return repaired;
    } catch (e) {
      console.warn('[AutoPilot] Não foi possível reparar dados do canal:', e);
      return project;
    }
  };

  const runFullPipeline = async (project: Project) => {
    if (isRunningAutomation.current) return;

    let runnableProject = project;
    let currentToken = accessTokenRef.current;
    if (!currentToken) {
      setAutoPilotStatus('Renovando sessão do YouTube...');
      currentToken = await refreshYouTubeToken(project.id);
      accessTokenRef.current = currentToken;
    }
    if (currentToken && !runnableProject.youtubeChannelData) {
      runnableProject = await repairYouTubeConnection(runnableProject, currentToken);
    }
    if (!currentToken || !runnableProject.youtubeChannelData) {
      const reason = !runnableProject.youtubeChannelData
        ? "canal YouTube ainda não configurado; o vídeo será criado e ficará em STANDBY no upload"
        : "YouTube será renovado novamente no upload; o vídeo será criado primeiro";
      setAutoPilotStatus(`Auto-Pilot: ${reason}`);
      addLogEntry({ projectId: runnableProject.id, projectTitle: runnableProject.title, status: 'running', message: reason, step: 'upload' });
    }

    // Acquire distributed lock before starting.
    // This prevents the browser and GitHub Actions from running the same
    // project simultaneously. Only one runner wins the DB update.
    if (supabase) {
      try {
        const { data: lockAcquired, error } = await supabase
          .rpc('acquire_autopilot_lock', {
            p_project_id: runnableProject.id,
            p_locked_by: 'browser',
            p_lock_minutes: 90,
          });

        if (error || !lockAcquired) {
          console.info(
            `[AutoPilot] Lock não obtido para "${runnableProject.title}" — provavelmente em execução pelo GitHub Actions.`
          );
          setAutoPilotStatus(`Auto-Pilot: "${runnableProject.title}" em execução em outro runner`);
          addLogEntry({
            projectId: runnableProject.id,
            projectTitle: runnableProject.title,
            status: 'retrying',
            message: error ? `Lock não obtido: ${error.message}` : 'Lock não obtido: outro runner está processando este projeto',
          });
          setIsAutoPilotRunning(false);
          returnStatusToIdle();
          return;
        }
      } catch (e) {
        // If Supabase is unreachable, proceed anyway — better to risk a duplicate
        // than to permanently block the browser pipeline.
        console.warn('[AutoPilot] Não foi possível verificar o lock distribuído:', e);
      }
    }

    isRunningAutomation.current = true;
    setIsAutoPilotRunning(true);
    const pipelineStart = Date.now();
    
    setAutoPilotProgress({
      isRunning: true, currentStep: null, stepMessage: 'Iniciando...', 
      stepStartTime: pipelineStart, pipelineStartTime: pipelineStart
    });
    setAutoPilotStatus(`Iniciando Auto-Pilot: ${runnableProject.title}`);
    addLogEntry({ projectId: runnableProject.id, projectTitle: runnableProject.title, status: 'running', message: 'Pipeline iniciado' });

    const callbacks: PipelineCallbacks = {
      onStepStart: (step, message) => {
        setAutoPilotProgress(prev => ({
          ...prev, currentStep: step, stepMessage: message, stepStartTime: Date.now()
        }));
        setAutoPilotStatus(message);
        addLogEntry({ projectId: runnableProject.id, projectTitle: runnableProject.title, status: 'running', message, step });
      },
      onStepComplete: (step) => {
        const label = STEP_LABELS[step];
        addLogEntry({ projectId: runnableProject.id, projectTitle: runnableProject.title, status: 'success', message: `${label} concluído`, step });
      },
      onProgress: (step, detail) => {
        setAutoPilotProgress(prev => ({ ...prev, stepMessage: detail }));
        setAutoPilotStatus(detail);
      },
      addVideo,
      updateVideo,
      updateIdeaStatus,
      getLatestProject: (id) => projectsRef.current.find(p => p.id === id),
      saveGeneratedIdeas,
      // Live token getter — guarantees the most recently refreshed token is used,
      // even if the pipeline has been running for many minutes.
      getYoutubeAccessToken: () => accessTokenRef.current,
      refreshYoutubeAccessToken: async () => {
        const token = await refreshYouTubeToken(runnableProject.id);
        accessTokenRef.current = token;
        return token;
      },
      youtubeAccessToken: currentToken,
    };

    // Wrap pipeline in try/finally so isRunningAutomation is ALWAYS released.
    // Without this, any uncaught exception from runAutomationPipeline permanently
    // sets the lock to true — the Auto-Pilot becomes unresponsive until page reload.
    try {
      const result: PipelineResult = await runAutomationPipeline(runnableProject, callbacks);

      if (result.success) {
        setAutoPilotStatus("Auto-Pilot Completo!");
        addLogEntry({ 
          projectId: runnableProject.id, projectTitle: runnableProject.title, 
          videoTitle: result.videoTitle, status: 'success', 
          message: `Vídeo publicado: ${result.videoTitle}`,
          elapsedMs: Date.now() - pipelineStart
        });
      } else {
        const stepLabel = result.failedStep ? STEP_LABELS[result.failedStep] : 'desconhecido';
        setAutoPilotStatus(`STANDBY: Falha em ${stepLabel}`);
        addLogEntry({ 
          projectId: runnableProject.id, projectTitle: runnableProject.title,
          videoTitle: result.videoTitle, status: 'error',
          message: `Falha em ${stepLabel}: ${result.errorMessage}`,
          step: result.failedStep,
          elapsedMs: Date.now() - pipelineStart
        });
      }

    } catch (fatalErr: any) {
      // Unexpected pipeline crash — log it and surface to the user
      console.error('[AutoPilot] Pipeline crash:', fatalErr);
      setAutoPilotStatus('STANDBY: Erro inesperado no pipeline');
      addLogEntry({
        projectId: runnableProject.id, projectTitle: runnableProject.title,
        status: 'error',
        message: `Erro inesperado: ${fatalErr?.message || 'Desconhecido'}`,
        elapsedMs: Date.now() - pipelineStart
      });
    } finally {
      scheduleNextRun(runnableProject.id);
      // ALWAYS release, even on crash — without this the bot freezes until reload
      if (supabase) {
        try {
          await supabase.rpc('release_autopilot_lock', { p_project_id: runnableProject.id });
        } catch (e) {
          console.warn('[AutoPilot] Não foi possível liberar o lock distribuído:', e);
        }
      }
      setAutoPilotProgress({
        isRunning: false, currentStep: null, stepMessage: '', stepStartTime: null, pipelineStartTime: null
      });
      isRunningAutomation.current = false;
      setIsAutoPilotRunning(false);
      returnStatusToIdle();
    }
  };


  // --- EXISTING ACTIONS ---
  const addProject = (channelTheme: string, description: string = '') => {
    const newProject: Project = {
      id: crypto.randomUUID(), title: channelTheme, channelTheme: channelTheme, description: description,
      createdAt: new Date().toISOString(), videos: [], usedIdeas: [], ideas: [], library: [],
      isYoutubeConnected: false, defaultTone: 'Suspenseful and Dark', defaultVoice: 'Fenrir',
      language: 'Portuguese (BR)', defaultDuration: 'Standard (5-8 min)', defaultFormat: 'Landscape 16:9',
      visualSourceMix: { geminiPercentage: 50, pexelsPercentage: 50 }, maxMediaDurationSeconds: 6,
      visualPacing: { minImagesPer5Sec: 1, maxImagesPer5Sec: 2, style: 'dynamic' },
      scheduleSettings: { frequencyDays: 1, timeWindowStart: '12:00', timeWindowEnd: '18:00', autoGenerate: false }
    };
    setProjects(prev => {
      const next = [newProject, ...prev];
      projectsRef.current = next;
      return next;
    });

    // Immediately persist to Supabase (don't wait for the 1.5s debounce).
    // Without this, quickly closing/refreshing the tab after creation loses
    // the project — locally it survives via IndexedDB, but on another device
    // or after cache clear it never made it to the cloud.
    if (supabase && userEmailRef.current) {
      supabase.from('projects').upsert({
        id: newProject.id,
        user_email: userEmailRef.current,
        data: newProject,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' }).then(({ error }) => {
        if (error) console.warn('[Supabase] Falha ao criar projeto remoto:', error);
      });
    }

    return newProject;
  };

  const updateProject = (id: string, updates: Partial<Project>) => {
    setProjects(prev => {
      const updated = prev.map(p => p.id === id ? { ...p, ...updates } : p);
      projectsRef.current = updated;

      // Immediately persist to Supabase on settings changes (non-blob fields).
      // Check the MERGED project videos (not just 'updates') because updates.videos
      // is often undefined when only settings change, making the old check always
      // return false and allowing blob-heavy syncs that exceed Supabase's 5 MB limit.
      const mergedProject = updated.find(p => p.id === id);
      const hasBlob = mergedProject?.videos.some(v =>
        (v.audioUrl?.length ?? 0) > 100 ||
        (v.backgroundMusicUrl?.length ?? 0) > 100 ||
        v.thumbnailUrl?.startsWith('data:') ||
        v.visualScenes?.some(s => s.imageUrl?.startsWith('data:'))
      ) ?? false;

      if (!hasBlob && supabase && userEmailRef.current) {
        const project = updated.find(p => p.id === id);
        if (project) {
          const lightProject = buildCloudProject(project);
          supabase.from('projects').upsert({
            id: project.id,
            user_email: userEmailRef.current,
            data: lightProject,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'id' }).then(({ error }) => {
            if (error) console.warn('[Supabase] updateProject sync failed:', error.message);
          });
        }
      }

      return updated;
    });
  };

  const saveGeneratedIdeas = (projectId: string, ideas: GeminiVideoIdea[]) => {
    const nextProjects = projectsRef.current.map(p => {
      if (p.id === projectId) {
        const newProjectIdeas: ProjectIdea[] = ideas.map(i => ({
          id: crypto.randomUUID(), topic: i.topic, context: i.context, specificContext: i.specificContext,
          status: 'new', createdAt: new Date().toISOString()
        }));
        const existingTopics = new Set(p.ideas?.map(pi => pi.topic) || []);
        const updatedProject = { ...p, ideas: [...(p.ideas || []), ...newProjectIdeas.filter(ni => !existingTopics.has(ni.topic))] };
        return updatedProject;
      }
      return p;
    });
    projectsRef.current = nextProjects;
    setProjects(nextProjects);
  };

  const updateIdeaStatus = (projectId: string, ideaId: string, status: 'used' | 'dismissed' | 'new') => {
    const nextProjects = projectsRef.current.map(p => {
      if (p.id === projectId && p.ideas) {
        const updatedProject = { ...p, ideas: p.ideas.map(i => i.id === ideaId ? { ...i, status } : i) };
        return updatedProject;
      }
      return p;
    });
    projectsRef.current = nextProjects;
    setProjects(nextProjects);
  };

  // Marks an idea as 'used' by matching its topic string.
  // Used by legacy callers that pass topic text instead of an idea ID.
  const markIdeaAsUsed = (projectId: string, topic: string) => {
    setProjects(prev => prev.map(p => {
      if (p.id !== projectId || !p.ideas) return p;
      return {
        ...p,
        ideas: p.ideas.map(i => i.topic === topic ? { ...i, status: 'used' as const } : i),
      };
    }));
  };

  // Permanently removes an idea by topic string (legacy interface).
  // Prefer updateIdeaStatus with 'dismissed' for reversible dismissal.
  const removeIdeaFromHistory = (projectId: string, topic: string) => {
    setProjects(prev => prev.map(p => {
      if (p.id !== projectId || !p.ideas) return p;
      return { ...p, ideas: p.ideas.filter(i => i.topic !== topic) };
    }));
  };

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
  const deleteProject = (id: string) => {
    setProjects(prev => prev.filter(p => p.id !== id));
    lastSyncSnapshotRef.current.delete(id);

    // Also delete from Supabase so the project doesn't re-sync on next load.
    // Without this, the load effect merges the stale remote row back in and
    // the "deleted" project reappears after a refresh.
    if (supabase && userEmailRef.current) {
      (async () => {
        try {
          await supabase.from('projects').delete().eq('id', id).eq('user_email', userEmailRef.current);
        } catch (e) {
          console.warn('[Supabase] Falha ao excluir projeto remoto:', id, e);
        }
        try {
          await supabase.from('project_auth').delete().eq('project_id', id).eq('user_email', userEmailRef.current);
        } catch {}
        try {
          await supabase.from('autopilot_logs').delete().eq('project_id', id);
        } catch {}
      })();
    }
  };

  const addVideo = (projectId: string, topic: string, duration: VideoDuration, format: VideoFormat, context?: string) => {
    // Auto-detect Shorts from format — Portrait 9:16 always means YouTube Shorts
    const isShorts = format?.includes('9:16') || format?.toLowerCase().includes('shorts');
    // Shorts are always short duration
    const effectiveDuration: VideoDuration = isShorts ? 'Short (< 3 min)' : duration;

    const newVideo: Video = {
      id: crypto.randomUUID(), projectId: projectId, title: topic, status: ProjectStatus.DRAFT,
      targetDuration: effectiveDuration, format: format, specificContext: context || '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const updated = projectsRef.current.map(p => {
      if (p.id === projectId) {
        const updatedIdeas = p.ideas?.map(i => i.topic === topic ? { ...i, status: 'used' as const } : i);
        return { ...p, videos: [newVideo, ...p.videos], ideas: updatedIdeas || p.ideas };
      }
      return p;
    });
    projectsRef.current = updated;
    setProjects(updated);
    return newVideo;
  };

  const updateVideo = (projectId: string, videoId: string, updates: Partial<Video>) => {
    const updated = projectsRef.current.map(p => {
      if (p.id === projectId) {
        return { ...p, videos: p.videos.map(v => v.id === videoId ? { ...v, ...updates, updatedAt: new Date().toISOString() } : v) };
      }
      return p;
    });
    projectsRef.current = updated;
    setProjects(updated);
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
      projects, isLoading, autoPilotStatus, isAutoPilotRunning, autoPilotLog, autoPilotProgress,
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
