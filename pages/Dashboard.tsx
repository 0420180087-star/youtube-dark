import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useProjects } from '../context/ProjectContext';
import { ProjectCard } from '../components/ProjectCard';
import { Plus, Sparkles, TrendingUp, Activity, Layers, X, Youtube, AlertOctagon, Trash2 } from 'lucide-react';
import { useNavigate, Link } from 'react-router-dom';
import { Project } from '../types';

export const Dashboard: React.FC = () => {
  const { projects, addProject, deleteProject } = useProjects();
  const navigate = useNavigate();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  
  // State for new project (Channel Theme only now)
  const [channelTheme, setChannelTheme] = useState('');
  const [description, setDescription] = useState('');

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!channelTheme) return;
    
    // Create the Project (Container)
    const project = addProject(channelTheme, description);
    
    setIsModalOpen(false);
    // Navigate to the HUB
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

  // Calculate total generated videos across all projects
  const totalVideos = projects.reduce((acc, p) => acc + p.videos.length, 0);

  return (
    <div className="space-y-8 md:space-y-10">
      {/* Hero Header */}
      <div className="relative overflow-hidden rounded-2xl md:rounded-3xl bg-gradient-to-r from-orange-900/40 via-amber-900/20 to-slate-900/40 border border-white/10 p-6 md:p-12">
        <div className="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
            <div>
              <h1 className="text-3xl md:text-5xl font-extrabold text-white mb-2 md:mb-3 tracking-tight">
                Creator <span className="text-transparent bg-clip-text bg-gradient-to-r from-orange-400 to-amber-400">Dashboard</span>
              </h1>
              <p className="text-sm md:text-lg text-slate-400 max-w-xl">
                Manage your YouTube Empires. Create specialized channels (Projects) and generate unlimited videos for each niche.
              </p>
            </div>
            <button 
              onClick={() => setIsModalOpen(true)}
              className="w-full md:w-auto group bg-white text-slate-950 hover:bg-orange-50 px-6 py-3 md:py-4 rounded-xl flex items-center justify-center gap-3 font-bold transition-all shadow-[0_0_20px_rgba(255,255,255,0.1)] hover:shadow-[0_0_30px_rgba(249,115,22,0.4)] active:scale-95"
            >
              <div className="bg-slate-950 rounded-full p-1">
                  <Plus className="w-4 h-4 text-white" />
              </div>
              <span>New Channel/Niche</span>
            </button>
        </div>
        
        {/* Decorative background elements */}
        <div className="absolute top-0 right-0 w-64 h-64 bg-orange-500/10 blur-[80px] -translate-y-1/2 translate-x-1/2"></div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 md:gap-6">
        <StatCard 
            icon={Activity} 
            value={projects.length.toString()} 
            label="Active Niches" 
            trend="Projects" 
            color="orange" 
        />
        <StatCard 
            icon={Sparkles} 
            value={totalVideos.toString()} 
            label="Total Videos" 
            trend="Generated" 
            color="amber" 
        />
        <StatCard 
            icon={TrendingUp} 
            value="0" 
            label="Pending Publish" 
            trend="Needs attention" 
            color="red" 
        />
      </div>

      {/* Recent Projects Section */}
      <div className="space-y-4 md:space-y-6">
        <div className="flex items-center justify-between">
            <h2 className="text-xl md:text-2xl font-bold text-white flex items-center gap-2">
                <Layers className="w-5 h-5 md:w-6 md:h-6 text-orange-400" />
                Your Niches
            </h2>
            <Link to="/projects" className="text-sm text-slate-500 hover:text-orange-400 transition-colors flex items-center gap-1">
                View All
            </Link>
        </div>
        
        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 md:py-24 border border-dashed border-slate-800 rounded-3xl bg-slate-900/20 text-center group cursor-pointer hover:bg-slate-900/40 transition-all" onClick={() => setIsModalOpen(true)}>
            <div className="w-16 h-16 bg-slate-800 rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <Plus className="w-8 h-8 text-slate-500 group-hover:text-orange-400" />
            </div>
            <h3 className="text-xl font-bold text-slate-300 mb-2">No projects yet</h3>
            <p className="text-slate-500 max-w-sm px-4">Create a Channel Theme to start generating videos.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects.slice(0, 6).map(p => (
              <ProjectCard key={p.id} project={p} onDelete={handleDeleteClick} />
            ))}
          </div>
        )}
      </div>

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

      {/* New Project Modal (Portal) */}
      {isModalOpen && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-md" onClick={() => setIsModalOpen(false)}></div>
          
          <div className="relative bg-[#0B1121] border border-slate-800 rounded-2xl w-full max-w-lg shadow-2xl shadow-black/50 overflow-hidden animate-in fade-in zoom-in duration-200 flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="bg-slate-900/50 p-6 border-b border-slate-800 flex justify-between items-center">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-orange-500/10 rounded-lg">
                        <Youtube className="w-5 h-5 text-orange-400" />
                    </div>
                    <h2 className="text-xl font-bold text-white">New Channel Niche</h2>
                </div>
                <button onClick={() => setIsModalOpen(false)} className="text-slate-500 hover:text-white transition-colors">
                    <X className="w-6 h-6" />
                </button>
            </div>

            <form onSubmit={handleCreate} className="p-6 space-y-6 overflow-y-auto">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-slate-300 ml-1">
                  Channel Theme / Niche Name
                </label>
                <div className="relative group">
                    <input 
                      type="text" 
                      value={channelTheme}
                      onChange={e => setChannelTheme(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none transition-all placeholder-slate-600 group-hover:border-slate-700"
                      placeholder="e.g., True Crime, Cosmic Horror, Sleep Sounds"
                      autoFocus
                    />
                </div>
              </div>
              
              <div className="space-y-2">
                <label className="text-sm font-semibold text-slate-300 ml-1">
                  Description (Optional)
                </label>
                <textarea 
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none transition-all h-24 resize-none placeholder-slate-600"
                  placeholder="What kind of content will this channel produce?"
                />
              </div>

              <div className="bg-slate-900/50 p-4 rounded-lg border border-slate-800 text-xs text-slate-400">
                  <p><strong>Note:</strong> You will create specific videos inside this project after it is initialized.</p>
              </div>

              <div className="flex gap-3 pt-2">
                <button 
                  type="button" 
                  onClick={() => setIsModalOpen(false)}
                  className="flex-1 px-4 py-3 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors font-medium"
                >
                  Cancel
                </button>
                <button 
                  type="submit"
                  disabled={!channelTheme}
                  className="flex-1 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-3 rounded-xl font-bold shadow-lg shadow-orange-600/20 transition-all active:scale-95"
                >
                  Create Niche
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

// Helper Component for Stats
const StatCard = ({ icon: Icon, value, label, trend, color }: any) => {
    const colorClasses: any = {
        orange: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
        amber: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
        red: 'bg-red-500/10 text-red-400 border-red-500/20',
        indigo: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
        purple: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
        emerald: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    };
    
    return (
        <div className="bg-slate-900/50 backdrop-blur border border-slate-800 p-6 rounded-2xl flex items-start justify-between group hover:border-slate-700 transition-colors">
            <div>
                <p className="text-slate-400 font-medium mb-1">{label}</p>
                <h3 className="text-3xl font-bold text-white mb-2">{value}</h3>
                <span className={`text-xs px-2 py-0.5 rounded ${colorClasses[color]} bg-opacity-50`}>
                    {trend}
                </span>
            </div>
            <div className={`p-3 rounded-xl ${colorClasses[color]}`}>
                <Icon className="w-6 h-6" />
            </div>
        </div>
    );
};