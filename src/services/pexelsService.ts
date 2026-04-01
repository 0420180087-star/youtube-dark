/**
 * PEXELS CONTEXTUAL SEARCH SERVICE
 * 
 * Intelligent, contextual, non-repeating media search for automated video generation.
 * Rules: Contextual queries per script section, tone-aware, zero repetition, fallback chain.
 */

import { decryptData } from "./securityService";

// =============================================
// TYPES
// =============================================

export interface PexelsMedia {
  id: number;
  videoUrl: string;
  thumbnailUrl: string;
  source: 'pexels';
}

export interface PexelsSearchParams {
  sectionText: string;
  sectionTitle: string;
  narrativeTone: string;
  niche: string;
  usedIds: Set<number>;
  format?: string;
}

// =============================================
// TONE → VISUAL MODIFIER MAP (Rule 2)
// =============================================

const TONE_VISUAL_MODIFIERS: Record<string, string[]> = {
  // Suspenseful & Dark (Horror)
  'dark':       ['dark', 'shadows', 'fog', 'abandoned', 'night'],
  'horror':     ['dark', 'eerie', 'fog', 'ruins', 'storm'],
  'suspens':    ['dark', 'mysterious', 'shadows', 'moody', 'night'],
  'thriller':   ['dark', 'urban night', 'tension', 'shadows'],
  
  // Children's Story
  'child':      ['colorful', 'nature', 'animals', 'playful', 'bright'],
  'kid':        ['colorful', 'cartoon', 'cute', 'garden', 'sunshine'],
  'fairy':      ['magical', 'forest', 'sparkle', 'flowers', 'rainbow'],
  
  // True Crime
  'crime':      ['urban', 'noir', 'police', 'city night', 'documentary'],
  'serious':    ['urban', 'black white', 'formal', 'documentary'],
  
  // Educational
  'education':  ['clean', 'office', 'whiteboard', 'modern', 'minimal'],
  'explanat':   ['clean', 'diagram', 'studio', 'bright', 'professional'],
  'clear':      ['minimal', 'bright', 'modern', 'organized'],
  'wendover':   ['aerial', 'infrastructure', 'map', 'transport', 'logistics'],
  'explainer':  ['clean', 'diagram', 'studio', 'modern'],
  
  // Documentary
  'documentary':['landscape', 'nature', 'journalism', 'formal', 'aerial'],
  'formal':     ['corporate', 'city', 'professional', 'clean'],
  
  // Fast-paced / Viral
  'fast':       ['dynamic', 'colorful', 'impact', 'speed', 'energy'],
  'viral':      ['trending', 'colorful', 'fast', 'energy', 'bold'],
  'shorts':     ['vertical', 'dynamic', 'bold', 'colorful'],
  
  // Vlog
  'vlog':       ['people', 'everyday', 'street', 'energy', 'casual'],
  'personal':   ['people', 'lifestyle', 'casual', 'warm'],
  'enthusiast': ['energy', 'people', 'action', 'outdoors'],
  
  // Calm / ASMR
  'calm':       ['nature', 'soft light', 'cozy', 'interior', 'peaceful'],
  'asmr':       ['close up', 'texture', 'soft', 'warm light', 'detail'],
  'relax':      ['nature', 'water', 'sunset', 'peaceful', 'slow'],
  'cozy':       ['interior', 'warm', 'candle', 'book', 'rain window'],
  
  // Motivational
  'motivat':    ['sunset', 'running', 'mountain', 'success', 'sunrise'],
  'energetic':  ['workout', 'action', 'sunrise', 'determination'],
  'coach':      ['sunrise', 'road', 'athlete', 'overcome', 'sky'],
  
  // Tech
  'tech':       ['technology', 'gadget', 'studio', 'clean', 'circuit'],
  'review':     ['product', 'studio', 'close up', 'modern', 'device'],
  'science':    ['lab', 'futuristic', 'data', 'space', 'technology'],
  
  // Gaming
  'gaming':     ['neon', 'gaming setup', 'rgb lights', 'action', 'screen'],
  'loud':       ['neon', 'explosion', 'fast', 'energy', 'vibrant'],
  
  // Business / Corporate
  'business':   ['corporate', 'meeting', 'city', 'skyscraper', 'office'],
  'corporate':  ['boardroom', 'city', 'professional', 'finance'],
  'finance':    ['stock market', 'city skyline', 'numbers', 'gold'],
  
  // Urban Legend / Folklore
  'legend':     ['forest', 'mystery', 'night', 'old', 'fog'],
  'folklore':   ['ancient', 'forest', 'campfire', 'night', 'ruin'],
  'urban legend':['dark alley', 'abandoned', 'night', 'mystery'],
};

