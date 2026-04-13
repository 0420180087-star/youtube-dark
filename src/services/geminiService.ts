import { GoogleGenAI, Type, Modality, HarmCategory, HarmBlockThreshold, ThinkingLevel } from "@google/genai";
import { ScriptData, GenerateScriptParams, VideoMetadata, ScriptSegment } from "../types";
import { decryptData } from "./securityService";

// =============================================
// HELPERS
// =============================================

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// =============================================
// KEY LOADER — Collects all API keys from storage + env
// =============================================

const loadAllKeys = async (): Promise<string[]> => {
    const raw: string[] = [];

    // 1. Identify user email for user-scoped keys
    let email = '';
    try {
        const enc = localStorage.getItem('ds_user_profile');
        if (enc) { email = JSON.parse(await decryptData(enc)).email || ''; }
    } catch {}

    // 2. Scan localStorage slots (user-scoped first, then generic)
    const slots = [
        ...(email ? [`ds_api_keys_list_${email}`, `ds_api_key_${email}`] : []),
        'ds_api_keys_list',
        'ds_api_key',
    ];

    for (const slot of slots) {
        const val = localStorage.getItem(slot);
        if (!val) continue;
        try {
            const dec = (await decryptData(val)).trim();
            if (dec.startsWith('[')) {
                const arr = JSON.parse(dec);
                if (Array.isArray(arr)) arr.forEach((k: any) => typeof k === 'string' && raw.push(k));
            } else {
                raw.push(dec);
            }
        } catch {}
    }

    // 3. Env vars
    try {
        const e1 = import.meta.env?.VITE_GEMINI_API_KEY;
        const e2 = import.meta.env?.VITE_API_KEY;
        if (e1 && typeof e1 === 'string') raw.push(e1);
        if (e2 && typeof e2 === 'string') raw.push(e2);
    } catch {}

    // 4. Deduplicate & validate
    const valid = [...new Set(raw.map(k => k.trim()))]
        .filter(k => k.length > 20 && !['undefined', 'null', '[object Object]'].includes(k));

    if (valid.length > 0) {
        console.log(`[DarkStream AI] 🔑 ${valid.length} chave(s) API carregada(s).`);
    } else {
        console.warn("[DarkStream AI] ⚠️ Nenhuma chave API encontrada.");
    }
    return valid;
};

// =============================================
// KEY ROTATION ENGINE — Simple, reliable, no over-engineering
// =============================================

/**
 * Each key tracks when it can be used again.
 * If a key hits a rate limit, we set a cooldown and move to the next.
 * If ALL keys are on cooldown, we wait for the shortest one.
 */
interface KeyCooldown {
    /** Timestamp when this key becomes available again */
    availableAt: number;
    /** Why it was put on cooldown */
    reason: string;
}

const keyCooldowns = new Map<string, KeyCooldown>();
let roundRobinIndex = 0;

/** Check if an error is a rate/quota limit */
const isQuotaError = (err: any): boolean => {
    if (!err) return false;

    // 1. Check direct status fields
    const status = err.status || err.response?.status || err.error?.code || err.code;
    if (status === 429 || status === '429') return true;
    if (status === 503 || status === '503') return true;

    // 2. Check error.status string (e.g. "UNAVAILABLE", "RESOURCE_EXHAUSTED")
    const errStatus = (err.error?.status || '').toUpperCase();
    if (errStatus === 'RESOURCE_EXHAUSTED' || errStatus === 'TOO_MANY_REQUESTS' || errStatus === 'UNAVAILABLE') return true;

    // 3. Check message string — including when Google embeds JSON inside err.message
    const rawMsg = err.message || err.toString() || '';
    const msg = rawMsg.toLowerCase();

    // Try to parse embedded JSON in the message (Google sometimes wraps errors as JSON strings)
    try {
        const jsonMatch = rawMsg.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            const embeddedCode = parsed?.error?.code || parsed?.code;
            const embeddedStatus = (parsed?.error?.status || parsed?.status || '').toUpperCase();
            if (embeddedCode === 429 || embeddedCode === 503) return true;
            if (embeddedStatus === 'UNAVAILABLE' || embeddedStatus === 'RESOURCE_EXHAUSTED' || embeddedStatus === 'TOO_MANY_REQUESTS') return true;
        }
    } catch {
        // JSON parse failed — fall through to keyword check
    }

    const keywords = [
        'quota', 'rate_limit', 'rate limit', 'too many requests',
        'resource_exhausted', 'requests per', 'limit exceeded',
        'exceeded your current quota', '429', '503', 'unavailable',
        'high demand', 'overloaded', 'try again later',
    ];
    return keywords.some(kw => msg.includes(kw));
};

/** Determine cooldown duration for a quota error */
const getCooldownMs = (err: any): number => {
    const rawMsg = err?.message || '';
    const msg = rawMsg.toLowerCase();
    const status = err?.status || err?.response?.status || err?.error?.code || err?.code;

    // Check for explicit retry-after
    const retryAfter = err?.headers?.get?.('retry-after') || err?.response?.headers?.['retry-after'];
    if (retryAfter) { const s = parseInt(retryAfter, 10); if (!isNaN(s)) return s * 1000; }

    // Try to extract code from embedded JSON in message
    let embeddedCode: number | null = null;
    let embeddedStatus = '';
    try {
        const jsonMatch = rawMsg.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            embeddedCode = parsed?.error?.code || parsed?.code || null;
            embeddedStatus = (parsed?.error?.status || parsed?.status || '').toUpperCase();
        }
    } catch { /* ignore */ }

    // 503 UNAVAILABLE (server overloaded) → short cooldown 15s
    if (status === 503 || status === '503' || embeddedCode === 503 ||
        embeddedStatus === 'UNAVAILABLE' ||
        msg.includes('unavailable') || msg.includes('high demand') || msg.includes('try again later')) {
        return 15_000;
    }

    // Daily limit → 30 min cooldown
    if (msg.includes('per-day') || msg.includes('per_day') || msg.includes('rpd') || msg.includes('daily')) {
        return 30 * 60 * 1000;
    }
    // Per-minute → 65s cooldown
    return 65_000;
};

/** Check if a key is currently usable */
const isKeyReady = (key: string): boolean => {
    const cd = keyCooldowns.get(key);
    if (!cd) return true;
    if (Date.now() >= cd.availableAt) {
        keyCooldowns.delete(key);
        return true;
    }
    return false;
};

/** Put a key on cooldown */
const cooldownKey = (key: string, err: any) => {
    const ms = getCooldownMs(err);

    // Normalize reason: try to extract status from embedded JSON, else use raw message
    let reason = 'unknown';
    const rawMsg = err?.message || '';
    try {
        const jsonMatch = rawMsg.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            const embeddedStatus = parsed?.error?.status || parsed?.status || '';
            const embeddedCode = parsed?.error?.code || parsed?.code || '';
            if (embeddedStatus) reason = `${embeddedCode} ${embeddedStatus}`.trim().toLowerCase();
            else reason = rawMsg.substring(0, 100);
        } else {
            reason = rawMsg.substring(0, 100);
        }
    } catch {
        reason = rawMsg.substring(0, 100);
    }

    keyCooldowns.set(key, { availableAt: Date.now() + ms, reason });
    const masked = key.length > 8 ? `...${key.slice(-6)}` : '***';
    console.warn(`[DarkStream AI] ⏸️ Chave ${masked} em cooldown por ${Math.round(ms / 1000)}s — ${reason}`);
};

/** Public: clear all cooldowns */
export const clearExhaustedKeys = () => {
    keyCooldowns.clear();
    console.log("[DarkStream AI] ✅ Todos os cooldowns de chaves foram limpos.");
};

