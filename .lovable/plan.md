# Fechar os últimos furos da automação headless

O runner já cobre o fluxo inteiro (ideia → roteiro → voz → visuais → thumbnail → metadados → render → upload) com retomada por passo, rotação de chaves Gemini, memória de cota entre execuções e auto-login por refresh token. O que sobra são falhas de borda que aparecem justamente quando "pega quase 100%". Abaixo o que confirmei lendo o código, e o que corrigir.

## O que já está sólido (confirmado)

- Persistência incremental a cada passo (`updateRunnerVideo`), então uma queda no meio não perde trabalho.
- Cota Gemini: cooldown por chave, rotação, eventos gravados em `automation_quota_events` e teto de 12 reagendamentos / 48 h.
- YouTube: checagem de token antes de gastar compute; vídeo pronto fica `SCHEDULED` com "Upload pendente" e publica sozinho depois da reconexão.
- Thumbnail nunca derruba o pipeline (falha do `uploadThumbnail` é apenas logada).
- Segredos sensíveis (`project_auth`, `user_settings`) fora do alcance do navegador, acessados via Edge Function `user-data`.

## Problemas a corrigir

### 1. Vídeo pendente de upload fica preso por cota do Gemini
Em `processProject`, o circuit breaker `recentQuotaExhaustion` roda **antes** de olhar se existe vídeo apenas aguardando upload. Publicar um vídeo já renderizado não usa Gemini nenhum, mas a execução é abortada.
Correção: mover a checagem de cota para depois de identificar o vídeo retomável; se o vídeo retomável for "Upload pendente" (ou qualquer retomada que só precise de upload), seguir mesmo em cooldown de cota.

### 2. Lock pode expirar com o job ainda rodando (risco de vídeo duplicado)
O lock é de 90 min e o job do workflow tem timeout de 120 min. Projetos longos (render + upload) podem passar dos 90 min: o lock cai, a execução seguinte pega o mesmo projeto e gera/publica de novo.
Correção: renovar o lock periodicamente (a cada ~5 min) enquanto o projeto processa, e reduzir o timeout do job para caber dentro da janela do lock.

### 3. Duplicata quando o upload dá certo mas a gravação falha
Se `updateRunnerVideo` não conseguir gravar o `PUBLISHED` (erro de rede no Supabase), o vídeo continua retomável e é re-renderizado e re-enviado — vídeo repetido no canal.
Correção: gravar o `youtubeUrl`/`videoId` imediatamente após o upload com retentativa própria, e antes de fazer upload de uma retomada verificar se aquele vídeo já tem `youtubeUrl` (nesse caso apenas concluir).

### 4. Heartbeat fica velho durante execuções longas
O heartbeat só é escrito no começo e no fim do ciclo. Um render de 40 min faz o painel "Saúde da Automação" acusar "sem sinal há 40 min" mesmo com tudo funcionando.
Correção: escrever heartbeat a cada passo do pipeline (com projeto e passo atual no `detail`), e ajustar o texto do painel para refletir isso.

### 5. Ordem e orçamento de tempo entre projetos
Os elegíveis são processados na ordem que o banco devolveu, sem limite de tempo por projeto. Com vários projetos, o primeiro pode consumir o job inteiro e os outros nunca rodam.
Correção: ordenar por `nextScheduledRun` mais antigo primeiro e parar o laço quando restar pouco tempo de job, deixando os demais para o próximo cron (eles continuam elegíveis).

### 6. Workflow: dependências não determinísticas
`auto-post.yml` usa `npm install` mesmo existindo `package-lock.json`, o que pode trazer versão diferente da testada em cada execução.
Correção: usar `npm ci` (com `npm install` só como fallback se o lock divergir).

## Detalhes técnicos

- `scripts/automation-runner.js`: reordenar o bloco de gate (lock → chaves → vídeo retomável → cota condicional); `renewLock(projectId)` chamado entre passos; `writeHeartbeat` por passo; guarda de idempotência no upload; ordenação e time budget em `main()`.
- `.github/workflows/auto-post.yml`: `npm ci`, `timeout-minutes` alinhado ao lock.
- `src/components/AutomationHealth.tsx`: exibir passo/projeto atual do heartbeat em vez de só a idade do sinal.
- Sem mudança de schema: `automation_heartbeat.detail` e os campos de vídeo já existem.

## Fora de escopo

Nada de mudança no motor de visuais, render ou prompts — o alvo aqui é só confiabilidade do orquestrador headless.
