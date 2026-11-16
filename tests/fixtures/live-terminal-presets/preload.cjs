const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('presetFixture', {
  list: () => ipcRenderer.invoke('preset:list'),
  readAsset: (id, slot) => ipcRenderer.invoke('preset:read', id, slot)
});
contextBridge.exposeInMainWorld('fixtureWindowState', {
  getState: () => ipcRenderer.invoke('preset:window-get'),
  onState(listener) {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('preset:window-state', handler);
    return () => ipcRenderer.removeListener('preset:window-state', handler);
  }
});
