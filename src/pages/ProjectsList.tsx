import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useProjects } from '../context/ProjectContext';
import { ProjectCard } from '../components/ProjectCard';
import { Project, ProjectStatus } from '../types';
import { Search, Filter, Plus, Film, X, Youtube, SlidersHorizontal, Layers, AlertOctagon, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export const ProjectsList: React.FC = () => {
  const { projects, addProject, deleteProject } = useProjects();
  const navigate = useNavigate();
  
  // UI State
  const [searchQuery, setSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);

  // New Project State
  const [channelTheme, setChannelTheme] = useState('');
  const [description, setDescription] = useState('');

  // Filter Logic
  const filteredProjects = projects.filter(p => {
    return p.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
           (p.description && p.description.toLowerCase().includes(searchQuery.toLowerCase()));
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!channelTheme) return;
    const project = addProject(channelTheme, description);
    setIsModalOpen(false);
    navigate(`/project/${project.id}`);
  };

  const handleDeleteClick = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const project = projects.find(p => p.id === id);
    if (project) setProjectToDelete(project);
  };

  const confirmDelete = () => {
    if (projectToDelete) {
      deleteProject(projectToDelete.id);
      setProjectToDelete(null);
    }
  };

  return (
    <div className="space-y-8 min-h-full flex flex-col">
      {/* Header & Controls */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-slate-900/30 p-6 rounded-2xl border border-slate-800/50 backdrop-blur-sm">
        <div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-3">
            <Layers className="w-8 h-8 text-orange-400" />
            Niche Library
          </h1>
          <p className="text-slate-400 mt-1">Manage your different YouTube channels and content themes.</p>
        </div>

        <button 
          onClick={() => setIsModalOpen(true)}
          className="bg-orange-600 hover:bg-orange-500 text-white px-5 py-3 rounded-xl font-bold flex items-center gap-2 shadow-lg shadow-orange-600/20 transition-all hover:scale-105 active:scale-95"
        >
          <Plus className="w-5 h-5" />
          New Channel Theme
        </button>
      </div>

      {/* Filters Bar */}
      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
        <input 
          type="text" 
          placeholder="Search niches..." 
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-12 pr-4 py-3 text-white focus:ring-2 focus:ring-orange-500/50 focus:border-orange-500 outline-none transition-all placeholder-slate-600"
        />
      </div>

      {/* Projects Grid */}
      {filteredProjects.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-20 border-2 border-dashed border-slate-800 rounded-3xl bg-slate-900/10">
           <div className="w-16 h-16 bg-slate-800/50 rounded-full flex items-center justify-center mb-4">
              <SlidersHorizontal className="w-8 h-8 text-slate-600" />
           </div>
           <h3 className="text-xl font-bold text-slate-400 mb-2">No niches found</h3>
           <p className="text-slate-600 max-w-xs text-center">Create a new niche to start organizing your videos.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 pb-10">
          {filteredProjects.map(project => (
            <ProjectCard key={project.id} project={project} onDelete={handleDeleteClick} />
          ))}
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {projectToDelete && createPortal(
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => setProjectToDelete(null)}></div>
          <div className="relative bg-[#0B1121] border border-red-500/20 rounded-2xl w-full max-w-md shadow-2xl shadow-black/50 overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="p-6 text-center">
              <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-4 border border-red-500/20">
                <AlertOctagon className="w-8 h-8 text-red-500" />
              </div>
              <h2 className="text-xl font-bold text-white mb-2">Excluir Projeto?</h2>
              <p className="text-slate-400 text-sm mb-6">
                Tem certeza que deseja excluir o projeto <span className="text-white font-bold">"{projectToDelete.title}"</span>? Esta ação é irreversível e excluirá permanentemente todos os vídeos e dados associados.
              </p>
              <div className="flex gap-3">
                <button 
                  onClick={() => setProjectToDelete(null)} 
                  className="flex-1 px-4 py-3 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors font-medium"
                >
                  Cancelar
                </button>
                <button 
                  onClick={confirmDelete} 
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

      {/* Creation Modal (Portal) */}
      {isModalOpen && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-md" onClick={() => setIsModalOpen(false)}></div>
          
          <div className="relative bg-[#0B1121] border border-slate-800 rounded-2xl w-full max-w-lg shadow-2xl shadow-black/50 overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="bg-slate-900/50 p-6 border-b border-slate-800 flex justify-between items-center">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-orange-500/10 rounded-lg">
                        <Youtube className="w-5 h-5 text-orange-400" />
                    </div>
                    <h2 className="text-xl font-bold text-white">New Channel Theme</h2>
                </div>
                <button onClick={() => setIsModalOpen(false)} className="text-slate-500 hover:text-white transition-colors">
                    <X className="w-6 h-6" />
                </button>
            </div>

            <form onSubmit={handleCreate} className="p-6 space-y-6">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-slate-300 ml-1">Channel Theme / Niche</label>
                <input 
                  type="text" 
                  value={channelTheme}
                  onChange={e => setChannelTheme(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-orange-500 outline-none transition-all placeholder-slate-600"
                  placeholder="e.g., True Crime, Cosmic Horror"
                  autoFocus
                />
              </div>
              
              <div className="space-y-2">
                <label className="text-sm font-semibold text-slate-300 ml-1">Description (Optional)</label>
                <textarea 
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-orange-500 outline-none transition-all h-24 resize-none placeholder-slate-600"
                  placeholder="What is this channel about?"
                />
              </div>
              
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setIsModalOpen(false)} className="flex-1 px-4 py-3 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors">Cancel</button>
                <button type="submit" disabled={!channelTheme} className="flex-1 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white px-6 py-3 rounded-xl font-bold shadow-lg transition-all active:scale-95">Create Niche</button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};