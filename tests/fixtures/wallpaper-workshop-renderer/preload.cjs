const { contextBridge, ipcRenderer } = require("electron");
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = channel => listener => { const handler = () => listener(); ipcRenderer.on(channel, handler); return () => ipcRenderer.removeListener(channel, handler); };
contextBridge.exposeInMainWorld("canvasTTY", {
  wallpapers: { list: invoke("wallpapers:list"), install: invoke("wallpapers:install"), read: invoke("wallpapers:read"), export: invoke("wallpapers:export"), remove: invoke("wallpapers:remove"), onChanged: subscribe("wallpapers:changed") },
  settings: { get: invoke("settings:get"), update: invoke("settings:update") },
  window: { getState: invoke("probe:window-get"), onState: listener => { const handler = (_event, state) => listener(state); ipcRenderer.on("probe:window-state", handler); return () => ipcRenderer.removeListener("probe:window-state", handler); } },
  clipboard: { writeText: value => ipcRenderer.send("probe:clipboard", value) }
});
