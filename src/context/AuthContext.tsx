import React, { createContext, useContext, useState, useEffect } from 'react';
import { UserProfile, YouTubeChannel } from '../types';
import {
  loadEncryptedJSON,
  loadEncryptedString,
  saveEncryptedJSON,
  saveEncryptedString,
} from '../services/securityService';
import {
  callRefreshToken,
  isAccessTokenValid,
  ACCESS_TOKEN_STORAGE_KEY,
} from '../services/youtubeAuthService';
import { supabase, setSupabaseUserEmail } from '../lib/supabaseClient';

declare const google: any;

interface AuthContextType {
  user: UserProfile | null;
  isLoading: boolean;
  googleClientId: string;
  youtubeChannel: YouTubeChannel | null;
  accessToken: string | null;
  
  setGoogleClientId: (id: string) => void;
  login: () => Promise<void>;
  logout: () => void;
  connectYoutube: (projectId?: string) => Promise<void>;
  disconnectYoutube: () => void;
  refreshYouTubeToken: (projectId: string) => Promise<string | null>;
  // Allows external components (e.g. ProjectHub) to save a token obtained
  // via initTokenClient into AuthContext memory + localStorage.
  setYoutubeToken: (token: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [youtubeChannel, setYoutubeChannel] = useState<YouTubeChannel | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [googleClientId, setGoogleClientIdState] = useState('');

  // Persist a fresh access_token to state + localStorage in one place.
  const persistAccessToken = async (token: string) => {
    setAccessToken(token);
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

        // Auto-refresh via Supabase Edge Function FIRST (before restoring cached token).
        //   1. Try to get a fresh token. If it works, use it and discard cache.
        //   2. Otherwise, restore the cached token only if Google says it's still valid.
        let freshTokenSet = false;
        if (profile?.email) {
          const fresh = await callRefreshToken('default', profile.email);
          if (fresh) {
            await persistAccessToken(fresh);
            freshTokenSet = true;
            console.log('[Auth] ✅ Token renovado automaticamente na inicialização');
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

  // NOTE: OAuth ?code= handling was intentionally removed from AuthContext.
  // The dedicated OAuthCallback page (/oauth/callback) is the sole handler.
  // Having two handlers caused a race condition: both would consume the
  // sessionStorage state and attempt to exchange the same code, with the
  // second call always failing (code already used) and potentially clearing
  // auth state mid-session.

  const setGoogleClientId = async (id: string) => {
    const cleanId = id.trim();
    await saveEncryptedString('ds_google_client_id', cleanId);
    setGoogleClientIdState(cleanId);
  };

  const login = async () => {
    setIsLoading(true);

    const activeClientId = googleClientId ? googleClientId.trim() : '';
    
    if (!activeClientId) {
        alert("Configuration Missing: Please go to Settings and enter your Google Client ID.");
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
            alert("Google Scripts not loaded. Verifique sua conexão e recarregue a página.");
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
                console.error("GIS Error:", err);
                setIsLoading(false);
            }
        });
        
        client.requestAccessToken();
    } catch (e: any) {
        console.error("Auth Crash", e);
        setIsLoading(false);
    }
  };

  const fetchUserProfile = async (token: string) => {
      try {
          const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
              headers: { Authorization: `Bearer ${token}` }
          });
          if (!res.ok) throw new Error("Failed to fetch profile");
          const data = await res.json();
          const profile: UserProfile = {
              name: data.name,
              email: data.email,
              picture: data.picture
          };
          setUser(profile);

          // Save locally (encrypted)
          await saveEncryptedJSON('ds_user_profile', profile);

          // Establish RLS session scope: all subsequent Supabase calls from
          // this client will be filtered to this user's rows.
          await setSupabaseUserEmail(profile.email);

          // Save to Supabase for cross-device persistence
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

    // Always use Authorization Code Flow with a STATIC redirect_uri.
    // Register this URI in Google Console → Credentials → OAuth → Authorized redirect URIs:
    //   Production:  https://your-domain.com/oauth/callback
    //   Local dev:   http://localhost:5173/oauth/callback
    //
    // This URI never changes — no project ID, no dynamic path.
    // Benefits over initTokenClient (implicit flow):
    //   - Returns a refresh_token saved server-side via the exchange-code edge function
    //   - Auto-refreshes silently on every page load — indefinite session
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

  // userEmail is passed explicitly — sessionStorage is already cleared by this point
  const fetchChannelData = async (token: string, userEmail?: string) => {
      try {
          const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', {
              headers: { Authorization: `Bearer ${token}` }
          });
          
          if (!res.ok) throw new Error("YouTube API Error");
          const data = await res.json();
          
          if (data.items?.length > 0) {
              const ch = data.items[0];
              const channel: YouTubeChannel = {
                  id: ch.id,
                  title: ch.snippet.title,
                  thumbnailUrl: ch.snippet.thumbnails.default.url,
                  subscriberCount: ch.statistics.subscriberCount
              };
              setYoutubeChannel(channel);

              // Save locally (encrypted)
              await saveEncryptedJSON('ds_youtube_channel', channel);

              // Update channel info in project_auth table if Supabase available
              // Use the explicitly passed email — sessionStorage is already cleared
              const emailToUse = userEmail || user?.email;
              if (supabase && emailToUse) {
                  try {
                      await supabase.from('project_auth').update({
                          youtube_channel_id: ch.id,
                          youtube_channel_title: ch.snippet.title,
                          updated_at: new Date().toISOString(),
                      }).eq('user_email', emailToUse);
                  } catch (e) {
                      console.warn('[Supabase] Falha ao salvar canal:', e);
                  }
              }
          } else {
              alert("No YouTube channel found associated with this Google Account.");
          }
      } catch (e) {
          console.error(e);
          alert("Failed to fetch channel info. Check your connection.");
      }
  };

  const refreshYouTubeToken = async (projectId: string): Promise<string | null> => {
    const fresh = await callRefreshToken(projectId, user?.email);
    if (fresh) {
      await persistAccessToken(fresh);
      return fresh;
    }
    return accessToken;
  };

  const disconnectYoutube = () => {
      setYoutubeChannel(null);
      setAccessToken(null);
      localStorage.removeItem('ds_youtube_channel');
      localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
      
      if (accessToken && typeof google !== 'undefined') {
        try { google.accounts.oauth2.revoke(accessToken, () => {}); } catch (e) {}
      }
  };

  const logout = () => {
    disconnectYoutube();
    setUser(null);
    localStorage.removeItem('ds_user_profile');
  };

  // Saves a token obtained outside of AuthContext (e.g. via initTokenClient in ProjectHub)
  // into AuthContext state and localStorage so the rest of the app can use it.
  const setYoutubeToken = async (token: string) => {
    await persistAccessToken(token);
  };

  return (
    <AuthContext.Provider value={{ 
      user, isLoading, googleClientId, youtubeChannel, accessToken,
      setGoogleClientId, login, logout, connectYoutube, disconnectYoutube,
      refreshYouTubeToken, setYoutubeToken
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
};
