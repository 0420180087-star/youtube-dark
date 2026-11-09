import type { CaptionCue, ConceptCard, ScriptSegment } from '../types';

export type WordCaptionCue = CaptionCue;

const PRONUNCIATION_HINTS = [
  { term: 'René Descartes', spoken: 'Renê Decárt' },
  { term: 'Cogito, ergo sum', spoken: 'Cóguito, érgo sum' },
];

export const getConversationalScriptGuidance = (language = 'the requested language'): string =>
  `EDITORIAL VOICE — write for spoken delivery in ${language}: open with a specific, intriguing question or tension; address the viewer naturally; explain ideas through concrete examples and clear cause-and-effect; use varied sentence lengths and purposeful transitions; avoid textbook openings, generic summaries, repeated rhetorical filler, and unsupported claims. Do not invent personal experiences or speak as the channel owner unless the supplied context explicitly provides those experiences. End with a meaningful takeaway, not a generic recap.`;

export const getNarrationDeliveryNotes = (text: string, language = ''): string => {
  const notes = [
    'DELIVERY: Sound like a thoughtful human storyteller, not a page being read. Vary pace naturally, breathe at paragraph boundaries, pause briefly after important questions, and give key ideas gentle emphasis without overacting.',
    'PRONUNCIATION: Keep the original wording and language. For unfamiliar names, pronounce carefully and consistently; do not translate names or add words.',
  ];

  if (language.toLowerCase().startsWith('pt')) {
    for (const hint of PRONUNCIATION_HINTS) {
      if (text.toLocaleLowerCase().includes(hint.term.toLocaleLowerCase())) {
        notes.push(`Portuguese pronunciation guide for this passage: ${hint.term} sounds like “${hint.spoken}”.`);
      }
    }
  }

  return notes.join('\n');
};

export const normalizeConceptCards = (value: unknown, maxSegments = 24): ConceptCard[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, idx) => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Partial<ConceptCard>;
    const segmentIndex = Number(candidate.segmentIndex);
    const title = String(candidate.title || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const items = Array.isArray(candidate.items)
      ? candidate.items.map((entry) => String(entry || '').replace(/\s+/g, ' ').trim().slice(0, 48)).filter(Boolean).slice(0, 3)
      : [];
    if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= maxSegments || !title || items.length < 2) return [];
    return [{ segmentIndex, title, items, relationship: String(candidate.relationship || '→').slice(0, 12), id: String(candidate.id || `concept-${segmentIndex}-${idx}`) }];
  }).slice(0, 12);
};

export const buildSegmentStarts = (durations: number[], pauseSeconds = 0): number[] => {
  let cursor = 0;
  return durations.map((duration, index) => {
    const start = cursor;
    cursor += Math.max(0, Number(duration) || 0);
    if (index < durations.length - 1) cursor += Math.max(0, pauseSeconds);
    return start;
  });
};

export const buildVideoCaptionCues = (
  segments: Pick<ScriptSegment, 'narratorText'>[],
  starts: number[],
  spokenDurations: number[],
): WordCaptionCue[] => buildWordCaptionCues(segments, starts, spokenDurations);

