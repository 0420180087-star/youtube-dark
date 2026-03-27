import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { Project, Video, ProjectStatus, VideoDuration, VisualScene, VisualEffect, ProjectIdea, LibraryItem, LibraryItemType, VideoFormat } from '../types';
import { get, set } from 'idb-keyval';
import { useAuth } from './AuthContext'; // Import Auth to get current user
import { 
    generateVideoIdeas, 
    generateVideoScript, 
    generateVideoMetadata,
    generateVoiceover,
    generateSceneImage,
    generateDarkAmbience,
    generateThumbnail,
    decodeAudioData,
    mergeAudioBuffers,
    audioBufferToBase64,
    searchStockVideos,
    generatePexelsKeywords,
    VideoIdea as GeminiVideoIdea
} from '../services/geminiService';
import { renderVideoHeadless } from '../services/renderService';
import { uploadVideoToYouTube } from '../services/youtubeService';

interface ProjectContextType {
  projects: Project[];
  isLoading: boolean;
  
  // Project (Container) Actions
  addProject: (channelTheme: string, description?: string) => Project;
  updateProject: (id: string, updates: Partial<Project>) => void;
  getProject: (id: string) => Project | undefined;
  deleteProject: (id: string) => void;
  
  // Idea Actions
  saveGeneratedIdeas: (projectId: string, ideas: GeminiVideoIdea[]) => void;
  updateIdeaStatus: (projectId: string, ideaId: string, status: 'used' | 'dismissed' | 'new') => void;
  markIdeaAsUsed: (id: string, idea: string) => void; // Legacy support
  removeIdeaFromHistory: (id: string, idea: string) => void; // Legacy support

  // Library Actions
  addLibraryItem: (projectId: string, title: string, type: LibraryItemType, content: string) => void;
  deleteLibraryItem: (projectId: string, itemId: string) => void;

  // Video (Content) Actions
  addVideo: (projectId: string, topic: string, duration: VideoDuration, format: VideoFormat, context?: string) => Video;
  updateVideo: (projectId: string, videoId: string, updates: Partial<Video>) => void;
  deleteVideo: (projectId: string, videoId: string) => void;
  getVideo: (projectId: string, videoId: string) => Video | undefined;

  // Automation Status
  autoPilotStatus: string;
  autoPilotLog: AutoPilotLogEntry[];
  triggerAutoPilotNow: (projectId: string) => void;
  getNextAutoRunInfo: (projectId: string) => { nextRunDate: Date | null; isEligible: boolean };
}

export interface AutoPilotLogEntry {
  id: string;
  projectId: string;
  projectTitle: string;
  videoTitle?: string;
  status: 'running' | 'success' | 'error' | 'retrying';
  message: string;
  timestamp: string;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

const ANIMATION_EFFECTS: VisualEffect[] = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'zoom-in-fast'];

