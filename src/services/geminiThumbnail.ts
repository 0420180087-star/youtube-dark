// Clickbait thumbnail generation engine.
// Extracted from geminiService.ts (phase 5 refactor).

import { GoogleGenAI } from '@google/genai';
import { executeGeminiRequest } from './geminiCore';
import { ScriptData } from '../types';

// --- THUMBNAIL (Clickbait Engine) ---

/**
 * Clickbait thumbnail type:
 * - Type 1: Bold colored text boxes (MrBeast/viral style) — red/yellow boxes, tilted, high contrast
 * - Type 2: Cinematic glow text — clean, dramatic lighting, glowing outline text
 */
export type ThumbnailStyle = 1 | 2;

/**
 * Generates a clickbait hook phrase optimized for CTR.
 * Now uses the thumbnailDescriptionService for intelligent clickbait generation.
 */
export const generateThumbnailHook = async (
    title: string, 
    tone: string = 'Viral', 
    language: string = 'English',
    scriptSummary: string = '',
    script?: ScriptData,
    niche?: string,
    libraryItems?: import('../types').LibraryItem[],
): Promise<{ mainText: string; accentText: string; style: ThumbnailStyle }> => {
    // If we have script data, use the new intelligent system
    if (script) {
        const { buildThumbnailPrompt } = await import('./thumbnailDescriptionService');
        const result = buildThumbnailPrompt({
            title, script, narrativeTone: tone, niche: niche || '',
            language, libraryItems,
        });
        const words = result.clickbaitText.split(' ');
        const mid = Math.ceil(words.length / 2);
        const mainText = words.slice(0, mid).join(' ').toUpperCase();
        const accentText = words.slice(mid).join(' ').toUpperCase();
        const styleMap: Record<string, ThumbnailStyle> = {
            'viral': 1, 'neon': 1, 'warm': 1,
            'horror': 2, 'cinematic': 2, 'clean': 1,
        };
        return { mainText, accentText, style: styleMap[result.style] || 1 };
    }
    
    // Fallback: use AI generation for backwards compatibility
    return executeGeminiRequest(async (ai) => {
        const prompt = `You are a YouTube thumbnail text specialist. Your job is to create the MOST CLICKABLE thumbnail text possible.

VIDEO TITLE: "${title}"
VIDEO SUMMARY: "${scriptSummary}"
LANGUAGE: ${language}
TONE: ${tone}

CLICKBAIT PSYCHOLOGY RULES (apply ALL):
- CURIOSITY GAP: Leave something unanswered so viewers MUST click
- SHOCK/EMOTION: Use power words that trigger emotion
- NUMBERS: If relevant, use specific numbers
- URGENCY: Create FOMO
- INCOMPLETE INFO: Never give the full answer in the thumbnail

RULES:
- Output EXACTLY 2 lines. Line 1 = MAIN TEXT (2-4 words, biggest impact). Line 2 = ACCENT TEXT (1-3 words, supporting hook).
- Both lines in ${language}.
- NO quotes, NO punctuation except ? or !
- ALL CAPS
- The text must be DIRECTLY related to the video topic, not generic.

ALSO output on line 3: either "1" or "2" to pick the thumbnail style:
- Style 1: Bold colored boxes (for energetic/shocking topics)
- Style 2: Cinematic glow (for mysterious/dark/serious topics)

Example output:
ELES DESCOBRIRAM
O SEGREDO
1`;
        const response = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt, config: { temperature: 1.0 } });
        const lines = (response.text || "").trim().split('\n').filter(l => l.trim());
        
        const mainText = (lines[0] || title.split(' ').slice(0, 3).join(' ')).replace(/["']/g, '').toUpperCase().trim();
        const accentText = (lines[1] || '').replace(/["']/g, '').toUpperCase().trim();
        const styleNum = parseInt(lines[2]?.trim() || '1');
        const style: ThumbnailStyle = (styleNum === 2 ? 2 : 1);
        
        return { mainText, accentText, style };
    }).catch(() => ({
        mainText: title.split(' ').slice(0, 3).join(' ').toUpperCase(),
        accentText: '???',
        style: 1 as ThumbnailStyle
    }));
};

/**
 * Generates a dramatic, topic-related background image for thumbnails.
 * Now uses the thumbnailDescriptionService for intelligent prompt building.
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
        // Step 1: Build a rich, clickbait-specific image prompt using AI
        const imagePrompt = await executeGeminiRequest(async (ai) => {
            // Extract key narrative hook from script if available
            const hook = script?.segments?.[0]?.narratorText?.substring(0, 200) || scriptSummary.substring(0, 200);
            const toneKeywords: Record<string, string> = {
                dark: 'dramatic dark shadows, ominous atmosphere, high contrast',
                horror: 'terrifying, dark shadows, blood red lighting, fear',
                suspense: 'mysterious, silhouette, dramatic lighting, tension',
                child: 'bright colorful, cartoon style, friendly, vibrant',
                motivat: 'epic golden lighting, sunrise, power, triumph',
                tech: 'futuristic neon, holographic, digital, sleek',
                crime: 'noir, dark urban, gritty, black and white tones',
            };
            let toneStyle = 'dramatic cinematic lighting, high contrast, professional';
            for (const [key, val] of Object.entries(toneKeywords)) {
                if (tone.toLowerCase().includes(key)) { toneStyle = val; break; }
            }

            const prompt = `You are a YouTube thumbnail art director for viral channels with millions of views.

VIDEO TITLE: "${topic}"
NARRATIVE HOOK: "${hook}"
VISUAL TONE: ${toneStyle}

Create a SINGLE image generation prompt for a YouTube thumbnail that will get maximum clicks.

CLICKBAIT VISUAL RULES (ALL must apply):
1. ONE dramatic focal subject — a face with extreme emotion, OR a shocking object, OR a surreal scene
2. Extreme lighting — god rays, neon glow, fire, lightning, or deep shadows
3. Cinematic depth — foreground subject sharp, dramatic background
4. Colors that POP — deep blacks with one dominant accent color (red, gold, cyan, or orange)
5. Movie poster quality — looks like a $100M film still
6. NO text, NO logos, NO UI elements
7. SPECIFIC to the video topic — not generic

Output ONLY the image generation prompt, nothing else. No explanation, no quotes.
Example output: Extreme close-up of a young man's terrified face half-illuminated by red fire light, ancient crumbling temple in background with gold light rays, ultra sharp focus, cinematic 8K, dramatic shadows`;

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: { temperature: 1.0 },
            });
            return (response.text || '').trim();
        });

        // Step 2: Generate the actual image using Gemini image model
        return await generateThumbnailImage(
            imagePrompt || `Dramatic cinematic scene: ${topic}, god rays, extreme contrast, movie poster quality, 8K`,
            tone
        );
    } catch (err: any) {
        console.warn('[DarkStream AI] ⚠️ Thumbnail AI failed, using canvas fallback:', err.message);
        return generateCanvasThumbnail(topic, tone);
    }
};

/**
 * Generates thumbnail image exclusively via Gemini image generation models.
 * Uses gemini-2.0-flash-preview-image-generation (the correct model for image output).
 */
const generateThumbnailImage = async (prompt: string, tone: string): Promise<string> => {
    return executeGeminiRequest(async (ai) => {
        const modelsToTry = [
            'gemini-2.0-flash-preview-image-generation',
            'gemini-2.0-flash-exp',
            'gemini-2.0-flash',
        ];

        for (const modelName of modelsToTry) {
            try {
                console.log(`[DarkStream AI] 🖼️ Gerando thumbnail com: ${modelName}`);
                const response = await ai.models.generateContent({
                    model: modelName,
                    contents: { parts: [{ text: `${prompt}. YouTube thumbnail format 16:9, ultra high quality, no text.` }] },
                    config: {
                        responseModalities: [Modality.IMAGE, Modality.TEXT],
                        safetySettings: [
                            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                        ],
                    },
                });
                const base64Image = response.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData?.data;
                if (base64Image) {
                    console.log(`[DarkStream AI] ✅ Thumbnail gerada com ${modelName}`);
                    return `data:image/jpeg;base64,${base64Image}`;
                }
            } catch (err: any) {
                if (isQuotaError(err)) throw err; // bubble up for key rotation
                const msg = (err.message || '').toLowerCase();
                if (msg.includes('not found') || msg.includes('404') || msg.includes('not supported')) {
                    console.warn(`[DarkStream AI] Modelo ${modelName} indisponível para imagens. Tentando próximo...`);
                    continue;
                }
                throw err;
            }
        }
        throw new Error('Nenhum modelo de imagem disponível');
    });
};

/**
 * Canvas fallback: generates a dramatic gradient thumbnail with visual elements.
 * No API calls needed. Designed to still look professional.
 */
const generateCanvasThumbnail = (topic: string, tone: string): string => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d')!;
    
    const t = tone.toLowerCase();
    const isDark = t.includes('dark') || t.includes('horror') || t.includes('suspens') || t.includes('mystery');
    
    // Dramatic color palettes
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
    
    // Background
    const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    grad.addColorStop(0, colors.bg);
    grad.addColorStop(0.4, colors.mid);
    grad.addColorStop(1, colors.bg);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Dramatic central glow (focal point)
    const cx = canvas.width * (0.4 + Math.random() * 0.2);
    const cy = canvas.height * (0.3 + Math.random() * 0.2);
    const radial = ctx.createRadialGradient(cx, cy, 0, cx, cy, 450);
    radial.addColorStop(0, colors.glow1 + '50');
    radial.addColorStop(0.3, colors.glow2 + '25');
    radial.addColorStop(1, 'transparent');
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Secondary glow (visual tension)
    const radial2 = ctx.createRadialGradient(canvas.width * 0.8, canvas.height * 0.7, 0, canvas.width * 0.8, canvas.height * 0.7, 300);
    radial2.addColorStop(0, colors.accent + '30');
    radial2.addColorStop(1, 'transparent');
    ctx.fillStyle = radial2;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Light rays (god rays effect)
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
    
    // Floating particles (depth effect)
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
    
    // Vignette (focus attention to center)
    const vignette = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 200, canvas.width / 2, canvas.height / 2, canvas.width * 0.7);
    vignette.addColorStop(0, 'transparent');
    vignette.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Add clickbait text overlay on canvas thumbnail
    const words = topic.toUpperCase().split(' ');
    const line1 = words.slice(0, Math.ceil(words.length / 2)).join(' ').substring(0, 20);
    const line2 = words.slice(Math.ceil(words.length / 2)).join(' ').substring(0, 20);

    // Text box background
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, canvas.height * 0.6, canvas.width, canvas.height * 0.4);

    // Red accent bar
    ctx.fillStyle = '#ff3333';
    ctx.fillRect(0, canvas.height * 0.6, 8, canvas.height * 0.4);

    // Main text
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(canvas.width / 12)}px Arial, sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 8;
    ctx.textAlign = 'left';
    ctx.fillText(line1, 30, canvas.height * 0.72);

    // Accent text in yellow
    ctx.fillStyle = '#ffdd00';
    ctx.font = `bold ${Math.round(canvas.width / 14)}px Arial, sans-serif`;
    ctx.fillText(line2, 30, canvas.height * 0.88);

    ctx.shadowBlur = 0;
    ctx.textAlign = 'left';

    return canvas.toDataURL('image/jpeg', 0.92);
};

