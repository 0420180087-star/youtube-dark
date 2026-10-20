/**
 * Funções puras para usar o ID do projeto na EXECUÇÃO FORÇADA do GitHub Actions.
 * (Ficam fora de components/ProjectIdTools.tsx para não atrapalhar o fast refresh do React.)
 */

/** Copia para a área de transferência (Clipboard API; se não houver, usa um textarea temporário). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* sem permissão: tenta o plano B */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Link da página do workflow "Auto Post Video" no GitHub, deduzido de onde o app está hospedado
 * (https://<dono>.github.io/<repositório>/). Fora do GitHub Pages devolve null.
 */
export function getAutoPostWorkflowUrl(
  opts: { hostname?: string; baseUrl?: string } = {}
): string | null {
  const hostname = opts.hostname ?? (typeof window !== 'undefined' ? window.location.hostname : '');
  const baseUrl = opts.baseUrl ?? import.meta.env.BASE_URL ?? '/';
  const owner = /^([a-z0-9-]+)\.github\.io$/i.exec(hostname)?.[1];
  const repo = baseUrl.split('/').filter(Boolean)[0];
  if (!owner || !repo) return null;
  return `https://github.com/${owner}/${repo}/actions/workflows/auto-post.yml`;
}

/** ID abreviado para caber em chips: 68e2148b…a123a */
export const shortId = (id: string) => (id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-5)}` : id);
