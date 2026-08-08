import { renderVideo } from '/dev-server/scripts/videoRenderer.js';
const mod = await import('/dev-server/src/services/visualSceneService.ts').catch(()=>null);
// build fallback svgs via runner-style inline copy is unnecessary: use simple colored svg data urls
const svg = (i)=>`data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="100%" height="100%" fill="#1${i}2836"/><text x="100" y="500" fill="#fff" font-size="90">scene ${i}</text></svg>`)}`;
const durs=[3.4,0.6,5.2,1.1,0.8];
const visuals = durs.map((d,i)=>({url:svg(i),duration:d,effect:'zoom-in'}));
const segments = durs.map(d=>({estimatedDuration:d}));
const total = durs.reduce((a,b)=>a+b,0);
const audio = Buffer.alloc(Math.round(24000*2*total)); // silence s16le 24k mono
const {default: ffmpeg} = await import('fluent-ffmpeg');
const r = await renderVideo({visuals,segments,audioBase64:audio.toString('base64'),audioMimeType:'audio/pcm',tmpDir:'/tmp/rt/work'});
console.log('OUT', r.videoPath);

await new Promise(res=>ffmpeg.ffprobe(r.videoPath,(e,m)=>{console.log('err',e?.message,'dur',m?.format?.duration,'streams',m?.streams?.map(s=>s.codec_type+':'+s.codec_name));res();}));
console.log('expected ~', (total - 4*0.4).toFixed(2), 'raw sum', total.toFixed(2));
