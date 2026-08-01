# 🚀 Setup — Automação 100% autônoma

Depois destes 4 passos (≈10 min, feitos **uma única vez**), o sistema cria e publica vídeos sozinho, com a página fechada.

---

## Passo 1 — Criar o banco de dados

1. Abra o **SQL Editor** no painel do Supabase.
2. Copie o conteúdo **inteiro** de [`supabase/bootstrap.sql`](supabase/bootstrap.sql) e execute.

Esse arquivo é idempotente: pode rodar de novo sempre que quiser, sem perder dados. Ele substitui todas as migrations antigas (`supabase/migrations/`) — não precisa aplicar nenhuma delas manualmente.

**Como confirmar que deu certo:** execute

```sql
select table_name from information_schema.tables
where table_schema = 'public' order by 1;
```

Deve listar: `autopilot_logs`, `automation_heartbeat`, `project_auth`, `projects`, `user_profiles`, `user_settings`.

> Se o runner do GitHub Actions imprimir `PREFLIGHT FALHOU`, é porque este passo não foi feito (ou foi feito parcialmente). Rode o `bootstrap.sql` novamente.

---

## Passo 2 — Ativar GitHub Pages

**Settings** → **Pages** → em **Source**, selecione **GitHub Actions**. O deploy roda a cada push na `main`.

---

## Passo 3 — Secrets do repositório

**Settings** → **Secrets and variables** → **Actions** → **New repository secret**.

### Obrigatórios (sem eles a automação não roda)

| Secret | Onde encontrar |
|---|---|
| `VITE_SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Settings → API → chave `anon public` |
| `SUPABASE_SERVICE_KEY` | Supabase → Settings → API → chave `service_role` (⚠️ nunca no frontend) |
| `VITE_GOOGLE_CLIENT_ID` | Google Cloud Console → Credentials → OAuth 2.0 Client ID |
| `YOUTUBE_CLIENT_SECRET` | Google Cloud Console → Credentials → OAuth 2.0 Client Secret |
| `VITE_BASE_URL` | `/nome-do-repositorio/` (com as duas barras) |

### Opcionais (recomendados)

| Secret | Para quê |
|---|---|
| `VITE_GEMINI_API_KEY` | Fallback global se o usuário não salvar a chave em Configurações |
| `VITE_PEXELS_API_KEY` | Fallback global do banco de vídeos/imagens |

As chaves Gemini/Pexels salvas na tela **Configurações** do app ficam em `user_settings` e têm prioridade sobre os secrets. Os secrets são só a rede de segurança.

---

## Passo 4 — Publicar o app OAuth no Google Cloud ⚠️

**Este passo é o que separa "funciona por 7 dias" de "funciona para sempre".**

Google Cloud Console → **APIs & Services** → **OAuth consent screen**:

1. Clique em **Publish app** (sair do modo *Testing*).
   Em modo *Testing*, o Google **expira o refresh token em 7 dias** — a automação para e exige reconexão manual do canal.
2. Em **Credentials** → seu OAuth Client, adicione:
   - **Authorized JavaScript origins**: `https://SEU-USUARIO.github.io`
   - **Authorized redirect URIs**: `https://SEU-USUARIO.github.io/NOME-DO-REPO/oauth/callback`
3. Ative a **YouTube Data API v3** em **Enabled APIs**.

---

## Como a automação funciona

- **Motor principal:** GitHub Actions, cron a cada 15 min (`.github/workflows/auto-post.yml`). Roda com a página fechada.
- **Motor local (navegador):** só é usado quando o Supabase não está configurado, ou quando você clica em **Executar Agora**. Fechar a aba interrompe apenas esse modo.
- **Lock distribuído:** garante que os dois motores nunca processem o mesmo projeto ao mesmo tempo.
- **Auto-retry:** falhas transitórias (Gemini `OTHER`, timeout de rede, Pexels) são reprocessadas automaticamente com backoff de 5 min → 20 min → 1 h → 4 h, retomando do passo que falhou. Só depois de 4 tentativas o vídeo fica em Standby aguardando você.
- **Sem token do YouTube:** o vídeo é gerado até o fim e fica em **SCHEDULED** (pronto para postar). Assim que o canal for reconectado, o próximo ciclo publica sozinho. Nenhum trabalho é perdido.
- **Novos projetos** já nascem com o Auto-Pilot **ligado** (diário, janela 12:00–18:00).

---

## Limitação honesta

Se o Google **revogar** o refresh token (usuário removeu o acesso, ou app em modo *Testing* por mais de 7 dias), **não existe** forma de renovar sem consentimento humano — é uma restrição do Google, não do sistema. O que o app faz: detecta isso no início de cada ciclo, avisa no banner, e continua gerando vídeos que serão publicados automaticamente após a reconexão.

---

## Diagnóstico

A aba **Calendário & Automação** mostra o card **Saúde da Automação** com: schema OK, chaves presentes, status do token do YouTube e último sinal do runner headless. Comece o troubleshooting sempre por ali.
