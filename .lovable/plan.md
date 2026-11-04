# Chaves e modelos sempre funcionais + login renovando sozinho + thumbnail a partir do vídeo

## Diagnóstico (confirmado no código)

1. **"Chave do Gemini não reconhecida" não é a chave** — é o modelo. O projeto chama `gemini-2.5-flash` fixo em vários pontos (`geminiCore.ts`, `geminiPexels.ts`, `geminiThumbnail.ts`, `automation-runner.js` linha 741) e o Google retirou esse modelo: o erro real no log é `404 "This model models/gemini-2.5-flash is no longer available to new users"`. A chave está correta e carregada.
2. **Login não reconhecido** — a Edge Function `user-data` valida o access token do Google do login; ele expira e a renovação silenciosa (GIS) falhou, devolvendo `401 "Token do Google inválido ou expirado"`. O painel "Saúde da Automação" mostra esse 401 também em "Canais do YouTube" (o check usa a mesma função), o que engana: o refresh token do YouTube está salvo e intacto — é só a sessão de login do navegador que venceu.
3. **Imagens do Gemini pararam** — cota diária do modelo de imagem (RPD) estourou. As thumbnails passarão a ser feitas a partir de um corte do vídeo, sem depender de geração de imagem.

## Fase 1 — Modelo Gemini resiliente (não quebra com atualização do Google)

- **Descoberta dinâmica de modelos:** nova camada `resolveTextModel()` que consulta `GET /v1beta/models` (ListModels) com a chave atual, filtra os que suportam `generateContent` (excluindo TTS e modelos de imagem), escolhe o melhor disponível por ordem de preferência e guarda em cache (memória + 6h). Funciona no runner (axios/REST) e no frontend.
- **Substituir todo `gemini-2.5-flash` fixo** pelos pontos centrais que usam o modelo resolvido: `geminiCore.ts` (9 ocorrências), `geminiPexels.ts`, `geminiThumbnail.ts` (briefing/descrição), `automation-runner.js` (`geminiGenerate`).
- **Auto-recuperação em 404:** erros "no longer available" / "not found" invalidam o cache e re-resolvem para o próximo modelo da lista, repetindo a chamada uma vez — sem marcar a chave como inválida e sem falhar o passo.
- **Lista estática de reserva** (caso ListModels falhe) com os modelos atuais e antigos, na ordem certa.
- Os modelos de imagem (`geminiImageModels.ts`) ganham a mesma verificação de 404 (pulam modelo desligado automaticamente).

## Fase 2 — Sessão de login sempre válida

- **Verificação preventiva:** antes de chamar `user-data`, o app confere se o token ainda vale (tokeninfo); se vencido, renova em silêncio antes da primeira chamada (hoje só renova depois de levar 401).
- **Renovação silenciosa no boot:** ao abrir o app, se o token estiver vencido, uma renovação silenciosa é tentada automaticamente por aba.
- **Mensagens corretas no painel de saúde:** 401 na leitura de chaves vira o check "Sessão de login" com botão "Entrar novamente e sincronizar"; "Canais do YouTube" passa a refletir só o estado real do canal (refresh token salvo/revogado), não mais o 401 da sessão. Assim o aviso amarelo de reconectar o canal só aparece quando o canal está mesmo desconectado.

## Fase 3 — Thumbnail a partir de um corte do vídeo

- **Runner (GitHub Actions):** reordena o pipeline — o vídeo é montado primeiro; ao terminar, `ffmpeg` extrai um frame escolhido (foto nítida de uma cena forte) do MP4 final e desenha o texto de clickbait por cima (título de até 4 palavras, contorno forte, estilo do layout atual). A thumbnail resultante é usada no upload. Sem nenhuma chamada de imagem ao Gemini.
- **Fluxo semiautomático (navegador):** a thumbnail é composta em canvas a partir da cena/visual já baixado do vídeo + o mesmo overlay de texto — sem Gemini de imagem. A captação de frame acontece durante o próprio render (canvas já em uso em `renderService.ts`).
- **Reserva:** se a montagem do vídeo falhar, o sistema recorre ao método antigo (Gemini de imagem) apenas nesse caso.
- Teste existente `geminiThumbnail.test.ts` é atualizado; novo teste cobre a regra "thumbnail vem de frame do vídeo, sem chamada de imagem".

## Fase 4 — Runner sem sinal

- O runner agora grava heartbeat **em todos os caminhos de saída** (skip por cota, sem projeto elegível, erro no arranque), então o painel deixa de mostrar "sem sinal há 244 min" quando a execução rodou e pulou.
- Orientação para verificar se o cron do GitHub Actions está ativo (aba Actions → "Auto Post Video").

## Fora do escopo (não mexe)

- Chaves salvas por usuário, lock/fila, velocidade de narração, música — nada muda.
- Nenhum modelo de pagamento de chaves é alterado; as chaves continuam salvas na nuvem por e-mail.