// =============================================
// EMOTION → VISUAL CONTEXT MAP (Rule 1)
// =============================================

const EMOTION_VISUAL_MAP: Record<string, string[]> = {
  // Positive emotions
  'opportunity':  ['city skyline', 'growth', 'sunrise', 'open road'],
  'success':      ['luxury', 'modern architecture', 'celebration', 'gold'],
  'hope':         ['sunrise', 'light tunnel', 'spring flowers', 'dawn'],
  'joy':          ['sunshine', 'festival', 'bright colors', 'laughter'],
  'freedom':      ['open sky', 'ocean', 'flying bird', 'highway'],
  'growth':       ['plant growing', 'city building', 'upward', 'green'],
  'wealth':       ['gold', 'luxury car', 'penthouse', 'diamond'],
  'victory':      ['trophy', 'summit mountain', 'fireworks', 'podium'],
  'innovation':   ['futuristic', 'technology', 'startup', 'creative'],
  'beginning':    ['dawn', 'first step', 'empty road', 'new day'],
  
  // Negative emotions
  'crisis':       ['storm', 'broken', 'abandoned building', 'dark clouds'],
  'failure':      ['ruins', 'empty', 'rain', 'fallen', 'shattered'],
  'danger':       ['fire', 'cliff edge', 'warning', 'dark alley'],
  'fear':         ['dark forest', 'shadows', 'fog', 'abandoned'],
  'loss':         ['empty chair', 'autumn leaves', 'rain window', 'alone'],
  'conflict':     ['chess', 'storm clouds', 'waves crashing', 'war'],
  'corruption':   ['dark city', 'smoke', 'cage', 'shadows'],
  'decline':      ['ruins', 'rust', 'decay', 'dried desert'],
  
  // Transitional emotions
  'change':       ['crossroads', 'door opening', 'butterfly', 'seasons'],
  'recovery':     ['sunrise road', 'phoenix', 'spring bloom', 'healing'],
  'mystery':      ['fog', 'closed door', 'labyrinth', 'keyhole'],
  'discovery':    ['map', 'telescope', 'cave', 'exploration'],
  'transformation':['metamorphosis', 'before after', 'construction', 'evolution'],
  'tension':      ['tightrope', 'clock ticking', 'storm approaching', 'standoff'],
  'revelation':   ['light breaking', 'curtain opening', 'magnifying glass'],
  'reflection':   ['mirror', 'still water', 'contemplation', 'journal'],
  
  // Neutral / Informational
  'explanation':  ['diagram', 'blueprint', 'library', 'classroom'],
  'comparison':   ['side by side', 'balance scale', 'contrast'],
  'history':      ['old photograph', 'museum', 'vintage', 'archive'],
  'technology':   ['circuit board', 'data center', 'hologram', 'code'],
  'nature':       ['forest', 'ocean', 'mountains', 'wildlife'],
};

// =============================================
// PEXELS KEY LOADER
// =============================================

const getPexelsKey = async (): Promise<string | null> => {
  const stored = localStorage.getItem('ds_pexels_api_key');
  if (stored) {
    try { return await decryptData(stored); } catch {}
  }
  const envKey = import.meta.env?.VITE_PEXELS_API_KEY;
  if (envKey && envKey.length > 10) return envKey;
  return null;
};

// =============================================
// RULE 1 & 2: QUERY BUILDER (no AI call needed)
// =============================================

/**
 * Detects the dominant emotion/context from a section's text.
 */
