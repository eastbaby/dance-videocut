import { transformSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
async function load(file) {
  const code = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {loader:'ts',format:'esm'}).code;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const {mergeRelock,retirePositionKeys,positionKeysAt}=await load('../src/relock.ts');
const {smoothTrajectory}=await load('../src/trajectory.ts');
const box=x=>({x,y:0,w:20,h:40});
const before=Array.from({length:180},()=>box(100));
const after=Array.from({length:180},()=>box(400));
const merged=mergeRelock(before,after,60);
assert.deepEqual(merged.slice(0,60),before.slice(0,60));
assert.deepEqual(merged.slice(60),after.slice(60));
assert.equal(merged[179].x,400,'must not revert 1.5 seconds after relock');
assert.deepEqual(before[60],box(100),'must not mutate previous result');
assert.throws(()=>mergeRelock(before,[],60));
const keys=retirePositionKeys([{time:1,box:box(10),subjectScale:70},{time:3,box:box(30),subjectScale:80}],60,30);
assert.equal(positionKeysAt(keys,30).length,1);
assert.equal(positionKeysAt(keys,90).length,0,'old offsets must not distort new identity');
assert.deepEqual(keys.map(k=>k.subjectScale),[70,80]);
const smoothed=smoothTrajectory(merged,78,[60]);
assert(Math.abs(smoothed[59].x-100)<1e-8);
assert(Math.abs(smoothed[60].x-400)<1e-8,'smoothing must not pull relock toward wrong person');
console.log('PASS: relock keeps prefix, replaces future permanently, retires offsets, preserves scale, isolates smoothing');
