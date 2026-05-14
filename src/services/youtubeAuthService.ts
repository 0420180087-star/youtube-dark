/**
 * youtubeAuthService — wrapper around the Supabase Edge Function `refresh-token`.
 * Centralises the fetch + headers + error handling used by AuthContext.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const ACCESS_TOKEN_STORAGE_KEY = 'ds_youtube_access_token';
export const NEEDS_RECONNECT_KEY = 'ds_yt_needs_reconnect';

export interface RefreshResult {
  accessToken: string | null;
  /** true quando o Google retornou invalid_grant — refresh_token foi revogado */
  needsReconnect: boolean;
}

/**
 * Chama a edge function refresh-token.
 * Retorna { accessToken, needsReconnect }.
 * Nunca lança exceção — erros de rede viram accessToken: null.
 */
export const callRefreshToken = async (
    projectId: string,
    userEmail: string | null | undefined,
): Promise<string | null> => {
    const result = await callRefreshTokenFull(projectId, userEmail);
    return result.accessToken;
};

export const callRefreshTokenFull = async (
    projectId: string,
    userEmail: string | null | undefined,
): Promise<RefreshResult> => {
    if (!SUPABASE_URL || !SUPABASE_ANON || !userEmail) {
        return { accessToken: null, needsReconnect: false };
    }
    try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/refresh-token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON}`,
            },
            body: JSON.stringify({ project_id: projectId, user_email: userEmail }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
            const needsReconnect = data?.needsReconnect === true;
            if (needsReconnect) {
                // Marca no localStorage para a UI mostrar o aviso
                localStorage.setItem(NEEDS_RECONNECT_KEY, '1');
            }
            return { accessToken: null, needsReconnect };
        }

        // Sucesso — limpa flag caso estivesse marcado
        localStorage.removeItem(NEEDS_RECONNECT_KEY);
        return { accessToken: data?.access_token ?? null, needsReconnect: false };
    } catch {
        return { accessToken: null, needsReconnect: false };
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