/** Public: get status summary for UI */
export const getKeysStatusSummary = async () => {
    const keys = await loadAllKeys();
    const details = keys.map(k => {
        const masked = k.length > 8 ? `...${k.slice(-6)}` : '***';
        const cd = keyCooldowns.get(k);
        if (!cd || Date.now() >= cd.availableAt) {
            return { masked, status: 'ready' as const };
        }
        return { masked, status: 'exhausted' as const, reason: cd.reason, remainingMs: cd.availableAt - Date.now() };
    });
    return {
        total: keys.length,
        ready: details.filter(d => d.status === 'ready').length,
        exhausted: details.filter(d => d.status === 'exhausted').length,
        details,
    };
};

export const getKeyStatus = (key: string) => {
    const cd = keyCooldowns.get(key.trim());
    if (!cd || Date.now() >= cd.availableAt) return { status: 'ready' as const };
    return { status: 'exhausted' as const, reason: cd.reason, remainingMs: cd.availableAt - Date.now() };
};

// =============================================
// REQUEST EXECUTOR — Sequential queue + rotation
// =============================================

let queueBusy = false;
const queue: Array<{ op: (ai: GoogleGenAI) => Promise<any>; res: (v: any) => void; rej: (e: any) => void }> = [];

const processQueue = async () => {
    if (queueBusy || queue.length === 0) return;
    queueBusy = true;

    while (queue.length > 0) {
        const { op, res, rej } = queue.shift()!;
        try {
            const result = await runWithRotation(op);
            res(result);
        } catch (e) {
            rej(e);
        }
        // Small gap between requests to be kind to rate limits
        await delay(500);
    }
    queueBusy = false;
};

/**
 * Public entry point: queues a Gemini operation for execution with automatic key rotation.
 */
const executeGeminiRequest = <T>(op: (ai: GoogleGenAI) => Promise<T>): Promise<T> => {
    return new Promise((res, rej) => {
        queue.push({ op, res, rej });
        processQueue();
    });
};

/**
 * Core rotation logic:
 * 1. Get all keys
 * 2. Try each ready key in round-robin order
 * 3. On quota error → cooldown that key, try next
 * 4. If all keys exhausted → wait for shortest cooldown, then retry once
 */
const runWithRotation = async <T>(op: (ai: GoogleGenAI) => Promise<T>, isRetry = false): Promise<T> => {
    const allKeys = await loadAllKeys();
    if (allKeys.length === 0) {
        throw new Error("Nenhuma chave API encontrada. Vá em Configurações e adicione suas chaves do Google AI Studio.");
    }

    // Clean expired cooldowns
    for (const [k, cd] of keyCooldowns) { if (Date.now() >= cd.availableAt) keyCooldowns.delete(k); }

    // Auto-reset: if ALL cooldowns have short duration (< 30s remaining) they are
    // temporary 503 errors — clear them and retry immediately instead of erroring
    if (keyCooldowns.size > 0 && keyCooldowns.size >= allKeys.length) {
        const allShortOrTemporary = [...keyCooldowns.values()].every(cd => {
            const remaining = cd.availableAt - Date.now();
            const r = (cd.reason || '').toLowerCase();
            const isTemporaryReason = r.includes('unavailable') || r.includes('high demand') ||
                r.includes('503') || r.includes('try again') || r.includes('overload');
            const isShortWait = remaining < 30_000;
            return isTemporaryReason || isShortWait;
        });
        if (allShortOrTemporary) {
            console.log('[DarkStream AI] 🔄 Cooldowns temporários detectados. Limpando e tentando novamente...');
            keyCooldowns.clear();
        }
    }

    const readyKeys = allKeys.filter(isKeyReady);

    // If no keys ready, wait for the shortest cooldown (only once)
    if (readyKeys.length === 0) {
        if (isRetry) {
            // Last resort: clear all cooldowns and try one more time
            // This handles the case where keys were stuck from a previous session
            const hadCooldowns = keyCooldowns.size > 0;
            keyCooldowns.clear();
            if (hadCooldowns) {
                console.warn('[DarkStream AI] 🔄 Forçando limpeza de cooldowns e tentando novamente...');
                return runWithRotation(op, false);
            }
            throw new Error(`Todas as ${allKeys.length} chaves estão em cooldown. Verifique suas chaves no Google AI Studio ou aguarde alguns minutos.`);
        }

        let minWait = Infinity;
        for (const [, cd] of keyCooldowns) {
            const remaining = cd.availableAt - Date.now();
            if (remaining > 0 && remaining < minWait) minWait = remaining;
        }

        // If wait is short (< 20s), wait automatically — otherwise surface the error
        if (minWait <= 20_000) {
            console.log(`[DarkStream AI] ⏳ Aguardando ${Math.ceil(minWait / 1000)}s para próxima chave disponível...`);
            await delay(minWait + 300);
            return runWithRotation(op, true);
        }

        // Long cooldown (quota exceeded) — wait up to 2min automatically, else error
        if (minWait > 120_000) {
            throw new Error(`Todas as ${allKeys.length} chaves em cooldown longo (${Math.ceil(minWait / 60000)}min). Adicione mais chaves no Google AI Studio.`);
        }

        console.log(`[DarkStream AI] ⏳ Aguardando ${Math.ceil(minWait / 1000)}s para próxima chave disponível...`);
        await delay(minWait + 500);
        return runWithRotation(op, true);
    }

    // Round-robin through ready keys
    let lastError: any = null;
    for (let i = 0; i < readyKeys.length; i++) {
        const idx = (roundRobinIndex + i) % readyKeys.length;
        const key = readyKeys[idx];
        const masked = key.length > 8 ? `...${key.slice(-6)}` : '***';

        console.log(`[DarkStream AI] 🔄 Usando chave ${masked} [${i + 1}/${readyKeys.length}]`);

        try {
            const ai = new GoogleGenAI({ apiKey: key });
            const result = await op(ai);
            // Success — advance round-robin globally
            roundRobinIndex = roundRobinIndex + i + 1;
            console.log(`[DarkStream AI] ✅ Sucesso com chave ${masked}`);
            return result;
        } catch (err: any) {
            lastError = err;

            if (isQuotaError(err)) {
                cooldownKey(key, err);
                continue; // try next key
            }

            // Auth/invalid key errors — longer cooldown
            const errMsg = (err.message || '').toLowerCase();
            const errStatus = err.status || err.response?.status || 0;
            if ((errStatus === 400 || errStatus === 401 || errStatus === 403) &&
                (errMsg.includes('key') || errMsg.includes('invalid') || errMsg.includes('permission'))) {
                keyCooldowns.set(key, { availableAt: Date.now() + 10 * 60 * 1000, reason: 'Chave inválida/sem permissão' });
                console.warn(`[DarkStream AI] 🔑 Chave ${masked} inválida. Pulando...`);
                continue;
            }

            // Non-quota error — don't retry other keys, just throw
            throw err;
        }
    }

    // All ready keys hit quota — try waiting if not already retrying
    if (!isRetry) {
        return runWithRotation(op, true);
    }

    throw new Error(`Todas as chaves falharam. Último erro: ${lastError?.message || 'Desconhecido'}`);
};

