/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures de JSON de forma livre */
import { describe, it, expect } from 'vitest';
import {
  isTooSimilarTopic,
  selectFreshIdeas,
  buildLibraryContext,
  buildChannelMemory,
  buildIdeasPrompt,
  buildFallbackIdeas,
  linkIdeaToVideo,
  backfillIdeaVideoLinks,
  FRESH_ANGLES,
} from './ideaEngine';

describe('similaridade de tópicos', () => {
  it('detecta o mesmo assunto com outra roupa e aceita assuntos diferentes', () => {
    expect(isTooSimilarTopic('O caso do farol abandonado em Santos', ['O caso do farol abandonado de Santos'])).toBe(true);
    expect(isTooSimilarTopic('O sequestro que parou a cidade', ['O mistério dos dois finais'])).toBe(false);
  });

  it('selectFreshIdeas remove repetidas do histórico e repetidas dentro do próprio lote', () => {
    const batch = [
      { topic: 'O caso do farol abandonado em Santos' },
      { topic: 'O sequestro que parou a cidade inteira' },
      { topic: 'O sequestro que parou a cidade inteira hoje' }, // parecida com a anterior
      { topic: '' },
    ];
    const fresh = selectFreshIdeas(batch, ['O caso do farol abandonado de Santos']);
    expect(fresh.map((i) => i.topic)).toEqual(['O sequestro que parou a cidade inteira']);
  });
});

describe('buildLibraryContext', () => {
  it('usa o mesmo formato do Brainstorm manual do app', () => {
    const ctx = buildLibraryContext([
      { type: 'youtube_channel', title: 'Canal X', content: 'https://youtube.com/@x' },
      { type: 'text', title: 'Nota', content: 'abc' },
    ]);
    expect(ctx).toBe('[YOUTUBE_REFERENCE_CHANNEL] Canal X: https://youtube.com/@x\n[TEXT] Nota: abc');
    expect(buildLibraryContext(undefined)).toBe('');
  });
});

describe('buildChannelMemory (memória do canal)', () => {
  const videos: any[] = [
    {
      title: 'A LEI SANGRENTA: O Crime que REFORMULOU a Justiça',
      status: 'PUBLISHED',
      createdAt: '2026-10-09T10:00:00.000Z',
      script: { description: 'Como um crime mudou a lei penal do país.', coreThemes: ['justiça', 'reforma penal'] },
    },
    { title: 'O MISTÉRIO DOS DOIS FINAIS', status: 'SCHEDULED', createdAt: '2026-09-08T10:00:00.000Z', specificContext: 'Dois desfechos para o mesmo caso.' },
    { title: 'Em produção', status: 'SCRIPTING', createdAt: '2026-10-12T10:00:00.000Z' },
    { title: '   ', status: 'DRAFT', createdAt: '2026-10-13T10:00:00.000Z' },
  ];

  it('lista vídeos do mais novo ao mais antigo, com estado, resumo e temas', () => {
    const mem = buildChannelMemory({ videos });
    const lines = mem.split('\n');
    expect(lines[0]).toBe('PRODUCED VIDEOS (newest first):');
    expect(lines[1]).toContain('"Em produção" (in production)');
    expect(lines[2]).toContain('"A LEI SANGRENTA: O Crime que REFORMULOU a Justiça" (published)');
    expect(lines[2]).toContain('Como um crime mudou a lei penal do país.');
    expect(lines[2]).toContain('themes: justiça, reforma penal');
    expect(lines[3]).toContain('(finished, waiting to be published)');
    expect(mem).not.toContain('"   "');
  });

  it('inclui ideias descartadas e respeita o limite de caracteres sem cortar linha no meio', () => {
    const ideas: any[] = [{ topic: 'Ideia rejeitada', status: 'dismissed' }, { topic: 'Outra', status: 'new' }];
    const mem = buildChannelMemory({ videos, ideas });
    expect(mem).toContain('REJECTED IDEAS');
    expect(mem).toContain('"Ideia rejeitada"');
    expect(mem).not.toContain('"Outra"');

    const short = buildChannelMemory({ videos }, { maxChars: 120 });
    expect(short.length).toBeLessThanOrEqual(120);
    expect(short.split('\n').every((l) => l.startsWith('PRODUCED') || l.startsWith('- "'))).toBe(true);
  });

  it('devolve vazio quando não há nada', () => {
    expect(buildChannelMemory({})).toBe('');
    expect(buildChannelMemory({ videos: [], ideas: [] })).toBe('');
  });
});

