/**
 * userDataService — ponte do navegador para a Edge Function `user-data`.
 *
 * As tabelas `user_settings` e `project_auth` não são mais acessíveis com a
 * chave anon (contêm chaves de API e refresh tokens do YouTube). Todo acesso
 * do frontend passa por aqui, autenticado com o access_token do Google.
 */
import { loadEncryptedString } from './securityService';
import { ACCESS_TOKEN_STORAGE_KEY } from './youtubeAuthService';

export interface ProjectAuthStatus {
  project_id: string;
  has_refresh_token: boolean;
  token_status: string | null;
  token_error: string | null;
  youtube_channel_title: string | null;
}

const FUNCTIONS_URL = (() => {
  const url = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
  return url ? `${url}/functions/v1/user-data` : '';
})();

const getGoogleToken = async (): Promise<string | null> => {
  try {
    return await loadEncryptedString(ACCESS_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
};

async function callUserData<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!FUNCTIONS_URL) throw new Error('VITE_SUPABASE_URL não configurado');
  const token = await getGoogleToken();
  if (!token) throw new Error('Sessão do Google ausente — faça login novamente');

  const res = await fetch(FUNCTIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY || '',
    },
    body: JSON.stringify({ action, ...payload }),
    signal: AbortSignal.timeout(20_000),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `user-data falhou (HTTP ${res.status})`);
  return body as T;
}

export const getUserSettings = () =>
  callUserData<{ gemini_api_keys: string[]; pexels_api_key: string | null }>('get_settings');

export const saveUserSettings = (geminiApiKeys: string[], pexelsApiKey: string | null) =>
  callUserData<{ ok: true }>('save_settings', {
    gemini_api_keys: geminiApiKeys,
    pexels_api_key: pexelsApiKey,
  });

export const getProjectAuthStatuses = async (): Promise<ProjectAuthStatus[]> => {
  const { rows } = await callUserData<{ rows: ProjectAuthStatus[] }>('get_project_auth');
  return rows || [];
};

export const deleteProjectAuth = (projectId: string) =>
  callUserData<{ ok: true }>('delete_project_auth', { project_id: projectId });
