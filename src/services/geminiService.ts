import { GoogleGenAI, Type, Modality, HarmCategory, HarmBlockThreshold, ThinkingLevel } from "@google/genai";
import { ScriptData, GenerateScriptParams, VideoMetadata, ScriptSegment } from "../types";
import { decryptData } from "./securityService";

// --- HELPERS ---

/**
 * FIX #1: Enhanced quota error detection.
 * Now checks more error patterns including:
 * - HTTP status 429 from multiple locations in the error object
 * - Google's RESOURCE_EXHAUSTED status
 * - Various rate limit message patterns
 * - Retry-After header presence (indicates rate limiting)
 */
const isQuotaError = (err: any): boolean => {
    if (!err) return false;
    
    // 1. Check explicit status codes (most reliable)
    const status = err.status || err.response?.status || err.error?.code || err.httpStatusCode || err.code;
    if (status === 429 || status === '429') return true;

    const msg = (err.message || err.toString() || '').toLowerCase();
    const errStatus = (err.error?.status || err.statusText || '').toUpperCase();
    const reason = (err.error?.details?.[0]?.reason || '').toLowerCase();
    
    // 2. Google-specific status codes
    if (errStatus === 'RESOURCE_EXHAUSTED' || errStatus === 'TOO_MANY_REQUESTS') return true;
    if (reason === 'rate_limit_exceeded' || reason === 'quota_exceeded' || reason === 'user_rate_limit_exceeded') return true;
    
    // 3. Check error message text patterns (expanded list for better detection)
    const quotaKeywords = [
        'quota exceeded', 
        'resource_exhausted', 
        'too many requests',
        'rate_limit_exceeded',
        'user_rate_limit_exceeded',
        'rate limit',
        'quota has been exceeded',
        'requests per minute',
        'requests per day',
        'rpm limit',
        'rpd limit',
        'exceeded your current quota',
        'insufficient quota',
        'billing not enabled', // Sometimes quota shows as billing issue
        'you have exceeded',
        'limit exceeded',
        'per-minute',
        'per-day',
        'generatecontent: 429',
        'http 429',
        'status: 429',
    ];
    
    return quotaKeywords.some(keyword => msg.includes(keyword));
};

/**
 * FIX #2: Extract retry-after time from error responses.
 * Returns milliseconds to wait, or a default if not found.
 */
const getRetryAfterMs = (err: any, defaultMs: number = 5000): number => {
    // Check for Retry-After header in the error
    const retryAfter = err?.headers?.get?.('retry-after') || err?.response?.headers?.['retry-after'];
    if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) return seconds * 1000;
    }
    
    // Check for retryDelay in error details (Google API pattern)
    const retryDelay = err?.error?.details?.find?.((d: any) => d.retryDelay);
    if (retryDelay?.retryDelay) {
        const match = retryDelay.retryDelay.match(/(\d+)s/);
        if (match) return parseInt(match[1], 10) * 1000;
    }

    return defaultMs;
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- KEY MANAGEMENT LOGIC ---

