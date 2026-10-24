/* eslint-disable @typescript-eslint/no-explicit-any -- fakes e fixtures de forma livre */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ gemini: vi.fn() }));

// Só generateGeminiThumbnail é simulada; o resto do geminiService (inclusive thumbnailErrorReason) segue real.
vi.mock('./geminiService', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  generateGeminiThumbnail: h.gemini,
}));

import { stepGenerateThumbnail } from './automationService';
import { ThumbnailGenerationError } from './geminiThumbnail';

const project: any = { id: 'p1', channelTheme: 'Crimes reais', defaultTone: 'Dark', language: 'Portuguese (BR)', library: [] };
const video: any = { id: 'v1', title: 'A LEI SANGRENTA', visualScenes: [{ imageUrl: 'https://x/y.jpg' }] };
const script: any = { segments: [{ narratorText: 'Era uma noite fria.' }, { narratorText: 'A lei mudou.' }] };

const makeCallbacks = () => ({
  onStepStart: vi.fn(), onStepComplete: vi.fn(), onProgress: vi.fn(), updateVideo: vi.fn(),
}) as any;

beforeEach(() => { h.gemini.mockReset(); });

describe('stepGenerateThumbnail (piloto automático) — SEMPRE o prompt-base Gemini', () => {
  it('gera pelo Gemini, salva no vídeo e entrega os dados reais do vídeo', async () => {
    h.gemini.mockResolvedValue('data:image/jpeg;base64,GEMINI');
    const cb = makeCallbacks();
    const url = await stepGenerateThumbnail(project, video, script, cb);

    expect(url).toBe('data:image/jpeg;base64,GEMINI');
    expect(cb.updateVideo).toHaveBeenCalledWith('p1', 'v1', { thumbnailUrl: 'data:image/jpeg;base64,GEMINI' });
    expect(cb.onStepComplete).toHaveBeenCalledWith('thumbnail');
    const args = h.gemini.mock.calls[0][0];
    expect(args).toMatchObject({ title: 'A LEI SANGRENTA', channelTheme: 'Crimes reais', language: 'Portuguese (BR)', script });
    expect(args.scriptSummary).toContain('Era uma noite fria.');
  });

  it('falhou: NÃO usa mais nenhum estilo antigo; mostra a CAUSA real no progresso e segue sem thumbnail', async () => {
    h.gemini.mockRejectedValue(new ThumbnailGenerationError('esta chave não tem cota para modelos de imagem (limit: 0).'));
    const cb = makeCallbacks();
    const url = await stepGenerateThumbnail(project, video, script, cb);

    expect(url).toBeUndefined();
    expect(h.gemini).toHaveBeenCalledTimes(1); // sem segunda tentativa com outro estilo
    expect(cb.updateVideo).not.toHaveBeenCalled();
    expect(cb.onProgress).toHaveBeenCalledWith('thumbnail', '⚠️ Thumbnail não gerada: esta chave não tem cota para modelos de imagem (limit: 0).');
    expect(cb.onStepComplete).toHaveBeenCalledWith('thumbnail'); // o pipeline continua
  });

  it('erro genérico (ex.: timeout) também é explicado e não derruba o pipeline', async () => {
    h.gemini.mockRejectedValue(new Error('thumbnail_step_timeout'));
    const cb = makeCallbacks();
    expect(await stepGenerateThumbnail(project, video, script, cb)).toBeUndefined();
    expect(cb.onProgress).toHaveBeenCalledWith('thumbnail', expect.stringContaining('Thumbnail não gerada'));
    expect(cb.onStepComplete).toHaveBeenCalledWith('thumbnail');
  });
});
