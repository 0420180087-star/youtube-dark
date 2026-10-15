/**
 * Idea Engine — lógica de brainstorm compartilhada entre o app (navegador) e o
 * runner headless do GitHub Actions (scripts/automation-runner.js).
 *
 * Funções PURAS: sem React, sem Supabase, sem APIs do Node/DOM. Assim o mesmo
 * código roda nos dois lados e pode ser testado isoladamente.
 *
 * Por que existe: o runner tinha uma cópia empobrecida do brainstorm (sem a
 * Biblioteca, sem a descrição do canal, sem ângulo novo a cada tentativa, uma
 * única tentativa e fallback fixo em inglês). Agora ele usa o MESMO prompt do
 * app e ainda recebe a "memória do canal" (o que já foi produzido/descartado).
 */

import type { ProjectIdea, Video } from '../types';

export interface IdeaDraft {
  topic: string;
  context: string;
  specificContext?: string;
}

// ---------------------------------------------------------------------------
// Similaridade de tópicos (Jaccard por palavras). > 0.6 = mesmo assunto.
// ---------------------------------------------------------------------------

export function topicWords(topic: unknown): Set<string> {
  return new Set(
    String(topic || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
}

export function isTooSimilarTopic(topic: unknown, previous: unknown[], threshold = 0.6): boolean {
  const a = topicWords(topic);
  if (!a.size) return true;
  return previous.some((p) => {
    const b = topicWords(p);
    if (!b.size) return false;
    let inter = 0;
    a.forEach((w) => {
      if (b.has(w)) inter++;
    });
    return inter / (a.size + b.size - inter) > threshold;
  });
}

/**
 * Filtra as ideias geradas: descarta as que repetem assuntos anteriores E as
 * que repetem umas às outras dentro do mesmo lote. Mantém a ordem original.
 */
export function selectFreshIdeas<T extends { topic: string }>(
  generated: T[],
  previousTopics: string[],
  threshold = 0.6
): T[] {
  const seen = previousTopics.filter(Boolean);
  const out: T[] = [];
  for (const idea of generated) {
    const topic = String(idea?.topic || '').trim();
    if (!topic) continue;
    if (isTooSimilarTopic(topic, seen, threshold)) continue;
    out.push(idea);
    seen.push(topic);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contexto de conhecimento
// ---------------------------------------------------------------------------

/** Formata a Biblioteca exatamente como o Brainstorm manual do app faz. */
export function buildLibraryContext(
  library?: Array<{ type?: string; title?: string; content?: string }>
): string {
  return (library || [])
    .map((item) => {
      const prefix =
        item.type === 'youtube_channel' ? 'YOUTUBE_REFERENCE_CHANNEL' : (item.type || 'info').toUpperCase();
      return `[${prefix}] ${item.title}: ${item.content}`;
    })
    .join('\n');
}

const STATUS_LABEL: Record<string, string> = {
  PUBLISHED: 'published',
  SCHEDULED: 'finished, waiting to be published',
};

/**
 * "Memória do canal": resumo do que o canal JÁ produziu (com resumo e temas
 * do roteiro) e do que o dono descartou. É a base para o brainstorm trazer
 * ideias realmente NOVAS — ou desdobramentos de vídeos anteriores.
 */
export function buildChannelMemory(
  project: { videos?: Array<Partial<Video>>; ideas?: Array<Partial<ProjectIdea>> },
  opts: { maxVideos?: number; maxChars?: number } = {}
): string {
  const maxVideos = opts.maxVideos ?? 40;
  const maxChars = opts.maxChars ?? 7000;

  const videos = [...(project.videos || [])]
    .filter((v) => v && typeof v.title === 'string' && v.title.trim())
    .sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0))
    .slice(0, maxVideos);

  const lines: string[] = [];
  if (videos.length) {
    lines.push('PRODUCED VIDEOS (newest first):');
    for (const v of videos) {
      const state = STATUS_LABEL[String(v.status)] || 'in production';
      const summary = String(v.script?.description || v.specificContext || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220);
      const themes = (v.script?.coreThemes || []).filter(Boolean).slice(0, 4).join(', ');
      lines.push(
        `- "${String(v.title).trim()}" (${state})${summary ? ` — ${summary}` : ''}${themes ? ` | themes: ${themes}` : ''}`
      );
    }
  }

  const dismissed = (project.ideas || [])
    .filter((i) => i && i.status === 'dismissed' && i.topic)
    .slice(-15);
  if (dismissed.length) {
    lines.push('REJECTED IDEAS (the owner dismissed these — avoid similar ones):');
    for (const i of dismissed) lines.push(`- "${i.topic}"`);
  }

  if (!lines.length) return '';

  // Corta em fim de linha para nunca deixar uma entrada pela metade.
  let out = '';
  for (const line of lines) {
    if (out.length + line.length + 1 > maxChars) break;
    out += (out ? '\n' : '') + line;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt do brainstorm (fonte única — usado por generateVideoIdeas e pelo runner)
// ---------------------------------------------------------------------------

export interface IdeasPromptParams {
  channelTheme: string;
  description?: string;
  tone?: string;
  language?: string;
  excludeTopics?: string[];
  libraryContext?: string;
  freshAngle?: string;
  /** Memória do canal (ver buildChannelMemory). Opcional. */
  channelMemory?: string;
  /** Quantas ideias pedir. O app usa 4. */
  count?: number;
  /**
   * true quando a chamada NÃO usa responseSchema (runner): acrescenta a
   * instrução explícita do formato JSON no fim do prompt.
   */
  jsonInstruction?: boolean;
}

export function buildIdeasPrompt(p: IdeasPromptParams): string {
  const channelTheme = p.channelTheme;
  const description = p.description || '';
  const tone = p.tone || 'Engaging';
  const language = p.language || 'English';
  const excludeTopics = p.excludeTopics || [];
  const libraryContext = p.libraryContext || '';
  const freshAngle = p.freshAngle || '';
  const count = p.count ?? 4;

  let exclusionsText = '';
  if (excludeTopics.length > 0) {
    const recentExclusions = excludeTopics.slice(-25);
    exclusionsText = `ALREADY COVERED (avoid repeating these exact topics): ${JSON.stringify(recentExclusions)}. Explore completely different angles and subjects.`;
  }

  const freshAngleText = freshAngle
    ? `CREATIVE DIRECTION FOR THIS BATCH: Focus your ideas around the angle of "${freshAngle}". This will help generate fresh perspectives not covered before.`
    : '';

  let libraryPrompt = '';
  if (libraryContext) {
    libraryPrompt = `CHANNEL KNOWLEDGE BASE & REFERENCES:
--------------------------------------------------
${libraryContext.substring(0, 15000)}
--------------------------------------------------

INSTRUCTIONS FOR REFERENCES:
- If you see [YOUTUBE_REFERENCE_CHANNEL], these are channels that the user likes. Analyze their titles, style, and themes from the provided context/URL and adapt the "vibe" to our channel.
- Use other [TEXT], [LINK], or [BOOK] items as factual source material for the ideas.`;
  }

  let memoryPrompt = '';
  if (p.channelMemory) {
    memoryPrompt = `CHANNEL MEMORY (what this channel has already produced or rejected):
--------------------------------------------------
${p.channelMemory}
--------------------------------------------------
MEMORY RULES: Do NOT repeat or paraphrase any subject listed above. You MAY propose follow-ups, related cases or a clearly different angle that build on this memory, as long as the central subject of each idea is new.`;
  }

  const clickbaitStrategy = `
CLICKBAIT STRATEGY (Hybrid Type 1 & Type 2):
- Type 1 (Curiosity Gap): Create a massive information gap. Use "The Secret...", "What they didn't tell you...", "The truth about...".
- Type 2 (Extreme/Polarizing): Use strong emotional hooks or consequences. "I Regret This", "The End of...", "Don't Do This", "This Changed Everything".
- HYBRID GOAL: Combine both. Create a mystery with a high-stakes consequence.
`;

  let prompt = `You are a YouTube Strategist for a channel about "${channelTheme}". Channel Description: "${description || 'General niche content'}". Target Narrative Tone: "${tone}". Target Language: "${language}" (Write the topics and context strictly in this language). ${libraryPrompt} ${memoryPrompt} ${exclusionsText} ${freshAngleText}
Generate ${count} unique, high-potential, click-worthy video ideas that fit this channel.
${clickbaitStrategy}
The ideas MUST reflect the specified Tone (e.g., if tone is 'Dark', use mysterious vocabulary; if 'Tech', use modern/crisp vocabulary).
For each idea provide:
1. A catchy 'topic' (Video Title). Must be in ${language}.
2. A 'context' (A brief 1-2 sentence summary for the idea card). Must be in ${language}.
3. A 'specificContext' (A detailed, paragraph-long explanation including specific plot points, key details to cover, or a unique angle to explore. This will be used to guide the script generator). Must be in ${language}.`;

  if (p.jsonInstruction) {
    prompt += `

Return ONLY valid JSON (no markdown, no commentary) in exactly this shape:
{ "ideas": [ { "topic": "video title", "context": "brief summary", "specificContext": "detailed angle" } ] }`;
  }

  return prompt;
}

// ---------------------------------------------------------------------------
// Ângulos e fallback
// ---------------------------------------------------------------------------

export const FRESH_ANGLES = [
  'untold history',
  'modern mystery',
  'shocking facts',
  'hidden truth',
  'expert insights',
  'controversial take',
];

const isPortuguese = (language?: string) => /portugu|^pt\b|^pt[-_]/i.test(String(language || ''));

/**
 * Último recurso, só quando a IA falhou nas tentativas (rede/JSON — NÃO cota).
 * Fala o idioma do projeto e varia semente/ângulo para nunca repetir título.
 */
export function buildFallbackIdeas(p: {
  channelTheme: string;
  description?: string;
  language?: string;
  count?: number;
  now?: Date;
  rand?: () => number;
}): IdeaDraft[] {
  const rand = p.rand || Math.random;
  const pt = isPortuguese(p.language);
  const seeds = pt
    ? [
        'A história não contada de',
        'A verdade escondida por trás de',
        'O que ninguém te conta sobre',
        'Por que todo mundo erra sobre',
        'O caso mais estranho de',
        'O lado esquecido de',
      ]
    : [
        'The Untold Story of',
        'The Hidden Truth Behind',
        'What Nobody Tells You About',
        'Why Everyone is Wrong About',
        'The Strangest Case of',
        'The Forgotten Side of',
      ];
  const angles = pt
    ? [
        'nos anos 1980',
        'que a polícia ignorou',
        'que ninguém resolveu',
        'na visão de um sobrevivente',
        'a portas fechadas',
        'que chocou uma cidade pequena',
        'com uma única pista',
        'décadas depois',
      ]
    : [
        'in the 1980s',
        'that police ignored',
        'no one solved',
        "from a survivor's view",
        'behind closed doors',
        'that shocked a small town',
        'with one tiny clue',
        'decades later',
      ];
  const stamp = (p.now || new Date()).toISOString().slice(0, 10);
  const count = Math.max(1, Math.min(p.count ?? 3, seeds.length));
  const start = Math.floor(rand() * seeds.length);
  const theme = p.channelTheme;
  const extra = (p.description || '').trim();

  const out: IdeaDraft[] = [];
  for (let i = 0; i < count; i++) {
    const seed = seeds[(start + i) % seeds.length];
    const angle = angles[Math.floor(rand() * angles.length)];
    out.push({
      topic: `${seed} ${theme} ${angle} (#${stamp}-${Math.floor(rand() * 1000)})`,
      context: pt ? `Um mergulho envolvente em ${theme}.` : `An engaging deep-dive about ${theme}.`,
      specificContext: (pt
        ? `Explore ${theme} por um ângulo novo e de alto potencial de clique. ${extra}`
        : `Explore ${theme} from a fresh, click-worthy angle. ${extra}`
      ).trim(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vínculo ideia → vídeo (gestão de conhecimento)
// ---------------------------------------------------------------------------

/**
 * Registra, na ideia usada, em qual vídeo ela virou. Retorna um NOVO array
 * (não muta o original). Se a ideia não existir, devolve o array inalterado.
 */
export function linkIdeaToVideo<T extends Partial<ProjectIdea>>(
  ideas: T[] | undefined,
  ideaId: string | undefined,
  info: { videoId: string; videoTitle?: string; youtubeUrl?: string | null; usedAt?: string }
): T[] {
  const list = ideas || [];
  if (!ideaId) return list;
  return list.map((i) =>
    i.id === ideaId
      ? {
          ...i,
          status: 'used' as const,
          usedAt: i.usedAt || info.usedAt || new Date().toISOString(),
          videoId: info.videoId,
          videoTitle: info.videoTitle || i.videoTitle,
          youtubeUrl: info.youtubeUrl || i.youtubeUrl,
        }
      : i
  );
}

const normContext = (value: unknown) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Restaura, em ideias JÁ usadas por vídeos antigos da automação, o vínculo ideia → vídeo.
 * O runner sempre gravou no vídeo o mesmo contexto da ideia (specificContext), então o
 * casamento é exato. Só vincula quando é INEQUÍVOCO: contexto longo o bastante, um único
 * vídeo com aquele contexto e nenhuma outra ideia disputando o mesmo vídeo.
 * Não muta os arrays recebidos; se nada casar devolve o MESMO array de ideias.
 */
export function backfillIdeaVideoLinks<T extends Partial<ProjectIdea>>(
  ideas: T[] | undefined,
  videos: Array<Partial<Video>> | undefined
): { ideas: T[]; linked: number } {
  const list = ideas || [];
  const byContext = new Map<string, Array<Partial<Video>>>();
  for (const v of videos || []) {
    const key = normContext(v?.specificContext);
    if (!v?.id || key.length < 20) continue;
    const bucket = byContext.get(key);
    if (bucket) bucket.push(v);
    else byContext.set(key, [v]);
  }

  // Quantas ideias elegíveis disputam cada contexto (contexto repetido = ambíguo).
  const claimsPerContext = new Map<string, number>();
  for (const i of list) {
    if (i?.status !== 'used' || i.videoId) continue;
    const key = normContext(i.specificContext || i.context);
    if (key.length >= 20) claimsPerContext.set(key, (claimsPerContext.get(key) || 0) + 1);
  }

  let linked = 0;
  const out = list.map((i) => {
    if (i?.status !== 'used' || i.videoId) return i;
    const key = normContext(i.specificContext || i.context);
    const matches = byContext.get(key);
    if (key.length < 20 || !matches || matches.length !== 1 || claimsPerContext.get(key) !== 1) return i;
    const v = matches[0];
    linked++;
    return {
      ...i,
      videoId: v.id as string,
      videoTitle: v.title || i.videoTitle,
      youtubeUrl: v.youtubeUrl || i.youtubeUrl,
      usedAt: i.usedAt || v.createdAt,
    };
  });
  return { ideas: linked ? out : list, linked };
}
