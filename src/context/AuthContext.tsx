import React, { createContext, useContext, useState, useEffect } from 'react';
import { UserProfile, YouTubeChannel } from '../types';
import {
  loadEncryptedJSON,
  loadEncryptedString,
  saveEncryptedJSON,
  saveEncryptedString,
} from '../services/securityService';
import {
  callRefreshTokenFull,
  isAccessTokenValid,
  ACCESS_TOKEN_STORAGE_KEY,
  NEEDS_RECONNECT_KEY,
} from '../services/youtubeAuthService';
import { supabase, setSupabaseUserEmail } from '../lib/supabaseClient';

declare const google: any;

interface AuthContextType {
  user: UserProfile | null;
  isLoading: boolean;
  googleClientId: string;
  youtubeChannel: YouTubeChannel | null;
  accessToken: string | null;
  /** true quando o Google revogou o refresh_token — app precisa reconectar */
  needsYoutubeReconnect: boolean;

  setGoogleClientId: (id: string) => void;
  login: () => Promise<void>;
  logout: () => void;
  connectYoutube: (projectId?: string) => Promise<void>;
  disconnectYoutube: () => void;
  refreshYouTubeToken: (projectId: string) => Promise<string | null>;
  setYoutubeToken: (token: string) => Promise<void>;
  clearReconnectFlag: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [youtubeChannel, setYoutubeChannel] = useState<YouTubeChannel | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [googleClientId, setGoogleClientIdState] = useState('');
  const [needsYoutubeReconnect, setNeedsYoutubeReconnect] = useState(
    () => localStorage.getItem(NEEDS_RECONNECT_KEY) === '1'
  );

  const persistAccessToken = async (token: string) => {
    setAccessToken(token);
    setNeedsYoutubeReconnect(false);
    localStorage.removeItem(NEEDS_RECONNECT_KEY);
    try {
      await saveEncryptedString(ACCESS_TOKEN_STORAGE_KEY, token);
    } catch (e) {
      console.warn('[Auth] Não foi possível salvar token localmente:', e);
    }
  };

  useEffect(() => {
    const initAuth = async () => {
      try {
        const clientId = await loadEncryptedString('ds_google_client_id');
        if (clientId) setGoogleClientIdState(clientId);

        const profile = await loadEncryptedJSON<UserProfile>('ds_user_profile');
        if (profile?.email) {
          setUser(profile);
          await setSupabaseUserEmail(profile.email);
        }

        const channel = await loadEncryptedJSON<YouTubeChannel>('ds_youtube_channel');
        if (channel?.id) setYoutubeChannel(channel);

        // ── Auto-refresh na inicialização ────────────────────────────────────
        //
        // Passa project_id vazio ('') para que a edge function use a camada B
        // (busca o refresh_token mais recente do usuário), independente de qual
        // projeto foi autenticado. Isso resolve o problema de reconexão diária.
        //
        // Fluxo:
        //   1. Tenta renovar via Supabase Edge Function (usa refresh_token salvo)
        //   2. Se a edge function retornar needsReconnect=true (invalid_grant),
        //      marca a flag para a UI exibir o aviso uma única vez
        //   3. Se falhar por rede, restaura o token cacheado se ainda for válido
        //
        let freshTokenSet = false;
        if (profile?.email) {
          const result = await callRefreshTokenFull('', profile.email);

          if (result.accessToken) {
            await persistAccessToken(result.accessToken);
            freshTokenSet = true;
            console.log('[Auth] ✅ Token renovado automaticamente na inicialização');
          } else if (result.needsReconnect) {
            // refresh_token foi revogado pelo Google (invalid_grant)
            // Acontece se: usuário removeu permissão no Google Account settings,
            // ou o token ficou sem uso por 6 meses (muito raro com o cron ativo)
            setNeedsYoutubeReconnect(true);
            localStorage.setItem(NEEDS_RECONNECT_KEY, '1');
            console.warn('[Auth] ⚠️ refresh_token revogado — usuário precisa reconectar o YouTube');
          }
        }

        if (!freshTokenSet) {
          const cached = await loadEncryptedString(ACCESS_TOKEN_STORAGE_KEY);
          if (cached && (await isAccessTokenValid(cached))) {
            setAccessToken(cached);
            console.log('[Auth] Cached token válido — restaurado.');
          } else if (cached) {
            localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
            console.log('[Auth] Cached token expirado — descartado.');
          }
        }
      } catch (e) {
        console.error('Auth init failed:', e);
      }
    };

    initAuth();
  }, []);