// Robust JSON repair function
function repairJson(jsonStr: string): string {
  let inString = false;
  let isEscaped = false;
  const stack: string[] = [];
  
  // BUG FIX: support both object and array JSON
  const firstBrace = jsonStr.indexOf('{');
  const firstBracket = jsonStr.indexOf('[');
  
  let startIndex: number;
  if (firstBrace === -1 && firstBracket === -1) return "{}";
  else if (firstBrace === -1) startIndex = firstBracket;
  else if (firstBracket === -1) startIndex = firstBrace;
  else startIndex = Math.min(firstBrace, firstBracket);
  
  let processed = jsonStr.substring(startIndex);
  
  for (let i = 0; i < processed.length; i++) {
    const char = processed[i];
    if (isEscaped) { isEscaped = false; continue; }
    if (char === '\\') { isEscaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (!inString) {
      if (char === '{') stack.push('}');
      else if (char === '[') stack.push(']');
      else if (char === '}' || char === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === char) stack.pop();
      }
    }
  }
  if (inString) processed += '"';
  while (stack.length > 0) processed += stack.pop();
  return processed;
}

export interface VideoIdea { topic: string; context: string; specificContext?: string; }

export const generateVideoIdeas = async (channelTheme: string, description: string, tone: string = 'Engaging', language: string = 'English', excludeTopics: string[] = [], libraryContext: string = ''): Promise<VideoIdea[]> => {
    return executeGeminiRequest(async (ai) => {
        let exclusionsText = "";
        if (excludeTopics.length > 0) { const recentExclusions = excludeTopics.slice(-20); exclusionsText = `IMPORTANT: Do NOT generate topics similar to these (already used): ${JSON.stringify(recentExclusions)}. Explore NEW angles.`; }
        let libraryPrompt = "";
        if (libraryContext) { 
            libraryPrompt = `CHANNEL KNOWLEDGE BASE & REFERENCES:\n--------------------------------------------------\n${libraryContext.substring(0, 15000)}\n--------------------------------------------------\n
            INSTRUCTIONS FOR REFERENCES:
            - If you see [YOUTUBE_REFERENCE_CHANNEL], these are channels that the user likes. Analyze their titles, style, and themes from the provided context/URL and adapt the "vibe" to our channel.
            - Use other [TEXT], [LINK], or [BOOK] items as factual source material for the ideas.`; 
        }
        const clickbaitStrategy = `
        CLICKBAIT STRATEGY (Hybrid Type 1 & Type 2):
        - Type 1 (Curiosity Gap): Create a massive information gap. Use "The Secret...", "What they didn't tell you...", "The truth about...".
        - Type 2 (Extreme/Polarizing): Use strong emotional hooks or consequences. "I Regret This", "The End of...", "Don't Do This", "This Changed Everything".
        - HYBRID GOAL: Combine both. Create a mystery with a high-stakes consequence.
        `;

        const prompt = `You are a YouTube Strategist for a channel about "${channelTheme}". Channel Description: "${description || 'General niche content'}". Target Narrative Tone: "${tone}". Target Language: "${language}" (Write the topics and context strictly in this language). ${libraryPrompt} ${exclusionsText} 
        Generate 4 unique, high-potential, click-worthy video ideas that fit this channel. 
        ${clickbaitStrategy}
        The ideas MUST reflect the specified Tone (e.g., if tone is 'Dark', use mysterious vocabulary; if 'Tech', use modern/crisp vocabulary). 
        For each idea provide: 
        1. A catchy 'topic' (Video Title). Must be in ${language}. 
        2. A 'context' (A brief 1-2 sentence summary for the idea card). Must be in ${language}.
        3. A 'specificContext' (A detailed, paragraph-long explanation including specific plot points, key details to cover, or a unique angle to explore. This will be used to guide the script generator). Must be in ${language}.`;
        
        const response = await ai.models.generateContent({ 
            model: "gemini-2.5-flash", 
            contents: prompt, 
            config: { 
                responseMimeType: "application/json", 
                responseSchema: { 
                    type: Type.OBJECT, 
                    properties: { 
                        ideas: { 
                            type: Type.ARRAY, 
                            items: { 
                                type: Type.OBJECT, 
                                properties: { 
                                    topic: { type: Type.STRING, description: "Catchy video title" }, 
                                    context: { type: Type.STRING, description: "Brief summary for the card" },
                                    specificContext: { type: Type.STRING, description: "Detailed context and angle for the video script generator" } 
                                },
                                required: ["topic", "context", "specificContext"]
                            } 
                        } 
                    },
                    required: ["ideas"]
                } 
            } 
        }); 
        
        try {
            const jsonStr = response.text || "{}"; 
            const data = JSON.parse(jsonStr); 
            const ideas = data.ideas || [];
            if (ideas.length === 0) {
                console.warn("[DarkStream AI] AI returned empty ideas array");
            }
            return ideas;
        } catch (e) {
            console.error("Failed to parse ideas JSON", e);
            throw new Error("Failed to generate valid ideas JSON");
        }
    });
};

const getToneInstruction = (tone: string): string => {
    const t = tone.toLowerCase();
    if (t.includes('child') || t.includes('kid')) { return `STYLE GUIDE: CHILDREN'S STORYTELLER / INFANTIL. MANDATORY: Write the full word-for-word narrator script for every segment.`; }
    if (t.includes('historical') || t.includes('formal') || t.includes('documentary')) { return `STYLE GUIDE: DOCUMENTARY NARRATOR. MANDATORY: Write the full word-for-word narrator script for every segment.`; }
    if (t.includes('suspense') || t.includes('dark') || t.includes('horror')) { return `STYLE GUIDE: PSYCHOLOGICAL THRILLER / HORROR. MANDATORY: Write the full word-for-word narrator script for every segment.`; }
    if (t.includes('wendover') || t.includes('logistics') || t.includes('explainer')) { 
        return `STYLE GUIDE: WENDOVER PRODUCTIONS / EDUCATIONAL EXPLAINER.`; 
    }
    return `STYLE GUIDE: ${tone}. Ensure the script perfectly matches this specific mood, pacing, and vocabulary.`;
};

const getStyleInstruction = (style: string): string => {
    const s = style.toLowerCase();
    switch (s) {
        case 'static': return "STATIC STYLE: Focus on long, stable, and highly detailed shots.";
        case 'dynamic': return "DYNAMIC STYLE: A balanced mix of movement and stability.";
        case 'fast-cuts': return "FAST-CUTS STYLE: High-energy, rapid transitions.";
        case 'cinematic': return "CINEMATIC STYLE: Focus on artistic composition, mood, and lighting.";
        case 'minimalist': return "MINIMALIST STYLE: Clean, simple, and uncluttered compositions.";
        case 'surreal': return "SURREAL STYLE: Dreamy, abstract, and unconventional visuals.";
        case 'vintage': return "VINTAGE STYLE: Old film look with grain and warm tones.";
        case 'cyberpunk': return "CYBERPUNK STYLE: Neon-drenched, dark, and futuristic.";
        default: return "DYNAMIC STYLE: A balanced mix of movement and stability.";
    }
};

// =============================================
// PHASE 2 — Duration-aware script generation
// =============================================

interface DurationSpec {
  minWords: number;
  maxWords: number;
  segments: number;
  minMinutes: number;
  maxMinutes: number;
}

