// geminiModelResolver — Descoberta DINÂMICA de modelos Gemini.
//
// O Google desliga modelos de tempos em tempos (ex.: `gemini-2.5-flash`
// "no longer available to new users" em 11/2026). Nomes fixos no código quebram
// a automação inteira quando isso acontece. Este módulo:
//   1. Consulta ListModels com a chave atual e escolhe o melhor modelo de TEXTO
//      disponível para `generateContent` (cache de 6h em memória + localStorage);
//   2. Mantém uma lista estática de reserva caso a descoberta falhe;
//   3. Expõe `markModelUnavailable`/`isModelUnavailableError` para que, ao ver um
//      404 de modelo, o chamador descarte o modelo e re-resolva o próximo.
//
// Não conhece chaves: o provedor de chaves é injetado por `setKeyProvider` (feito
// pelo geminiCore ao carregar) para evitar importação circular.

export const TEXT_MODEL_FALLBACKS = [
    'gemini-flash-latest',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
];

const TTS_MODEL_FALLBACKS = [
    'gemini-2.5-flash-preview-tts',
    'gemini-2.5-pro-preview-tts',
];

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_STORAGE_KEY = 'ds_gemini_model_cache_v1';
const LIST_TIMEOUT_MS = 15_000;

interface ModelCache {
    resolvedAt: number;
    textModel: string;
    ttsModel: string;
    excluded: string[];
}

let keyProvider: () => Promise<string[]> = async () => [];
let memoryCache: ModelCache | null = null;
let inflight: Promise<ModelCache> | null = null;

export function setKeyProvider(provider: () => Promise<string[]>): void {
    keyProvider = provider;
}

/** Erro de modelo indisponível: 404 "not found" / "no longer available", etc. */
export function isModelUnavailableError(err: any): boolean {
    if (!err) return false;
    const status = err.status || err.response?.status || err.error?.code || err.code;
    if (Number(status) === 404) return true;
    const msg = String(err.message || err.error?.message || '');
    return /no longer available|not found|is not supported|unsupported model|does not exist/i.test(msg) && /model|models\//i.test(msg);
}

/** Extrai o nome do modelo citado na mensagem de erro (ex.: "models/gemini-2.5-flash"). */
export function extractModelNameFromError(err: any): string | null {
    const msg = String(err?.message || err?.error?.message || '');
    const m = msg.match(/models\/([a-z0-9.\-]+)/i) || msg.match(/model ([a-z0-9.\-]+)/i);
    return m ? m[1] : null;
}

export function markModelUnavailable(model: string): void {
    const cache = readCache();
    const excluded = [...new Set([...(cache?.excluded || []), model])];
    if (cache) writeCache({ ...cache, excluded });
    else memoryCache = { resolvedAt: 0, textModel: '', ttsModel: '', excluded };
    // Invalida a escolha atual para forçar re-resolução na próxima chamada.
    memoryCache = null;
    try { localStorage.removeItem(CACHE_STORAGE_KEY); } catch { /* sem storage */ }
}

function readCache(): ModelCache | null {
    if (memoryCache) return memoryCache;
    try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(CACHE_STORAGE_KEY) : null;
        if (raw) memoryCache = JSON.parse(raw) as ModelCache;
    } catch { /* cache inválido */ }
    return memoryCache;
}

function writeCache(cache: ModelCache): void {
    memoryCache = cache;
    try { localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(cache)); } catch { /* sem storage */ }
}

/** Pontuação: flash > lite > pro; versão maior ganha; preview/exp perdem. */
function scoreTextModel(name: string): number {
    let s = 0;
    if (/lite/i.test(name)) s -= 4;
    if (/pro/i.test(name)) s -= 3;
    if (/preview|exp/i.test(name)) s -= 5;
    if (/flash/i.test(name)) s += 5;
    if (/-latest$/i.test(name)) s += 3;
    const ver = parseFloat((name.match(/gemini-(\d+(?:\.\d+)?)/i) || [])[1] || '0');
    s += ver * 2;
    return s;
}

function isExcluded(name: string, excluded: string[]): boolean {
    return excluded.some(e => name === e || name.startsWith(e));
}

function filterTextCandidates(names: string[]): string[] {
    return names.filter(n =>
        (n.includes('gemini') || n.includes('flash') || n.includes('pro')) &&
        !/tts|image|imagen|embedding|aqa|native-audio|live|veo|lyria|robotics|computer-use|gemini-(1\.0|1\.5)/i.test(n)
    );
}

function filterTtsCandidates(names: string[]): string[] {
    return names.filter(n => /tts/i.test(n) && !/gemini-(1\.0|1\.5)/i.test(n));
}

async function fetchModelNames(apiKey: string): Promise<string[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LIST_TIMEOUT_MS);
    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`,
            { signal: ctrl.signal },
        );
        if (!res.ok) throw new Error(`ListModels HTTP ${res.status}`);
        const data = await res.json();
        return (data.models || []).map((m: any) => String(m.name || '').replace(/^models\//, '')).filter(Boolean);
    } finally {
        clearTimeout(timer);
    }
}

async function resolveBoth(): Promise<ModelCache> {
    const cache = readCache();
    const excluded = cache?.excluded || [];
    let names: string[] = [];
    try {
        const keys = await keyProvider();
        for (const key of keys.slice(0, 2)) {
            try { names = await fetchModelNames(key); break; } catch { /* próxima chave */ }
        }
    } catch { /* sem chaves — usa fallback estático */ }

    const textCandidates = filterTextCandidates(names)
        .filter(n => !isExcluded(n, excluded))
        .sort((a, b) => scoreTextModel(b) - scoreTextModel(a));
    const ttsCandidates = filterTtsCandidates(names)
        .filter(n => !isExcluded(n, excluded))
        .sort((a, b) => scoreTextModel(b) - scoreTextModel(a));

    const textModel = textCandidates[0]
        || TEXT_MODEL_FALLBACKS.find(n => !isExcluded(n, excluded))
        || TEXT_MODEL_FALLBACKS[0];
    const ttsModel = ttsCandidates[0]
        || TTS_MODEL_FALLBACKS.find(n => !isExcluded(n, excluded))
        || TTS_MODEL_FALLBACKS[0];

    const fresh: ModelCache = { resolvedAt: Date.now(), textModel, ttsModel, excluded };
    writeCache(fresh);
    return fresh;
}

async function getCache(): Promise<ModelCache> {
    const cache = readCache();
    if (cache && Date.now() - cache.resolvedAt < CACHE_TTL_MS && cache.textModel) return cache;
    if (!inflight) {
        inflight = resolveBoth().finally(() => { inflight = null; });
    }
    return inflight;
}

/** Modelo de TEXTO atual (generateContent), resolvido dinamicamente. */
export async function getTextModel(): Promise<string> {
    return (await getCache()).textModel;
}

/** Modelo de TTS atual, resolvido dinamicamente. */
export async function getTtsModel(): Promise<string> {
    return (await getCache()).ttsModel;
}
