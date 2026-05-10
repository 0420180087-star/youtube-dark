# Limpeza & Refatoração

Análise feita em `src/`, `scripts/` e `supabase/functions/` (≈13.8k linhas). Encontrei código morto concreto e várias oportunidades de refatoração de baixo risco.

## 1. Arquivos / símbolos para REMOVER

| Caminho | Motivo |
|---|---|
| `src/pages/Index.tsx` | Não importado em lugar algum, não está nas rotas de `App.tsx`. |
| `src/pages/NotFound.tsx` | Sem rota catch-all `*` — nunca é renderizado. |
| `src/test/example.test.ts` | Teste placeholder (`expect(true).toBe(true)`). |
| `playwright.config.ts` + `playwright-fixture.ts` + dep `@playwright/test` | Nenhum teste Playwright existe em `src/`. |
| `generateFullMetadata` + `FullMetadataResult` em `thumbnailDescriptionService.ts` (linhas 1086‑1098) | Exportados mas nunca importados; `geminiCore` chama as 3 funções base diretamente. |
| `getPexelsKey` re‑export em `geminiPexels.ts` | Comentário diz "legacy callers" — nenhum chamador legado restante; importam de `pexelsService` direto. |

Decisão a tomar: adicionar uma rota catch‑all `<Route path="*" element={<NotFound/>} />` **ou** deletar `NotFound.tsx`. Recomendo manter (UX melhor) adicionando a rota.

## 2. Refatorações de funções (sem mudar comportamento)

### 2a. `AuthContext.tsx` (422 linhas)
- O bloco `useEffect` de inicialização tem 4 padrões repetidos `localStorage.getItem` → `decryptData` → `JSON.parse` → `try/catch removeItem`. Extrair helper `loadEncryptedJSON<T>(key)` em `securityService.ts`.
- Lógica de "tentar refresh-token + fallback para token cacheado validado" (linhas ~70‑130) e `refreshYouTubeToken` duplicam a chamada `fetch /functions/v1/refresh-token`. Extrair `callRefreshToken(projectId, email)` num módulo `services/youtubeAuthService.ts`.
- `setYoutubeToken` e o trecho de refresh repetem `encryptData` + `localStorage.setItem('ds_youtube_access_token', ...)`. Extrair `persistAccessToken(token)`.

### 2b. `geminiService.ts` barrel
- Já é um barrel limpo, mas `geminiPexels.ts` re‑exporta `getPexelsKey` redundantemente. Simplificar.

### 2c. Arquivos gigantes (não dividir agora, apenas marcar)
`ProjectEditor.tsx` (1921), `ProjectHub.tsx` (1626), `thumbnailDescriptionService.ts` (1098), `geminiCore.ts` (1093), `automationService.ts` (681). Refatoração em larga escala fica fora deste passo — proponho fazer em PRs futuros, um por vez, para evitar regressões. **Posso fazer um deles agora se você priorizar.**

### 2d. `ProjectContext.tsx` (679 linhas)
- Verificar (no próximo passo) se há listeners/subscriptions duplicadas. Não toquei agora pra manter o escopo enxuto.

## 3. O que NÃO vou mexer

- Edge Functions (`exchange-code`, `refresh-token`) — funcionando, fora de escopo.
- `scripts/automation-runner.js` — recém‑refatorado.
- Componentes shadcn/ui — gerados, mantém.

## 4. Validação

Após cada bloco: build do Vite + checagem de imports quebrados via `tsc --noEmit` automático do harness.

---

## Confirmações antes de executar

1. Deleto `playwright*` + dep, ou você usa em CI externa?
2. Adiciono rota catch‑all com `NotFound`, ou deleto `NotFound.tsx`?
3. Quer que eu já comece a quebrar **um** dos arquivos gigantes (qual: `ProjectEditor`, `ProjectHub`, `thumbnailDescriptionService`, `geminiCore`)?