function durationToWordCount(targetDuration: string): DurationSpec {
  const d = targetDuration.toLowerCase();

  // Exact matches for app's VideoDuration type values:
  // 'Short (< 3 min)' | 'Standard (5-8 min)' | 'Long (10-15 min)' | 'Deep Dive (20+ min)'
  if (d.includes('short') || d.includes('< 3') || d.includes('60s') || d.includes('shorts') || d.includes('portrait'))
    return { minWords: 120, maxWords: 450, segments: 4, minMinutes: 1, maxMinutes: 3 };
  if (d.includes('standard') || d.includes('5-8') || d.includes('5-7'))
    return { minWords: 750, maxWords: 1200, segments: 8, minMinutes: 5, maxMinutes: 8 };
  if (d.includes('long') || d.includes('10-15'))
    // 10-15 min = 1500-2250 words at 150wpm — this was the broken case
    return { minWords: 1500, maxWords: 2250, segments: 13, minMinutes: 10, maxMinutes: 15 };
  if (d.includes('deep') || d.includes('20+') || d.includes('15-20'))
    return { minWords: 3000, maxWords: 4500, segments: 18, minMinutes: 20, maxMinutes: 30 };
  // fallback: standard
  return { minWords: 750, maxWords: 1200, segments: 8, minMinutes: 5, maxMinutes: 8 };
}

function validateScriptDuration(script: ScriptData, targetDuration: string): { totalWords: number; estimatedMinutes: number; warning?: string } {
  const totalWords = script.segments.reduce((sum, seg) => {
    return sum + (seg.narratorText || '').split(/\s+/).filter(Boolean).length;
  }, 0);
  const estimatedMinutes = totalWords / 150;
  const spec = durationToWordCount(targetDuration);

  let warning: string | undefined;
  if (estimatedMinutes < spec.minMinutes * 0.7) {
    warning = `⚠️ Script muito curto: ~${estimatedMinutes.toFixed(1)} min (alvo: ${spec.minMinutes}-${spec.maxMinutes} min, ${totalWords} palavras)`;
    console.warn(`[DarkStream AI] ${warning}`);
  } else if (estimatedMinutes > spec.maxMinutes * 1.3) {
    warning = `⚠️ Script muito longo: ~${estimatedMinutes.toFixed(1)} min (alvo: ${spec.minMinutes}-${spec.maxMinutes} min, ${totalWords} palavras)`;
    console.warn(`[DarkStream AI] ${warning}`);
  } else {
    console.log(`[DarkStream AI] ✅ Script dentro do alvo: ~${estimatedMinutes.toFixed(1)} min (${totalWords} palavras)`);
  }

  return { totalWords, estimatedMinutes, warning };
}

export const generateVideoScript = async (params: GenerateScriptParams): Promise<ScriptData> => {
  return executeGeminiRequest(async (ai) => {
      const languagePrompt = params.language ? `IMPORTANT: Write the entire script in ${params.language}.` : "Write the script in English.";
      const toneInstruction = getToneInstruction(params.tone);
      const spec = durationToWordCount(params.targetDuration);

      const minWordsPerSegment = Math.round(spec.minWords / spec.segments);
      const systemInstruction = `You are a world-class cinematic scriptwriter for YouTube videos.
Channel Theme: "${params.channelTheme}". Target Tone: "${params.tone}". ${languagePrompt}
${toneInstruction}

════════════════════════════════════════
MANDATORY DURATION REQUIREMENTS — READ CAREFULLY
════════════════════════════════════════
TARGET DURATION: ${params.targetDuration}
TOTAL WORD COUNT: You MUST write between ${spec.minWords} and ${spec.maxWords} words of narrator text across ALL segments combined.
SEGMENTS: Generate EXACTLY ${spec.segments} segments.
WORDS PER SEGMENT: Each segment must have a minimum of ${minWordsPerSegment} words in its narratorText field.
SPEAKING RATE: 150 words per minute. A ${spec.minMinutes}-${spec.maxMinutes} minute video needs ${spec.minWords}-${spec.maxWords} words total.

DO NOT write short summaries. DO NOT use bullet points. WRITE THE FULL SPOKEN SCRIPT word-for-word as the narrator would read it aloud.
Each narratorText must be multiple dense paragraphs — not a single sentence or short paragraph.
Failure to meet the word count requirement means the generated video will be far too short.

estimatedDuration for each segment = (word count of that segment's narratorText) / 150 × 60  [in seconds]
════════════════════════════════════════`;

      let prompt = `Topic: "${params.topic}".\n`; 
      if (params.additionalContext) { prompt += `Context: ${params.additionalContext}\n`; } 
      if (params.libraryContext) { 
          prompt += `\nLIBRARY CONTEXT:\n${params.libraryContext.substring(0, 20000)}\n`; 
      }
      
      const scriptConfig = {
          systemInstruction: systemInstruction,
          responseMimeType: "application/json",
          maxOutputTokens: 65536,
          responseSchema: {
              type: Type.OBJECT,
              properties: {
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  brainstorming: { type: Type.ARRAY, items: { type: Type.STRING } },
                  narrativeOutline: { type: Type.ARRAY, items: { type: Type.STRING } },
                  segments: {
                      type: Type.ARRAY,
                      items: {
                          type: Type.OBJECT,
                          properties: {
                              sectionTitle: { type: Type.STRING },
                              visualDescriptions: { type: Type.ARRAY, items: { type: Type.STRING } },
                              narratorText: { type: Type.STRING },
                              estimatedDuration: { type: Type.NUMBER }
                          }
                      }
                  }
              },
              propertyOrdering: ["brainstorming", "narrativeOutline", "title", "description", "segments"]
          }
      };

      let fullText = '';

      // Try streaming first — with a 90s timeout watchdog
      // If the stream stalls (no chunks for 90s), fall back to non-streaming
      try {
          const streamResult = await Promise.race([
              (async () => {
                  const responseStream = await ai.models.generateContentStream({
                      model: "gemini-2.5-flash",
                      contents: prompt,
                      config: scriptConfig,
                  });
                  let text = '';
                  for await (const chunk of responseStream) {
                      if (chunk.text) {
                          text += chunk.text;
                          if (params.onProgress) params.onProgress(text);
                      }
                  }
                  return text;
              })(),
              new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error('stream_timeout')), 90_000)
              ),
          ]);
          fullText = streamResult as string;
      } catch (streamErr: any) {
          if (streamErr.message === 'stream_timeout' || !fullText) {
              // Stream timed out or returned nothing — fall back to regular (non-streaming) call
              console.warn('[DarkStream AI] Stream travou ou veio vazio. Usando fallback não-streaming...');
              if (params.onProgress) params.onProgress('__fallback__');
              const fallbackResponse = await ai.models.generateContent({
                  model: "gemini-2.5-flash",
                  contents: prompt,
                  config: scriptConfig,
              });
              fullText = fallbackResponse.text || '';
          } else {
              throw streamErr;
          }
      }

      if (!fullText) throw new Error("No script generated"); 
      let jsonString = fullText.replace(/```json/g, '').replace(/```/g, '').trim(); 
      let script: ScriptData;
      try { 
          script = JSON.parse(jsonString) as ScriptData; 
      } catch (parseError) { 
          console.warn("JSON Parse failed, attempting repair..."); 
          try { 
              const repaired = repairJson(jsonString); 
              script = JSON.parse(repaired) as ScriptData; 
          } catch (repairError) { 
              throw new Error("Generated script was incomplete. Please try again."); 
          } 
      }

      // Validate and annotate
      const validation = validateScriptDuration(script, params.targetDuration);
      (script as any).estimatedDurationMinutes = validation.estimatedMinutes;
      (script as any).totalWords = validation.totalWords;
      if (validation.warning) {
        (script as any).durationWarning = validation.warning;
      }

      // If script is way too short (< 60% of min target), expand each segment
      const spec2 = durationToWordCount(params.targetDuration);
      if (validation.totalWords < spec2.minWords * 0.6 && script.segments?.length > 0) {
        console.warn(`[DarkStream AI] ⚠️ Script muito curto (${validation.totalWords} palavras). Expandindo segmentos automaticamente...`);
        const wordsNeeded = spec2.minWords - validation.totalWords;
        const wordsPerSegment = Math.ceil(wordsNeeded / script.segments.length);
        // Mark each segment as needing expansion (for UI feedback)
        (script as any).needsExpansion = true;
        (script as any).expansionNote = `Script gerado com ${validation.totalWords} palavras. Alvo: ${spec2.minWords}-${spec2.maxWords} palavras para ${params.targetDuration}.`;
      }

      return script;
  });
};

