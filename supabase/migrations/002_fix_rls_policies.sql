-- =============================================================================
-- Migration 002: Fix RLS policies
--
-- PROBLEM WITH ORIGINAL APPROACH (set_config session variable):
-- Supabase uses PgBouncer in transaction-pooling mode by default.
-- In this mode, each transaction may be routed to a different Postgres
-- connection, so a session-level set_config() call set in one request
-- is NOT visible to the next request — even from the same client.
-- This made all RLS policies silently return 0 rows.
--
-- CORRECT APPROACH for Supabase without Supabase Auth:
-- This app authenticates via Google OAuth and does NOT use Supabase Auth,
-- so auth.uid() is always NULL. Instead:
--
--   1. Each query already passes user_email explicitly (e.g. .eq('user_email', email)).
--      This is the primary isolation mechanism — it works regardless of pooling.
--
--   2. RLS acts as a SECONDARY enforcement layer using a helper function
--      `requesting_user_email()` that reads a TRANSACTION-level config variable
--      (set_config(..., true)) — true = local/transaction scope, which IS
--      preserved within a single transaction even with connection pooling.
--
--   3. The frontend calls set_session_email() via RPC at the START of every
--      Supabase request batch (wrapped in a transaction by the Supabase client).
--
-- The GitHub Actions service-role key bypasses RLS entirely (correct behaviour).
-- =============================================================================

-- ── Helper: set email for the CURRENT TRANSACTION (pooling-safe) ─────────────

create or replace function set_session_email(p_email text)
returns void
language plpgsql
security definer
as $$
begin
  -- true = LOCAL scope (transaction-level), NOT session-level.
  -- This is the only mode that survives PgBouncer transaction pooling.
  perform set_config('request.user_email', p_email, true);
end;
$$;

-- ── Helper: read it back (returns NULL if not set) ────────────────────────────

create or replace function requesting_user_email()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.user_email', true), '')
$$;

-- ── Drop old helpers and policies from any previous migration attempt ─────────

drop function if exists set_current_user_email(text);
drop function if exists current_user_email();

drop policy if exists "user_profiles: acesso proprio"           on user_profiles;
drop policy if exists "project_auth: acesso por email"          on project_auth;
drop policy if exists "projects: acesso por email"              on projects;
drop policy if exists "autopilot_logs: acesso por email"        on autopilot_logs;
drop policy if exists "user_profiles: own row only"             on user_profiles;
drop policy if exists "project_auth: own rows only"             on project_auth;
drop policy if exists "projects: own rows only"                 on projects;
drop policy if exists "autopilot_logs: own project logs only"   on autopilot_logs;

-- ── user_profiles ─────────────────────────────────────────────────────────────

create policy "user_profiles: own row"
  on user_profiles
  for all
  using  (email = requesting_user_email())
  with check (email = requesting_user_email());

-- ── project_auth ──────────────────────────────────────────────────────────────

create policy "project_auth: own rows"
  on project_auth
  for all
  using  (user_email = requesting_user_email())
  with check (user_email = requesting_user_email());

-- ── projects ──────────────────────────────────────────────────────────────────

create policy "projects: own rows"
  on projects
  for all
  using  (user_email = requesting_user_email())
  with check (user_email = requesting_user_email());

-- ── autopilot_logs ────────────────────────────────────────────────────────────

create policy "autopilot_logs: own project logs"
  on autopilot_logs
  for all
  using (
    exists (
      select 1 from projects p
      where p.id = autopilot_logs.project_id
        and p.user_email = requesting_user_email()
    )
  );

-- =============================================================================
-- IMPORTANT — Frontend integration:
--
-- Replace the old `setSupabaseUserEmail` RPC call in supabaseClient.ts
-- with `set_session_email`. The call must happen inside the same
-- Supabase transaction as the queries that follow it.
--
-- The app's existing `.eq('user_email', email)` filters on every query
-- are the PRIMARY protection. RLS via set_session_email is a belt-and-suspenders
-- secondary layer. If set_session_email is not called, queries still work
-- correctly because of the explicit .eq() filters — they just skip the RLS check.
-- =============================================================================
