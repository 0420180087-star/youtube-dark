/**
 * THUMBNAIL & DESCRIPTION ENGINE
 * 
 * Intelligent clickbait thumbnail generation and 3-layer YouTube descriptions.
 * Tone-aware, SEO-optimized, and coherent between thumbnail text and description hook.
 */

import { ScriptData, ScriptSegment } from "../types";

// =============================================
// TYPES
// =============================================

export type ThumbnailStyle = 'viral' | 'cinematic' | 'horror' | 'clean' | 'neon' | 'warm';

export interface ThumbnailResult {
  /** Clickbait text for the thumbnail overlay (max 5 words) */
  clickbaitText: string;
  /** Full image generation prompt ready for Gemini */
  imagePrompt: string;
  /** Recommended visual style */
  style: ThumbnailStyle;
  /** Color palette description */
  colorPalette: string;
}

export interface DescriptionResult {
  /** Full YouTube description with all 3 layers */
  fullDescription: string;
  /** Layer 1: Hook (first 2 lines visible before "show more") */
  hook: string;
  /** Layer 2: Content summary */
  summary: string;
  /** Layer 3: SEO hashtags + CTA */
  seoBlock: string;
}

export interface ThumbnailDescriptionParams {
  title: string;
  script: ScriptData;
  narrativeTone: string;
  niche: string;
  language?: string;
}

// =============================================
// TONE → VISUAL STYLE MAPPING
// =============================================

interface ToneVisualConfig {
  style: ThumbnailStyle;
  colorPalette: string;
  visualKeywords: string;
  emotionalElement: string;
  descriptionVoice: string;
  clickbaitExamples: string[];
  textColor: string;
}

