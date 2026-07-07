## Diagnóstico profundo

A automação não está falhando em um único ponto; ela está quebrada por uma cadeia de dependências frágeis. O maior problema é que a criação do vídeo, o brainstorm, o scheduler e o upload estão acoplados demais, então uma falha de token, agendamento, lock ou persistência impede até a criação da ideia/vídeo.

### 5 Porquês — criação não começa / brainstorm não cria ideias

1. **Por que a criação automática não começa?**
   Porque o Auto-Pilot do navegador retorna antes do passo de ideia quando não encontra token/canal do YouTube no projeto.

2. **Por que o YouTube bloqueia a criação, se ele só deveria ser necessário no upload?**
   Porque `runFullPipeline` valida YouTube antes de executar o pipeline inteiro, em vez de validar YouTube apenas no passo de postagem.

3. **Por que o projeto muitas vezes não tem canal/token válido?**
   Porque a conexão do YouTube depende de estado temporário de sessão e de metadados salvos no projeto; se o callback OAuth não atualiza o projeto corretamente, `youtubeChannelData` fica ausente.

4. **Por que isso vira falha silenciosa?**
   Porque retornos antecipados não geram log persistente nem reagendam corretamente a próxima tentativa.

5. **Raiz máxima:**
   O pipeline mistura pré-condições de criação com pré-condições de postagem, e não tem uma camada única de “saúde da automação” que registre o motivo real do bloqueio e permita continuar até onde for possível.

### 5 Porquês — GitHub Actions não cria/posta

1. **Por que o runner do GitHub não cria vídeos visíveis?**
   Porque ele só salva o novo vídeo no projeto depois do upload bem-sucedido.

2. **Por que isso é grave?**
   Se falhar no upload, render, token ou thumbnail, todo o trabalho anterior fica invisível e parece que nada foi criado.

3. **Por que as ideias se repetem?**
   Porque a ideia escolhida é persistida tarde demais; no runner, o estado de brainstorm só é salvo no final do pipeline.

4. **Por que o job parece “sucesso” mesmo sem entregar vídeo?**
   Porque muitos skips são tratados como retorno normal, com logs insuficientes para diferenciar “não havia nada para rodar” de “não consegui rodar”.

5. **Raiz máxima:**
   O runner não possui persistência incremental por etapa. Ele trata o pipeline como transação única, mas o fluxo real é longo e propenso a falhas; qualquer falha depois da ideia apaga evidências de progresso.

### 5 Porquês — postagem automática falha

1. **Por que a postagem falha depois da criação?**
   Porque o upload depende de refresh token, client id/secret e metadados do projeto estarem perfeitamente alinhados.

2. **Por que o token pode estar desalinhado?**
   Porque existem caminhos diferentes para token global, token por projeto, callback OAuth e runner do GitHub.

3. **Por que isso não é detectado cedo?**
   Porque não há preflight compartilhado entre navegador e GitHub verificando: projeto, brainstorm, chaves de IA, lock, refresh token do projeto e credenciais YouTube.

4. **Por que a falha bloqueia o vídeo inteiro?**
   Porque o fluxo salva o vídeo publicado só depois do upload; se o upload falha, o vídeo criado não é registrado como `STANDBY` de upload.

5. **Raiz máxima:**
   Falta separar “criar vídeo” de “postar vídeo” como fases independentes, com estado persistente e recuperação por etapa.

## Causas-raiz consolidadas

1. **Acoplamento indevido:** criação depende de YouTube antes da hora.
2. **Persistência tardia:** ideias e vídeos só são salvos no final, então falhas geram repetição e invisibilidade.
3. **Scheduler frágil:** `nextScheduledRun` pode não ser criado/recriado em abortos precoces.
4. **Logs insuficientes:** skips e retornos antecipados não viram diagnóstico persistente.
5. **Divergência navegador vs GitHub:** existem dois pipelines com regras diferentes para token, agendamento e persistência.
6. **Risco de banco/configuração:** as permissões/GRANTs e funções de lock precisam ser idempotentes e aplicadas como migration real, não apenas SQL manual opcional.
7. **Render/upload ainda têm pontos frágeis:** data URLs no renderer, crossfade, upload de stream e tratamento de erro precisam ser endurecidos.

## Plano de implementação

### 1. Criar uma camada única de diagnóstico da automação

Adicionar um helper compartilhado para navegador e runner com checagens em fases:

```text
Fase criação:
- projeto existe
- autoGenerate ativo ou execução manual
- usuário/proprietário definido
- chave Gemini disponível
- brainstorm acessível

Fase postagem:
- refresh_token do projeto existe
- YouTube client id/secret disponíveis
- canal do projeto conhecido ou reparável
- token renovável
```

