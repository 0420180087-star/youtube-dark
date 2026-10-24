/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures de JSON de forma livre */
import { describe, it, expect } from 'vitest';
import {
  buildThumbnailSummary,
  buildThumbnailContent,
  buildThumbnailBriefPrompt,
  buildThumbnailImagePrompt,
  buildFallbackThumbnailBrief,
  parseThumbnailBrief,
  cleanOverlayText,
  detectThemeKind,
  type ThumbnailContext,
} from './thumbnailPrompt';

const script: any = {
  title: 'A Lei Sangrenta',
  description: 'Como um crime brutal em 1987 mudou para sempre a lei penal do país e deixou perguntas sem resposta. Um segundo detalhe aqui.',
  coreThemes: ['justiça', 'reforma penal', 'impunidade'],
  segments: [
    { sectionTitle: 'A noite do crime', narratorText: 'Era uma noite fria de março quando a cidade acordou com a notícia que ninguém esperava ouvir.' },
    { sectionTitle: 'A investigação', narratorText: 'A polícia encontrou uma pasta com fotos que nunca foram divulgadas.' },
    { sectionTitle: 'A mudança', narratorText: 'No fim, a lei mudou, mas a pergunta principal continua aberta até hoje.' },
  ],
};

const ctx: ThumbnailContext = {
  channelTheme: 'Crimes impressionantes da vida real',
  title: 'A LEI SANGRENTA: O Crime que REFORMULOU a Justiça',
  language: 'Portuguese (BR)',
  script,
};

describe('campos preenchidos com dados reais do vídeo', () => {
  it('resumo: usa a descrição do roteiro, limitada a poucas linhas', () => {
    const s = buildThumbnailSummary(ctx);
    expect(s).toContain('crime brutal em 1987');
    expect(s.length).toBeLessThanOrEqual(241);
  });

  it('resumo: descrição explícita vence; sem descrição usa as 2 primeiras frases da narração; sem roteiro usa o texto de apoio', () => {
    expect(buildThumbnailSummary({ ...ctx, description: 'Resumo explícito do vídeo.' })).toBe('Resumo explícito do vídeo.');
    const noDesc = buildThumbnailSummary({ ...ctx, script: { segments: script.segments } });
    expect(noDesc).toContain('Era uma noite fria de março');
    expect(buildThumbnailSummary({ channelTheme: 't', title: 'x', fallbackSummary: 'Apoio.' })).toBe('Apoio.');
  });

  it('conteúdo: abertura, seções, temas centrais e desfecho', () => {
    const c = buildThumbnailContent(ctx);
    expect(c).toContain('Abertura: "Era uma noite fria');
    expect(c).toContain('Seções: A noite do crime → A investigação → A mudança');
    expect(c).toContain('Temas centrais: justiça, reforma penal, impunidade');
    expect(c).toContain('Desfecho: "No fim, a lei mudou');
    expect(buildThumbnailContent(ctx, 120).length).toBeLessThanOrEqual(121);
  });
});

