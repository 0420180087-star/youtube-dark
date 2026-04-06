/**
 * THUMBNAIL & DESCRIPTION ENGINE v2
 * 
 * Based on YouTube CTR Psychology Guide:
 * - 200ms decision window → visual impact first, text second
 * - 6 psychological triggers: Curiosity Gap, FOMO, Visual Dissonance, 
 *   Personal Relevance, Facial Recognition, Reward Anticipation
 * - Face covering 40-60% of frame with extreme expression
 * - Max 3-5 words, bold font, high contrast
 * - Honest clickbait (high CTR + high retention)
 * 
 * Uses channel branding from Library for visual identity consistency.
 */

import { ScriptData, ScriptSegment, LibraryItem } from "../types";

// =============================================
// TYPES
// =============================================

export type ThumbnailStyle = 'viral' | 'cinematic' | 'horror' | 'clean' | 'neon' | 'warm';

export interface ThumbnailResult {
  clickbaitText: string;
  imagePrompt: string;
  style: ThumbnailStyle;
  colorPalette: string;
}

export interface DescriptionResult {
  fullDescription: string;
  hook: string;
  summary: string;
  seoBlock: string;
}

export interface ThumbnailDescriptionParams {
  title: string;
  script: ScriptData;
  narrativeTone: string;
  niche: string;
  language?: string;
  /** Channel library items for branding context */
  libraryItems?: LibraryItem[];
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
  clickbaitPatterns: ClickbaitPattern[];
  textColor: string;
  facialExpression: string; // Specific face instruction for 40-60% coverage
}

/** Clickbait patterns with psychological trigger type */
interface ClickbaitPattern {
  text: string;
  trigger: 'curiosity_gap' | 'fomo' | 'shock' | 'personal' | 'urgency' | 'controversy' | 'number' | 'before_after';
}

