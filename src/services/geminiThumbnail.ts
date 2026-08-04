// Thumbnail generation engine — fully Gemini-driven.
//
// ARCHITECTURE:
//   1. generateThumbnailHook()  — Gemini reads the full script and generates
//      a clickbait text phrase tuned to the video's actual content + tone.
//
//   2. generateThumbnail()      — Two-step Gemini pipeline:
//        Step A: Gemini Flash reads script → outputs a rich, topic-specific
//                image prompt that references concrete details from the content.
//        Step B: Gemini image model renders that prompt at 1280×720.
//
//   3. generateCanvasThumbnail() — No-API fallback. Only fires if both
//      image models refuse or hit a non-quota error.
//
// CLICKBAIT PSYCHOLOGY applied at every step:
//   • Curiosity gap  — never reveal the answer, always imply a secret
//   • Visual dissonance — one unexpected element that forces a double-take
//   • Face 40-60% rule — extreme emotion, eyes at camera
//   • 3-5 word limit  — readable at 40×22 px mobile thumbnail
//   • Fake progress bar at 70% — FOMO trigger

import { Modality, HarmCategory, HarmBlockThreshold } from '@google/genai';
import { executeGeminiRequest, isQuotaError } from './geminiCore';
import { ScriptData } from '../types';

export type ThumbnailStyle = 1 | 2;

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — CLICKBAIT HOOK TEXT (Gemini-generated, script-aware)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates the thumbnail overlay text using Gemini.
 * Reads the actual script content so the hook is always specific to the video.
 */
