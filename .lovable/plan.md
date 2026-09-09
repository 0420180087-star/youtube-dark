# Automação: voltar a postar, parar de duplicar e melhorar a execução semiautomática

## O que está confirmado

**Por que parou de postar (confirmado pelo log de hoje):** o runner acha o projeto, ele está elegível, mas a linha de `user_settings` do seu e-mail tem `gemini_api_keys` vazio. O runner então pula sem gerar nada e reagenda para 30 min depois — todo ciclo. O código de Configurações envia as chaves via `user-data`, mas o botão Salvar mostra "salvo" mesmo quando o envio à nuvem falha (o erro fica só no selo), então a falha passou despercebida. Sem acesso ao banco daqui, a causa exata da falha do envio (sessão Google expirada, função `user-data` não publicada, ou conta diferente) precisa ser vista na tela — o plano inclui um teste que mostra isso na hora.

**Por que gerava vídeos duplicados/parecidos (confirmado no código):**
1. Quando o brainstorm da IA falha, o fallback cria ideias com 4 frases fixas ("The Untold Story of <tema>"...). Como esses tópicos já existem no projeto, o filtro os descarta e o runner escolhe `generatedIdeas[0]` — um tópico já usado → vídeo repetido.
2. O prompt de ideias só manda "evite estes tópicos"; não há verificação de similaridade depois, então a IA devolve variações do mesmo assunto.
3. Se o job do GitHub morre sem passar pelo `catch` (timeout de 120 min, falta de memória), `nextScheduledRun` continua no passado e o vídeo fica em DRAFT/SCRIPTING sem virar STANDBY. No próximo tick (15 min) o runner cria um vídeo novo em vez de retomar o órfão.
4. "Executar agora" no navegador dispara o pipeline local **e** enfileira o headless (`nextScheduledRun = agora`), além de liberar à força qualquer lock com mais de 15 min. Um clique pode gerar dois vídeos.

**Regressão recente:** o commit "Refactor audio processing and thumbnail generation" (8/set) removeu do pipeline do navegador o retry da música (agora uma falha na música derruba o vídeo inteiro) e a aceleração da narração (o controle de velocidade no projeto não faz mais efeito no navegador).

## Fase 0 — Voltar a postar hoje (sem código)
- Adicionar `GEMINI_API_KEY` (e `PEXELS_API_KEY`) nos Secrets do repositório GitHub. O runner já usa esses valores quando `user_settings` está vazio. Rodar o workflow manualmente para confirmar que passa da etapa de ideia.

## Fase 1 — Chaves realmente na nuvem
- Configurações: Salvar só mostra "salvo" se a leitura de volta da nuvem confirmar as chaves; caso contrário mostra erro em destaque com o motivo (sessão expirada / função indisponível / e-mail diferente do dono do projeto).
- Botão "Testar o que a automação vê": chama a leitura da nuvem e mostra "N chaves para <e-mail>" — mesma consulta que o runner faz.
- Em erro 401, abrir automaticamente a renovação da sessão Google (interativa) e repetir o envio.
- Saúde da Automação: o check de chaves passa a mostrar o e-mail consultado e a contagem, igual ao runner.

## Fase 2 — Nunca mais duplicar
- Ideias: fallback com variação real (seed + ângulo + número) e regra dura: nunca escolher tópico já existente; filtro de similaridade por palavras (rejeita >60% de sobreposição com títulos anteriores/publicados). Se não sobrar ideia inédita, entra em STANDBY curto em vez de gravar duplicata.
- Retomar órfãos: `findRetryableVideo` passa a considerar vídeos em DRAFT/SCRIPTING/AUDIO_GENERATED/VIDEO_GENERATED sem lock ativo como retomáveis (reaproveita roteiro/áudio/visuais já salvos) em vez de criar vídeo novo.
- Lock renovado a cada etapa (heartbeat) para não expirar no meio de um render longo; `nextScheduledRun` é avançado no início da execução (claim) e recalculado no fim.
- "Executar agora": ou roda local ou enfileira headless — nunca os dois; só libera lock realmente vencido; `nextScheduledRun` futuro é gravado antes de iniciar.
- Scheduler mostra vídeos órfãos/em andamento com botão "Retomar" ou "Descartar".

## Fase 3 — Execução semiautomática
- **Retomar:** botão "Retomar" em qualquer vídeo parado, reaproveitando as etapas já concluídas; render e upload separados, com o vídeo renderizado guardado localmente (IndexedDB) para reenviar sem re-renderizar.
- **Cancelar / refazer etapa:** botão Cancelar (aborta chamadas em andamento e libera o lock) e botões "Refazer voz", "Refazer visuais", "Refazer thumbnail", "Refazer descrição" por vídeo.
- **Visibilidade:** painel de etapas com tempo decorrido, etapa atual, último erro e histórico; o pipeline do navegador passa a gravar em `autopilot_logs` (runner = "browser"), aparecendo no Scheduler como o do GitHub.
- **Thumbnails temáticas:** antes de compor, o Gemini gera um briefing específico do vídeo (cena-chave, emoção do rosto, gancho de 2–4 palavras, paleta, elemento de destaque) a partir do roteiro; a imagem é gerada por esse briefing (modelo de imagem) e composta com um frame real do vídeo e o gancho. Mesmo caminho no navegador e no runner, respeitando as regras já definidas (máx. 4 palavras, emoção extrema, barra de progresso).
- **Restaurar o que a regressão removeu:** retry da música com fallback "segue sem música" e aceleração da narração conforme o controle do projeto, no navegador e no runner.

## Detalhes técnicos
- `scripts/automation-runner.js`: `stepIdea` (fallback + similaridade + recusa de duplicata), `findRetryableVideo` (estados intermediários órfãos), `acquireLock`/renovação por etapa, claim de `nextScheduledRun` no início de `processProject`, thumbnail com briefing.
- `src/context/ProjectContext.tsx`: `triggerAutoPilotNow` (modo único, sem liberação forçada de lock, agenda antes de iniciar), `cancelAutoPilot` via `AbortController`, log remoto do navegador.
- `src/services/automationService.ts`: aceitar `AbortSignal`, passos reexecutáveis isoladamente, render/upload separados, música com retry, `narrationSpeed` de volta.
- `src/services/geminiThumbnail.ts` (+ equivalente no runner): `generateThumbnailBrief` e uso no `generateComposedThumbnail`.
- `src/pages/Settings.tsx`, `src/components/AutomationHealth.tsx`: estado de sync verdadeiro, botão de teste, renovação interativa em 401.
- `src/pages/Scheduler.tsx` / `ProjectHub.tsx`: painel de etapas, botões Retomar/Cancelar/Refazer/Descartar.
- Sem alteração de schema.

## Validação
- Log do Actions passa de "Nenhuma chave" até "Publicado: <URL>".
- Forçar falha do brainstorm e confirmar que não sai vídeo com título repetido.
- Matar o job no meio e confirmar que o próximo tick retoma o mesmo vídeo.
- "Executar agora" gera exatamente um vídeo; Cancelar interrompe e libera o lock.
