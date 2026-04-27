import React, { createContext, useContext, useState, useEffect } from 'react';
import { UserProfile, YouTubeChannel } from '../types';
import { encryptData, decryptData } from '../services/securityService';
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

  useEffect(() => {
    const initAuth = async () => {
      try {
        const storedClientId = localStorage.getItem('ds_google_client_id');
        if (storedClientId) {
          try {
            const val = await decryptData(storedClientId);
            if (val && val.length > 0) setGoogleClientIdState(val);
          } catch {
            localStorage.removeItem('ds_google_client_id');
          }
        }

        const storedUser = localStorage.getItem('ds_user_profile');
        if (storedUser) {
          try {
            const val = await decryptData(storedUser);
            const parsed = JSON.parse(val);
            if (parsed?.email) {
              setUser(parsed);
              // Re-establish RLS scope for this session
              await setSupabaseUserEmail(parsed.email);
            }
          } catch {
            localStorage.removeItem('ds_user_profile');
          }
        }

        const storedChannel = localStorage.getItem('ds_youtube_channel');
        if (storedChannel) {
          try {
            const val = await decryptData(storedChannel);
            const parsed = JSON.parse(val);
            if (parsed?.id) setYoutubeChannel(parsed);
          } catch {
            localStorage.removeItem('ds_youtube_channel');
          }
        }

        const storedToken = localStorage.getItem('ds_youtube_access_token');

        // Auto-refresh via Supabase Edge Function FIRST (before restoring cached token).
        // Strategy:
        //   1. If Supabase is configured and we have a user email, try to get a fresh token.
        //   2. If that succeeds, use the fresh token — discard whatever is cached.
        //   3. If refresh fails (network, edge fn down, no refresh_token), fall back to
        //      the cached token and validate it with a lightweight Google API call.
        //   4. If validation fails (token expired, 401), clear it — don't set a bad token.
        let freshTokenSet = false;

        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
        const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY;

        if (supabaseUrl && supabaseAnon) {
          try {
            const storedEmail = localStorage.getItem('ds_user_profile');
            let userEmail = '';
            if (storedEmail) {
              try {
                const dec = await decryptData(storedEmail);
                userEmail = JSON.parse(dec)?.email || '';
              } catch { /* ignore */ }
            }

            if (userEmail) {
              const res = await fetch(`${supabaseUrl}/functions/v1/refresh-token`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${supabaseAnon}`,
                },
                body: JSON.stringify({ project_id: 'default', user_email: userEmail }),
              });
              if (res.ok) {
                const data = await res.json();
                if (data.access_token) {
                  setAccessToken(data.access_token);
                  freshTokenSet = true;
                  const encToken = await encryptData(data.access_token);
                  localStorage.setItem('ds_youtube_access_token', encToken);
                  console.log('[Auth] ✅ Token renovado automaticamente na inicialização');
                }
              }
            }
          } catch {
            // Silent fail — fall through to cached token below
          }
        }

        // Fallback: restore cached token only if refresh didn't produce a fresh one.
        // Validate with Google before setting — a 401 means the token is expired.
        if (!freshTokenSet && storedToken) {
          try {
            const val = await decryptData(storedToken);
            if (val) {
              // Lightweight validation: userinfo endpoint returns 401 for expired tokens
              const check = await fetch('https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + val);
              if (check.ok) {
                setAccessToken(val);
                console.log('[Auth] Cached token válido — restaurado.');
              } else {
                // Token expired — remove silently so UI shows "not connected"
                localStorage.removeItem('ds_youtube_access_token');
                console.log('[Auth] Cached token expirado — descartado.');
              }
            }
          } catch {
            localStorage.removeItem('ds_youtube_access_token');
          }
        }
      } catch (e) {
        console.error('Auth init failed:', e);
      }
    };
    
    initAuth();
  }, []);

  // Capture ?code= after Google OAuth redirect and exchange via Edge Function
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const state = urlParams.get('state');

    if (!code) return;

    const pendingRaw = sessionStorage.getItem('yt_oauth_pending');
    if (!pendingRaw) return;

    let pending: { state: string; projectId: string; userEmail: string; redirectUri: string };
    try {
      pending = JSON.parse(pendingRaw);
    } catch {
      sessionStorage.removeItem('yt_oauth_pending');
      return;
    }

    if (pending.state !== state) {
      console.error('[Auth] State mismatch — possível CSRF');
      sessionStorage.removeItem('yt_oauth_pending');
      return;
    }

    sessionStorage.removeItem('yt_oauth_pending');
    window.history.replaceState({}, '', window.location.pathname);

    const exchangeCode = async () => {
      setIsLoading(true);
      try {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
        if (!supabaseUrl) {
          throw new Error('VITE_SUPABASE_URL não configurada. Configure o Supabase nas variáveis de ambiente.');
        }

        const res = await fetch(`${supabaseUrl}/functions/v1/exchange-code`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
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

        setAccessToken(data.access_token);
        const encToken = await encryptData(data.access_token);
        localStorage.setItem('ds_youtube_access_token', encToken);

        await fetchChannelData(data.access_token);

        console.log('[Auth] ✅ YouTube conectado e refresh_token salvo no Supabase');
      } catch (err: any) {
        console.error('[Auth] Erro ao trocar code:', err);
        alert(`Erro ao conectar YouTube: ${err.message}`);
      } finally {
        setIsLoading(false);
      }
    };

    exchangeCode();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setGoogleClientId = async (id: string) => {
    const cleanId = id.trim();
    const encrypted = await encryptData(cleanId);
    localStorage.setItem('ds_google_client_id', encrypted);
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
          const encrypted = await encryptData(JSON.stringify(profile));
          localStorage.setItem('ds_user_profile', encrypted);

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
    const redirectUri = window.location.origin + '/oauth/callback';

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

  const fetchChannelData = async (token: string) => {
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
              const encChannel = await encryptData(JSON.stringify(channel));
              localStorage.setItem('ds_youtube_channel', encChannel);

              // Update channel info in project_auth table if Supabase available
              const pendingRaw = sessionStorage.getItem('yt_oauth_pending');
              const pending = pendingRaw ? JSON.parse(pendingRaw) : null;
              if (supabase && pending?.userEmail) {
                  try {
                      await supabase.from('project_auth').update({
                          youtube_channel_id: ch.id,
                          youtube_channel_title: ch.snippet.title,
                          updated_at: new Date().toISOString(),
                      }).eq('user_email', pending.userEmail);
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
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;

    if (!supabase || !supabaseUrl) {
      return accessToken;
    }

    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/refresh-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ project_id: projectId, user_email: user?.email }),
      });

      if (!res.ok) return accessToken;

      const data = await res.json();
      if (data.access_token) {
        setAccessToken(data.access_token);
        const encToken = await encryptData(data.access_token);
        localStorage.setItem('ds_youtube_access_token', encToken);
        return data.access_token;
      }
    } catch (err) {
      console.warn('[Auth] Falha ao renovar token:', err);
    }

    return accessToken;
  };

  const disconnectYoutube = () => {
      setYoutubeChannel(null);
      setAccessToken(null);
      localStorage.removeItem('ds_youtube_channel');
      localStorage.removeItem('ds_youtube_access_token');
      
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
    setAccessToken(token);
    try {
      const encToken = await encryptData(token);
      localStorage.setItem('ds_youtube_access_token', encToken);
    } catch (e) {
      console.warn('[Auth] Não foi possível salvar token localmente:', e);
    }
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
