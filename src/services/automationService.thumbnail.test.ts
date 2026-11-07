/* eslint-disable @typescript-eslint/no-explicit-any -- fakes e fixtures de forma livre */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ gemini: vi.fn(), composed: vi.fn() }));

vi.mock('./geminiService', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  generateGeminiThumbnail: h.gemini,
  generateComposedThumbnail: h.composed,
}));

import { stepGenerateThumbnail } from './automationService';

const project: any = { id: 'p1', channelTheme: 'Crimes reais', defaultTone: 'Dark', language: 'Portuguese (BR)', library: [] };
const script: any = { segments: [{ narratorText: 'Era uma noite fria.' }, { narratorText: 'A lei mudou.' }] };
const makeCallbacks = () => ({
  onStepStart: vi.fn(), onStepComplete: vi.fn(), onProgress: vi.fn(), updateVideo: vi.fn(),
}) as any;

beforeEach(() => { h.gemini.mockReset(); h.composed.mockReset(); });

describe('stepGenerateThumbnail — thumbnail a partir de um corte do vídeo', () => {
  it('com cenas no vídeo: usa a imagem da cena e NÃO chama a geração de imagem do Gemini', async () => {
    h.composed.mockResolvedValue('data:image/jpeg;base64,FRAME');
    const video: any = { id: 'v1', title: 'A LEI SANGRENTA', visualScenes: [{ imageUrl: 'https://x/y.jpg' }] };
    const cb = makeCallbacks();
    const url = await stepGenerateThumbnail(project, video, script, cb);

    expect(url).toBe('data:image/jpeg;base64,FRAME');
    expect(h.composed.mock.calls[0][0].sceneImageUrls).toEqual(['https://x/y.jpg']);
    expect(h.gemini).not.toHaveBeenCalled();
    expect(cb.updateVideo).toHaveBeenCalledWith('p1', 'v1', { thumbnailUrl: 'data:image/jpeg;base64,FRAME' });
  });

  it('sem cenas: recorre à imagem do Gemini', async () => {
    h.gemini.mockResolvedValue('data:image/jpeg;base64,GEMINI');
    const video: any = { id: 'v1', title: 'T', visualScenes: [] };
    expect(await stepGenerateThumbnail(project, video, script, makeCallbacks())).toBe('data:image/jpeg;base64,GEMINI');
    expect(h.composed).not.toHaveBeenCalled();
  });

  it('falha não derruba o pipeline', async () => {
    h.composed.mockRejectedValue(new Error('thumbnail_step_timeout'));
    const video: any = { id: 'v1', title: 'T', visualScenes: [{ imageUrl: 'https://x/y.jpg' }] };
    const cb = makeCallbacks();
    expect(await stepGenerateThumbnail(project, video, script, cb)).toBeUndefined();
    expect(cb.onStepComplete).toHaveBeenCalledWith('thumbnail');
  });
});
