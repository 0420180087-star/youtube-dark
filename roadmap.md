# Roadmap — automação (plano 2026-09-09)

## Melhorias de criação de vídeos (plano aprovado 2026-11-08)
- [ ] Fase 1: roteiro conversacional e cadência/pronúncia IA consistentes nos três fluxos
- [ ] Fase 2: B-roll temático, ritmo de cortes e tratamento cinematográfico coerentes
- [ ] Fase 3: legendas temporizadas com destaque, títulos e diagramas conceituais nos dois renderizadores
- [ ] Fase 4: testes e validação da criação manual/assistida, automação no navegador e GitHub Actions

- [x] F1 Settings: Salvar só confirma com leitura de volta
- [ ] F1 AutomationHealth: e-mail + contagem de chaves
- [x] F2 Runner: stepIdea sem duplicata (similaridade, fallback variado, STANDBY curto)
- [x] F2 Runner: retomar vídeos órfãos (DRAFT/SCRIPTING/AUDIO/VIDEO_GENERATED)
- [x] F2 Runner: renovar lock por etapa + claim de nextScheduledRun no início
- [x] F2 ProjectContext: Executar agora em modo único, sem liberar lock à força, agenda antes
- [ ] F2 Scheduler: órfãos com Retomar/Descartar
- [~] F3 automationService: (feito: música com retry, narrationSpeed; pendente: AbortSignal, render/upload separados) música com retry, narrationSpeed de volta, render/upload separados
- [ ] F3 ProjectContext: cancelAutoPilot, log remoto do navegador
- [ ] F3 Thumbnail brief (navegador + runner)
- [ ] F3 UI: painel de etapas, Retomar/Cancelar/Refazer
