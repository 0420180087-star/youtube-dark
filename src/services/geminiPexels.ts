// Pexels stock video search + Gemini-powered keyword generation.
// Extracted from geminiService.ts (phase 5 refactor).

import { GoogleGenAI } from '@google/genai';
import { executeGeminiRequest, delay } from './geminiCore';

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