export const generateThumbnailHook = async (
    title: string,
    tone: string = 'Viral',
    language: string = 'Portuguese',
    scriptSummary: string = '',
    script?: ScriptData,
    niche?: string,
    libraryItems?: import('../types').LibraryItem[],
): Promise<{ mainText: string; accentText: string; style: ThumbnailStyle }> => {

    // Build a compact script digest so Gemini has real context without blowing tokens
    const scriptDigest = buildScriptDigest(script, scriptSummary);
    const toneStyle = mapToneToStyle(tone);

    return executeGeminiRequest(async (ai) => {
        const prompt = `You are the world's best YouTube thumbnail copywriter. Your hooks get 15-25% CTR.

VIDEO TITLE: "${title}"
LANGUAGE: ${language}
TONE/NICHE: ${tone}${niche ? ` — ${niche}` : ''}
SCRIPT DIGEST (use this to write something SPECIFIC to the content):
${scriptDigest}

CLICKBAIT PSYCHOLOGY RULES (apply ALL):
1. CURIOSITY GAP — imply there is a secret or twist, NEVER reveal it
2. SHOCK/EMOTION — use power words that trigger strong emotion
3. SPECIFICITY — reference ONE concrete detail from the script, not generic words
4. 3-5 WORDS MAXIMUM — must be readable at 40×22 pixels on mobile
5. NO PUNCTUATION except ? or ! at the end
6. ALL CAPS
7. HONEST clickbait — the content must actually deliver on the promise

STYLE REFERENCE:
- Style 1 (Bold Boxes, energetic): "ELE PERDEU TUDO", "NINGUÉM ACREDITOU", "ISSO MUDA TUDO"
- Style 2 (Cinematic Glow, dark/mysterious): "A VERDADE PROIBIDA", "NINGUÉM SOBREVIVEU", "O SEGREDO FINAL"

OUTPUT FORMAT — exactly 3 lines, nothing else:
Line 1: MAIN TEXT (2-4 words, the primary hook)
Line 2: ACCENT TEXT (1-3 words, supports or contrasts the main hook)
Line 3: Style number — 1 or 2

Example output for a horror video about a haunted place:
ELA VOLTOU DO ALÉM
NINGUÉM ACREDITA
2`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: { temperature: 1.1 },
        });

        const lines = (response.text || '')
            .trim()
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean);

        const mainText = (lines[0] || title.split(' ').slice(0, 3).join(' '))
            .replace(/['"*_`]/g, '')
            .toUpperCase()
            .trim();
        const accentText = (lines[1] || '')
            .replace(/['"*_`]/g, '')
            .toUpperCase()
            .trim();
        const styleNum = parseInt(lines[2]?.trim() || String(toneStyle));
        const style: ThumbnailStyle = styleNum === 2 ? 2 : 1;

        return { mainText, accentText, style };
    }).catch(() => ({
        mainText: title.split(' ').slice(0, 3).join(' ').toUpperCase(),
        accentText: 'VOCÊ NÃO VAI ACREDITAR',
        style: toneStyle,
    }));
};

// ─────────────────────────────────────────────────────────────────────────────
// TIMEOUT HELPER — nenhuma chamada de thumbnail pode travar o pipeline
// ─────────────────────────────────────────────────────────────────────────────

/** Rejects if the wrapped promise takes longer than `ms`. */
const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
    Promise.race([
        p,
        new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label}_timeout`)), ms)),
    ]);

const PROMPT_TIMEOUT_MS = 25_000;
const PER_MODEL_TIMEOUT_MS = 35_000;
const RENDER_TOTAL_TIMEOUT_MS = 70_000;
const THUMBNAIL_TOTAL_TIMEOUT_MS = 100_000;

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2A — IMAGE PROMPT GENERATION (Gemini Flash, script-aware)
// ─────────────────────────────────────────────────────────────────────────────


/**
 * Uses Gemini to generate a rich, topic-specific image prompt.
 * The key difference vs the old approach: Gemini reads the actual script
 * and references concrete details (real locations, events, objects, people)
 * instead of producing a generic "dramatic cinematic" description.
 */
const buildImagePrompt = async (
    title: string,
    tone: string,
    script: ScriptData | undefined,
    scriptSummary: string,
    niche: string | undefined,
): Promise<string> => {

    const scriptDigest = buildScriptDigest(script, scriptSummary);
    const visualStyle = mapToneToVisualStyle(tone);

    return executeGeminiRequest(async (ai) => {
        const prompt = `You are an elite YouTube thumbnail art director. Your thumbnails generate 20%+ CTR.

VIDEO TITLE: "${title}"
TONE: ${tone}${niche ? ` | NICHE: ${niche}` : ''}
SCRIPT CONTENT (use concrete details from this):
${scriptDigest}

Create a YouTube thumbnail image generation prompt following these rules:

COMPOSITION RULES (200ms decision window):
1. ONE dominant human face covering 40-60% of the frame — extreme emotion matching the tone
   - Eyes must look DIRECTLY at the camera (breaks 4th wall, creates connection)
   - Expression must be: ${mapToneToExpression(tone)}
   - Face positioned in the RIGHT third of the image
2. BACKGROUND: a specific scene directly related to the video's actual topic
   - Use ONE concrete element from the script (a real place, object, event)
   - NOT generic "dramatic lighting" — something SPECIFIC to this content
3. COLOR PALETTE: ${mapToneToColors(tone)}
   - One dominant accent color that pops against the background
   - Extreme contrast between face and background
4. VISUAL DISSONANCE: include one unexpected, out-of-place detail that forces a double-take
5. ATMOSPHERE: ${visualStyle}

TECHNICAL SPECS:
- 1280×720 pixels, YouTube thumbnail format
- Ultra high quality, cinematic, 8K render
- NO text, NO logos, NO watermarks, NO UI elements
- Movie poster level composition

ANTI-PATTERNS (do NOT include):
- Generic stock photo aesthetics
- Low contrast or "harmonious" color schemes
- Neutral facial expressions
- Busy cluttered compositions
- Generic "person looking at camera" without context

Output ONLY the image generation prompt as a single paragraph. No explanation, no quotes.`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: { temperature: 1.0 },
        });

        return (response.text || '').trim();
    });
};

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2B — IMAGE GENERATION (Gemini image models)
// ─────────────────────────────────────────────────────────────────────────────

const IMAGE_MODELS = [
    'gemini-2.0-flash-preview-image-generation',
    'gemini-2.0-flash-exp',
    'gemini-2.0-flash',
];

const SAFETY_SETTINGS = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

const renderImageFromPrompt = async (prompt: string): Promise<string> => {
    return executeGeminiRequest(async (ai) => {
        const fullPrompt = `${prompt}. YouTube thumbnail 16:9 format, ultra high quality, photorealistic, no text, no watermarks.`;

        let lastError: any = null;

        for (const modelName of IMAGE_MODELS) {
            try {
                console.log(`[Thumbnail] 🖼️ Tentando modelo: ${modelName}`);
                const response = await ai.models.generateContent({
                    model: modelName,
                    contents: { parts: [{ text: fullPrompt }] },
                    config: {
                        responseModalities: [Modality.IMAGE, Modality.TEXT],
                        safetySettings: SAFETY_SETTINGS,
                    },
                });

                const base64 = response.candidates?.[0]?.content?.parts
                    ?.find((p: any) => p.inlineData)?.inlineData?.data;

                if (base64) {
                    console.log(`[Thumbnail] ✅ Imagem gerada com ${modelName}`);
                    return `data:image/jpeg;base64,${base64}`;
                }
            } catch (err: any) {
                if (isQuotaError(err)) throw err; // bubble up for key rotation
                const msg = (err.message || '').toLowerCase();
                if (msg.includes('not found') || msg.includes('404') || msg.includes('not supported')) {
                    console.warn(`[Thumbnail] Modelo ${modelName} indisponível. Tentando próximo...`);
                    lastError = err;
                    continue;
                }
                lastError = err;
                console.warn(`[Thumbnail] Erro em ${modelName}: ${err.message}. Tentando próximo...`);
            }
        }

        throw lastError || new Error('Nenhum modelo de imagem disponível');
    });
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: generateThumbnail — orchestrates both steps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a topic-specific, clickbait-optimized thumbnail image using Gemini.
 *
 * Flow:
 *   1. Gemini Flash reads the script → generates a rich, specific image prompt
 *   2. Gemini image model renders the prompt
 *   3. If both fail (non-quota), canvas fallback fires
 */
export const generateThumbnail = async (
    topic: string,
    tone: string = 'Cinematic',
    scriptSummary: string = '',
    script?: ScriptData,
    niche?: string,
    libraryItems?: import('../types').LibraryItem[],
): Promise<string> => {
    try {
        // Step A: Build a rich, script-aware image prompt via Gemini
        console.log('[Thumbnail] 📝 Gerando prompt de imagem com Gemini...');
        const imagePrompt = await buildImagePrompt(topic, tone, script, scriptSummary, niche);

        if (!imagePrompt) throw new Error('Prompt de imagem vazio');
        console.log('[Thumbnail] Prompt gerado:', imagePrompt.substring(0, 120) + '...');

        // Step B: Render the image with Gemini image models
        return await renderImageFromPrompt(imagePrompt);

    } catch (err: any) {
        console.warn('[Thumbnail] ⚠️ Pipeline Gemini falhou, usando fallback canvas:', err.message);
        return generateCanvasThumbnail(topic, tone);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// CANVAS FALLBACK — no API calls, still looks professional
// ─────────────────────────────────────────────────────────────────────────────

const generateCanvasThumbnail = (topic: string, tone: string): string => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d')!;

    const t = tone.toLowerCase();
    const isDark = t.includes('dark') || t.includes('horror') || t.includes('suspens') || t.includes('mystery') || t.includes('crime');

    const palettes = isDark
        ? [
            { bg: '#050510', mid: '#0a0a30', glow1: '#6a00ff', glow2: '#ff0040', accent: '#00ffff' },
            { bg: '#0a0000', mid: '#1a0005', glow1: '#ff0000', glow2: '#ff6600', accent: '#ffcc00' },
            { bg: '#000a0a', mid: '#001a1a', glow1: '#00ff88', glow2: '#0088ff', accent: '#ff00ff' },
          ]
        : [
            { bg: '#0f0f1a', mid: '#1a1a3e', glow1: '#ff4444', glow2: '#ffaa00', accent: '#ffffff' },
            { bg: '#1a0a0a', mid: '#2a1515', glow1: '#ff6b35', glow2: '#ffd700', accent: '#ff4081' },
            { bg: '#0a0a1a', mid: '#15152a', glow1: '#4444ff', glow2: '#00ccff', accent: '#ff4444' },
          ];

    const colors = palettes[Math.floor(Math.random() * palettes.length)];

    // Background gradient
    const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    grad.addColorStop(0, colors.bg);
    grad.addColorStop(0.4, colors.mid);
    grad.addColorStop(1, colors.bg);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Central dramatic glow
    const cx = canvas.width * 0.5;
    const cy = canvas.height * 0.4;
    const radial = ctx.createRadialGradient(cx, cy, 0, cx, cy, 450);
    radial.addColorStop(0, colors.glow1 + '55');
    radial.addColorStop(0.3, colors.glow2 + '25');
    radial.addColorStop(1, 'transparent');
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Secondary accent glow
    const r2 = ctx.createRadialGradient(canvas.width * 0.8, canvas.height * 0.7, 0, canvas.width * 0.8, canvas.height * 0.7, 300);
    r2.addColorStop(0, colors.accent + '30');
    r2.addColorStop(1, 'transparent');
    ctx.fillStyle = r2;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // God rays
    ctx.save();
    ctx.globalAlpha = 0.08;
    for (let i = 0; i < 8; i++) {
        const angle = (Math.PI * 2 * i) / 8 + Math.random() * 0.3;
        const rayLen = 500 + Math.random() * 300;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(angle - 0.03) * rayLen, cy + Math.sin(angle - 0.03) * rayLen);
        ctx.lineTo(cx + Math.cos(angle + 0.03) * rayLen, cy + Math.sin(angle + 0.03) * rayLen);
        ctx.closePath();
        ctx.fillStyle = colors.glow1;
        ctx.fill();
    }
    ctx.restore();

    // Floating particles
    for (let i = 0; i < 30; i++) {
        const px = Math.random() * canvas.width;
        const py = Math.random() * canvas.height;
        const pr = 1 + Math.random() * 4;
        const particle = ctx.createRadialGradient(px, py, 0, px, py, pr);
        particle.addColorStop(0, colors.accent + '60');
        particle.addColorStop(1, 'transparent');
        ctx.fillStyle = particle;
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fill();
    }

    // Vignette
    const vignette = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 200, canvas.width / 2, canvas.height / 2, canvas.width * 0.7);
    vignette.addColorStop(0, 'transparent');
    vignette.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Text overlay
    const words = topic.toUpperCase().split(' ');
    const line1 = words.slice(0, Math.ceil(words.length / 2)).join(' ').substring(0, 22);
    const line2 = words.slice(Math.ceil(words.length / 2)).join(' ').substring(0, 22);

    // Text box background
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, canvas.height * 0.58, canvas.width * 0.7, canvas.height * 0.42);

    // Red accent bar
    ctx.fillStyle = '#ff3333';
    ctx.fillRect(0, canvas.height * 0.58, 10, canvas.height * 0.42);

    ctx.textAlign = 'left';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 10;

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(canvas.width / 11)}px Impact, Arial Black, sans-serif`;
    ctx.fillText(line1, 30, canvas.height * 0.72);

    ctx.fillStyle = '#ffdd00';
    ctx.font = `bold ${Math.round(canvas.width / 14)}px Impact, Arial Black, sans-serif`;
    ctx.fillText(line2, 30, canvas.height * 0.89);

    // Fake progress bar at 70% — FOMO trigger
    const barY = canvas.height - 5;
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(0, barY - 3, canvas.width, 6);
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, barY - 3, canvas.width * 0.70, 6);

    ctx.shadowBlur = 0;
    ctx.textAlign = 'left';

    return canvas.toDataURL('image/jpeg', 0.92);
};