const TONE_CONFIGS: Record<string, ToneVisualConfig> = {
  'horror': {
    style: 'horror',
    colorPalette: 'pure blacks, blood reds (#FF0000), ghostly whites, cold blues',
    visualKeywords: 'dark horror style with red accents, dramatic shadows, volumetric fog, eerie atmosphere',
    emotionalElement: 'terrified person looking at something unseen off-camera',
    facialExpression: 'extreme terror, wide eyes with visible whites, mouth slightly open in horror, sweating, pale skin',
    descriptionVoice: 'sombria, suspense, frases curtas e impactantes, linguagem tensa',
    clickbaitPatterns: [
      { text: 'Não deveria existir', trigger: 'shock' },
      { text: 'O que eles escondem', trigger: 'curiosity_gap' },
      { text: 'Ninguém sobreviveu', trigger: 'shock' },
      { text: 'Isso é real?', trigger: 'curiosity_gap' },
      { text: 'Não assista sozinho', trigger: 'fomo' },
    ],
    textColor: '#FF0000 blood red with thick black stroke outline',
  },
  'suspens': {
    style: 'horror',
    colorPalette: 'dark navy (#0A1628), shadow blacks, accent golds (#FFD700), muted teals',
    visualKeywords: 'dark mysterious style, dramatic side lighting, deep shadows, tension',
    emotionalElement: 'person half-hidden in shadow looking suspicious',
    facialExpression: 'intense suspicious gaze, narrowed eyes, one side lit dramatically, jaw clenched',
    descriptionVoice: 'sombria, suspense, frases curtas e impactantes, mistério',
    clickbaitPatterns: [
      { text: 'A verdade escondida', trigger: 'curiosity_gap' },
      { text: 'Ninguém percebeu isso', trigger: 'curiosity_gap' },
      { text: 'O que aconteceu de verdade', trigger: 'curiosity_gap' },
      { text: 'Você não deveria saber', trigger: 'fomo' },
      { text: 'Caso não resolvido', trigger: 'curiosity_gap' },
    ],
    textColor: 'cold white (#FFFFFF) with heavy black stroke',
  },
  'dark': {
    style: 'horror',
    colorPalette: 'pure blacks, blood reds (#CC0000), ghostly whites, purple shadows (#2D1B4E)',
    visualKeywords: 'dark atmospheric style, horror aesthetic, dramatic shadows, volumetric fog, backlit silhouettes',
    emotionalElement: 'person reacting to something terrifying behind them',
    facialExpression: 'shocked terrified expression, mouth agape, eyes wide showing fear, hands raised defensively',
    descriptionVoice: 'sombria, frases curtas, linguagem tensa e impactante',
    clickbaitPatterns: [
      { text: 'Isso é real', trigger: 'shock' },
      { text: 'Ninguém acreditou', trigger: 'shock' },
      { text: 'O que aconteceu depois', trigger: 'curiosity_gap' },
      { text: 'A verdade proibida', trigger: 'curiosity_gap' },
      { text: 'Caso encerrado?', trigger: 'curiosity_gap' },
    ],
    textColor: 'blood red (#FF0000) or ghostly white with thick black stroke',
  },
  'motivat': {
    style: 'warm',
    colorPalette: 'warm oranges (#FF6B00), golden yellows (#FFD700), sunrise pinks, deep purples',
    visualKeywords: 'motivational epic style, golden hour lighting, sunrise colors, empowering atmosphere, lens flare',
    emotionalElement: 'person in triumphant pose against sunrise backdrop',
    facialExpression: 'determined powerful expression, clenched jaw, piercing eyes looking at camera, confident smile',
    descriptionVoice: 'energética, verbos de ação, empoderamento, inspiração',
    clickbaitPatterns: [
      { text: 'Isso mudou tudo', trigger: 'before_after' },
      { text: 'Pare de fazer isso', trigger: 'personal' },
      { text: 'O segredo que funciona', trigger: 'curiosity_gap' },
      { text: 'Comece hoje', trigger: 'urgency' },
      { text: 'A virada aconteceu', trigger: 'before_after' },
    ],
    textColor: 'golden yellow (#FFD700) with dark stroke',
  },
  'energetic': {
    style: 'warm',
    colorPalette: 'fiery oranges (#FF4500), electric yellows (#FFFF00), power reds, sunset golds',
    visualKeywords: 'energetic powerful style, dynamic lighting, bold saturated colors, epic atmosphere',
    emotionalElement: 'person celebrating with arms raised',
    facialExpression: 'excited triumphant expression, big open smile, eyes bright, energy and joy radiating',
    descriptionVoice: 'energética, dinâmica, inspiradora, cheia de ação',
    clickbaitPatterns: [
      { text: 'Agora ou nunca', trigger: 'urgency' },
      { text: 'Isso mudou tudo', trigger: 'before_after' },
      { text: 'Comece hoje', trigger: 'urgency' },
      { text: 'A virada aconteceu', trigger: 'before_after' },
      { text: 'Impossível? Não.', trigger: 'shock' },
    ],
    textColor: 'fiery orange (#FF4500) or bold yellow with dark stroke',
  },
  'coach': {
    style: 'warm',
    colorPalette: 'deep orange (#E65100), gold (#FFD700), motivational red (#CC0000), clean white',
    visualKeywords: 'coaching motivational style, sunrise backdrop, powerful atmosphere, stadium lights',
    emotionalElement: 'person pointing directly at camera like a mentor',
    facialExpression: 'confident determined expression, pointing forward at viewer, slightly furrowed brow, authoritative',
    descriptionVoice: 'direta, motivadora, verbos de ação, tom de mentor',
    clickbaitPatterns: [
      { text: 'Pare de fazer isso', trigger: 'personal' },
      { text: 'Isso mudou tudo', trigger: 'before_after' },
      { text: 'A verdade que dói', trigger: 'controversy' },
      { text: 'Você está fazendo errado', trigger: 'personal' },
      { text: 'Ninguém te contou', trigger: 'curiosity_gap' },
    ],
    textColor: 'golden yellow (#FFD700) or power red (#CC0000) with dark stroke',
  },
  'education': {
    style: 'clean',
    colorPalette: 'clean whites, knowledge blues (#1E88E5), accent greens (#43A047), subtle grays',
    visualKeywords: 'clean educational style, bright professional lighting, modern minimal design, diagrams',
    emotionalElement: 'person having a lightbulb moment of discovery',
    facialExpression: 'surprised enlightened expression, wide eyes of discovery, eyebrows raised, mouth slightly open in amazement',
    descriptionVoice: 'clara, didática, promessa de aprendizado, linguagem acessível',
    clickbaitPatterns: [
      { text: 'O erro que todos cometem', trigger: 'personal' },
      { text: 'Simples assim', trigger: 'curiosity_gap' },
      { text: 'Ninguém ensina isso', trigger: 'curiosity_gap' },
      { text: '5 erros fatais', trigger: 'number' },
      { text: 'Finalmente explicado', trigger: 'curiosity_gap' },
    ],
    textColor: 'bright white or knowledge blue (#1E88E5) with contrasting stroke',
  },
  'explanat': {
    style: 'clean',
    colorPalette: 'blue whites, diagram blues (#1565C0), highlight yellows (#FDD835), clean grays',
    visualKeywords: 'explainer style, clean infographic aesthetic, bright and organized, data visualization',
    emotionalElement: 'person pointing at an invisible diagram with curiosity',
    facialExpression: 'curious thoughtful expression, hand on chin, one eyebrow raised, intrigued look',
    descriptionVoice: 'clara, lógica, passo a passo, didática',
    clickbaitPatterns: [
      { text: 'Simples assim', trigger: 'curiosity_gap' },
      { text: 'Finalmente explicado', trigger: 'curiosity_gap' },
      { text: 'O erro que todos cometem', trigger: 'personal' },
      { text: 'Agora faz sentido', trigger: 'curiosity_gap' },
      { text: '3 passos simples', trigger: 'number' },
    ],
    textColor: 'highlight yellow (#FDD835) or bright white with black stroke',
  },
  'clear': {
    style: 'clean',
    colorPalette: 'clean whites, soft blues (#42A5F5), mint greens (#66BB6A), light grays',
    visualKeywords: 'clean minimal style, bright studio lighting, professional organized',
    emotionalElement: 'person nodding with confident knowing look',
    facialExpression: 'confident knowing expression, slight smile, eyes looking directly at camera, calm authority',
    descriptionVoice: 'clara, objetiva, sem rodeios, fácil de entender',
    clickbaitPatterns: [
      { text: 'Ninguém ensina isso', trigger: 'curiosity_gap' },
      { text: 'A verdade é simples', trigger: 'curiosity_gap' },
      { text: 'Você não sabia', trigger: 'curiosity_gap' },
      { text: 'Finalmente explicado', trigger: 'curiosity_gap' },
      { text: 'Pare de complicar', trigger: 'personal' },
    ],
    textColor: 'bright white with black stroke',
  },
  'wendover': {
    style: 'clean',
    colorPalette: 'infographic blues (#0D47A1), data greens (#2E7D32), map yellows (#F9A825), clean whites',
    visualKeywords: 'documentary explainer style, aerial maps, data visualization aesthetic, infographics',
    emotionalElement: 'person looking at a map or data screen with intrigue',
    facialExpression: 'intrigued analytical expression, eyes focused, slightly squinting, detective-like concentration',
    descriptionVoice: 'analítica, informativa, curiosa, baseada em dados',
    clickbaitPatterns: [
      { text: 'A logística impossível', trigger: 'shock' },
      { text: 'Por que isso funciona', trigger: 'curiosity_gap' },
      { text: 'O sistema que ninguém vê', trigger: 'curiosity_gap' },
      { text: 'A matemática por trás', trigger: 'curiosity_gap' },
      { text: 'Em 7 números', trigger: 'number' },
    ],
    textColor: 'bright white or data green (#2E7D32) with dark stroke',
  },
  'business': {
    style: 'clean',
    colorPalette: 'corporate dark blues (#0D47A1), gold accents (#FFD700), clean whites, power blacks',
    visualKeywords: 'corporate dark blue style, professional lighting, modern city backdrop, skyscraper',
    emotionalElement: 'businessman with jaw dropped at shocking information',
    facialExpression: 'shocked businessman expression, jaw dropped, eyes wide, professional disbelief, suit and tie',
    descriptionVoice: 'formal, dados, autoridade, tom profissional e confiante',
    clickbaitPatterns: [
      { text: 'Perdendo dinheiro sem saber', trigger: 'personal' },
      { text: 'O mercado não quer que saiba', trigger: 'curiosity_gap' },
      { text: 'Seus concorrentes já sabem', trigger: 'fomo' },
      { text: 'O erro de R$ milhões', trigger: 'shock' },
      { text: 'Estratégia revelada', trigger: 'curiosity_gap' },
    ],
    textColor: 'bright white or gold (#FFD700) with dark stroke',
  },
  'corporate': {
    style: 'clean',
    colorPalette: 'navy blue (#1A237E), silver (#C0C0C0), executive gray, clean white',
    visualKeywords: 'corporate professional style, boardroom aesthetic, skyscraper backdrop',
    emotionalElement: 'executive with serious authoritative look',
    facialExpression: 'serious authoritative expression, crossed arms, power pose, direct eye contact',
    descriptionVoice: 'formal, autoritativa, baseada em dados e resultados',
    clickbaitPatterns: [
      { text: 'Seus concorrentes já sabem', trigger: 'fomo' },
      { text: 'O erro que custa milhões', trigger: 'shock' },
      { text: 'Estratégia revelada', trigger: 'curiosity_gap' },
      { text: 'A verdade sobre...', trigger: 'curiosity_gap' },
      { text: 'Em 5 passos', trigger: 'number' },
    ],
    textColor: 'bright white or silver with dark stroke',
  },
  'finance': {
    style: 'clean',
    colorPalette: 'money green (#2E7D32), gold (#FFD700), dark blue (#0D47A1), chart red (#D32F2F)',
    visualKeywords: 'financial corporate style, stock market aesthetic, wealth imagery, trading screens',
    emotionalElement: 'person shocked at financial numbers on screen',
    facialExpression: 'shocked expression at numbers, eyes wide, mouth open, pointing at invisible chart',
    descriptionVoice: 'autoritativa, baseada em números, tom de especialista',
    clickbaitPatterns: [
      { text: 'Perdendo dinheiro sem saber', trigger: 'personal' },
      { text: 'O investimento que ninguém fala', trigger: 'curiosity_gap' },
      { text: 'Antes que seja tarde', trigger: 'urgency' },
      { text: 'O erro de R$ milhões', trigger: 'shock' },
      { text: 'Em 3 meses', trigger: 'number' },
    ],
    textColor: 'money green (#2E7D32) or gold (#FFD700) with dark stroke',
  },
  'crime': {
    style: 'cinematic',
    colorPalette: 'noir blacks, evidence yellows (#FDD835), blood reds (#B71C1C), cold grays',
    visualKeywords: 'true crime noir style, police investigation aesthetic, evidence board, crime tape',
    emotionalElement: 'investigator examining evidence with intense focus',
    facialExpression: 'serious investigative expression, stern face, furrowed brow, flashlight under chin',
    descriptionVoice: 'sombria, investigativa, séria, linguagem de documentário criminal',
    clickbaitPatterns: [
      { text: 'O caso que chocou', trigger: 'shock' },
      { text: 'A evidência perdida', trigger: 'curiosity_gap' },
      { text: 'Caso não resolvido', trigger: 'curiosity_gap' },
      { text: 'Ninguém investigou', trigger: 'curiosity_gap' },
      { text: 'A pista ignorada', trigger: 'curiosity_gap' },
    ],
    textColor: 'evidence yellow (#FDD835) or blood red (#B71C1C) with black stroke',
  },
  'serious': {
    style: 'cinematic',
    colorPalette: 'desaturated tones, muted grays, evidence yellows (#FDD835), cold blues',
    visualKeywords: 'serious documentary style, noir aesthetic, journalistic lighting, film grain',
    emotionalElement: 'person in deep thought, dramatic side lighting',
    facialExpression: 'intense serious expression, deep thought, one eye in shadow, contemplative',
    descriptionVoice: 'séria, investigativa, documental, imparcial mas impactante',
    clickbaitPatterns: [
      { text: 'Ninguém investigou', trigger: 'curiosity_gap' },
      { text: 'A verdade por trás', trigger: 'curiosity_gap' },
      { text: 'Caso encerrado?', trigger: 'curiosity_gap' },
      { text: 'O que realmente aconteceu', trigger: 'curiosity_gap' },
      { text: 'Revelado pela primeira vez', trigger: 'shock' },
    ],
    textColor: 'cold white or evidence yellow (#FDD835) with heavy black stroke',
  },
  'documentary': {
    style: 'cinematic',
    colorPalette: 'natural earth tones, sky blues (#1976D2), documentary grays, warm ambers (#FF8F00)',
    visualKeywords: 'documentary cinematic style, natural lighting, journalistic composition, wide shots',
    emotionalElement: 'person gazing into the distance at a landscape',
    facialExpression: 'contemplative expression, gazing into distance, wisdom in eyes, weathered face',
    descriptionVoice: 'formal, jornalística, informativa, tom de narrador de documentário',
    clickbaitPatterns: [
      { text: 'O que realmente aconteceu', trigger: 'curiosity_gap' },
      { text: 'A história não contada', trigger: 'curiosity_gap' },
      { text: 'Revelado pela primeira vez', trigger: 'shock' },
      { text: 'Imagens inéditas', trigger: 'shock' },
      { text: 'A verdade completa', trigger: 'curiosity_gap' },
    ],
    textColor: 'bright white or warm amber (#FF8F00) with dark stroke',
  },
  'calm': {
    style: 'warm',
    colorPalette: 'soft pastels, warm beiges (#D7CCC8), gentle greens (#81C784), cozy ambers',
    visualKeywords: 'soft cozy style, warm golden hour lighting, gentle atmosphere, bokeh',
    emotionalElement: 'person with serene peaceful smile in warm light',
    facialExpression: 'serene peaceful expression, gentle smile, half-closed eyes, relaxed, warm lighting on face',
    descriptionVoice: 'suave, acolhedora, convidativa, linguagem de conforto',
    clickbaitPatterns: [
      { text: 'Você precisa ver isso', trigger: 'curiosity_gap' },
      { text: 'Tente fazer isso hoje', trigger: 'personal' },
      { text: 'O momento perfeito', trigger: 'curiosity_gap' },
      { text: 'Relaxe e assista', trigger: 'personal' },
      { text: 'Puro conforto', trigger: 'personal' },
    ],
    textColor: 'warm white or soft gold with subtle shadow',
  },
  'cozy': {
    style: 'warm',
    colorPalette: 'candle warm (#FFB74D), blanket beiges, tea browns (#795548), window rain blues',
    visualKeywords: 'cozy intimate style, candlelight warmth, interior comfort, rain on window',
    emotionalElement: 'person content with warm drink, candle light',
    facialExpression: 'content peaceful smile, eyes half-closed, comfort, wrapped in warmth',
    descriptionVoice: 'suave, íntima, acolhedora, como um abraço em palavras',
    clickbaitPatterns: [
      { text: 'Assista antes de dormir', trigger: 'personal' },
      { text: 'O momento perfeito', trigger: 'curiosity_gap' },
      { text: 'Puro conforto', trigger: 'personal' },
      { text: 'Você merece isso', trigger: 'personal' },
      { text: 'Relaxe e assista', trigger: 'personal' },
    ],
    textColor: 'warm cream or soft white with warm shadow',
  },
  'asmr': {
    style: 'warm',
    colorPalette: 'soft lavenders (#CE93D8), gentle pinks (#F48FB1), whisper whites, calm blues',
    visualKeywords: 'soft ASMR aesthetic, macro close-up textures, gentle studio lighting, bokeh',
    emotionalElement: 'person with blissful relaxed expression',
    facialExpression: 'relaxed blissful expression, closed eyes, slight smile, tingling sensation, whisper pose',
    descriptionVoice: 'suave, delicada, sensorial, linguagem que acalma',
    clickbaitPatterns: [
      { text: 'Você precisa ouvir isso', trigger: 'curiosity_gap' },
      { text: 'Sons que relaxam', trigger: 'personal' },
      { text: 'Durma em minutos', trigger: 'personal' },
      { text: 'Sensação única', trigger: 'curiosity_gap' },
      { text: 'Arrepios garantidos', trigger: 'personal' },
    ],
    textColor: 'soft lavender or whisper white with gentle shadow',
  },
  'relax': {
    style: 'warm',
    colorPalette: 'ocean blues (#0288D1), sunset oranges (#FF6D00), forest greens (#388E3C), sand beiges',
    visualKeywords: 'relaxing natural style, soft nature lighting, peaceful scenery, ocean waves',
    emotionalElement: 'person meditating in nature',
    facialExpression: 'peaceful meditative expression, deep breath, eyes closed, connection with nature',
    descriptionVoice: 'tranquila, contemplativa, convite ao descanso',
    clickbaitPatterns: [
      { text: 'Pare e respire', trigger: 'personal' },
      { text: 'O vídeo que acalma', trigger: 'personal' },
      { text: 'Natureza pura', trigger: 'curiosity_gap' },
      { text: 'Você precisa ver isso', trigger: 'curiosity_gap' },
      { text: 'Paz absoluta', trigger: 'personal' },
    ],
    textColor: 'soft white or ocean blue with gentle stroke',
  },
  'gaming': {
    style: 'neon',
    colorPalette: 'neon greens (#00FF41), electric purples (#AA00FF), RGB rainbows, dark blacks',
    visualKeywords: 'gaming neon style, RGB lighting, esports energy, electric atmosphere, screen glow',
    emotionalElement: 'gamer with mind-blown reaction to gameplay',
    facialExpression: 'excited screaming expression, mind-blown reaction, hands on head, mouth wide open, RGB light on face',
    descriptionVoice: 'dinâmica, gírias de gaming, energia alta, entusiasmo',
    clickbaitPatterns: [
      { text: 'Ninguém faz isso', trigger: 'shock' },
      { text: 'Isso é real?', trigger: 'shock' },
      { text: 'Play insano', trigger: 'shock' },
      { text: 'Impossível de repetir', trigger: 'shock' },
      { text: 'Bug ou habilidade?', trigger: 'curiosity_gap' },
    ],
    textColor: 'neon green (#00FF41) or electric blue with glow effect',
  },
  'loud': {
    style: 'neon',
    colorPalette: 'explosive reds (#FF0000), neon yellows (#FFFF00), electric blues (#00B0FF), fire oranges',
    visualKeywords: 'high energy explosive style, neon lights, maximum intensity, sparks, explosion effects',
    emotionalElement: 'person screaming with explosive reaction',
    facialExpression: 'screaming mind-blown expression, hands on head, veins visible, extreme shock, maximum energy',
    descriptionVoice: 'explosiva, cheia de energia, gírias, reações exageradas',
    clickbaitPatterns: [
      { text: 'IMPOSSÍVEL', trigger: 'shock' },
      { text: 'Ninguém esperava isso', trigger: 'shock' },
      { text: 'O play do século', trigger: 'shock' },
      { text: 'Ficou maluco', trigger: 'shock' },
      { text: 'INACREDITÁVEL', trigger: 'shock' },
    ],
    textColor: 'neon yellow (#FFFF00) or explosive red (#FF0000) with maximum stroke',
  },
  'fast': {
    style: 'viral',
    colorPalette: 'bold reds (#E53935), attention yellows (#FDD835), contrast blacks, pop whites',
    visualKeywords: 'viral facts style, bold impactful design, eye-catching colors, speed lines',
    emotionalElement: 'person shocked with hand over mouth',
    facialExpression: 'shocked wide-eyed expression, hand over mouth, total disbelief, viral reaction face',
    descriptionVoice: 'dinâmica, rápida, impactante, frases curtas e diretas',
    clickbaitPatterns: [
      { text: '#1 chocou a todos', trigger: 'number' },
      { text: 'Impossível? Não.', trigger: 'shock' },
      { text: 'Você não sabia disso', trigger: 'curiosity_gap' },
      { text: 'Fatos insanos', trigger: 'shock' },
      { text: '7 coisas que chocam', trigger: 'number' },
    ],
    textColor: 'attention yellow (#FDD835) or bold red (#E53935) with heavy black stroke',
  },
  'viral': {
    style: 'viral',
    colorPalette: 'MrBeast red (#FF0000), attention yellow (#FFEB3B), pop blue (#2979FF), bold white',
    visualKeywords: 'viral MrBeast style, extremely bold colors, maximum visual impact, confetti, dramatic lighting',
    emotionalElement: 'person with extreme exaggerated reaction',
    facialExpression: 'exaggerated shocked face, jaw on floor, hands up, maximum surprise, eyes popping',
    descriptionVoice: 'ultra dinâmica, provocativa, irresistível, FOMO total',
    clickbaitPatterns: [
      { text: 'Isso é real?', trigger: 'shock' },
      { text: 'Ninguém acreditou', trigger: 'shock' },
      { text: 'O mais insano de todos', trigger: 'shock' },
      { text: 'Você não vai acreditar', trigger: 'shock' },
      { text: 'ASSISTA ATÉ O FINAL', trigger: 'fomo' },
    ],
    textColor: 'attention yellow (#FFEB3B) or bold white with maximum black stroke',
  },
  'vlog': {
    style: 'warm',
    colorPalette: 'natural warm tones, everyday colors, bright and lively',
    visualKeywords: 'personal vlog style, natural daylight, authentic real-life aesthetic, outdoor',
    emotionalElement: 'person with genuine surprise in everyday setting',
    facialExpression: 'genuine surprise expression, authentic reaction, pointing at something off-camera, natural look',
    descriptionVoice: 'primeira pessoa, próximo, autêntico, como um amigo contando',
    clickbaitPatterns: [
      { text: 'Não acreditei', trigger: 'shock' },
      { text: 'Isso aconteceu comigo', trigger: 'personal' },
      { text: 'Nunca mais faço isso', trigger: 'before_after' },
      { text: 'Vocês pediram', trigger: 'personal' },
      { text: 'Preciso contar', trigger: 'curiosity_gap' },
    ],
    textColor: 'bright white or warm yellow with natural shadow',
  },
  'personal': {
    style: 'warm',
    colorPalette: 'selfie warm tones, casual brights, friendly yellows (#FFD54F)',
    visualKeywords: 'personal authentic style, casual daylight, real-life setting, selfie angle',
    emotionalElement: 'person pointing at camera with surprised look',
    facialExpression: 'surprised genuine expression, hand pointing at viewer, wide eyes, "you won\'t believe" face',
    descriptionVoice: 'pessoal, íntima, autêntica, como conversa de amigo',
    clickbaitPatterns: [
      { text: 'Isso aconteceu comigo', trigger: 'personal' },
      { text: 'Não acreditei quando vi', trigger: 'shock' },
      { text: 'Preciso contar', trigger: 'curiosity_gap' },
      { text: 'Vocês não vão acreditar', trigger: 'shock' },
      { text: 'Me arrependi', trigger: 'personal' },
    ],
    textColor: 'bright white or friendly yellow with shadow',
  },
  'enthusiast': {
    style: 'warm',
    colorPalette: 'energetic oranges (#FF6D00), fun yellows (#FFEA00), action reds, outdoor greens',
    visualKeywords: 'enthusiastic vlog style, outdoor energy, bright lively colors, adventure',
    emotionalElement: 'excited person giving thumbs up',
    facialExpression: 'excited enthusiastic expression, big smile, thumbs up, eyes sparkling, genuine joy',
    descriptionVoice: 'entusiasmada, contagiante, cheia de energia positiva',
    clickbaitPatterns: [
      { text: 'Melhor coisa que já fiz', trigger: 'personal' },
      { text: 'Testei e aprovei', trigger: 'personal' },
      { text: 'Isso é incrível', trigger: 'shock' },
      { text: 'Vocês precisam ver', trigger: 'fomo' },
      { text: 'Resultado surpreendente', trigger: 'curiosity_gap' },
    ],
    textColor: 'energetic orange (#FF6D00) or bright white with dark stroke',
  },
  'legend': {
    style: 'cinematic',
    colorPalette: 'ancient golds (#FFB300), forest greens (#1B5E20), mysterious purples (#4A148C), campfire oranges',
    visualKeywords: 'folklore mysterious style, ancient forest atmosphere, mythical lighting, moonlight, fog',
    emotionalElement: 'storyteller by campfire with mysterious expression',
    facialExpression: 'mysterious knowing expression, raised eyebrow, ancient wisdom, firelight on face, half smile',
    descriptionVoice: 'narrativa, misteriosa, envolvente, tom de contador de histórias',
    clickbaitPatterns: [
      { text: 'Isso realmente aconteceu', trigger: 'shock' },
      { text: 'Ninguém explica', trigger: 'curiosity_gap' },
      { text: 'A lenda é verdadeira', trigger: 'shock' },
      { text: 'Não deveria existir', trigger: 'shock' },
      { text: 'O mistério continua', trigger: 'curiosity_gap' },
    ],
    textColor: 'ancient gold (#FFB300) or mystic purple with dark stroke',
  },
  'folklore': {
    style: 'cinematic',
    colorPalette: 'moonlight blues (#1565C0), old parchment yellows (#F9A825), forest blacks, fire oranges (#E65100)',
    visualKeywords: 'mythical folklore style, moonlit forest, ancient mysterious atmosphere, candlelight',
    emotionalElement: 'person looking at something mystical in forest',
    facialExpression: 'awestruck ancient expression, gazing at something mystical, wonder and fear mixed',
    descriptionVoice: 'narrativa, misteriosa, ancestral, tom de lenda',
    clickbaitPatterns: [
      { text: 'A lenda proibida', trigger: 'curiosity_gap' },
      { text: 'Ninguém deveria saber', trigger: 'curiosity_gap' },
      { text: 'O mistério continua', trigger: 'curiosity_gap' },
      { text: 'Isso realmente aconteceu', trigger: 'shock' },
      { text: 'A criatura existe', trigger: 'shock' },
    ],
    textColor: 'moonlight white or parchment yellow (#F9A825) with dark stroke',
  },
  'child': {
    style: 'warm',
    colorPalette: 'rainbow colors, candy pinks (#F48FB1), sky blues (#64B5F6), sunshine yellows (#FFF176)',
    visualKeywords: 'colorful kids style, pixar-like 3D render, bright cheerful whimsical, cartoon',
    emotionalElement: 'cute animated character with wide-eyed wonder',
    facialExpression: 'wide-eyed wonder expression, magical sparkles, cute character, mouth open in amazement',
    descriptionVoice: 'divertida, acessível, linguagem simples e encantadora',
    clickbaitPatterns: [
      { text: 'O segredo do castelo', trigger: 'curiosity_gap' },
      { text: 'A aventura começa', trigger: 'curiosity_gap' },
      { text: 'O maior mistério', trigger: 'curiosity_gap' },
      { text: 'Quem é o vilão?', trigger: 'curiosity_gap' },
      { text: 'Ninguém sabia', trigger: 'curiosity_gap' },
    ],
    textColor: 'rainbow colors or sunshine yellow with playful stroke',
  },
  'kid': {
    style: 'warm',
    colorPalette: 'bright primary colors, playful pastels, fun neons',
    visualKeywords: 'playful children style, cartoon aesthetic, bright and fun, confetti',
    emotionalElement: 'excited happy animated character',
    facialExpression: 'excited happy expression, jumping, magical wonder, big cartoon eyes',
    descriptionVoice: 'alegre, lúdica, convidativa, linguagem infantil amigável',
    clickbaitPatterns: [
      { text: 'Que legal!', trigger: 'shock' },
      { text: 'O segredo revelado', trigger: 'curiosity_gap' },
      { text: 'A maior aventura', trigger: 'curiosity_gap' },
      { text: 'Você vai adorar', trigger: 'personal' },
      { text: 'Brinquedo mágico', trigger: 'curiosity_gap' },
    ],
    textColor: 'bright primary colors or fun pink with white stroke',
  },
  'tech': {
    style: 'clean',
    colorPalette: 'tech blacks (#212121), circuit greens (#00E676), LED blues (#00B0FF), clean whites',
    visualKeywords: 'tech reviewer style, studio product lighting, clean modern aesthetic, gadgets',
    emotionalElement: 'person skeptically inspecting a device',
    facialExpression: 'skeptical analytical expression, raised eyebrow, inspecting closely, one hand on product',
    descriptionVoice: 'crítica, técnica, objetiva, com opinião fundamentada',
    clickbaitPatterns: [
      { text: 'Vale mesmo a pena?', trigger: 'curiosity_gap' },
      { text: 'Testei por 30 dias', trigger: 'personal' },
      { text: 'A verdade sobre...', trigger: 'curiosity_gap' },
      { text: 'Não compre antes de ver', trigger: 'urgency' },
      { text: 'Resultado inesperado', trigger: 'curiosity_gap' },
    ],
    textColor: 'bright white or circuit green (#00E676) with dark stroke',
  },
  'review': {
    style: 'clean',
    colorPalette: 'studio whites, product blacks, rating stars gold (#FFD700), clean grays',
    visualKeywords: 'product review style, studio lighting, close-up product shots, comparison layout',
    emotionalElement: 'person comparing two products with strong opinion',
    facialExpression: 'disappointed or impressed expression, comparing products, one raised eyebrow, verdict face',
    descriptionVoice: 'analítica, honesta, comparativa, baseada em testes reais',
    clickbaitPatterns: [
      { text: 'Não vale o preço', trigger: 'controversy' },
      { text: 'Testei e me surpreendi', trigger: 'curiosity_gap' },
      { text: 'O melhor de todos?', trigger: 'curiosity_gap' },
      { text: 'Resultado inesperado', trigger: 'curiosity_gap' },
      { text: 'vs — Qual vence?', trigger: 'curiosity_gap' },
    ],
    textColor: 'rating gold (#FFD700) or bright white with dark stroke',
  },
  'science': {
    style: 'clean',
    colorPalette: 'lab whites, data blues (#1565C0), futuristic purples (#7B1FA2), neon accents (#00E5FF)',
    visualKeywords: 'scientific futuristic style, lab aesthetic, holographic data visualization, particles',
    emotionalElement: 'scientist with amazed discovery expression',
    facialExpression: 'amazed scientist expression, discovery moment, goggles pushed up, pointing at experiment',
    descriptionVoice: 'científica, curiosa, baseada em evidências, acessível',
    clickbaitPatterns: [
      { text: 'A ciência explica', trigger: 'curiosity_gap' },
      { text: 'Descoberta chocante', trigger: 'shock' },
      { text: 'Ninguém esperava esse resultado', trigger: 'shock' },
      { text: 'O experimento proibido', trigger: 'curiosity_gap' },
      { text: 'Provado em laboratório', trigger: 'curiosity_gap' },
    ],
    textColor: 'neon accent (#00E5FF) or bright white with dark stroke',
  },
};

