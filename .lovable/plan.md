## Diagnóstico confirmado

Verifiquei no código antes de planejar:

- `supabase/migrations/` tem 5 arquivos (001→005) que o `SETUP.md` **não menciona**. O SQL do guia cria apenas `projects` e `autopilot_logs`.
- `scripts/automation-runner.js` depende de `user_settings` (linha ~68), `project_auth` (~765) e do RPC `acquire_autopilot_lock` (~924). Sem eles, falha antes de gerar qualquer coisa.
- `src/context/ProjectContext.tsx:682` cria projeto com `autoGenerate: false`.
- O runner grava `status: 'STANDBY'` (linha ~1108) e **nunca** reprocessa — não existe campo de tentativa nem seleção de vídeos em standby.

Ou seja: a causa raiz nº1 é ambiente/schema, não lógica de pipeline. As causas 2–5 são decisões de design que exigem intervenção humana.

---

## Fase 1 — Schema canônico e à prova de erro (elimina causa 1)

1. Criar `supabase/bootstrap.sql`: um único script idempotente que consolida 001→005 (tabelas `projects`, `project_auth`, `user_settings`, `autopilot_logs`, GRANTs, RLS e os RPCs de lock). Rodar duas vezes não quebra nada.
2. Reescrever o `SETUP.md` para mandar colar **apenas** esse arquivo, removendo o SQL parcial atual e listando explicitamente os secrets obrigatórios vs. opcionais.
3. **Preflight no runner**: antes de processar projetos, verificar existência de cada tabela/RPC. Se algo faltar, imprimir um bloco de erro único e acionável (`Rode supabase/bootstrap.sql — falta: user_settings, acquire_autopilot_lock`) em vez de falhar de forma confusa por projeto.
4. **Degradação em vez de travamento**: se o RPC de lock não existir, cair para lock por coluna (`UPDATE ... WHERE autopilot_locked_until IS NULL`), que já existe no schema. Se `user_settings` não existir, usar as chaves do env. O runner passa a rodar mesmo em schema incompleto.
5. Fase de diagnóstico na UI: card "Saúde da Automação" no Scheduler mostrando schema OK/faltando, chaves presentes, refresh token do YouTube, último heartbeat do runner.

## Fase 2 — Auto-retry de falhas (elimina causa 3)

1. Adicionar ao vídeo: `retryCount`, `lastError`, `nextRetryAt`.
2. Quando uma etapa falha, o vídeo vai para `STANDBY` **com** `nextRetryAt = agora + backoff` (5 min → 20 min → 1 h → 4 h, máx. 4 tentativas).
3. O runner, a cada ciclo de 15 min, antes de gerar ideia nova, coleta vídeos em `STANDBY` com `nextRetryAt <= agora` e **retoma da etapa que falhou** (script/voz/visual/render/upload já são idempotentes por artefato salvo — não regera o que já existe).
4. Esgotadas as tentativas, marca `STANDBY` definitivo com motivo legível, e só então exige ação humana.

## Fase 3 — Autopilot ligado por padrão (elimina causa 4)

1. Mudar o default de criação de projeto para `autoGenerate: true`, com janela 12:00–18:00 e frequência diária (valores já usados hoje).
2. Banner no ProjectHub quando o autopilot estiver desligado, com botão de ativar em um clique.
3. O log "pulado: autoGenerate não está ativado" passa a ser agregado numa linha só, para não poluir o log do Actions.

## Fase 4 — Resiliência do OAuth do YouTube (mitiga causa 2)

Renovar um refresh token revogado sem o usuário é tecnicamente impossível — o Google exige consentimento. O que dá para automatizar:

1. **Detecção proativa**: a cada ciclo, o runner testa o refresh token e grava a validade em `project_auth`. Se estiver quebrado, avisa **antes** de gastar 10 minutos gerando um vídeo que não poderá ser postado.
2. Vídeo pronto mas sem token válido → fica em `SCHEDULED` (pronto para postar), não em `STANDBY`, e é postado automaticamente no primeiro ciclo após a reconexão. Nenhum trabalho é perdido.
3. Banner de reconexão sempre visível (o `YoutubeReconnectBanner` já existe) alimentado por esse status remoto, não só pelo localStorage.
4. Aviso explícito no SETUP.md: app OAuth em modo *Testing* no Google Cloud faz o token morrer em 7 dias — publicar em produção é requisito para o modo liga-e-esquece.

## Fase 5 — Motor único (elimina causa 5)

1. O GitHub Actions passa a ser o motor canônico. O `setInterval` do navegador deixa de disparar execuções automáticas; fica só o botão "Executar Agora" manual.
2. O runner grava heartbeat em cada ciclo; o Scheduler alerta em amarelo se não houver sinal há mais de 60 min (indica secrets ausentes no repo).
3. Cron de 15 min mantido, com o lock distribuído protegendo execuções sobrepostas.

---

## Detalhes técnicos

- Arquivos: `supabase/bootstrap.sql` (novo), `SETUP.md`, `scripts/automation-runner.js`, `src/services/automationService.ts`, `src/context/ProjectContext.tsx`, `src/pages/Scheduler.tsx`, `src/pages/ProjectHub.tsx`, `src/types.ts`.
- Nenhuma mudança na qualidade de geração: prompts, modelos, parâmetros de TTS, render e cascatas de fallback visual ficam intactos. O retry retoma de artefatos já salvos, sem regerar.
- Novos campos vão em colunas com `add column if not exists`, sem migration destrutiva.
- Ação manual que continua necessária: rodar o `bootstrap.sql` uma vez, preencher os secrets do repositório e publicar o app OAuth no Google Cloud. Depois disso, o fluxo roda sem intervenção.

## Validação

1. `node --check` nos scripts e build do frontend.
2. Simular schema incompleto e confirmar que o preflight dá mensagem única e acionável em vez de travar.
3. Forçar falha na etapa de voz e confirmar que o ciclo seguinte retoma do ponto exato, sem regerar roteiro.
4. Revogar token do YouTube e confirmar que o vídeo termina em `SCHEDULED` e sobe sozinho após reconectar.
