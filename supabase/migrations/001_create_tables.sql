-- Tabela de autenticação YouTube por projeto
create table if not exists project_auth (
  project_id        text primary key,
  user_email        text not null,
  youtube_channel_id   text,
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

-- RLS: cada usuário só acessa os próprios dados
alter table project_auth enable row level security;
alter table projects      enable row level security;
alter table autopilot_logs enable row level security;

-- Políticas simples por email (o app usa anon key com email como identificador)
create policy "Acesso por email" on project_auth
  using (user_email = current_setting('request.jwt.claims', true)::json->>'email');

create policy "Acesso por email" on projects
  using (user_email = current_setting('request.jwt.claims', true)::json->>'email');
