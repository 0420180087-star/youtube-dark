# 🚀 Setup — Deploy e Automação

Após o Lovable fazer o push para o GitHub, você precisa fazer **3 passos manuais** (≈5 minutos):

---

## Passo 1 — Ativar GitHub Pages

1. Vá ao seu repositório no GitHub
2. Clique em **Settings** → **Pages**
3. Em **Source**, selecione **GitHub Actions**
4. Salve

O deploy acontecerá automaticamente a cada push na branch `main`.

---

## Passo 2 — Adicionar Secrets

1. No repositório, vá em **Settings** → **Secrets and variables** → **Actions**
2. Clique em **New repository secret** para cada um:

| Secret | Onde encontrar |
|---|---|
| `VITE_BASE_URL` | `/nome-do-seu-repositorio/` (com barras) |
| `VITE_SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Settings → API → `anon` `public` key |
| `SUPABASE_SERVICE_KEY` | Supabase → Settings → API → `service_role` key (⚠️ nunca exponha no frontend) |
| `VITE_GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) |
| `VITE_PEXELS_API_KEY` | [Pexels API](https://www.pexels.com/api/) → Sua API Key |
| `VITE_GOOGLE_CLIENT_ID` | Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID |
| `YOUTUBE_CLIENT_SECRET` | Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client Secret |

---

## Passo 3 — Criar tabelas no Supabase

Abra o **SQL Editor** no painel do Supabase e cole o SQL abaixo:

```sql
-- Tabela de projetos (se ainda não existir)
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own projects"
  ON projects FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Tabela de logs do autopilot
CREATE TABLE IF NOT EXISTS autopilot_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('success', 'error', 'skipped')),
  video_title TEXT,
  video_url TEXT,
  failed_step TEXT,
  error_message TEXT,
  duration_seconds INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE autopilot_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own logs"
  ON autopilot_logs FOR SELECT
  TO authenticated
  USING (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  );

-- Service role pode inserir logs (usado pelo automation-runner)
CREATE POLICY "Service role can insert logs"
  ON autopilot_logs FOR INSERT
  TO service_role
  WITH CHECK (true);
```

---

## ✅ Pronto!

- O **deploy** roda automaticamente a cada push na `main`
- A **automação de postagem** roda a cada 6 horas via cron, ou manualmente pelo botão "Run workflow" na aba Actions
- Vídeos que falharem ficam em **STANDBY** no Supabase para reprocessamento manual
