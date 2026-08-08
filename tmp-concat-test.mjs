import { concatenateWithCrossfade, simpleConcat, makePlaceholderClip } from './scripts/videoRenderer.js';
const {default: ffmpeg} = await import('fluent-ffmpeg');
import fs from 'fs';
fs.mkdirSync('/tmp/rt/c', {recursive:true});
const durs=[3.4,0.6,5.2,0.35,1.1,0.8];
const paths=[];
for(let i=0;i<durs.length;i++){const p=`/tmp/rt/c/c${i}.mp4`; await makePlaceholderClip(p,durs[i],i*7); paths.push(p);}
const probe=(p)=>new Promise(r=>ffmpeg.ffprobe(p,(e,m)=>r(m?.format?.duration?Number(m.format.duration):null)));
console.log('durs reais', await Promise.all(paths.map(probe)));
await concatenateWithCrossfade(paths,'/tmp/rt/c/x.mp4',0.4);
console.log('crossfade dur', await probe('/tmp/rt/c/x.mp4'));
await simpleConcat(paths,'/tmp/rt/c/s.mp4');
console.log('simpleConcat dur', await probe('/tmp/rt/c/s.mp4'));
console.log('soma', durs.reduce((a,b)=>a+b,0).toFixed(2));
