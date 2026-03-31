import React, { createContext, useContext, useState, useEffect } from 'react';
import { UserProfile, YouTubeChannel } from '../types';
import { encryptData, decryptData } from '../services/securityService';

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
  connectYoutube: () => Promise<void>;
  disconnectYoutube: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [youtubeChannel, setYoutubeChannel] = useState<YouTubeChannel | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [googleClientId, setGoogleClientIdState] = useState('');

  // 1. ASYNC INITIALIZATION to handle decryption
  useEffect(() => {
    const initAuth = async () => {
        // Load Client ID
        const storedClientId = localStorage.getItem('ds_google_client_id');
        if (storedClientId) {
            const val = await decryptData(storedClientId);
            setGoogleClientIdState(val);
        }

        // Load User Profile
        const storedUser = localStorage.getItem('ds_user_profile');
        if (storedUser) {
            try {
                const val = await decryptData(storedUser);
                setUser(JSON.parse(val));
            } catch(e) {}
        }
        
        // Load Channel
        const storedChannel = localStorage.getItem('ds_youtube_channel');
        if (storedChannel) {
            try {
                const val = await decryptData(storedChannel);
                setYoutubeChannel(JSON.parse(val));
            } catch(e) {}
        }

        // Load Token
        const storedToken = localStorage.getItem('ds_youtube_access_token');
        if (storedToken) {
            const val = await decryptData(storedToken);
            setAccessToken(val);
        }
    };
    
    initAuth();
  }, []);

  const setGoogleClientId = async (id: string) => {
    const cleanId = id.trim();
    const encrypted = await encryptData(cleanId);
    localStorage.setItem('ds_google_client_id', encrypted);
    setGoogleClientIdState(cleanId);
  };

  // --- 1. BASIC USER LOGIN (Identity Only) ---
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
        // Request only Profile and Email initially
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
          const encrypted = await encryptData(JSON.stringify(profile));
          localStorage.setItem('ds_user_profile', encrypted);
      } catch (e) {
          console.error(e);
      }
  };

  // --- 2. YOUTUBE CONNECTION (Permissions) ---
  const connectYoutube = async () => {
      if (!user) { 
          await login();
          return; 
      }
      
      setIsLoading(true);
      const activeClientId = googleClientId ? googleClientId.trim() : '';

      if (!activeClientId) {
          alert("Por favor, configure o Google Client ID nas Configurações primeiro.");
          setIsLoading(false);
          return;
      }

      if (typeof google !== 'undefined') {
        const client = google.accounts.oauth2.initTokenClient({
            client_id: activeClientId,
            // CRITICAL: Requesting upload scope here
            scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
            callback: async (tokenResponse: any) => {
                if (tokenResponse && tokenResponse.access_token) {
                    // Save Token Encrypted
                    setAccessToken(tokenResponse.access_token);
                    const encToken = await encryptData(tokenResponse.access_token);
                    localStorage.setItem('ds_youtube_access_token', encToken);
                    
                    // Fetch Channel Data
                    await fetchChannelData(tokenResponse.access_token);
                }
                setIsLoading(false);
            },
        });
        
        client.requestAccessToken();
      }
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
              const encChannel = await encryptData(JSON.stringify(channel));
              localStorage.setItem('ds_youtube_channel', encChannel);
          } else {
              alert("No YouTube channel found associated with this Google Account.");
          }
      } catch (e) {
          console.error(e);
          alert("Failed to fetch channel info. Check your connection.");
      }
  };

  const disconnectYoutube = () => {
      setYoutubeChannel(null);
      setAccessToken(null);
      localStorage.removeItem('ds_youtube_channel');
      localStorage.removeItem('ds_youtube_access_token');
      
      // Revoke token if possible
      if (accessToken && typeof google !== 'undefined') {
        try { google.accounts.oauth2.revoke(accessToken, () => {}); } catch (e) {}
      }
  };

  const logout = () => {
    disconnectYoutube();
    setUser(null);
    localStorage.removeItem('ds_user_profile');
  };

  return (
    <AuthContext.Provider value={{ 
      user, isLoading, googleClientId, youtubeChannel, accessToken,
      setGoogleClientId, login, logout, connectYoutube, disconnectYoutube 
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