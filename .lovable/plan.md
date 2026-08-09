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

Sobre os dados que você trouxe:

- O "429 no passo `script`" veio das **mensagens de erro que você colou/mostrou** (4 tentativas de 17:20 → 20:10 de 08/08, `Request failed with status code 429`). Eu **não consultei `autopilot_logs`** — não tenho acesso ao seu banco daqui. Então isso é evidência sua, não verificação minha. Primeiro item da Fase 0.5 é justamente confirmar no banco antes de qualquer código.
- OAuth "In production" e cota da YouTube Data API em 0 (pico 51 unidades) também são leituras suas — trato como corretas e a cota do YouTube segue como prevenção, não urgência.
- O log foi "1 projeto(s) encontrados, 0 elegível(is)": encontrou 1, filtrou 1. Como `if (PROJECT_ID) return true` (linha 1730) **já bypassa autoGenerate/nextRun**, o resultado indica que o run **não recebeu `project_id`** — não que o filtro esteja errado. Nada a mudar na elegibilidade; ver Fase 0.5 item 6.

## Fase 0.5 — Desbloquear o 429 do Gemini (prioridade máxima)

Correções confirmadas por leitura do código neste turno:

- `rotateGeminiKey()` (linha 190 do runner) **nunca é chamado** — o runner carrega N chaves de `gemini_api_keys` e usa só a primeira para sempre. É por isso que um 429 derruba o passo inteiro mesmo com várias chaves salvas.
- `geminiWithRetry` (linha 361) detecta quota só por `status===429 || mensagem contém "quota"`, espera 30s/60s fixos e **não troca de chave**.
- `geminiGenerateImage` (linha 394) **não passa por `geminiWithRetry`**: tem loop próprio imagen-3 → `FLASH_MODELS`, sem rotação de chave e sem qualquer tratamento de 429.
- `geminiCore.ts` (navegador) já tem tudo isso resolvido: `isQuotaError` (92), `getCooldownMs` (132) com distinção 503=15s / diária=30min / por-minuto=65s, `keyCooldowns` + `isKeyReady` + `cooldownKey`, `getKeysStatusSummary`.

Itens:

1. **Portar** (não reinventar) a lógica de `geminiCore.ts` para o runner: `isQuotaError`, `getCooldownMs`, mapa `keyCooldowns` por chave, `isKeyReady`. Mesmos limiares (503→15s, diária→30min, por-minuto→65s) e leitura de `retry-after`/`RetryInfo` quando presente.
2. `geminiWithRetry`: em quota, colocar a chave atual em cooldown e **rotacionar para a próxima chave pronta** (ativando de fato `rotateGeminiKey`) antes de contar tentativa; só falha quando **todas** estiverem em cooldown.
3. Ao falhar por todas em cooldown, reagendar o vídeo usando o **menor cooldown restante** (regra do `getCooldownMs`, não 1h fixo): por-minuto → minutos; diária → ~30min/próxima virada. Status explícito "cota Gemini esgotada — retomando às HH:MM".
4. **`geminiGenerateImage` — implementação separada** dos itens 1-3: envolver cada tentativa de modelo no mesmo wrapper de cooldown/rotação, preservando o fallback imagen-3 → `FLASH_MODELS` e sem tratar 403/400/404 como quota.
5. **Teto para não consumir tentativa em 429**: contador `quotaSkips` + janela de tempo por vídeo (máx. 48h desde `firstQuotaAt` ou 12 skips). Ao estourar o teto, o vídeo volta ao fluxo normal de falha ("cota insuficiente — ação manual"), evitando retry infinito silencioso.
6. **Não** mexer no filtro de elegibilidade. Em vez disso: log explícito quando `PROJECT_ID` estiver vazio no `workflow_dispatch` e mensagem separando "encontrados=0" (query/id não bateu) de "elegíveis=0" (agendamento), para o próximo teste sob demanda ser conclusivo.
7. `geminiCore.ts`: **nenhuma duplicação**. Só o que falta lá é persistir o evento de quota (item 8).
8. **Persistência de eventos de cota**: nova tabela `automation_quota_events` (`user_email`, `runner`, `key_masked`, `reason`, `cooldown_ms`, `created_at`) em `supabase/bootstrap.sql`. O runner grava a cada cooldown (o navegador também, best-effort) — é a única forma do painel ver o que aconteceu no GitHub Actions.
9. `AutomationHealth.tsx`: check "Cota Gemini" lendo `automation_quota_events` (últimas 24h) — chaves afetadas, último 429 e runner de origem. `getKeysStatusSummary()` só complementa como estado da aba atual, rotulado como tal.




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
