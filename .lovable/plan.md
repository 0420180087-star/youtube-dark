# Correção completa — segurança, concorrência e confiabilidade

## Fase 0 — Diagnóstico (o que já foi confirmado agora)

Verificado por leitura de código/SQL neste turno:

- `supabase/bootstrap.sql` já cria `token_status`, `token_checked_at`, `token_error` em `project_auth` (linhas 28 e 69). Se o painel ainda reporta erro, é porque o bootstrap **não foi executado** no banco atual — não porque falta no repositório.
- Todas as policies são `for all using (true) with check (true)` e há `grant select, insert, update, delete ... to anon, authenticated` em **todas** as tabelas, incluindo `project_auth` e `user_settings`. A exposição descrita é real.
- `src/context/ProjectContext.tsx:538` faz `release_autopilot_lock` incondicional antes de retentar o `acquire` — o force-release existe.
- `src/services/geminiThumbnail.ts:490` ainda usa `['gemini-2.0-flash-exp','gemini-2.0-flash']` em `sceneModels`.
- `scripts/automation-runner.js` já tem `raceTimeout` + `NET_TIMEOUT.TEXT/TTS` aplicados em `geminiGenerate`/`geminiTTS`; a varredura restante ainda precisa ser fechada.
- A pasta `pages/` na raiz **já não existe** (nada a deletar).
- Não existe nenhum arquivo de teste no projeto.

Confirmado pelos dados que você trouxe:

- **A causa real das falhas de hoje é 429 do Gemini no passo `script`**, não YouTube nem OAuth. Foram 4 tentativas (17:20 → 20:10 de 08/08), todas `Request failed with status code 429`, até "aguardando ação manual". O vídeo nunca passou do roteiro — por isso nada é publicado.
- OAuth está "In production" (refresh_token não expira em 7 dias) e a cota da YouTube Data API está em 0 (pico 51 unidades). **Nenhuma das duas hipóteses é o problema** — a Fase 3, item 4 (cota do YouTube) passa a ser prevenção, não correção urgente.
- A execução manual do runner terminou com "1 projeto(s), 0 elegível(is)" porque `nextRun=2026-08-09T16:17` ainda está no futuro. Comportamento correto, mas hoje não há como forçar um projeto específico ignorando o agendamento.

## Fase 0.5 — Desbloquear o 429 do Gemini (nova prioridade máxima)

Isto é o que impede a publicação hoje; vem antes da Fase 1.

- `scripts/automation-runner.js`: tratar 429 como classe própria em `geminiGenerate`/`geminiTTS`/`geminiGenerateImage` — ao receber 429, marcar a chave como "esfriando" e **rotacionar imediatamente** para a próxima chave de `gemini_api_keys` antes de contar como tentativa; só falha o passo quando todas as chaves estiverem em cooldown.
- Respeitar o `retryDelay` que o Gemini devolve no corpo do erro (`RetryInfo`) em vez do backoff fixo, e não consumir uma das 4 tentativas do vídeo quando o erro for exclusivamente 429.
- Quando todas as chaves estiverem em 429, reagendar o vídeo em ~1h com mensagem explícita ("cota Gemini esgotada — retomando às HH:MM") em vez de "aguardando ação manual" após 4 tentativas.
- Mesma lógica de rotação/cooldown em `src/services/geminiCore.ts` para o modo manual no navegador.
- `AutomationHealth.tsx`: novo check "Cota Gemini" mostrando quantas chaves estão em cooldown e o último 429 registrado.
- Runner: quando `PROJECT_ID` for passado no `workflow_dispatch`, ignorar `nextRun` e forçar a execução daquele projeto (hoje ele reporta "0 elegíveis" e não há como testar sob demanda).


## Fase 1 — Segurança crítica

- `supabase/bootstrap.sql`: `revoke all on public.project_auth, public.user_settings from anon, authenticated`, remover suas policies permissivas e manter acesso apenas por `service_role`. `projects`/`autopilot_logs`/`user_profiles` seguem permissivos (dívida técnica registrada em comentário no topo do arquivo).
- Nova Edge Function `user-data` (service role) com ações: ler/gravar `user_settings` do e-mail informado e ler o status de token de `project_auth` (retornando **apenas** `token_status`, `token_error`, `youtube_channel_title` e um booleano `has_refresh_token` — nunca os tokens).
- Trocar os acessos diretos do navegador por essa função: `src/pages/Settings.tsx` (leitura e upsert de `user_settings`), `src/components/AutomationHealth.tsx` (chaves + canais), `src/context/ProjectContext.tsx:830` (delete de `project_auth` ao excluir projeto → nova ação `delete_project_auth`).
- `refresh-token`: passa a exigir cabeçalho `Authorization` com o `id_token` do Google já obtido no login, validado contra `https://oauth2.googleapis.com/tokeninfo`, e o e-mail usado é o do token — não o do corpo. Mesmo tratamento em `exchange-code`. Sessão opaca própria e criptografia dos tokens em repouso ficam documentadas como próximo passo no `SETUP.md`.

## Fase 2 — Concorrência e integridade

- `ProjectContext.tsx`: remover o force-release; ao falhar o `acquire`, abortar com mensagem clara ("execução já em andamento em outro runner"), como o runner já faz.
- `scripts/automation-runner.js`: marcador de idempotência antes do upload (`uploadStartedAt` + `youtubeVideoId` persistidos no vídeo). No início de `stepUploadYouTube`, se já houver `youtubeVideoId`, pular o envio e só concluir. A escrita pós-upload (`status: 'PUBLISHED'`) ganha retry agressivo (5 tentativas com backoff) e, se falhar, log destacado `MANUAL_INTERVENTION_REQUIRED` sem reenvio automático.

## Fase 3 — Confiabilidade do pipeline

- `AutomationHealth.tsx`: tratar o `error` da query de canais (via nova Edge Function) e mostrar "Falha ao verificar: …" em vez de "sem canal válido".
- Fechar a varredura de timeouts: centralizar em um helper único por lado (`raceTimeout` no runner, `withTimeout` em `src/services/`) e aplicar em toda chamada de rede restante de `scripts/*.js` e `src/services/*.ts`.
- `geminiThumbnail.ts`: `sceneModels` passa a usar a mesma lista `IMAGE_MODELS`.
- `scripts/youtubeUploader.js`: detectar `quotaExceeded`/`dailyLimitExceeded` (403) e sinalizar retry só após a virada de cota (meia-noite Pacífico), com mensagem de status explícita em vez de "tentativas esgotadas".

## Fase 4 — Limpeza, deploy e testes

- `pages/` já removida — nada a fazer.
- `.github/workflows/deploy.yml`: remover a dependência do job do site em `supabase-deploy` e documentar `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_URL` no `SETUP.md`.
- `npm audit fix` (apenas correções não-destrutivas).
- Testes de regressão em `src/test/`: (a) varredura estática que falha se alguma chamada de rede do pipeline ficar sem timeout; (b) teste que falha se aparecer `release_autopilot_lock` sem lock próprio confirmado no fluxo de aquisição.

## O que você precisa fazer depois

- Rodar o `supabase/bootstrap.sql` atualizado uma vez no SQL Editor (é o que aplica revoke/colunas).
- Fazer deploy das Edge Functions (`user-data`, `refresh-token`, `exchange-code`).
- Reabrir Configurações e salvar as chaves novamente.
