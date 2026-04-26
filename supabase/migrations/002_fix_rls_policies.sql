-- =============================================================================
-- Migration 002: Fix RLS policies
--
-- The original policies used `using (true)`, meaning any authenticated client
-- could read and write ANY row — effectively disabling row-level isolation.
--
-- This migration drops those open policies and replaces them with ones that
-- actually restrict each user to their own data.
--
-- CONTEXT: This app authenticates via Google OAuth (implicit/GIS flow), NOT via
-- Supabase Auth. There is no `auth.uid()`. The user identity is the verified
-- Google email stored in each row's `user_email` column.
--
-- APPROACH: We use a Postgres session variable (`app.current_user_email`) that
-- the frontend sets at the start of every Supabase session via RPC. This gives
-- us row-level filtering without requiring Supabase Auth.
--
-- The GitHub Actions service-role key bypasses RLS entirely (correct behaviour).
-- =============================================================================

-- ── Step 1: Create a helper to set the current user email for a session ──────

create or replace function set_current_user_email(email text)
returns void
language plpgsql
security definer
as $$
begin
  perform set_config('app.current_user_email', email, false);
end;
$$;

-- ── Step 2: Create a helper to read it back safely ───────────────────────────

create or replace function current_user_email()
returns text
language sql
stable
as $$
  select nullif(current_setting('app.current_user_email', true), '')
$$;

-- ── Step 3: Drop the open policies from migration 001 ────────────────────────

drop policy if exists "user_profiles: acesso proprio"  on user_profiles;
drop policy if exists "project_auth: acesso por email" on project_auth;
drop policy if exists "projects: acesso por email"     on projects;
drop policy if exists "autopilot_logs: acesso por email" on autopilot_logs;

-- ── Step 4: user_profiles — users can only read/write their own profile ───────

create policy "user_profiles: own row only"
  on user_profiles
  for all
  using  (email = current_user_email())
  with check (email = current_user_email());

-- ── Step 5: project_auth — users can only access their own auth rows ──────────

create policy "project_auth: own rows only"
  on project_auth
  for all
  using  (user_email = current_user_email())
  with check (user_email = current_user_email());

-- ── Step 6: projects — users can only access their own projects ───────────────

create policy "projects: own rows only"
  on projects
  for all
  using  (user_email = current_user_email())
  with check (user_email = current_user_email());

-- ── Step 7: autopilot_logs — users can only access logs for their projects ────
-- We join through the projects table to verify ownership.

create policy "autopilot_logs: own project logs only"
  on autopilot_logs
  for all
  using (
    exists (
      select 1 from projects p
      where p.id = autopilot_logs.project_id
        and p.user_email = current_user_email()
    )
  );
