/* eslint-disable @typescript-eslint/no-explicit-any -- projects.data é um JSON de forma livre; o merge precisa tratá-lo de forma genérica */
/**
 * Project Sync — mescla de 3 vias entre o estado local, a nuvem e a "base".
 *
 * PROBLEMA QUE RESOLVE
 * O projeto inteiro (vídeos, ideias, biblioteca, agenda…) vive em UMA linha JSON
 * (projects.data). Dois escritores independentes gravam nela:
 *   • o app no navegador (grava o projeto inteiro a cada alteração);
 *   • o runner do GitHub Actions (lê a linha UMA vez, trabalha 20–50 min e
 *     regrava o projeto inteiro a cada etapa).
 * Sem mesclagem, quem grava por último apaga o que o outro fez: vídeos criados
 * pela automação sumiam do projeto (e com eles fase, ideias usadas e novas
 * ideias do Brainstorm) ou o runner apagava edições feitas no app.
 *
 * COMO RESOLVE
 *   base   = último estado da nuvem que este escritor VIU (leu ou gravou);
 *   local  = o que este escritor quer gravar;
 *   remote = o que está na nuvem AGORA.
 * Cada item (vídeo/ideia/biblioteca, por id) e cada campo é decidido assim:
 *   só o outro mudou → fica a versão da nuvem;
 *   só eu mudei       → fica a minha;
 *   os dois mudaram   → vence a mais recente (updatedAt); empate → a minha.
 * Item novo do outro escritor é ADICIONADO; item que EU apaguei continua apagado.
 *
 * Funções puras: sem React, sem Supabase, sem APIs de Node/DOM — o mesmo código
 * roda no app e no runner e é testado em projectSync.test.ts.
 */

type AnyRecord = Record<string, any>;

// ---------------------------------------------------------------------------
// Marcadores de blobs na nuvem
// O app grava "__has_audio__", "__has_image__"…; o runner grava
// "__runner_audio__", "__runner_image__"… Nenhum deles é uma URL real.
// ---------------------------------------------------------------------------

export const isCloudPlaceholder = (value: unknown): value is string =>
  typeof value === 'string' && (value.startsWith('__has_') || value.startsWith('__runner_'));

/** URL de imagem que o navegador consegue exibir (descarta marcadores da nuvem). */
export const isUsableImageUrl = (value?: string | null): value is string =>
  typeof value === 'string' && value.length > 0 && !isCloudPlaceholder(value);

// ---------------------------------------------------------------------------
// Assinatura estável (para saber se algo mudou)
// ---------------------------------------------------------------------------

function canonical(value: any): any {
  if (typeof value === 'string') return isCloudPlaceholder(value) ? '__blob__' : value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: AnyRecord = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined) continue; // undefined == ausente (o JSON também descarta)
      out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/**
 * Assinatura independente da ordem das chaves, tratando `undefined` como
 * ausente e qualquer marcador de blob ("__has_*" / "__runner_*") como
 * equivalente — assim app e runner não "brigam" por causa do nome do marcador.
 */
export const stableSignature = (value: unknown): string => JSON.stringify(canonical(value)) ?? 'undefined';

export const cloneJson = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

// ---------------------------------------------------------------------------
// Merge de listas por id
// ---------------------------------------------------------------------------

interface MergeByIdOptions {
  /** ids que este escritor "possui" agora (ex.: o vídeo que o runner está gerando): a versão local sempre vence. */
  owned?: Set<string>;
  /** onde entram os itens novos vindos da nuvem. Vídeos/biblioteca: início. Ideias: fim. */
  addAt: 'start' | 'end';
  /** descarta item novo da nuvem cujo tópico já existe localmente (ideias). */
  dedupeTopic?: boolean;
}

const firstById = (list: any[]): Map<string, any> => {
  const map = new Map<string, any>();
  for (const item of list) {
    const id = item?.id;
    if (id && !map.has(id)) map.set(id, item);
  }
  return map;
};

const stamp = (item: any): number => Date.parse(item?.updatedAt || '') || 0;
// Ideias não têm updatedAt: nunca deixar uma cópia velha reverter "used"/"dismissed" para "new"
// (isso faria a mesma ideia virar vídeo duas vezes).
const IDEA_STATUS_RANK: Record<string, number> = { new: 0, dismissed: 1, used: 2 };
const newer = (local: any, remote: any) => {
  const ls = stamp(local);
  const rs = stamp(remote);
  if (ls || rs) return rs > ls ? remote : local;
  const lr = IDEA_STATUS_RANK[local?.status] ?? -1;
  const rr = IDEA_STATUS_RANK[remote?.status] ?? -1;
  return rr > lr ? remote : local;
};
const topicKey = (item: any) => String(item?.topic || '').trim().toLowerCase();

