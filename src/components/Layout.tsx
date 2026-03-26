import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Film, Calendar, Settings, Youtube, Zap, Menu, X, Bot } from 'lucide-react';
import { useProjects } from '../context/ProjectContext';

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const { autoPilotStatus } = useProjects(); // Get auto pilot status

  const navItems = [
    { label: 'Dashboard', path: '/', icon: LayoutDashboard },
    { label: 'Projects', path: '/projects', icon: Film },
    { label: 'Scheduler', path: '/scheduler', icon: Calendar },
  ];

  const toggleMenu = () => setIsMobileMenuOpen(!isMobileMenuOpen);
  const isAutoPilotActive = autoPilotStatus !== 'Idle';

  return (
    <div className="flex h-screen bg-[#020617] text-slate-200 overflow-hidden font-sans selection:bg-orange-500/30 selection:text-orange-200">
      {/* Optimized Background: Using Radial Gradients instead of heavy Blur filters for Mobile Performance */}
      <div 
        className="fixed inset-0 pointer-events-none z-0" 
        style={{
            background: `
                radial-gradient(circle at 0% 0%, rgba(124, 45, 18, 0.08) 0%, transparent 40%),
                radial-gradient(circle at 100% 100%, rgba(120, 53, 15, 0.08) 0%, transparent 40%)
            `
        }}
      ></div>

      {/* MOBILE HEADER */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center w-8 h-8 bg-gradient-to-br from-orange-600 to-amber-600 rounded-lg shadow-lg shadow-orange-500/20">
            <Youtube className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold tracking-tight text-white">DarkStream</span>
        </div>
        <button onClick={toggleMenu} className="p-2 text-slate-300 hover:text-white bg-slate-800/50 rounded-lg active:scale-95 transition-transform">
          {isMobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </div>

      {isMobileMenuOpen && (
        <div className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden" onClick={() => setIsMobileMenuOpen(false)}></div>
      )}

      {/* SIDEBAR */}
      <aside className={`
        fixed inset-y-0 left-0 z-40 w-72 bg-slate-900/95 md:bg-slate-900/40 backdrop-blur-xl border-r border-slate-800/60 
        transform transition-transform duration-300 ease-in-out md:translate-x-0 md:static md:flex flex-col flex-shrink-0
        ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        <div className="p-8 flex items-center gap-3 hidden md:flex">
          <div className="relative flex items-center justify-center w-10 h-10 bg-gradient-to-br from-orange-600 to-amber-600 rounded-xl shadow-lg shadow-orange-500/20">
            <Youtube className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white leading-none">DarkStream</h1>
            <span className="text-[10px] uppercase tracking-widest text-orange-400 font-semibold">AI Automation</span>
          </div>
        </div>

        <div className="h-20 md:hidden"></div>

        <div className="px-4 mb-6">
            <div className={`border rounded-lg p-3 flex items-center justify-between transition-colors ${isAutoPilotActive ? 'bg-orange-500/10 border-orange-500/30' : 'bg-slate-800/50 border-slate-700/50'}`}>
                <div className="flex items-center gap-2 overflow-hidden">
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isAutoPilotActive ? 'bg-orange-500 animate-pulse' : 'bg-green-500'}`}></div>
                    <span className="text-xs font-mono text-slate-400 truncate">{autoPilotStatus}</span>
                </div>
                {isAutoPilotActive ? <Bot className="w-3 h-3 text-orange-500 animate-bounce" /> : <Zap className="w-3 h-3 text-green-500" />}
            </div>
        </div>

        <nav className="flex-1 px-4 space-y-1.5">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path || (item.path === '/projects' && location.pathname.includes('/project/'));
            return (
              <Link
                key={item.path}
                to={item.path}
                onClick={() => setIsMobileMenuOpen(false)}
                className={`group flex items-center space-x-3 px-4 py-3.5 rounded-xl transition-all duration-200 relative overflow-hidden ${
                  isActive 
                    ? 'bg-orange-600/10 text-white shadow-inner shadow-orange-500/10 border border-orange-500/20' 
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/50 border border-transparent'
                }`}
              >
                {isActive && <div className="absolute left-0 top-0 bottom-0 w-1 bg-orange-500 rounded-r-full"></div>}
                <item.icon className={`w-5 h-5 transition-colors ${isActive ? 'text-orange-400' : 'text-slate-500 group-hover:text-slate-300'}`} />
                <span className="font-medium tracking-wide">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800/60">
          <Link 
            to="/settings" 
            onClick={() => setIsMobileMenuOpen(false)}
            className={`flex items-center space-x-3 px-4 py-3 w-full rounded-xl group transition-all ${location.pathname === '/settings' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'}`}
          >
            <Settings className={`w-5 h-5 transition-transform duration-500 ${location.pathname === '/settings' ? 'rotate-90 text-orange-400' : 'group-hover:rotate-90'}`} />
            <span className="font-medium">Settings</span>
          </Link>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto relative scroll-smooth pt-16 md:pt-0">
        <div className="max-w-7xl mx-auto p-4 md:p-8 lg:p-10 pb-24 md:pb-8">
            {children}
        </div>
      </main>
    </div>
  );
};