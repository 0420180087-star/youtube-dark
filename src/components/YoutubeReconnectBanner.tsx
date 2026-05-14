/**
 * YoutubeReconnectBanner
 *
 * Exibe um aviso persistente no topo da tela quando o Google revogou o
 * refresh_token (invalid_grant). Isso acontece em dois casos raros:
 *   1. O usuário removeu manualmente o acesso em myaccount.google.com
 *   2. O token ficou sem uso por mais de 6 meses (com o cron ativo, impossível)
 *
 * Coloque este componente dentro de <Layout> ou no topo de <App>, APÓS o
 * AuthProvider. Ele só renderiza quando needsYoutubeReconnect === true.
 *
 * Uso:
 *   import { YoutubeReconnectBanner } from '../components/YoutubeReconnectBanner';
 *   // Dentro do layout:
 *   <YoutubeReconnectBanner projectId={currentProjectId} />
 */

import React from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface Props {
  /** ID do projeto atual para passar ao connectYoutube */
  projectId?: string;
}

export const YoutubeReconnectBanner: React.FC<Props> = ({ projectId }) => {
  const { needsYoutubeReconnect, connectYoutube, clearReconnectFlag } = useAuth();

  if (!needsYoutubeReconnect) return null;

  return (
    <div className="w-full bg-amber-500/10 border-b border-amber-500/30 px-4 py-3 flex items-center gap-3">
      <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
      <p className="text-sm text-amber-200 flex-1">
        A autorização do YouTube expirou. Reconecte para continuar postando automaticamente.
      </p>
      <button
        onClick={() => connectYoutube(projectId)}
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
