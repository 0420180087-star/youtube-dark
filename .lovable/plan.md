# Automação de criação e postagem — diagnóstico e correção

## Passo 1 — Evidência levantada

Não tenho acesso ao banco deste projeto (Supabase externo, sem credenciais no sandbox) nem à aba Actions, então a evidência veio do log que você colou + leitura do código.

**Causa raiz #1 (é a que está parando tudo hoje):** o runner encontra o projeto elegível e para em
`No Gemini key configured for user r9345302@gmail.com`. Ou seja: nada do pipeline (roteiro, voz, visuais, thumbnail, upload) chega a rodar. Não é timeout, não é OAuth — é a leitura das chaves.

Em `scripts/automation-runner.js`, `loadUserKeys()` faz `.from('user_settings').select(...)` e **descarta o `error`** (`const { data } = ...`). Se a query falhar (RLS bloqueando a chave usada pelo runner, coluna diferente, e-mail com caixa/espaço diferente, ou linha inexistente porque o save em Configurações falhou em silêncio), o resultado é idêntico a "usuário sem chave": pula o projeto e reagenda para o dia seguinte. Por isso a automação "nunca roda" enquanto o manual funciona (no navegador as chaves vêm do localStorage criptografado, não do banco).

**Causa raiz #2:** `Failed to write autopilot log: null value in column "user_email" of relation "autopilot_logs" violates not-null constraint`. O banco real tem `autopilot_logs.user_email NOT NULL`, e nem `bootstrap.sql` nem o runner conhecem essa coluna → **todo log remoto é descartado**. É por isso que o Scheduler e o painel de saúde não mostram histórico e o diagnóstico ficou cego.

**Causa raiz #3 (confirmada por código, não é o bloqueio atual):** `token_status`, `token_checked_at` e `token_error` não existem em nenhum SQL do repositório, mas são consultados por `AutomationHealth.tsx` e pelo runner → a checagem "Canais do YouTube" sempre reporta desconectado.

**OAuth:** você confirmou app "In production", então expiração de refresh token em 7 dias **não** é o problema. Continua valendo melhorar a mensagem para `invalid_grant`, mas com prioridade baixa.

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
