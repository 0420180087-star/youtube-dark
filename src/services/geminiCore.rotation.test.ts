import { describe, it, expect, vi, afterEach } from 'vitest';
import { executeGeminiRequest, setInjectedGeminiKeys, clearExhaustedKeys, MAX_ROTATION_ROUNDS } from './geminiCore';

const quotaErr = () => Object.assign(new Error('429 RESOURCE_EXHAUSTED'), { status: 429 });

afterEach(() => { vi.useRealTimers(); clearExhaustedKeys(); });

describe('rotação de chaves Gemini sem cota', () => {
  it('para após 3 rodadas com 2 chaves (6 chamadas) e lança erro de cota, sem loop infinito', async () => {
    vi.useFakeTimers();
    setInjectedGeminiKeys(['AIzaKEY_AAAAAAAAAAAAAAAAAAAAA1', 'AIzaKEY_BBBBBBBBBBBBBBBBBBBBB2']);
    let calls = 0;
    const p = executeGeminiRequest(async () => { calls++; throw quotaErr(); });
    const settled = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    const err: any = await settled;
    expect(MAX_ROTATION_ROUNDS).toBe(3);
    expect(calls).toBe(6);
    expect(err.isQuotaExhausted).toBe(true);
  });
});
