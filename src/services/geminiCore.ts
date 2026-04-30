// Core Gemini infrastructure: API key management, rotation engine,
// sequential request queue, and session-based cancellation.
// Extracted from geminiService.ts (phase 5 refactor).
//
// All other gemini* modules import { executeGeminiRequest } from here.

import { GoogleGenAI, Type, Modality, HarmCategory, HarmBlockThreshold, ThinkingLevel } from "@google/genai";
import { ScriptData, GenerateScriptParams, VideoMetadata, ScriptSegment } from "../types";
import { decryptData } from "./securityService";

// =============================================
// HELPERS
// =============================================

export const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

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
// REQUEST EXECUTOR — Sequential queue + key rotation
// =============================================
//
// CANCELLATION MODEL:
// Each caller can tag its operations with a `sessionId` string.
// Calling `cancelGeminiSession(sessionId)` immediately rejects all pending
// operations for that session that are still in the queue (not yet running).
// Operations that are already executing are not interrupted — they run to
// completion but their result is discarded (the promise is already rejected).
//
// Usage in components:
//   const SESSION = 'editor-audio-gen'; // unique per generation type
//   await executeGeminiRequest(op, SESSION);
//   // on unmount or cancel:
//   cancelGeminiSession(SESSION);

interface QueueEntry {
    op: (ai: GoogleGenAI) => Promise<any>;
    res: (v: any) => void;
    rej: (e: any) => void;
    sessionId?: string;
}

const CANCELLED_ERROR = new DOMException('Gemini request cancelled', 'AbortError');

let queueBusy = false;
const queue: QueueEntry[] = [];

/**
 * Cancels all pending (not yet executing) queue entries for a given sessionId.
 * Safe to call even if the session has no entries.
 */
export const cancelGeminiSession = (sessionId: string): void => {
    let removed = 0;
    for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].sessionId === sessionId) {
            queue[i].rej(CANCELLED_ERROR);
            queue.splice(i, 1);
            removed++;
        }
    }
    if (removed > 0) {
        console.debug(`[Gemini] Cancelled ${removed} queued request(s) for session "${sessionId}"`);
    }
};

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
 * @param op      The operation to execute, receiving a configured GoogleGenAI instance.
 * @param sessionId Optional tag — use `cancelGeminiSession(sessionId)` to cancel all
 *                  pending ops with this tag when the caller unmounts or navigates away.
 */