describe('prompt-base do usuário', () => {
  const brief = {
    hookWord: 'ELES NÃO QUEREM QUE VOCÊ SAIBA',
    directHint: 'O QUE ACHEI NO PORÃO',
    visualHint: 'uma pasta de caso com fotos de evidências',
    centralElement: 'uma pasta de caso entreaberta sobre uma mesa escura',
    accentColor: 'azul frio de cena de crime',
  };
  const prompt = buildThumbnailImagePrompt(ctx, brief);

  it('substitui TODOS os campos entre colchetes pelos dados do vídeo', () => {
    expect(prompt).toContain('TEMA DO CANAL: Crimes impressionantes da vida real');
    expect(prompt).toContain('TÍTULO DO VÍDEO: A LEI SANGRENTA: O Crime que REFORMULOU a Justiça');
    expect(prompt).toContain('DESCRIÇÃO/RESUMO: Como um crime brutal em 1987');
    expect(prompt).toContain('SCRIPT/RESUMO DO CONTEÚDO: Abertura:');
    expect(prompt).toContain('DICA VISUAL QUE DEVE SER INSINUADA: uma pasta de caso com fotos de evidências');
    expect(prompt).toContain('- Elemento central: uma pasta de caso entreaberta sobre uma mesa escura');
    expect(prompt).toContain('- Paleta: preto, vermelho sangue (#8B0000), branco sujo e 1 cor de destaque coerente com o tema e com este vídeo: azul frio de cena de crime');
    expect(prompt).toContain('linha 1: “ELES NÃO QUEREM QUE VOCÊ SAIBA”');
    expect(prompt).toContain('linha 2 (menor, amarela): “O QUE ACHEI NO PORÃO”');
    // nenhum placeholder sobrando
    expect(prompt).not.toMatch(/\[[A-ZÁÉÍÓÚÂÊÔÃÕÇ][^\]]*\]/);
    expect(prompt).not.toContain('{{');
    expect(prompt).not.toContain('undefined');
  });

  it('mantém o texto do prompt-base: regras faceless, composição, clickbait e negativo', () => {
    for (const needle of [
      'Crie uma thumbnail de YouTube ultra clickbait para um canal dark/faceless',
      'formato 16:9 (1280x720), estilo fotorrealista cinematográfico',
      'REGRA DE ADAPTAÇÃO AO TEMA DO CANAL:',
      'REGRA PRINCIPAL DO CANAL (FACELESS):',
      '- NÃO mostrar rosto humano',
      '- NÃO usar expressão facial de choque',
      '- Metade direita da imagem reservada para texto grande e impactante, com espaço negativo escuro',
      'vermelho sangue (#8B0000)',
      'lente 35mm, qualidade 8K',
      '- Seta vermelha grossa apontando para o detalhe revelador',
      '- Círculo vermelho irregular destacando o “segredo”',
      '- Ícone de interrogação grande e semi-transparente no fundo',
      '(Impact ou Bebas Neue) com contorno preto:',
      'NEGATIVO (o que NÃO incluir):',
      'rosto humano, apresentador, youtuber, selfie, pessoa identificável, mão reconhecível, expressão facial, cartoon',
    ]) {
      expect(prompt, needle).toContain(needle);
    }
  });

  it('avisa que as aspas só delimitam o texto (para não serem desenhadas)', () => {
    expect(prompt).toContain('NÃO as desenhe na imagem');
  });
});

