-- Per-user API keys (Gemini + Pexels) so the GitHub Actions runner
-- can pick up the keys saved in the app instead of relying on global
-- workspace env vars.
--
-- SECURITY: stored as plaintext on the server because:
--   1. The client-side AES-GCM key never leaves the browser, so the runner
--      could not decrypt anything we wrote in ciphertext anyway.
--   2. Access is controlled via RLS (per user_email) + service-role on the runner.
-- Treat this table as sensitive — same level as project_auth.

create table if not exists user_settings (
  user_email      text primary key,
  gemini_api_keys text[] not null default '{}',
  pexels_api_key  text,
  updated_at      timestamptz default now()
);

alter table user_settings enable row level security;

drop policy if exists "user_settings: own row only" on user_settings;
create policy "user_settings: own row only" on user_settings
  using (user_email = current_setting('app.user_email', true));