export const executeGeminiRequest = <T>(
    op: (ai: GoogleGenAI) => Promise<T>,
    sessionId?: string,
): Promise<T> => {
    return new Promise((res, rej) => {
        queue.push({ op, res, rej, sessionId });
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
            // Mod by allKeys.length (not readyKeys.length) so the index stays
            // bounded and cycles correctly across calls with varying ready-key counts.
            // Without the mod, roundRobinIndex grows unboundedly and eventually exceeds
            // Number.MAX_SAFE_INTEGER after millions of requests.
            roundRobinIndex = (roundRobinIndex + i + 1) % allKeys.length;
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

export const generateVideoIdeas = async (channelTheme: string, description: string, tone: string = 'Engaging', language: string = 'English', excludeTopics: string[] = [], libraryContext: string = '', freshAngle: string = ''): Promise<VideoIdea[]> => {
    return executeGeminiRequest(async (ai) => {
        let exclusionsText = "";
        if (excludeTopics.length > 0) {
            const recentExclusions = excludeTopics.slice(-25);
            exclusionsText = `ALREADY COVERED (avoid repeating these exact topics): ${JSON.stringify(recentExclusions)}. Explore completely different angles and subjects.`;
        }
        const freshAngleText = freshAngle
            ? `CREATIVE DIRECTION FOR THIS BATCH: Focus your ideas around the angle of "${freshAngle}". This will help generate fresh perspectives not covered before.`
            : '';
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

        const prompt = `You are a YouTube Strategist for a channel about "${channelTheme}". Channel Description: "${description || 'General niche content'}". Target Narrative Tone: "${tone}". Target Language: "${language}" (Write the topics and context strictly in this language). ${libraryPrompt} ${exclusionsText} ${freshAngleText}
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
      const languagePrompt = params.language
        ? `CRITICAL: Write the ENTIRE script exclusively in ${params.language}. Every word of narratorText must be in ${params.language}.`
        : "Write the script in English.";
      const toneInstruction = getToneInstruction(params.tone);
      const spec = durationToWordCount(params.targetDuration);
      const minWordsPerSegment = Math.round(spec.minWords / spec.segments);

      // For longer videos skip responseSchema — it truncates long narratorText fields
      const isLongVideo = spec.minWords >= 750;

      const systemInstruction = `You are a world-class YouTube scriptwriter. Write complete, engaging, word-for-word narrator scripts.
Channel Theme: "${params.channelTheme}". Target Tone: "${params.tone}".
${languagePrompt}
${toneInstruction}

TARGET: ${params.targetDuration}
Total words needed: ${spec.minWords}–${spec.maxWords} words across ALL segments
Number of segments: EXACTLY ${spec.segments}
Words per segment: minimum ${minWordsPerSegment} words each
Speaking rate: 150 words/minute

RULES for narratorText (MOST IMPORTANT):
- Write the COMPLETE spoken script word for word
- Each segment: ${minWordsPerSegment}–${Math.round(spec.maxWords / spec.segments)} words of dense narrative
- Multiple paragraphs — NO bullet points, NO summaries
- Full storytelling sentences like a documentary voiceover
- estimatedDuration per segment = (word count / 150) * 60 seconds

OUTPUT: Valid JSON only with fields: title, description, brainstorming[], narrativeOutline[], segments[]
Each segment: sectionTitle, visualDescriptions[], narratorText, estimatedDuration`;

      let prompt = `Topic: "${params.topic}".\n`;
      if (params.additionalContext) { prompt += `Context: ${params.additionalContext}\n`; }
      if (params.libraryContext) {
          prompt += `\nLIBRARY CONTEXT:\n${params.libraryContext.substring(0, 20000)}\n`;
      }
      prompt += `\nGenerate EXACTLY ${spec.segments} segments with at least ${minWordsPerSegment} words per narratorText. Total: ${spec.minWords}–${spec.maxWords} words.`;

      const scriptConfig: any = {
          systemInstruction,
          maxOutputTokens: 65536,
          responseMimeType: "application/json",
      };

      // Only use responseSchema for short videos — it truncates long narratorText
      if (!isLongVideo) {
          scriptConfig.responseSchema = {
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
          };
      }

      let fullText = '';
      const timeoutMs = isLongVideo ? 120_000 : 90_000;

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
                  setTimeout(() => reject(new Error('stream_timeout')), timeoutMs)
              ),
          ]);
          fullText = streamResult as string;
      } catch (streamErr: any) {
          if (streamErr.message === 'stream_timeout' || !fullText) {
              console.warn('[DarkStream AI] Stream travou. Usando fallback...');
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
      } catch {
          try {
              script = JSON.parse(repairJson(jsonString)) as ScriptData;
          } catch {
              throw new Error("Generated script was incomplete. Please try again.");
          }
      }

      // Recalculate estimatedDuration from real word count — never trust the model's guess
      if (script.segments?.length > 0) {
          script.segments = script.segments.map(seg => {
              const wc = (seg.narratorText || '').split(/\s+/).filter(w => w.length > 0).length;
              return { ...seg, estimatedDuration: Math.max(Math.round((wc / 150) * 60), 3) };
          });
      }

      const validation = validateScriptDuration(script, params.targetDuration);
      (script as any).estimatedDurationMinutes = validation.estimatedMinutes;
      (script as any).totalWords = validation.totalWords;
      if (validation.warning) {
          (script as any).durationWarning = validation.warning;
          console.warn('[DarkStream AI]', validation.warning);
      }

      // If script too short (<65% of target), expand with a second call
      const specCheck = durationToWordCount(params.targetDuration);
      if (validation.totalWords < specCheck.minWords * 0.65 && script.segments?.length > 0) {
          console.warn(`[DarkStream AI] Script curto (${validation.totalWords}/${specCheck.minWords}w). Expandindo...`);
          try {
              const expandPrompt = `This YouTube script is too short (${validation.totalWords} words, need ${specCheck.minWords}). Expand EACH segment's narratorText to reach the target. Keep the same JSON structure, sectionTitle, and visualDescriptions. Only expand narratorText with more detailed storytelling. ${languagePrompt}

SCRIPT TO EXPAND:
${JSON.stringify({ segments: script.segments })}

Return complete JSON with same structure but longer narratorText in each segment.`;

              const expandRes = await ai.models.generateContent({
                  model: "gemini-2.5-flash",
                  contents: expandPrompt,
                  config: { maxOutputTokens: 65536, responseMimeType: "application/json" },
              });
              const expandedJson = (expandRes.text || '').replace(/```json/g, '').replace(/```/g, '').trim();
              const expanded = JSON.parse(repairJson(expandedJson));

              const expandedSegments = expanded.segments || expanded;
              if (Array.isArray(expandedSegments) && expandedSegments.length === script.segments.length) {
                  script.segments = expandedSegments.map((seg: any) => {
                      const wc = (seg.narratorText || '').split(/\s+/).filter((w: string) => w.length > 0).length;
                      return { ...seg, estimatedDuration: Math.max(Math.round((wc / 150) * 60), 3) };
                  });
                  const ev = validateScriptDuration(script, params.targetDuration);
                  (script as any).estimatedDurationMinutes = ev.estimatedMinutes;
                  (script as any).totalWords = ev.totalWords;
                  console.log(`[DarkStream AI] ✅ Expansão: ${validation.totalWords} → ${ev.totalWords} palavras`);
              }
          } catch (expandErr) {
              console.warn('[DarkStream AI] Expansão falhou, mantendo script original');
          }
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
  format?: string,
): Promise<VideoMetadata> => {
  // Auto-detect Shorts from format — never rely on AI to guess this
  const isShortsByFormat = !!(format?.includes('9:16') || format?.toLowerCase().includes('shorts'));

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
        const detectedIsShorts = isShortsByFormat || data.isShorts || false;
        return {
          youtubeTitle: data.youtubeTitle || topic,
          youtubeDescription: fullDesc,
          tags: data.tags || [],
          categoryId: detectedIsShorts ? "22" : (data.categoryId || "24"),
          visibility: "public" as const,
          isShorts: detectedIsShorts,
        };
      });
    } catch {
      // If AI fails, still return the intelligent description
      return {
        youtubeTitle: topic,
        youtubeDescription: fullDesc,
        tags: [],
        categoryId: isShortsByFormat ? "22" : "24",
        visibility: "public",
        isShorts: isShortsByFormat,
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

// ─── Voice style instructions per tone ──────────────────────────────────────
const getVoiceStyleInstruction = (tone: string): string => {
    const t = tone.toLowerCase();

    if (t.includes('horror') || t.includes('dark') || t.includes('suspense') || t.includes('thriller')) {
        return `You are a master horror narrator. Speak in a slow, deep, gravelly voice with deliberate dramatic pauses between key phrases. Let tension build gradually. Breathe between sentences. Lower your pitch on shocking reveals. Never rush. Make the listener feel dread.`;
    }
    if (t.includes('child') || t.includes('kid') || t.includes('fairy')) {
        return `You are a warm, engaging children's storyteller. Speak with enthusiasm and playful energy. Vary your pitch — go higher for exciting moments, softer for gentle ones. Add wonder to your voice. Pause briefly after questions to let imagination work.`;
    }
    if (t.includes('documentary') || t.includes('historical') || t.includes('formal')) {
        return `You are a seasoned documentary narrator in the style of David Attenborough. Speak with calm authority and gravitas. Use measured pacing with natural breathing pauses. Emphasize key facts with slight pitch drops. Sound thoughtful and wise.`;
    }
    if (t.includes('motivat') || t.includes('energetic') || t.includes('coach')) {
        return `You are an inspiring motivational speaker. Speak with conviction and rising energy. Build momentum through each sentence. Use punchy pacing on action phrases. Sound like you genuinely believe every word. Pause powerfully before key statements.`;
    }
    if (t.includes('crime') || t.includes('true crime') || t.includes('investigat')) {
        return `You are a true crime podcast narrator. Speak in a measured, slightly hushed tone as if sharing a secret. Build tension with pacing. Drop your voice on disturbing details. Sound investigative and compelling, never sensational.`;
    }
    if (t.includes('tech') || t.includes('science') || t.includes('explainer') || t.includes('wendover')) {
        return `You are a confident, clear educational narrator. Speak at a comfortable pace — not too fast, not too slow. Sound genuinely excited about the subject. Use natural emphasis on technical terms. Be authoritative but approachable.`;
    }
    // Default: engaging, natural, broadcast quality
    return `You are a professional YouTube narrator with a warm, engaging broadcast voice. Speak naturally with varied pacing — faster for exciting moments, slower for important points. Use natural emphasis and pauses. Sound like a real person telling a story, not reading a script. Breathe naturally between paragraphs.`;
};

// ─── Pre-process text to help TTS sound more natural ─────────────────────────
const preprocessTextForTTS = (text: string): string => {
    return text
        // Replace ellipsis with pause markers the TTS understands
        .replace(/\.\.\./g, '...')
        // Ensure em-dashes create pauses
        .replace(/—/g, ' — ')
        // Add slight pause after colons in narrative context
        .replace(/: /g, ': ')
        // Clean up multiple spaces
        .replace(/  +/g, ' ')
        .trim();
};

export const generateVoiceover = async (
    text: string,
    voiceName: string = 'Fenrir',
    tone: string = 'Cinematic',
    sessionId?: string,
): Promise<ArrayBuffer> => { 
    if (!text || !text.trim()) return new ArrayBuffer(0); 
    
    // Gemini TTS supported voices as of 2025
    const SUPPORTED_VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr', 'Aoede', 'Leda', 'Orus', 'Schedar'];
    const VOICE_MAPPING: Record<string, string> = {
        'Default': 'Fenrir',
    };
    
    let finalVoice = voiceName;
    if (!SUPPORTED_VOICES.includes(voiceName)) {
        finalVoice = VOICE_MAPPING[voiceName] || 'Fenrir';
    }

    const styleInstruction = getVoiceStyleInstruction(tone);
    const cleanText = preprocessTextForTTS(text);

    return executeGeminiRequest(async (ai) => {
        // Craft the prompt to guide natural delivery
        // DO NOT wrap text in quotes — that signals "read this literally" to the TTS model
        // Instead, give acting direction then present the text as a continuation
        const ttsPrompt = `${styleInstruction}

Now narrate the following passage with full expression and natural rhythm:

${cleanText}`;
        
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
    }, sessionId);
};