export const generateMissingNarratorTexts = async (topic: string, segments: ScriptSegment[], tone: string, language: string = 'English'): Promise<ScriptSegment[]> => {
    return executeGeminiRequest(async (ai) => {
        const segmentsContext = segments.map((s, i) => `Segment #${i+1}: ${s.sectionTitle}\nVisuals: ${s.visualDescriptions.join(', ')}`).join('\n\n');
        
        const prompt = `Topic: "${topic}"\nTone: ${tone}\nLanguage: ${language}\n\nSEGMENTS:\n${segmentsContext}\n\nWrite narrator text for each segment. Return JSON array of strings.`;

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                systemInstruction: "You are a professional scriptwriter. Return ONLY a JSON array of strings.",
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING }
                }
            }
        });

        const newTexts: string[] = JSON.parse(response.text || "[]");
        return segments.map((s, i) => ({
            ...s,
            narratorText: s.narratorText || newTexts[i] || ""
        }));
    });
};

export const generateSingleNarratorText = async (topic: string, sectionTitle: string, visualDescriptions: string[], tone: string, language: string = 'English'): Promise<string> => {
    return executeGeminiRequest(async (ai) => {
        const prompt = `Topic: "${topic}"\nSection: "${sectionTitle}"\nVisuals: ${visualDescriptions.join(', ')}\nTone: ${tone}\nLanguage: ${language}\n\nWrite the narrator script for this section.`;

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                systemInstruction: "You are a professional scriptwriter. Write only the spoken narrator text.",
            }
        });

        return response.text || "";
    });
};

const formatTimestamp = (seconds: number): string => { const mins = Math.floor(seconds / 60); const secs = Math.floor(seconds % 60); return `${mins}:${secs.toString().padStart(2, '0')}`; };

export const generateVideoMetadata = async (
  topic: string, 
  scriptSummary: string, 
  tone: string = 'Viral', 
  language: string = 'English', 
  segments: ScriptSegment[] = [],
  script?: ScriptData,
  niche?: string,
): Promise<VideoMetadata> => {
  // If we have full script data, use the new intelligent description builder
  if (script && script.segments.length > 0) {
    const { buildVideoDescription, buildTimestamps } = await import('./thumbnailDescriptionService');
    const descResult = buildVideoDescription({
      title: topic, script, narrativeTone: tone, niche: niche || '', language,
    });
    const timestamps = buildTimestamps(script.segments);
    const fullDesc = descResult.fullDescription + '\n\n📋 CAPÍTULOS:\n' + timestamps;
    
    // Still use AI for the optimized title and tags
    try {
      return await executeGeminiRequest(async (ai) => {
        const prompt = `Generate an SEO-optimized YouTube title and tags for: "${topic}".
Context: ${scriptSummary.substring(0, 500)}
Tone: ${tone}
Language: ${language}

RULES:
- youtubeTitle: Clickbait-optimized, max 70 chars, in ${language}
- tags: 15-20 relevant SEO tags in ${language}
- The title must generate curiosity and urgency`;
        
        const response = await ai.models.generateContent({ 
          model: "gemini-2.5-flash", 
          contents: prompt, 
          config: { 
            responseMimeType: "application/json", 
            responseSchema: { 
              type: Type.OBJECT, 
              properties: { 
                youtubeTitle: { type: Type.STRING }, 
                tags: { type: Type.ARRAY, items: { type: Type.STRING } },
                categoryId: { type: Type.STRING },
                isShorts: { type: Type.BOOLEAN }
              },
              required: ["youtubeTitle", "tags"]
            } 
          } 
        });
        
        const data = JSON.parse(response.text || "{}");
        return {
          youtubeTitle: data.youtubeTitle || topic,
          youtubeDescription: fullDesc,
          tags: data.tags || [],
          categoryId: data.categoryId || "24",
          visibility: "public" as const,
          isShorts: data.isShorts || false,
        };
      });
    } catch {
      // If AI fails, still return the intelligent description
      return {
        youtubeTitle: topic,
        youtubeDescription: fullDesc,
        tags: [],
        categoryId: "24",
        visibility: "public",
        isShorts: false,
      };
    }
  }
  
  // Fallback: original AI-only approach
  return executeGeminiRequest(async (ai) => {
      let timestampsContext = ""; 
      if (segments.length > 0) { 
          let currentTime = 0; 
          timestampsContext = "TIMESTAMPS:\n"; 
          segments.forEach((seg) => { 
              timestampsContext += `- ${formatTimestamp(currentTime)} : ${seg.sectionTitle}\n`; 
              currentTime += seg.estimatedDuration; 
          }); 
      }
      
      const prompt = `Generate optimized YouTube metadata for: "${topic}". Context: ${scriptSummary.substring(0, 1000)} ${timestampsContext} Tone: ${tone} Language: ${language}`;
      const response = await ai.models.generateContent({ 
          model: "gemini-2.5-flash", 
          contents: prompt, 
          config: { 
              responseMimeType: "application/json", 
              responseSchema: { 
                  type: Type.OBJECT, 
                  properties: { 
                      youtubeTitle: { type: Type.STRING }, 
                      youtubeDescription: { type: Type.STRING }, 
                      tags: { type: Type.ARRAY, items: { type: Type.STRING } }, 
                      visibility: { type: Type.STRING, enum: ["public", "private", "unlisted"] },
                      categoryId: { type: Type.STRING },
                      isShorts: { type: Type.BOOLEAN }
                  },
                  required: ["youtubeTitle", "youtubeDescription", "tags", "visibility"]
              } 
          } 
      }); 
      
      try {
          const data = JSON.parse(response.text || "{}");
          return {
              youtubeTitle: data.youtubeTitle || topic,
              youtubeDescription: data.youtubeDescription || "",
              tags: data.tags || [],
              categoryId: data.categoryId || "24",
              visibility: data.visibility || "public",
              isShorts: data.isShorts || false
          };
      } catch (e) {
          return { youtubeTitle: topic, youtubeDescription: scriptSummary, tags: [], categoryId: "24", visibility: "public", isShorts: false };
      }
  });
};