const getAllAvailableKeys = async (): Promise<string[]> => {
    let candidateKeys: string[] = [];
    
    let userEmail = '';
    try {
        const storedProfileEnc = localStorage.getItem('ds_user_profile');
        if (storedProfileEnc) {
            const decryptedProfile = await decryptData(storedProfileEnc);
            const user = JSON.parse(decryptedProfile);
            userEmail = user.email;
        }
    } catch(e) {}

    const storageKeysToScan = [
        'ds_api_keys_list',
        'ds_api_key',
    ];
    
    if (userEmail) {
        storageKeysToScan.unshift(`ds_api_keys_list_${userEmail}`);
        storageKeysToScan.unshift(`ds_api_key_${userEmail}`);
    }

    for (const storageKey of storageKeysToScan) {
        const storedValue = localStorage.getItem(storageKey);
        if (storedValue) {
            try {
                const decrypted = await decryptData(storedValue);
                if (!decrypted) continue;

                const cleanDecrypted = decrypted.trim();
                
                if (cleanDecrypted.startsWith('[')) {
                    try {
                        const parsed = JSON.parse(cleanDecrypted);
                        if (Array.isArray(parsed)) {
                            parsed.forEach(k => {
                                if (typeof k === 'string') candidateKeys.push(k);
                            });
                        }
                    } catch (e) {}
                } else {
                    candidateKeys.push(cleanDecrypted);
                }
            } catch (e) {
                console.warn(`Failed to process key from ${storageKey}`, e);
            }
        }
    }

    try {
        const k3 = import.meta.env?.VITE_GEMINI_API_KEY;
        const k4 = import.meta.env?.VITE_API_KEY;
        
        if (k3 && typeof k3 === 'string' && k3.length > 20) candidateKeys.push(k3);
        if (k4 && typeof k4 === 'string' && k4.length > 20) candidateKeys.push(k4);
    } catch(e) {}

    const validKeys = Array.from(new Set(candidateKeys))
        .map(k => k ? k.trim() : '')
        .filter(k => {
            const hasLength = k.length > 20;
            const isNotPlaceholder = k !== 'undefined' && k !== 'null' && k !== '[object Object]';
            return hasLength && isNotPlaceholder;
        });

    if (validKeys.length > 0) {
        console.log(`[DarkStream AI] Gerenciador de Chaves: Encontradas ${validKeys.length} chaves utilizáveis.`);
    } else {
        console.warn("[DarkStream AI] Nenhuma chave Gemini API encontrada nos slots de armazenamento ou ambiente.");
    }
    
    return validKeys;
};

// --- KEY MANAGEMENT STATE ---
let lastUsedKeyIndex = parseInt(localStorage.getItem('ds_last_key_index') || '0');

interface ExhaustedKeyInfo {
    expiration: number;
    reason: 'quota_rpm' | 'quota_rpd' | 'auth' | 'error';
    retryAfterMs: number;
}

const exhaustedKeys = new Map<string, ExhaustedKeyInfo>();

/**
 * Classify quota error type: RPM (per-minute, short cooldown) vs RPD (per-day, long cooldown)
 */
const classifyQuotaType = (err: any): 'quota_rpm' | 'quota_rpd' => {
    const msg = (err?.message || err?.toString() || '').toLowerCase();
    const reason = (err?.error?.details?.[0]?.reason || '').toLowerCase();
    
    // Only classify as RPD if the error EXPLICITLY mentions daily/per-day limits
    const isDailyExplicit = 
        msg.includes('per-day') || msg.includes('per_day') || 
        msg.includes('rpd') || 
        reason.includes('daily') || reason.includes('per_day');
    
    if (isDailyExplicit) {
        return 'quota_rpd';
    }
    // Default to RPM (short cooldown) - much safer to avoid false daily limit errors
    return 'quota_rpm';
};

/**
 * Get cooldown duration based on quota type
 */
const getCooldownMs = (err: any, quotaType: 'quota_rpm' | 'quota_rpd'): number => {
    // First check if the API tells us how long to wait
    const apiRetry = getRetryAfterMs(err, 0);
    if (apiRetry > 0) return apiRetry;
    
    // Defaults based on type
    if (quotaType === 'quota_rpd') return 60 * 60 * 1000; // 1 hour for daily limits
    return 65 * 1000; // 65 seconds for per-minute limits
};

export const getKeyStatus = (key: string): { status: 'ready' | 'exhausted'; reason?: string; remainingMs?: number } => {
    const trimmedKey = (key || '').trim();
    const info = exhaustedKeys.get(trimmedKey);
    if (!info) return { status: 'ready' };
    const remaining = info.expiration - Date.now();
    if (remaining <= 0) {
        exhaustedKeys.delete(trimmedKey);
        return { status: 'ready' };
    }
    return { status: 'exhausted', reason: info.reason, remainingMs: remaining };
};

export const clearExhaustedKeys = () => {
    exhaustedKeys.clear();
    console.log("[DarkStream AI] ✅ Status de todas as chaves resetado.");
};

