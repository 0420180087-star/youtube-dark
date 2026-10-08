/**
 * keyDropService — envia as chaves Gemini/Pexels para a automação do GitHub
 * SEM depender da função de nuvem `user-data`.
 *
 * Como funciona:
 *  1. A automação (GitHub Actions) gera um par de chaves de criptografia e
 *     publica só a parte pública em `automation_heartbeat`.
 *  2. O navegador cifra { chaves, e-mail, token do login } com essa chave
 *     pública e grava o pacote cifrado em `autopilot_logs` (tabela que o app
 *     já consegue gravar — é por ela que os logs funcionam hoje).
 *  3. Na próxima execução, a automação decifra, confere o e-mail com o Google
 *     e grava as chaves em `user_settings` (só ela tem acesso a essa tabela).
 *
 * Ninguém além da automação consegue ler as chaves: o pacote só abre com a
 * chave privada, que fica numa tabela inacessível ao navegador.
 */
import { supabase } from '../lib/supabaseClient';
import { loadEncryptedString } from './securityService';
import { LOGIN_TOKEN_STORAGE_KEY } from './youtubeAuthService';

export const KEY_DROP_PROJECT_ID = '__keys__';
const PUBLIC_KEY_ROW = 'runner_public_key';

const toB64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s);
};

export interface KeyDropResult {
  ok: boolean;
  message: string;
}

export async function sendKeysToAutomation(
  email: string,
  geminiApiKeys: string[],
  pexelsApiKey: string | null,
): Promise<KeyDropResult> {
  if (!supabase) return { ok: false, message: 'Sem conexão com a nuvem.' };
  const appEmail = email.trim().toLowerCase();

  const { data: pk, error: pkErr } = await supabase
    .from('automation_heartbeat')
    .select('detail')
    .eq('runner', PUBLIC_KEY_ROW)
    .maybeSingle();
  if (pkErr) return { ok: false, message: `Não foi possível ler a chave pública da automação: ${pkErr.message}` };
  if (!pk?.detail) {
    return {
      ok: false,
      message: 'A automação do GitHub ainda não rodou com a versão nova. Rode "Auto Post Video" uma vez no GitHub e salve de novo.',
    };
  }

  let token: string | null = null;
  try { token = await loadEncryptedString(LOGIN_TOKEN_STORAGE_KEY); } catch { /* sem token */ }

  const subtle = crypto.subtle;
  const publicKey = await subtle.importKey('jwk', JSON.parse(pk.detail), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const aesKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = JSON.stringify({
    email: appEmail,
    gemini_api_keys: geminiApiKeys.filter(Boolean),
    pexels_api_key: pexelsApiKey,
    token,
    at: new Date().toISOString(),
  });
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(payload));
  const wk = await subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, await subtle.exportKey('raw', aesKey));

  const { error } = await supabase.from('autopilot_logs').insert({
    project_id: KEY_DROP_PROJECT_ID,
    user_email: appEmail,
    status: 'keys',
    step: 'settings',
    runner: 'browser-keys',
    message: JSON.stringify({ v: 1, wk: toB64(wk), iv: toB64(iv), ct: toB64(ct) }),
  });
  if (error) return { ok: false, message: `Falha ao enviar as chaves: ${error.message}` };

  return {
    ok: true,
    message: `Chaves enviadas com segurança para a automação (${appEmail}). Ela aplica na próxima execução — até ~15 min.`,
  };
}

/** Último resultado registrado pela automação para este e-mail. */
export async function getKeyDropStatus(email: string): Promise<{ detail: string; at: string } | null> {
  if (!supabase) return null;
  const { data } = await supabase
    .from('automation_heartbeat')
    .select('detail,last_seen_at')
    .eq('runner', `keys:${email.trim().toLowerCase()}`)
    .maybeSingle();
  return data?.detail ? { detail: data.detail, at: data.last_seen_at } : null;
}