const detectEmotion = (text: string): string => {
  const lower = text.toLowerCase();
  
  // Score each emotion by keyword presence
  const scores: [string, number][] = [];
  
  const emotionKeywords: Record<string, string[]> = {
    'opportunity':  ['opportunity', 'invest', 'chance', 'potential', 'oportunidade', 'investir', 'chance'],
    'success':      ['success', 'win', 'profit', 'achieve', 'sucesso', 'lucro', 'vitória', 'conquist'],
    'hope':         ['hope', 'dream', 'future', 'better', 'esperança', 'sonho', 'futuro', 'melhor'],
    'joy':          ['happy', 'joy', 'fun', 'celebrate', 'feliz', 'alegria', 'divert', 'celebr'],
    'freedom':      ['freedom', 'free', 'escape', 'liberdade', 'livre', 'escapar'],
    'growth':       ['grow', 'scale', 'expand', 'develop', 'cresci', 'escala', 'expandi', 'desenvolv'],
    'wealth':       ['money', 'rich', 'wealth', 'million', 'billion', 'dinheiro', 'rico', 'riqueza', 'milhão', 'bilhão'],
    'victory':      ['victory', 'champion', 'first place', 'medal', 'campeão', 'medalha', 'primeiro lugar'],
    'innovation':   ['innovate', 'invent', 'create', 'startup', 'inovar', 'inventar', 'criar', 'startup'],
    'beginning':    ['begin', 'start', 'origin', 'birth', 'início', 'começo', 'origem', 'nasciment'],
    'crisis':       ['crisis', 'crash', 'collapse', 'disaster', 'crise', 'colapso', 'desastre', 'queda'],
    'failure':      ['fail', 'mistake', 'error', 'wrong', 'falha', 'erro', 'errado', 'fracass'],
    'danger':       ['danger', 'risk', 'threat', 'warning', 'perigo', 'risco', 'ameaça', 'alerta'],
    'fear':         ['fear', 'scared', 'terror', 'horror', 'afraid', 'medo', 'terror', 'horror', 'assust'],
    'loss':         ['loss', 'lost', 'gone', 'disappear', 'perda', 'perdeu', 'sumiu', 'desaparec'],
    'conflict':     ['war', 'fight', 'battle', 'conflict', 'guerra', 'luta', 'batalha', 'conflito'],
    'corruption':   ['corrupt', 'fraud', 'scandal', 'lie', 'corrupção', 'fraude', 'escândalo', 'mentira'],
    'decline':      ['decline', 'fall', 'decay', 'ruin', 'declínio', 'ruína', 'decadência'],
    'change':       ['change', 'transform', 'shift', 'turn', 'mudan', 'transform', 'virada'],
    'recovery':     ['recover', 'rebuild', 'comeback', 'heal', 'recuper', 'reconstrui', 'volta por cima', 'curar'],
    'mystery':      ['mystery', 'secret', 'hidden', 'unknown', 'mistério', 'segredo', 'escondido', 'desconhecido'],
    'discovery':    ['discover', 'find', 'reveal', 'uncover', 'descobr', 'encontr', 'revela'],
    'transformation':['transform', 'evolve', 'metamorphos', 'transform', 'evolu', 'metamorfos'],
    'tension':      ['tension', 'pressure', 'deadline', 'urgent', 'tensão', 'pressão', 'prazo', 'urgent'],
    'revelation':   ['reveal', 'truth', 'expose', 'uncover', 'verdade', 'expor', 'revelação'],
    'reflection':   ['reflect', 'think', 'ponder', 'review', 'reflet', 'pensar', 'revis'],
    'explanation':  ['explain', 'how', 'why', 'because', 'explic', 'como', 'por que', 'porque'],
    'comparison':   ['compare', 'versus', 'vs', 'differ', 'compar', 'diferenç'],
    'history':      ['history', 'ancient', 'century', 'era', 'história', 'antigo', 'século', 'era'],
    'technology':   ['technology', 'ai', 'computer', 'digital', 'tecnologia', 'computador', 'digital', 'artificial'],
    'nature':       ['nature', 'animal', 'forest', 'ocean', 'natureza', 'animal', 'floresta', 'oceano'],
  };
  
  for (const [emotion, keywords] of Object.entries(emotionKeywords)) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > 0) scores.push([emotion, score]);
  }
  
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0]?.[0] || 'explanation';
};

