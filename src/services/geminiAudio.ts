// Audio helper functions — decoding, merging, serialising AudioBuffers.
// Extracted from geminiService.ts (phase 5 refactor).
// These have no dependency on the Gemini API or key management.

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

    // All buffers must be at the same sample rate
    const sampleRate = buffers[0].sampleRate;
    const totalLength = buffers.reduce((acc, b) => acc + b.length, 0);
    const outputBuffer = ctx.createBuffer(1, totalLength, sampleRate);
    const outputData = outputBuffer.getChannelData(0);

    let offset = 0;
    for (let bi = 0; bi < buffers.length; bi++) {
        const buffer = buffers[bi];
        const channelData = buffer.getChannelData(0);

        // Apply a very short fade-in (5ms) at the start of each non-silence buffer
        // to eliminate click artifacts at segment boundaries
        const fadeInSamples = Math.min(Math.ceil(0.005 * sampleRate), channelData.length);
        const fadeData = new Float32Array(channelData);
        for (let i = 0; i < fadeInSamples; i++) {
            fadeData[i] *= i / fadeInSamples;
        }
        // Fade-out (5ms) at end
        const fadeOutSamples = Math.min(Math.ceil(0.005 * sampleRate), channelData.length);
        for (let i = 0; i < fadeOutSamples; i++) {
            const idx = channelData.length - 1 - i;
            fadeData[idx] *= i / fadeOutSamples;
        }

        outputData.set(fadeData, offset);
        offset += buffer.length;
    }

    return outputBuffer;
};

/**
 * Acelera (ou desacelera) a narração PRESERVANDO o tom da voz.
 * Overlap-add com janela de Hann: hop de análise = hop de síntese * fator.
 * Fator 1.0 (ou inválido) devolve o buffer original sem tocar em nada.
 */
export const changeAudioSpeed = (buffer: AudioBuffer, ctx: BaseAudioContext, factor: number): AudioBuffer => {
    const f = Number(factor);
    if (!isFinite(f) || f <= 1.005 && f >= 0.995) return buffer;
    const speed = Math.max(0.5, Math.min(2.0, f));

    const input = buffer.getChannelData(0);
    const N = 1024;                       // ~43ms a 24kHz
    const Hs = N / 2;                     // hop de síntese (Hann soma constante)
    const Ha = Math.max(1, Math.round(Hs * speed));
    const outLength = Math.max(1, Math.ceil(input.length / speed));

    const out = new Float32Array(outLength + N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

    let frame = 0;
    while (true) {
        const inStart = frame * Ha;
        const outStart = frame * Hs;
        if (inStart + N > input.length || outStart + N > out.length) break;
        for (let i = 0; i < N; i++) out[outStart + i] += input[inStart + i] * win[i];
        frame++;
    }

    const result = ctx.createBuffer(1, outLength, buffer.sampleRate);
    result.getChannelData(0).set(out.subarray(0, outLength));
    return result;
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