describe('briefing criativo', () => {
  it('o prompt do briefing leva os dados do vídeo e as regras de tema e faceless', () => {
    const p = buildThumbnailBriefPrompt(ctx);
    expect(p).toContain('TEMA DO CANAL: Crimes impressionantes da vida real');
    expect(p).toContain('TÍTULO: A LEI SANGRENTA');
    expect(p).toContain('IDIOMA DOS TEXTOS ESCRITOS NA THUMBNAIL: Portuguese (BR)');
    expect(p).toContain('true crime, evidência/mapa com marcação');
    expect(p).toContain('nenhum campo pode pedir rosto');
    expect(p).toContain('"hookWord"');
    expect(p).toContain('"accentColor"');
    expect(p).toContain('cor de destaque da paleta');
  });

  it('limpa o texto que vai escrito na imagem: sem aspas/emoji, MAIÚSCULAS, no máximo 6 palavras', () => {
    expect(cleanOverlayText('  "o que ninguém te contou" 😱 ')).toBe('O QUE NINGUÉM TE CONTOU');
    expect(cleanOverlayText('uma duas três quatro cinco seis sete oito')).toBe('UMA DUAS TRÊS QUATRO CINCO SEIS');
    expect(cleanOverlayText('palavra-extremamente-longa-que-estoura-o-limite de caracteres', 6, 20).length).toBeLessThanOrEqual(20);
    expect(cleanOverlayText(undefined)).toBe('');
    expect(cleanOverlayText('...!!!')).toBe('');
  });

  it('aceita objeto ou texto JSON (inclusive com cerca de markdown) e sanitiza', () => {
    const good = { hookWord: '"eles esconderam isso"', directHint: 'o que a polícia achou', visualHint: 'uma fita de CCTV com data apagada', centralElement: 'uma pasta de caso aberta', accentColor: 'âmbar queimado' };
    const a = parseThumbnailBrief(good, ctx);
    expect(a.accentColor).toBe('âmbar queimado');
    expect(a.hookWord).toBe('ELES ESCONDERAM ISSO');
    expect(a.directHint).toBe('O QUE A POLÍCIA ACHOU');
    expect(a.visualHint).toBe('uma fita de CCTV com data apagada');
    const b = parseThumbnailBrief('```json\n' + JSON.stringify(good) + '\n```', ctx);
    expect(b).toEqual(a);
  });

  it('campos vazios ou inutilizáveis são trocados pelo briefing local (nunca fica campo vazio)', () => {
    const fb = buildFallbackThumbnailBrief(ctx);
    const out = parseThumbnailBrief({ hookWord: '', directHint: '😱😱', visualHint: '', centralElement: null, accentColor: '' }, ctx);
    expect(out).toEqual(fb);
    expect(parseThumbnailBrief('isso não é json', ctx)).toEqual(fb);
    expect(parseThumbnailBrief(null, ctx)).toEqual(fb);
    for (const v of Object.values(fb)) expect(String(v).length).toBeGreaterThan(5);
  });

  it('canal faceless: descarta visual/elemento que peçam rosto ou apresentador, mas aceita "sem rosto"', () => {
    const fb = buildFallbackThumbnailBrief(ctx);
    const bad = parseThumbnailBrief({ hookWord: 'X Y', directHint: 'Z W', visualHint: 'um rosto em choque olhando para a câmera', centralElement: 'um apresentador apontando' }, ctx);
    expect(bad.visualHint).toBe(fb.visualHint);
    expect(bad.centralElement).toBe(fb.centralElement);
    const ok = parseThumbnailBrief({ hookWord: 'X Y', directHint: 'Z W', visualHint: 'uma silhueta anônima sem rosto numa janela', centralElement: 'uma janela iluminada' }, ctx);
    expect(ok.visualHint).toBe('uma silhueta anônima sem rosto numa janela');
  });
});

describe('briefing local por tema e idioma', () => {
  it('detecta o universo do tema', () => {
    expect(detectThemeKind('Crimes impressionantes da vida real')).toBe('crime');
    expect(detectThemeKind('História sombria e civilizações antigas')).toBe('history');
    expect(detectThemeKind('Tecnologia e inteligência artificial')).toBe('tech');
    expect(detectThemeKind('Finanças ocultas e dinheiro')).toBe('finance');
    expect(detectThemeKind('Psicologia sombria')).toBe('psychology');
    expect(detectThemeKind('Curiosidades aleatórias')).toBe('generic');
  });

  it('true crime usa evidências/pastas; tecnologia usa telas/servidores', () => {
    const crime = buildFallbackThumbnailBrief(ctx);
    expect(crime.visualHint).toMatch(/pasta de caso|evidências/);
    expect(crime.directHint).toBe('O QUE A POLÍCIA ESCONDEU');
    const tech = buildFallbackThumbnailBrief({ ...ctx, channelTheme: 'Tecnologia e IA' });
    expect(tech.visualHint).toMatch(/tela|código/);
    expect(crime.accentColor).toBe('azul frio de cena de crime');
    expect(tech.accentColor).toBe('verde fósforo de terminal');
  });

  it('gancho local vem do título (parte antes de ":") e o idioma muda a dica direta', () => {
    expect(buildFallbackThumbnailBrief(ctx).hookWord).toBe('A LEI SANGRENTA');
    const en = buildFallbackThumbnailBrief({ ...ctx, language: 'English', title: 'The Vanishing of Flight 19' });
    expect(en.directHint).toBe('WHAT POLICE HID');
    expect(en.hookWord).toBe('THE VANISHING OF FLIGHT');
  });
});
