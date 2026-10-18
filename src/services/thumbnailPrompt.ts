/**
 * Thumbnail Prompt — UM prompt-base para TODAS as formas de criar thumbnail
 * (100% automático no GitHub Actions, piloto automático no navegador e manual).
 *
 * O prompt-base (canal dark/faceless, ultra clickbait) tem campos que mudam a cada
 * vídeo. Aqui eles são preenchidos assim:
 *   • dados reais do projeto/vídeo → TEMA DO CANAL, TÍTULO, DESCRIÇÃO/RESUMO e
 *     SCRIPT/RESUMO DO CONTEÚDO (tirados do próprio roteiro);
 *   • campos criativos → um "briefing" gerado pelo Gemini (texto) a partir do vídeo:
 *     PALAVRA GANCHO (linha 1), DICA DIRETA (linha 2), DICA VISUAL e ELEMENTO CENTRAL.
 *     Se a IA de texto falhar, entra um briefing local determinístico (por tema), então
 *     a thumbnail nunca fica com campo vazio.
 *
 * Funções PURAS (sem React/Node/DOM): rodam no app e no runner e são testadas em
 * thumbnailPrompt.test.ts.
 */

export interface ThumbnailScriptLike {
  title?: string;
  description?: string;
  coreThemes?: string[];
  segments?: Array<{ sectionTitle?: string; narratorText?: string }>;
}

export interface ThumbnailContext {
  /** TEMA DO CANAL */
  channelTheme: string;
  /** TÍTULO DO VÍDEO */
  title: string;
  /** Idioma do vídeo (os textos escritos na imagem seguem este idioma). */
  language?: string;
  /** Resumo explícito (opcional). Sem ele, sai da descrição/narração do roteiro. */
  description?: string;
  script?: ThumbnailScriptLike | null;
  /** Texto de apoio quando não há roteiro estruturado. */
  fallbackSummary?: string;
}

export interface ThumbnailBrief {
  /** Linha 1 do texto na imagem (gancho). */
  hookWord: string;
  /** Linha 2 do texto na imagem (menor, amarela). */
  directHint: string;
  /** DICA VISUAL QUE DEVE SER INSINUADA */
  visualHint: string;
  /** Elemento central da composição */
  centralElement: string;
}

// ---------------------------------------------------------------------------
// Utilidades de texto
// ---------------------------------------------------------------------------

const collapse = (text: unknown): string => String(text ?? '').replace(/\s+/g, ' ').trim();

/** Corta em fim de palavra, com reticências, no máximo `max` caracteres. */
function clip(text: unknown, max: number): string {
  const t = collapse(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.\-–—]+$/, '')}…`;
}

const isPortuguese = (language?: string) => /portugu|^pt\b|^pt[-_]/i.test(String(language || 'Portuguese'));

// ---------------------------------------------------------------------------
// Campos preenchidos com dados reais do vídeo
// ---------------------------------------------------------------------------

/** DESCRIÇÃO/RESUMO — 1 a 2 linhas. */
export function buildThumbnailSummary(ctx: ThumbnailContext): string {
  const explicit = collapse(ctx.description);
  if (explicit) return clip(explicit, 240);

  const fromScript = collapse(ctx.script?.description);
  if (fromScript) return clip(fromScript, 240);

  const narration = collapse((ctx.script?.segments || []).slice(0, 2).map((s) => s?.narratorText).join(' '));
  if (narration) {
    const sentences = narration.match(/[^.!?]+[.!?]+/g);
    return clip(sentences ? sentences.slice(0, 2).join(' ') : narration, 240);
  }
  return clip(ctx.fallbackSummary, 240);
}

/** SCRIPT/RESUMO DO CONTEÚDO — pontos principais e trechos do roteiro. */
export function buildThumbnailContent(ctx: ThumbnailContext, maxChars = 900): string {
  const segments = (ctx.script?.segments || []).filter((s) => collapse(s?.narratorText));
  if (!segments.length) return clip(ctx.fallbackSummary || buildThumbnailSummary(ctx), maxChars);

  const parts: string[] = [];
  parts.push(`Abertura: "${clip(segments[0].narratorText, 260)}"`);

  const titles = segments.map((s) => collapse(s.sectionTitle)).filter(Boolean).slice(0, 6);
  if (titles.length) parts.push(`Seções: ${titles.join(' → ')}`);

  const themes = (ctx.script?.coreThemes || []).map(collapse).filter(Boolean).slice(0, 4);
  if (themes.length) parts.push(`Temas centrais: ${themes.join(', ')}`);

  if (segments.length > 1) parts.push(`Desfecho: "${clip(segments[segments.length - 1].narratorText, 200)}"`);

  return clip(parts.join(' | '), maxChars);
}

// ---------------------------------------------------------------------------
// Briefing criativo (IA de texto) — prompt, validação e fallback local
// ---------------------------------------------------------------------------

export function buildThumbnailBriefPrompt(ctx: ThumbnailContext): string {
  return `Você é diretor de arte e copywriter de thumbnails de YouTube para canais dark/faceless (sem rosto, sem apresentador).

