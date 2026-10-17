/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures de JSON de forma livre */
import { describe, it, expect } from 'vitest';
import {
  getScriptBudget,
  countWords,
  countScriptWords,
  isScriptOverBudget,
  condenseTargetWords,
  perSegmentWordLimits,
  buildCondensePrompt,
  parseCondensedScript,
  WORDS_PER_MINUTE,
} from './scriptBudget';

const words = (n: number) => Array.from({ length: n }, (_, i) => `palavra${i}`).join(' ');
const script = (counts: number[]): any => ({
  title: 'T',
  description: 'D',
  segments: counts.map((c, i) => ({
    sectionTitle: `Seção ${i + 1}`,
    narratorText: words(c),
    visualDescriptions: [`visual ${i + 1}`],
    estimatedDuration: 30,
  })),
});

describe('getScriptBudget — mesma tabela que o runner já usava', () => {
  it('mapeia cada rótulo de duração', () => {
    expect(getScriptBudget('Short (< 3 min)')).toEqual({ minWords: 100, maxWords: 450, segments: 4 });
    expect(getScriptBudget('Standard (5-8 min)')).toEqual({ minWords: 750, maxWords: 1200, segments: 7 });
    expect(getScriptBudget('Long (10-15 min)')).toEqual({ minWords: 1500, maxWords: 2250, segments: 12 });
    expect(getScriptBudget('Deep Dive (20+ min)')).toEqual({ minWords: 2250, maxWords: 3000, segments: 16 });
  });

  it('sem rótulo, usa o padrão Standard', () => {
    expect(getScriptBudget(undefined).maxWords).toBe(1200);
    expect(getScriptBudget('').maxWords).toBe(1200);
  });

  it('o limite de cada orçamento cabe na duração-alvo ao ritmo de 150 palavras/min', () => {
    expect(450 / WORDS_PER_MINUTE).toBe(3); // Short < 3 min
    expect(1200 / WORDS_PER_MINUTE).toBe(8); // Standard 5-8 min
  });
});

describe('contagem e estouro de orçamento', () => {
  it('conta palavras ignorando espaços extras e segmentos vazios', () => {
    expect(countWords('  um   dois\ntrês  ')).toBe(3);
    expect(countWords(undefined)).toBe(0);
    expect(countScriptWords(script([10, 0, 5]))).toBe(15);
    expect(countScriptWords(null)).toBe(0);
  });

  it('só considera estourado acima do máximo + 5% de folga', () => {
    const budget = getScriptBudget('Short (< 3 min)'); // máx. 450 → folga até 472
    expect(isScriptOverBudget(script([450]), budget)).toBe(false);
    expect(isScriptOverBudget(script([472]), budget)).toBe(false);
    expect(isScriptOverBudget(script([473]), budget)).toBe(true);
    expect(isScriptOverBudget(script([1500]), budget)).toBe(true); // o caso "10 min para alvo de 3 min"
  });
});

describe('condensação', () => {
  const budget = getScriptBudget('Short (< 3 min)');

  it('mira em 92% do máximo e reparte por segmento proporcionalmente', () => {
    expect(condenseTargetWords(budget)).toBe(414);
    const limits = perSegmentWordLimits(script([300, 100, 100]), 400);
    expect(limits).toEqual([240, 80, 80]);
    expect(perSegmentWordLimits(script([0, 0]), 400).every((l) => l >= 15)).toBe(true);
  });

  it('o prompt traz limite total, limites por segmento, nº de segmentos e o texto atual', () => {
    const p = buildCondensePrompt({ script: script([300, 100, 100]), budget, topic: 'O caso do farol', language: 'Portuguese (BR)', tone: 'Dark' });
    expect(p).toContain('"O caso do farol"');
    expect(p).toContain('Portuguese (BR)');
    expect(p).toContain('500 words');
    expect(p).toContain('AT MOST 450 words');
    expect(p).toContain('exactly 3 segments');
    expect(p).toContain('limit 248'); // 414 * 300/500
    expect(p).toContain('palavra0');
    expect(p).toContain('never stop mid-thought');
  });

  it('parseCondensedScript mescla só o texto e preserva títulos e descrições visuais', () => {
    const original = script([300, 100]);
    const raw = { segments: [{ narratorText: words(150), estimatedDuration: 999 }, { narratorText: words(50) }] };
    const out = parseCondensedScript(raw, original)!;
    expect(out).not.toBeNull();
    expect(countScriptWords(out)).toBe(200);
    expect(out.segments![0].sectionTitle).toBe('Seção 1');
    expect((out.segments![0] as any).visualDescriptions).toEqual(['visual 1']);
    expect(out.segments![0].estimatedDuration).toBe(60); // 150 palavras / 150 wpm = 1 min (recalculado, ignora o 999 da IA)
    expect(out.segments![1].estimatedDuration).toBe(20); // 50 palavras = 20 s
    expect(original.segments[0].narratorText).toBe(words(300)); // não muta o original
  });

  it('rejeita respostas inutilizáveis', () => {
    const original = script([300, 100]);
    expect(parseCondensedScript(null, original)).toBeNull();
    expect(parseCondensedScript({}, original)).toBeNull();
    expect(parseCondensedScript({ segments: [{ narratorText: 'x' }] }, original)).toBeNull(); // nº de segmentos diferente
    expect(parseCondensedScript({ segments: [{ narratorText: words(10) }, { narratorText: '   ' }] }, original)).toBeNull(); // segmento esvaziado
  });
});
