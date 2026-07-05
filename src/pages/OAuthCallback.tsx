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
  const { setYoutubeToken, setYoutubeChannelData } = useAuth();
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

      let pending: { state: string; projectId: string; userEmail: string; redirectUri: string; clientId?: string };
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
        const edgeFunctionUrl = `${supabaseUrl}/functions/v1/exchange-code`;
        setMessage(`Conectando ao servidor...\n→ ${edgeFunctionUrl}`);

        let res: Response;
        try {
          res = await fetch(edgeFunctionUrl, {
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
              client_id: pending.clientId,
            }),
          });
        } catch (networkErr: any) {
          // "Failed to fetch" = CORS bloqueou o preflight OU função não existe/não deployada
          const diagnosis = [
            `Falha de rede ao chamar a Edge Function.`,
            ``,
            `URL chamada: ${edgeFunctionUrl}`,
            ``,
            `Causas mais prováveis:`,
            `1. A Edge Function não foi deployada no Supabase`,
            `   → Rode: supabase functions deploy exchange-code`,
            ``,
            `2. CORS bloqueado (ALLOWED_ORIGIN errado)`,
            `   → Verifique o secret ALLOWED_ORIGIN no Supabase`,
            `   → Deve ser: https://0420180087-star.github.io`,
            ``,
            `3. VITE_SUPABASE_URL inválido`,
            `   → URL atual: ${supabaseUrl}`,
            ``,
            `Erro original: ${networkErr?.message ?? String(networkErr)}`,
          ].join('\n');

          console.error('[OAuthCallback] Network/CORS error:\n' + diagnosis);
          setStatus('error');
          setMessage(diagnosis);
          setTimeout(() => navigate('/'), 15000);
          return;
        }

        // Função respondeu — captura corpo mesmo em erro HTTP
        let data: any = {};
        try {
          data = await res.json();
        } catch {
          data = { error: `Resposta inválida (HTTP ${res.status} ${res.statusText}) — a função pode ter crashado` };
        }

        if (!res.ok) {
          const diagnosis = [
            `Edge Function retornou erro HTTP ${res.status}`,
            ``,
            `Mensagem: ${data.error || data.message || JSON.stringify(data)}`,
            ``,
            res.status === 404
              ? `→ Função "exchange-code" não encontrada no Supabase. Deploy necessário.`
              : res.status === 401 || res.status === 403
              ? `→ SUPABASE_ANON_KEY inválida ou função requer autenticação.`
              : res.status === 500
              ? `→ Erro interno da função. Verifique os logs no Supabase Dashboard.`
              : `→ Verifique os logs da Edge Function no Supabase Dashboard.`,
          ].join('\n');

          console.error('[OAuthCallback] Edge Function HTTP error:\n' + diagnosis);
          throw new Error(diagnosis);
        }

        // Save access_token into AuthContext + localStorage
        await setYoutubeToken(data.access_token);
        setMessage('Token salvo. Buscando dados do canal...');

        let channelData = data.channel;
        if (!channelData?.id) {
          const chRes = await fetch(
            'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
            { headers: { Authorization: `Bearer ${data.access_token}` } }
          );

          if (!chRes.ok) throw new Error('Falha ao buscar dados do canal YouTube.');

          const chData = await chRes.json();
          const ch = chData.items?.[0];
          if (!ch) throw new Error('Nenhum canal YouTube encontrado nesta conta.');

          channelData = {
            id: ch.id,
            title: ch.snippet.title,
            thumbnailUrl: ch.snippet.thumbnails?.default?.url || '',
            subscriberCount: ch.statistics?.subscriberCount,
          };
        }

        await setYoutubeChannelData(channelData);

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
        setMessage(`Canal "${channelData.title}" conectado com sucesso!`);

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
          {status === 'error' ? (
            <pre className="text-left text-xs text-slate-300 bg-slate-900 border border-slate-700 rounded-lg p-4 mt-2 whitespace-pre-wrap break-words max-h-80 overflow-y-auto">
              {message}
            </pre>
          ) : (
            <p className="text-slate-400 text-sm">{message}</p>
          )}
          {status !== 'loading' && (
            <p className="text-slate-600 text-xs mt-3">Redirecionando em instantes...</p>
          )}
        </div>
      </div>
    </div>
  );
};
