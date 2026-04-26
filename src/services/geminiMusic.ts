// Procedural ambient music generation.
// Extracted from geminiService.ts (phase 5 refactor).

import { delay } from './geminiCore';

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