/**
 * FIX #8: Main image generation with robust quota detection.
 * - Retries with exponential backoff on 429
 * - Tries multiple models as fallback
 * - Properly re-throws quota errors so key rotation works
 * - Better error classification for UI feedback
 */
export const generateSceneImage = async (
    prompt: string,
    tone: string = 'Cinematic',
    format: string = 'Landscape 16:9',
    sessionId?: string,
): Promise<string> => {
  if (!prompt || !prompt.trim()) throw new Error("Prompt is empty");

  let toneInstruction = "cinematic lighting, high contrast";
  const t = tone.toLowerCase();
  if (t.includes('child') || t.includes('kid')) toneInstruction = "pixar style 3d render, vibrant colors, whimsical";
  else if (t.includes('dark') || t.includes('horror')) toneInstruction = "dark atmospheric, horror aesthetic, dramatic shadows";
  else if (t.includes('tech') || t.includes('science')) toneInstruction = "futuristic, neon accents, sci-fi";

  let aspectRatio = "16:9";
  if (format.includes('9:16')) aspectRatio = "9:16";
  if (format.includes('1:1')) aspectRatio = "1:1";

  const generateImageWithClient = async (ai: GoogleGenAI, promptText: string) => {
    const modelsToTry = ['gemini-2.0-flash-exp', 'gemini-2.0-flash'];
    let lastImgErr: any = null;

    for (const modelName of modelsToTry) {
        try {
            console.log(`[DarkStream AI] 🎨 Gerando imagem: ${modelName}`);
            const response = await ai.models.generateContent({
                model: modelName,
                contents: { parts: [{ text: promptText }] },
                config: { 
                    responseModalities: [Modality.IMAGE, Modality.TEXT],
                    safetySettings: [
                        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH }
                    ]
                }
            });
            return response;
        } catch (err: any) {
            lastImgErr = err;
            
            // CRITICAL FIX: Do NOT retry quota errors here - let them bubble up
            // to executeGeminiRequestInternal for proper key rotation
            if (isQuotaError(err)) {
                console.warn(`[DarkStream AI] ⚠️ Quota atingida em ${modelName}. Delegando rotação de chave...`);
                throw err;
            }
            
            const msg = (err.message || '').toLowerCase();
            if (msg.includes('not found') || msg.includes('404')) {
                console.warn(`[DarkStream AI] Modelo ${modelName} indisponível. Tentando fallback...`);
                continue;
            }
            
            console.warn(`[DarkStream AI] Erro: ${modelName}: ${err.message}. Tentando fallback...`);
            continue;
        }
    }
    throw lastImgErr;
  };

  return executeGeminiRequest(async (ai) => {
      const fullPrompt = `Create a visually stunning image of: ${prompt}. 
      STYLE: ${toneInstruction}, 8k resolution, professional film still.`;
      
      try {
          const response = await generateImageWithClient(ai, fullPrompt);
          const base64Image = response.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData?.data;
          if (base64Image) return `data:image/jpeg;base64,${base64Image}`;
          throw new Error("No image data in response");
      } catch (err: any) {
          // FIX: ALWAYS re-throw quota errors so key rotation works
          if (isQuotaError(err)) {
              throw err; 
          }

          console.warn("Primary image failed, trying abstract fallback...");
          const safePrompt = `Abstract cinematic background representing ${prompt}, ${tone} style, 4k wallpaper.`;
          const response = await generateImageWithClient(ai, safePrompt);
          const base64Image = response.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData?.data;
          if (base64Image) return `data:image/jpeg;base64,${base64Image}`;
          throw new Error("Model refused to generate image.");
      }
  }, sessionId);
};

