import { realpath, stat } from "node:fs/promises";
import { BrowserWindow, clipboard, dialog, shell } from "electron";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import type { MaterialsAddResult, Point } from "../../shared/contracts.ts";
import { IPC } from "../../shared/contracts.ts";
import type { MaterialService } from "../services/materials/MaterialService";
import type { HandoffService } from "../services/materials/HandoffService";
import { captureRejection, fileUrlPaths, plistPaths, textPaths, windowsFileNames } from "../services/materials/materialClipboard.ts";
import { isId } from "../services/materials/materialState.ts";
import { assertMainRenderer } from "./registerIpc";
import type { IpcRegistrar } from "./IpcReadinessGate";

const MAX_CLIPBOARD_PATHS = 16;

interface MaterialIpcDependencies {
  materials: MaterialService;
  handoffs: HandoffService;
  workingDirectory(sessionId: string): string | null;
  getMainWindow(): BrowserWindow | null;
}

export function registerMaterialIpc(ipcMain: IpcRegistrar, { materials, handoffs, workingDirectory, getMainWindow }: MaterialIpcDependencies): void {

  ipcMain.handle(IPC.materialsSnapshot, (event) => {
    assertMainRenderer(event, getMainWindow);
    return materials.snapshot();
  });

  ipcMain.handle(IPC.materialsAddPaths, (event, paths: unknown, point: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (!Array.isArray(paths)) throw new Error("File paths are required.");
    return materials.addPaths(paths, point);
  });

  ipcMain.handle(IPC.materialsPick, async (event, point: unknown) => {
    assertMainRenderer(event, getMainWindow);
    const paths = await pickFiles(event, true);
    return paths.length === 0 ? emptyResult() : materials.addPaths(paths, point);
  });

  ipcMain.handle(IPC.materialsPaste, (event, point: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return pasteFromClipboard(materials, point);
  });

  ipcMain.on(IPC.materialsSetBounds, (event, id: unknown, bounds: unknown) => {
    try {
      assertMainRenderer(event, getMainWindow);
    } catch {
      return;
    }
    if (typeof id === "string") materials.setBounds(id, bounds);
  });

  ipcMain.on(IPC.materialsSetBoundsBatch, (event, entries: unknown) => {
    try {
      assertMainRenderer(event, getMainWindow);
    } catch {
      return;
    }
    if (Array.isArray(entries)) materials.setBoundsBatch(entries);
  });

  ipcMain.handle(IPC.materialsRemove, (event, id: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return materials.remove(requireId(id));
  });

  ipcMain.handle(IPC.materialsPinVersion, (event, id: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return materials.pinVersion(requireId(id));
  });

  ipcMain.handle(IPC.materialsReveal, (event, id: unknown) => {
    assertMainRenderer(event, getMainWindow);
    const location = materials.location(requireId(id));
    if (location) shell.showItemInFolder(location);
  });

  ipcMain.handle(IPC.materialsRelink, async (event, id: unknown) => {
    assertMainRenderer(event, getMainWindow);
    const materialId = requireId(id);
    const [path] = await pickFiles(event, false);
    return path ? materials.relink(materialId, path) : { ok: false, reason: "cancelled" };
  });

  ipcMain.handle(IPC.materialsAcceptMove, (event, id: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return materials.acceptMove(requireId(id));
  });

  ipcMain.handle(IPC.materialsAddRemark, (event, draft: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return materials.addRemark(draft);
  });

  ipcMain.handle(IPC.materialsUpdateRemark, (event, id: unknown, patch: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return materials.updateRemark(requireId(id), patch);
  });

  ipcMain.handle(IPC.materialsDeleteRemark, (event, id: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return materials.deleteRemark(requireId(id));
  });

  ipcMain.handle(IPC.materialsPreviewHandoff, (event, draft: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return handoffs.preview(draft);
  });

  ipcMain.handle(IPC.materialsSendHandoff, (event, draft: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return handoffs.send(draft);
  });


  ipcMain.handle(IPC.materialsPickResultsFolder, async (event, sessionId: unknown) => {
    assertMainRenderer(event, getMainWindow);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = typeof sessionId === "string" ? workingDirectory(sessionId) ?? undefined : undefined;
    const options: OpenDialogOptions = { properties: ["openDirectory", "createDirectory"], ...(defaultPath ? { defaultPath } : {}) };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const selected = result.filePaths[0];
    if (result.canceled || !selected) return null;
    try {
      if (!(await stat(selected)).isDirectory()) return null;
      const folder = await realpath(selected);
      handoffs.grantResultsFolder(folder);
      return folder;
    } catch {
      return null;
    }
  });
}

async function pickFiles(event: IpcMainInvokeEvent, multiple: boolean): Promise<string[]> {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options: OpenDialogOptions = {
    properties: multiple ? ["openFile", "multiSelections"] : ["openFile"]
  };
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
}

async function pasteFromClipboard(materials: MaterialService, point: unknown): Promise<MaterialsAddResult> {
  const paths = clipboardPaths();
  if (paths.length > 0) return materials.addPaths(paths, point);
  const image = clipboard.readImage();
  if (image.isEmpty()) return { added: [], existing: [], rejected: [{ name: "clipboard", reason: "empty-clipboard" }] };
  const created = await materials.addCapture({
    bytes: image.toPNG(),
    name: `clipboard-${timestamp(new Date())}.png`,
    mimeType: "image/png",
    origin: { kind: "clipboard" },
    point: point as Point,
    natural: image.getSize()
  });
  return created.ok
    ? { added: [created.materialId], existing: [], rejected: [] }
    : { added: [], existing: [], rejected: [{ name: "clipboard", reason: captureRejection(created.reason) }] };
}

function clipboardPaths(): string[] {
  const listed = process.platform === "darwin"
    ? orElse(plistPaths(safeRead(() => clipboard.read("NSFilenamesPboardType"))), () => fileUrlPaths(safeRead(() => clipboard.read("public.file-url"))))
    : process.platform === "win32"
      ? windowsFileNames(safeRead(() => clipboard.readBuffer("FileNameW"), Buffer.alloc(0)))
      : fileUrlPaths(safeRead(() => clipboard.read("text/uri-list")));
  return listed.length > 0 ? listed : textPaths(safeRead(() => clipboard.readText()), process.platform);
}

function orElse(paths: string[], fallback: () => string[]): string[] {
  return paths.length > 0 ? paths : fallback();
}

function safeRead<T = string>(read: () => T, fallback = "" as T): T {
  try {
    return read() ?? fallback;
  } catch {
    return fallback;
  }
}

function timestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function requireId(value: unknown): string {
  if (!isId(value)) throw new Error("Material id is required.");
  return value;
}

function emptyResult(): MaterialsAddResult {
  return { added: [], existing: [], rejected: [] };
}