  const setGoogleClientId = async (id: string) => {
    const cleanId = id.trim();
    await saveEncryptedString('ds_google_client_id', cleanId);
    setGoogleClientIdState(cleanId);
  };

  const login = async () => {
    setIsLoading(true);

    const activeClientId = googleClientId ? googleClientId.trim() : '';

    if (!activeClientId) {
      alert('Configuration Missing: Please go to Settings and enter your Google Client ID.');
      setIsLoading(false);
      return;
    }

    if (typeof google === 'undefined') {
      let loaded = false;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (typeof google !== 'undefined') { loaded = true; break; }
      }
      if (!loaded) {
        alert('Google Scripts not loaded. Verifique sua conexão e recarregue a página.');
        setIsLoading(false);
        return;
      }
    }

    try {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: activeClientId,
        scope: 'https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
        callback: async (tokenResponse: any) => {
          if (tokenResponse && tokenResponse.access_token) {
            await fetchUserProfile(tokenResponse.access_token);
          }
          setIsLoading(false);
        },
        error_callback: (err: any) => {
          console.error('GIS Error:', err);
          setIsLoading(false);
        },
      });

      client.requestAccessToken();
    } catch (e: any) {
      console.error('Auth Crash', e);
      setIsLoading(false);
    }
  };

  const fetchUserProfile = async (token: string) => {
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to fetch profile');
      const data = await res.json();
      const profile: UserProfile = {
        name: data.name,
        email: data.email,
        picture: data.picture,
      };
      setUser(profile);

      await saveEncryptedJSON('ds_user_profile', profile);
      await setSupabaseUserEmail(profile.email);

      if (supabase && profile.email) {
        try {
          await supabase.from('user_profiles').upsert({
            email: profile.email,
            name: profile.name,
            picture: profile.picture,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'email' });
        } catch (e) {
          console.warn('[Supabase] Falha ao salvar perfil:', e);
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  const connectYoutube = async (projectId?: string) => {
    if (!user) { await login(); return; }

    const activeClientId = googleClientId?.trim();
    if (!activeClientId) {
      alert('Por favor, configure o Google Client ID nas Configurações primeiro.');
      return;
    }

    const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
    const redirectUri = window.location.origin + base + '/oauth/callback';

    const state = crypto.randomUUID();
    sessionStorage.setItem('yt_oauth_pending', JSON.stringify({
      state,
      projectId: projectId || 'default',
      userEmail: user.email,
      redirectUri,
    }));

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', activeClientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
    ].join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);

    window.location.href = authUrl.toString();
  };

  const refreshYouTubeToken = async (projectId: string): Promise<string | null> => {
    const result = await callRefreshTokenFull(projectId, user?.email);
    if (result.accessToken) {
      await persistAccessToken(result.accessToken);
      return result.accessToken;
    }
    if (result.needsReconnect) {
      setNeedsYoutubeReconnect(true);
      localStorage.setItem(NEEDS_RECONNECT_KEY, '1');
    }
    return accessToken;
  };

  const disconnectYoutube = () => {
    setYoutubeChannel(null);
    setAccessToken(null);
    setNeedsYoutubeReconnect(false);
    localStorage.removeItem('ds_youtube_channel');
    localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
    localStorage.removeItem(NEEDS_RECONNECT_KEY);

    if (accessToken && typeof google !== 'undefined') {
      try { google.accounts.oauth2.revoke(accessToken, () => {}); } catch (e) {}
    }
  };

  const logout = () => {
    disconnectYoutube();
    setUser(null);
    localStorage.removeItem('ds_user_profile');
  };

  const setYoutubeToken = async (token: string) => {
    await persistAccessToken(token);
  };

  const clearReconnectFlag = () => {
    setNeedsYoutubeReconnect(false);
    localStorage.removeItem(NEEDS_RECONNECT_KEY);
  };

  return (
    <AuthContext.Provider value={{
      user, isLoading, googleClientId, youtubeChannel, accessToken,
      needsYoutubeReconnect,
      setGoogleClientId, login, logout, connectYoutube, disconnectYoutube,
      refreshYouTubeToken, setYoutubeToken, clearReconnectFlag,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};
