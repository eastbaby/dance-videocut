const { resolveEngineRuntime } = require('../electron/engine-runtime.cjs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const appRoot = path.resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const resourcesPath = process.env.DANCEFRAME_TEST_RESOURCES || '/Applications/Dance Videocut.app/Contents/Resources';
const runtime = resolveEngineRuntime({ isPackaged: packaged, appRoot, resourcesPath });
const job = { rawTrajectory: !packaged, mode: 'track', inputPath: '/tmp/danceframe-keyframe-test.mp4', box: { x: 240, y: 90, w: 100, h: 180 }, smoothing: 78 };
const result = spawnSync(runtime.command, runtime.args, {
 cwd: packaged ? resourcesPath : appRoot,
 env: { ...process.env, FFMPEG_PATH: require('ffmpeg-static') },
 input: JSON.stringify(job), encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024
});
// This fixture contains colour bars, not a person. Refuse to silently track a
// guessed rectangle: an empty seed must now be an actionable error.
assert.equal(result.status, 2, result.stderr + result.stdout);
const messages = result.stdout.split('\n').flatMap(line => {try { return [JSON.parse(line)]; } catch { return []; }});
assert(messages.some(m => m.type === 'error' && m.message.includes('当前框内未检测到人物')));
assert(!messages.some(m => m.type === 'done'));
console.log(JSON.stringify({mode:packaged ? 'installed' : 'development',runtime:runtime.command,emptySeedRejected:true}));
