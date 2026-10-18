const path = require('node:path');
const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

function resolveEngineRuntime({ isPackaged, appRoot, resourcesPath }) {
  if (isPackaged) return {
    command: path.join(resourcesPath, 'engine', 'DanceFrameEngine', 'DanceFrameEngine'),
    args: []
  };
  const candidates = [
    path.join(appRoot, '.venv', 'bin', 'python'),
    path.join(appRoot, 'build', 'native-engine-venv-py312', 'bin', 'python')
  ];
  for (const command of candidates) {
    if (!existsSync(command)) continue;
    const probe = spawnSync(command, ['-c', 'import numpy, cv2, ultralytics, torch'], { timeout: 30000, encoding: 'utf8' });
    if (probe.status === 0) return { command, args: [path.join(appRoot, 'engine', 'export_video.py')] };
  }
  throw new Error('开发环境缺少完整 YOLO 依赖，请运行 uv sync --extra tracking，或 npm run bundle:engine。');
}
module.exports = { resolveEngineRuntime };