DADOS DO VÍDEO
- TEMA DO CANAL: ${collapse(ctx.channelTheme) || 'conteúdo geral'}
- TÍTULO: ${collapse(ctx.title)}
- RESUMO: ${buildThumbnailSummary(ctx)}
- CONTEÚDO (trechos do roteiro): ${buildThumbnailContent(ctx, 700)}
- IDIOMA DOS TEXTOS ESCRITOS NA THUMBNAIL: ${collapse(ctx.language) || 'Portuguese'}

Monte o briefing da thumbnail com 4 campos. Todos devem ser ESPECÍFICOS deste vídeo (nada genérico):

1. hookWord — linha 1 do texto da imagem: um gancho curto de curiosidade/mistério, em MAIÚSCULAS, de 2 a 5 palavras, no idioma indicado acima. Exemplos de ESTILO (não copie): "ELES NÃO QUEREM QUE VOCÊ SAIBA", "NINGUÉM EXPLICOU ISSO".
2. directHint — linha 2 (menor): dica direta e concreta do que o vídeo revela, em MAIÚSCULAS, de 2 a 5 palavras, no idioma indicado acima. Exemplo de ESTILO (não copie): "O QUE ACHEI NO PORÃO".
3. visualHint — a dica visual que deve ser insinuada na imagem: UM detalhe típico do universo do TEMA DO CANAL, ligado ao conteúdo deste vídeo, em 1 frase em português. Adapte ao tema real: se for histórico, documento censurado/foto antiga/relíquia/arquivo; se for tecnologia, tela com erro/código/servidor; se for finanças, gráfico estranho/cofre/contrato; se for psicologia, espelho/corredor/símbolo/ambiente clínico; se for true crime, evidência/mapa com marcação/fita/pasta de caso. Nunca um elemento genérico de mistério.
4. centralElement — o objeto, ambiente ou detalhe MAIS FORTE para ficar no centro da composição, em 1 frase em português.

REGRAS
- Canal faceless: nenhum campo pode pedir rosto, pessoa, apresentador, mão ou expressão facial.
- Não invente fatos que contradigam o conteúdo. Sem emojis e sem aspas dentro dos textos.

Responda SOMENTE com JSON válido, sem markdown:
{"hookWord":"...","directHint":"...","visualHint":"...","centralElement":"..."}`;
}

const EMOJI_RE = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu;
const stripEmoji = (text: string) => text.replace(EMOJI_RE, '').replace(/\uFE0F/g, '');

/** Texto que vai ESCRITO na imagem: sem aspas/emoji, MAIÚSCULAS, no máximo 6 palavras e 40 caracteres. */
export function cleanOverlayText(value: unknown, maxWords = 6, maxChars = 40): string {
  let t = stripEmoji(collapse(value))
    .replace(/["“”„‟«»'`´]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^[\s\-–—:;,.!?]+|[\s\-–—:;,.]+$/g, '');
  t = t.toLocaleUpperCase('pt-BR');
  const words = t.split(' ').filter(Boolean).slice(0, maxWords);
  let out = '';
  for (const w of words) {
    if ((out ? out.length + 1 : 0) + w.length > maxChars) break;
    out += (out ? ' ' : '') + w;
  }
  return out;
}

// Canal faceless: descarta sugestões que pedem rosto/pessoa (a frase "sem rosto" é permitida).
const FACE_RE = /\b(rosto|face|faces|apresentador|apresentadora|youtuber|selfie|express[aã]o facial|olhando para a c[aâ]mera|olhar para a c[aâ]mera)\b/i;
const asksForFace = (text: string) => FACE_RE.test(text.replace(/sem\s+(um\s+)?rosto/gi, ''));