Resultado esperado:
- criação pode prosseguir mesmo se postagem estiver sem token;
- upload falha como `STANDBY: upload`, não como “nada aconteceu”.

### 2. Desacoplar criação de upload no navegador

Alterar `ProjectContext.tsx` e `automationService.ts` para:
- não abortar o pipeline inteiro por ausência de YouTube antes da ideia/script/voz/visual/render;
- validar/renovar YouTube somente no passo `upload`;
- se YouTube falhar, manter o vídeo criado em `STANDBY` com erro claro;
- registrar log persistente para token ausente, canal ausente, lock negado e refresh falho;
- sempre reagendar ou marcar próxima tentativa após abortos controlados.

### 3. Tornar brainstorm e vídeo persistidos por etapa

No navegador:
- `saveGeneratedIdeas` deve retornar/confirmar as ideias criadas antes de marcar uma como usada;
- evitar depender de React state imediatamente após `setProjects`;
- atualizar `projectsRef.current` de forma síncrona dentro dos mutators críticos.

No GitHub runner:
- salvar `data.ideas` imediatamente após escolher/gerar ideia;
- criar um registro de vídeo logo após escolher a ideia, com status inicial;
- atualizar esse vídeo a cada etapa: script, voice, visuals, thumbnail, metadata, render, upload;
- se falhar no upload, salvar o vídeo como `STANDBY` em vez de descartá-lo.

### 4. Corrigir scheduler e lock

- Quando `autoGenerate` for ativado, gravar `nextScheduledRun` imediatamente.
- Se `nextScheduledRun` estiver ausente em projeto ativo, criar uma data determinística em vez de recalcular aleatoriamente a cada checagem.
- Em falha/skip de lock, registrar log persistente.
- Garantir que `scheduleNextRun` rode em `finally` para falhas controladas.
- No runner, diferenciar claramente:
  - sem projetos;
  - projetos não elegíveis;
  - projeto elegível mas bloqueado por lock;
  - projeto elegível mas sem credencial.

### 5. Endurecer o runner do GitHub

Arquivos principais:
- `.github/workflows/auto-post.yml`
- `scripts/automation-runner.js`
- `scripts/videoRenderer.js`
- `scripts/youtubeUploader.js`

Mudanças planejadas:
- aumentar timeout do job;
- adicionar preflight de envs com mensagens explícitas;
- persistir progresso incremental no banco;
- tratar `PROJECT_ID` manual como execução forçada com diagnóstico completo;
- corrigir render de `data:image/...` salvando data URLs em arquivo antes do FFmpeg;
- corrigir cadeia de crossfade para múltiplos clipes;
- fazer upload do vídeo com corpo compatível com Node atual e erro detalhado;
- normalizar `privacyStatus` para `public/private/unlisted`.

### 6. Aplicar migration idempotente de confiabilidade

Criar uma migration real para garantir, no Cloud/banco:
- permissões explícitas para tabelas usadas pela automação;
- colunas necessárias em `autopilot_logs`;
- colunas/índices de `project_auth`;
- funções `acquire_autopilot_lock` e `release_autopilot_lock` com assinatura `text`;
- grants de execução das funções;
- índices para busca por usuário/projeto.

Observação: nesta sessão o acesso direto ao banco não está disponível, então a correção deve ser idempotente e segura para rodar mesmo se parte dela já existir.

### 7. Unificar estado de postagem por projeto

- O refresh token usado no upload deve ser sempre o do `project_id` atual.
- O callback OAuth deve salvar canal e auth no projeto alvo de forma confiável.
- Se o canal estiver ausente mas o refresh token existir, reparar metadados do canal antes do upload.
- Remover dependência de token global para decidir se o pipeline de criação pode começar.

### 8. Validação final

Depois de implementar, validar estes cenários:

```text
1. Projeto novo sem ideias:
   auto/manual cria brainstorm novo e escolhe uma ideia.

2. Projeto com ideia existente:
   usa a ideia nova e marca como used sem repetir.

3. YouTube desconectado:
   cria vídeo até onde possível e para em STANDBY/upload com log claro.

4. YouTube conectado:
   cria, renderiza e posta usando refresh_token do projeto.

5. GitHub workflow manual com PROJECT_ID:
   ignora agenda, roda projeto específico e mostra motivo real se falhar.

6. GitHub workflow agendado:
   processa apenas projetos elegíveis, registra logs e agenda próxima execução.
```

## Ordem de correção recomendada

1. Migration/Cloud e diagnóstico compartilhado.
2. Persistência incremental de brainstorm/vídeo.
3. Desacoplamento criação vs upload no navegador.
4. Hardening do runner GitHub.
5. Correções de render/upload.
6. Teste manual e teste via workflow forçado.