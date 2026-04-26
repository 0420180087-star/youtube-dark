-- =============================================================================
-- Migration 003: Autopilot lock column
--
-- Prevents the browser scheduler (setInterval) and GitHub Actions cron from
-- running the same project pipeline simultaneously.
--
-- MECHANISM (optimistic lock):
--   Before starting a pipeline, the runner (browser OR Actions) attempts to
--   set `autopilot_locked_until` to NOW() + 90 minutes using a conditional
--   UPDATE that only succeeds if the lock is currently NULL or expired.
--   Only the runner that wins the UPDATE actually proceeds.
--
-- The browser runner checks this field before each setInterval tick.
-- The Actions runner does the same before processing each eligible project.
--
-- `autopilot_locked_by` is informational — 'browser' or 'github-actions' —
-- and helps with debugging duplicate-run investigations.
-- =============================================================================

alter table projects
  add column if not exists autopilot_locked_until  timestamptz default null,
  add column if not exists autopilot_locked_by     text        default null;

-- RPC: Try to acquire the autopilot lock for a project.
-- Returns TRUE if the lock was acquired, FALSE if already held.
-- The lock expires automatically after `lock_minutes` minutes,
-- so a crashed runner never permanently blocks a project.
create or replace function acquire_autopilot_lock(
    p_project_id  uuid,
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
            or autopilot_locked_until < now()   -- expired lock
        );

    get diagnostics v_updated = row_count;
    return v_updated > 0;
end;
$$;

-- RPC: Release the autopilot lock (call when pipeline finishes or errors).
create or replace function release_autopilot_lock(p_project_id uuid)
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

comment on column projects.autopilot_locked_until is
  'Timestamp until which the autopilot pipeline lock is held. NULL = unlocked.';
comment on column projects.autopilot_locked_by is
  'Which runner holds the lock: ''browser'' or ''github-actions''.';
