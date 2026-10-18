/* eslint-disable @typescript-eslint/no-explicit-any -- fakes e fixtures de forma livre */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  gemini: vi.fn(),
  composed: vi.fn(),
  simple: vi.fn(),
}));

// Só as 3 funções de thumbnail são simuladas; o resto do geminiService continua real.
vi.mock('./geminiService', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  generateGeminiThumbnail: h.gemini,
  generateComposedThumbnail: h.composed,
  generateThumbnail: h.simple,
}));

import { stepGenerateThumbnail } from './automationService';

const project: any = { id: 'p1', channelTheme: 'Crimes reais', defaultTone: 'Dark', language: 'Portuguese (BR)', library: [] };
const video: any = { id: 'v1', title: 'A LEI SANGRENTA', visualScenes: [{ imageUrl: 'https://x/y.jpg' }] };
const script: any = { segments: [{ narratorText: 'Era uma noite fria.' }, { narratorText: 'A lei mudou.' }] };

const makeCallbacks = () => ({
  onStepStart: vi.fn(), onStepComplete: vi.fn(), onProgress: vi.fn(), updateVideo: vi.fn(),
}) as any;

beforeEach(() => { h.gemini.mockReset(); h.composed.mockReset(); h.simple.mockReset(); });

describe('stepGenerateThumbnail (piloto automático) — Gemini primeiro, com fallbacks', () => {
  it('usa o prompt-base Gemini e NÃO chama as composições antigas', async () => {
    h.gemini.mockResolvedValue('data:image/jpeg;base64,GEMINI');
    const cb = makeCallbacks();
    const url = await stepGenerateThumbnail(project, video, script, cb);

    expect(url).toBe('data:image/jpeg;base64,GEMINI');
    expect(h.composed).not.toHaveBeenCalled();
    expect(h.simple).not.toHaveBeenCalled();
    expect(cb.updateVideo).toHaveBeenCalledWith('p1', 'v1', { thumbnailUrl: 'data:image/jpeg;base64,GEMINI' });
    expect(cb.onStepComplete).toHaveBeenCalledWith('thumbnail');

    // recebe os dados reais do vídeo
    const args = h.gemini.mock.calls[0][0];
    expect(args).toMatchObject({ title: 'A LEI SANGRENTA', channelTheme: 'Crimes reais', language: 'Portuguese (BR)', script });
    expect(args.scriptSummary).toContain('Era uma noite fria.');
  });

  it('Gemini falhou → cai na composição (cena do vídeo + gancho)', async () => {
    h.gemini.mockRejectedValue(new Error('429 RESOURCE_EXHAUSTED'));
    h.composed.mockResolvedValue('data:image/jpeg;base64,COMPOSED');
    const cb = makeCallbacks();
    const url = await stepGenerateThumbnail(project, video, script, cb);

    expect(url).toBe('data:image/jpeg;base64,COMPOSED');
    expect(h.simple).not.toHaveBeenCalled();
    expect(h.composed.mock.calls[0][0].sceneImageUrls).toEqual(['https://x/y.jpg']);
    expect(cb.updateVideo).toHaveBeenCalledWith('p1', 'v1', { thumbnailUrl: 'data:image/jpeg;base64,COMPOSED' });
  });

  it('Gemini e composição falharam → generateThumbnail simples', async () => {
    h.gemini.mockRejectedValue(new Error('x'));
    h.composed.mockRejectedValue(new Error('y'));
    h.simple.mockResolvedValue('data:image/jpeg;base64,SIMPLE');
    const url = await stepGenerateThumbnail(project, video, script, makeCallbacks());
    expect(url).toBe('data:image/jpeg;base64,SIMPLE');
    expect(h.simple).toHaveBeenCalledTimes(1);
  });

  it('tudo falhou → segue SEM thumbnail, sem derrubar o pipeline', async () => {
    h.gemini.mockRejectedValue(new Error('a'));
    h.composed.mockRejectedValue(new Error('b'));
    h.simple.mockRejectedValue(new Error('c'));
    const cb = makeCallbacks();
    const url = await stepGenerateThumbnail(project, video, script, cb);
    expect(url).toBeUndefined();
    expect(cb.updateVideo).not.toHaveBeenCalled();
    expect(cb.onStepComplete).toHaveBeenCalledWith('thumbnail');
  });
});
