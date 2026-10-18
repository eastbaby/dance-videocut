import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
// Keep the packaging interpreter native to Apple Silicon. Do not reuse the
// old venv, which was created from macOS's universal system Python.
const buildVenv = path.join(root, "build", "native-engine-venv-py312");
const python = path.join(buildVenv, "bin", "python");
const output = path.join(root, "build", "engine", "DanceFrameEngine");
const bootstrapPython = "/opt/homebrew/bin/python3.12";

if (!existsSync(python)) {
  if (!existsSync(bootstrapPython)) {
    console.error(`Native Apple Silicon Python was not found: ${bootstrapPython}`);
    process.exit(1);
  }
  const venv = spawnSync("arch", ["-arm64", bootstrapPython, "-m", "venv", buildVenv], {
    cwd: root,
    stdio: "inherit"
  });
  if (venv.status !== 0) {
    console.error("Unable to create the native macOS Python build environment.");
    process.exit(venv.status ?? 1);
  }
}

const dependencies = spawnSync("arch", ["-arm64", python, "-m", "pip", "install", "-r", "scripts/requirements-engine.txt"], {
  cwd: root,
  stdio: "inherit"
});
if (dependencies.status !== 0) process.exit(dependencies.status ?? 1);

rmSync(path.join(root, "build", "engine"), { recursive: true, force: true });
const result = spawnSync("arch", ["-arm64", python, "-m", "PyInstaller",
  "--noconfirm",
  "--clean",
  "--onedir",
  "--name", "DanceFrameEngine",
  "--distpath", path.join(root, "build", "engine"),
  "--workpath", path.join(root, "build", "pyinstaller-work"),
  "--specpath", path.join(root, "build", "pyinstaller-spec"),
  "--collect-all", "cv2",
  "--collect-all", "ultralytics",
  "--collect-all", "torch",
  "--collect-all", "torchvision",
  "--add-data", `${path.join(root, "yolov8n-pose.pt")}${path.delimiter}.`,
  path.join(root, "engine", "export_video.py")
], { cwd: root, stdio: "inherit" });

if (result.status !== 0 || !existsSync(output)) process.exit(result.status ?? 1);