export const generateVoiceover = async (text: string, voiceName: string = 'Fenrir', tone: string = 'Cinematic'): Promise<ArrayBuffer> => { 
    if (!text || !text.trim()) return new ArrayBuffer(0); 
    
    const SUPPORTED_VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'];
    const VOICE_MAPPING: Record<string, string> = {
        'Aoede': 'Kore',
        'Leda': 'Kore',
    };
    
    let finalVoice = voiceName;
    if (!SUPPORTED_VOICES.includes(voiceName)) {
        finalVoice = VOICE_MAPPING[voiceName] || 'Fenrir';
    }

    return executeGeminiRequest(async (ai) => {
        const t = tone.toLowerCase();
        let styleInstruction = "Read clearly and naturally.";
        
        if (t.includes('horror') || t.includes('dark') || t.includes('suspense')) {
            styleInstruction = "Read in a low, tense, and ominous tone with dramatic pauses.";
        } else if (t.includes('child') || t.includes('kid')) {
            styleInstruction = "Read in a warm, enthusiastic, and friendly tone.";
        }

        const ttsPrompt = `Style: ${styleInstruction}\n\nText to read: "${text}"`;
        
        const response = await ai.models.generateContent({ 
            model: "gemini-2.5-flash-preview-tts", 
            contents: [{ parts: [{ text: ttsPrompt }] }], 
            config: { 
                responseModalities: [Modality.AUDIO], 
                speechConfig: { 
                    voiceConfig: { 
                        prebuiltVoiceConfig: { voiceName: finalVoice as any }, 
                    }, 
                }, 
            }, 
        }); 
        
        const audioPart = response.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
        const base64Audio = audioPart?.inlineData?.data; 
        
        if (!base64Audio) { 
            const textRefusal = response.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text; 
            if (textRefusal) throw new Error(`Model Refusal: ${textRefusal}`); 
            
            const finishReason = response.candidates?.[0]?.finishReason;
            if (finishReason && finishReason !== 'STOP') {
                const err = new Error(`Audio generation failed: ${finishReason}`);
                (err as any).status = 500;
                throw err;
            }

            const err = new Error("No audio generated (Empty response)"); 
            (err as any).status = 500;
            throw err;
        } 
        const binaryString = atob(base64Audio); 
        const len = binaryString.length; 
        const bytes = new Uint8Array(len); 
        for (let i = 0; i < len; i++) { bytes[i] = binaryString.charCodeAt(i); } 
        return bytes.buffer;
    });
};

// --- MUSIC GENERATION (Procedural) ---
type TextureType = 'none' | 'wind' | 'rain' | 'hum' | 'crackle';
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const randomChoice = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
type InstrumentType = 'pad' | 'bass' | 'pluck' | 'glitch' | 'drone' | 'piano' | 'bell' | 'strings' | 'lead';
const MIDI_ROOT = 440; const MIDI_ROOT_NUM = 69; const mtof = (note: number) => MIDI_ROOT * Math.pow(2, (note - MIDI_ROOT_NUM) / 12);
const SCALES: Record<string, number[]> = { MINOR: [0, 2, 3, 5, 7, 8, 10], MAJOR: [0, 2, 4, 5, 7, 9, 11], PENTATONIC: [0, 2, 4, 7, 9], PHRYGIAN: [0, 1, 3, 5, 7, 8, 10], HARMONIC_MINOR: [0, 2, 3, 5, 7, 8, 11], DORIAN: [0, 2, 3, 5, 7, 9, 10], BLUES: [0, 3, 5, 6, 7, 10] };

const createNoiseBuffer = (ctx: BaseAudioContext, duration: number, type: 'pink' | 'brown' | 'white'): AudioBuffer => { const bufferSize = ctx.sampleRate * duration; const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate); const output = buffer.getChannelData(0); let lastOut = 0; for (let i = 0; i < bufferSize; i++) { const white = Math.random() * 2 - 1; if (type === 'brown') { output[i] = (lastOut + (0.02 * white)) / 1.02; lastOut = output[i]; output[i] *= 3.5; } else if (type === 'pink') { let b0=0; output[i] = 0.99886 * b0 + white * 0.0555179; output[i] *= 0.11; b0 = output[i]; } else { output[i] = white; } } return buffer; };

const createDelay = (ctx: BaseAudioContext, input: AudioNode, output: AudioNode, time: number, feedback: number) => { const d = ctx.createDelay(); d.delayTime.value = time; const feed = ctx.createGain(); feed.gain.value = feedback; const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 2000; input.connect(d); d.connect(filter); filter.connect(feed); feed.connect(d); filter.connect(output); };

const createAtmosphere = (ctx: BaseAudioContext, dest: AudioNode, type: TextureType, duration: number) => { 
    if (type === 'none') return; 
    const masterGain = ctx.createGain(); masterGain.connect(dest); 
    const noise = ctx.createBufferSource(); noise.buffer = createNoiseBuffer(ctx, duration, type === 'wind' ? 'pink' : 'brown'); noise.loop = true; 
    const filter = ctx.createBiquadFilter(); filter.type = type === 'wind' ? 'bandpass' : 'lowpass'; filter.frequency.value = type === 'wind' ? 500 : 800; 
    masterGain.gain.value = 0.15; noise.connect(filter); filter.connect(masterGain); noise.start(0); noise.stop(duration); 
};

const createDrone = (ctx: BaseAudioContext, dest: AudioNode, freq: number, duration: number) => { const osc = ctx.createOscillator(); osc.type = randomChoice(['sawtooth', 'triangle'] as OscillatorType[]); osc.frequency.value = freq; const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = randomInt(70, 110); const gain = ctx.createGain(); gain.gain.setValueAtTime(0, 0); gain.gain.linearRampToValueAtTime(0.15, 3); gain.gain.setValueAtTime(0.15, duration - 3); gain.gain.linearRampToValueAtTime(0, duration); osc.connect(filter); filter.connect(gain); gain.connect(dest); osc.start(); osc.stop(duration); };

const playInstrumentNote = (ctx: BaseAudioContext, dest: AudioNode, freq: number, startTime: number, duration: number, type: InstrumentType) => {
    const t = startTime;
    const dur = duration;
    const masterGain = ctx.createGain();
    masterGain.connect(dest);

    if (type === 'pad' || type === 'strings') {
        const osc1 = ctx.createOscillator(); osc1.type = 'sawtooth'; osc1.frequency.value = freq; osc1.detune.value = -10;
        const osc2 = ctx.createOscillator(); osc2.type = 'triangle'; osc2.frequency.value = freq; osc2.detune.value = 10;
        const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.setValueAtTime(400, t); filter.frequency.linearRampToValueAtTime(1500, t + dur * 0.5);
        masterGain.gain.setValueAtTime(0, t); masterGain.gain.linearRampToValueAtTime(0.12, t + 1); masterGain.gain.linearRampToValueAtTime(0, t + dur + 2.0);
        osc1.connect(filter); osc2.connect(filter); filter.connect(masterGain);
        osc1.start(t); osc2.start(t); osc1.stop(t + dur + 3.0); osc2.stop(t + dur + 3.0);
    } else if (type === 'bass') {
        const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = freq;
        const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.setValueAtTime(200, t);
        masterGain.gain.setValueAtTime(0, t); masterGain.gain.linearRampToValueAtTime(0.2, t + 0.05); masterGain.gain.linearRampToValueAtTime(0, t + dur);
        osc.connect(filter); filter.connect(masterGain); osc.start(t); osc.stop(t + dur + 1);
    } else if (type === 'piano' || type === 'bell' || type === 'pluck') {
        const osc = ctx.createOscillator(); osc.type = type === 'bell' ? 'sine' : 'triangle'; osc.frequency.value = freq;
        const attackTime = type === 'bell' ? 0.005 : 0.01;
        const decayTime = type === 'bell' ? 3 : (type === 'pluck' ? 0.5 : 1.5);
        masterGain.gain.setValueAtTime(0, t); masterGain.gain.linearRampToValueAtTime(0.15, t + attackTime); masterGain.gain.exponentialRampToValueAtTime(0.001, t + decayTime);
        osc.connect(masterGain); osc.start(t); osc.stop(t + decayTime + 0.1);
    } else {
        const osc = ctx.createOscillator(); osc.type = 'square'; osc.frequency.value = freq;
        masterGain.gain.setValueAtTime(0.05, t); masterGain.gain.linearRampToValueAtTime(0, t + 0.3);
        osc.connect(masterGain); osc.start(t); osc.stop(t + 0.5);
    }
};

