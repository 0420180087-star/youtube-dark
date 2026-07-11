- Diagnóstico honesto (causa raiz)

Olhando a imagem e o código:

1. Sempre que você clica **"Executar Agora"**, `triggerAutoPilotNow` só faz:
  - upsert do projeto no Supabase com `nextScheduledRun` no passado
  - insere um log "Execução enfileirada"
  - **retorna sem executar nada no navegador**
   Ou seja: se o GitHub Actions não estiver configurado no seu repositório (secrets, workflow ativo, cron rodando de fato), **ninguém pega a fila** — e o botão só empilha logs "Execução enfileirada" a cada clique.
2. O log "Lock não obtido: outro runner está processando este projeto" de 22:01 mostra que uma execução anterior **deixou `autopilot_locked_until` preso no Supabase**. Como o lock dura até 90 min e não há como você liberar pela UI, qualquer tentativa nova (local ou headless) é ignorada.
3. Não há sinal na UI de que o GitHub Actions realmente rodou (nenhum log com `runner: github-actions` vindo do servidor). Isso reforça que o runner headless não está processando.

## O que vamos consertar

### 1. `ProjectContext.triggerAutoPilotNow` — executar de verdade

- **Não bloquear** o botão só porque enfileirou. O enfileiramento remoto vira **best-effort em paralelo** (fire-and-forget) e a execução local começa imediatamente na mesma chamada.
- Antes de rodar, se `autopilotLockedUntil` estiver preso e passou mais de **15 minutos** desde `updated_at`, considerar stale e liberar via `release_autopilot_lock` no Supabase (o RPC já existe).
- Deduplicar log: se o último log for "Execução enfileirada" do mesmo projeto nos últimos 10s, não adicionar outro.

### 2. Botão "Liberar lock" no card do projeto (Scheduler)

- Quando `autopilotLockedUntil` estiver no futuro, mostrar botão pequeno "Liberar lock" ao lado de "Executar Agora".
- Chama `supabase.rpc('release_autopilot_lock', { p_project_id })` e limpa `autopilotLockedUntil` local.
- Assim você nunca mais fica bloqueado 90 min esperando.

### 3. Sinal claro do runner headless

- No card, mostrar "Runner headless: nunca visto" quando não há nenhum log remoto com `runner = 'github-actions'` nos últimos 60 min. Aviso curto: "Executando somente no navegador. Configure GitHub Actions para rodar com a página fechada."
- Isso torna transparente por que a "fila" nunca é consumida quando o Actions não está ativo.

### 4. Estado do botão

- `isRunning` reflete apenas `isRunningAutomation.current` (execução local real), não "enfileirou remotamente". Botão volta a `Idle` imediatamente após o enqueue best-effort se a execução local também não iniciar (ex.: falta de chave Gemini) — com toast explicando o motivo real em vez de deixar preso.

## Arquivos que serão editados

- `src/context/ProjectContext.tsx` — reescrever `triggerAutoPilotNow`, deduplicar `addLogEntry`, liberar lock stale, disparar local + headless em paralelo.
- `src/pages/Scheduler.tsx` — botão "Liberar lock", aviso "runner headless nunca visto", ajustar rótulos.
- (Sem mudanças no runner do GitHub nem no SQL — o RPC `release_autopilot_lock` já existe.)

## Limitação transparente

- Execução local só continua enquanto a aba estiver aberta. É por isso que mantemos o enqueue headless em paralelo — se o GitHub Actions estiver ativo, ele conclui mesmo com a página fechada.
- Se o Actions não estiver ativo/configurado, o app agora diz isso claramente em vez de fingir que enfileirou algo que nunca será processado.

## Validação após implementar

1. Clicar "Executar Agora" com lock preso → lock é liberado, execução local começa, botão vira "Executando local…".
2. Clicar sem lock → pipeline local roda visivelmente (barra de progresso na parte de cima do Scheduler).
3. Se GitHub Actions estiver configurado, log remoto `[github-actions]` aparece em minutos e o aviso "nunca visto" desaparece.
4. Log deixa de ser spammado com "Execução enfileirada" idênticos.