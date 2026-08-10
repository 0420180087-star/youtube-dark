-- =============================================================================
-- DarkStream — Setup COMPLETO do Supabase (idempotente)
-- Consolida as migrations 001 a 005 + automation_reliability.sql
-- Pode rodar mesmo que já tenha rodado o SQL do SETUP.md antes — tudo usa
-- IF NOT EXISTS / OR REPLACE, então não duplica nem quebra nada existente.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- 1. TABELAS
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists user_profiles (
  email       text primary key,
  name        text,
  picture     text,
  updated_at  timestamptz default now()
);

create table if not exists project_auth (
  project_id            text not null,
  user_email            text not null,
  youtube_channel_id    text,
  youtube_channel_title text,
  youtube_access_token  text,
  youtube_refresh_token text,
  oauth_client_id       text,
  token_expires_at      timestamptz,
  token_status          text,
  token_error           text,
  token_checked_at      timestamptz,
  updated_at            timestamptz default now(),
  primary key (project_id, user_email)
);

create table if not exists projects (
  id          text primary key,
  user_email  text not null,
  data        jsonb not null,
  autopilot_locked_until timestamptz default null,
  autopilot_locked_by    text default null,
  updated_at  timestamptz default now()
);

create table if not exists autopilot_logs (
  id          uuid primary key default gen_random_uuid(),
  project_id  text not null,
  user_email  text,
  status      text not null,
  message     text,
  step        text,
  video_title text,
  elapsed_ms  integer,
  runner      text,
  created_at  timestamptz default now()
);

create table if not exists user_settings (
  user_email      text primary key,
  gemini_api_keys text[] not null default '{}',
  pexels_api_key  text,
  updated_at      timestamptz default now()
);

-- Sinal de vida do runner headless (GitHub Actions). Faltava aqui: sem ela o
-- painel de Saúde marcava "Runner headless" como falha para sempre.
create table if not exists automation_heartbeat (
  runner       text primary key,
  last_seen_at timestamptz default now(),
  detail       text
);

-- Eventos de cota do Gemini (429/503). O runner roda em outro processo, então o
-- estado em memória do navegador nunca reflete o que aconteceu no GitHub
-- Actions — esta tabela é a única fonte compartilhada.
create table if not exists automation_quota_events (
  id          bigserial primary key,
  user_email  text,
  runner      text,
  key_masked  text,
  reason      text,
  cooldown_ms integer,
  created_at  timestamptz default now()
);
create index if not exists idx_quota_events_user_created
  on automation_quota_events(user_email, created_at desc);


-- Garante colunas em bancos que só rodaram o SQL antigo do SETUP.md
alter table project_auth
  add column if not exists youtube_channel_id    text,
  add column if not exists youtube_channel_title text,
  add column if not exists oauth_client_id       text,
  add column if not exists token_status          text,
  add column if not exists token_error           text,
  add column if not exists token_checked_at      timestamptz;
alter table project_auth alter column youtube_refresh_token drop not null;

-- Bancos antigos podem ter linhas duplicadas por (project_id, user_email)
-- sem a primary key composta; o runner acabava pegando um token expirado.
delete from project_auth p
 using project_auth q
 where p.project_id = q.project_id
   and p.user_email = q.user_email
   and coalesce(p.updated_at, 'epoch') < coalesce(q.updated_at, 'epoch');

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.project_auth'::regclass and contype = 'p'
  ) then
    alter table project_auth add primary key (project_id, user_email);
  end if;
end;
$$;

alter table projects
  add column if not exists autopilot_locked_until timestamptz default null,
  add column if not exists autopilot_locked_by    text default null;

alter table autopilot_logs
  add column if not exists video_title text,
  add column if not exists elapsed_ms  integer,
  add column if not exists runner      text,
  add column if not exists user_email  text;

-- autopilot_logs.user_email era NOT NULL em bancos antigos: todo log do runner
-- headless era rejeitado, deixando a automação sem nenhuma observabilidade.
alter table autopilot_logs alter column user_email drop not null;

-- user_settings antigo só tinha colunas de OAuth: sem estas colunas o runner
-- não conseguia ler as chaves por usuário e reportava "No Gemini key".
alter table user_settings
  add column if not exists gemini_api_keys text[] not null default '{}',
  add column if not exists pexels_api_key  text,
  add column if not exists updated_at      timestamptz default now();


-- ─────────────────────────────────────────────────────────────────────────
-- 2. RLS — política permissiva ("app managed rows")
-- Este app usa Google OAuth próprio, NÃO Supabase Auth (auth.uid() é sempre
-- NULL). O isolamento real acontece via .eq('user_email', email) no código
-- do frontend. RLS aqui é apenas uma camada extra, não o filtro principal.
-- ─────────────────────────────────────────────────────────────────────────

alter table user_profiles  enable row level security;
alter table project_auth   enable row level security;
alter table projects       enable row level security;
alter table autopilot_logs enable row level security;
alter table user_settings  enable row level security;

drop policy if exists "user_profiles: acesso proprio"  on user_profiles;
drop policy if exists "user_profiles: own row only"    on user_profiles;
drop policy if exists "user_profiles: own row"          on user_profiles;
drop policy if exists "user_profiles: app managed rows" on user_profiles;
create policy "user_profiles: app managed rows" on user_profiles for all using (true) with check (true);