export const getKeysStatusSummary = async (): Promise<{ total: number; ready: number; exhausted: number; details: Array<{ masked: string; status: string; reason?: string; remainingMs?: number }> }> => {
    const allKeys = await getAllAvailableKeys();
    const details = allKeys.map(k => {
        const masked = k.length > 8 ? `...${k.slice(-6)}` : '***';
        const status = getKeyStatus(k);
        return { masked, status: status.status, reason: status.reason, remainingMs: status.remainingMs };
    });
    return {
        total: allKeys.length,
        ready: details.filter(d => d.status === 'ready').length,
        exhausted: details.filter(d => d.status === 'exhausted').length,
        details
    };
};

// --- CONCURRENCY CONTROL ---
let isProcessingQueue = false;
const requestQueue: Array<{
    operation: (ai: GoogleGenAI) => Promise<any>;
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
}> = [];

const processQueue = async () => {
    if (isProcessingQueue || requestQueue.length === 0) return;
    isProcessingQueue = true;
    
    while (requestQueue.length > 0) {
        const { operation, resolve, reject } = requestQueue.shift()!;
        try {
            const result = await executeGeminiRequestInternal(operation);
            resolve(result);
        } catch (err) {
            reject(err);
        }
        // Dynamic delay: less keys = more spacing to avoid hitting limits
        const keyCount = (await getAllAvailableKeys()).length || 1;
        const baseDelay = Math.max(300, 1500 / keyCount);
        await delay(baseDelay);
    }
    
    isProcessingQueue = false;
};

const executeGeminiRequest = async <T>(
    operation: (ai: GoogleGenAI) => Promise<T>
): Promise<T> => {
    return new Promise((resolve, reject) => {
        requestQueue.push({ operation, resolve, reject });
        processQueue();
    });
};

/**
 * IMPROVED KEY ROTATION ENGINE
 * 
 * Strategy:
 * 1. Round-robin across all available keys
 * 2. On quota error: classify as RPM or RPD, set appropriate cooldown
 * 3. Skip exhausted keys (unless all are exhausted)
 * 4. If ALL keys exhausted: auto-wait for the shortest cooldown, then retry
 * 5. Up to 2 full rotation cycles before giving up
 */
