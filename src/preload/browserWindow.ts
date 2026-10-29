import { contextBridge } from "electron";
import { browserApi } from "./browserApi";
// Only browser capabilities cross this window's bridge; no terminal, settings or filesystem API.
contextBridge.exposeInMainWorld("canvasTTY", { browser: browserApi });
