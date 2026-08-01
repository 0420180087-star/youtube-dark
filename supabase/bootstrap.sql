-- =============================================================================
-- DarkStream — BOOTSTRAP SQL (canônico e idempotente)
--
-- Cole este arquivo INTEIRO no SQL Editor do Supabase e execute.
-- Pode rodar quantas vezes quiser: nada é destruído, nada duplica.
--
-- Este script substitui todas as migrations 001→005. Ele cria:
--   • user_profiles     — perfil do usuário (cross-device)
--   • projects          — espelho dos projetos (lido pelo GitHub Actions)
--   • project_auth      — refresh_token do YouTube por projeto
--   • user_settings     — chaves Gemini/Pexels por usuário
--   • autopilot_logs    — histórico de execuções da automação
--   • automation_heartbeat — sinal de vida do runner headless
--   • RPCs de lock      — evitam dois runners no mesmo projeto
--   • GRANTs + RLS      — sem eles o app recebe "permission denied"
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. TABELAS
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.user_profiles (
  email      text primary key,
  name       text,
  picture    text,
  updated_at timestamptz default now()
);

create table if not exists public.projects (
  id         text primary key,
  user_email text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

alter table public.projects
  add column if not exists autopilot_locked_until timestamptz default null,
  add column if not exists autopilot_locked_by    text        default null;

create table if not exists public.project_auth (
  project_id            text not null,
  user_email            text not null,
  youtube_channel_id    text,
  youtube_channel_title text,
  youtube_access_token  text,
  youtube_refresh_token text,
  token_expires_at      timestamptz,
  updated_at            timestamptz default now(),
  primary key (project_id, user_email)
);

alter table public.project_auth
  add column if not exists youtube_channel_id    text,
  add column if not exists youtube_channel_title text,
  add column if not exists oauth_client_id       text,
  -- Saúde do refresh_token, escrita pelo runner a cada ciclo.
  -- 'ok' | 'revoked' | 'missing' | 'unknown'
  add column if not exists token_status          text default 'unknown',
  add column if not exists token_checked_at      timestamptz,
  add column if not exists token_error           text;

-- Bancos antigos criaram youtube_refresh_token como NOT NULL. O fluxo atual
-- grava a linha antes de ter o refresh_token, então a restrição precisa cair.
alter table public.project_auth
  alter column youtube_refresh_token drop not null;

create table if not exists public.user_settings (
  user_email      text primary key,
  gemini_api_keys text[] not null default '{}',
  pexels_api_key  text,
  updated_at      timestamptz default now()
);

create table if not exists public.autopilot_logs (
  id          uuid primary key default gen_random_uuid(),
  project_id  text not null,
  status      text not null,
  message     text,
  step        text,
  created_at  timestamptz default now()
);

alter table public.autopilot_logs
  add column if not exists video_title text,
  add column if not exists elapsed_ms  integer,
  add column if not exists runner      text;

-- Sinal de vida do runner headless. Se a linha 'github-actions' estiver velha,
-- o app avisa que os secrets do repositório não estão configurados.
create table if not exists public.automation_heartbeat (
  runner       text primary key,
  last_seen_at timestamptz not null default now(),
  detail       text
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ÍNDICES
-- ─────────────────────────────────────────────────────────────────────────────

create index if not exists idx_projects_user_email        on public.projects(user_email);
create index if not exists idx_projects_updated_at        on public.projects(updated_at desc);
create index if not exists idx_projects_autopilot_lock    on public.projects(autopilot_locked_until) where autopilot_locked_until is not null;
create index if not exists idx_project_auth_project_user  on public.project_auth(project_id, user_email);
create index if not exists idx_project_auth_user_updated  on public.project_auth(user_email, updated_at desc);
create index if not exists idx_autopilot_logs_proj_create on public.autopilot_logs(project_id, created_at desc);
create index if not exists idx_user_settings_email        on public.user_settings(user_email);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. GRANTS — obrigatórios. Sem eles o PostgREST retorna permission denied.
-- ─────────────────────────────────────────────────────────────────────────────

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete on public.user_profiles        to anon, authenticated;
grant select, insert, update, delete on public.projects             to anon, authenticated;
grant select, insert, update, delete on public.project_auth         to anon, authenticated;
grant select, insert, update, delete on public.user_settings        to anon, authenticated;
grant select, insert, update, delete on public.autopilot_logs       to anon, authenticated;
grant select, insert, update, delete on public.automation_heartbeat to anon, authenticated;

grant all on public.user_profiles        to service_role;
grant all on public.projects             to service_role;
grant all on public.project_auth         to service_role;
grant all on public.user_settings        to service_role;
grant all on public.autopilot_logs       to service_role;
grant all on public.automation_heartbeat to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS
--
-- O app faz login com Google OAuth no navegador, NÃO com Supabase Auth, então
-- auth.uid() é sempre NULL aqui. A isolação real acontece nos filtros
-- explícitos (.eq('user_email', ...)) de cada query. As policies abaixo
-- mantêm RLS habilitado e liberam o acesso via anon key.
-- Trate a anon key como pública e o projeto Supabase como privado.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.user_profiles        enable row level security;
alter table public.projects             enable row level security;
alter table public.project_auth         enable row level security;
alter table public.user_settings        enable row level security;
alter table public.autopilot_logs       enable row level security;
alter table public.automation_heartbeat enable row level security;

do $$
declare
  t text;
  p record;
begin
  foreach t in array array[
    'user_profiles','projects','project_auth',
    'user_settings','autopilot_logs','automation_heartbeat'
  ]
  loop
    -- remove qualquer policy antiga (migrations 001/002/004/005)
    for p in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;

    execute format(
      'create policy %I on public.%I for all using (true) with check (true)',
      t || ': app managed rows', t
    );
  end loop;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. LOCK DISTRIBUÍDO (projects.id é TEXT — não uuid)
-- ─────────────────────────────────────────────────────────────────────────────

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

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. updated_at automático em user_settings
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_settings_touch_updated_at on public.user_settings;
create trigger user_settings_touch_updated_at
  before update on public.user_settings
  for each row execute function public.touch_updated_at();

-- =============================================================================
-- FIM. Se rodou sem erro, o schema está completo.
-- Verifique com:
--   select table_name from information_schema.tables
--   where table_schema = 'public' order by 1;
-- Deve listar: autopilot_logs, automation_heartbeat, project_auth,
--              projects, user_profiles, user_settings
-- =============================================================================
