import React, { useState, useEffect } from 'react';
import { useProjects, AutoPilotLogEntry } from '../context/ProjectContext';
import { ProjectStatus } from '../types';
import { STEP_LABELS } from '../services/automationService';
import { 
  Calendar as CalendarIcon, Clock, ListOrdered, PlayCircle, Bot, Zap, 
  CheckCircle, XCircle, Loader2, Timer, ArrowRight, AlertTriangle, 
  Activity, PauseCircle
} from 'lucide-react';
import { Link } from 'react-router-dom';

// --- Sub-Components ---

const formatTimeUntil = (date: Date): string => {
  const now = new Date();
  const diff = date.getTime() - now.getTime();
  if (diff <= 0) return 'Agora';
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const formatElapsed = (ms: number): string => {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
};

const ALL_STEPS = ['idea', 'script', 'voice', 'visuals', 'studio', 'thumbnail', 'metadata', 'upload'] as const;

const ProgressPanel: React.FC = () => {
  const { autoPilotProgress } = useProjects();
  const [elapsed, setElapsed] = useState(0);
  const [stepElapsed, setStepElapsed] = useState(0);

  useEffect(() => {
    if (!autoPilotProgress.isRunning) return;
    const interval = setInterval(() => {
      if (autoPilotProgress.pipelineStartTime) setElapsed(Date.now() - autoPilotProgress.pipelineStartTime);
      if (autoPilotProgress.stepStartTime) setStepElapsed(Date.now() - autoPilotProgress.stepStartTime);
    }, 1000);
    return () => clearInterval(interval);
  }, [autoPilotProgress.isRunning, autoPilotProgress.pipelineStartTime, autoPilotProgress.stepStartTime]);

  if (!autoPilotProgress.isRunning) return null;

  const currentIdx = autoPilotProgress.currentStep 
    ? ALL_STEPS.indexOf(autoPilotProgress.currentStep) 
    : -1;

  return (
    <div className="bg-gradient-to-r from-orange-950/30 to-slate-900/60 border border-orange-500/30 rounded-2xl p-5 space-y-4 animate-in fade-in">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          <Activity className="w-5 h-5 text-orange-400 animate-pulse" />
          Pipeline em Execução
        </h2>
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span>Total: <span className="text-white font-mono">{formatElapsed(elapsed)}</span></span>
          <span>Passo: <span className="text-orange-300 font-mono">{formatElapsed(stepElapsed)}</span></span>
        </div>
      </div>

      {/* Step Progress Bar */}
      <div className="flex items-center gap-1">
        {ALL_STEPS.map((step, idx) => {
          const isDone = idx < currentIdx;
          const isCurrent = idx === currentIdx;
          return (
            <div key={step} className="flex-1 flex flex-col items-center gap-1">
              <div className={`h-1.5 w-full rounded-full transition-all duration-500 ${
                isDone ? 'bg-green-500' : isCurrent ? 'bg-orange-500 animate-pulse' : 'bg-slate-800'
              }`} />
              <span className={`text-[9px] font-medium truncate max-w-full ${
                isDone ? 'text-green-400' : isCurrent ? 'text-orange-400' : 'text-slate-600'
              }`}>
                {STEP_LABELS[step].split(' ')[0]}
              </span>
            </div>
          );
        })}
      </div>

      {/* Current Status */}
      <div className="flex items-center gap-2 bg-slate-950/50 px-4 py-3 rounded-xl border border-slate-800">
        <Loader2 className="w-4 h-4 text-orange-400 animate-spin flex-shrink-0" />
        <span className="text-sm text-slate-300 truncate">{autoPilotProgress.stepMessage}</span>
      </div>
    </div>
  );
};

const StandbyVideos: React.FC = () => {
  const { projects } = useProjects();
  const standbyVideos = projects.flatMap(p => 
    p.videos
      .filter(v => v.status === ProjectStatus.STANDBY && v.standbyInfo)
      .map(v => ({ ...v, projectTitle: p.title }))
  );

  if (standbyVideos.length === 0) return null;

  return (
    <div className="bg-yellow-950/20 border border-yellow-600/30 rounded-2xl p-5 space-y-3">
      <h2 className="text-sm font-bold text-yellow-400 flex items-center gap-2">
        <PauseCircle className="w-5 h-5" />
        Vídeos em Standby ({standbyVideos.length})
      </h2>
      <p className="text-[11px] text-slate-400">Esses vídeos tiveram falha em alguma etapa. Você pode reprocessá-los manualmente.</p>
      <div className="space-y-2">
        {standbyVideos.map(v => (
          <Link 
            key={v.id}
            to={`/project/${v.projectId}/video/${v.id}/editor`}
            className="flex items-center gap-3 bg-slate-950/50 px-4 py-3 rounded-xl border border-slate-800 hover:border-yellow-500/40 transition-colors group"
          >
            <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-white truncate">{v.title}</span>
                <span className="text-[10px] text-slate-500">({v.projectTitle})</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] bg-red-500/10 text-red-400 px-2 py-0.5 rounded border border-red-500/20">
                  Falhou em: {v.standbyInfo ? STEP_LABELS[v.standbyInfo.failedStep] : '?'}
                </span>
                <span className="text-[10px] text-slate-500 truncate">{v.standbyInfo?.errorMessage}</span>
              </div>
            </div>
            <ArrowRight className="w-4 h-4 text-slate-600 group-hover:text-yellow-400 transition-colors" />
          </Link>
        ))}
      </div>
    </div>
  );
};