describe('buildIdeasPrompt', () => {
  it('traz tema, descrição, tom e idioma', () => {
    const p = buildIdeasPrompt({ channelTheme: 'Crimes reais', description: 'Casos', tone: 'Sombrio', language: 'Portuguese (BR)' });
    expect(p).toContain('channel about "Crimes reais"');
    expect(p).toContain('Channel Description: "Casos"');
    expect(p).toContain('Target Narrative Tone: "Sombrio"');
    expect(p).toContain('Target Language: "Portuguese (BR)"');
    expect(p).toContain('Generate 4 unique');
    expect(p).not.toContain('CHANNEL MEMORY');
    expect(p).not.toContain('Return ONLY valid JSON');
  });

  it('inclui Biblioteca, memória do canal, ângulo e exclusões (últimas 25)', () => {
    const exclude = Array.from({ length: 30 }, (_, i) => `Tópico ${i}`);
    const p = buildIdeasPrompt({
      channelTheme: 'T',
      libraryContext: '[TEXT] Nota: conteúdo',
      channelMemory: 'PRODUCED VIDEOS (newest first):\n- "A"',
      freshAngle: 'untold history',
      excludeTopics: exclude,
      count: 5,
      jsonInstruction: true,
    });
    expect(p).toContain('CHANNEL KNOWLEDGE BASE & REFERENCES');
    expect(p).toContain('[TEXT] Nota: conteúdo');
    expect(p).toContain('CHANNEL MEMORY');
    expect(p).toContain('Do NOT repeat or paraphrase');
    expect(p).toContain('angle of "untold history"');
    expect(p).toContain('Tópico 29');
    expect(p).not.toContain('"Tópico 4"'); // só as 25 mais recentes
    expect(p).toContain('Generate 5 unique');
    expect(p).toContain('Return ONLY valid JSON');
  });

  it('usa valores padrão quando tom/idioma/descrição vêm vazios', () => {
    const p = buildIdeasPrompt({ channelTheme: 'T', tone: '', language: '', description: '' });
    expect(p).toContain('Channel Description: "General niche content"');
    expect(p).toContain('Target Narrative Tone: "Engaging"');
    expect(p).toContain('Target Language: "English"');
  });
});

describe('buildFallbackIdeas', () => {
  const fixed = { now: new Date('2026-10-14T12:00:00Z'), rand: () => 0.3 };

  it('fala português quando o projeto é pt-BR (e não deixa o título em inglês)', () => {
    const ideas = buildFallbackIdeas({ channelTheme: 'Crimes impressionantes da vida real', language: 'Portuguese (BR)', ...fixed });
    expect(ideas.length).toBe(3);
    expect(ideas[0].topic).toMatch(/Crimes impressionantes da vida real/);
    expect(ideas[0].topic).not.toMatch(/Untold|Hidden Truth|Nobody Tells/i);
    expect(ideas[0].topic).toContain('(#2026-10-14-');
    expect(ideas[0].context).toMatch(/Um mergulho/);
  });

  it('mantém o fallback em inglês para outros idiomas', () => {
    const ideas = buildFallbackIdeas({ channelTheme: 'True crime', language: 'English', count: 2, ...fixed });
    expect(ideas.length).toBe(2);
    expect(ideas[0].context).toMatch(/engaging deep-dive/);
  });

  it('gera tópicos diferentes entre si', () => {
    const ideas = buildFallbackIdeas({ channelTheme: 'X', language: 'pt-BR', now: fixed.now });
    expect(new Set(ideas.map((i) => i.topic)).size).toBe(ideas.length);
  });
});

