/**
 * YoutubeReconnectBanner — aviso quando o Google revogou o refresh_token
 * (invalid_grant). A reconexão SEMPRE precisa ser feita para um projeto
 * específico: a automação procura o refresh_token pelo id do projeto. Antes o
 * botão reconectava em um projeto "default", que a automação nunca lê — o
 * aviso sumia mas o projeto continuava sem token.
 */

import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface Props {
  projectId?: string;
}

export const YoutubeReconnectBanner: React.FC<Props> = ({ projectId }) => {
  const { needsYoutubeReconnect, connectYoutube, clearReconnectFlag } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  if (!needsYoutubeReconnect) return null;

  const currentProjectId = projectId || location.pathname.match(/\/project\/([^/]+)/)?.[1];

  const handleReconnect = () => {
    if (!currentProjectId) {
      navigate('/projects');
      alert('Abra o projeto do canal e clique em "Conectar canal" para reconectar o YouTube daquele projeto.');
      return;
    }
    sessionStorage.setItem('yt_oauth_target_project', currentProjectId);
    connectYoutube(currentProjectId);
  };

  return (
    <div className="w-full bg-amber-500/10 border-b border-amber-500/30 px-4 py-3 flex items-center gap-3">
      <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
      <p className="text-sm text-amber-200 flex-1">
        A autorização do YouTube expirou. Reconecte para continuar postando automaticamente.
      </p>
      <button
        onClick={handleReconnect}
        className="flex items-center gap-1.5 text-sm font-medium text-amber-300 hover:text-amber-100 transition-colors"
      >
        <RefreshCw className="w-4 h-4" />
        Reconectar
      </button>
      <button
        onClick={clearReconnectFlag}
        className="text-amber-500 hover:text-amber-300 transition-colors ml-1"
        aria-label="Fechar aviso"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};
