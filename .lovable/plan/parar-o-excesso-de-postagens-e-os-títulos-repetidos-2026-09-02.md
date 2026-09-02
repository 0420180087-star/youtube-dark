# Parar o excesso de postagens e os títulos repetidos

Dois sintomas, causas distintas — mas ambos vêm do runner headless (`scripts/automation-runner.js`).

## Por que estão sendo postados 3-4 vídeos por dia

O que confirmei lendo o runner:

1. **O horário só é reagendado no fim do trabalho.** `data.scheduleSettings.nextScheduledRun` só é recalculado na linha do passo de render (após ~20-40 min de pipeline) ou no `catch` de erro. Enquanto o pipeline roda, o projeto continua "vencido" no banco. Se o processo morrer no meio (timeout do job, falha de rede na gravação, cancelamento do GitHub Actions), o horário nunca avança e o cron de 15 min pega o mesmo projeto de novo — e cria **outro** vídeo do zero.
2. **Não existe teto de publicações por período.** Nada conta quantos vídeos já foram publicados no dia/frequência. "1 por dia" hoje é apenas uma sugestão de horário, não um limite.
3. **O caminho de retomada ignora o agendamento.** Um vídeo retomável (`findRetryableVideo`) torna o projeto elegível na hora, independente da frequência — com backoff de 5 min a primeira tentativa. Se a falha aconteceu *depois* de o upload ter dado certo (mas antes de gravar `youtubeUrl`), a retomada re-renderiza e **publica de novo** — mesmo título, vídeo duplicado no canal.
4. **Escrita do projeto inteiro com dado velho (lost update).** `persistProjectData` grava o blob `data` lido no começo do ciclo. Se outra gravação (navegador ou execução anterior) alterou `scheduleSettings` no meio, o valor novo é sobrescrito pelo antigo — o projeto volta a ficar vencido.

## Por que os títulos se repetem

1. **Deduplicação frágil.** Em `stepIdea`, ideias novas são filtradas só por igualdade exata (`Set` de `topic`) e **só contra as ideias já salvas** — nunca contra os títulos dos vídeos já publicados (esses entram apenas como dica no prompt). Diferença de maiúscula, acento ou pontuação já passa como "nova".
2. **Fallback determinístico.** Quando o brainstorm da IA falha, o fallback gera literalmente `"The Untold Story of <tema>"`, `"The Hidden Truth Behind <tema>"` — os mesmos títulos toda vez que a IA falha.
3. **Escolha sem saída.** Se todas as 5 ideias geradas já existirem, `chosen = generatedIdeas[0]` — ou seja, escolhe deliberadamente uma repetida em vez de pedir outra rodada.
4. **O título final não é revalidado.** O título do YouTube vem de `stepMetadata` e é gravado sem nenhuma checagem contra os títulos já publicados no projeto.

## Correções

### A. Reserva do slot antes de trabalhar
Assim que um vídeo novo é criado (passo "idea"), gravar imediatamente `nextScheduledRun` para o próximo ciclo (`frequencyDays` + janela de horário) e um `lastPublishAttemptAt`. Se o processo morrer no meio, o projeto **não** volta a ser elegível hoje — o vídeo interrompido é retomado pelo caminho de retry (que não cria vídeo novo), em vez de gerar outro.

### B. Teto real de publicações por período
Antes de criar um vídeo novo, contar os vídeos do projeto com status `PUBLISHED`/`SCHEDULED` (com `youtubeUrl` ou aguardando upload) cujo `updatedAt` cai dentro do período atual (`frequencyDays` a partir do último publicado). Se o teto já foi atingido, registrar log "cota do período já cumprida" e sair sem gastar nada de IA. Retomadas de vídeo existente continuam permitidas — elas não aumentam a contagem.

### C. Gravação de agendamento sem lost update
Ao adquirir o lock, reler a linha do projeto do banco e usar esse `data` fresco como base do ciclo. Para os campos de agendamento, aplicar o valor mais avançado (nunca retroceder `nextScheduledRun`).

### D. Retomada não pode republicar
- Marcar `uploadStartedAt` no vídeo **antes** de chamar o upload.
- Numa retomada em que `uploadStartedAt` existe e `youtubeUrl` não, consultar os uploads recentes do canal (YouTube Data API, `search`/`playlistItems` do canal) procurando o mesmo título; se encontrar, gravar a URL e concluir como publicado — sem novo upload.
- Só quando nada for encontrado é que a retomada refaz o upload.
- Backoff mínimo da primeira retomada subindo de 5 min para ~20 min, para não empilhar tentativas no mesmo dia.

### E. Títulos únicos de verdade
- Criar um normalizador (minúsculas, sem acentos, sem pontuação, espaços colapsados) e um índice de títulos já usados juntando `project.ideas[].topic` + `project.videos[].title` + `videoMetadata.youtubeTitle`.
- Filtrar o lote do brainstorm por esse índice normalizado; se sobrar zero ideia nova, pedir **uma segunda rodada** ao Gemini com a lista explícita de proibidos antes de aceitar qualquer repetição.
- Fallback deixa de ser fixo: combina semente + ângulo + um discriminador (data/número da série), e também passa pelo filtro de duplicatas.
- Depois de `stepMetadata`, se o `youtubeTitle` colidir (normalizado) com um título já publicado, pedir um título alternativo à IA; se falhar, acrescentar um diferenciador contextual em vez de publicar título idêntico.

## Detalhes técnicos

- `scripts/automation-runner.js`: novas funções `normalizeTitle`, `usedTitleIndex(data)`, `publishedInCurrentPeriod(data)`, `reserveNextRun(projectId, data)`; `stepIdea` com segunda rodada e filtro normalizado; guarda de teto em `processProject` antes do bloco de criação; releitura do projeto pós-lock; `uploadStartedAt` + reconciliação via YouTube antes de re-upload; ajuste de `RETRY_BACKOFF_MS[0]`.
- `scripts/youtubeUploader.js`: helper `findRecentUploadByTitle(auth, title)` usado apenas na reconciliação.
- `src/types.ts`: campos opcionais `uploadStartedAt` em `Video` e `lastPublishAttemptAt` em `ScheduleSettings`.
- Sem mudança de schema: tudo vive no JSON de `projects.data`.

## Fora de escopo

Motor de visuais, render FFmpeg, prompts de roteiro e a UI do editor não mudam.
