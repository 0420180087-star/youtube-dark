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
 * Sets the transaction-level user email used by RLS policies.
 *
 * WHY transaction-level (not session-level):
 * Supabase uses PgBouncer in transaction-pooling mode. In this mode, each
 * transaction may land on a different Postgres connection, so session-level
 * variables (set_config(..., false)) are lost between requests.
 * Transaction-level variables (set_config(..., true)) are scoped to the
 * current transaction and ARE preserved within a single Supabase query — which
 * is the only guarantee we need.
 *
 * USAGE:
 * Call once after the user is identified (login or restore in AuthContext).
 * The call itself is a lightweight RPC and can be fire-and-forget.
 *
 * NOTE: The app's explicit .eq('user_email', email) filters on every query
 * are the PRIMARY data isolation mechanism. This RLS call is a secondary
 * enforcement layer. If Supabase is unreachable, the app still works correctly.
 */
export const setSupabaseUserEmail = async (email: string): Promise<void> => {
  if (!supabase || !email) return;
  try {
    const { error } = await supabase.rpc('set_session_email', { p_email: email });
    if (error) {
      // Non-fatal: the explicit .eq() filters still isolate data correctly
      console.warn('[Supabase] set_session_email falhou (RLS desativado para esta sessão):', error.message);
    }
  } catch (e) {
    console.warn('[Supabase] set_session_email RPC inacessível:', e);
  }
};
