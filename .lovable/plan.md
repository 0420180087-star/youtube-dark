## Diagnóstico das causas-raiz

A automação não está falhando por um único bug; existem quebras em cadeia entre autenticação YouTube, persistência no banco, scheduler do navegador e runner do GitHub.

### Bloqueadores principais

1. **Canal conectado não vira estado confiável do projeto**
   - O OAuth salva token, mas nem sempre atualiza `youtubeChannelData`/`isYoutubeConnected` no projeto.
   - O scheduler manual só inicia se o projeto tiver `youtubeChannelData`; se o usuário conectou pelo Settings global ou a volta do OAuth não atualizou o projeto, a automação para antes de criar o vídeo.

2. **Client ID/secret do YouTube estão inconsistentes entre app, Cloud e GitHub**
   - O refresh token do Google só funciona com o mesmo OAuth Client ID/secret usado na autorização.
   - Hoje há caminhos diferentes: campo editável no frontend, secrets do deploy, secrets do runner e função `get-youtube-config` lendo nomes diferentes.
   - Resultado provável: `invalid_grant`, token ausente ou upload nunca começa.

3. **GitHub Actions depende do banco, mas o banco pode estar inacessível ou incompleto**
   - As migrations criam tabelas públicas sem `GRANT` explícito para Data API.
   - A migration 005 tentou resolver abrindo RLS com `using (true)`, o que faz funcionar parcialmente, mas é inseguro e ainda não garante grants.
   - Se projetos, chaves ou tokens não sincronizam, o runner não encontra nada para processar.

4. **Runner automático gera ideia mas não mantém o fluxo Brainstorm corretamente**
   - Quando não há ideias, ele cria uma ideia para o vídeo, mas não persiste um lote de novas ideias no brainstorm como o fluxo manual esperado.
   - Isso quebra o fluxo “verificar ideias → se não tiver criar ideias novas → usar uma ideia”.

5. **Render server-side pode quebrar na etapa de voz**
   - O runner concatena chunks de áudio diretamente em bytes. Se o Gemini retornar WAV/L16 com headers por segmento, o arquivo final pode ficar inválido ou só tocar parcialmente.
   - Isso pode impedir a renderização antes do upload.

6. **Upload de thumbnail no runner ainda usa formato errado**
   - `scripts/youtubeUploader.js` ainda importa `form-data` e envia multipart; o endpoint do YouTube para thumbnail espera mídia bruta.
   - Não bloqueia o vídeo, mas deixa a automação incompleta.

7. **Falhas silenciosas dificultam saber onde parou**
   - Alguns erros ficam só em console/standby local, sem log persistente claro.
   - GitHub e navegador não compartilham um mesmo checklist de saúde: chaves, projeto conectado, token, próxima execução, render e upload.

## Plano de correção

### 1. Padronizar OAuth YouTube como fonte única de verdade

- Usar um único OAuth Client ID configurado pela plataforma/build secrets, não um Client ID arbitrário por usuário.
- Corrigir `get-youtube-config`, `exchange-code`, `refresh-token`, `.github/workflows/deploy.yml` e `.github/workflows/auto-post.yml` para usarem os mesmos nomes:
  - `GOOGLE_CLIENT_ID`
  - `YOUTUBE_CLIENT_SECRET`
- Remover/neutralizar caminhos que aceitam `client_secret` vindo do browser.
- Salvar no `project_auth` também:
  - `youtube_channel_id`
  - `youtube_channel_title`
  - `oauth_client_id`
  - `token_expires_at`

### 2. Corrigir callback OAuth para marcar o projeto como conectado

- Atualizar `AuthContext.tsx` para expor método de salvar canal atual em memória/local seguro.
- Atualizar `OAuthCallback.tsx` para, após buscar o canal:
  - salvar token em AuthContext;
  - salvar dados do canal no AuthContext;
  - marcar o projeto alvo com `isYoutubeConnected: true` e `youtubeChannelData`;
  - persistir isso imediatamente no banco.
- Se OAuth vier de Settings global sem projeto, mostrar aviso para conectar o canal dentro do projeto ou aplicar ao projeto selecionado quando existir `yt_oauth_target_project`.

### 3. Tornar refresh token estritamente por projeto

- Ajustar `refresh-token` para buscar primeiro e obrigatoriamente por `project_id + user_email` quando o projeto for informado.
- Remover fallback silencioso para “qualquer projeto do usuário” durante upload automático, porque isso pode postar no canal errado.
- Se não houver token daquele projeto, retornar erro claro: “reconecte este projeto ao YouTube”.
- Ajustar `automation-runner.js` para usar a mesma regra.