/** Estimate word-level timing within each measured spoken segment. */
export const buildWordCaptionCues = (
  segments: Pick<ScriptSegment, 'narratorText'>[],
  starts: number[],
  spokenDurations: number[],
): WordCaptionCue[] => {
  const cues: WordCaptionCue[] = [];
  segments.forEach((segment, segmentIndex) => {
    const words = (segment.narratorText || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || [];
    const start = Math.max(0, Number(starts[segmentIndex]) || 0);
    const duration = Math.max(0, Number(spokenDurations[segmentIndex]) || 0);
    if (!words.length || duration <= 0) return;

    const weights = words.map((word) => Math.max(1, Math.pow(word.length, 0.72)));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = start;
    words.forEach((word, index) => {
      const wordDuration = duration * (weights[index] / totalWeight);
      cues.push({ text: word, start: cursor, end: index === words.length - 1 ? start + duration : cursor + wordDuration, segmentIndex });
      cursor += wordDuration;
    });
  });
  return cues;
};

export const getCaptionWindow = (cues: WordCaptionCue[], time: number, maxWords = 5) => {
  const activeIndex = cues.findIndex((cue) => time >= cue.start && time < cue.end);
  if (activeIndex < 0) return [];
  const segmentIndex = cues[activeIndex]?.segmentIndex;
  if (segmentIndex === undefined) return [];
  const inSegment = cues.map((cue, index) => ({ cue, index })).filter(({ cue }) => cue.segmentIndex === segmentIndex);
  const localIndex = inSegment.findIndex(({ index }) => index === activeIndex);
  const windowStart = Math.floor(localIndex / maxWords) * maxWords;
  return inSegment.slice(windowStart, windowStart + maxWords).map(({ cue, index }) => ({ ...cue, active: index === activeIndex }));
};

export const drawVideoOverlays = (
  ctx: CanvasRenderingContext2D,
  time: number,
  width: number,
  height: number,
  cues: WordCaptionCue[],
  conceptCards: ConceptCard[] = [],
): void => {
  const maxWords = width >= 1200 ? 5 : 3;
  const caption = getCaptionWindow(cues, time, maxWords);
  const fontSize = Math.max(28, Math.round(height * 0.044));
  const padX = Math.round(fontSize * 0.55);
  const padY = Math.round(fontSize * 0.35);
  const gap = Math.round(fontSize * 0.24);

  if (caption.length) {
    ctx.save();
    ctx.font = `700 ${fontSize}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const totalWidth = caption.reduce((sum, word) => sum + ctx.measureText(word.text).width, 0) + gap * (caption.length - 1);
    const centerX = width / 2;
    const y = height * 0.86;
    let x = centerX - totalWidth / 2;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.beginPath();
    const boxWidth = Math.min(width - 32, totalWidth + padX * 2);
    ctx.roundRect(centerX - boxWidth / 2, y - fontSize / 2 - padY, boxWidth, fontSize + padY * 2, Math.round(fontSize * 0.25));
    ctx.fill();
    for (const word of caption) {
      const wordWidth = ctx.measureText(word.text).width;
      ctx.fillStyle = word.active ? '#FFD166' : '#FFFFFF';
      ctx.shadowColor = 'rgba(0,0,0,0.65)';
      ctx.shadowBlur = 3;
      ctx.fillText(word.text, x + wordWidth / 2, y, width - 48);
      x += wordWidth + gap;
    }
    ctx.restore();
  }

  const activeCue = cues.find((cue) => time >= cue.start && time < cue.end);
  const card = conceptCards.find((item) => {
    if (item.segmentIndex !== activeCue?.segmentIndex) return false;
    const first = cues.find((cue) => cue.segmentIndex === item.segmentIndex);
    return first !== undefined && time < first.start + 4.5;
  });
  if (!card) return;

  ctx.save();
  const cardFont = Math.max(24, Math.round(height * 0.032));
  const line = card.items.join(`  ${card.relationship || '→'}  `);
  ctx.font = `700 ${cardFont}px Arial, sans-serif`;
  const boxWidth = Math.min(width - 40, Math.max(ctx.measureText(card.title).width, ctx.measureText(line).width) + cardFont * 1.4);
  const boxHeight = cardFont * 3.1;
  const x = (width - boxWidth) / 2;
  const y = height * 0.12;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.beginPath();
  ctx.roundRect(x, y, boxWidth, boxHeight, Math.round(cardFont * 0.3));
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFD166';
  ctx.fillText(card.title, width / 2, y + cardFont * 0.8, boxWidth - cardFont);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `600 ${cardFont * 0.8}px Arial, sans-serif`;
  ctx.fillText(line, width / 2, y + cardFont * 2, boxWidth - cardFont);
  ctx.restore();
};

const assTime = (seconds: number): string => {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const centiseconds = Math.floor((safe - Math.floor(safe)) * 100);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
};

const escapeAss = (text: string): string => text.replace(/[{}]/g, '').replace(/\\/g, '\\\\');

/** ASS subtitle track shared by the FFmpeg export; karaoke tags highlight each spoken word. */
export const buildAssSubtitleScript = (
  cues: WordCaptionCue[],
  conceptCards: ConceptCard[] = [],
  width = 1920,
  height = 1080,
): string => {
  const fontSize = Math.max(32, Math.round(height * 0.045));
  const cardSize = Math.max(24, Math.round(height * 0.032));
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 2',
    '', '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Karaoke,Arial,${fontSize},&H0000D7FF,&H00FFFFFF,&H00101010,&H90000000,-1,0,1,3,1,2,80,80,${Math.round(height * 0.075)},1`,
    `Style: Concept,Arial,${cardSize},&H00FFFFFF,&H00FFFFFF,&H00101010,&H99000000,-1,0,3,1,0,8,80,80,${Math.round(height * 0.07)},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  for (let index = 0; index < cues.length;) {
    const first = cues[index];
    if (!first) break;
    const group = [first];
    let nextIndex = index + 1;
    while (nextIndex < cues.length && group.length < 5) {
      const next = cues[nextIndex];
      const previous = group[group.length - 1];
      if (!next || next.segmentIndex !== first.segmentIndex || next.start - previous.end > 0.25) break;
      group.push(next);
      nextIndex++;
    }
    const karaokeText = group.map((cue) => {
      const durationCs = Math.max(1, Math.round((cue.end - cue.start) * 100));
      return `{\\k${durationCs}}${escapeAss(cue.text)} `;
    }).join('').trim();
    lines.push(`Dialogue: 0,${assTime(first.start)},${assTime(group[group.length - 1]?.end || first.end)},Karaoke,,0,0,0,,${karaokeText}`);
    index += group.length;
  }

  const firstCueBySegment = new Map<number, WordCaptionCue>();
  const lastCueBySegment = new Map<number, WordCaptionCue>();
  cues.forEach((cue) => {
    if (!firstCueBySegment.has(cue.segmentIndex)) firstCueBySegment.set(cue.segmentIndex, cue);
    lastCueBySegment.set(cue.segmentIndex, cue);
  });
  conceptCards.forEach((card) => {
    const firstCue = firstCueBySegment.get(card.segmentIndex);
    const lastCue = lastCueBySegment.get(card.segmentIndex);
    if (!firstCue) return;
    const end = Math.min(firstCue.start + 5, lastCue?.end || firstCue.end);
    const diagram = `${escapeAss(card.title)}\\N${card.items.map(escapeAss).join(`  ${escapeAss(card.relationship || '→')}  `)}`;
    lines.push(`Dialogue: 1,${assTime(firstCue.start)},${assTime(end)},Concept,,0,0,0,,${diagram}`);
  });

  return `${lines.join('\n')}\n`;
};