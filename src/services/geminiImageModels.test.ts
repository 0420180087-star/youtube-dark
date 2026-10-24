import { describe, it, expect } from 'vitest';
import {
  THUMBNAIL_IMAGE_MODELS,
  SCENE_IMAGE_MODEL_IDS,
  imageConfigVariants,
  pickGeneratedImage,
  describeNoImage,
  describeImageError,
  isTransientImageError,
} from './geminiImageModels';

const DEAD = [/^imagen-/, /gemini-2\.0-flash-preview-image-generation/, /-image-preview$/];

describe('lista de modelos', () => {
  it('thumbnail: começa pelo Nano Banana 2.1 e não contém modelos já desligados', () => {
    expect(THUMBNAIL_IMAGE_MODELS[0].id).toBe('gemini-nano-banana-2.1');
    for (const m of THUMBNAIL_IMAGE_MODELS) for (const re of DEAD) expect(m.id).not.toMatch(re);
    expect(new Set(THUMBNAIL_IMAGE_MODELS.map((m) => m.id)).size).toBe(THUMBNAIL_IMAGE_MODELS.length);
  });

  it('cenas: mantém o 2.5 primeiro (comportamento atual) e troca o modelo desligado pelos atuais', () => {
    expect(SCENE_IMAGE_MODEL_IDS[0]).toBe('gemini-2.5-flash-image');
    expect(SCENE_IMAGE_MODEL_IDS).toContain('gemini-nano-banana-2.1');
    for (const id of SCENE_IMAGE_MODEL_IDS) for (const re of DEAD) expect(id).not.toMatch(re);
  });

  it('só os modelos Gemini 3 recebem imageSize; o 2.5 não', () => {
    const byId = Object.fromEntries(THUMBNAIL_IMAGE_MODELS.map((m) => [m.id, m]));
    expect(byId['gemini-nano-banana-2.1'].imageSize).toBe('1K');
    expect(byId['gemini-2.5-flash-image'].imageSize).toBeUndefined();
  });
});

describe('imageConfigVariants', () => {
  it('modelo com imageSize: completa → só proporção → sem imageConfig', () => {
    expect(imageConfigVariants({ id: 'x', imageSize: '1K' })).toEqual([{ aspectRatio: '16:9', imageSize: '1K' }, { aspectRatio: '16:9' }, undefined]);
  });
  it('modelo sem imageSize: proporção → sem imageConfig', () => {
    expect(imageConfigVariants({ id: 'x' })).toEqual([{ aspectRatio: '16:9' }, undefined]);
  });
});

describe('pickGeneratedImage', () => {
  const img = (data: string, extra: Record<string, unknown> = {}) => ({ inlineData: { mimeType: 'image/png', data }, ...extra });

  it('devolve a imagem e o mimeType', () => {
    expect(pickGeneratedImage({ candidates: [{ content: { parts: [{ text: 'ok' }, img('AAA')] } }] })).toEqual({ data: 'AAA', mimeType: 'image/png' });
  });

  it('ignora imagens intermediárias "thought" e usa a ÚLTIMA imagem final', () => {
    const r = { candidates: [{ content: { parts: [img('PENSANDO1', { thought: true }), img('PENSANDO2', { thought: true }), img('FINAL')] } }] };
    expect(pickGeneratedImage(r)?.data).toBe('FINAL');
    expect(pickGeneratedImage({ candidates: [{ content: { parts: [img('SO_PENSAMENTO', { thought: true })] } }] })).toBeNull();
  });

  it('aceita inline_data (snake_case) e respostas vazias/inválidas', () => {
    expect(pickGeneratedImage({ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/jpeg', data: 'J' } }] } }] })).toEqual({ data: 'J', mimeType: 'image/jpeg' });
    expect(pickGeneratedImage(null)).toBeNull();
    expect(pickGeneratedImage({})).toBeNull();
    expect(pickGeneratedImage({ candidates: [{ content: { parts: [{ text: 'só texto' }] } }] })).toBeNull();
  });
});

describe('describeNoImage', () => {
  it('distingue bloqueio de segurança de resposta só com texto', () => {
    expect(describeNoImage({ candidates: [{ finishReason: 'IMAGE_SAFETY' }] }, 'm1')).toMatch(/filtros de segurança.*IMAGE_SAFETY.*m1/);
    expect(describeNoImage({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }, 'm1')).toMatch(/PROHIBITED_CONTENT/);
    expect(describeNoImage({ candidates: [{ finishReason: 'STOP' }] }, 'm1')).toBe('m1 respondeu sem imagem (só texto)');
  });
});

describe('describeImageError — causa real em português', () => {
  it('"limit: 0" = chave sem faturamento para imagem', () => {
    const msg = describeImageError(new Error('429 RESOURCE_EXHAUSTED: Quota exceeded ... limit: 0, model: gemini-nano-banana-2.1'));
    expect(msg).toMatch(/limit: 0/);
    expect(msg).toMatch(/não têm plano gratuito/);
    expect(msg).toMatch(/faturamento/);
  });
  it('429 comum = cota esgotada', () => {
    expect(describeImageError({ response: { status: 429 }, message: 'x' })).toMatch(/cota de geração de imagem/);
    expect(describeImageError(new Error('Cota esgotada para todas as chaves'))).toMatch(/cota de geração de imagem/);
  });
  it('404 = modelo indisponível; 403 = sem permissão; 400 = parâmetros', () => {
    expect(describeImageError({ status: 404, message: 'models/x is not found' })).toMatch(/modelo de imagem indisponível/);
    expect(describeImageError({ response: { status: 403 }, message: 'PERMISSION_DENIED' })).toMatch(/permissão/);
    expect(describeImageError({ response: { status: 400 }, message: 'INVALID_ARGUMENT' })).toMatch(/parâmetros/);
  });
  it('segurança, timeout, 5xx e erro desconhecido', () => {
    expect(describeImageError(new Error('blocked by safety'))).toMatch(/filtros de segurança/);
    expect(describeImageError(new Error('thumbnail_render: timeout após 70000ms'))).toMatch(/tempo esgotado/);
    expect(describeImageError({ response: { status: 503 }, message: 'x' })).toMatch(/HTTP 503/);
    expect(describeImageError(new Error('algo estranho'))).toBe('algo estranho');
    expect(describeImageError(undefined)).toMatch(/erro desconhecido/);
  });
});

describe('isTransientImageError', () => {
  it('5xx, timeout e rede são passageiros; 4xx não', () => {
    expect(isTransientImageError({ response: { status: 503 } })).toBe(true);
    expect(isTransientImageError(new Error('timeout após 70s'))).toBe(true);
    expect(isTransientImageError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientImageError({ response: { status: 404 }, message: 'x' })).toBe(false);
    expect(isTransientImageError({ response: { status: 400 }, message: 'x' })).toBe(false);
  });
});