const TONE_CONFIGS: Record<string, ToneVisualConfig> = {
  'horror': {
    style: 'horror',
    colorPalette: 'dark blacks, deep reds, cold blues, fog whites',
    visualKeywords: 'dark horror style with red accents, dramatic shadows, fog, eerie atmosphere',
    emotionalElement: 'fearful expression close-up, wide terrified eyes',
    descriptionVoice: 'sombria, suspense, frases curtas e impactantes, linguagem tensa',
    clickbaitExamples: ['Você não deveria saber disso', 'O que eles escondem', 'Isso não deveria existir', 'Ninguém sobreviveu'],
  },
  'suspens': {
    style: 'horror',
    colorPalette: 'dark navy, shadow blacks, accent golds, muted teals',
    visualKeywords: 'dark mysterious style, dramatic lighting, shadows, tension',
    emotionalElement: 'intense gaze, suspicious expression, narrowed eyes',
    descriptionVoice: 'sombria, suspense, frases curtas e impactantes, mistério',
    clickbaitExamples: ['Você não deveria saber disso', 'A verdade escondida', 'Ninguém percebeu isso', 'O que realmente aconteceu'],
  },
  'dark': {
    style: 'horror',
    colorPalette: 'pure blacks, blood reds, ghostly whites, purple shadows',
    visualKeywords: 'dark atmospheric style, horror aesthetic, dramatic shadows, volumetric fog',
    emotionalElement: 'shocked terrified expression, mouth agape',
    descriptionVoice: 'sombria, frases curtas, linguagem tensa e impactante',
    clickbaitExamples: ['Isso é real', 'Ninguém acreditou', 'O que aconteceu depois', 'Você não vai acreditar'],
  },
  'motivat': {
    style: 'warm',
    colorPalette: 'warm oranges, golden yellows, sunrise pinks, deep purples',
    visualKeywords: 'motivational epic style, golden hour lighting, sunrise colors, empowering atmosphere',
    emotionalElement: 'determined powerful expression, clenched fist, triumphant pose',
    descriptionVoice: 'energética, verbos de ação, empoderamento, inspiração',
    clickbaitExamples: ['Isso mudou tudo', 'Ninguém te contou', 'Pare de fazer isso', 'O segredo que funciona'],
  },
  'energetic': {
    style: 'warm',
    colorPalette: 'fiery oranges, electric yellows, power reds, sunset golds',
    visualKeywords: 'energetic powerful style, dynamic lighting, bold colors, epic atmosphere',
    emotionalElement: 'excited triumphant expression, arms raised, celebration',
    descriptionVoice: 'energética, dinâmica, inspiradora, cheia de ação',
    clickbaitExamples: ['Isso mudou tudo', 'Agora ou nunca', 'Comece hoje', 'A virada aconteceu'],
  },
  'coach': {
    style: 'warm',
    colorPalette: 'deep orange, gold, motivational red, clean white',
    visualKeywords: 'coaching motivational style, sunrise backdrop, powerful atmosphere',
    emotionalElement: 'confident determined expression, pointing forward',
    descriptionVoice: 'direta, motivadora, verbos de ação, tom de mentor',
    clickbaitExamples: ['Pare de fazer isso', 'Isso mudou tudo', 'A verdade que dói', 'Você está fazendo errado'],
  },
  'education': {
    style: 'clean',
    colorPalette: 'clean whites, knowledge blues, accent greens, subtle grays',
    visualKeywords: 'clean educational style, bright professional lighting, modern minimal design',
    emotionalElement: 'surprised enlightened expression, wide eyes of discovery, lightbulb moment',
    descriptionVoice: 'clara, didática, promessa de aprendizado, linguagem acessível',
    clickbaitExamples: ['O erro que todos cometem', 'Simples assim', 'Ninguém ensina isso', 'A resposta surpreende'],
  },
  'explanat': {
    style: 'clean',
    colorPalette: 'blue whites, diagram blues, highlight yellows, clean grays',
    visualKeywords: 'explainer style, clean infographic aesthetic, bright and organized',
    emotionalElement: 'curious thoughtful expression, hand on chin',
    descriptionVoice: 'clara, lógica, passo a passo, didática',
    clickbaitExamples: ['O erro que todos cometem', 'Simples assim', 'Finalmente explicado', 'Agora faz sentido'],
  },
  'clear': {
    style: 'clean',
    colorPalette: 'clean whites, soft blues, mint greens, light grays',
    visualKeywords: 'clean minimal style, bright studio lighting, professional organized',
    emotionalElement: 'confident knowing expression, nodding',
    descriptionVoice: 'clara, objetiva, sem rodeios, fácil de entender',
    clickbaitExamples: ['Ninguém ensina isso', 'A verdade é simples', 'Você não sabia', 'Finalmente explicado'],
  },
  'wendover': {
    style: 'clean',
    colorPalette: 'infographic blues, data greens, map yellows, clean whites',
    visualKeywords: 'documentary explainer style, aerial maps, data visualization aesthetic',
    emotionalElement: 'intrigued analytical expression',
    descriptionVoice: 'analítica, informativa, curiosa, baseada em dados',
    clickbaitExamples: ['A logística impossível', 'Por que isso funciona', 'O sistema que ninguém vê', 'A matemática por trás'],
  },
  'business': {
    style: 'clean',
    colorPalette: 'corporate dark blues, gold accents, clean whites, power blacks',
    visualKeywords: 'corporate dark blue style, professional lighting, modern city backdrop',
    emotionalElement: 'shocked businessman expression, jaw dropped, professional disbelief',
    descriptionVoice: 'formal, dados, autoridade, tom profissional e confiante',
    clickbaitExamples: ['Por que você está perdendo dinheiro', 'A verdade sobre...', 'O mercado não quer que você saiba', 'Seus concorrentes já sabem'],
  },
  'corporate': {
    style: 'clean',
    colorPalette: 'navy blue, silver, executive gray, clean white',
    visualKeywords: 'corporate professional style, boardroom aesthetic, skyscraper backdrop',
    emotionalElement: 'serious authoritative expression, crossed arms',
    descriptionVoice: 'formal, autoritativa, baseada em dados e resultados',
    clickbaitExamples: ['A verdade sobre...', 'Seus concorrentes já sabem', 'O erro que custa milhões', 'Estratégia revelada'],
  },
  'finance': {
    style: 'clean',
    colorPalette: 'money green, gold, dark blue, chart red',
    visualKeywords: 'financial corporate style, stock market aesthetic, wealth imagery',
    emotionalElement: 'shocked expression at numbers, disbelief at charts',
    descriptionVoice: 'autoritativa, baseada em números, tom de especialista',
    clickbaitExamples: ['Perdendo dinheiro sem saber', 'O investimento que ninguém fala', 'Antes que seja tarde', 'O erro de R$ milhões'],
  },
  'crime': {
    style: 'cinematic',
    colorPalette: 'noir blacks, evidence yellows, blood reds, cold grays',
    visualKeywords: 'true crime noir style, police investigation aesthetic, evidence lighting',
    emotionalElement: 'serious investigative expression, stern face',
    descriptionVoice: 'sombria, investigativa, séria, linguagem de documentário criminal',
    clickbaitExamples: ['O caso que chocou', 'Ninguém acreditou', 'A evidência perdida', 'Caso não resolvido'],
  },
  'serious': {
    style: 'cinematic',
    colorPalette: 'black and white, muted tones, evidence yellows, cold blues',
    visualKeywords: 'serious documentary style, noir aesthetic, journalistic lighting',
    emotionalElement: 'intense serious expression, deep thought',
    descriptionVoice: 'séria, investigativa, documental, imparcial mas impactante',
    clickbaitExamples: ['O caso que chocou', 'Ninguém investigou', 'A verdade por trás', 'Caso encerrado?'],
  },
  'documentary': {
    style: 'cinematic',
    colorPalette: 'natural earth tones, sky blues, documentary grays, warm ambers',
    visualKeywords: 'documentary cinematic style, natural lighting, journalistic composition',
    emotionalElement: 'contemplative expression, gazing into distance',
    descriptionVoice: 'formal, jornalística, informativa, tom de narrador de documentário',
    clickbaitExamples: ['O que realmente aconteceu', 'A história que não contaram', 'Revelado pela primeira vez', 'Imagens inéditas'],
  },
  'calm': {
    style: 'warm',
    colorPalette: 'soft pastels, warm beiges, gentle greens, cozy ambers',
    visualKeywords: 'soft cozy style, warm golden hour lighting, gentle atmosphere',
    emotionalElement: 'serene peaceful expression, gentle smile, relaxed',
    descriptionVoice: 'suave, acolhedora, convidativa, linguagem de conforto',
    clickbaitExamples: ['Você precisa ver isso', 'Tente fazer isso hoje', 'O momento perfeito', 'Relaxe e assista'],
  },
  'cozy': {
    style: 'warm',
    colorPalette: 'candle warm, blanket beiges, tea browns, window rain blues',
    visualKeywords: 'cozy intimate style, candlelight warmth, interior comfort',
    emotionalElement: 'content peaceful smile, eyes half-closed, comfort',
    descriptionVoice: 'suave, íntima, acolhedora, como um abraço em palavras',
    clickbaitExamples: ['Você precisa disso', 'O momento perfeito', 'Assista antes de dormir', 'Puro conforto'],
  },
  'asmr': {
    style: 'warm',
    colorPalette: 'soft lavenders, gentle pinks, whisper whites, calm blues',
    visualKeywords: 'soft ASMR aesthetic, macro close-up textures, gentle lighting',
    emotionalElement: 'relaxed blissful expression, closed eyes, tingling',
    descriptionVoice: 'suave, delicada, sensorial, linguagem que acalma',
    clickbaitExamples: ['Você precisa ouvir isso', 'Sons que relaxam', 'Durma em minutos', 'Sensação única'],
  },
  'relax': {
    style: 'warm',
    colorPalette: 'ocean blues, sunset oranges, forest greens, sand beiges',
    visualKeywords: 'relaxing natural style, soft nature lighting, peaceful scenery',
    emotionalElement: 'peaceful meditative expression, deep breath',
    descriptionVoice: 'tranquila, contemplativa, convite ao descanso',
    clickbaitExamples: ['Você precisa ver isso', 'Pare e respire', 'O vídeo que acalma', 'Natureza pura'],
  },
  'gaming': {
    style: 'neon',
    colorPalette: 'neon greens, electric purples, RGB rainbows, dark blacks',
    visualKeywords: 'gaming neon style, RGB lighting, esports energy, electric atmosphere',
    emotionalElement: 'excited screaming expression, mind-blown reaction',
    descriptionVoice: 'dinâmica, gírias de gaming, energia alta, entusiasmo',
    clickbaitExamples: ['Ninguém faz isso', 'Isso é real?', 'Play insano', 'Impossível de repetir'],
  },
  'loud': {
    style: 'neon',
    colorPalette: 'explosive reds, neon yellows, electric blues, fire oranges',
    visualKeywords: 'high energy explosive style, neon lights, maximum intensity',
    emotionalElement: 'screaming mind-blown expression, hands on head',
    descriptionVoice: 'explosiva, cheia de energia, gírias, reações exageradas',
    clickbaitExamples: ['IMPOSSÍVEL', 'Ninguém esperava isso', 'O play do século', 'Ficou maluco'],
  },
  'fast': {
    style: 'viral',
    colorPalette: 'bold reds, attention yellows, contrast blacks, pop whites',
    visualKeywords: 'viral facts style, bold impactful design, eye-catching colors',
    emotionalElement: 'shocked wide-eyed expression, hand over mouth',
    descriptionVoice: 'dinâmica, rápida, impactante, frases curtas e diretas',
    clickbaitExamples: ['#1 chocou a todos', 'Impossível? Não.', 'Você não sabia disso', 'Fatos insanos'],
  },
  'viral': {
    style: 'viral',
    colorPalette: 'MrBeast red, attention yellow, pop blue, bold white',
    visualKeywords: 'viral MrBeast style, extremely bold colors, maximum visual impact',
    emotionalElement: 'exaggerated shocked face, jaw on floor, hands up',
    descriptionVoice: 'ultra dinâmica, provocativa, irresistível, FOMO total',
    clickbaitExamples: ['Isso é real?', 'Ninguém acreditou', 'Você não vai acreditar', 'O mais insano de todos'],
  },
  'vlog': {
    style: 'warm',
    colorPalette: 'natural warm tones, everyday colors, bright and lively',
    visualKeywords: 'personal vlog style, natural daylight, authentic real-life aesthetic',
    emotionalElement: 'genuine surprise expression, authentic reaction',
    descriptionVoice: 'primeira pessoa, próximo, autêntico, como um amigo contando',
    clickbaitExamples: ['Não acreditei', 'Isso aconteceu comigo', 'Nunca mais faço isso', 'Vocês pediram'],
  },
  'personal': {
    style: 'warm',
    colorPalette: 'selfie warm tones, casual brights, friendly yellows',
    visualKeywords: 'personal authentic style, casual daylight, real-life setting',
    emotionalElement: 'surprised genuine expression, hand pointing',
    descriptionVoice: 'pessoal, íntima, autêntica, como conversa de amigo',
    clickbaitExamples: ['Isso aconteceu comigo', 'Não acreditei quando vi', 'Preciso contar', 'Vocês não vão acreditar'],
  },
  'enthusiast': {
    style: 'warm',
    colorPalette: 'energetic oranges, fun yellows, action reds, outdoor greens',
    visualKeywords: 'enthusiastic vlog style, outdoor energy, bright lively colors',
    emotionalElement: 'excited enthusiastic expression, big smile, thumbs up',
    descriptionVoice: 'entusiasmada, contagiante, cheia de energia positiva',
    clickbaitExamples: ['Melhor coisa que já fiz', 'Testei e aprovei', 'Isso é incrível', 'Vocês precisam ver'],
  },
  'legend': {
    style: 'cinematic',
    colorPalette: 'ancient golds, forest greens, mysterious purples, campfire oranges',
    visualKeywords: 'folklore mysterious style, ancient forest atmosphere, mythical lighting',
    emotionalElement: 'mysterious knowing expression, raised eyebrow, ancient wisdom',
    descriptionVoice: 'narrativa, misteriosa, envolvente, tom de contador de histórias',
    clickbaitExamples: ['Isso realmente aconteceu', 'Ninguém explica', 'A lenda é verdadeira', 'Não deveria existir'],
  },
  'folklore': {
    style: 'cinematic',
    colorPalette: 'moonlight blues, old parchment yellows, forest blacks, fire oranges',
    visualKeywords: 'mythical folklore style, moonlit forest, ancient mysterious atmosphere',
    emotionalElement: 'awestruck ancient expression, gazing at something mystical',
    descriptionVoice: 'narrativa, misteriosa, ancestral, tom de lenda',
    clickbaitExamples: ['Isso realmente aconteceu', 'A lenda proibida', 'Ninguém deveria saber', 'O mistério continua'],
  },
  'child': {
    style: 'warm',
    colorPalette: 'rainbow colors, candy pinks, sky blues, sunshine yellows',
    visualKeywords: 'colorful kids style, pixar-like 3D render, bright cheerful whimsical',
    emotionalElement: 'wide-eyed wonder expression, magical sparkles, cute character',
    descriptionVoice: 'divertida, acessível, linguagem simples e encantadora',
    clickbaitExamples: ['O segredo do castelo', 'Ninguém sabia...', 'A aventura começa', 'O maior mistério'],
  },
  'kid': {
    style: 'warm',
    colorPalette: 'bright primary colors, playful pastels, fun neons',
    visualKeywords: 'playful children style, cartoon aesthetic, bright and fun',
    emotionalElement: 'excited happy expression, jumping, magical wonder',
    descriptionVoice: 'alegre, lúdica, convidativa, linguagem infantil amigável',
    clickbaitExamples: ['Que legal!', 'O segredo revelado', 'A maior aventura', 'Você vai adorar'],
  },
  'tech': {
    style: 'clean',
    colorPalette: 'tech blacks, circuit greens, LED blues, clean whites',
    visualKeywords: 'tech reviewer style, studio product lighting, clean modern aesthetic',
    emotionalElement: 'skeptical analytical expression, raised eyebrow, inspecting closely',
    descriptionVoice: 'crítica, técnica, objetiva, com opinião fundamentada',
    clickbaitExamples: ['Vale mesmo a pena?', 'Testei por 30 dias', 'A verdade sobre...', 'Não compre antes de ver'],
  },
  'review': {
    style: 'clean',
    colorPalette: 'studio whites, product blacks, rating stars gold, clean grays',
    visualKeywords: 'product review style, studio lighting, close-up product shots',
    emotionalElement: 'disappointed or impressed expression, comparing products',
    descriptionVoice: 'analítica, honesta, comparativa, baseada em testes reais',
    clickbaitExamples: ['Não vale o preço', 'Testei e me surpreendi', 'O melhor de todos?', 'Resultado inesperado'],
  },
  'science': {
    style: 'clean',
    colorPalette: 'lab whites, data blues, futuristic purples, neon accents',
    visualKeywords: 'scientific futuristic style, lab aesthetic, holographic data visualization',
    emotionalElement: 'amazed scientist expression, discovery moment',
    descriptionVoice: 'científica, curiosa, baseada em evidências, acessível',
    clickbaitExamples: ['A ciência explica', 'Descoberta chocante', 'Ninguém esperava esse resultado', 'O experimento proibido'],
  },
};

