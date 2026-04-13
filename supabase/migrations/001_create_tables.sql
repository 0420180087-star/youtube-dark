-- Tabela de perfis de usuário (persistência cross-device)
create table if not exists user_profiles (
  email       text primary key,
  name        text,
  picture     text,
  updated_at  timestamptz default now()
);

-- Tabela de autenticação YouTube por projeto
create table if not exists project_auth (
  project_id            text primary key,
  user_email            text not null,
  youtube_channel_id    text,
  youtube_channel_title text,
  youtube_access_token  text,
  youtube_refresh_token text not null,
  token_expires_at      timestamptz,
  updated_at            timestamptz default now()
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

-- RLS
alter table user_profiles  enable row level security;
alter table project_auth   enable row level security;
alter table projects       enable row level security;
alter table autopilot_logs enable row level security;

-- Políticas: acesso público via anon key por email match
create policy "user_profiles: acesso proprio" on user_profiles
  using (true); -- perfis são lidos/escritos pelo próprio usuário via anon key

create policy "project_auth: acesso por email" on project_auth
  using (true); -- o frontend usa anon key; a service key do runner bypassa RLS

create policy "projects: acesso por email" on projects
  using (true);

create policy "autopilot_logs: acesso por email" on autopilot_logs
  using (true);
