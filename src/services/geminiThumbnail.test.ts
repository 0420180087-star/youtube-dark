/* eslint-disable @typescript-eslint/no-explicit-any -- fakes e fixtures de forma livre */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Gemini simulado: executeGeminiRequest só repassa o "ai" falso (sem rotação de chaves).
const h = vi.hoisted(() => ({
  calls: [] as any[],
  handler: null as null | ((req: any, n: number) => any),
}));

vi.mock('./geminiCore', () => ({
  executeGeminiRequest: vi.fn(async (fn: any) =>
    fn({ models: { generateContent: async (req: any) => { h.calls.push(req); return h.handler!(req, h.calls.length); } } })),
  isQuotaError: (e: any) => /quota|RESOURCE_EXHAUSTED|429/i.test(String(e?.message || '')),
}));

import { generateGeminiThumbnail } from './geminiThumbnail';

const BRIEF = {
  hookWord: 'a lei que nasceu do sangue',
  directHint: 'o que a polícia não contou',
  visualHint: 'uma pasta de caso com fotos de evidências',
  centralElement: 'uma pasta de caso entreaberta sobre uma mesa escura',
};
const imageResponse = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } }] };
const isBriefCall = (req: any) => req.model === 'gemini-2.5-flash';
const imageCalls = () => h.calls.filter((c) => c.model !== 'gemini-2.5-flash');

const OPTS = {
  title: 'A LEI SANGRENTA: O Crime que REFORMULOU a Justiça',
  channelTheme: 'Crimes impressionantes da vida real',
  language: 'Portuguese (BR)',
  script: {
    title: 't', description: 'Um crime que mudou a lei penal.', brainstorming: [], narrativeOutline: [], coreThemes: ['justiça'],
    segments: [
      { sectionTitle: 'A noite', narratorText: 'Era uma noite fria quando tudo começou.', visualDescriptions: [], estimatedDuration: 10 },
      { sectionTitle: 'O fim', narratorText: 'A lei mudou para sempre.', visualDescriptions: [], estimatedDuration: 10 },
    ],
  } as any,
};

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 1024;
  height = 1024;
  set src(_v: string) { setTimeout(() => this.onload?.(), 0); }
}