const executeGeminiRequestInternal = async <T>(
    operation: (ai: GoogleGenAI) => Promise<T>,
    _rotationAttempt: number = 0
): Promise<T> => {
    const MAX_ROTATION_CYCLES = 2;
    
    const allKeys = await getAllAvailableKeys();
    
    if (allKeys.length === 0) {
        throw new Error("Nenhuma chave API encontrada. Vá em Configurações e adicione suas chaves do Google AI Studio.");
    }

    // Clean up expired cooldowns
    for (const [key, info] of exhaustedKeys.entries()) {
        if (info.expiration <= Date.now()) exhaustedKeys.delete(key);
    }

    // Separate ready and exhausted keys
    const readyKeys = allKeys.filter(k => getKeyStatus(k).status === 'ready');
    
    // If ALL keys are exhausted, wait for the shortest cooldown and retry
    if (readyKeys.length === 0) {
        if (_rotationAttempt >= MAX_ROTATION_CYCLES) {
            const summary = allKeys.map(k => {
                const s = getKeyStatus(k);
                const masked = k.length > 8 ? `...${k.slice(-6)}` : '***';
                return `${masked}: ${s.reason} (${Math.ceil((s.remainingMs || 0) / 1000)}s)`;
            }).join(', ');
            throw new Error(`[DarkStream AI] ⚠️ Todas as ${allKeys.length} chaves estão em cooldown. Status: ${summary}. Adicione mais chaves em Configurações.`);
        }

        // Find shortest wait time
        let minWait = Infinity;
        for (const [, info] of exhaustedKeys.entries()) {
            const remaining = info.expiration - Date.now();
            if (remaining > 0 && remaining < minWait) minWait = remaining;
        }
        
        // Only auto-wait for RPM limits (short waits). For RPD, throw immediately.
        if (minWait > 5 * 60 * 1000) { // More than 5 minutes = likely daily limit
            throw new Error(`[DarkStream AI] ⚠️ Todas as ${allKeys.length} chaves atingiram o limite diário. Adicione mais chaves ou aguarde o reset.`);
        }

        const waitSec = Math.ceil(minWait / 1000);
        console.log(`[DarkStream AI] ⏳ Todas as ${allKeys.length} chaves em cooldown. Aguardando ${waitSec}s para a próxima disponível...`);
        await delay(minWait + 1000); // Wait + 1s buffer
        
        return executeGeminiRequestInternal(operation, _rotationAttempt + 1);
    }

    // Round-robin starting from last used index
    const startIndex = lastUsedKeyIndex % readyKeys.length;
    
    let lastError: any = null;

    for (let i = 0; i < readyKeys.length; i++) {
        const currentIndex = (startIndex + i) % readyKeys.length;
        const currentKey = readyKeys[currentIndex];
        
        // Update round-robin index
        lastUsedKeyIndex = (allKeys.indexOf(currentKey) + 1) % allKeys.length;
        localStorage.setItem('ds_last_key_index', lastUsedKeyIndex.toString());

        const masked = currentKey.length > 8 ? `...${currentKey.slice(-6)}` : '***';
        console.log(`[DarkStream AI] 🔄 Chave ${masked} [${i + 1}/${readyKeys.length} disponíveis, ${allKeys.length} total]`);

        try {
            const ai = new GoogleGenAI({ apiKey: currentKey });
            
            // Try with 1 inline retry for transient rate limits
            let attempt = 0;
            while (true) {
                try {
                    const result = await operation(ai);
                    console.log(`[DarkStream AI] ✅ Sucesso com chave ${masked}`);
                    return result;
                } catch (innerErr: any) {
                    attempt++;
                    if (attempt < 2 && isQuotaError(innerErr)) {
                        const waitTime = getRetryAfterMs(innerErr, 3000);
                        console.log(`[DarkStream AI] ⏳ Rate limit na chave ${masked}. Retry rápido em ${waitTime/1000}s...`);
                        await delay(waitTime);
                        continue;
                    }
                    throw innerErr;
                }
            }

        } catch (err: any) {
            lastError = err;
            const errMsg = (err.message || '').toLowerCase();
            const errStatus = err.status || err.response?.status || 0;

            if (isQuotaError(err)) {
                const quotaType = classifyQuotaType(err);
                const cooldown = getCooldownMs(err, quotaType);
                
                exhaustedKeys.set(currentKey, { 
                    expiration: Date.now() + cooldown, 
                    reason: quotaType,
                    retryAfterMs: cooldown
                });
                
                const cooldownStr = cooldown >= 60000 ? `${Math.round(cooldown/60000)}min` : `${Math.round(cooldown/1000)}s`;
                console.warn(`[DarkStream AI] ⚠️ Chave ${masked} → ${quotaType} (cooldown: ${cooldownStr}). Rotacionando...`);
                continue;
            }

            const isAuthError = 
                (errStatus === 400 || errStatus === 401 || errStatus === 403) &&
                (errMsg.includes('key') || errMsg.includes('invalid') || errMsg.includes('permission') || errMsg.includes('credential'));

            if (isAuthError) {
                exhaustedKeys.set(currentKey, { 
                    expiration: Date.now() + 10 * 60 * 1000, // 10 min cooldown for auth errors
                    reason: 'auth',
                    retryAfterMs: 10 * 60 * 1000
                });
                console.warn(`[DarkStream AI] 🔑 Chave ${masked} → erro de autenticação. Rotacionando...`);
                continue;
            }

            // Unknown error - mark temporarily and continue
            exhaustedKeys.set(currentKey, { 
                expiration: Date.now() + 30 * 1000,
                reason: 'error',
                retryAfterMs: 30000
            });
            console.warn(`[DarkStream AI] ❌ Chave ${masked} → erro: ${err.message}. Rotacionando...`);
            continue;
        }
    }

    // All ready keys failed in this cycle - recurse to trigger auto-wait logic
    if (_rotationAttempt < MAX_ROTATION_CYCLES) {
        console.log(`[DarkStream AI] 🔄 Ciclo de rotação ${_rotationAttempt + 1} completo. Iniciando novo ciclo...`);
        return executeGeminiRequestInternal(operation, _rotationAttempt + 1);
    }

    throw new Error(`[DarkStream AI] ⚠️ Todas as chaves falharam após ${MAX_ROTATION_CYCLES} ciclos. Último erro: ${lastError?.message || 'Desconhecido'}`);
};

