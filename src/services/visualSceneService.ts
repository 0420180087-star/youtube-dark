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

const FALLBACK_PALETTES: [string, string, string][] = [
  ['#152238', '#d97706', '#f8fafc'],
  ['#1f2937', '#14b8a6', '#f1f5f9'],
  ['#111827', '#ef4444', '#fef2f2'],
  ['#172554', '#facc15', '#eff6ff'],
  ['#0f172a', '#2563eb', '#e2e8f0'],
  ['#1c1917', '#f97316', '#fff7ed'],
  ['#0b2b26', '#22c55e', '#ecfdf5'],
  ['#2e1065', '#a855f7', '#f5f3ff'],
  ['#1e1b4b', '#38bdf8', '#e0f2fe'],
  ['#450a0a', '#fb7185', '#fff1f2'],
];

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
  const s = Math.abs(Math.trunc(seed));
  const [bg, accent, fg] = FALLBACK_PALETTES[s % FALLBACK_PALETTES.length];
  const layout = Math.floor(s / 10) % 4;
  const safePrompt = cleanText(prompt).slice(0, 110) || cleanText(tone) || 'cinematic scene';
  const r = Math.min(width, height);

  const glows = [
    { cx: '68%', cy: '34%' },
    { cx: '24%', cy: '28%' },
    { cx: '50%', cy: '72%' },
    { cx: '82%', cy: '66%' },
  ][layout];

  const curves = [
    `M0 ${height * 0.72} C ${width * 0.28} ${height * 0.58}, ${width * 0.52} ${height * 0.86}, ${width} ${height * 0.64} L ${width} ${height} L 0 ${height} Z`,
    `M0 ${height * 0.62} C ${width * 0.34} ${height * 0.88}, ${width * 0.66} ${height * 0.52}, ${width} ${height * 0.78} L ${width} ${height} L 0 ${height} Z`,
    `M0 ${height * 0.84} L ${width * 0.46} ${height * 0.58} L ${width} ${height * 0.9} L ${width} ${height} L 0 ${height} Z`,
    `M0 ${height} L 0 ${height * 0.5} C ${width * 0.4} ${height * 0.7}, ${width * 0.6} ${height * 0.42}, ${width} ${height * 0.68} L ${width} ${height} Z`,
  ][layout];

  const circles = [
    { cx: width * 0.18, cy: height * 0.22, r: r * 0.14 },
    { cx: width * 0.82, cy: height * 0.2, r: r * 0.18 },
    { cx: width * 0.5, cy: height * 0.3, r: r * 0.11 },
    { cx: width * 0.28, cy: height * 0.66, r: r * 0.22 },
  ][layout];

  const textAnchor = layout === 1 || layout === 3 ? 'end' : 'start';
  const textX = textAnchor === 'end' ? width * 0.92 : width * 0.08;
  const textY = layout === 2 ? height * 0.2 : height * 0.84;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="g" x1="${layout % 2}" y1="0" x2="${1 - (layout % 2)}" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="#020617"/></linearGradient>
      <radialGradient id="r" cx="${glows.cx}" cy="${glows.cy}" r="55%"><stop offset="0" stop-color="${accent}" stop-opacity="0.55"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <rect width="100%" height="100%" fill="url(#r)"/>
    <path d="${curves}" fill="${accent}" opacity="0.28"/>
    <circle cx="${circles.cx}" cy="${circles.cy}" r="${circles.r}" fill="${fg}" opacity="0.08"/>
    <text x="${textX}" y="${textY}" text-anchor="${textAnchor}" fill="${fg}" font-family="Arial, sans-serif" font-size="${Math.max(36, width * 0.035)}" font-weight="700" opacity="0.82">${safePrompt.replace(/[<>&]/g, '')}</text>
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