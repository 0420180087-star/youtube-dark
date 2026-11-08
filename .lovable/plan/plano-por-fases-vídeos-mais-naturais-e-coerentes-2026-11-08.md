# Plano por fases: vídeos mais naturais e coerentes

## Objetivo

Melhorar os vídeos criados de forma automática, manual e assistido, mantendo os mesmos padrões de roteiro, voz, imagens e edição em todas as formas de postagem. A locução continuará sendo feita por IA; não será incluído envio nem clonagem de voz própria.

## Fases

### 1. Roteiro e locução com mais personalidade

- Padronizar as instruções de roteiro usadas no editor e no GitHub Actions: abertura com gancho, linguagem conversacional, análise clara e transições naturais entre ideias, sem introduções enciclopédicas genéricas.
- Não inventar histórias pessoais como fatos do criador; usar primeira pessoa somente quando houver contexto fornecido pelo usuário.
- Melhorar a cadência da voz IA com pausas e ênfases planejadas, ajustes de pronúncia para nomes e termos e configurações de velocidade compatíveis entre editor e automação.
- Preservar a seleção de modelos Gemini dinâmica já existente e a retomada de etapas.

### 2. B-roll contextual e identidade visual

- Melhorar a relevância das buscas usando tema, época, pessoas, lugares e contexto de cada trecho; para assuntos históricos/filosóficos, priorizar referências visuais de época em vez de imagens genéricas desconectadas.
- Manter alternativas quando a mídia específica não estiver disponível, sem repetir mídia no mesmo vídeo e sem interromper a criação.
- Aplicar tratamento visual coerente (cor, contraste, textura/grão e vinheta quando apropriado), com movimentos sutis em imagens estáticas.
- Harmonizar ritmo e duração dos cortes com mudanças de ideia e locução, reduzindo dissoluções longas e evitando cortes que prejudiquem a compreensão.

### 3. Legendas dinâmicas e elementos conceituais

- Criar legendas temporizadas a partir da locução, com destaque progressivo de palavras-chave e estilos legíveis para vídeos horizontais, quadrados e Shorts.
- Inserir títulos e diagramas simples quando ajudarem a explicar conceitos, sem sobrecarregar as cenas.
- Exibir os mesmos elementos na prévia e no vídeo final, tanto no render do navegador quanto no render do GitHub Actions.

### 4. Integração e validação dos três fluxos

- Reutilizar regras e dados compartilhados sempre que possível, reduzindo diferenças entre criação manual/assistida, automação no navegador e GitHub Actions.
- Adicionar testes para orçamento do roteiro, pistas de pronúncia/pausas, planejamento de cenas/legendas e consistência dos parâmetros entre renderizadores.
- Validar o fluxo completo em cada modo: gerar roteiro, voz, visuais, edição, render e postagem; confirmar retomada após falha e preservar os controles já existentes.
- Entregar as fases incrementalmente, verificando cada uma antes de avançar para a seguinte.

## Detalhes técnicos

- O editor manual e o fluxo assistido usam `ProjectEditor.tsx`; a automação do navegador passa por `automationService.ts`; o GitHub Actions tem orquestração própria em `scripts/automation-runner.js`.
- Voz e resolução de visuais já compartilham serviços em partes dos fluxos, mas a geração de roteiro, o planejamento de cortes e a renderização ainda têm diferenças entre navegador e runner.
- A prévia do estúdio pode mostrar a fala por trecho, mas os renderizadores atuais não oferecem uma trilha de legendas dinâmicas nem diagramas conceituais incorporados ao vídeo.
- O plano mantém voz IA e não inclui clonagem, envio de gravações ou troca de provedor. Os detalhes de sincronização das legendas serão definidos para funcionar nos dois renderizadores sem depender de geração de imagens Gemini.