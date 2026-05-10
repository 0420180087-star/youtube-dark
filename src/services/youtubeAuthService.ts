/**
 * youtubeAuthService — small wrapper around the Supabase Edge Function
 * `refresh-token`. Centralises the fetch + headers + error swallowing
 * that was previously duplicated in AuthContext.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const ACCESS_TOKEN_STORAGE_KEY = 'ds_youtube_access_token';

/**
 * Calls the refresh-token edge function. Returns a fresh access_token, or
 * null if anything fails (network, missing env, no refresh_token saved).
 * Never throws — callers can fall back to whatever they had cached.
 */
export const callRefreshToken = async (
    projectId: string,
    userEmail: string | null | undefined,
): Promise<string | null> => {
    if (!SUPABASE_URL || !SUPABASE_ANON || !userEmail) return null;
    try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/refresh-token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON}`,
            },
            body: JSON.stringify({ project_id: projectId, user_email: userEmail }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data?.access_token ?? null;
    } catch {
        return null;
    }
};

/**
 * Lightweight Google tokeninfo check. Returns true if the access token is
 * still valid. Used to decide whether to restore a cached token at boot.
 */
export const isAccessTokenValid = async (token: string): Promise<boolean> => {
    try {
        const res = await fetch(
            `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(token)}`,
        );
        return res.ok;
    } catch {
        return false;
    }
};
