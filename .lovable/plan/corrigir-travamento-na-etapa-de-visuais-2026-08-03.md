# Corrigir travamento na etapa de Visuais

## O que está acontecendo

No print, o pipeline ficou **32m34s** parado em "Segmento 1, cena 19/19". Confirmei no código (`src/services/automationService.ts`, `stepGenerateVisuals`) três causas reais:

1. **Nenhuma chamada tem timeout.** `generateSceneImage` (Gemini) e a busca no Pexels não usam `AbortController`. Se uma requisição pendurar, o loop espera para sempre — exatamente o comportamento do print (uma cena "em andamento" indefinidamente).
2. **Loop 100% sequencial com espera fixa de 6s por cena.** Antes de cada slot há um `await` de até 6.000ms, mesmo quando o slot vai usar Pexels e não precisa de cota Gemini. Com 19 cenas só no segmento 1, são ~2min de espera artificial por segmento, somados à fila global do Gemini (que serializa tudo com 500ms de gap).
3. **Número de cenas sem limite.** `slotCount = ceil(duraçãoDoSegmento / maxMediaDurationSeconds)` — um segmento longo com o padrão de 6s gera 19+ slots, e cada slot sem acerto no Pexels dispara uma geração de imagem nova.

Somado a isso, a rotação de chaves (`geminiCore.ts`) pode dormir até 2 minutos aguardando cooldown, sem que a UI mostre esse motivo.

## Correções

**1. Watchdog por chamada (a correção que destrava)**

- Envolver cada busca Pexels (25s) e cada geração de imagem Gemini (60s) num `Promise.race` com timeout. No timeout, cancelar e seguir para o próximo recurso em vez de travar.
- Cada slot passa a ter um teto total (~90s). Estourando, usa `createFallbackVisualDataUrl` (já existe, gera SVG não-preto) e continua. A etapa nunca mais fica presa.

**2. Paralelizar com pool controlado**

- Construir a lista de todos os slots primeiro, depois processar com concorrência limitada (3 simultâneos), preservando a ordem pelo índice.
- Remover a espera fixa de 6s: throttle apenas antes de chamadas Gemini reais (não antes de slots resolvidos pelo Pexels), e reduzido, já que a fila do Gemini já serializa.

**3. Progresso legível**

- `onProgress` passa a mostrar cena concluída/total e a origem (`Pexels`, `IA`, `fallback`), além de avisar quando está aguardando cooldown de chave. Assim um travamento fica visível em segundos, não em minutos.

## Detalhes técnicos

- Arquivo principal: `src/services/automationService.ts` (`stepGenerateVisuals`) — refatoração do loop para "montar slots → pool paralelo → ordenar".
- `src/services/geminiThumbnail.ts` (`generateSceneImage`): aceitar um `AbortSignal`/timeout opcional e falhar rápido em vez de aguardar indefinidamente.
- `src/services/pexelsService.ts`: adicionar `AbortController` com timeout nos `fetch` de vídeo e foto.
- `scripts/automation-runner.js`: alinhar os mesmos limites (timeout por cena, teto de cenas) para o fluxo do GitHub Actions se comportar igual ao do navegador.
- Sem mudanças de schema no banco.