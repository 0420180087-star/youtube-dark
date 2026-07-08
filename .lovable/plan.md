## Diagnóstico honesto

O comportamento da imagem tem duas causas principais:

1. **UI presa em “Executando…”**
   - Quando o lock do projeto não é obtido (`Lock não obtido: outro runner está processando este projeto`), o código muda `autoPilotStatus` para um texto de execução/retentativa e **retorna sem voltar para `Idle`**.
   - Como o botão usa `autoPilotStatus !== 'Idle'`, ele fica desabilitado indefinidamente mesmo quando nada está rodando no navegador.
   - Além disso, se uma execução anterior foi interrompida fechando/recarregando a página, o lock pode ficar preso até expirar, hoje por até **90 minutos**.

2. **Automação do navegador não pode continuar 100% após sair/fechar a página**
   - Se o fluxo roda no navegador, ele depende da aba aberta: IA, áudio, canvas/renderização e upload podem ser suspensos ou cancelados ao fechar/recarregar a página.
   - Navegar dentro do app pode continuar porque o `ProjectProvider` fica montado, mas fechar a aba, recarregar, perder sessão, suspensão do browser ou mobile background **interrompe o processo**.
   - Para rodar independente da página, precisa ser no runner headless/externo: hoje o caminho realista é o **GitHub Actions**. Ele também tem limites: tempo máximo do job, fila/atrasos do cron e dependência de secrets/configuração.

## O que é possível

É possível deixar o fluxo robusto assim:

```text
Botão manual no app
  -> cria/força uma execução persistida
  -> GitHub Actions/runner pega o projeto
  -> roda até concluir, falhar ou atingir timeout do job
  -> salva progresso por etapa
  -> UI apenas acompanha o status
```

Não é possível prometer que um fluxo pesado iniciado e executado no browser continue após fechar a página. O correto é o browser disparar/acompanhar, e o runner independente executar.

## Plano de correção

### 1. Corrigir imediatamente o “Executando…” infinito

- Ajustar `ProjectContext.tsx` para que qualquer retorno antecipado por lock negado volte para `Idle` após poucos segundos.
- Garantir que `isRunningAutomation.current` nunca fique preso.
- Reduzir o lock do navegador ou tornar o lock recuperável quando o runner morre.
- Adicionar mensagem clara: “Outro runner está processando; tente novamente em X min” em vez de deixar o botão desabilitado sem saída.

### 2. Separar status de UI de status real de execução

- Não usar somente `autoPilotStatus !== 'Idle'` para travar o botão.
- Expor um boolean real, por exemplo `isAutoPilotRunning`, baseado em `isRunningAutomation.current`/progresso local.
- Assim, estados como “lock não obtido”, “aguardando runner” ou “standby” não deixam o botão eternamente bloqueado.

### 3. Fazer o botão “Executar agora” preferir execução independente

- Quando houver Supabase/Cloud configurado, o botão deve registrar/forçar uma execução para o runner do GitHub, não depender do navegador para todo o vídeo.
- Para execução manual, gravar `nextScheduledRun` como agora ou criar um campo/flag de execução imediata compatível com o runner atual.
- O runner já aceita `PROJECT_ID` no workflow manual; o app não deve tentar chamar GitHub diretamente sem token secreto no frontend. O caminho seguro é persistir a intenção no banco e o cron pegar.

### 4. Melhorar o GitHub Actions runner para ser a fonte da verdade

- Tratar `PROJECT_ID` manual e execução agendada como modos explícitos.
- Persistir logs de início, etapa atual, erro e sucesso em `autopilot_logs`.
- Sempre salvar `nextScheduledRun` em falha controlada para não travar a agenda.
- Marcar vídeo como `STANDBY` quando criação/render/upload falhar.
- Garantir que lock seja liberado no `finally`, e que locks antigos expirem de forma segura.

### 5. Mostrar no Scheduler o status real do runner

- Carregar `autopilot_logs`/lock remoto além do log local do IndexedDB.
- Mostrar se o projeto está:
  - aguardando próximo horário;
  - em execução pelo navegador;
  - em execução pelo GitHub Actions;
  - travado por lock expirável;
  - em standby por erro.
- O botão deixa de parecer “travado” quando na verdade é lock/runner externo.

### 6. Limitação transparente final

Após a correção haverá dois modos:

```text
Modo navegador:
- útil para teste/manual enquanto a aba está aberta;
- pode parar ao fechar/recarregar/suspender a página;
- não é garantia 100% headless.

Modo GitHub Actions/headless:
- roda sem usuário na página;
- pode continuar até erro, conclusão ou timeout do job;
- é o caminho correto para automação real;
- depende de secrets, cron, banco e OAuth do YouTube configurados corretamente.
```

### 7. Validação depois da implementação

- Clicar “Executar agora” uma vez e confirmar que o botão não fica preso se o lock for negado.
- Simular lock existente e confirmar que a UI volta para estado clicável.
- Confirmar que fechar/sair da página não é mais tratado como garantia de execução browser; a execução confiável fica delegada ao runner.
- Confirmar que um projeto sem YouTube conectado ainda cria vídeo/brainstorm até `STANDBY`.
- Confirmar que um projeto com YouTube conectado consegue chegar ao upload pelo runner headless quando as credenciais estiverem corretas.