// ─────────────────────────────────────────────────────────────────────────────
// SCENE IMAGE (used by video studio, not thumbnails — kept intact)
// ─────────────────────────────────────────────────────────────────────────────

/** Rejects if the wrapped promise takes longer than `ms`. */
const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
    Promise.race([
        p,
        new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label}_timeout`)), ms)),
    ]);

export const generateSceneImage = async (
    prompt: string,
    tone: string = 'Cinematic',
    format: string = 'Landscape 16:9',
    sessionId?: string,
    timeoutMs: number = 60_000,
): Promise<string> => {
    if (!prompt || !prompt.trim()) throw new Error('Prompt is empty');

    const t = tone.toLowerCase();
    let toneInstruction = 'cinematic lighting, high contrast';
    if (t.includes('child') || t.includes('kid'))   toneInstruction = 'pixar style 3d render, vibrant colors, whimsical';
    else if (t.includes('dark') || t.includes('horror')) toneInstruction = 'dark atmospheric, horror aesthetic, dramatic shadows';
    else if (t.includes('tech') || t.includes('science')) toneInstruction = 'futuristic, neon accents, sci-fi';

    let aspectRatio = '16:9';
    if (format.includes('9:16')) aspectRatio = '9:16';
    if (format.includes('1:1'))  aspectRatio = '1:1';

    return executeGeminiRequest(async (ai) => {
        const fullPrompt = `Create a visually stunning image of: ${prompt}. STYLE: ${toneInstruction}, 8k resolution, professional film still, aspect ratio ${aspectRatio}.`;

        let lastErr: any = null;
        const sceneModels = ['gemini-2.0-flash-exp', 'gemini-2.0-flash'];
        // Split the budget across the candidate models so one hang can't eat it all.
        const perModelTimeout = Math.max(15_000, Math.floor(timeoutMs / sceneModels.length));

        for (const modelName of sceneModels) {
            try {
                console.log(`[Scene] 🎨 Gerando imagem: ${modelName}`);
                const response: any = await withTimeout(
                    ai.models.generateContent({
                        model: modelName,
                        contents: { parts: [{ text: fullPrompt }] },
                        config: {
                            responseModalities: [Modality.IMAGE, Modality.TEXT],
                            safetySettings: SAFETY_SETTINGS,
                        },
                    }),
                    perModelTimeout,
                    'scene_image',
                );
                const base64 = response.candidates?.[0]?.content?.parts
                    ?.find((p: any) => p.inlineData)?.inlineData?.data;
                if (base64) return `data:image/jpeg;base64,${base64}`;
                throw new Error('No image data in response');
            } catch (err: any) {
                if (isQuotaError(err)) throw err;
                const msg = (err.message || '').toLowerCase();
                if (msg.includes('not found') || msg.includes('404')) { lastErr = err; continue; }
                lastErr = err;
                console.warn(`[Scene] Erro ${modelName}: ${err.message}`);
            }
        }
        throw lastErr || new Error('Nenhum modelo disponível');
    }, sessionId);
};


// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a compact script digest for Gemini context.
 * Uses: hook (segment 0), 3 section titles, core themes, and one key fact.
 * Keeps it under ~400 tokens to avoid wasting context.
 */
const buildScriptDigest = (script: ScriptData | undefined, fallbackSummary: string): string => {
    if (!script?.segments?.length) return fallbackSummary.substring(0, 400);

    const parts: string[] = [];

    // Opening hook — usually the most dramatic part
    const hook = script.segments[0]?.narratorText?.substring(0, 250);
    if (hook) parts.push(`OPENING HOOK: "${hook}"`);

    // Section titles — give a map of the content
    const titles = script.segments
        .map(s => s.sectionTitle)
        .filter(Boolean)
        .slice(0, 5)
        .join(' → ');
    if (titles) parts.push(`SECTIONS: ${titles}`);

    // Core themes
    if (script.coreThemes?.length) {
        parts.push(`CORE THEMES: ${script.coreThemes.slice(0, 3).join(', ')}`);
    }

    // Closing — often contains the twist or resolution
    const closing = script.segments[script.segments.length - 1]?.narratorText?.substring(0, 150);
    if (closing && script.segments.length > 1) parts.push(`CONCLUSION HINT: "${closing}"`);

    return parts.join('\n');
};

/** Maps narrative tone to ThumbnailStyle (1 = bold boxes, 2 = cinematic glow) */
const mapToneToStyle = (tone: string): ThumbnailStyle => {
    const t = tone.toLowerCase();
    const darkStyles = ['horror', 'dark', 'suspens', 'mystery', 'crime', 'serious', 'documentary', 'legend', 'folklore'];
    return darkStyles.some(k => t.includes(k)) ? 2 : 1;
};

/** Maps tone to visual style description */
const mapToneToVisualStyle = (tone: string): string => {
    const t = tone.toLowerCase();
    if (t.includes('horror') || t.includes('dark')) return 'dark horror aesthetic, volumetric fog, eerie red rim lighting, deep shadows';
    if (t.includes('suspens') || t.includes('mystery')) return 'noir mystery atmosphere, side-lit dramatic shadows, tension and intrigue';
    if (t.includes('crime')) return 'true crime noir, police investigation atmosphere, cold blue-yellow palette';
    if (t.includes('motivat') || t.includes('coach')) return 'epic golden hour sunrise, empowering atmosphere, god rays, triumph';
    if (t.includes('gaming') || t.includes('loud')) return 'RGB neon explosion, electric gaming energy, maximum saturation';
    if (t.includes('tech') || t.includes('science')) return 'futuristic holographic, neon circuit aesthetic, sci-fi blue glow';
    if (t.includes('child') || t.includes('kid')) return 'Pixar-style colorful 3D, whimsical magical, bright and joyful';
    if (t.includes('education') || t.includes('wendover')) return 'clean documentary explainer, bright professional, infographic aesthetic';
    if (t.includes('finance') || t.includes('business')) return 'corporate power aesthetic, trading floor drama, wealth contrast lighting';
    if (t.includes('calm') || t.includes('asmr') || t.includes('cozy')) return 'warm golden bokeh, candle-soft light, intimate and cozy';
    return 'cinematic dramatic lighting, high contrast, movie poster quality, ultra sharp';
};

/** Maps tone to facial expression for the image prompt */
const mapToneToExpression = (tone: string): string => {
    const t = tone.toLowerCase();
    if (t.includes('horror') || t.includes('dark')) return 'extreme terror — wide eyes with visible whites, mouth open in silent scream, pale sweating skin';
    if (t.includes('suspens') || t.includes('mystery')) return 'intense suspicious gaze — narrowed eyes, jaw clenched, half-face in dramatic shadow';
    if (t.includes('crime')) return 'shocked investigator — stern face, furrowed brow, holding a crucial piece of evidence';
    if (t.includes('motivat') || t.includes('coach')) return 'powerful determination — clenched jaw, piercing eyes looking directly at viewer, triumph';
    if (t.includes('gaming') || t.includes('loud')) return 'mind-blown reaction — hands on head, mouth wide open, total disbelief, RGB glow on face';
    if (t.includes('tech') || t.includes('science')) return 'amazed discovery — goggles pushed up, pointing at something, wide-eyed revelation';
    if (t.includes('education') || t.includes('explanat')) return 'surprised enlightenment — eyebrows raised, mouth slightly open in amazement, lightbulb moment';
    if (t.includes('finance') || t.includes('business')) return 'shocked disbelief at numbers — jaw dropped, eyes wide, pointing at an invisible screen';
    if (t.includes('child') || t.includes('kid')) return 'wide-eyed wonder — magical sparkles, cute expression, mouth open in amazement';
    if (t.includes('vlog') || t.includes('personal')) return 'genuine surprise — hand over mouth, authentic reaction, pointing at something off-camera';
    return 'extreme emotion matching the video content — eyes directly at camera, breaking the fourth wall';
};

/** Maps tone to color palette instructions */
const mapToneToColors = (tone: string): string => {
    const t = tone.toLowerCase();
    if (t.includes('horror') || t.includes('dark')) return 'pure blacks, blood reds (#FF0000), cold blues — high contrast';
    if (t.includes('suspens') || t.includes('mystery')) return 'dark navy, shadow blacks, gold accents (#FFD700)';
    if (t.includes('crime')) return 'noir blacks, evidence yellow (#FDD835), blood red, cold gray';
    if (t.includes('motivat') || t.includes('coach')) return 'warm oranges (#FF6B00), golden yellows (#FFD700), sunrise pinks';
    if (t.includes('gaming')) return 'neon green (#00FF41), electric purple (#AA00FF), dark blacks';
    if (t.includes('tech') || t.includes('science')) return 'tech blacks, circuit green (#00E676), LED blue (#00B0FF)';
    if (t.includes('child') || t.includes('kid')) return 'rainbow primaries, candy pinks, sky blues, sunshine yellows';
    if (t.includes('finance') || t.includes('business')) return 'corporate dark blue (#0D47A1), gold (#FFD700), power blacks';
    if (t.includes('calm') || t.includes('cozy') || t.includes('asmr')) return 'soft lavenders, warm beiges, gentle ambers';
    return 'dramatic contrasts — one bold accent color against deep blacks or whites';
};
