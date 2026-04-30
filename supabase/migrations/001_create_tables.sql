-- Tabela de perfis de usuário (persistência cross-device)
create table if not exists user_profiles (
  email       text primary key,
  name        text,
  picture     text,
  updated_at  timestamptz default now()
);

-- Tabela de autenticação YouTube por projeto
-- NOTE: primary key moved to (project_id, user_email) composite so multiple users
-- can each have a 'default' project_id without colliding.
create table if not exists project_auth (
  project_id            text not null,
  user_email            text not null,
  youtube_channel_id    text,
  youtube_channel_title text,
  youtube_access_token  text,
  youtube_refresh_token text not null,
  token_expires_at      timestamptz,
  updated_at            timestamptz default now(),
  primary key (project_id, user_email)
);

-- Tabela de projetos (espelho do IndexedDB para o GitHub Actions ler)
create table if not exists projects (
  id          text primary key,
  user_email  text not null,
  data        jsonb not null,
  updated_at  timestamptz default now()
);

-- Logs do AutoPilot
create table if not exists autopilot_logs (
  id          uuid primary key default gen_random_uuid(),
  project_id  text not null,
  status      text not null,
  message     text,
  step        text,
  created_at  timestamptz default now()
);

-- Helper: store the requesting user's email for the current transaction
-- so RLS policies can filter by it without needing Supabase Auth JWT.
create or replace function set_session_email(p_email text)
returns void language plpgsql as $$
begin
  -- transaction-level so it survives PgBouncer transaction pooling
  perform set_config('app.user_email', p_email, true);
end;
$$;

-- RLS
alter table user_profiles  enable row level security;
alter table project_auth   enable row level security;
alter table projects       enable row level security;
alter table autopilot_logs enable row level security;

-- Drop old permissive policies if they exist
drop policy if exists "user_profiles: acesso proprio"    on user_profiles;
drop policy if exists "project_auth: acesso por email"   on project_auth;
drop policy if exists "projects: acesso por email"       on projects;
drop policy if exists "autopilot_logs: acesso por email" on autopilot_logs;

-- user_profiles: only the owner can read/write their own row
create policy "user_profiles: own row only" on user_profiles
  using (email = current_setting('app.user_email', true));

-- project_auth: scoped to the authenticated user's email
create policy "project_auth: own rows only" on project_auth
  using (user_email = current_setting('app.user_email', true));

-- projects: scoped to the authenticated user's email
create policy "projects: own rows only" on projects
  using (user_email = current_setting('app.user_email', true));

-- autopilot_logs: readable by the project owner (join via projects table)
create policy "autopilot_logs: own projects only" on autopilot_logs
  using (
    project_id in (
      select id from projects
      where user_email = current_setting('app.user_email', true)
    )
  );
