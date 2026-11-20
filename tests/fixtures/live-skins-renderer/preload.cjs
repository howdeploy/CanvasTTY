const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("fixtureWindowState", {
  getState: () => ipcRenderer.invoke("probe:window-get"),
  onState(listener) {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("probe:window-state", handler);
    return () => ipcRenderer.removeListener("probe:window-state", handler);
  }
});
