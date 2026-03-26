import React from 'react';
import { Link } from 'react-router-dom';
import { Project, ProjectStatus } from '../types';
import { Clock, Film, Layers, Trash2 } from 'lucide-react';

interface ProjectCardProps {
  project: Project;
  onDelete?: (id: string, e: React.MouseEvent) => void;
}

export const ProjectCard: React.FC<ProjectCardProps> = ({ project, onDelete }) => {
  // Find the latest modified video to show thumbnail
  const latestVideo = project.videos && project.videos.length > 0 
    ? [...project.videos].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]
    : null;

  const publishedCount = project.videos ? project.videos.filter(v => v.status === ProjectStatus.PUBLISHED).length : 0;
  const totalVideos = project.videos ? project.videos.length : 0;

  const hasThumbnail = latestVideo && latestVideo.visualScenes && latestVideo.visualScenes.length > 0;
  const thumbnail = hasThumbnail ? latestVideo.visualScenes![0].imageUrl : null;
  
  // Deterministic gradient fallback - Warm Tones
  const getGradient = (id: string) => {
    const variants = [
      'from-slate-900 via-orange-950 to-slate-900',
      'from-slate-900 via-amber-950 to-slate-900',
      'from-slate-900 via-red-950 to-slate-900',
    ];
    const index = id.charCodeAt(0) % variants.length;
    return variants[index];
  };

  return (
    <div className="relative group h-full">
      <Link to={`/project/${project.id}`} className="block h-full">
        <div className="relative h-full bg-[#0F1629] border border-slate-800/60 rounded-xl overflow-hidden hover:border-orange-500/40 hover:shadow-[0_0_40px_-10px_rgba(249,115,22,0.2)] transition-all duration-300 flex flex-col group-hover:-translate-y-1">
          
          {/* Cover Image / Header */}
          <div className="relative h-44 w-full overflow-hidden bg-slate-950">
              {thumbnail ? (
                  <>
                      <img 
                          src={thumbnail} 
                          alt={project.title} 
                          className="w-full h-full object-cover opacity-80 group-hover:opacity-100 group-hover:scale-105 transition-all duration-700" 
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-[#0F1629] via-transparent to-transparent opacity-90"></div>
                  </>
              ) : (
                  <div className={`w-full h-full bg-gradient-to-br ${getGradient(project.id)}`}>
                      <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20"></div>
                      <div className="absolute inset-0 flex items-center justify-center">
                           <Layers className="w-12 h-12 text-white/10 group-hover:text-white/20 transition-colors" />
                      </div>
                  </div>
              )}

              {/* Floating Badge */}
              <div className="absolute top-3 left-3 z-10">
                  <span className={`px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider backdrop-blur-md border shadow-lg bg-orange-500/10 text-orange-400 border-orange-500/20`}>
                      Channel
                  </span>
              </div>

              {/* Video Count Badge */}
              <div className="absolute bottom-3 right-3 z-10">
                   <div className="bg-black/60 backdrop-blur-sm px-2 py-0.5 rounded text-[10px] font-mono text-slate-300 border border-white/10 flex items-center gap-1">
                      <Film className="w-3 h-3" />
                      {totalVideos} Videos
                   </div>
              </div>
          </div>

          {/* Content Body */}
          <div className="p-5 flex flex-col flex-1 relative">
            
            <h3 className="text-lg font-bold text-white group-hover:text-orange-400 transition-colors line-clamp-2 mb-2 leading-snug">
              {project.title}
            </h3>
            
            <p className="text-xs text-slate-500 line-clamp-2 mb-4 leading-relaxed font-light">
              {project.description || "No description provided."}
            </p>

            <div className="mt-auto pt-4 flex items-center justify-between border-t border-slate-800/50">
               <div className="flex items-center gap-3 text-slate-600">
                  <div className="text-[10px] uppercase font-bold tracking-wider">
                      {publishedCount} Published
                  </div>
               </div>
               
               <div className="flex items-center text-[10px] text-slate-500 font-mono">
                  <Clock className="w-3 h-3 mr-1.5 opacity-50" />
                  {new Date(project.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
               </div>
            </div>
          </div>
        </div>
      </Link>

      {/* Delete Button - Absolute positioned outside the Link but inside the relative container */}
      {onDelete && (
        <button 
          onClick={(e) => onDelete(project.id, e)}
          className="absolute top-3 right-3 z-20 p-2 bg-black/40 hover:bg-red-500/80 text-white/60 hover:text-white rounded-lg backdrop-blur-sm border border-white/10 transition-all opacity-0 group-hover:opacity-100"
          title="Delete Niche"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
};
