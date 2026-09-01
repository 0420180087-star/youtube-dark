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

### 7. "Executar Agora" (semiautomático) deve gerar igual ao automático
Hoje o botão roda `runAutomationPipeline` dentro da aba: os passos são os mesmos do runner, mas a montagem final é outra engine — Canvas + MediaRecorder gerando **WebM**, sem crossfade cumulativo, sem loop de clipe curto e sem o mix de música a 15% do FFmpeg. Resultado: o vídeo do "Executar Agora" sai diferente (e pior) do que o do automático.

Também confirmei que os ativos pesados nunca sobem para o banco: `ProjectContext` troca `audioUrl` por `__has_audio__`, thumbnails/imagens de IA em `data:` por marcadores, e o runner faz o mesmo com `lightVideoRecord`. Ou seja, não existe como o navegador gerar a narração/visuais e "entregar" os arquivos ao runner — quem renderiza precisa ter gerado os ativos.

Correção: transformar o "Executar Agora" em **execução na nuvem**, com o runner sendo o único produtor do vídeo final.
- O clique passa a enfileirar o projeto para execução headless imediata: `scheduleSettings.nextScheduledRun = agora`, marcador `forceRun` (para o runner ignorar janela de horário e cooldown de cota quando for um pedido explícito do usuário) e limpeza do lock obsoleto.
- A UI mostra o estado real da fila em vez de barra de progresso local: "na fila", "rodando (passo X)", "publicado", lendo `autopilot_logs` + `automation_heartbeat` em tempo real, com o mesmo rótulo de passos (`STEP_LABELS`) já usado hoje.
- Enquanto o cron de 15 min não pegar o item, a UI diz explicitamente quando a próxima varredura acontece. Opcionalmente (se o usuário salvar um token do GitHub nos secrets) o app dispara o `workflow_dispatch` com o `project_id` para começar em segundos em vez de minutos.
- O pipeline local (`runAutomationPipeline` no navegador) deixa de ser o caminho do botão. Ele continua existindo para o **editor passo a passo**, que segue permitindo gerar/prever/baixar localmente — só não é mais o que publica.

Assim o vídeo publicado é sempre o MP4 do FFmpeg, com as mesmas transições, durações de mídia e mix de áudio, venha o pedido do cron ou do botão.

## Detalhes técnicos

- `scripts/automation-runner.js`: reordenar o bloco de gate (lock → chaves → vídeo retomável → cota condicional); `renewLock(projectId)` chamado entre passos; `writeHeartbeat` por passo; guarda de idempotência no upload; ordenação e time budget em `main()`; respeitar `forceRun` (ignora janela/cota e limpa a marca ao concluir).
- `.github/workflows/auto-post.yml`: `npm ci`, `timeout-minutes` alinhado ao lock.
- `src/context/ProjectContext.tsx` / `src/pages/ProjectHub.tsx` (botão Executar Agora): trocar a chamada de `runAutomationPipeline` por `enqueueHeadlessRun(projectId)` (update em `projects.data.scheduleSettings` + release de lock) e assinar `autopilot_logs` do projeto para o progresso.
- `src/components/AutomationHealth.tsx`: exibir passo/projeto atual do heartbeat em vez de só a idade do sinal.
- `src/services/automationService.ts`: sem mudança de lógica; permanece como engine do editor manual.
- Sem mudança de schema: `automation_heartbeat.detail`, `autopilot_logs` e os campos de vídeo já existem; `forceRun` vive no JSON de `projects.data`.

## Fora de escopo

Nada de mudança no motor de visuais, render ou prompts — o alvo aqui é confiabilidade do orquestrador headless e fazer o botão "Executar Agora" usar exatamente esse mesmo motor.