-- project_auth guarda refresh tokens do YouTube: acesso APENAS via service_role
-- (Edge Functions exchange-code / refresh-token / user-data).
drop policy if exists "project_auth: acesso por email"  on project_auth;
drop policy if exists "project_auth: own rows only"     on project_auth;
drop policy if exists "project_auth: own rows"          on project_auth;
drop policy if exists "project_auth: app managed rows"  on project_auth;

drop policy if exists "projects: acesso por email"  on projects;
drop policy if exists "projects: own rows only"     on projects;
drop policy if exists "projects: own rows"          on projects;
drop policy if exists "projects: app managed rows"  on projects;
create policy "projects: app managed rows" on projects for all using (true) with check (true);

drop policy if exists "autopilot_logs: acesso por email"      on autopilot_logs;
drop policy if exists "autopilot_logs: own project logs"      on autopilot_logs;
drop policy if exists "autopilot_logs: own projects only"     on autopilot_logs;
drop policy if exists "autopilot_logs: app managed rows"      on autopilot_logs;
create policy "autopilot_logs: app managed rows" on autopilot_logs for all using (true) with check (true);

drop policy if exists "user_settings: own row only"    on user_settings;
drop policy if exists "user_settings: own row"          on user_settings;
drop policy if exists "user_settings: app managed rows" on user_settings;
create policy "user_settings: app managed rows" on user_settings for all using (true) with check (true);

alter table automation_heartbeat    enable row level security;
alter table automation_quota_events enable row level security;

drop policy if exists "automation_heartbeat: app managed rows" on automation_heartbeat;
create policy "automation_heartbeat: app managed rows" on automation_heartbeat for all using (true) with check (true);

drop policy if exists "automation_quota_events: app managed rows" on automation_quota_events;
create policy "automation_quota_events: app managed rows" on automation_quota_events for all using (true) with check (true);

-- GRANTs — necessários pois as policies acima liberam para anon/authenticated
grant select, insert, update, delete on public.user_profiles  to anon, authenticated;
grant select, insert, update, delete on public.projects       to anon, authenticated;
grant select, insert, update, delete on public.project_auth   to anon, authenticated;
grant select, insert, update, delete on public.autopilot_logs to anon, authenticated;
grant select, insert, update, delete on public.user_settings  to anon, authenticated;
grant select on public.automation_heartbeat    to anon, authenticated;
grant select, insert on public.automation_quota_events to anon, authenticated;
grant usage, select on sequence public.automation_quota_events_id_seq to anon, authenticated;
grant all on public.user_profiles  to service_role;
grant all on public.projects       to service_role;
grant all on public.project_auth   to service_role;
grant all on public.autopilot_logs to service_role;
grant all on public.user_settings  to service_role;
grant all on public.automation_heartbeat    to service_role;
grant all on public.automation_quota_events to service_role;
grant usage, select on sequence public.automation_quota_events_id_seq to service_role;


-- ─────────────────────────────────────────────────────────────────────────
-- 3. FUNÇÕES AUXILIARES
-- ─────────────────────────────────────────────────────────────────────────

-- Usada pelo frontend (supabaseClient.ts) — hoje é só "melhor esforço",
-- não bloqueia nada, mas evita warnings no console se não existir.
create or replace function set_session_email(p_email text)
returns void language plpgsql as $$
begin
  perform set_config('request.user_email', p_email, true);
end;
$$;

create or replace function requesting_user_email()
returns text language sql stable as $$
  select nullif(current_setting('request.user_email', true), '')
$$;

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_settings_touch_updated_at on user_settings;
create trigger user_settings_touch_updated_at
  before update on user_settings
  for each row execute function touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- 4. LOCK DISTRIBUÍDO — essencial para o automation-runner.js funcionar
-- (é o que trava o erro "Lock RPC error" se estiver faltando)
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.acquire_autopilot_lock(
    p_project_id   text,
    p_locked_by    text,
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
        autopilot_locked_by    = p_locked_by,
        updated_at             = now()
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
        autopilot_locked_by    = null,
        updated_at             = now()
    where id = p_project_id;
end;
$$;

grant execute on function public.acquire_autopilot_lock(text, text, int) to anon, authenticated, service_role;
grant execute on function public.release_autopilot_lock(text)            to anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. ÍNDICES
-- ─────────────────────────────────────────────────────────────────────────

create index if not exists idx_projects_user_email          on public.projects(user_email);
create index if not exists idx_projects_updated_at          on public.projects(updated_at desc);
create index if not exists idx_projects_autopilot_lock      on public.projects(autopilot_locked_until) where autopilot_locked_until is not null;
create index if not exists idx_project_auth_project_user    on public.project_auth(project_id, user_email);
create index if not exists idx_project_auth_user_updated    on public.project_auth(user_email, updated_at desc);
create index if not exists idx_autopilot_logs_project_created on public.autopilot_logs(project_id, created_at desc);
create index if not exists idx_user_settings_email          on public.user_settings(user_email);

-- =============================================================================
-- FIM. Depois de rodar isto, confira em Table Editor se aparecem:
--   user_profiles, project_auth, projects, autopilot_logs, user_settings
-- E em Database → Functions:
--   acquire_autopilot_lock, release_autopilot_lock, set_session_email,
--   requesting_user_email, touch_updated_at
-- =============================================================================
