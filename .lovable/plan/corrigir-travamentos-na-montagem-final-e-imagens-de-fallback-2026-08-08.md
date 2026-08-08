# Corrigir travamentos na montagem final e imagens de fallback repetidas

Escopo: apenas montagem/renderização e o gerador de imagem de reserva. Buscas no Pexels, geração via Gemini, timeouts, roteiro, TTS e upload ficam intactos.

## 1. Travamentos na concatenação (scripts/videoRenderer.js)

`concatenateWithCrossfade` hoje acumula `offset += prevDur - crossfadeDuration` com crossfade fixo de 0.4s. Quando um clipe é mais curto que o crossfade (ex.: 0.8s ou menos), o offset pode ficar igual ou menor que o anterior — o xfade sobrepõe trechos e o vídeo trava/congela. E o fallback `simpleConcat` usa `-c copy`, que só funciona se todos os arquivos tiverem streams binariamente idênticos; qualquer divergência gera travamento.

Correções:
- Offset cumulativo que nunca regride: para cada transição, `safeXfade = clamp(crossfade, 0.15s, 40% da menor duração do par)` e `offset = max(0, duraçãoAcumulada - safeXfade)`, atualizando a duração acumulada a cada passo.
- `simpleConcat` passa a re-encodar: `-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -r 30 -an` em vez de `-c copy`.

## 2. Imagens de fallback repetidas

`createFallbackVisualDataUrl` existe em duas versões (frontend e runner) e só tem 4 paletas, então após erros de renderização as mesmas 4 telas reaparecem.

Correção nos dois arquivos (`src/services/visualSceneService.ts` e `scripts/automation-runner.js`):
- 10 paletas de cor (paleta = `seed % 10`).
- 4 composições SVG distintas (posição do círculo, direção da curva de destaque, alinhamento do texto) — layout = `floor(seed / 10) % 4`.
- Resultado: até 40 variações visuais distintas, mantendo a mesma assinatura de função e o mesmo retorno data URL.

## 3. Verificação

Teste de render real com FFmpeg local: clipes gerados com durações bem diferentes (incluindo um de ~0.6s), passando por `concatenateWithCrossfade`, confirmando via `ffprobe` que a duração final bate com a soma esperada e que o fallback `simpleConcat` também produz saída válida. Também gero as 40 variações de fallback e confirmo que não há SVG duplicado.

## Detalhes técnicos

- `scripts/videoRenderer.js`: apenas `concatenateWithCrossfade` e `simpleConcat`.
- `scripts/automation-runner.js`: apenas `createFallbackVisualDataUrl` (linhas ~638-644).
- `src/services/visualSceneService.ts`: apenas `createFallbackVisualDataUrl`.
- Sem mudanças de schema, de rede ou de chamadas de API.
