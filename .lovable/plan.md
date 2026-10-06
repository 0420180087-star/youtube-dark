# Fazer a chave Gemini chegar na automação (de verdade)

## O que o log mostra
A automação acha o projeto e ele está na hora de rodar. Mas a linha da nuvem para **augusto.gomes@ufpe.br** existe e está **sem nenhuma chave**. Também não há `GEMINI_API_KEY` nos Secrets do GitHub ("nem no ambiente"). Então ela pula o projeto. As correções contra duplicação não chegam a ser testadas, porque a execução para antes.

## Causa mais provável (vou confirmar no primeiro passo)
O app manda as chaves para a nuvem usando a **sessão Google guardada no navegador**. A nuvem grava as chaves no e-mail **dessa sessão**, não no e-mail do dono do projeto. Se essa sessão for de outra conta Google (por exemplo, a conta do canal do YouTube conectado), acontece o seguinte:
- as chaves vão para o e-mail dessa outra conta;
- a confirmação lê de volta da mesma conta e mostra "Salva na nuvem";
- a automação procura em augusto.gomes@ufpe.br e encontra a linha vazia.

Isso explica por que a tela diz que está tudo certo e o GitHub diz que não. Outra possibilidade: a função de salvar publicada na nuvem é uma versão antiga, que não grava as chaves.

## Fase 0 — Destravar agora (2 minutos, sem código)
No GitHub: repositório → Settings → Secrets and variables → Actions → New secret:
- `GEMINI_API_KEY` = sua chave Gemini
- `PEXELS_API_KEY` = sua chave Pexels

Depois, rode o workflow "Auto Post Video" manualmente. A automação usa essas chaves quando a nuvem não tem nenhuma. Assim já dá para testar a criação e a postagem completas hoje.

## Fase 1 — Corrigir o salvamento por conta
1. A função de salvar passa a responder **para qual e-mail gravou** e quantas chaves ficaram salvas.
2. Configurações mostra: "Chaves salvas para **<e-mail>** (N chaves)".
   - Se esse e-mail for diferente do e-mail com que você entrou no app, aparece um aviso vermelho e o selo fica em "não sincronizado".
3. O botão "Entrar novamente e sincronizar" abre o Google já sugerindo a conta certa (o seu e-mail de login). Se você escolher outra conta, o app recusa e explica o motivo.
4. Novo botão "Testar o que a automação vê": mostra quantas chaves existem na nuvem para o e-mail dono do projeto, que é o mesmo que o GitHub consulta.
5. A Saúde da Automação passa a mostrar o e-mail consultado e a quantidade de chaves.
6. A automação: no log de "linha vazia", passa a mostrar também quando a linha foi atualizada pela última vez. Isso ajuda a ver se o salvamento chegou a acontecer.

## Fase 2 — Publicar a função atualizada
- A função de salvar precisa ser publicada de novo na nuvem para valer a nova versão. Se o deploy automático estiver configurado, isso acontece sozinho. Se não, vou passar o comando exato.

## Detalhes técnicos
- `supabase/functions/user-data/index.ts`: `save_settings`/`get_settings` retornam `{ email, count, updated_at }`; o `save_settings` relê a linha depois do upsert.
- `src/services/userDataService.ts`: `renewGoogleToken` com `login_hint` = e-mail logado; tipos de retorno atualizados.
- `src/pages/Settings.tsx`: compara o e-mail retornado com `user.email`, mostra o e-mail e a contagem, e adiciona o botão de teste.
- `src/components/AutomationHealth.tsx`: o check de chaves passa a mostrar o e-mail e a contagem.
- `scripts/automation-runner.js`: inclui `updated_at` no log de linha vazia.
- Sem mudança no banco.

## Como valido
- Com os Secrets do GitHub: o log passa da etapa de chaves e chega a "Publicado: <URL>".
- Em Configurações: o e-mail mostrado é augusto.gomes@ufpe.br e a contagem é ≥ 1. Com isso, a automação passa a encontrar as chaves mesmo sem os Secrets do GitHub.
