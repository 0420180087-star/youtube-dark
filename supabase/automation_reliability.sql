-- =============================================================================
-- Automation reliability SQL
-- Apply this SQL to the connected database if the managed migration tool is not
-- available for this project.
-- =============================================================================

alter table public.project_auth
  add column if not exists youtube_channel_id text,
  add column if not exists youtube_channel_title text,
  add column if not exists oauth_client_id text;

alter table public.projects
  add column if not exists autopilot_locked_until timestamptz default null,
  add column if not exists autopilot_locked_by text default null;

alter table public.project_auth
  alter column youtube_refresh_token drop not null;

alter table public.autopilot_logs
  add column if not exists video_title text,
  add column if not exists elapsed_ms integer,
  add column if not exists runner text;

grant select, insert, update, delete on public.user_profiles to anon, authenticated;
grant all on public.user_profiles to service_role;
grant select, insert, update, delete on public.projects to anon, authenticated;
grant all on public.projects to service_role;
grant select, insert, update, delete on public.project_auth to anon, authenticated;
grant all on public.project_auth to service_role;
grant select, insert, update, delete on public.autopilot_logs to anon, authenticated;
grant all on public.autopilot_logs to service_role;
grant select, insert, update, delete on public.user_settings to anon, authenticated;
grant all on public.user_settings to service_role;

create index if not exists idx_projects_user_email on public.projects(user_email);
create index if not exists idx_projects_updated_at on public.projects(updated_at desc);
create index if not exists idx_project_auth_project_user on public.project_auth(project_id, user_email);
create index if not exists idx_project_auth_user_updated on public.project_auth(user_email, updated_at desc);
create index if not exists idx_autopilot_logs_project_created on public.autopilot_logs(project_id, created_at desc);
create index if not exists idx_user_settings_email on public.user_settings(user_email);

create or replace function public.acquire_autopilot_lock(
    p_project_id text,
    p_locked_by text,
    p_lock_minutes int default 90
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_updated int;
begin
    update public.projects
    set autopilot_locked_until = now() + (p_lock_minutes || ' minutes')::interval,
        autopilot_locked_by = p_locked_by,
        updated_at = now()
    where id = p_project_id
      and (autopilot_locked_until is null or autopilot_locked_until < now());

    get diagnostics v_updated = row_count;
    return v_updated > 0;
end;
$$;

create or replace function public.release_autopilot_lock(p_project_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.projects
    set autopilot_locked_until = null,
        autopilot_locked_by = null,
        updated_at = now()
    where id = p_project_id;
end;
$$;

grant execute on function public.acquire_autopilot_lock(text, text, int) to anon, authenticated, service_role;
grant execute on function public.release_autopilot_lock(text) to anon, authenticated, service_role;