const DEFAULT_CONFIG: ToneVisualConfig = {
  style: 'cinematic',
  colorPalette: 'dramatic contrasts, bold accents, professional tones',
  visualKeywords: 'cinematic professional style, dramatic lighting, high production value',
  emotionalElement: 'person with impactful emotional expression',
  facialExpression: 'strong emotional expression, direct eye contact, dramatic lighting on face',
  descriptionVoice: 'envolvente, profissional, clara e impactante',
  clickbaitPatterns: [
    { text: 'Você não vai acreditar', trigger: 'shock' },
    { text: 'Isso muda tudo', trigger: 'before_after' },
    { text: 'A verdade revelada', trigger: 'curiosity_gap' },
    { text: 'Ninguém esperava', trigger: 'shock' },
    { text: 'Descoberta chocante', trigger: 'shock' },
  ],
  textColor: 'bright yellow (#FFEB3B) or white with heavy black stroke',
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
// CHANNEL BRANDING FROM LIBRARY
// =============================================

interface ChannelBranding {
  brandColors?: string;
  brandStyle?: string;
  referenceChannels?: string;
  brandElements?: string;
}

const extractBrandingFromLibrary = (items?: LibraryItem[]): ChannelBranding => {
  if (!items || items.length === 0) return {};
  
  const branding: ChannelBranding = {};
  const brandingItems: string[] = [];
  const channelRefs: string[] = [];
  
  for (const item of items) {
    const content = item.content.toLowerCase();
    const title = item.title.toLowerCase();
    
    // Extract branding-specific items
    if (title.includes('brand') || title.includes('marca') || title.includes('identidade') || 
        title.includes('cor') || title.includes('color') || title.includes('visual') ||
        title.includes('logo') || title.includes('paleta') || title.includes('palette')) {
      brandingItems.push(item.content);
    }
    
    // Extract YouTube channel references for inspiration
    if (item.type === 'youtube_channel') {
      channelRefs.push(`${item.title}: ${item.content}`);
    }
    
    // Look for color patterns in any item
    const hexColors = item.content.match(/#[0-9A-Fa-f]{6}/g);
    if (hexColors && hexColors.length > 0) {
      branding.brandColors = hexColors.join(', ');
    }
  }
  
  if (brandingItems.length > 0) {
    branding.brandStyle = brandingItems.join('. ');
  }
  if (channelRefs.length > 0) {
    branding.referenceChannels = channelRefs.join('; ');
  }
  
  return branding;
};

// =============================================
// THUMBNAIL PROMPT BUILDER (v2 — Psychology-driven)
// =============================================

/**
 * Generates clickbait text + image prompt following proven CTR psychology:
 * 
 * 1. Face covers 40-60% of frame with EXTREME expression
 * 2. Max 3-5 words in bold text with highest contrast
 * 3. Curiosity gap — never reveal the answer
 * 4. High contrast colors (yellow+black, red+white)
 * 5. Element of visual dissonance or unexpected object
 * 6. Channel branding from Library is applied
 * 7. Fake progress bar at bottom (70% watched illusion)
 */
export const buildThumbnailPrompt = (params: ThumbnailDescriptionParams): ThumbnailResult => {
  const { title, script, narrativeTone, niche, libraryItems } = params;
  const config = getToneConfig(narrativeTone);
  const branding = extractBrandingFromLibrary(libraryItems);
  
  // Select clickbait text using psychological triggers
  const clickbaitText = selectClickbaitText(title, script, config);
  
  // Build niche-specific visual element
  const nicheVisual = getNicheVisualElement(niche, narrativeTone);
  
  // Build branding instructions
  const brandingInstructions = buildBrandingInstructions(branding, config);
  
  // Build the complete prompt following CTR psychology rules
  const imagePrompt = `
    YouTube thumbnail, ultra high CTR design, professional quality, exactly 1280x720 pixels.
    
    COMPOSITION (following 200ms decision psychology):
    1. FACE (40-60% of frame): ${config.facialExpression}
       - Face positioned in the right third of the image
       - Eyes looking DIRECTLY at camera (creates personal connection)
       - Dramatic lighting from one side (creates depth and drama)
       - Face must be the FIRST thing noticed
    
    2. TEXT OVERLAY (left or bottom-left third):
       "${clickbaitText}"
       - Maximum 4 words, HUGE bold font
       - Color: ${config.textColor}
       - THICK black outline/stroke (minimum 4px) for mobile legibility
       - Must be readable at 40x22 pixel thumbnail size
       - Text creates curiosity gap — does NOT reveal the answer
    
    3. VISUAL DISSONANCE ELEMENT:
       - One unexpected or out-of-place object/detail that forces a double-take
       - ${nicheVisual}
    
    4. CONTRAST & COLOR:
       - Color palette: ${config.colorPalette}
       - EXTREME contrast between foreground and background
       - Background should NOT compete with the face for attention
       - If it looks "harmonious and balanced" it has INSUFFICIENT contrast
    
    5. SUBTLE ENGAGEMENT TRICKS:
       - A thin red progress bar (3px height) at the very bottom, filled to 70% width
       - This mimics a partially-watched video and triggers FOMO
    
    ${brandingInstructions}
    
    STYLE: ${config.style}, ${config.visualKeywords}
    
    ANTI-PATTERNS (do NOT include):
    - NO watermarks, NO logos, NO URLs
    - NO text other than the specified overlay
    - NO cluttered compositions — maximum 3 focal elements
    - NO neutral facial expressions
    - NO low-contrast color combinations
    - NO generic stock photo aesthetics
  `.trim();
  
  return {
    clickbaitText,
    imagePrompt,
    style: config.style,
    colorPalette: branding.brandColors || config.colorPalette,
  };
};

/**
 * Builds branding instructions from library items
 */
const buildBrandingInstructions = (branding: ChannelBranding, config: ToneVisualConfig): string => {
  const parts: string[] = [];
  
  if (branding.brandColors) {
    parts.push(`CHANNEL BRAND COLORS: Use these as accent colors where possible: ${branding.brandColors}`);
  }
  if (branding.brandStyle) {
    parts.push(`CHANNEL VISUAL IDENTITY: ${branding.brandStyle}`);
  }
  if (branding.referenceChannels) {
    parts.push(`REFERENCE STYLE INSPIRATION: ${branding.referenceChannels}`);
  }
  
  if (parts.length === 0) return '';
  return `6. CHANNEL BRANDING:\n       ${parts.join('\n       ')}`;
};

/**
 * Selects the best clickbait text using content theme analysis + psychological triggers.
 * Prefers curiosity gap (highest CTR impact) when possible.
 */
const selectClickbaitText = (title: string, script: ScriptData, config: ToneVisualConfig): string => {
  const fullText = (title + ' ' + script.segments.map(s => s.narratorText).join(' ')).toLowerCase();
  
  // Detect content themes
  const themes: Record<string, { keywords: string[]; trigger: string }> = {
    'secret':    { keywords: ['segredo', 'secret', 'escondido', 'hidden', 'oculto', 'proibido'], trigger: 'curiosity_gap' },
    'money':     { keywords: ['dinheiro', 'money', 'investir', 'profit', 'lucro', 'rico', 'wealth', 'milhão', 'bilhão'], trigger: 'personal' },
    'danger':    { keywords: ['perigo', 'danger', 'risco', 'risk', 'morte', 'death', 'morrer', 'cuidado'], trigger: 'urgency' },
    'mistake':   { keywords: ['erro', 'mistake', 'errado', 'wrong', 'falha', 'fail', 'problema'], trigger: 'personal' },
    'change':    { keywords: ['mudou', 'changed', 'transform', 'revolução', 'revolution', 'virada'], trigger: 'before_after' },
    'shock':     { keywords: ['choc', 'shock', 'incrível', 'impossible', 'impossível', 'inacredit'], trigger: 'shock' },
    'truth':     { keywords: ['verdade', 'truth', 'mentira', 'lie', 'real', 'fake', 'falso'], trigger: 'curiosity_gap' },
    'discovery': { keywords: ['descobr', 'discover', 'encontr', 'find', 'revel', 'reveal'], trigger: 'curiosity_gap' },
    'fear':      { keywords: ['medo', 'fear', 'terror', 'horror', 'assust', 'scared'], trigger: 'shock' },
    'test':      { keywords: ['test', 'experiment', 'prova', 'result', 'funciona'], trigger: 'curiosity_gap' },
    'number':    { keywords: ['lista', 'list', 'top', 'ranking', 'razões', 'reasons', 'erros', 'errors', 'passos', 'steps'], trigger: 'number' },
    'personal':  { keywords: ['eu ', 'minha', 'meu', 'comigo', 'my ', 'i ', 'myself'], trigger: 'personal' },
  };
  
  let bestTheme = '';
  let bestScore = 0;
  
  for (const [theme, data] of Object.entries(themes)) {
    let score = 0;
    for (const kw of data.keywords) {
      if (fullText.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestTheme = theme;
    }
  }
  
  // Pick clickbait that matches both theme and psychological trigger
  const bestTrigger = bestTheme ? themes[bestTheme].trigger : 'curiosity_gap';
  
  // First try to find a pattern matching the trigger
  const triggerMatches = config.clickbaitPatterns.filter(p => p.trigger === bestTrigger);
  const candidates = triggerMatches.length > 0 
    ? triggerMatches 
    : config.clickbaitPatterns;
  
  // Pick deterministically based on title hash
  const hash = title.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return candidates[hash % candidates.length].text;
};

/**
 * Gets a niche-specific visual element for the thumbnail background.
 */
const getNicheVisualElement = (niche: string, tone: string): string => {
  const lower = niche.toLowerCase();
  
  const nicheVisuals: Record<string, string> = {
    'financ':     'stock trading screens glowing, falling money, red/green charts',
    'finance':    'stock trading screens glowing, falling money, red/green charts',
    'money':      'stacks of money with dramatic lighting, gold bars, wealth contrast',
    'invest':     'stock market graphs with dramatic up/down arrows, trading floor',
    'crypto':     'blockchain visualization, holographic Bitcoin, digital rain matrix',
    'tech':       'futuristic holographic screens, circuit boards, blue LED glow',
    'gaming':     'gaming setup with RGB explosion, controller on fire, screen glow',
    'horror':     'abandoned corridor with single light, fog, door ajar with something behind',
    'terror':     'dark forest at night with single flashlight beam, mysterious figure silhouette',
    'crime':      'crime scene tape, red and blue police lights, investigation board with strings',
    'cook':       'dramatic food explosion, ingredients flying, chef fire',
    'food':       'stunning food close-up with steam, dramatic dark background',
    'fitness':    'powerful athlete silhouette, sweat drops with dramatic backlight',
    'health':     'medical imagery with dramatic lighting, DNA helix, heartbeat line',
    'travel':     'stunning impossible landscape, golden hour, adventure gear',
    'music':      'concert stage explosion of lights, sound wave visualization',
    'education':  'giant book opening with light emanating, knowledge explosion',
    'science':    'laboratory with glowing chemicals, molecular structures floating',
    'nature':     'dramatic landscape with extreme weather, wildlife close-up',
    'history':    'ancient artifacts with dramatic lighting, old maps with X marks',
    'psychology': 'brain visualization split in two with different colors, mind concept',
    'business':   'corporate boardroom with dramatic window view, city lights',
    'art':        'paint explosion in slow motion, artistic composition',
    'fashion':    'high fashion dramatic lighting, avant-garde styling',
    'auto':       'luxury car with dramatic reflection, speed blur, chrome detail',
    'space':      'galaxy nebula, planet close-up, astronaut visor reflection',
    'mystery':    'mysterious door in fog with light streaming through crack',
    'legend':     'ancient forest clearing with mystical light beam, runes',
    'folklore':   'campfire in dark forest with faces in smoke, old castle ruins',
    'politic':    'dramatic parliamentary or government building, flags, podium',
    'president':  'presidential office or government building with dramatic lighting',
    'govern':     'government building columns with dramatic sky, flags waving',
  };
  
  for (const [key, visual] of Object.entries(nicheVisuals)) {
    if (lower.includes(key)) return visual;
  }
  
  const toneConfig = getToneConfig(tone);
  return `dramatic background related to ${niche}, ${toneConfig.visualKeywords}`;
};

// =============================================
// DESCRIPTION BUILDER
// =============================================

export const buildVideoDescription = (params: ThumbnailDescriptionParams): DescriptionResult => {
  const { title, script, narrativeTone, niche, language } = params;
  const config = getToneConfig(narrativeTone);
  const lang = (language || 'Portuguese').toLowerCase();
  const isPt = lang.includes('portug') || lang.includes('pt');
  
  const clickbaitText = selectClickbaitText(title, script, config);
  
  const hook = buildHook(title, script, config, clickbaitText, isPt);
  const summary = buildSummary(title, script, config, isPt);
  const seoBlock = buildSeoBlock(title, script, niche, isPt);
  
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

const buildHook = (
  title: string,
  script: ScriptData,
  config: ToneVisualConfig,
  clickbaitText: string,
  isPt: boolean
): string => {
  const coreTheme = script.coreThemes?.[0] || title;
  
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
  
  const hash = title.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return hookPatterns[hash % hookPatterns.length];
};

const extractTopic = (title: string): string => {
  return title
    .replace(/^(o |a |os |as |the |why |how |what |como |por que |o que )/i, '')
    .replace(/[!?…\.]+$/, '')
    .toLowerCase()
    .trim()
    .substring(0, 60);
};

const buildSummary = (
  title: string,
  script: ScriptData,
  config: ToneVisualConfig,
  isPt: boolean
): string => {
  const segments = script.segments;
  const sectionTitles = segments.map(s => s.sectionTitle).filter(Boolean);
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

const buildSeoBlock = (
  title: string,
  script: ScriptData,
  niche: string,
  isPt: boolean
): string => {
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

const generateHashtags = (title: string, script: ScriptData, niche: string): string[] => {
  const tags = new Set<string>();
  
  const nicheTag = niche.replace(/[^a-zA-ZÀ-ú0-9]/g, '').toLowerCase();
  if (nicheTag) tags.add(nicheTag);
  
  const titleWords = title
    .replace(/[^a-zA-ZÀ-ú0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .map(w => w.toLowerCase());
  
  for (const w of titleWords.slice(0, 3)) {
    tags.add(w);
  }
  
  for (const theme of (script.coreThemes || []).slice(0, 4)) {
    const tag = theme.replace(/[^a-zA-ZÀ-ú0-9]/g, '').toLowerCase();
    if (tag.length > 2) tags.add(tag);
  }
  
  for (const seg of script.segments.slice(0, 5)) {
    const words = (seg.sectionTitle || '')
      .replace(/[^a-zA-ZÀ-ú0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 4);
    for (const w of words.slice(0, 1)) {
      tags.add(w.toLowerCase());
    }
  }
  
  tags.add('youtube');
  
  return [...tags].slice(0, 12);
};

// =============================================
// TIMESTAMPS BUILDER
// =============================================

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

export const generateFullMetadata = (params: ThumbnailDescriptionParams): FullMetadataResult => {
  const thumbnail = buildThumbnailPrompt(params);
  const description = buildVideoDescription(params);
  const timestamps = buildTimestamps(params.script.segments);
  
  return { thumbnail, description, timestamps };
};