function mergeById(base: any, local: any, remote: any, opts: MergeByIdOptions): any[] {
  const L: any[] = Array.isArray(local) ? local : [];
  const R: any[] = Array.isArray(remote) ? remote : [];
  const B: any[] = Array.isArray(base) ? base : [];
  const lMap = firstById(L);
  const rMap = firstById(R);
  const bMap = firstById(B);

  const out: any[] = [];
  const emitted = new Set<string>();

  for (const l of L) {
    const id = l?.id;
    if (!id) {
      out.push(l); // sem id não dá para rastrear: nunca descartar dado
      continue;
    }
    if (emitted.has(id)) continue; // também remove duplicatas (bug antigo do merge de carga)
    emitted.add(id);

    const own = lMap.get(id);
    const b = bMap.get(id);
    const r = rMap.get(id);

    if (opts.owned?.has(id)) {
      out.push(own);
    } else if (!r) {
      // Não existe na nuvem.
      if (!b) out.push(own); // criado aqui
      else if (stableSignature(own) !== stableSignature(b)) out.push(own); // removido lá, mas editado aqui → preserva
      // removido lá e intocado aqui → continua removido
    } else if (!b) {
      out.push(newer(own, r)); // existe nos dois e não há base: fica o mais recente
    } else {
      const lc = stableSignature(own) !== stableSignature(b);
      const rc = stableSignature(r) !== stableSignature(b);
      if (lc && rc) out.push(newer(own, r));
      else if (rc) out.push(r);
      else out.push(own);
    }
  }

  // Itens que só existem na nuvem.
  const additions: any[] = [];
  const existingTopics = new Set(out.map(topicKey));
  for (const r of R) {
    const id = r?.id;
    if (!id || emitted.has(id) || lMap.has(id)) continue;
    emitted.add(id);
    const b = bMap.get(id);
    const isNewFromRemote = !b;
    const editedRemotelyAfterLocalDelete = !!b && stableSignature(r) !== stableSignature(b);
    if (!isNewFromRemote && !editedRemotelyAfterLocalDelete) continue; // apagado aqui e intocado lá → continua apagado
    if (opts.dedupeTopic && isNewFromRemote && existingTopics.has(topicKey(r))) continue;
    additions.push(r);
    existingTopics.add(topicKey(r));
  }

  return opts.addAt === 'start' ? [...additions, ...out] : [...out, ...additions];
}

function mergeStrings(base: any, local: any, remote: any): string[] {
  const L: string[] = Array.isArray(local) ? local : [];
  const R: string[] = Array.isArray(remote) ? remote : [];
  const B = new Set<string>(Array.isArray(base) ? base : []);
  const seen = new Set<string>(L);
  const out = [...L];
  for (const item of R) {
    if (!seen.has(item) && !B.has(item)) {
      out.push(item);
      seen.add(item);
    }
  }
  return out;
}

const isPlainObject = (v: unknown): v is AnyRecord => !!v && typeof v === 'object' && !Array.isArray(v);

/** Valor simples: mudei eu → o meu; mudou só a nuvem → o da nuvem. */
function pickValue(base: any, local: any, remote: any): any {
  const baseSig = stableSignature(base);
  if (stableSignature(local) !== baseSig) return local;
  if (stableSignature(remote) !== baseSig) return remote;
  return local;
}