// Default config for unknown tones
const DEFAULT_CONFIG: ToneVisualConfig = {
  style: 'cinematic',
  colorPalette: 'dramatic contrasts, bold accents, professional tones',
  visualKeywords: 'cinematic professional style, dramatic lighting, high production value',
  emotionalElement: 'impactful expression, strong emotion',
  descriptionVoice: 'envolvente, profissional, clara e impactante',
  clickbaitExamples: ['Você não vai acreditar', 'Isso muda tudo', 'A verdade revelada', 'Ninguém esperava'],
};

// =============================================
// CORE: Get tone config
// =============================================

const getToneConfig = (tone: string): ToneVisualConfig => {
  const lower = tone.toLowerCase();
  for (const [key, config] of Object.entries(TONE_CONFIGS)) {
    if (lower.includes(key)) return config;
  }
  return DEFAULT_CONFIG;
};

// =============================================
// RULE 1+2: THUMBNAIL PROMPT BUILDER
// =============================================

/**
 * Generates the clickbait text and complete image prompt for thumbnail generation.
 * No AI call needed — deterministic based on tone + content analysis.
 */
export const buildThumbnailPrompt = (params: ThumbnailDescriptionParams): ThumbnailResult => {
  const { title, script, narrativeTone, niche } = params;
  const config = getToneConfig(narrativeTone);
  
  // Select clickbait text based on script content analysis
  const clickbaitText = selectClickbaitText(title, script, config);
  
  // Build the niche-specific visual element
  const nicheVisual = getNicheVisualElement(niche, narrativeTone);
  
  // Build complete image prompt (Rule 2)
  const imagePrompt = [
    `YouTube thumbnail`,
    config.visualKeywords,
    `text overlay "${clickbaitText}"`,
    nicheVisual,
    config.emotionalElement,
    `color palette: ${config.colorPalette}`,
    `high contrast, bold colors, professional design`,
    `16:9 aspect ratio, no watermark, 4K quality`,
    `the text must be large, bold, and perfectly readable`,
    `cinematic depth of field, dramatic composition`,
  ].join(', ');
  
  return {
    clickbaitText,
    imagePrompt,
    style: config.style,
    colorPalette: config.colorPalette,
  };
};