### 4. Adicionar migration de confiabilidade do banco

Criar uma nova migration para:

- adicionar `GRANT` explícito para todas as tabelas usadas pela automação;
- adicionar índices em `projects(user_email)`, `project_auth(project_id,user_email)`, `autopilot_logs(project_id)` e `user_settings(user_email)`;
- adicionar colunas faltantes em `project_auth` se necessário;
- permitir `youtube_refresh_token` nullable apenas para linhas parciais, mas bloquear upload quando refresh token estiver ausente;
- recriar RPCs de lock com `project_id text` e logs claros.

### 5. Fechar o checklist antes de iniciar qualquer pipeline

Criar uma validação única usada por navegador e GitHub:

```text
Projeto existe
AutoGenerate ativo ou execução manual forçada
Ideia disponível ou geração de ideias habilitada
Gemini API key disponível
YouTube conectado neste projeto
Refresh token válido para este projeto
FFmpeg disponível no runner GitHub
Próxima execução vencida ou Run Now acionado
```

- Se algo faltar, registrar em `autopilot_logs` com passo e mensagem acionável.
- Mostrar o mesmo motivo no Scheduler dentro da plataforma.

### 6. Corrigir fluxo Brainstorm → vídeo no runner

- Quando não houver ideias:
  - gerar um lote de ideias;
  - salvar todas no projeto;
  - marcar apenas a escolhida como `used`;
  - continuar criação do vídeo.
- Evitar repetir título já publicado ou ideia já usada.

### 7. Corrigir render e áudio server-side

- Ajustar `stepVoice`/`videoRenderer.js` para normalizar cada chunk de TTS antes de concatenar.
- Se o áudio vier WAV, concatenar com FFmpeg ou converter cada segmento para PCM/AAC antes de juntar.
- Manter fallback de ambiência como não bloqueante.
- Garantir que falha em thumbnail/ambience não derrube upload do vídeo principal.

### 8. Corrigir upload YouTube no GitHub

- Atualizar `scripts/youtubeUploader.js`:
  - thumbnail com corpo bruto e `uploadType=media`;
  - checar `res.ok` e logar erro sem falhar o vídeo;
  - remover `form-data` se ficar sem uso.
- Padronizar metadata e privacidade com o mesmo comportamento do upload manual.

### 9. Corrigir scheduler manual dentro da plataforma

- Se o projeto tem token salvo no Cloud mas não tem `youtubeChannelData`, tentar reparar automaticamente buscando o canal via refresh token.
- Ao ativar Auto-Generate, calcular e persistir `nextScheduledRun` de forma previsível.
- O botão “Executar Agora” deve ignorar agenda, mas não ignorar checklist de chaves/token.
- Falhas de Studio/thumbnail devem virar warning, não impedir publicação.

### 10. Melhorar observabilidade

- Persistir logs com:
  - projeto;
  - título do vídeo;
  - etapa;
  - erro resumido;
  - duração;
  - origem: `browser` ou `github-actions`.
- No Scheduler, mostrar último erro real do GitHub também, não só logs locais do navegador.

## Arquivos que serão modificados

- `.github/workflows/auto-post.yml`
- `.github/workflows/deploy.yml`
- `scripts/automation-runner.js`
- `scripts/videoRenderer.js`
- `scripts/youtubeUploader.js`
- `src/context/AuthContext.tsx`
- `src/context/ProjectContext.tsx`
- `src/pages/OAuthCallback.tsx`
- `src/pages/ProjectHub.tsx`
- `src/pages/Settings.tsx`
- `src/pages/Scheduler.tsx`
- `src/services/automationService.ts`
- `src/services/youtubeAuthService.ts`
- `supabase/functions/exchange-code/index.ts`
- `supabase/functions/refresh-token/index.ts`
- `supabase/functions/get-youtube-config/index.ts`
- nova migration `supabase/migrations/006_automation_reliability.sql`

## Validação após implementar

- Rodar checagem estática dos scripts Node.
- Validar que o fluxo manual cria: ideia → vídeo → script → voz → visuais → ambiência → thumbnail → metadata → upload.
- Validar que o runner GitHub consegue:
  - encontrar projetos elegíveis;
  - carregar chaves do usuário ou fallback;
  - renovar token do projeto;
  - renderizar MP4;
  - postar no YouTube;
  - salvar vídeo publicado e próxima execução.
- Se eu não tiver acesso direto ao banco real, vou deixar logs e mensagens suficientes para você colar o output do GitHub Actions e identificarmos qualquer secret/migration ausente em uma rodada curta.