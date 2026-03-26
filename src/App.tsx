import React, { Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ProjectProvider } from './context/ProjectContext';
import { AuthProvider } from './context/AuthContext';
import { Layout } from './components/Layout';
import { Loader2 } from 'lucide-react';

const Dashboard = React.lazy(() => import('./pages/Dashboard').then(module => ({ default: module.Dashboard })));
const ProjectEditor = React.lazy(() => import('./pages/ProjectEditor').then(module => ({ default: module.ProjectEditor })));
const ProjectHub = React.lazy(() => import('./pages/ProjectHub').then(module => ({ default: module.ProjectHub })));
const Scheduler = React.lazy(() => import('./pages/Scheduler').then(module => ({ default: module.Scheduler })));
const ProjectsList = React.lazy(() => import('./pages/ProjectsList').then(module => ({ default: module.ProjectsList })));
const Settings = React.lazy(() => import('./pages/Settings').then(module => ({ default: module.Settings })));

const PageLoader = () => (
  <div className="h-full w-full flex items-center justify-center text-slate-500">
    <Loader2 className="w-8 h-8 animate-spin text-orange-500" />
  </div>
);

const App: React.FC = () => {
  return (
    <AuthProvider>
      <ProjectProvider>
        <BrowserRouter>
          <Layout>
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/project/:id" element={<ProjectHub />} />
                <Route path="/project/:projectId/video/:videoId/editor" element={<ProjectEditor />} />
                <Route path="/projects" element={<ProjectsList />} />
                <Route path="/scheduler" element={<Scheduler />} />
                <Route path="/settings" element={<Settings />} />
              </Routes>
            </Suspense>
          </Layout>
        </BrowserRouter>
      </ProjectProvider>
    </AuthProvider>
  );
};

export default App;