describe('linkIdeaToVideo (gestão de conhecimento)', () => {
  const ideas: any[] = [
    { id: 'i1', topic: 'A', status: 'used', createdAt: 'x' },
    { id: 'i2', topic: 'B', status: 'new', createdAt: 'x' },
  ];

  it('grava o vínculo ideia → vídeo sem mutar o original', () => {
    const out = linkIdeaToVideo(ideas, 'i1', { videoId: 'auto_1', videoTitle: 'Título final', youtubeUrl: 'https://youtu.be/x', usedAt: '2026-10-14T00:00:00.000Z' });
    expect(out[0]).toMatchObject({ id: 'i1', status: 'used', videoId: 'auto_1', videoTitle: 'Título final', youtubeUrl: 'https://youtu.be/x', usedAt: '2026-10-14T00:00:00.000Z' });
    expect(out[1]).toEqual(ideas[1]);
    expect(ideas[0].videoId).toBeUndefined();
  });

  it('não faz nada quando a ideia não existe ou o id é vazio', () => {
    expect(linkIdeaToVideo(ideas, 'nope', { videoId: 'v' })).toEqual(ideas);
    expect(linkIdeaToVideo(ideas, undefined, { videoId: 'v' })).toBe(ideas);
    expect(linkIdeaToVideo(undefined, 'i1', { videoId: 'v' })).toEqual([]);
  });

  it('exporta ângulos de variação', () => {
    expect(FRESH_ANGLES.length).toBeGreaterThan(3);
  });
});

describe('backfillIdeaVideoLinks (vínculos de vídeos antigos da automação)', () => {
  const ctxA = 'Detalhe longo do caso A: o que aconteceu naquela noite na estrada.';
  const ctxB = 'Detalhe longo do caso B: a investigação que ninguém quis reabrir.';
  const videos: any[] = [
    { id: 'auto_1', title: 'TÍTULO FINAL A', specificContext: ctxA, youtubeUrl: 'https://youtu.be/a', createdAt: '2026-10-01T10:00:00.000Z' },
    { id: 'auto_2', title: 'TÍTULO FINAL B', specificContext: ctxB, createdAt: '2026-10-02T10:00:00.000Z' },
  ];

  it('liga cada ideia usada ao seu vídeo pelo contexto idêntico', () => {
    const ideas: any[] = [
      { id: 'i1', topic: 'Ideia A', status: 'used', specificContext: ctxA },
      { id: 'i2', topic: 'Ideia B', status: 'used', specificContext: '  ' + ctxB.toUpperCase() + ' ' },
      { id: 'i3', topic: 'Ideia C', status: 'new', specificContext: ctxA },
    ];
    const { ideas: out, linked } = backfillIdeaVideoLinks(ideas, videos);
    expect(linked).toBe(2);
    expect(out[0]).toMatchObject({ videoId: 'auto_1', videoTitle: 'TÍTULO FINAL A', youtubeUrl: 'https://youtu.be/a', usedAt: '2026-10-01T10:00:00.000Z' });
    expect(out[1]).toMatchObject({ videoId: 'auto_2', videoTitle: 'TÍTULO FINAL B' });
    expect(out[2]).toBe(ideas[2]); // ideia "new" não é tocada
    expect(ideas[0].videoId).toBeUndefined(); // não muta o original
  });

  it('não arrisca quando é ambíguo ou curto, e não sobrescreve vínculo existente', () => {
    const dupVideos: any[] = [...videos, { id: 'auto_3', title: 'Outro', specificContext: ctxA }];
    const ideas: any[] = [
      { id: 'i1', topic: 'A', status: 'used', specificContext: ctxA }, // 2 vídeos com o mesmo contexto
      { id: 'i2', topic: 'B', status: 'used', specificContext: 'curto' },
      { id: 'i4', topic: 'D', status: 'used', specificContext: ctxB, videoId: 'ja_tinha' },
    ];
    const res = backfillIdeaVideoLinks(ideas, dupVideos);
    expect(res.linked).toBe(0);
    expect(res.ideas).toBe(ideas); // mesmo array quando nada casa
    const twoIdeas: any[] = [
      { id: 'a', topic: 'A1', status: 'used', specificContext: ctxA },
      { id: 'b', topic: 'A2', status: 'used', specificContext: ctxA }, // duas ideias disputam o mesmo vídeo
    ];
    expect(backfillIdeaVideoLinks(twoIdeas, videos).linked).toBe(0);
  });

  it('aceita listas vazias/indefinidas', () => {
    expect(backfillIdeaVideoLinks(undefined, undefined)).toEqual({ ideas: [], linked: 0 });
  });
});
