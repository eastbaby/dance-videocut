const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("danceframe", {
  selectVideo: () => ipcRenderer.invoke("dialog:select-video"),
  selectAudio: () => ipcRenderer.invoke("dialog:select-audio"),
  diagnostics: () => ipcRenderer.invoke("engine:diagnostics"),
  analyzeBeat: (job) => ipcRenderer.invoke("engine:analyze-beat", job),
  cancelTracking: () => ipcRenderer.invoke("engine:cancel-track"),
  trackVideo: (job) => ipcRenderer.invoke("engine:track-video", job),
  exportVideo: (job) => ipcRenderer.invoke("engine:export-video", job),
  showItemInFolder: (path) => ipcRenderer.invoke("shell:show-item", path),
  onEngineProgress: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("engine:progress", listener);
    return () => ipcRenderer.removeListener("engine:progress", listener);
  }
});