// Robust JSON repair function
function repairJson(jsonStr: string): string {
  let inString = false;
  let isEscaped = false;
  const stack: string[] = [];
  
  const firstBrace = jsonStr.indexOf('{');
  if (firstBrace === -1) return "{}";
  
  let processed = jsonStr.substring(firstBrace);
  
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

export const generateVideoScript = async (params: GenerateScriptParams): Promise<ScriptData> => {
  return executeGeminiRequest(async (ai) => {
      const languagePrompt = params.language ? `IMPORTANT: Write the entire script in ${params.language}.` : "Write the script in English.";
      const toneInstruction = getToneInstruction(params.tone);
      const systemInstruction = `You are a world-class cinematic trailer scriptwriter. 
      Channel Theme: "${params.channelTheme}". Target Tone: "${params.tone}". ${languagePrompt}
      ${toneInstruction}
      Target Duration: ${params.targetDuration}`;
      let prompt = `Topic: "${params.topic}".\n`; 
      if (params.additionalContext) { prompt += `Context: ${params.additionalContext}\n`; } 
      if (params.libraryContext) { 
          prompt += `\nLIBRARY CONTEXT:\n${params.libraryContext.substring(0, 20000)}\n`; 
      }
      
      const responseStream = await ai.models.generateContentStream({ 
          model: "gemini-2.5-flash", 
          contents: prompt, 
          config: { 
              systemInstruction: systemInstruction, 
              responseMimeType: "application/json", 
              maxOutputTokens: 8192, 
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
          } 
      }); 
      
      let fullText = ''; 
      for await (const chunk of responseStream) { 
          const text = chunk.text; 
          if (text) { 
              fullText += text; 
              if (params.onProgress) params.onProgress(fullText); 
          } 
      } 
      if (!fullText) throw new Error("No script generated"); 
      let jsonString = fullText.replace(/```json/g, '').replace(/```/g, '').trim(); 
      try { 
          return JSON.parse(jsonString) as ScriptData; 
      } catch (parseError) { 
          console.warn("JSON Parse failed, attempting repair..."); 
          try { 
              const repaired = repairJson(jsonString); 
              return JSON.parse(repaired) as ScriptData; 
          } catch (repairError) { 
              throw new Error("Generated script was incomplete. Please try again."); 
          } 
      }
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

export const generateVideoMetadata = async (topic: string, scriptSummary: string, tone: string = 'Viral', language: string = 'English', segments: ScriptSegment[] = []): Promise<VideoMetadata> => {
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

// --- THUMBNAIL ---
export const generateThumbnailHook = async (title: string, tone: string = 'Viral', language: string = 'English'): Promise<string> => {
    return executeGeminiRequest(async (ai) => {
        const prompt = `Create a 2-3 word YouTube thumbnail hook for: "${title}". Language: ${language}. Tone: ${tone}. Output ONLY the text.`;
        const response = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt, config: { temperature: 0.9 } });
        return (response.text || "").trim().replace(/["']/g, '').toUpperCase();
    }).catch(() => title.split(' ').slice(0, 2).join(' ').toUpperCase());
};

/**
 * FIX #7: Improved thumbnail generation with explicit quota error detection and propagation.
 * The error is now always properly classified so the UI can show the right message.
 */
export const generateThumbnail = async (topic: string, tone: string = 'Cinematic', style: string = 'dynamic'): Promise<string> => {
    const prompt = `Viral, high-CTR thumbnail for: "${topic}". Tone: ${tone}. 
    COMPOSITION: Leave left 45% clean for text. Subject on right 55%.
    LIGHTING: Professional cinematic. NO TEXT IN IMAGE. Photorealistic, 8k.`;
    
    return await generateSceneImage(prompt, tone);
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