/**
 * Gets the visual modifier words for a given narrative tone.
 */
const getToneModifiers = (tone: string): string[] => {
  const lower = tone.toLowerCase();
  for (const [key, modifiers] of Object.entries(TONE_VISUAL_MODIFIERS)) {
    if (lower.includes(key)) return modifiers;
  }
  return ['cinematic', 'professional'];
};

/**
 * RULE 1+2+4: Builds a contextual Pexels search query.
 * Combines emotion-detected visual context with tone-based modifier.
 * Returns 2-4 word English query.
 */
export const buildContextualQuery = (
  sectionText: string,
  sectionTitle: string,
  narrativeTone: string,
): string => {
  const emotion = detectEmotion(sectionText + ' ' + sectionTitle);
  const emotionVisuals = EMOTION_VISUAL_MAP[emotion] || ['landscape', 'atmosphere'];
  const toneModifiers = getToneModifiers(narrativeTone);
  
  // Pick one visual context and one tone modifier
  const visual = emotionVisuals[Math.floor(Math.random() * emotionVisuals.length)];
  const modifier = toneModifiers[Math.floor(Math.random() * toneModifiers.length)];
  
  // Build 2-4 word query
  return `${visual} ${modifier}`.trim();
};

/**
 * Generates multiple variant queries for a section to maximize coverage.
 */
export const buildQueryVariants = (
  sectionText: string,
  sectionTitle: string,
  narrativeTone: string,
  niche: string,
): string[] => {
  const emotion = detectEmotion(sectionText + ' ' + sectionTitle);
  const emotionVisuals = EMOTION_VISUAL_MAP[emotion] || ['landscape', 'atmosphere'];
  const toneModifiers = getToneModifiers(narrativeTone);
  
  const queries: string[] = [];
  const used = new Set<string>();
  
  // Generate 4-6 unique combinations
  for (let i = 0; i < Math.min(emotionVisuals.length, 3); i++) {
    for (let j = 0; j < Math.min(toneModifiers.length, 2); j++) {
      const q = `${emotionVisuals[i]} ${toneModifiers[j]}`;
      if (!used.has(q)) {
        used.add(q);
        queries.push(q);
      }
      if (queries.length >= 5) break;
    }
    if (queries.length >= 5) break;
  }
  
  // Add a niche-only fallback query
  if (niche) {
    queries.push(niche.split(' ').slice(0, 2).join(' '));
  }
  
  return queries;
};

// =============================================
// RULE 3: SEARCH WITH DEDUPLICATION
// =============================================

/**
 * Searches Pexels with full deduplication and fallback chain.
 * Returns media items with IDs for tracking.
 */
