import { ScriptSegment, VideoFormat, VisualScene } from '../types';

const SLOT_VARIATIONS = [
  'wide establishing shot',
  'close detail shot',
  'dynamic movement shot',
  'symbolic cinematic insert',
  'dramatic atmosphere shot',
  'human perspective shot',
  'environment texture shot',
  'high-energy transition shot',
];

const cleanText = (value?: string) => (value || '').replace(/\s+/g, ' ').trim();

export const getSegmentVisualPrompts = (segment: Pick<ScriptSegment, 'visualDescriptions' | 'sectionTitle' | 'narratorText'>): string[] => {
  const explicit = (segment.visualDescriptions || [])
    .map(cleanText)
    .filter(Boolean);

  if (explicit.length > 0) return explicit;

  const title = cleanText(segment.sectionTitle);
  const sentences = cleanText(segment.narratorText)
    .split(/(?<=[.!?])\s+/)
    .map(s => s.replace(/["“”]/g, '').trim())
    .filter(s => s.length > 20)
    .slice(0, 4);

  if (sentences.length > 0) {
    return sentences.map((sentence, idx) => `${title || 'Narrative beat'} — ${sentence.slice(0, 180)} — cinematic b-roll ${idx + 1}`);
  }

  return [title || 'cinematic atmosphere for this narrative moment'];
};

export const buildSlotVisualPrompt = (
  segment: Pick<ScriptSegment, 'sectionTitle' | 'narratorText'>,
  basePrompt: string,
  segmentIndex: number,
  slotIndex: number,
  totalSlots: number,
  channelTheme?: string,
): string => {
  const variation = SLOT_VARIATIONS[(segmentIndex + slotIndex) % SLOT_VARIATIONS.length];
  const narratorContext = cleanText(segment.narratorText).slice(0, 220);
  const section = cleanText(segment.sectionTitle) || `Section ${segmentIndex + 1}`;

  return [
    cleanText(basePrompt) || section,
    `section: ${section}`,
    channelTheme ? `topic: ${cleanText(channelTheme)}` : '',
    narratorContext ? `story context: ${narratorContext}` : '',
    `visual variation ${slotIndex + 1} of ${totalSlots}: ${variation}`,
    'must be visually distinct from previous shots',
  ].filter(Boolean).join('. ');
};

export const createFallbackVisualDataUrl = (
  prompt: string,
  tone: string = 'Cinematic',
  format: VideoFormat | string = 'Landscape 16:9',
  seed: number = 0,
): string => {
  const isPortrait = String(format).includes('9:16');
  const isSquare = String(format).includes('1:1');
  const width = isPortrait ? 1080 : 1920;
  const height = isPortrait ? 1920 : isSquare ? 1080 : 1080;
  const palettes = [
    ['#152238', '#d97706', '#f8fafc'],
    ['#1f2937', '#14b8a6', '#f1f5f9'],
    ['#111827', '#ef4444', '#fef2f2'],
    ['#172554', '#facc15', '#eff6ff'],
  ];
  const [bg, accent, fg] = palettes[Math.abs(seed) % palettes.length];
  const safePrompt = cleanText(prompt).slice(0, 110) || cleanText(tone) || 'cinematic scene';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="#020617"/></linearGradient>
      <radialGradient id="r" cx="68%" cy="34%" r="55%"><stop offset="0" stop-color="${accent}" stop-opacity="0.55"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <rect width="100%" height="100%" fill="url(#r)"/>
    <path d="M0 ${height * 0.72} C ${width * 0.28} ${height * 0.58}, ${width * 0.52} ${height * 0.86}, ${width} ${height * 0.64} L ${width} ${height} L 0 ${height} Z" fill="${accent}" opacity="0.28"/>
    <circle cx="${width * 0.18}" cy="${height * 0.22}" r="${Math.min(width, height) * 0.14}" fill="${fg}" opacity="0.08"/>
    <text x="${width * 0.08}" y="${height * 0.84}" fill="${fg}" font-family="Arial, sans-serif" font-size="${Math.max(36, width * 0.035)}" font-weight="700" opacity="0.82">${safePrompt.replace(/[<>&]/g, '')}</text>
  </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

export const collectPexelsIds = (scenes: VisualScene[] = []): Set<number> => {
  return new Set(
    scenes
      .map(scene => scene.pexelsId)
      .filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
  );
};