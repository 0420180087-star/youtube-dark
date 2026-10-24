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

import { generateGeminiThumbnail, thumbnailErrorReason, ThumbnailGenerationError } from './geminiThumbnail';

const BRIEF = {
  hookWord: 'a lei que nasceu do sangue',
  directHint: 'o que a polícia não contou',
  visualHint: 'uma pasta de caso com fotos de evidências',
  centralElement: 'uma pasta de caso entreaberta sobre uma mesa escura',
  accentColor: 'âmbar queimado',
};
const imageResponse = (data = 'AAAA', extra: Record<string, unknown> = {}) =>
  ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data }, ...extra }] } }] });
const isBriefCall = (req: any) => req.model === 'gemini-2.5-flash';
const imageCalls = () => h.calls.filter((c) => c.model !== 'gemini-2.5-flash');
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

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
  h.handler = (req) => (isBriefCall(req) ? { text: JSON.stringify(BRIEF) } : imageResponse());
  vi.stubGlobal('Image', FakeImage);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as any);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,NORMALIZED');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('generateGeminiThumbnail — prompt-base faceless/clickbait pelo Gemini', () => {
  it('briefing pela IA → prompt-base preenchido → Nano Banana 2.1 em 16:9 → JPEG 1280x720', async () => {
    const out = await generateGeminiThumbnail(OPTS);

    expect(out).toBe('data:image/jpeg;base64,NORMALIZED');
    const brief = h.calls.find(isBriefCall);
    expect(brief.contents).toContain('TEMA DO CANAL: Crimes impressionantes da vida real');
    expect(brief.config.responseMimeType).toBe('application/json');

    const img = imageCalls()[0];
    expect(img.model).toBe('gemini-nano-banana-2.1'); // modelo atual (o 2.5 e o Imagen não são mais o 1º)
    expect(img.config.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '1K' });
    const sent: string = img.contents.parts[0].text;
    for (const needle of [
      'TEMA DO CANAL: Crimes impressionantes da vida real',
      'TÍTULO DO VÍDEO: A LEI SANGRENTA: O Crime que REFORMULOU a Justiça',
      'DESCRIÇÃO/RESUMO: Um crime que mudou a lei penal.',
      'linha 1: “A LEI QUE NASCEU DO SANGUE”',
      'linha 2 (menor, amarela): “O QUE A POLÍCIA NÃO CONTOU”',
      '- Elemento central: uma pasta de caso entreaberta sobre uma mesa escura',
      '- Paleta: preto, vermelho sangue (#8B0000), branco sujo e 1 cor de destaque coerente com o tema e com este vídeo: âmbar queimado',
      'REGRA PRINCIPAL DO CANAL (FACELESS):',
    ]) expect(sent, needle).toContain(needle);
    expect(sent).not.toMatch(/no text/i);
    expect(sent).not.toMatch(/\[[A-ZÁÉÍÓÚ][^\]]*\]/); // nenhum campo entre colchetes sobrando
  });

  it('modelo que recusa o imageConfig completo (400): repete o MESMO modelo com a proporção só', async () => {
    h.handler = (req) => {
      if (isBriefCall(req)) return { text: JSON.stringify(BRIEF) };
      if (imageCalls().length === 1) throw httpError(400, '400 INVALID_ARGUMENT: imageSize not supported');
      return imageResponse();
    };
    expect(await generateGeminiThumbnail(OPTS)).toBe('data:image/jpeg;base64,NORMALIZED');
    const imgs = imageCalls();
    expect(imgs).toHaveLength(2);
    expect(imgs.map((c) => c.model)).toEqual(['gemini-nano-banana-2.1', 'gemini-nano-banana-2.1']);
    expect(imgs[0].config.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '1K' });
    expect(imgs[1].config.imageConfig).toEqual({ aspectRatio: '16:9' });
  });

  it('se o 1º modelo responder só com texto, tenta o próximo modelo atual', async () => {
    h.handler = (req) => {
      if (isBriefCall(req)) return { text: JSON.stringify(BRIEF) };
      if (req.model === 'gemini-nano-banana-2.1') return { candidates: [{ content: { parts: [{ text: 'só texto' }] } }] };
      return imageResponse();
    };
    expect(await generateGeminiThumbnail(OPTS)).toBe('data:image/jpeg;base64,NORMALIZED');
    expect(imageCalls().map((c) => c.model)).toEqual(['gemini-nano-banana-2.1', 'gemini-3.1-flash-image']);
  });

  it('modelo desligado (404) cai para o próximo; nenhuma chamada usa modelo já desligado', async () => {
    h.handler = (req) => {
      if (isBriefCall(req)) return { text: JSON.stringify(BRIEF) };
      if (req.model === 'gemini-nano-banana-2.1') throw httpError(404, 'models/gemini-nano-banana-2.1 is not found');
      return imageResponse();
    };
    await generateGeminiThumbnail(OPTS);
    expect(imageCalls().map((c) => c.model)).toEqual(['gemini-nano-banana-2.1', 'gemini-3.1-flash-image']);
    for (const c of h.calls) {
      expect(c.model).not.toMatch(/^imagen-/);
      expect(c.model).not.toBe('gemini-2.0-flash-preview-image-generation');
    }
  });

  it('ignora imagens intermediárias ("thought") e usa a imagem FINAL', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as any); // devolve a imagem original
    h.handler = (req) => (isBriefCall(req)
      ? { text: JSON.stringify(BRIEF) }
      : { candidates: [{ content: { parts: [
          { thought: true, inlineData: { mimeType: 'image/png', data: 'PENSANDO' } },
          { inlineData: { mimeType: 'image/png', data: 'FINAL' } },
        ] } }] });
    expect(await generateGeminiThumbnail(OPTS)).toBe('data:image/png;base64,FINAL');
  });

  it('falha passageira (503) é repetida UMA vez no mesmo modelo', async () => {
    h.handler = (req) => {
      if (isBriefCall(req)) return { text: JSON.stringify(BRIEF) };
      if (imageCalls().length === 1) throw httpError(503, 'servidor sobrecarregado');
      return imageResponse();
    };
    expect(await generateGeminiThumbnail(OPTS)).toBe('data:image/jpeg;base64,NORMALIZED');
    expect(imageCalls().map((c) => c.model)).toEqual(['gemini-nano-banana-2.1', 'gemini-nano-banana-2.1']);
  }, 10_000);

  it('briefing da IA falhou: usa o briefing LOCAL (por tema) e ainda gera a imagem', async () => {
    h.handler = (req) => { if (isBriefCall(req)) throw new Error('rede caiu'); return imageResponse(); };
    expect(await generateGeminiThumbnail(OPTS)).toBe('data:image/jpeg;base64,NORMALIZED');
    const sent: string = imageCalls()[0].contents.parts[0].text;
    expect(sent).toContain('“A LEI SANGRENTA”'); // gancho local = parte do título antes de ":"
    expect(sent).toContain('“O QUE A POLÍCIA ESCONDEU”'); // dica direta local do tema crime
    expect(sent).toContain('azul frio de cena de crime'); // cor de destaque local do tema crime
  });

  it('briefing com campo pedindo rosto é descartado (canal faceless)', async () => {
    h.handler = (req) => (isBriefCall(req)
      ? { text: JSON.stringify({ ...BRIEF, visualHint: 'um rosto em choque olhando para a câmera' }) }
      : imageResponse());
    await generateGeminiThumbnail(OPTS);
    const sent: string = imageCalls()[0].contents.parts[0].text;
    expect(sent).not.toContain('um rosto em choque');
    expect(sent).toContain('DICA VISUAL QUE DEVE SER INSINUADA: uma pasta de caso com fotos de evidências e um mapa');
  });

  it('nenhum modelo gera imagem: rejeita com a CAUSA real em português', async () => {
    h.handler = (req) => { if (isBriefCall(req)) return { text: JSON.stringify(BRIEF) }; throw httpError(404, 'model is not found'); };
    const err: any = await generateGeminiThumbnail(OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(ThumbnailGenerationError);
    expect(err.message).toMatch(/modelo de imagem indisponível/);
    expect(imageCalls()).toHaveLength(5); // percorreu todos os modelos da lista
  });

  it('cota esgotada na imagem: propaga como erro explicado e não insiste em outros modelos', async () => {
    h.handler = (req) => { if (isBriefCall(req)) return { text: JSON.stringify(BRIEF) }; throw new Error('429 RESOURCE_EXHAUSTED'); };
    const err: any = await generateGeminiThumbnail(OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(ThumbnailGenerationError);
    expect(err.message).toMatch(/cota de geração de imagem/);
    expect(imageCalls()).toHaveLength(1);
  });

  it('"limit: 0" (chave sem faturamento) é explicado como tal', async () => {
    h.handler = (req) => { if (isBriefCall(req)) return { text: JSON.stringify(BRIEF) }; throw new Error('429 RESOURCE_EXHAUSTED: Quota exceeded, limit: 0'); };
    const err: any = await generateGeminiThumbnail(OPTS).catch((e) => e);
    expect(err.message).toMatch(/limit: 0/);
    expect(err.message).toMatch(/faturamento/);
    expect(err.message).toMatch(/não têm plano gratuito/);
  });

  it('sem canvas disponível, devolve a imagem original do Gemini (sem quebrar)', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as any);
    expect(await generateGeminiThumbnail(OPTS)).toBe('data:image/png;base64,AAAA');
  });
});

describe('thumbnailErrorReason', () => {
  it('usa a mensagem já explicada ou descreve qualquer outro erro', () => {
    expect(thumbnailErrorReason(new ThumbnailGenerationError('motivo pronto'))).toBe('motivo pronto');
    expect(thumbnailErrorReason(new Error('thumbnail_step_timeout'))).toBe('tempo esgotado ao gerar a imagem.');
    expect(thumbnailErrorReason({ response: { status: 404 }, message: 'x' })).toMatch(/modelo de imagem indisponível/);
  });
});
