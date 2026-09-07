# Fazer as chaves de API chegarem de fato à automação

## O que o log mostra

A automação encontrou o projeto e o agendamento certo. Ela parou porque, no banco, não existe nenhuma chave Gemini salva para `augusto.gomes@ufpe.br` — mesmo a tela de Configurações mostrando uma chave ativa.

Motivo: a tela mostra a chave guardada **neste navegador**. O envio para a nuvem (que é o que a automação lê) acontece só quando você clica em "Salvar" **e** existe uma sessão do Google válida naquele momento. Essa sessão vale cerca de 1 hora; se ela estiver expirada, o envio falha e a chave continua só local. Hoje isso passa quase silencioso (só um aviso), então a tela parece salva enquanto a automação vê "nenhuma chave".

Também confirmado: adicionar a chave com "+ Adicionar" não envia nada para a nuvem por si só; e a chave do Pexels segue o mesmo caminho.

## O que vou fazer

1. **Mostrar a verdade na tela**: um indicador por seção — "Salva na nuvem (automação enxerga)" ou "Somente neste navegador" —, calculado lendo de volta o que está no banco, não pelo que foi digitado.
2. **Salvar de verdade sem depender da hora certa**: ao salvar, se a sessão do Google estiver expirada, o sistema renova a sessão sozinho e tenta de novo; se ainda não der, aparece um botão claro "Entrar novamente e sincronizar" que conclui o envio.
3. **Confirmar depois de salvar**: logo após enviar, o sistema lê de volta as chaves da nuvem e só então mostra "sincronizado". Se a leitura vier vazia, mostra erro visível com o motivo, em vez de sucesso.
4. **Sincronizar também ao adicionar/remover chave**, para não depender de o usuário lembrar de clicar em Salvar.
5. **Mensagem melhor na automação**: quando não houver chave, o log dirá qual e-mail foi consultado, se a tabela respondeu e o que fazer (abrir Configurações e sincronizar), diferenciando "usuário sem chave" de "consulta falhou".

## Detalhes técnicos

- `src/pages/Settings.tsx`: estado de sincronização (`unknown | synced | local_only | error`), verificação via `getUserSettings()` no carregamento e após cada `saveUserSettings()`, botão de re-sync, sincronização disparada em add/remove de chave.
- `src/services/userDataService.ts`: em resposta 401 do `user-data`, obter novo access token do Google (fluxo já existente em `youtubeAuthService`) e repetir a chamada uma vez; erros passam a incluir status e corpo para diagnóstico.
- `scripts/automation-runner.js` (`loadUserKeys`): log distinto para "linha ausente", "linha existe mas array vazio" e "erro de query", com instrução de ação; mantém fallback para chaves de ambiente.
- Sem mudança de schema; `user_settings` e a função `user-data` já existem.

## Como valido

- Salvar as chaves na tela e ver o indicador virar "salva na nuvem".
- Rodar `npx tsx scripts/automation-runner.js` e confirmar que a etapa de chaves passa e o pipeline avança além do ponto atual.