/** Objeto simples (ex.: scheduleSettings): decide campo a campo. */
function mergeFields(base: any, local: AnyRecord, remote: AnyRecord): AnyRecord {
  const out: AnyRecord = {};
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  keys.forEach((key) => {
    const value = pickValue(isPlainObject(base) ? base[key] : undefined, local[key], remote[key]);
    if (value !== undefined) out[key] = value;
  });
  return out;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export interface MergeOptions {
  /** Vídeos que este escritor está produzindo agora: a versão local sempre vence. */
  ownedVideoIds?: Iterable<string>;
  /** Ideias que este escritor criou/consumiu agora: a versão local sempre vence. */
  ownedIdeaIds?: Iterable<string>;
}

// Colunas de runtime (lock) — não fazem parte de projects.data e nunca são mescladas.
const RUNTIME_KEYS = new Set(['autopilotLockedUntil', 'autopilotLockedBy']);

/**
 * Mescla `local` (o que quero gravar) com `remote` (o que está na nuvem agora)
 * usando `base` (o que eu vi da última vez) como ancestral comum.
 * Sem `remote` devolve `local`. Sem `base` o resultado é a UNIÃO dos dois lados
 * (nunca perde dado); em conflito de campo simples vence o local.
 */
export function mergeProjectData<T extends AnyRecord>(
  base: AnyRecord | null | undefined,
  local: T,
  remote: AnyRecord | null | undefined,
  opts: MergeOptions = {}
): T {
  if (!remote) return local;
  const b = base || undefined;
  const ownedVideos = new Set(opts.ownedVideoIds || []);
  const ownedIdeas = new Set(opts.ownedIdeaIds || []);
  const out: AnyRecord = {};
  const keys = new Set<string>([...Object.keys(local || {}), ...Object.keys(remote)]);

  keys.forEach((key) => {
    if (RUNTIME_KEYS.has(key)) {
      if (local && key in local) out[key] = (local as AnyRecord)[key];
      return;
    }
    const lv = (local as AnyRecord)?.[key];
    const rv = remote[key];
    const bv = b?.[key];
    let value: any;

    if (key === 'videos') value = mergeById(bv, lv, rv, { owned: ownedVideos, addAt: 'start' });
    else if (key === 'ideas') value = mergeById(bv, lv, rv, { owned: ownedIdeas, addAt: 'end', dedupeTopic: true });
    else if (key === 'library') value = mergeById(bv, lv, rv, { addAt: 'start' });
    else if (key === 'usedIdeas') value = mergeStrings(bv, lv, rv);
    else if (isPlainObject(lv) && isPlainObject(rv)) value = mergeFields(bv, lv, rv);
    else value = pickValue(bv, lv, rv);

    if (value !== undefined) out[key] = value;
  });

  return out as T;
}

/**
 * Devolve ao projeto mesclado (forma "leve" da nuvem) os blobs reais que esta
 * máquina guarda localmente (áudio, música, miniaturas, imagens das cenas).
 *
 *  • "__has_*"    (gravado pelo app): comportamento original — vira o valor
 *                 local, mesmo que não exista (blob de outro dispositivo).
 *  • "__runner_*" (gravado pelo runner): vira o valor local se existir; senão o
 *                 marcador permanece, para a fase continuar contando como feita.
 */
export function restoreCloudBlobs<T extends AnyRecord>(merged: T, local?: AnyRecord | null): T {
  if (!local || !Array.isArray(merged?.videos)) return merged;
  const localVideos = firstById(Array.isArray(local.videos) ? local.videos : []);

  const restore = (cloudValue: any, localValue: any) => {
    if (typeof cloudValue !== 'string') return cloudValue;
    if (cloudValue.startsWith('__has_')) return localValue;
    if (cloudValue.startsWith('__runner_')) return localValue && !isCloudPlaceholder(localValue) ? localValue : cloudValue;
    return cloudValue;
  };

  const videos = merged.videos.map((rv: AnyRecord) => {
    const lv = localVideos.get(rv?.id);
    if (!lv) return rv;
    return {
      ...rv,
      audioUrl: restore(rv.audioUrl, lv.audioUrl),
      backgroundMusicUrl: restore(rv.backgroundMusicUrl, lv.backgroundMusicUrl),
      thumbnailUrl: restore(rv.thumbnailUrl, lv.thumbnailUrl),
      visualScenes: rv.visualScenes?.map((rs: AnyRecord) => {
        if (!isCloudPlaceholder(rs?.imageUrl)) return rs;
        const ls = lv.visualScenes?.find(
          (s: AnyRecord) => s.startTime === rs.startTime && s.segmentIndex === rs.segmentIndex
        );
        return { ...rs, imageUrl: restore(rs.imageUrl, ls?.imageUrl) };
      }),
    };
  });

  return { ...merged, videos };
}

// ---------------------------------------------------------------------------
// Gravação segura (usada pelo runner)
// ---------------------------------------------------------------------------

export interface ProjectStore {
  read(projectId: string): Promise<{ data: AnyRecord | null; error?: string | null }>;
  write(projectId: string, data: AnyRecord): Promise<{ error?: string | null }>;
}

export interface PersistState {
  /** Última versão da nuvem vista por este escritor (lida ou gravada). */
  base?: AnyRecord;
  ownedVideoIds: Set<string>;
  ownedIdeaIds: Set<string>;
}

export function createPersistState(initialRow: AnyRecord | null | undefined): PersistState {
  return {
    base: initialRow ? cloneJson(initialRow) : undefined,
    ownedVideoIds: new Set<string>(),
    ownedIdeaIds: new Set<string>(),
  };
}

/** Substitui, no MESMO objeto, todo o conteúdo por `source` (mantém a referência que o chamador segura). */
export function replaceContents(target: AnyRecord, source: AnyRecord): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
  }
  for (const key of Object.keys(source)) target[key] = source[key];
}

/**
 * Grava `working` na nuvem SEM apagar o que o outro escritor fez desde a última
 * leitura: lê a linha atual, mescla e só então grava. Em caso de sucesso,
 * adota o resultado mesclado dentro de `working` (assim as próximas etapas já
 * enxergam o que mudou na nuvem) e avança a base.
 */
export async function persistMerged(
  store: ProjectStore,
  projectId: string,
  working: AnyRecord,
  state: PersistState
): Promise<{ ok: boolean; error?: string; merged: AnyRecord; readFailed?: boolean }> {
  let merged: AnyRecord = working;
  let readFailed = false;

  const current = await store.read(projectId);
  if (!current.error && current.data) {
    merged = mergeProjectData(state.base, working, current.data, {
      ownedVideoIds: state.ownedVideoIds,
      ownedIdeaIds: state.ownedIdeaIds,
    });
  } else if (current.error) {
    readFailed = true; // sem leitura não dá para mesclar: grava o que tem (comportamento antigo)
  }

  const written = await store.write(projectId, merged);
  if (written.error) return { ok: false, error: written.error, merged, readFailed };

  state.base = cloneJson(merged);
  if (merged !== working) replaceContents(working, merged);
  return { ok: true, merged: working, readFailed };
}