/**
 * Selects the best clickbait text by analyzing the script content.
 */
const selectClickbaitText = (title: string, script: ScriptData, config: ToneVisualConfig): string => {
  const fullText = (title + ' ' + script.segments.map(s => s.narratorText).join(' ')).toLowerCase();
  
  // Detect content themes to pick the most relevant clickbait
  const themes: Record<string, string[]> = {
    'secret':    ['segredo', 'secret', 'escondido', 'hidden', 'oculto', 'proibido'],
    'money':     ['dinheiro', 'money', 'investir', 'profit', 'lucro', 'rico', 'wealth', 'milhão', 'bilhão'],
    'danger':    ['perigo', 'danger', 'risco', 'risk', 'morte', 'death', 'morrer', 'cuidado'],
    'mistake':   ['erro', 'mistake', 'errado', 'wrong', 'falha', 'fail', 'problema'],
    'change':    ['mudou', 'changed', 'transform', 'revolução', 'revolution', 'virada'],
    'shock':     ['choc', 'shock', 'incr[ií]vel', 'impossible', 'impossível', 'inacredit'],
    'truth':     ['verdade', 'truth', 'mentira', 'lie', 'real', 'fake', 'falso'],
    'discovery': ['descobr', 'discover', 'encontr', 'find', 'revel', 'reveal'],
    'fear':      ['medo', 'fear', 'terror', 'horror', 'assust', 'scared'],
    'test':      ['test', 'experiment', 'prova', 'result', 'funciona'],
  };
  
  let bestTheme = '';
  let bestScore = 0;
  
  for (const [theme, keywords] of Object.entries(themes)) {
    let score = 0;
    for (const kw of keywords) {
      if (fullText.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestTheme = theme;
    }
  }
  
  // Map theme to clickbait pattern, then pick from tone examples
  const themeClickbaits: Record<string, string[]> = {
    'secret':    ['O que eles escondem', 'Ninguém deveria saber', 'O segredo revelado'],
    'money':     ['Perdendo dinheiro sem saber', 'Isso muda sua vida financeira', 'O erro que custa caro'],
    'danger':    ['Cuidado com isso', 'O risco que ninguém fala', 'Antes que seja tarde'],
    'mistake':   ['O erro que todos cometem', 'Pare de fazer isso', 'Você está fazendo errado'],
    'change':    ['Isso mudou tudo', 'A virada que ninguém esperava', 'Nunca mais o mesmo'],
    'shock':     ['Impossível? Não.', 'Ninguém acreditou', 'Isso é real?'],
    'truth':     ['A verdade que dói', 'Mentira ou verdade?', 'Finalmente revelado'],
    'discovery': ['Descoberta chocante', 'Finalmente encontraram', 'A revelação'],
    'fear':      ['Isso não deveria existir', 'O medo é real', 'Não assista sozinho'],
    'test':      ['Testei e me surpreendi', 'O resultado chocou', 'Funciona mesmo?'],
  };
  
  // Prefer theme-specific clickbait, fallback to tone examples
  const candidates = bestTheme && themeClickbaits[bestTheme] 
    ? [...themeClickbaits[bestTheme], ...config.clickbaitExamples]
    : config.clickbaitExamples;
  
  // Pick one deterministically based on title hash for consistency
  const hash = title.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return candidates[hash % candidates.length];
};

/**
 * Gets a niche-specific visual element for the thumbnail background.
 */
const getNicheVisualElement = (niche: string, tone: string): string => {
  const lower = niche.toLowerCase();
  
  const nicheVisuals: Record<string, string> = {
    'financ':     'modern city skyline with stock charts overlay, gold coins',
    'finance':    'modern city skyline with stock charts overlay, gold coins',
    'money':      'stacks of money, luxury items, financial charts',
    'invest':     'stock market graphs, rising charts, financial district',
    'crypto':     'blockchain visualization, digital currency, holographic data',
    'tech':       'futuristic technology devices, holographic screens, circuit boards',
    'gaming':     'gaming setup with RGB lights, controller, game screens',
    'horror':     'abandoned building with fog, dark corridor, eerie shadows',
    'terror':     'dark forest at night, mysterious fog, abandoned place',
    'crime':      'crime scene tape, dark alley, investigation board',
    'cook':       'beautiful food photography, kitchen with dramatic lighting',
    'food':       'stunning food close-up, chef hands, ingredients',
    'fitness':    'powerful athlete silhouette, gym equipment, determination',
    'health':     'wellness environment, medical imagery, healthy lifestyle',
    'travel':     'stunning landscape, exotic destination, adventure gear',
    'music':      'concert stage lights, musical instruments, sound waves',
    'education':  'books, library, academic setting, knowledge symbols',
    'science':    'laboratory equipment, molecular structures, space imagery',
    'nature':     'dramatic landscape, wildlife, nature phenomenon',
    'history':    'ancient artifacts, historical monuments, old maps',
    'psychology': 'brain visualization, mind concept, human behavior',
    'business':   'corporate boardroom, city skyline, professional setting',
    'art':        'artistic composition, gallery, creative studio',
    'fashion':    'high fashion photography, runway, designer items',
    'auto':       'luxury car, racing track, mechanical parts',
    'space':      'galaxy, planets, rocket launch, astronaut',
    'mystery':    'mysterious door, fog, question marks, dark atmosphere',
    'legend':     'ancient forest, mystical creature silhouette, moonlight',
    'folklore':   'campfire in dark forest, old castle, mystical symbols',
  };
  
  for (const [key, visual] of Object.entries(nicheVisuals)) {
    if (lower.includes(key)) return visual;
  }
  
  // Generic fallback based on tone
  const toneConfig = getToneConfig(tone);
  return `dramatic background related to ${niche}, ${toneConfig.visualKeywords}`;
};

// =============================================
// RULE 3+4+5: DESCRIPTION BUILDER
// =============================================

/**
 * Generates a complete YouTube description with 3 layers.
 * Returns the full description and each layer separately.
 */
export const buildVideoDescription = (params: ThumbnailDescriptionParams): DescriptionResult => {
  const { title, script, narrativeTone, niche, language } = params;
  const config = getToneConfig(narrativeTone);
  const lang = (language || 'Portuguese').toLowerCase();
  const isPt = lang.includes('portug') || lang.includes('pt');
  
  // Get the clickbait text for coherence with thumbnail
  const clickbaitText = selectClickbaitText(title, script, config);
  
  // === LAYER 1: Hook (first 2 lines) ===
  const hook = buildHook(title, script, config, clickbaitText, isPt);
  
  // === LAYER 2: Content Summary ===
  const summary = buildSummary(title, script, config, isPt);
  
  // === LAYER 3: SEO + CTA ===
  const seoBlock = buildSeoBlock(title, script, niche, isPt);
  
  // Combine all layers
  const fullDescription = [
    hook,
    '',
    '─────────────────────────────',
    '',
    summary,
    '',
    '─────────────────────────────',
    '',
    seoBlock,
  ].join('\n');
  
  return { fullDescription, hook, summary, seoBlock };
};

/**
 * Layer 1: Hook — First 2 lines visible before "show more".
 * Must generate immediate curiosity.
 */
const buildHook = (
  title: string,
  script: ScriptData,
  config: ToneVisualConfig,
  clickbaitText: string,
  isPt: boolean
): string => {
  // Extract key info from first segment for context
  const firstSegment = script.segments[0];
  const coreTheme = script.coreThemes?.[0] || title;
  
  // Build hook that's coherent with thumbnail clickbait
  const hookPatterns = isPt ? [
    `${clickbaitText}... E o que descobrimos vai mudar a forma como você enxerga ${extractTopic(title)}.`,
    `Você sabia que a maioria das pessoas comete esse erro sobre ${extractTopic(title)}? A verdade vai te surpreender.`,
    `${clickbaitText}. Neste vídeo, revelamos o que ninguém teve coragem de mostrar sobre ${extractTopic(title)}.`,
    `O que acontece quando você ignora ${extractTopic(title)}? Investigamos e o resultado vai te chocar.`,
    `${clickbaitText}. Prepare-se para descobrir algo que vai mudar sua perspectiva sobre ${extractTopic(title)}.`,
  ] : [
    `${clickbaitText}... What we discovered will change how you see ${extractTopic(title)}.`,
    `Did you know most people make this mistake about ${extractTopic(title)}? The truth will surprise you.`,
    `${clickbaitText}. In this video, we reveal what nobody dared to show about ${extractTopic(title)}.`,
    `What happens when you ignore ${extractTopic(title)}? We investigated and the result will shock you.`,
    `${clickbaitText}. Get ready to discover something that will change your perspective on ${extractTopic(title)}.`,
  ];
  
  // Pick based on title hash for consistency
  const hash = title.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return hookPatterns[hash % hookPatterns.length];
};

/**
 * Extract the main topic from a title for natural language insertion.
 */
const extractTopic = (title: string): string => {
  // Remove common clickbait prefixes/suffixes and clean up
  return title
    .replace(/^(o |a |os |as |the |why |how |what |como |por que |o que )/i, '')
    .replace(/[!?…\.]+$/, '')
    .toLowerCase()
    .trim()
    .substring(0, 60);
};

/**
 * Layer 2: Content summary — clear, no spoilers, 3-5 sentences.
 */
const buildSummary = (
  title: string,
  script: ScriptData,
  config: ToneVisualConfig,
  isPt: boolean
): string => {
  const segments = script.segments;
  const sectionTitles = segments.map(s => s.sectionTitle).filter(Boolean);
  
  // Build summary from section titles and themes
  const themes = script.coreThemes || [];
  const topicsList = sectionTitles.slice(0, 4).join(', ');
  
  if (isPt) {
    const lines = [
      `📌 Neste vídeo, exploramos a fundo: ${title}`,
      '',
      topicsList ? `Abordamos os seguintes pontos: ${topicsList}.` : '',
      themes.length > 0 ? `Temas centrais: ${themes.slice(0, 3).join(', ')}.` : '',
      `Estilo narrativo: ${config.descriptionVoice}.`,
      '',
      `⏱️ ${segments.length} seções • Conteúdo completo e detalhado`,
    ];
    return lines.filter(Boolean).join('\n');
  } else {
    const lines = [
      `📌 In this video, we deep dive into: ${title}`,
      '',
      topicsList ? `We cover the following topics: ${topicsList}.` : '',
      themes.length > 0 ? `Core themes: ${themes.slice(0, 3).join(', ')}.` : '',
      `Narrative style: ${config.descriptionVoice}.`,
      '',
      `⏱️ ${segments.length} sections • Complete and detailed content`,
    ];
    return lines.filter(Boolean).join('\n');
  }
};

/**
 * Layer 3: SEO hashtags + CTA.
 */
const buildSeoBlock = (
  title: string,
  script: ScriptData,
  niche: string,
  isPt: boolean
): string => {
  // Generate relevant hashtags from title, niche, and themes
  const hashtags = generateHashtags(title, script, niche);
  
  const cta = isPt
    ? [
        '👍 Gostou? Deixe seu LIKE e se INSCREVA no canal!',
        '🔔 Ative o sininho para não perder nenhum vídeo!',
        '💬 Comente o que achou — sua opinião importa!',
      ]
    : [
        '👍 Enjoyed it? Hit LIKE and SUBSCRIBE!',
        '🔔 Turn on notifications so you never miss a video!',
        '💬 Comment what you think — your opinion matters!',
      ];
  
  return [
    ...cta,
    '',
    hashtags.map(h => `#${h}`).join(' '),
  ].join('\n');
};

/**
 * Generates 8-12 relevant hashtags from content.
 */
const generateHashtags = (title: string, script: ScriptData, niche: string): string[] => {
  const tags = new Set<string>();
  
  // Add niche hashtag
  const nicheTag = niche.replace(/[^a-zA-ZÀ-ú0-9]/g, '').toLowerCase();
  if (nicheTag) tags.add(nicheTag);
  
  // Extract keywords from title
  const titleWords = title
    .replace(/[^a-zA-ZÀ-ú0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .map(w => w.toLowerCase());
  
  for (const w of titleWords.slice(0, 3)) {
    tags.add(w);
  }
  
  // Extract from core themes
  for (const theme of (script.coreThemes || []).slice(0, 4)) {
    const tag = theme.replace(/[^a-zA-ZÀ-ú0-9]/g, '').toLowerCase();
    if (tag.length > 2) tags.add(tag);
  }
  
  // Extract from section titles
  for (const seg of script.segments.slice(0, 5)) {
    const words = (seg.sectionTitle || '')
      .replace(/[^a-zA-ZÀ-ú0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 4);
    for (const w of words.slice(0, 1)) {
      tags.add(w.toLowerCase());
    }
  }
  
  // Add common YouTube tags
  tags.add('youtube');
  
  // Limit to 12
  return [...tags].slice(0, 12);
};

// =============================================
// TIMESTAMPS BUILDER
// =============================================

/**
 * Generates YouTube chapter timestamps from script segments.
 */
export const buildTimestamps = (segments: ScriptSegment[]): string => {
  let currentTime = 0;
  const lines: string[] = [];
  
  for (const seg of segments) {
    const mins = Math.floor(currentTime / 60);
    const secs = Math.floor(currentTime % 60);
    lines.push(`${mins}:${secs.toString().padStart(2, '0')} - ${seg.sectionTitle}`);
    currentTime += seg.estimatedDuration;
  }
  
  return lines.join('\n');
};

// =============================================
// COMBINED: Full metadata generation
// =============================================

export interface FullMetadataResult {
  thumbnail: ThumbnailResult;
  description: DescriptionResult;
  timestamps: string;
}

/**
 * Generates thumbnail prompt + description + timestamps in one call.
 * Ensures coherence between thumbnail clickbait and description hook.
 */
export const generateFullMetadata = (params: ThumbnailDescriptionParams): FullMetadataResult => {
  const thumbnail = buildThumbnailPrompt(params);
  const description = buildVideoDescription(params);
  const timestamps = buildTimestamps(params.script.segments);
  
  return { thumbnail, description, timestamps };
};
