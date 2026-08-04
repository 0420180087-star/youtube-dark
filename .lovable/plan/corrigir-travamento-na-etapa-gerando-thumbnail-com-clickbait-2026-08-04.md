# Corrigir travamento na etapa "Gerando thumbnail com clickbait"

## Causa raiz (confirmada no código)

O pipeline ficou 11m32s no passo de thumbnail. Diferente da etapa de visuais (que já recebeu watchdog), o caminho da thumbnail em `src/services/geminiThumbnail.ts` **não tem nenhum timeout**:

1. `generateThumbnail()` chama `buildImagePrompt()` (Gemini Flash) e depois `renderImageFromPrompt()` — nenhuma das duas usa o helper `withTimeout` que já existe no arquivo (hoje ele só é usado em `generateSceneImage`). Uma requisição pendurada trava a etapa para sempre.
2. `IMAGE_MODELS` está desatualizado: `gemini-2.0-flash-preview-image-generation` foi descontinuado (404) e `gemini-2.0-flash-exp` / `gemini-2.0-flash` **não são modelos de imagem**. Quando eles respondem só texto, `base64` fica vazio e o loop segue **sem lançar erro** — ou seja, o fallback canvas nunca é acionado por esse caminho, e cada tentativa gasta uma chamada real.
3. Como os 3 modelos falham por quota/erro, o erro sobe para o rotador de chaves (`geminiCore.ts`), que pode dormir até ~2 minutos por tentativa aguardando cooldown. Com 3 modelos × rotação de chaves, isso soma os 11+ minutos observados sem nunca desistir.
4. O `scripts/automation-runner.js` (`stepThumbnail`, linha ~849) tem o mesmo problema: `geminiWithRetry(() => geminiGenerateImage(...))` sem teto de tempo.

## Correções

**1. Modelos de imagem corretos**
- Trocar a lista para os modelos de imagem atuais, em cascata: `gemini-2.5-flash-image` → `gemini-2.0-flash-preview-image-generation` (legado, mantido por compatibilidade).
- Se a resposta não trouxer `inlineData`, lançar erro explícito (`No image data`) em vez de continuar em silêncio — assim o fallback funciona de verdade.

**2. Watchdog na etapa de thumbnail (a correção que destrava)**
- `buildImagePrompt`: timeout de 25s. Se estourar, usar um prompt determinístico montado localmente a partir de título/tom/nicho (helpers `mapToneTo*` já existem) em vez de abortar.
- `renderImageFromPrompt`: timeout por modelo (35s) e teto total de 70s para a cascata.
- `generateThumbnail`: teto global de ~100s. Estourando qualquer coisa, cai imediatamente no `generateCanvasThumbnail`, que já produz uma imagem 1280×720 com clickbait, barra de progresso a 70% e vinheta.

**3. Nunca bloquear o pipeline pela thumbnail**
- Em `src/services/automationService.ts` (`stepGenerateThumbnail`), envolver a chamada em try/catch com teto de tempo: em caso de falha, seguir com a thumbnail canvas e registrar o aviso, sem mandar o vídeo para STANDBY.
- Usar o texto clickbait de `generateThumbnailHook` no canvas (hoje o fallback usa apenas o título cru), para o resultado continuar clickbait mesmo sem IA.

**4. Paridade no runner headless**
- `scripts/automation-runner.js`: aplicar a mesma lista de modelos, timeout por chamada e teto total em `stepThumbnail`, mantendo o comportamento atual de "continuar sem thumbnail" quando estourar.

## Detalhes técnicos

- Arquivos: `src/services/geminiThumbnail.ts` (principal), `src/services/automationService.ts` (`stepGenerateThumbnail`), `scripts/automation-runner.js` (`stepThumbnail`).
- Reutiliza o helper `withTimeout` já presente em `geminiThumbnail.ts`; nenhuma dependência nova.
- Sem mudanças de schema no banco.
