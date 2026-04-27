import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useProjects } from '../context/ProjectContext';
import { Loader2, CheckCircle, XCircle } from 'lucide-react';

/**
 * OAuthCallback — handles the YouTube Authorization Code Flow redirect.
 *
 * URL: /oauth/callback
 *
 * This is the STATIC redirect_uri registered in Google Console.
 * It never changes regardless of which project triggered the auth.
 *
 * Flow:
 *   1. Google redirects here with ?code=...&state=...
 *   2. We validate the state from sessionStorage (CSRF check)
 *   3. Exchange the code for tokens via the exchange-code Edge Function
 *   4. The edge function saves refresh_token to Supabase project_auth table
 *   5. We set the access_token in AuthContext (memory + localStorage)
 *   6. Fetch channel data and save to the target project
 *   7. Redirect back to the project hub
 *
 * Google Console setup (one-time):
 *   Add to Authorized redirect URIs:
 *     https://your-domain.com/oauth/callback
 *     http://localhost:5173/oauth/callback   (for local dev)
 */
export const OAuthCallback: React.FC = () => {
  const navigate = useNavigate();
  const { setYoutubeToken } = useAuth();
  const { updateProject } = useProjects();

  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Conectando ao YouTube...');

  useEffect(() => {
    const handle = async () => {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');
      const state = urlParams.get('state');
      const errorParam = urlParams.get('error');

      // Clean URL immediately so the code can't be replayed
      window.history.replaceState({}, '', '/oauth/callback');

      if (errorParam) {
        setStatus('error');
        setMessage(`Acesso negado pelo Google: ${errorParam}`);
        setTimeout(() => navigate('/'), 4000);
        return;
      }

      if (!code) {
        setStatus('error');
        setMessage('Código de autorização não encontrado na URL.');
        setTimeout(() => navigate('/'), 4000);
        return;
      }

      // Validate CSRF state
      const pendingRaw = sessionStorage.getItem('yt_oauth_pending');
      if (!pendingRaw) {
        setStatus('error');
        setMessage('Sessão de autenticação expirada. Tente conectar novamente.');
        setTimeout(() => navigate('/'), 4000);
        return;
      }

      let pending: { state: string; projectId: string; userEmail: string; redirectUri: string };
      try {
        pending = JSON.parse(pendingRaw);
      } catch {
        sessionStorage.removeItem('yt_oauth_pending');
        setStatus('error');
        setMessage('Dados de sessão corrompidos. Tente novamente.');
        setTimeout(() => navigate('/'), 4000);
        return;
      }

      if (pending.state !== state) {
        sessionStorage.removeItem('yt_oauth_pending');
        setStatus('error');
        setMessage('Falha de verificação de segurança (state mismatch). Tente novamente.');
        setTimeout(() => navigate('/'), 4000);
        return;
      }

      sessionStorage.removeItem('yt_oauth_pending');

      // Exchange code for tokens via Edge Function
      setMessage('Trocando código por tokens...');
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY;

      if (!supabaseUrl) {
        setStatus('error');
        setMessage('Supabase não configurado. Configure VITE_SUPABASE_URL nas variáveis de ambiente.');
        setTimeout(() => navigate('/'), 5000);
        return;
      }

      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/exchange-code`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseAnon}`,
          },
          body: JSON.stringify({
            code,
            redirect_uri: pending.redirectUri,
            project_id: pending.projectId,
            user_email: pending.userEmail,
          }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Falha na troca de código');

        // Save access_token into AuthContext + localStorage
        await setYoutubeToken(data.access_token);
        setMessage('Token salvo. Buscando dados do canal...');

        // Fetch channel data
        const chRes = await fetch(
          'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
          { headers: { Authorization: `Bearer ${data.access_token}` } }
        );

        if (!chRes.ok) throw new Error('Falha ao buscar dados do canal YouTube.');

        const chData = await chRes.json();
        const ch = chData.items?.[0];
        if (!ch) throw new Error('Nenhum canal YouTube encontrado nesta conta.');

        const channelData = {
          id: ch.id,
          title: ch.snippet.title,
          thumbnailUrl: ch.snippet.thumbnails?.default?.url || '',
          subscriberCount: ch.statistics?.subscriberCount,
        };

        // Save channel metadata into the target project
        // The projectId was saved to sessionStorage before the redirect
        const targetProjectId =
          sessionStorage.getItem('yt_oauth_target_project') || pending.projectId;
        sessionStorage.removeItem('yt_oauth_target_project');

        if (targetProjectId && targetProjectId !== 'default') {
          updateProject(targetProjectId, {
            isYoutubeConnected: true,
            youtubeChannelData: channelData,
          });
        }

        setStatus('success');
        setMessage(`Canal "${ch.snippet.title}" conectado com sucesso!`);

        // Redirect back to the project (or home if no project)
        const redirectTo = targetProjectId && targetProjectId !== 'default'
          ? `/project/${targetProjectId}`
          : '/';

        setTimeout(() => navigate(redirectTo), 2000);
      } catch (err: any) {
        console.error('[OAuthCallback] Error:', err);
        setStatus('error');
        setMessage(`Erro: ${err.message}`);
        setTimeout(() => navigate('/'), 5000);
      }
    };

    handle();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-[#080D1A] flex items-center justify-center">
      <div className="bg-[#0F1629] border border-white/10 rounded-2xl p-10 max-w-md w-full flex flex-col items-center gap-6 shadow-2xl">
        {status === 'loading' && (
          <Loader2 className="w-12 h-12 text-orange-400 animate-spin" />
        )}
        {status === 'success' && (
          <CheckCircle className="w-12 h-12 text-green-400" />
        )}
        {status === 'error' && (
          <XCircle className="w-12 h-12 text-red-400" />
        )}
        <div className="text-center">
          <h2 className="text-xl font-bold text-white mb-2">
            {status === 'loading' && 'Conectando YouTube'}
            {status === 'success' && 'Conectado!'}
            {status === 'error' && 'Erro na conexão'}
          </h2>
          <p className="text-slate-400 text-sm">{message}</p>
          {status !== 'loading' && (
            <p className="text-slate-600 text-xs mt-3">Redirecionando em instantes...</p>
          )}
        </div>
      </div>
    </div>
  );
};
