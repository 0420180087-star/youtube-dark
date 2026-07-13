
## Causa raiz (reproduzida)

`src/pages/ProjectHub.tsx:15` define `statusConfig` só com 6 status: DRAFT, SCRIPTING, AUDIO_GENERATED, VIDEO_GENERATED, SCHEDULED, PUBLISHED.

O enum `ProjectStatus` em `src/types.ts` inclui **um sétimo: `STANDBY`** (adicionado quando um vídeo falha na automação e vai para reprocessamento manual).

No render da lista de vídeos:

```tsx
const status = statusConfig[video.status];         // undefined para STANDBY
// ...
className={`... ${status.bg} ${status.color} ${status.border}`}  // 💥 TypeError
```

Qualquer vídeo com `status === STANDBY` derruba o React na aba Videos do ProjectHub → tela branca **em todo projeto que tenha um vídeo em standby**. Como o vídeo "O Sacrifício Financeiro..." já está em STANDBY, todos os projetos do usuário com essa situação quebram — bate com "em todos os projetos, sempre".

## Correção definitiva

### 1. `src/pages/ProjectHub.tsx` — completar o `statusConfig`

- Adicionar entrada `STANDBY` (rótulo "Standby", laranja para indicar atenção) no mapa.
- Tornar o acesso à pragmática: `const status = statusConfig[video.status] ?? statusConfig[ProjectStatus.DRAFT];` — assim qualquer status futuro que for adicionado ao enum e esquecido no mapa **não derruba mais a página**, só cai num visual neutro. É a defesa que garante que o bug não volte.

### 2. `src/components/ProjectCard.tsx` — mesma proteção

- Verificar se este card também referencia `statusConfig` sem STANDBY (uso indireto na lista de projetos). Se sim, aplicar o mesmo `??` fallback.

### 3. Sem outras mudanças

- Não mexer no pipeline, no runner nem no SQL — o crash é puramente de render.

## Arquivos editados

- `src/pages/ProjectHub.tsx` — adicionar `STANDBY` ao `statusConfig` + fallback defensivo no acesso.
- `src/components/ProjectCard.tsx` — mesma verificação (só se estiver afetado).

## Validação

1. Abrir `/project/:id` de um projeto com vídeo em STANDBY → renderiza normalmente, mostrando o badge "Standby" laranja no card do vídeo.
2. Abrir projeto sem STANDBY → continua funcionando igual.
3. Reproduzir automatizado via Playwright com um vídeo mock `status: 'STANDBY'` para confirmar que não há mais `TypeError`.