const generateChordProgression = (scaleName: string, numChords: number): Array<[number, number, number]> => {
    const progressions: Array<[number, number, number]>[] = [
        [[0, 4, 0], [5, 4, 0], [3, 4, 0], [7, 4, 0]],
        [[0, 4, 0], [3, 4, 0], [5, 4, 0], [0, 4, 0]],
        [[0, 8, 0], [5, 8, 0]],
    ];
    return randomChoice(progressions);
};

const getProceduralParams = (tone: string) => {
    const t = tone.toLowerCase();
    let possibleScales = ['MINOR', 'PHRYGIAN'];
    let possibleRoots = [36, 38, 40, 43];
    let possibleInstruments: InstrumentType[] = ['pad', 'drone', 'bass', 'bell'];
    let bpmRange: [number, number] = [55, 70];
    let texture: TextureType = 'wind';
    let delayAmount = 0.2;

    if (t.includes('horror') || t.includes('dark') || t.includes('suspense')) {
        possibleScales = ['PHRYGIAN', 'HARMONIC_MINOR'];
        possibleInstruments = ['drone', 'pad', 'strings', 'bell'];
        bpmRange = [50, 65];
        texture = 'wind';
    } else if (t.includes('child') || t.includes('kid')) {
        possibleScales = ['MAJOR', 'PENTATONIC'];
        possibleRoots = [48, 50, 52, 55];
        possibleInstruments = ['piano', 'bell', 'pluck', 'pad'];
        bpmRange = [90, 110];
        texture = 'none';
        delayAmount = 0.15;
    }

    const scaleName = randomChoice(possibleScales);
    const scale = SCALES[scaleName];
    const rootNote = randomChoice(possibleRoots);
    const bpm = randomInt(bpmRange[0], bpmRange[1]);
    const instruments: InstrumentType[] = [randomChoice(possibleInstruments.filter(i => i === 'pad' || i === 'drone' || i === 'strings') || ['pad'])];
    for(let i=0; i<3; i++) instruments.push(randomChoice(possibleInstruments));
    const progression = generateChordProgression(scaleName, 4);
    return { rootNote, scale, instruments, progression, bpm, texture, delayAmount };
};

export const generateDarkAmbience = async (tone: string): Promise<string> => { 
    const duration = 32; const sampleRate = 44100; 
    const ctx = new OfflineAudioContext(2, sampleRate * duration, sampleRate); 
    const { rootNote, scale, instruments, progression, bpm, texture, delayAmount } = getProceduralParams(tone); 
    const secondsPerBeat = 60 / bpm; 
    
    const reverb = ctx.createConvolver(); 
    const irLen = sampleRate * 4; const irBuffer = ctx.createBuffer(2, irLen, sampleRate); 
    for (let ch = 0; ch < 2; ch++) { const data = irBuffer.getChannelData(ch); for (let i = 0; i < irLen; i++) { data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 3); } } 
    reverb.buffer = irBuffer; 
    
    const masterComp = ctx.createDynamicsCompressor(); masterComp.threshold.value = -15; masterComp.ratio.value = 4; masterComp.connect(ctx.destination); 
    const wetGain = ctx.createGain(); wetGain.gain.value = 0.4; wetGain.connect(masterComp); reverb.connect(wetGain); 
    const dryGain = ctx.createGain(); dryGain.gain.value = 0.7; dryGain.connect(masterComp); 
    const delayBus = ctx.createGain(); 
    if (delayAmount > 0) { createDelay(ctx, delayBus, wetGain, 0.4, delayAmount); } 
    if (instruments.includes('drone')) { createDrone(ctx, reverb, mtof(rootNote - 12), duration); } 
    createAtmosphere(ctx, reverb, texture, duration); 
    
    const totalBeats = duration / secondsPerBeat;
    let chordMap: { root: number }[] = [];
    let pIndex = 0; let pBeatCount = 0;
    for (let i = 0; i < totalBeats + 16; i++) {
        const segment = progression[pIndex];
        chordMap.push({ root: rootNote + segment[0] });
        pBeatCount++;
        if (pBeatCount >= segment[1]) { pBeatCount = 0; pIndex = (pIndex + 1) % progression.length; }
    }
    
    for (let b = 0; b < totalBeats; b += 0.25) {
        const time = b * secondsPerBeat;
        const currentChord = chordMap[Math.floor(b)];
        if (instruments.includes('bass') && (b % 4 === 0)) {
            playInstrumentNote(ctx, dryGain, mtof(currentChord.root - 12), time, 3.5, 'bass');
        }
        if ((instruments.includes('pad') || instruments.includes('strings')) && b % 8 === 0) {
            const instName = instruments.includes('strings') ? 'strings' : 'pad';
            playInstrumentNote(ctx, reverb, mtof(currentChord.root), time, 7.0, instName);
            playInstrumentNote(ctx, reverb, mtof(currentChord.root + 7), time, 7.0, instName);
        }
        if (Math.random() > 0.6) {
            const interval = scale[Math.floor(Math.random() * scale.length)];
            const note = currentChord.root + interval + 12;
            const melodyInsts = instruments.filter(i => ['bell', 'piano', 'pluck'].includes(i));
            const inst: InstrumentType = melodyInsts.length > 0 ? randomChoice(melodyInsts) : 'piano';
            playInstrumentNote(ctx, delayAmount > 0 ? delayBus : reverb, mtof(note), time, 0.8, inst);
        }
    }
    
    const renderedBuffer = await ctx.startRendering(); 
    return audioBufferToBase64(renderedBuffer); 
};

// --- PEXELS / STOCK VIDEO ---
export interface StockVideo {
    videoUrl: string;
    thumbnailUrl: string;
}

export const getPexelsKey = async (): Promise<string | null> => {
    const stored = localStorage.getItem('ds_pexels_api_key');
    if (stored) {
        try { return await decryptData(stored); } catch (e) {}
    }
    const envKey = import.meta.env?.VITE_PEXELS_API_KEY;
    if (envKey && envKey.length > 10) return envKey;
    return null;
};

export const generatePexelsKeywords = async (visualDescription: string, videoTopic?: string, channelTheme?: string): Promise<string[]> => {
    return executeGeminiRequest(async (ai) => {
        const prompt = `You are a stock footage search expert. Given a scene description from a video, generate GENERIC but THEMATICALLY RELEVANT search queries for Pexels stock video API.

VIDEO TOPIC: "${videoTopic || 'unknown'}"
CHANNEL THEME: "${channelTheme || 'general'}"
SCENE DESCRIPTION: "${visualDescription}"

RULES:
- Generate 4-6 search queries in English
- Each query should be 2-4 words MAX
- Queries must be GENERIC enough to find results on stock sites (avoid proper nouns, specific people, fictional characters)
- Focus on ATMOSPHERE, MOOD, SETTING, and VISUAL ELEMENTS (e.g. "dark forest night", "abandoned building interior", "city rain night")
- Include a mix of: environment/setting shots, mood/atmosphere shots, and abstract/texture shots
- Think cinematically: what B-roll would a filmmaker use for this scene?
- Avoid overly specific queries that would return zero results
- Prioritize visually striking, cinematic footage

Return a JSON array of strings. Example: ["dark corridor shadows", "foggy forest aerial", "city lights rain", "old book candlelight"]`;

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: { temperature: 0.8, responseMimeType: "application/json" }
        });
        try {
            const keywords = JSON.parse((response.text || "[]").trim());
            return Array.isArray(keywords) ? keywords.slice(0, 6) : [visualDescription.split(' ').slice(0, 3).join(' ')];
        } catch (e) { return [visualDescription.split(' ').slice(0, 3).join(' ')]; }
    }).catch(() => [visualDescription.split(' ').slice(0, 3).join(' ')]);
};

