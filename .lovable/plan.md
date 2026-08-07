# Automação de criação e postagem — diagnóstico e correção

## Passo 1 — Evidência levantada

Evidência real: log do GitHub Actions + inspeção do schema do banco (`information_schema.columns`). Diagnóstico agora é confirmado, não hipótese.

**Causa raiz #1 — CONFIRMADA (é o que para tudo hoje).** A tabela `user_settings` no banco real tem apenas `user_email`, `google_client_id`, `youtube_channel`, `youtube_access_token`, `updated_at`. **As colunas `gemini_api_keys` e `pexels_api_key` não existem** (`ERROR 42703: column "gemini_api_keys" does not exist`) — a migration `004_user_settings.sql` nunca foi aplicada neste banco.

Consequência em cadeia: em `scripts/automation-runner.js`, `loadUserKeys()` faz `.select('gemini_api_keys, pexels_api_key')` e **descarta o `error`** (`const { data } = ...`). O PostgREST erra, `data` vem `null`, e o runner interpreta isso como "usuário sem chave" → `No Gemini key configured for user r9345302@gmail.com` → pula o projeto e reagenda para o dia seguinte. Nada do pipeline (roteiro, voz, visuais, thumbnail, upload) chega a rodar. O modo manual funciona porque no navegador as chaves vêm do localStorage criptografado, não do banco.

**Causa raiz #2 — CONFIRMADA.** `autopilot_logs.user_email` é `NOT NULL` no banco real, mas nem `bootstrap.sql` nem o runner conhecem essa coluna → **todo log remoto é rejeitado** (`null value in column "user_email" ... violates not-null constraint`). Por isso o Scheduler e o painel de saúde ficaram cegos.

**Causa raiz #3 — CONFIRMADA.** `project_auth` não tem `token_status`, `token_checked_at` nem `token_error`, mas `AutomationHealth.tsx` e o runner consultam essas colunas → a checagem "Canais do YouTube" sempre reporta desconectado, mesmo com refresh token válido (as duas linhas de `project_auth` têm `tem_refresh = true`).

**Achado extra:** há **duas linhas em `project_auth` para o mesmo canal "Biblical Investor"**, uma com `token_expires_at` de 2026-08-01 (vencida) e outra de 2026-08-07. Se o runner ler a linha errada, tenta refresh com token velho. O plano passa a ordenar por `updated_at desc` ao ler o token.

**OAuth:** você confirmou app "In production", então expiração de refresh token em 7 dias **não** é o problema. Melhorar a mensagem de `invalid_grant` fica como prioridade baixa.

## Passo 2 — Correções

### Fase A — Desbloquear a automação (prioridade máxima)
1. `loadUserKeys()`: capturar e logar `error` explicitamente, normalizar o e-mail (`trim().toLowerCase()`), e tentar `ilike` no e-mail como segunda tentativa. Se a query falhar, o log diz "falha ao ler user_settings: <msg>" em vez de "sem chave".
2. Quando não houver chave: em vez de reagendar para o dia seguinte, gravar log de erro claro e manter `nextScheduledRun` próximo (retry curto), para não perder um dia inteiro por um problema de leitura.
3. `Settings.tsx`: tratar e exibir o `error` do `upsert` em `user_settings` (hoje pode falhar sem o usuário saber) e salvar o e-mail normalizado.

### Fase B — Schema canônico (`supabase/bootstrap.sql`)
4. Adicionar em `project_auth`: `token_status text`, `token_checked_at timestamptz`, `token_error text`.
5. Reconciliar `autopilot_logs.user_email`: adicionar a coluna no bootstrap (nullable) e, se existir com NOT NULL, remover a constraint (`alter column user_email drop not null`), mantendo o bootstrap idempotente e como fonte única da verdade.
6. Runner: passar `user_email` em todos os inserts de `autopilot_logs`.
7. `AutomationHealth.tsx`: tratar `error` em todas as queries e mostrar "Falha ao verificar: <mensagem>" em vez de assumir "desconectado".

### Fase C — Timeouts (a classe de bug que já voltou 3×)
8. Criar um helper único de timeout reutilizável em cada lado (`raceTimeout` no runner; `withTimeout` compartilhado no frontend) e aplicar em:
   - runner: `geminiGenerate()` e `geminiTTS()` (`axios.post` sem `timeout` hoje) → `timeout` no axios + race; roteiro/ideia/metadados 90s, TTS por segmento 60s.
   - `src/services/geminiCore.ts`: `ttsOnce()` → race de 60s por segmento.
   - Em timeout: erro explícito que aciona retry/standby, nunca pendurar até os 120 min do job.
9. Varredura final: todas as chamadas Gemini/Pexels/YouTube em `scripts/automation-runner.js` e `src/services/*.ts` passam a usar o helper — sem exceção.

### Fase D — Modelo de imagem de cena
10. `src/services/geminiThumbnail.ts`, `generateSceneImage`: trocar `sceneModels = ['gemini-2.0-flash-exp','gemini-2.0-flash']` (não retornam imagem) pela mesma lista `IMAGE_MODELS` (`gemini-2.5-flash-image`, `gemini-2.0-flash-preview-image-generation`).

### Fase E — Limpeza
11. Deletar a pasta `pages/` da raiz (órfã; `src/App.tsx` importa de `src/pages`).
12. `.github/workflows/deploy.yml`: remover a dependência de `build-and-deploy` em `supabase-deploy` (site deixa de ficar refém) e documentar `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_URL` no `SETUP.md`.
13. `YoutubeReconnectBanner.tsx`: mensagem específica quando `invalid_grant` repetir logo após reconexão.

## O que você precisa fazer depois
- Rodar o `supabase/bootstrap.sql` atualizado uma vez no SQL Editor (Fase B).
- Reabrir Configurações e salvar as chaves Gemini/Pexels novamente, para garantir a linha em `user_settings` com o e-mail normalizado.
- Disparar o workflow Auto-Post manualmente e conferir se avança além da etapa de ideia.

## Validação
- Log do Actions passa de "No Gemini key" e chega a "Enviando vídeo para o YouTube" com URL.
- `autopilot_logs` volta a receber linhas (sem erro de `user_email`).
- "Saúde da Automação" mostra o canal como conectado quando está, e erro de query quando houver.
