## Resultado da auditoria

Sintaxe dos 3 scripts (`automation-runner.js`, `videoRenderer.js`, `youtubeUploader.js`) está OK (`node --check` passa). Mas encontrei **4 bugs reais** que vão derrubar o pipeline antes do upload — em especial o nº 1, que impede qualquer projeto de ser processado.

### Bugs encontrados

**1. Lock RPC com tipo errado (BLOQUEADOR)** — `supabase/migrations/003_autopilot_lock.sql` define `acquire_autopilot_lock(p_project_id uuid, …)` e `release_autopilot_lock(p_project_id uuid)`, mas:
- `projects.id` é **TEXT** (não uuid)
- O runner passa `String(projectId)` (linha 519 de `automation-runner.js`)
- Resultado: Postgres rejeita o cast → `lockError` → `processProject` retorna `false` para **todo projeto** → nada é postado.

**2. Upload de thumbnail com encoding errado** — `scripts/youtubeUploader.js` (linhas 83-101) envia a thumbnail como `multipart/form-data`, mas o endpoint `youtube/v3/thumbnails/set` espera o **corpo bruto** com `Content-Type: image/jpeg`. Sempre falha silenciosamente (sem checar `res.ok`). A thumbnail nunca é aplicada no vídeo automático.

**3. Workflows duplicados** — Existem dois arquivos `auto-post.yml`: `.github/workflows/` (Node 22, correto) e `workflows/` (Node 20, sem o fix do `ws`). O segundo é dead code, mas confunde — se alguém mover, quebra. Apagar.

**4. `.single()` em `project_auth`** — Linha 483 de `automation-runner.js` usa `.single()` na busca do refresh token. Se não houver linha (projeto recém-criado), lança exceção genérica em vez da mensagem clara "reconecte YouTube". Trocar por `.maybeSingle()`.

### Outros pontos verificados (OK)

- ENV vars do workflow alinhadas com o runner (`SUPABASE_SERVICE_KEY`, `YOUTUBE_CLIENT_SECRET`, etc.)
- Node 22 já tem WebSocket nativo + fallback `ws` configurado
- Pipeline 8 steps presente: idea → script → voice (TTS) → visuals → thumbnail → metadata → render → upload
- Fluxo de refresh token via `project_auth` está correto (com fallback p/ legacy `projectData.youtubeRefreshToken`)
- `release_autopilot_lock` no `finally` — não fica travado em crash

### Plano de correção

**Arquivo: nova migration `supabase/migrations/004_fix_autopilot_lock_types.sql`**
```sql
-- Recria os RPCs com p_project_id TEXT (compatível com projects.id)
drop function if exists acquire_autopilot_lock(uuid, text, int);
drop function if exists release_autopilot_lock(uuid);

create or replace function acquire_autopilot_lock(
    p_project_id text,
    p_locked_by  text,
    p_lock_minutes int default 90
) returns boolean language plpgsql security definer as $$
declare v_updated int;
begin
    update projects
    set autopilot_locked_until = now() + (p_lock_minutes || ' minutes')::interval,
        autopilot_locked_by    = p_locked_by,
        updated_at             = now()
    where id = p_project_id
      and (autopilot_locked_until is null or autopilot_locked_until < now());
    get diagnostics v_updated = row_count;
    return v_updated > 0;
end; $$;

create or replace function release_autopilot_lock(p_project_id text)
returns void language plpgsql security definer as $$
begin
    update projects set autopilot_locked_until = null, autopilot_locked_by = null,
        updated_at = now() where id = p_project_id;
end; $$;
```
Você precisará rodar esse SQL no **SQL Editor do Supabase Dashboard** (igual fizemos com `project_auth`).

**Arquivo: `scripts/youtubeUploader.js`** — reescrever `uploadThumbnail` para enviar o buffer bruto + checar `res.ok`:
```js
const res = await fetch(
  `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`,
  { method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'image/jpeg' },
    body: buffer });
if (!res.ok) { const t = await res.text(); console.warn('thumbnail falhou:', res.status, t); }
```
Remover import `form-data` (deixa de ser usado).

**Arquivo: `scripts/automation-runner.js`** — linha 483: `.single()` → `.maybeSingle()`.

**Apagar:** `workflows/auto-post.yml` e `workflows/deploy.yml` (diretório `workflows/` na raiz — duplicata).

### Como validar depois

1. Aprovar este plano → eu aplico as 3 edições + crio a migration.
2. Você roda o SQL da migration 004 no Supabase.
3. GitHub → Actions → "Auto Post Video" → **Run workflow** (pode deixar `project_id` vazio ou preencher com um ID específico).
4. Me cola o log. Com os 4 bugs corrigidos, o fluxo deve chegar até o upload + thumbnail aplicada.

### Observação sobre auditoria estática vs teste real

Não consigo executar o runner aqui (sem `SUPABASE_SERVICE_KEY`, `YOUTUBE_CLIENT_SECRET`, sem `ffmpeg` rodando no contexto do projeto, e sem permissão de fazer upload real para o seu canal). A parte de "ambos" será: agora eu corrijo → você dispara no GitHub Actions → log volta pra mim.