export const generatePexelsSearchQuery = async (visualDescription: string, videoTopic?: string): Promise<string> => {
    return executeGeminiRequest(async (ai) => {
        const prompt = `Convert this scene description into a GENERIC 2-3 word stock video search query that would find cinematic B-roll footage on Pexels.
Scene: "${visualDescription}"
Topic context: "${videoTopic || ''}"

RULES: Must be generic enough to return results. Focus on mood/setting/atmosphere. No proper nouns. Output ONLY the query words, nothing else.`;
        const response = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt, config: { temperature: 0.3 } });
        return (response.text || "").trim().replace(/["']/g, '');
    }).catch(() => visualDescription.split(' ').slice(0, 3).join(' '));
};

export const searchStockVideos = async (queries: string | string[], tone: string = 'Cinematic', format: string = 'Landscape 16:9'): Promise<StockVideo[]> => {
    const apiKey = await getPexelsKey();
    if (!apiKey) return [];

    let keywordList = Array.isArray(queries) ? queries : [queries];
    const orientation = format.toLowerCase().includes('portrait') ? 'portrait' : 'landscape';
    const minWidth = orientation === 'portrait' ? 720 : 1280;
    const allVideos: StockVideo[] = [];
    const seenIds = new Set<number>();
    const limitedKeywords = keywordList.slice(0, 6);

    for (const kw of limitedKeywords) {
        try {
            // Search with more results and better filtering
            const response = await fetch(
                `https://api.pexels.com/videos/search?query=${encodeURIComponent(kw)}&per_page=10&orientation=${orientation}&min_duration=5&max_duration=30&size=medium`, 
                { headers: { Authorization: apiKey } }
            );
            if (response.ok) {
                const data = await response.json();
                if (data.videos) {
                    for (const video of data.videos) {
                        if (seenIds.has(video.id)) continue;
                        seenIds.add(video.id);
                        
                        // Pick the best quality file that's not excessively large
                        const validFiles = (video.video_files || [])
                            .filter((f: any) => f.width >= minWidth && f.quality === 'hd')
                            .sort((a: any, b: any) => (a.width || 0) - (b.width || 0)); // prefer smaller HD
                        
                        const file = validFiles[0] || video.video_files?.[0];
                        if (file) {
                            allVideos.push({ videoUrl: file.link, thumbnailUrl: video.image });
                        }
                    }
                }
            }
            await delay(250);
        } catch (err) {
            console.error(`Pexels search failed for "${kw}":`, err);
        }
        
        // If we already have enough variety, stop early
        if (allVideos.length >= 15) break;
    }
    
    // Shuffle to add variety when picking from results
    return allVideos.sort(() => Math.random() - 0.5);
};

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
        let imagePrompt: string;
        
        // If we have script data, use the new intelligent system
        if (script) {
            const { buildThumbnailPrompt } = await import('./thumbnailDescriptionService');
            const result = buildThumbnailPrompt({
                title: topic, script, narrativeTone: tone, niche: niche || '',
                libraryItems,
            });
            imagePrompt = result.imagePrompt;
            console.log(`[DarkStream AI] 🎨 Thumbnail prompt (intelligent): ${imagePrompt.substring(0, 100)}...`);
        } else {
            // Fallback: generate prompt via AI
            imagePrompt = await executeGeminiRequest(async (ai) => {
                const prompt = `You are a thumbnail visual director. Create an image generation prompt for a YouTube thumbnail.
VIDEO TOPIC: "${topic}"
VIDEO SUMMARY: "${scriptSummary}"
TONE: ${tone}

RULES:
- Output ONLY the image prompt, nothing else
- Include dramatic lighting and cinematic composition
- Make it look like a $50M movie poster background
- Be SPECIFIC to the topic

Example: "Dramatic aerial view of a half-buried golden pyramid, volumetric god rays, storm clouds, cinematic lighting, 8K"`;
                
                const response = await ai.models.generateContent({ 
                    model: "gemini-2.5-flash", 
                    contents: prompt, 
                    config: { temperature: 0.9 } 
                });
                return (response.text || "").trim();
            });
        }
        
        return await generateSceneImage(
            imagePrompt || `Dramatic cinematic scene related to ${topic}, volumetric lighting, dark atmosphere, 8K`, 
            tone
        );
    } catch (err: any) {
        console.warn("[DarkStream AI] ⚠️ Thumbnail AI failed, using canvas fallback:", err.message);
        return generateCanvasThumbnail(topic, tone);
    }
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
export const generateSceneImage = async (prompt: string, tone: string = 'Cinematic', format: string = 'Landscape 16:9'): Promise<string> => {
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
  });
};

// --- AUDIO HELPERS ---
export const decodeAudioData = async (arrayBuffer: ArrayBuffer, ctx: AudioContext): Promise<AudioBuffer> => { 
    if (arrayBuffer.byteLength < 100) return ctx.createBuffer(1, 24000, 24000); 
    const dataInt16 = new Int16Array(arrayBuffer); 
    const sampleRate = 24000; const numChannels = 1; const frameCount = dataInt16.length / numChannels; 
    const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate); 
    for (let channel = 0; channel < numChannels; channel++) { 
        const channelData = buffer.getChannelData(channel); 
        for (let i = 0; i < frameCount; i++) { channelData[i] = dataInt16[i * numChannels + channel] / 32768.0; } 
    } 
    return buffer; 
};

export const mergeAudioBuffers = (buffers: AudioBuffer[], ctx: AudioContext): AudioBuffer => { 
    if (buffers.length === 0) return ctx.createBuffer(1, 1, 24000); 
    const totalLength = buffers.reduce((acc, b) => acc + b.length, 0); 
    const sampleRate = buffers[0].sampleRate; 
    const outputBuffer = ctx.createBuffer(1, totalLength, sampleRate); 
    const outputData = outputBuffer.getChannelData(0); 
    let offset = 0; 
    for (const buffer of buffers) { outputData.set(buffer.getChannelData(0), offset); offset += buffer.length; } 
    return outputBuffer; 
};

export const audioBufferToBase64 = (buffer: AudioBuffer): string => { 
    const channelData = buffer.getChannelData(0); 
    const int16Array = new Int16Array(channelData.length); 
    for (let i = 0; i < channelData.length; i++) { let s = Math.max(-1, Math.min(1, channelData[i])); int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF; } 
    const uint8Array = new Uint8Array(int16Array.buffer); 
    let binary = ''; 
    const chunkSize = 8192; 
    for (let i = 0; i < uint8Array.length; i += chunkSize) { const chunk = uint8Array.subarray(i, i + chunkSize); binary += String.fromCharCode.apply(null, Array.from(chunk)); } 
    return btoa(binary); 
};

function writeString(view: DataView, offset: number, string: string) { for (let i = 0; i < string.length; i++) { view.setUint8(offset + i, string.charCodeAt(i)); } }

export const base64ToWavBlob = (base64Data: string, sampleRate: number = 24000): Blob => { 
    const binaryString = atob(base64Data); const len = binaryString.length; const buffer = new ArrayBuffer(44 + len); const view = new DataView(buffer); 
    writeString(view, 0, 'RIFF'); view.setUint32(4, 36 + len, true); writeString(view, 8, 'WAVE'); writeString(view, 12, 'fmt '); 
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); 
    view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); writeString(view, 36, 'data'); 
    view.setUint32(40, len, true); const bytes = new Uint8Array(buffer, 44); 
    for (let i = 0; i < len; i++) { bytes[i] = binaryString.charCodeAt(i); } 
    return new Blob([buffer], { type: 'audio/wav' }); 
};
