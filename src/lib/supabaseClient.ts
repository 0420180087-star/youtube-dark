import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('[Supabase] Variáveis de ambiente não configuradas. Persistência em nuvem desativada.');
}

export const supabase: SupabaseClient | null = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

/**
 * Sets the session-level user email used by RLS policies.
 *
 * This app uses Google OAuth (not Supabase Auth), so there is no `auth.uid()`.
 * Instead, each request is scoped via a Postgres session variable
 * (`app.current_user_email`) set through this RPC call.
 *
 * Call this once after the user is identified (in AuthContext after login/restore).
 * The anon key is safe to use here because RLS policies validate the email
 * against the row's `user_email` column — a client cannot impersonate another
 * user without knowing their exact email AND having the correct rows to match.
 *
 * The GitHub Actions service-role key bypasses RLS entirely, which is correct.
 */
export const setSupabaseUserEmail = async (email: string): Promise<void> => {
  if (!supabase || !email) return;
  try {
    const { error } = await supabase.rpc('set_current_user_email', { email });
    if (error) {
      console.warn('[Supabase] Falha ao definir email de sessão RLS:', error.message);
    }
  } catch (e) {
    console.warn('[Supabase] set_current_user_email RPC falhou:', e);
  }
};
