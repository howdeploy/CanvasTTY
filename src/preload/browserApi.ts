import { ipcRenderer } from "electron";
import type { BrowserCommand, BrowserStateEvent, BrowserActivityStateEvent, BrowserCanvasWheelEvent, BrowserCanvasFreezeFrameEvent, BrowserCanvasPointerEvent, BrowserCanvasNavigationPointerEvent, BrowserViewportBounds, CanvasTTYApi } from "../shared/contracts.ts";
import { IPC } from "../shared/contracts.ts";
function subscribe<T>(channel: string, listener: (event: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}
export const browserApi: CanvasTTYApi["browser"] = {
    openWindow: (url?: string) => ipcRenderer.invoke(IPC.browserOpenWindow, url),
    getState: () => ipcRenderer.invoke(IPC.browserGetState),
    open: (url?: string) => ipcRenderer.invoke(IPC.browserOpen, url),
    close: () => ipcRenderer.invoke(IPC.browserClose),
    closeAllTabs: () => ipcRenderer.invoke(IPC.browserCloseAllTabs),
    newTab: (url?: string) => ipcRenderer.invoke(IPC.browserNewTab, url),
    selectTab: (id: string) => ipcRenderer.invoke(IPC.browserSelectTab, id),
    closeTab: (id: string) => ipcRenderer.invoke(IPC.browserCloseTab, id),
    navigate: (id: string, value: string) => ipcRenderer.invoke(IPC.browserNavigate, id, value),
    back: (id: string) => ipcRenderer.invoke(IPC.browserBack, id),
    forward: (id: string) => ipcRenderer.invoke(IPC.browserForward, id),
    reload: (id: string) => ipcRenderer.invoke(IPC.browserReload, id),
    execute: (command: BrowserCommand) => ipcRenderer.invoke(IPC.browserExecute, command),
    getActivity: (sinceSequence?: number) => ipcRenderer.invoke(IPC.browserGetActivity, sinceSequence),
    clearData: () => ipcRenderer.invoke(IPC.browserClearData),
    focus: () => ipcRenderer.send(IPC.browserFocus),
    setInputFocused: (focused: boolean) => {
      ipcRenderer.sendSync(IPC.browserSetInputFocused, focused);
    },
    setViewport: (bounds: BrowserViewportBounds) => ipcRenderer.send(IPC.browserSetViewport, bounds),
    onState: (listener: (event: BrowserStateEvent) => void) => subscribe(IPC.browserState, listener),
    onActivity: (listener: (event: BrowserActivityStateEvent) => void) => subscribe(IPC.browserActivity, listener),
    onCanvasWheel: (listener: (event: BrowserCanvasWheelEvent) => void) => subscribe(IPC.browserCanvasWheel, listener),
    onCanvasFreezeFrame: (listener: (event: BrowserCanvasFreezeFrameEvent) => void) => (
      subscribe(IPC.browserCanvasFreezeFrame, listener)
    ),
    onCanvasPointer: (listener: (event: BrowserCanvasPointerEvent) => void) => subscribe(IPC.browserCanvasPointer, listener),
    onCanvasNavigationPointer: (listener: (event: BrowserCanvasNavigationPointerEvent) => void) => (
      subscribe(IPC.browserCanvasNavigationPointer, listener)
    )
  };
