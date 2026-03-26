import React from 'react';
import { useProjects } from '../context/ProjectContext';
import { ProjectStatus } from '../types';
import { Calendar as CalendarIcon, Clock, MoreHorizontal, GripVertical, ListOrdered, ChevronRight, PlayCircle } from 'lucide-react';
import { Link } from 'react-router-dom';

export const Scheduler: React.FC = () => {
  const { projects } = useProjects();
  
  // Flatten videos from all projects
  const allVideos = projects.flatMap(p => p.videos.map(v => ({ 
      ...v, 
      projectTitle: p.title,
      projectTheme: p.channelTheme 
  })));

  // 1. Get Scheduled Queue (Sorted by Date)
  const scheduledQueue = allVideos
    .filter(v => v.status === ProjectStatus.SCHEDULED && v.scheduledDate)
    .sort((a, b) => new Date(a.scheduledDate!).getTime() - new Date(b.scheduledDate!).getTime());

  // 2. Get Calendar Data (Current Week)
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  
  const getVideosForDay = (dayIndex: number) => {
    return allVideos.filter(v => {
        if (v.status !== ProjectStatus.SCHEDULED || !v.scheduledDate) return false;
        
        const date = new Date(v.scheduledDate);
        const jsDay = date.getDay(); 
        const uiDay = jsDay === 0 ? 6 : jsDay - 1; // Convert Sun=0 to Sun=6
        
        // Filter for current week only (Simple visual implementation)
        return uiDay === dayIndex;
    });
  };

  return (
    <div className="h-full flex flex-col space-y-6">
      <div className="flex justify-between items-center bg-slate-900/50 p-6 rounded-2xl border border-slate-800">
        <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-3">
                <CalendarIcon className="w-7 h-7 text-orange-400" />
                Content Calendar & Queue
            </h1>
            <p className="text-slate-400 text-sm mt-1">Manage your upload schedule and view the global posting queue.</p>
        </div>
        
        <div className="flex items-center space-x-4">
            <div className="flex items-center gap-2 text-sm text-slate-400">
                <div className="w-2 h-2 rounded-full bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.5)]"></div>
                Scheduled
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-400">
                <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]"></div>
                Published
            </div>
        </div>
      </div>

      <div className="flex-1 flex gap-6 min-h-[600px] overflow-hidden">
        
        {/* LEFT: WEEKLY CALENDAR GRID */}
        <div className="flex-1 flex flex-col overflow-hidden">
            <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-4 flex items-center gap-2">
                <CalendarIcon className="w-4 h-4" /> Weekly Grid
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
                                            video.status === ProjectStatus.PUBLISHED ? 'bg-green-500' : 'bg-yellow-500'
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
                    Global Upload Queue
                </h3>
                <p className="text-[10px] text-slate-500 mt-0.5">Sorted by next upload time</p>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-3">
                {scheduledQueue.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-40 text-slate-500 text-center p-4">
                        <Clock className="w-8 h-8 mb-2 opacity-30" />
                        <p className="text-xs">No videos in queue.</p>
                        <Link to="/projects" className="text-xs text-orange-400 hover:underline mt-1">Schedule a video</Link>
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
                                    {/* Queue Number */}
                                    <div className="absolute -left-3 top-1/2 -translate-y-1/2 w-6 h-6 bg-slate-900 border border-slate-700 rounded-full flex items-center justify-center text-[10px] text-slate-400 font-mono shadow z-10">
                                        {idx + 1}
                                    </div>

                                    <div className="flex gap-3">
                                        {/* Thumbnail */}
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
                                                        Next Up
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