beforeEach(() => {
  h.calls = [];
  h.handler = (req) => (isBriefCall(req) ? { text: JSON.stringify(BRIEF) } : imageResponse);
  vi.stubGlobal('Image', FakeImage);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as any);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,NORMALIZED');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('generateGeminiThumbnail — prompt-base faceless/clickbait pelo Gemini', () => {
  it('monta o briefing pela IA, preenche o prompt-base e pede 16:9 a um modelo de imagem', async () => {
    const out = await generateGeminiThumbnail(OPTS);

    expect(out).toBe('data:image/jpeg;base64,NORMALIZED'); // normalizada para 1280x720 JPEG
    const brief = h.calls.find(isBriefCall);
    expect(brief.contents).toContain('TEMA DO CANAL: Crimes impressionantes da vida real');
    expect(brief.config.responseMimeType).toBe('application/json');

    const img = imageCalls()[0];
    expect(img.model).toBe('gemini-2.5-flash-image');
    expect(img.config.imageConfig).toEqual({ aspectRatio: '16:9' });
    const sent: string = img.contents.parts[0].text;
    for (const needle of [
      'TEMA DO CANAL: Crimes impressionantes da vida real',
      'TÍTULO DO VÍDEO: A LEI SANGRENTA: O Crime que REFORMULOU a Justiça',
      'DESCRIÇÃO/RESUMO: Um crime que mudou a lei penal.',
      'linha 1: “A LEI QUE NASCEU DO SANGUE”',
      'linha 2 (menor, amarela): “O QUE A POLÍCIA NÃO CONTOU”',
      '- Elemento central: uma pasta de caso entreaberta sobre uma mesa escura',
      'REGRA PRINCIPAL DO CANAL (FACELESS):',
    ]) expect(sent, needle).toContain(needle);
    expect(sent).not.toMatch(/no text/i); // o texto do gancho faz parte da imagem
    expect(sent).not.toMatch(/\[[A-ZÁÉÍÓÚ][^\]]*\]/); // nenhum campo entre colchetes sobrando
  });

  it('modelo que recusa imageConfig (400): repete o MESMO modelo sem o parâmetro', async () => {
    h.handler = (req, n) => {
      if (isBriefCall(req)) return { text: JSON.stringify(BRIEF) };
      if (imageCalls().length === 1) throw Object.assign(new Error('400 INVALID_ARGUMENT: imageConfig not supported'), { status: 400 });
      return imageResponse;
    };
    const out = await generateGeminiThumbnail(OPTS);
    expect(out).toBe('data:image/jpeg;base64,NORMALIZED');
    const imgs = imageCalls();
    expect(imgs).toHaveLength(2);
    expect(imgs[0].model).toBe('gemini-2.5-flash-image');
    expect(imgs[1].model).toBe('gemini-2.5-flash-image');
    expect(imgs[0].config.imageConfig).toBeDefined();
    expect(imgs[1].config.imageConfig).toBeUndefined();
  });

  it('se o 1º modelo não devolver imagem, tenta o próximo', async () => {
    h.handler = (req) => {
      if (isBriefCall(req)) return { text: JSON.stringify(BRIEF) };
      if (req.model === 'gemini-2.5-flash-image') return { candidates: [{ content: { parts: [{ text: 'só texto' }] } }] };
      return imageResponse;
    };
    expect(await generateGeminiThumbnail(OPTS)).toBe('data:image/jpeg;base64,NORMALIZED');
    expect(imageCalls().some((c) => c.model === 'gemini-2.0-flash-preview-image-generation')).toBe(true);
  });

  it('briefing da IA falhou: usa o briefing LOCAL (por tema) e ainda gera a imagem', async () => {
    h.handler = (req) => { if (isBriefCall(req)) throw new Error('rede caiu'); return imageResponse; };
    expect(await generateGeminiThumbnail(OPTS)).toBe('data:image/jpeg;base64,NORMALIZED');
    const sent: string = imageCalls()[0].contents.parts[0].text;
    expect(sent).toContain('“A LEI SANGRENTA”'); // gancho local = parte do título antes de ":"
    expect(sent).toContain('“O QUE A POLÍCIA ESCONDEU”'); // dica direta local do tema crime
  });

  it('briefing com campo pedindo rosto é descartado (canal faceless)', async () => {
    h.handler = (req) => (isBriefCall(req)
      ? { text: JSON.stringify({ ...BRIEF, visualHint: 'um rosto em choque olhando para a câmera' }) }
      : imageResponse);
    await generateGeminiThumbnail(OPTS);
    const sent: string = imageCalls()[0].contents.parts[0].text;
    expect(sent).not.toContain('um rosto em choque');
    expect(sent).toContain('DICA VISUAL QUE DEVE SER INSINUADA: uma pasta de caso com fotos de evidências e um mapa');
  });

  it('todos os modelos de imagem falham: rejeita (quem chama decide o fallback)', async () => {
    h.handler = (req) => { if (isBriefCall(req)) return { text: JSON.stringify(BRIEF) }; throw new Error('500 erro interno'); };
    await expect(generateGeminiThumbnail(OPTS)).rejects.toThrow(/500 erro interno/);
  });

  it('cota esgotada na imagem: propaga o erro de cota (para a rotação de chaves)', async () => {
    h.handler = (req) => { if (isBriefCall(req)) return { text: JSON.stringify(BRIEF) }; throw new Error('429 RESOURCE_EXHAUSTED'); };
    await expect(generateGeminiThumbnail(OPTS)).rejects.toThrow(/RESOURCE_EXHAUSTED/);
    expect(imageCalls()).toHaveLength(1); // não insiste em outros modelos com a cota esgotada
  });

  it('sem canvas disponível, devolve a imagem original do Gemini (sem quebrar)', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as any);
    expect(await generateGeminiThumbnail(OPTS)).toBe('data:image/png;base64,AAAA');
  });
});