function cleanVisualField(value: unknown, max: number): string {
  const t = clip(stripEmoji(collapse(value)).replace(/["“”]/g, ''), max);
  return t && !asksForFace(t) ? t : '';
}

type ThemeKind = 'crime' | 'history' | 'tech' | 'finance' | 'psychology' | 'generic';

export function detectThemeKind(channelTheme: string): ThemeKind {
  const t = collapse(channelTheme)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (/crime|policial|assassin|serial|detetive|investiga|true crime|desaparec|caso arquivado|homicid/.test(t)) return 'crime';
  if (/histor|guerra|antig|medieval|imperio|civiliza|arqueolog|relic/.test(t)) return 'history';
  if (/tecnolog|\bia\b|inteligencia artificial|codigo|hacker|software|cyber|ciberseg|computa|robo/.test(t)) return 'tech';
  if (/financ|dinheiro|invest|banco|econom|cripto|bolsa|rique/.test(t)) return 'finance';
  if (/psicolog|mente|comportament|trauma|manipula|cerebro/.test(t)) return 'psychology';
  return 'generic';
}

const FALLBACK_VISUALS: Record<ThemeKind, { visualHint: string; centralElement: string }> = {
  crime: {
    visualHint: 'uma pasta de caso com fotos de evidências e um mapa com marcações vermelhas, com um detalhe fora do lugar',
    centralElement: 'uma pasta de caso entreaberta sobre uma mesa escura, com evidências espalhadas e uma fita de cena de crime ao fundo',
  },
  history: {
    visualHint: 'um documento antigo parcialmente censurado ao lado de uma fotografia envelhecida',
    centralElement: 'um arquivo histórico aberto sobre uma mesa de madeira escura, com relíquias e um documento rasgado',
  },
  tech: {
    visualHint: 'uma tela com mensagem de erro e linhas de código vazadas',
    centralElement: 'um monitor antigo num corredor de servidores escuros exibindo um erro em vermelho',
  },
  finance: {
    visualHint: 'um gráfico em queda estranha e um contrato com trechos riscados',
    centralElement: 'um cofre entreaberto com contratos e planilhas espalhados sob luz fria',
  },
  psychology: {
    visualHint: 'um espelho rachado refletindo um corredor clínico vazio',
    centralElement: 'um corredor clínico escuro com um espelho rachado e um símbolo estranho riscado na parede',
  },
  generic: {
    visualHint: 'um arquivo confidencial com carimbo vermelho e uma página arrancada',
    centralElement: 'uma pasta confidencial entreaberta sobre uma mesa escura, com um detalhe revelador iluminado',
  },
};

const FALLBACK_DIRECT_HINT: Record<'pt' | 'en', Record<ThemeKind, string>> = {
  pt: {
    crime: 'O QUE A POLÍCIA ESCONDEU',
    history: 'O QUE OS ARQUIVOS REVELAM',
    tech: 'O ERRO QUE NINGUÉM VIU',
    finance: 'PARA ONDE FOI O DINHEIRO',
    psychology: 'O QUE ESTÁ POR TRÁS DISSO',
    generic: 'A VERDADE POR TRÁS DISSO',
  },
  en: {
    crime: 'WHAT POLICE HID',
    history: 'WHAT THE ARCHIVES REVEAL',
    tech: 'THE ERROR NOBODY SAW',
    finance: 'WHERE THE MONEY WENT',
    psychology: "WHAT'S BEHIND IT",
    generic: 'THE TRUTH BEHIND IT',
  },
};

/** Gancho local a partir do título: parte antes de ":" se curta, senão as primeiras palavras. */
function hookFromTitle(title: string): string {
  const t = collapse(title);
  const beforeColon = t.split(/\s*[:—–|]\s*/)[0];
  const base = beforeColon && beforeColon.split(' ').length >= 2 && beforeColon.split(' ').length <= 6 ? beforeColon : t;
  return cleanOverlayText(base, 4, 32);
}

/** Briefing 100% local (sem IA) — usado quando o Gemini de texto falha ou devolve algo inutilizável. */
export function buildFallbackThumbnailBrief(ctx: ThumbnailContext): ThumbnailBrief {
  const kind = detectThemeKind(ctx.channelTheme);
  const lang = isPortuguese(ctx.language) ? 'pt' : 'en';
  return {
    hookWord: hookFromTitle(ctx.title) || (lang === 'pt' ? 'NINGUÉM EXPLICOU ISSO' : 'NOBODY EXPLAINED THIS'),
    directHint: FALLBACK_DIRECT_HINT[lang][kind],
    ...FALLBACK_VISUALS[kind],
  };
}

/**
 * Valida/limpa a resposta da IA. Cada campo inválido é substituído pelo equivalente do briefing
 * local, então o resultado SEMPRE tem os 4 campos preenchidos.
 */
export function parseThumbnailBrief(raw: unknown, ctx: ThumbnailContext): ThumbnailBrief {
  const fb = buildFallbackThumbnailBrief(ctx);
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === 'string') {
    const text = raw.replace(/```json|```/g, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { obj = JSON.parse(text.slice(start, end + 1)); } catch { obj = null; }
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }
  if (!obj) return fb;

  return {
    hookWord: cleanOverlayText(obj.hookWord) || fb.hookWord,
    directHint: cleanOverlayText(obj.directHint) || fb.directHint,
    visualHint: cleanVisualField(obj.visualHint, 220) || fb.visualHint,
    centralElement: cleanVisualField(obj.centralElement, 220) || fb.centralElement,
  };
}

// ---------------------------------------------------------------------------
// PROMPT-BASE (texto do usuário) com os campos entre colchetes preenchidos
// ---------------------------------------------------------------------------

export function buildThumbnailImagePrompt(ctx: ThumbnailContext, brief: ThumbnailBrief): string {
  return `Crie uma thumbnail de YouTube ultra clickbait para um canal dark/faceless (sem apresentador, sem rosto humano identificável, sem o criador aparecendo), formato 16:9 (1280x720), estilo fotorrealista cinematográfico.

TEMA DO CANAL: ${collapse(ctx.channelTheme) || 'conteúdo geral'}

TÍTULO DO VÍDEO: ${collapse(ctx.title)}
DESCRIÇÃO/RESUMO: ${buildThumbnailSummary(ctx)}
SCRIPT/RESUMO DO CONTEÚDO: ${buildThumbnailContent(ctx)}
DICA VISUAL QUE DEVE SER INSINUADA: ${brief.visualHint}

REGRA DE ADAPTAÇÃO AO TEMA DO CANAL:
- Adapte TODOS os elementos visuais ao universo semântico do TEMA DO CANAL.
- Escolha objetos, ambientes, texturas, iluminação e cores coerentes com esse tema.
- A dica visual deve ser um detalhe típico desse tema, não um elemento genérico de mistério.
- Se o tema for histórico, use documentos, fotos antigas, relíquias e arquivos; se for tecnologia, use telas, código, servidores e erros; se for finanças, use gráficos, cofres, contratos e planilhas; se for psicologia, use espelhos, corredores, símbolos e ambientes clínicos; se for true crime, use evidências, mapas, fitas e pastas de caso. Adapte conforme o tema real.

REGRA PRINCIPAL DO CANAL (FACELESS):
- NÃO mostrar rosto humano
- NÃO mostrar apresentador, youtuber, selfie ou pessoa identificável
- NÃO usar expressão facial de choque
- O apelo deve vir de objeto, ambiente, documento, tela, silhueta anônima sem rosto ou detalhe estranho

COMPOSIÇÃO:
- Elemento central: ${brief.centralElement}
- Metade direita da imagem reservada para texto grande e impactante, com espaço negativo escuro
- Iluminação dramática em chiaroscuro, fundo escuro profundo com névoa sutil
- Paleta: preto, vermelho sangue (#8B0000), branco sujo e 1 cor de destaque coerente com o tema (âmbar, azul frio, verde doentio, etc.)
- Alto contraste, granulação de filme/VHS, vinheta escura nas bordas
- Regra dos terços, profundidade de campo rasa, lente 35mm, qualidade 8K

ELEMENTOS CLICKBAIT OBRIGATÓRIOS:
- Seta vermelha grossa apontando para o detalhe revelador
- Círculo vermelho irregular destacando o “segredo”
- Ícone de interrogação grande e semi-transparente no fundo
- Texto overlay em fonte bold impactante (Impact ou Bebas Neue) com contorno preto:
  linha 1: “${brief.hookWord}”
  linha 2 (menor, amarela): “${brief.directHint}”
  (As aspas “ ” só delimitam o texto aqui: NÃO as desenhe na imagem. Escreva exatamente as palavras indicadas, sem erros de ortografia.)

ESTILO TÉCNICO:
- Fotorrealismo cinematográfico
- Sem watermark, sem assinatura, sem texto extra além do especificado
- Composição limpa e legível mesmo em miniatura pequena

NEGATIVO (o que NÃO incluir):
rosto humano, apresentador, youtuber, selfie, pessoa identificável, mão reconhecível, expressão facial, cartoon, cores claras/festivas, fundo branco, excesso de elementos, poluição visual, watermark, assinatura.`;
}