const AutoPilotProjects: React.FC = () => {
  const { projects, autoPilotStatus, autoPilotLog, triggerAutoPilotNow, getNextAutoRunInfo } = useProjects();
  const autoProjects = projects.filter(p => p.scheduleSettings?.autoGenerate);
  const isRunning = autoPilotStatus !== 'Idle';

  if (autoProjects.length === 0) return null;

  const logIcon = (status: AutoPilotLogEntry['status']) => {
    switch(status) {
      case 'success': return <CheckCircle className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />;
      case 'error': return <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />;
      case 'running': return <Loader2 className="w-3.5 h-3.5 text-orange-400 animate-spin flex-shrink-0" />;
      default: return <Timer className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />;
    }
  };

  return (
    <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          <Bot className="w-5 h-5 text-orange-400" />
          Auto-Pilot Projects
        </h2>
        <span className="text-[10px] text-slate-500 uppercase tracking-wider">
          {autoProjects.length} projeto{autoProjects.length > 1 ? 's' : ''} ativo{autoProjects.length > 1 ? 's' : ''}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {autoProjects.map(p => {
          const info = getNextAutoRunInfo(p.id);
          const freq = p.scheduleSettings?.frequencyDays || 1;
          const freqLabel = freq === 1 ? 'Diário' : freq === 7 ? 'Semanal' : `A cada ${freq} dias`;
          
          return (
            <div key={p.id} className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-white truncate max-w-[180px]">{p.title}</h3>
                <span className="text-[10px] bg-orange-500/10 text-orange-400 px-2 py-0.5 rounded-full border border-orange-500/20 font-medium">
                  {freqLabel}
                </span>
              </div>
              
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Clock className="w-3.5 h-3.5" />
                <span>Janela: {p.scheduleSettings?.timeWindowStart} - {p.scheduleSettings?.timeWindowEnd}</span>
              </div>
              
              <div className="flex items-center gap-2 text-xs">
                <Timer className="w-3.5 h-3.5 text-slate-500" />
                {info.nextRunDate ? (
                  <span className={info.isEligible ? 'text-green-400 font-medium' : 'text-slate-400'}>
                    Próximo: {info.isEligible ? 'Pronto agora!' : formatTimeUntil(info.nextRunDate)}
                  </span>
                ) : (
                  <span className="text-slate-500">Sem agendamento</span>
                )}
              </div>
              
              <div className="flex gap-2">
                <button
                  onClick={() => triggerAutoPilotNow(p.id)}
                  disabled={isRunning}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-orange-600 hover:bg-orange-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-xs font-bold py-2 rounded-lg transition-colors"
                >
                  <Zap className="w-3.5 h-3.5" />
                  {isRunning ? 'Executando...' : 'Executar Agora'}
                </button>
                <Link 
                  to={`/project/${p.id}`}
                  className="flex items-center gap-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-3 py-2 rounded-lg transition-colors"
                >
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      {/* Activity Log */}
      {autoPilotLog.length > 0 && (
        <div className="mt-4 space-y-2">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Atividade Recente</h3>
          <div className="max-h-40 overflow-y-auto custom-scrollbar space-y-1.5">
            {autoPilotLog.slice(0, 20).map(entry => (
              <div key={entry.id} className="flex items-start gap-2 text-xs bg-slate-950/50 px-3 py-2 rounded-lg border border-slate-800/50">
                {logIcon(entry.status)}
                <div className="flex-1 min-w-0">
                  <span className="text-slate-300 font-medium">{entry.projectTitle}</span>
                  {entry.videoTitle && <span className="text-slate-500"> — {entry.videoTitle}</span>}
                  {entry.step && <span className="text-slate-600 text-[10px]"> [{STEP_LABELS[entry.step]}]</span>}
                  <p className="text-slate-500 truncate">{entry.message}</p>
                  {entry.elapsedMs && (
                    <span className="text-[10px] text-slate-600">Duração: {formatElapsed(entry.elapsedMs)}</span>
                  )}
                </div>
                <span className="text-[10px] text-slate-600 whitespace-nowrap">
                  {new Date(entry.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// --- MAIN PAGE ---

export const Scheduler: React.FC = () => {
  const { projects } = useProjects();
  const [, setTick] = useState(0);
  
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(interval);
  }, []);
  
  const allVideos = projects.flatMap(p => p.videos.map(v => ({ 
      ...v, projectTitle: p.title, projectTheme: p.channelTheme 
  })));

  const scheduledQueue = allVideos
    .filter(v => v.status === ProjectStatus.SCHEDULED && v.scheduledDate)
    .sort((a, b) => new Date(a.scheduledDate!).getTime() - new Date(b.scheduledDate!).getTime());

  const days = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
  
  const getVideosForDay = (dayIndex: number) => {
    return allVideos.filter(v => {
        if (v.status !== ProjectStatus.SCHEDULED || !v.scheduledDate) return false;
        const date = new Date(v.scheduledDate);
        const jsDay = date.getDay(); 
        const uiDay = jsDay === 0 ? 6 : jsDay - 1;
        return uiDay === dayIndex;
    });
  };

  return (
    <div className="h-full flex flex-col space-y-6">
      {/* HEADER */}
      <div className="flex justify-between items-center bg-slate-900/50 p-6 rounded-2xl border border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <CalendarIcon className="w-7 h-7 text-orange-400" />
            Calendário & Automação
          </h1>
          <p className="text-slate-400 text-sm mt-1">Gerencie seu calendário de uploads e o motor auto-pilot.</p>
        </div>
        <div className="flex items-center space-x-4">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <div className="w-2 h-2 rounded-full bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.5)]"></div>
            Agendado
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]"></div>
            Publicado
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <div className="w-2 h-2 rounded-full bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.5)]"></div>
            Standby
          </div>
        </div>
      </div>

      {/* PROGRESS PANEL (only visible during execution) */}
      <ProgressPanel />

      {/* STANDBY VIDEOS */}
      <StandbyVideos />

      {/* AUTO-PILOT PROJECTS */}
      <AutoPilotProjects />

      <div className="flex-1 flex gap-6 min-h-[400px] overflow-hidden">
        {/* LEFT: WEEKLY CALENDAR GRID */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-4 flex items-center gap-2">
            <CalendarIcon className="w-4 h-4" /> Grade Semanal
          </h3>
          <div className="flex-1 grid grid-cols-7 gap-3">
            {days.map((day, index) => {
              const dayVideos = getVideosForDay(index);
              const todayIndex = new Date().getDay() === 0 ? 6 : new Date().getDay() - 1;
              const isToday = index === todayIndex;

              return (
                <div key={day} className={`flex flex-col rounded-xl border ${isToday ? 'bg-slate-900/60 border-orange-500/30' : 'bg-slate-900/30 border-slate-800/60'} overflow-hidden transition-colors hover:bg-slate-900/60`}>
                  <div className={`p-3 text-center border-b ${isToday ? 'border-orange-500/20 bg-orange-500/5' : 'border-slate-800/60 bg-slate-900/50'}`}>
                    <span className={`text-xs font-bold uppercase tracking-wider ${isToday ? 'text-orange-400' : 'text-slate-400'}`}>
                      {day}
                    </span>
                  </div>
                  <div className="p-2 flex-1 space-y-2 overflow-y-auto custom-scrollbar relative">
                    {dayVideos.map(video => (
                      <Link to={`/project/${video.projectId}/video/${video.id}/editor`} key={video.id} className="block group relative bg-slate-800/80 backdrop-blur p-2 rounded-lg border border-slate-700 hover:border-orange-500/50 hover:shadow-lg transition-all hover:-translate-y-0.5">
                        <div className={`w-1.5 h-1.5 rounded-full mb-1.5 ${
                          video.status === ProjectStatus.PUBLISHED ? 'bg-green-500' : 
                          video.status === ProjectStatus.STANDBY ? 'bg-orange-500' : 'bg-yellow-500'
                        }`} />
                        <div className="font-semibold text-slate-200 text-[11px] leading-tight mb-1 line-clamp-2">
                          {video.title}
                        </div>
                        <div className="flex items-center text-slate-500 text-[10px]">
                          <Clock className="w-2.5 h-2.5 mr-1" />
                          <span>{new Date(video.scheduledDate!).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* RIGHT: CHRONOLOGICAL QUEUE SIDEBAR */}
        <div className="w-80 flex-shrink-0 flex flex-col bg-slate-900/30 border border-slate-800 rounded-2xl overflow-hidden">
          <div className="p-4 border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <ListOrdered className="w-4 h-4 text-orange-400" />
              Fila de Upload
            </h3>
            <p className="text-[10px] text-slate-500 mt-0.5">Ordenado por próximo upload</p>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-3">
            {scheduledQueue.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-slate-500 text-center p-4">
                <Clock className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-xs">Nenhum vídeo na fila.</p>
                <Link to="/projects" className="text-xs text-orange-400 hover:underline mt-1">Agendar um vídeo</Link>
              </div>
            ) : (
              scheduledQueue.map((video, idx) => {
                const date = new Date(video.scheduledDate!);
                const isNext = idx === 0;
                const visual = video.visualScenes?.[0]?.imageUrl;

                return (
                  <Link to={`/project/${video.projectId}/video/${video.id}/editor`} key={video.id} className="block group">
                    <div className={`relative p-3 rounded-xl border transition-all ${
                      isNext 
                        ? 'bg-gradient-to-r from-orange-900/20 to-slate-900 border-orange-500/40 shadow-lg shadow-orange-900/10' 
                        : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                    }`}>
                      <div className="absolute -left-3 top-1/2 -translate-y-1/2 w-6 h-6 bg-slate-900 border border-slate-700 rounded-full flex items-center justify-center text-[10px] text-slate-400 font-mono shadow z-10">
                        {idx + 1}
                      </div>

                      <div className="flex gap-3">
                        <div className="w-12 h-12 rounded-lg bg-slate-900 flex-shrink-0 overflow-hidden border border-slate-700/50 relative">
                          {visual ? (
                            <img src={visual} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <PlayCircle className="w-5 h-5 text-slate-600" />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-start">
                            <span className="text-[10px] text-orange-400 font-medium truncate max-w-[100px] block">
                              {video.projectTitle}
                            </span>
                            <span className="text-[10px] text-slate-500 font-mono whitespace-nowrap">
                              {date.toLocaleDateString(undefined, {month:'short', day:'numeric'})}
                            </span>
                          </div>
                          <h4 className="text-xs font-bold text-white leading-tight truncate mt-0.5 group-hover:text-orange-300 transition-colors">
                            {video.title}
                          </h4>
                          <div className="flex items-center gap-2 mt-1.5">
                            <div className="flex items-center text-[10px] text-slate-400 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">
                              <Clock className="w-2.5 h-2.5 mr-1" />
                              {date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                            </div>
                            {isNext && (
                              <span className="text-[9px] font-bold text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded uppercase tracking-wider">
                                Próximo
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    {idx < scheduledQueue.length - 1 && (
                      <div className="h-4 w-0.5 bg-slate-800 ml-8 my-1"></div>
                    )}
                  </Link>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
