const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("optimizerApp", {
  getState: () => ipcRenderer.invoke("runner:get-state"),
  startRunner: (options) => ipcRenderer.invoke("runner:start", options),
  stopRunner: () => ipcRenderer.invoke("runner:stop"),
  loadSetup: () => ipcRenderer.invoke("app:load-setup"),
  saveChartUrl: (chartUrl) => ipcRenderer.invoke("app:save-chart-url", chartUrl),
  saveParams: (rows) => ipcRenderer.invoke("app:save-params", rows),
  getSetupState: () => ipcRenderer.invoke("setup:get-state"),
  startSetupTask: (taskName) => ipcRenderer.invoke("setup:start-task", taskName),
  stopSetupTask: () => ipcRenderer.invoke("setup:stop-task"),
  sendSetupEnter: () => ipcRenderer.invoke("setup:send-enter"),
  listResults: () => ipcRenderer.invoke("results:list"),
  openResult: (name) => ipcRenderer.invoke("results:open", name),
  revealResult: (name) => ipcRenderer.invoke("results:reveal", name),
  onRunnerLog: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on("runner-log", wrapped);
    return () => ipcRenderer.removeListener("runner-log", wrapped);
  },
  onRunnerStatus: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on("runner-status", wrapped);
    return () => ipcRenderer.removeListener("runner-status", wrapped);
  },
  onSetupLog: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on("setup-log", wrapped);
    return () => ipcRenderer.removeListener("setup-log", wrapped);
  },
  onSetupStatus: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on("setup-status", wrapped);
    return () => ipcRenderer.removeListener("setup-status", wrapped);
  },
});
