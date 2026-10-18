import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import assert from 'node:assert/strict';
const root='/Applications/Dance Videocut.app/Contents/Resources';
const engine=`${root}/engine/DanceFrameEngine/DanceFrameEngine`;
const ffmpeg=`${root}/bin/ffmpeg`;
const input='/tmp/danceframe-release-dance.mp4';
const output='/tmp/danceframe-1.0.4-engine-verified.mp4';
async function module(name) {
 const code=transformSync(readFileSync(new URL(`../src/${name}.ts`,import.meta.url),'utf8'),{loader:'ts',format:'esm'}).code;
 return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
function run(job) {
 const result=spawnSync(engine,[],{cwd:'/tmp',env:{...process.env,FFMPEG_PATH:ffmpeg},input:JSON.stringify(job),encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
 assert.equal(result.status,0,result.stdout+result.stderr);
 const messages=result.stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}});
 assert(!messages.some(m=>m.type==='error'));
 const done=messages.find(m=>m.type==='done'); assert(done); return done;
}
const box={x:580,y:265,w:115,h:320};
const tracked=run({mode:'track',rawTrajectory:true,inputPath:input,box});
assert(tracked.boxes.length>=89);
const {smoothTrajectory}=await module('trajectory');
const {scaleAt,boxAtScale}=await module('keyframe-scale');
const smooth=smoothTrajectory(tracked.boxes,52);
const keys=[{time:0,subjectScale:80},{time:2,subjectScale:50}];
const boxes=smooth.map((b,i)=>boxAtScale(b,62,scaleAt(i/tracked.fps,tracked.fps,keys,62)));
run({inputPath:input,outputPath:output,boxes,box,subjectScale:62,aspect:'9:16'});
const decoded=spawnSync(ffmpeg,['-v','error','-i',output,'-f','null','-'],{encoding:'utf8',timeout:60000});
assert.equal(decoded.status,0,decoded.stderr);
const info=spawnSync(ffmpeg,['-hide_banner','-i',output],{encoding:'utf8'}).stderr;
assert(info.includes('1080x1920')&&info.includes('yuv420p')&&info.includes('h264'));
const evidence={version:'1.0.4',runtime:engine,source:input,trackedFrames:tracked.boxes.length,fps:tracked.fps,localScales:keys,smoothing:52,output,decoded:true};
writeFileSync(new URL('../release/validation-1.0.4.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence));
