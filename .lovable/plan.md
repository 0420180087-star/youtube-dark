
## Diagnóstico (causa raiz)

O vídeo em Standby mostra: **Falhou em Narração — "Audio generation failed: OTHER"**.

Rastreando o código:

- `stepGenerateVoice` (`src/services/automationService.ts:148`) chama `generateVoiceover` **uma vez por segmento**, sem retry.
- `generateVoiceover` (`src/services/geminiCore.ts:1023`) usa `gemini-2.5-flash-preview-tts`. Quando a resposta vem sem áudio, ele lê `finishReason` e joga um erro imediato — **inclusive para `OTHER`**, que na API do Gemini TTS é o código genérico usado para:
  - falhas transitórias do modelo (o mais comum — resolve na 2ª tentativa),
  - texto acima do limite prático (~4-5k caracteres num único segmento),
  - trecho que dispara o classificador de segurança (o vídeo que falhou é sobre finanças + Bíblia, campo sensível),
  - caracteres/emoji que o TTS não consome.

Como não há nenhuma tentativa de retry, split ou fallback, **um único segmento problemático mata o vídeo inteiro** e ele vai para Standby. Isso bate com "falhando na maioria das execuções".

`executeGeminiRequest` retenta por chave/quota, mas **não retenta por finishReason** — do ponto de vista dele a chamada foi um sucesso (retornou 200), então nada é retentado.

## Correção

### 1. `src/services/geminiCore.ts` — `generateVoiceover` mais resiliente

- Sanitizar texto antes de enviar: remover emojis e caracteres de controle, colapsar espaços, cortar aspas curly problemáticas. Mantém pontuação e travessão (que já ajudam prosódia).
- Retry interno em `OTHER` / `MAX_TOKENS` / resposta vazia: até **3 tentativas** com backoff (800ms, 1.6s, 3.2s) + jitter. Cada tentativa passa por `executeGeminiRequest` — se `OTHER` for de sobrecarga momentânea, resolve.
- Se as 3 tentativas falharem **e** o texto for maior que 1.200 caracteres: fazer **split recursivo** por frase (`. ! ?`), gerar áudio dos pedaços e concatenar os `ArrayBuffer` PCM (mesmo sample rate 24kHz mono, então concat é seguro).
- Se `finishReason === 'SAFETY'`: lançar erro específico "Bloqueado por filtro de segurança do TTS neste trecho" para ficar transparente na UI (não fica escondido como "OTHER").
- Logar `finishReason` real e o começo do texto (primeiros 80 chars) para diagnóstico.

### 2. `src/services/automationService.ts` — `stepGenerateVoice` com fallback por segmento

- Envolver a chamada `generateVoiceover` em retry de segmento: até **2 tentativas** adicionais com backoff.
- Se ainda falhar, tentar **uma vez com voz alternativa** (`Charon` se a atual não for Charon; `Fenrir` como último recurso). Muitas falhas `OTHER` somem trocando o preset de voz.
- Se todas as tentativas falharem, o erro final inclui número do segmento + primeiros caracteres do texto — mais útil que "OTHER".
- Callback `onProgress` reporta "Segmento X: tentativa Y/3" para o usuário ver.

### 3. Sem mudanças em

- `videoRenderer.js`, `youtubeUploader.js`, `automation-runner.js`, SQL, workflow — o problema está exclusivamente no cliente TTS.
- Sem mudança de modelo/API — mesma chave, mesmo endpoint.

## Arquivos editados

- `src/services/geminiCore.ts` — reescrever `generateVoiceover` com sanitização, retry por finishReason, split recursivo e mensagens claras.
- `src/services/automationService.ts` — envolver `stepGenerateVoice` com retry por segmento + fallback de voz.

## Limitação transparente

- Se o trecho realmente violar política de segurança do Gemini TTS, nenhum retry resolve — nesse caso o erro dirá "SAFETY" para você editar o texto do segmento manualmente em vez de ficar em loop.
- Cota/rate-limit continua sendo tratado pelo `executeGeminiRequest` já existente (rotação de chaves) — não mudamos isso.

## Validação após implementar

1. Reprocessar o vídeo em Standby "O Sacrifício Financeiro..." → esperar 1-2 retries silenciosos, deve concluir.
2. Se falhar de novo, log agora mostrará se foi `SAFETY` (conteúdo) ou `OTHER` persistente após 3 tentativas + split — em ambos os casos, mensagem clara em vez de "OTHER".
3. Rodar automação nova → taxa de falha em Narração cai (esperado: >90% dos "OTHER" transitórios resolvem na 2ª tentativa).