export const searchPexelsContextual = async (
  params: PexelsSearchParams
): Promise<PexelsMedia[]> => {
  const apiKey = await getPexelsKey();
  if (!apiKey) {
    console.warn('[Pexels] No API key configured');
    return [];
  }
  
  const { sectionText, sectionTitle, narrativeTone, niche, usedIds, format } = params;
  const orientation = format?.toLowerCase().includes('portrait') ? 'portrait' : 'landscape';
  const minWidth = orientation === 'portrait' ? 720 : 1280;
  
  // Build query variants
  const queries = buildQueryVariants(sectionText, sectionTitle, narrativeTone, niche);
  
  console.log(`[Pexels] 🔍 Searching for section "${sectionTitle}" | emotion-based queries:`, queries);
  
  const results: PexelsMedia[] = [];
  
  for (const query of queries) {
    const newResults = await executePexelsSearch(apiKey, query, orientation, minWidth, usedIds);
    results.push(...newResults);
    
    // Mark these IDs as used
    for (const r of newResults) usedIds.add(r.id);
    
    // Stop if we have enough
    if (results.length >= 5) break;
    
    // Rate limit courtesy
    await new Promise(r => setTimeout(r, 250));
  }
  
  // RULE 5: Fallback chain
  if (results.length < 3) {
    console.log(`[Pexels] ⚠️ Only ${results.length} results. Trying tone-stripped query...`);
    // Fallback 1: emotion visual only (no tone modifier)
    const emotion = detectEmotion(sectionText + ' ' + sectionTitle);
    const emotionVisuals = EMOTION_VISUAL_MAP[emotion] || ['landscape'];
    const fallbackQuery = emotionVisuals[0];
    
    const fallbackResults = await executePexelsSearch(apiKey, fallbackQuery, orientation, minWidth, usedIds);
    results.push(...fallbackResults);
    for (const r of fallbackResults) usedIds.add(r.id);
  }
  
  if (results.length < 3) {
    console.log(`[Pexels] ⚠️ Still only ${results.length} results. Trying niche-only query...`);
    // Fallback 2: niche only
    const nicheQuery = niche.split(' ').slice(0, 2).join(' ') || 'cinematic';
    const nicheResults = await executePexelsSearch(apiKey, nicheQuery, orientation, minWidth, usedIds);
    results.push(...nicheResults);
    for (const r of nicheResults) usedIds.add(r.id);
  }
  
  if (results.length < 2) {
    console.log(`[Pexels] ⚠️ Final fallback: generic atmospheric query`);
    // Fallback 3: completely generic
    const genericQueries = ['cinematic atmosphere', 'dramatic landscape', 'abstract motion', 'aerial city'];
    const gq = genericQueries[Math.floor(Math.random() * genericQueries.length)];
    const genericResults = await executePexelsSearch(apiKey, gq, orientation, minWidth, usedIds);
    results.push(...genericResults);
    for (const r of genericResults) usedIds.add(r.id);
  }
  
  console.log(`[Pexels] ✅ Found ${results.length} unique media items for section "${sectionTitle}"`);
  
  // Shuffle for variety
  return results.sort(() => Math.random() - 0.5);
};

// =============================================
// LOW-LEVEL PEXELS API CALL
// =============================================

const executePexelsSearch = async (
  apiKey: string,
  query: string,
  orientation: string,
  minWidth: number,
  usedIds: Set<number>,
): Promise<PexelsMedia[]> => {
  try {
    const response = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=15&orientation=${orientation}&min_duration=5&max_duration=30&size=medium`,
      { headers: { Authorization: apiKey } }
    );
    
    if (!response.ok) {
      console.warn(`[Pexels] API returned ${response.status} for "${query}"`);
      return [];
    }
    
    const data = await response.json();
    const results: PexelsMedia[] = [];
    
    for (const video of (data.videos || [])) {
      // RULE 3: Skip already-used IDs
      if (usedIds.has(video.id)) continue;
      
      const validFiles = (video.video_files || [])
        .filter((f: any) => f.width >= minWidth && f.quality === 'hd')
        .sort((a: any, b: any) => (a.width || 0) - (b.width || 0));
      
      const file = validFiles[0] || video.video_files?.[0];
      if (file) {
        results.push({
          id: video.id,
          videoUrl: file.link,
          thumbnailUrl: video.image,
          source: 'pexels',
        });
      }
    }
    
    return results;
  } catch (err) {
    console.error(`[Pexels] Search failed for "${query}":`, err);
    return [];
  }
};

// =============================================
// CONVENIENCE: Single-call for ProjectEditor
// =============================================

/**
 * High-level function: searches Pexels contextually for a visual scene.
 * Drop-in replacement for the old generatePexelsKeywords + searchStockVideos flow.
 */
export const searchContextualMedia = async (
  sectionNarratorText: string,
  sectionTitle: string,
  narrativeTone: string,
  channelNiche: string,
  usedIds: Set<number>,
  format?: string,
): Promise<PexelsMedia | null> => {
  const results = await searchPexelsContextual({
    sectionText: sectionNarratorText,
    sectionTitle,
    narrativeTone,
    niche: channelNiche,
    usedIds,
    format,
  });
  
  if (results.length === 0) return null;
  
  // Pick from top results
  const pick = results[Math.floor(Math.random() * Math.min(3, results.length))];
  return pick;
};
