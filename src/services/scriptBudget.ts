/**
 * Script Budget — o roteiro precisa CABER na duração-alvo ANTES de ser narrado.
 *
 * Por que existe: o runner pedia ao Gemini "entre N e M palavras", mas nunca
 * conferia se o roteiro obedeceu. Um roteiro de 10 min para um alvo de 3 min
 * era narrado por inteiro e, na hora de montar o vídeo, a narração era cortada
 * no ponto em que os visuais (planejados pelo alvo) acabavam. Agora o roteiro é
 * conferido e, se estourar o limite, é CONDENSADO pela IA (com final de
 * verdade) — nunca cortado.
 *
 * Funções PURAS (sem Node/DOM): testadas em scriptBudget.test.ts.
 */

export interface ScriptBudget {
  minWords: number;
  maxWords: number;
  segments: number;
}

/** Ritmo de fala usado no prompt do roteiro (palavras por minuto). */
export const WORDS_PER_MINUTE = 150;

/** Folga aceita acima do limite antes de condensar (5%). */
export const SCRIPT_OVERRUN_GRACE = 1.05;

/** Quanto do limite a versão condensada deve mirar (92% do máximo). */
const CONDENSE_TARGET_RATIO = 0.92;

/**
 * Orçamento de palavras por duração. Mesma tabela que o runner usava dentro
 * do stepScript — agora numa fonte única e testável.
 */
export function getScriptBudget(durationLabel?: string): ScriptBudget {
  const dur = (durationLabel || 'Standard (5-8 min)').toLowerCase();
  if (dur.includes('short') || dur.includes('< 3')) return { minWords: 100, maxWords: 450, segments: 4 };
  if (dur.includes('long') || dur.includes('10-15')) return { minWords: 1500, maxWords: 2250, segments: 12 };
  if (dur.includes('deep') || dur.includes('20+')) return { minWords: 2250, maxWords: 3000, segments: 16 };
  return { minWords: 750, maxWords: 1200, segments: 7 };
}

export const countWords = (text: unknown): number =>
  String(text || '').split(/\s+/).filter(Boolean).length;

interface ScriptLike {
  segments?: Array<{ narratorText?: string; sectionTitle?: string; estimatedDuration?: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

export const countScriptWords = (script: ScriptLike | null | undefined): number =>
  (script?.segments || []).reduce((sum, s) => sum + countWords(s?.narratorText), 0);

/** O roteiro passou do limite (com a folga de 5%)? */
export const isScriptOverBudget = (
  script: ScriptLike | null | undefined,
  budget: ScriptBudget,
  grace: number = SCRIPT_OVERRUN_GRACE
): boolean => countScriptWords(script) > Math.floor(budget.maxWords * grace);

/** Quantas palavras a versão condensada deve ter, no total. */
export const condenseTargetWords = (budget: ScriptBudget): number =>
  Math.max(budget.minWords, Math.round(budget.maxWords * CONDENSE_TARGET_RATIO));

/** Limite de palavras por segmento, proporcional ao tamanho atual de cada um. */
export function perSegmentWordLimits(script: ScriptLike, targetWords: number): number[] {
  const counts = (script.segments || []).map((s) => countWords(s?.narratorText));
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  return counts.map((c) => Math.max(15, Math.floor((targetWords * c) / total)));
}

export function buildCondensePrompt(params: {
  script: ScriptLike;
  budget: ScriptBudget;
  topic: string;
  language?: string;
  tone?: string;
}): string {
  const { script, budget, topic } = params;
  const segments = script.segments || [];
  const words = countScriptWords(script);
  const target = condenseTargetWords(budget);
  const limits = perSegmentWordLimits(script, target);

  const current = segments
    .map(
      (s, i) =>
        `[${i + 1}] ${s.sectionTitle || `Section ${i + 1}`} (${countWords(s.narratorText)} words — limit ${limits[i]})\n${String(s.narratorText || '').trim()}`
    )
    .join('\n\n');

  return `You are editing a YouTube narration script that is TOO LONG for its target duration.

Topic: "${topic}"
Language: ${params.language || 'en'} (keep the script in this language)
Narrative tone: ${params.tone || 'Engaging'}

The narration has ${words} words, but it MUST have AT MOST ${budget.maxWords} words in total (aim for about ${target}) so the finished video fits its target duration WITHOUT being cut.

RULES:
- Rewrite ONLY the narratorText of each segment, making it shorter. Keep exactly ${segments.length} segments, in the same order.
- Respect each segment's word limit shown below and the ${budget.maxWords}-word total.
- Remove repetition, filler and secondary details first. Keep the hook, the key facts and a REAL conclusion: the story must feel complete and end properly — never stop mid-thought.
- Keep it full, spoken, word-for-word narration (no bullet points, no summaries of what the segment would say).
- estimatedDuration of each segment = its words / ${WORDS_PER_MINUTE} * 60 (seconds).

CURRENT SEGMENTS:
${current}

Return ONLY valid JSON (no markdown) in exactly this shape:
{ "segments": [ { "narratorText": "...", "estimatedDuration": 30 } ] }`;
}

/**
 * Valida a resposta da condensação e a mescla no roteiro original. Só o texto
 * (e a duração estimada, recalculada pelas palavras) muda: títulos de seção e
 * descrições visuais do original são preservados, então os visuais continuam
 * coerentes. Devolve null se a resposta não for utilizável.
 */
export function parseCondensedScript<T extends ScriptLike>(raw: unknown, original: T): T | null {
  const candidate = (raw as ScriptLike | null | undefined)?.segments;
  const originalSegments = original?.segments || [];
  if (!Array.isArray(candidate) || candidate.length !== originalSegments.length || candidate.length === 0) return null;

  const segments = originalSegments.map((seg, i) => {
    const text = String(candidate[i]?.narratorText || '').trim();
    return { ...seg, narratorText: text, estimatedDuration: Math.max(2, Math.round((countWords(text) / WORDS_PER_MINUTE) * 60)) };
  });
  // Segmento que tinha texto e voltou vazio = resposta ruim.
  if (segments.some((s, i) => countWords(originalSegments[i]?.narratorText) > 0 && countWords(s.narratorText) === 0)) return null;

  return { ...original, segments };
}
