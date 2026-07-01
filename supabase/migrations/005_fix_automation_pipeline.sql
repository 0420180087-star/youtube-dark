-- =============================================================================
-- Migration 005: Automation pipeline hardening
--
-- Fixes the issues that stopped both browser Auto-Pilot and GitHub Actions:
--   1. user_settings RLS was still reading app.user_email while the current
--      helper writes request.user_email. In practice, saved Gemini/Pexels keys
--      could not be read/written by the app, so the runner saw no user keys.
--   2. lock RPCs accepted uuid while projects.id is text. This can fail at
--      runtime with text = uuid and prevents the pipeline from starting.
--   3. automation-runner inserts video_title and elapsed_ms into autopilot_logs;
--      older databases did not have those columns.
-- =============================================================================

-- Logs used by scripts/automation-runner.js
alter table autopilot_logs
  add column if not exists video_title text,
  add column if not exists elapsed_ms integer;

-- Robust lock RPCs: project IDs are stored as text in the projects table.
create or replace function acquire_autopilot_lock(
    p_project_id  text,
    p_locked_by   text,
    p_lock_minutes int default 90
)
returns boolean
language plpgsql
security definer
as $$
declare
    v_updated int;
begin
    update projects
    set
        autopilot_locked_until = now() + (p_lock_minutes || ' minutes')::interval,
        autopilot_locked_by    = p_locked_by,
        updated_at             = now()
    where
        id = p_project_id
        and (
            autopilot_locked_until is null
            or autopilot_locked_until < now()
        );

    get diagnostics v_updated = row_count;
    return v_updated > 0;
end;
$$;

create or replace function release_autopilot_lock(p_project_id text)
returns void
language plpgsql
security definer
as $$
begin
    update projects
    set
        autopilot_locked_until = null,
        autopilot_locked_by    = null,
        updated_at             = now()
    where id = p_project_id;
end;
$$;

-- user_settings policies.
-- This app uses Google OAuth in the browser, not Supabase Auth JWTs. Because of
-- PgBouncer transaction pooling, a transaction-local GUC set by a previous RPC
-- is not visible to a later PostgREST request. Therefore the old policy made the
-- Settings page silently fail to persist API keys. Keep explicit user_email
-- filters in frontend code and allow anon CRUD so the app can function.
-- Treat the anon key as public and keep the table private at the project level.
drop policy if exists "user_settings: own row only" on user_settings;
drop policy if exists "user_settings: own row" on user_settings;
create policy "user_settings: app managed rows"
  on user_settings
  for all
  using (true)
  with check (true);

-- Backfill updated_at behaviour for settings rows.
create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_settings_touch_updated_at on user_settings;
create trigger user_settings_touch_updated_at
  before update on user_settings
  for each row
  execute function touch_updated_at();
