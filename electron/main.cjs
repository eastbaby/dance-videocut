const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");

const isDev = !app.isPackaged;
const appRoot = path.join(__dirname, "..");

function enginePath(...parts) {
  return isDev
    ? path.join(appRoot, "engine", ...parts)
    : path.join(process.resourcesPath, "engine", ...parts);
}

let runtime;
function engineRuntime() {
  runtime ??= require("./engine-runtime.cjs").resolveEngineRuntime({
    isPackaged: app.isPackaged, appRoot, resourcesPath: process.resourcesPath
  });
  return runtime;
}
function pythonCommand() { return engineRuntime().command; }
function engineArgs() { return engineRuntime().args; }

function engineEnvironment() {
  return {
    ...process.env,
    FFMPEG_PATH: isDev
      ? process.env.FFMPEG_PATH
      : path.join(process.resourcesPath, "bin", "ffmpeg")
  };
}

function safeSend(event, channel, ...args) {
  if (!event.sender || event.sender.isDestroyed()) {
    return false;
  }
  try {
    event.sender.send(channel, ...args);
    return true;
  } catch (err) {
    console.error("[Electron] Failed to send IPC message:", err);
    return false;
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    title: "Dance Videocut",
    backgroundColor: "#090908",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false
    }
  });

  if (isDev) {
    window.loadURL("http://127.0.0.1:5180/");
  } else {
    window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

const trackingJobs = new Map();
app.whenReady().then(() => {
  ipcMain.handle("engine:cancel-track", (event) => {
    const child = trackingJobs.get(event.sender.id);
    if (!child) return false;
    child.canceled = true;
    return child.kill();
  });
  ipcMain.handle("dialog:select-video", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择舞蹈视频",
      properties: ["openFile"],
      filters: [
        { name: "Video", extensions: ["mp4", "mov", "m4v", "webm", "avi", "mkv"] },
        { name: "All Files", extensions: ["*"] }
      ]
    });

    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    return {
      path: filePath,
      name: path.basename(filePath),
      url: pathToFileURL(filePath).toString()
    };
  });

  ipcMain.handle("dialog:select-audio", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择替换音乐",
      properties: ["openFile"],
      filters: [
        { name: "Audio", extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg"] },
        { name: "Video/Audio", extensions: ["mp4", "mov", "m4v", "webm", "mkv"] },
        { name: "All Files", extensions: ["*"] }
      ]
    });

    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    return {
      path: filePath,
      name: path.basename(filePath),
      url: pathToFileURL(filePath).toString()
    };
  });

  ipcMain.handle("shell:show-item", async (event, filePath) => {
    console.log("[Electron] shell.showItemInFolder called for path:", filePath);
    shell.showItemInFolder(filePath);
    return true;
  });

  ipcMain.handle("engine:diagnostics", async () => {
    const python = spawnSync(pythonCommand(), ["--version"], { encoding: "utf8" });
    const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
    return {
      python: python.status === 0 ? (python.stdout || python.stderr).trim() : "未检测到 python3",
      ffmpeg: ffmpeg.status === 0 ? ffmpeg.stdout.split("\n")[0] : "未检测到 ffmpeg",
      accelerator: process.platform === "darwin" ? "Apple Silicon: 推荐 ONNX/CoreML/MPS 后端" : "Local accelerator"
    };
  });

  ipcMain.handle("engine:track-video", async (event, job) => {
    const payload = {
      ...job,
      mode: "track"
    };

    const child = spawn(pythonCommand(), engineArgs(), {
      cwd: isDev ? appRoot : process.resourcesPath,
      env: engineEnvironment(),
      stdio: ["pipe", "pipe", "pipe"]
    });

    trackingJobs.set(event.sender.id, child);
    child.once("close", () => {
      if (trackingJobs.get(event.sender.id) === child) trackingJobs.delete(event.sender.id);
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    child.stdout.setEncoding("utf8");
    let stdoutData = "";
    let stdoutBuffer = "";
    child.stdout.on("data", (chunk) => {
      stdoutData += chunk;
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.type === "phase" || message.type === "progress") {
            if (!safeSend(event, "engine:progress", message)) {
              child.kill();
              return;
            }
          }
        } catch {}
      }
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    return await new Promise((resolve) => {
      child.on("error", (error) => {
        resolve({ ok: false, error: error.message });
      });
      child.on("close", (code) => {
        if (child.canceled) return resolve({ ok: false, error: "已取消分析" });
        if (code === 0) {
          try {
            const lines = stdoutData.split("\n");
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const message = JSON.parse(line);
                if (message.type === "done") {
                  return resolve({ ok: true, boxes: message.boxes, fps: message.fps, uncertainFrames: message.uncertainFrames });
                }
              } catch {}
            }
            resolve({ ok: false, error: "未能在输出中找到追踪数据" });
          } catch (err) {
            resolve({ ok: false, error: err.message });
          }
        } else {
          let engineError = "";
          for (const line of stdoutData.split(/\r?\n/)) {
            try {
              const message = JSON.parse(line);
              if (message.type === "error" && message.message) engineError = message.message;
            } catch {}
          }
          resolve({ ok: false, error: engineError || stderr.trim() || `Tracker exited with code ${code}` });
        }
      });
    });
  });

  ipcMain.handle("engine:analyze-beat", async (event, job) => {
    const payload = {
      ...job,
      mode: "beat"
    };

    const child = spawn(pythonCommand(), engineArgs(), {
      cwd: isDev ? appRoot : process.resourcesPath,
      env: engineEnvironment(),
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    child.stdout.setEncoding("utf8");
    let stdoutData = "";
    child.stdout.on("data", (chunk) => {
      stdoutData += chunk;
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.type === "phase" || message.type === "progress") {
            if (!safeSend(event, "engine:progress", message)) {
              child.kill();
              return;
            }
          }
        } catch {}
      }
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    return await new Promise((resolve) => {
      child.on("error", (error) => {
        resolve({ ok: false, error: error.message });
      });
      child.on("close", (code) => {
        if (code === 0) {
          for (const line of stdoutData.split("\n")) {
            if (!line.trim()) continue;
            try {
              const message = JSON.parse(line);
              if (message.type === "done" && message.source && message.replacement) {
                return resolve({
                  ok: true,
                  source: message.source,
                  replacement: message.replacement,
                  offset: message.offset,
                  rate: message.rate,
                  alignmentScore: message.alignmentScore
                });
              }
            } catch {}
          }
          resolve({ ok: false, error: "未能在输出中找到节拍分析结果" });
        } else {
          resolve({ ok: false, error: stderr.trim() || `Beat analyzer exited with code ${code}` });
        }
      });
    });
  });

  ipcMain.handle("engine:export-video", async (event, job) => {
    const suggestedName = `${path.parse(job.inputPath).name}-dance-videocut-${job.aspect.replace(":", "x")}.mp4`;
    const result = await dialog.showSaveDialog({
      title: "导出竖版成片",
      defaultPath: path.join(path.dirname(job.inputPath), suggestedName),
      filters: [{ name: "MP4 Video", extensions: ["mp4"] }]
    });

    if (result.canceled || !result.filePath) return { canceled: true };

    const payload = {
      ...job,
      outputPath: result.filePath
    };

    const child = spawn(pythonCommand(), engineArgs(), {
      cwd: isDev ? appRoot : process.resourcesPath,
      env: engineEnvironment(),
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (!safeSend(event, "engine:progress", message)) {
            child.kill();
            return;
          }
        } catch {
          if (!safeSend(event, "engine:progress", { type: "log", message: line })) {
            child.kill();
            return;
          }
        }
      }
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    return await new Promise((resolve) => {
      child.on("error", (error) => {
        resolve({ ok: false, error: error.message });
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve({ ok: true, outputPath: result.filePath });
        } else {
          resolve({ ok: false, error: stderr.trim() || `Engine exited with code ${code}` });
        }
      });
    });
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
