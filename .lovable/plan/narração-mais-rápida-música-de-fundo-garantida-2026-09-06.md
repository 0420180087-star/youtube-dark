# Narração mais rápida + música de fundo garantida

Dois ajustes no áudio dos vídeos: deixar a voz um pouco mais rápida (com controle no projeto) e garantir que a música de fundo realmente entre nos vídeos gerados de forma automática (GitHub Actions) e semiautomática (no navegador).

## 1. Velocidade da narração

- Nova configuração por projeto: "Velocidade da narração", de 1.0x a 1.4x, padrão **1.15x**.
- Aplicada nos dois caminhos de geração:
  - No navegador: a voz gerada é acelerada preservando o tom (sem "voz de esquilo"), e os tempos de cada segmento são recalculados dividindo pelo fator, para que as imagens continuem sincronizadas com a fala.
  - Na automação do servidor: a mesma aceleração é aplicada na montagem final, também preservando o tom.
- Se a aceleração falhar por qualquer motivo, o áudio original é usado (nunca quebra a geração).

## 2. Música de fundo

Pontos confirmados na leitura do código:

- A automação do servidor já cria uma trilha ambiente própria e a mistura a 12% de volume; se essa criação falha, o vídeo segue **em silêncio de fundo sem aviso claro**.
- No navegador, a música é criada em um passo separado e misturada a 14%.
- Existe uma falha real: ao sincronizar com a nuvem, a música é substituída por um marcador (`__has_music__`) para não estourar o limite de tamanho. Se o vídeo for montado a partir dos dados vindos da nuvem (outro navegador/sessão), esse marcador não é áudio válido e a mistura falha em silêncio — vídeo sai sem música.

Correções:

- Antes de montar, validar a música: se o valor for um marcador (`__has_music__`) ou inválido, **regerar a trilha na hora** em vez de seguir sem música.
- Na automação do servidor, se a trilha ambiente falhar na primeira tentativa, tentar uma versão simplificada antes de desistir, e registrar isso no log da execução.
- Padronizar o volume da música em **15%** nos dois caminhos, com a voz sempre à frente (compressão/ducking leve já existente mantida).
- Registrar no log, em ambos os caminhos, se o vídeo saiu com ou sem música — para nunca mais ficar dúvida.

## 3. Verificação

- Gerar um vídeo curto pela automação local (FFmpeg no sandbox) e conferir com `ffprobe`/análise de volume que existe áudio de música junto da voz.
- Conferir que a duração final do vídeo acompanha a narração acelerada (sem cortes nem sobra de imagem no fim).
- Conferir que os tempos dos segmentos continuam alinhados com a fala após a aceleração.

## Detalhes técnicos

- `src/types.ts`: novo campo opcional `narrationSpeed` em `Project`.
- `src/services/geminiAudio.ts`: nova função de time-stretch por sobreposição (preserva pitch) aplicada ao buffer final de voz; fallback para resample simples.
- `src/services/automationService.ts` (`stepGenerateVoice`): aplica a velocidade e divide `segmentTimestamps` pelo fator.
- `src/services/renderService.ts`: valida `backgroundMusicUrl` (rejeita sentinelas/`__has_music__`), regenera via `generateDarkAmbience` quando inválido, volume 0.15.
- `scripts/automation-runner.js`: `generateAmbienceTrack` com retry simplificado + logs de música; passa `narrationSpeed` ao renderer.
- `scripts/videoRenderer.js`: `atempo` na faixa de voz (encadeado quando fator > 2 não se aplica aqui) e `volume=0.15` na música em `mixAudio`.
- `src/pages/ProjectHub.tsx` / configurações do projeto: controle de velocidade (slider 1.0–1.4).
- Sem mudanças de schema, de rede ou de chaves de API.