export const ProjectProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, accessToken, youtubeChannel } = useAuth(); // Access user state and tokens
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [autoPilotStatus, setAutoPilotStatus] = useState<string>('Idle');
  const [autoPilotLog, setAutoPilotLog] = useState<AutoPilotLogEntry[]>([]);
  
  const automationInterval = useRef<number | null>(null);
  const isRunningAutomation = useRef(false);
  const projectsRef = useRef(projects);

  const storageKey = user?.email ? `darkstream_projects_${user.email}` : 'darkstream_projects_guest';

  // Load projects
  useEffect(() => {
    const loadProjects = async () => {
      setIsLoading(true);
      try {
        let loaded = await get(storageKey); 
        if (!loaded || !Array.isArray(loaded)) setProjects([]);
        else setProjects(loaded);
      } catch (e) { console.error("Failed to load projects", e); } 
      finally { setIsLoading(false); }
    };
    loadProjects();
  }, [storageKey]);

  // Keep ref in sync
  useEffect(() => { projectsRef.current = projects; }, [projects]);

  // Save projects
  useEffect(() => {
    if (!isLoading) {
      set(storageKey, projects).catch(e => console.error("Failed to save projects", e));
    }
  }, [projects, isLoading, storageKey]);

  const addLogEntry = (entry: Omit<AutoPilotLogEntry, 'id' | 'timestamp'>) => {
    setAutoPilotLog(prev => [{
      ...entry, id: crypto.randomUUID(), timestamp: new Date().toISOString()
    }, ...prev].slice(0, 50)); // keep last 50
  };

  const getNextAutoRunInfo = (projectId: string): { nextRunDate: Date | null; isEligible: boolean } => {
    const project = projects.find(p => p.id === projectId);
    if (!project?.scheduleSettings?.autoGenerate) return { nextRunDate: null, isEligible: false };
    
    const freq = project.scheduleSettings.frequencyDays || 1;
    const sortedVideos = [...project.videos].sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const lastVideo = sortedVideos[0];
    
    if (!lastVideo) {
      // Next run is today at start of time window
      const [h, m] = project.scheduleSettings.timeWindowStart.split(':').map(Number);
      const next = new Date(); next.setHours(h, m, 0, 0);
      if (next < new Date()) next.setDate(next.getDate() + 1);
      return { nextRunDate: next, isEligible: true };
    }
    
    const lastDate = new Date(lastVideo.createdAt);
    const nextDate = new Date(lastDate);
    nextDate.setDate(nextDate.getDate() + freq);
    const [h, m] = project.scheduleSettings.timeWindowStart.split(':').map(Number);
    nextDate.setHours(h, m, 0, 0);
    
    return { nextRunDate: nextDate, isEligible: nextDate <= new Date() };
  };

  const triggerAutoPilotNow = (projectId: string) => {
    const project = projects.find(p => p.id === projectId);
    if (!project) return;
    if (isRunningAutomation.current) {
      setAutoPilotStatus("Already running...");
      return;
    }
    runFullAutomationPipeline(project);
  };


  // --- AUTO-PILOT ENGINE ---
  useEffect(() => {
      // Run every 60 seconds
      if (automationInterval.current) clearInterval(automationInterval.current);
      
      automationInterval.current = window.setInterval(async () => {
          if (isRunningAutomation.current) return;
          
          const now = new Date();
          const currentHour = now.getHours();
          const currentMinutes = now.getMinutes();
          const currentTimeValue = currentHour * 60 + currentMinutes;

          // Find a project that needs a video
          const eligibleProject = projects.find(p => {
              if (!p.scheduleSettings?.autoGenerate) return false;
              if (!p.isYoutubeConnected) return false; // Must be connected

              // Parse Window
              const [startH, startM] = p.scheduleSettings.timeWindowStart.split(':').map(Number);
              const [endH, endM] = p.scheduleSettings.timeWindowEnd.split(':').map(Number);
              const startVal = startH * 60 + startM;
              const endVal = endH * 60 + endM;

              // Check Time Window
              if (currentTimeValue < startVal || currentTimeValue > endVal) return false;

              // Check Frequency
              const frequency = p.scheduleSettings.frequencyDays || 1;
              
              // Sort videos by creation date to find the latest one
              const sortedVideos = [...p.videos].sort((a, b) => 
                  new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
              );
              
              const lastVideo = sortedVideos[0];
              
              if (!lastVideo) return true; // No videos yet, start now!

              const lastDate = new Date(lastVideo.createdAt);
              const diffTime = Math.abs(now.getTime() - lastDate.getTime());
              const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

              // If frequency is 1 (daily), we just check if last video was NOT today
              if (frequency === 1) {
                  const isSameDay = lastDate.getDate() === now.getDate() && 
                                  lastDate.getMonth() === now.getMonth() && 
                                  lastDate.getFullYear() === now.getFullYear();
                  return !isSameDay;
              }

              return diffDays >= frequency;
          });

          if (eligibleProject) {
              await runFullAutomationPipeline(eligibleProject);
          }

      }, 60000); // Check every minute

      return () => { if (automationInterval.current) clearInterval(automationInterval.current); };
  }, [projects]);


  const runFullAutomationPipeline = async (project: Project) => {
      if (isRunningAutomation.current) return;
      if (!accessToken || !youtubeChannel) {
          setAutoPilotStatus("Auto-Pilot Paused: YouTube Token Missing");
          return;
      }

      isRunningAutomation.current = true;
      setAutoPilotStatus(`Starting Auto-Pilot for: ${project.title}`);

      try {
          // 1. Generate Idea
          setAutoPilotStatus("Brainstorming Topic...");
          const excludeList = project.videos.map(v => v.title);
          const libraryContext = project.library?.map(item => `[${item.type?.toUpperCase() || 'INFO'}] ${item.title}: ${item.content}`).join('\n') || '';
          const ideas = await generateVideoIdeas(project.channelTheme, project.description || '', project.defaultTone, project.language, excludeList, libraryContext);
          const bestIdea = ideas[0];

          if (!bestIdea) throw new Error("No ideas generated");

          // 2. Create Video Entry
          const video = addVideo(project.id, bestIdea.topic, project.defaultDuration || 'Standard (5-8 min)', project.defaultFormat || 'Landscape 16:9', bestIdea.context);
          
          // 3. Generate Script
          setAutoPilotStatus("Writing Script...");
          const script = await generateVideoScript({ 
              topic: video.title, channelTheme: project.channelTheme, targetDuration: video.targetDuration, 
              tone: project.defaultTone || 'Suspenseful', additionalContext: video.specificContext, 
              language: project.language, libraryContext, visualPacing: project.visualPacing
          });
          
          // Update Video with Script
          const scriptVideo = { ...video, script, status: ProjectStatus.SCRIPTING };
          updateVideo(project.id, video.id, { script, status: ProjectStatus.SCRIPTING });

          // 4. Generate Audio
          setAutoPilotStatus("Synthesizing Voice...");
          const audioBuffers: AudioBuffer[] = [];
          const timestamps = [0];
          let totalDur = 0;
          const ctx = new AudioContext({sampleRate: 24000});
          
          for(let i=0; i<script.segments.length; i++) {
             const seg = script.segments[i];
             const ab = await decodeAudioData(await generateVoiceover(seg.narratorText, project.defaultVoice), ctx);
             audioBuffers.push(ab);
             totalDur += ab.duration;
             if(i < script.segments.length -1) timestamps.push(totalDur);
          }
          const finalAudio = mergeAudioBuffers(audioBuffers, ctx);
          const audioUrl = audioBufferToBase64(finalAudio);
          
          updateVideo(project.id, video.id, { audioUrl, segmentTimestamps: timestamps, status: ProjectStatus.AUDIO_GENERATED });
          const audioVideo = { ...scriptVideo, audioUrl, segmentTimestamps: timestamps };

          // 5. Generate Visuals & Music
          setAutoPilotStatus("Generating Visuals & Music...");
          const scenes: VisualScene[] = [];
          for(let i=0; i<script.segments.length; i++) {
              const start = timestamps[i];
              const next = timestamps[i+1] || totalDur;
              const totalSegmentDur = next - start;
              
              const seg = script.segments[i];
              const prompts = seg.visualDescriptions || [];
              
              const weights = prompts.map(() => 0.5 + Math.random());
              const totalWeight = weights.reduce((a, b) => a + b, 0);
              const sceneDurations = weights.map(w => (w / totalWeight) * totalSegmentDur);
              
              let currentSceneStart = start;

              for (let j = 0; j < prompts.length; j++) {
                  const prompt = prompts[j];
                  const dur = sceneDurations[j];
                  
                  if (i > 0 || j > 0) await new Promise(r => setTimeout(r, 6000));
                  
                  let imgUrl = '';
                  let videoUrl = undefined;

                  // Pexels Integration for Automation
                  const pexelsChance = (project.visualSourceMix?.pexelsPercentage || 50) / 100;

                  if (Math.random() < pexelsChance) {
                      try {
                          const keywords = await generatePexelsKeywords(prompt);
                          const videos = await searchStockVideos(keywords, project.defaultTone, project.defaultFormat);
                          if (videos.length > 0) {
                              const bestVideo = videos[0];
                              videoUrl = bestVideo.videoUrl;
                              imgUrl = bestVideo.thumbnailUrl;
                          }
                      } catch (e) {
                          console.warn("Pexels search failed in automation", e);
                      }
                  }

                  if (!imgUrl) {
                      imgUrl = await generateSceneImage(prompt, project.defaultTone, video.format);
                  }

                  scenes.push({
                      segmentIndex: i, imageUrl: imgUrl, videoUrl, prompt: prompt,
                      effect: ANIMATION_EFFECTS[(i + j) % ANIMATION_EFFECTS.length], 
                      startTime: currentSceneStart, 
                      duration: dur
                  });
                  currentSceneStart += dur;
              }
          }
          const musicUrl = await generateDarkAmbience(project.defaultTone || 'Dark');
          const thumbnailUrl = await generateThumbnail(video.title, project.defaultTone);
          
          updateVideo(project.id, video.id, { visualScenes: scenes, backgroundMusicUrl: musicUrl, thumbnailUrl, status: ProjectStatus.VIDEO_GENERATED });
          const visualVideo = { ...audioVideo, visualScenes: scenes, backgroundMusicUrl: musicUrl, thumbnailUrl };

          // 6. Generate Metadata
          setAutoPilotStatus("Optimizing Metadata...");
          const metadata = await generateVideoMetadata(video.title, script.segments.map(s=>s.narratorText).join(' '), project.defaultTone, project.language, script.segments);
          updateVideo(project.id, video.id, { videoMetadata: metadata });
          const finalVideo = { ...visualVideo, videoMetadata: metadata };

          // 7. Render & Upload
          setAutoPilotStatus("Rendering Video (This may take a minute)...");
          const blob = await renderVideoHeadless(finalVideo, (pct, status) => {
              setAutoPilotStatus(`Auto-Pilot: ${status}`);
          });

          const file = new File([blob], "video.webm", { type: 'video/webm' });
          
          setAutoPilotStatus("Uploading to YouTube...");
          const ytbId = await uploadVideoToYouTube(accessToken, file, metadata, thumbnailUrl); // No schedule date = publish immediately (or default private)

          updateVideo(project.id, video.id, { status: ProjectStatus.PUBLISHED, youtubeUrl: `https://youtu.be/${ytbId}` });
          setAutoPilotStatus("Auto-Pilot Complete!");
          addLogEntry({ projectId: project.id, projectTitle: project.title, videoTitle: video.title, status: 'success', message: `Video published: ${video.title}` });

      } catch (e: any) {
          console.error("Auto-Pilot Failed", e);
          setAutoPilotStatus(`Auto-Pilot Error: ${e.message}`);
          addLogEntry({ projectId: project.id, projectTitle: project.title, status: 'error', message: e.message });
      } finally {
          isRunningAutomation.current = false;
          setTimeout(() => setAutoPilotStatus("Idle"), 5000);
      }
  };


  // --- EXISTING ACTIONS (Preserved) ---
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
                  id: crypto.randomUUID(), 
                  topic: i.topic, 
                  context: i.context, 
                  specificContext: i.specificContext,
                  status: 'new', 
                  createdAt: new Date().toISOString()
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
      projects, isLoading, autoPilotStatus, autoPilotLog,
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