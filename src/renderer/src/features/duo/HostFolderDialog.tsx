import { useEffect, useRef, useState } from "react";
import type { FileEntry, FileLocation, FileRootDescriptor } from "../../../../shared/contracts";
import { duoWorkspace } from "./duoWorkspaceRuntime";

export function HostFolderDialog({ workspace, ru, filesOnly, onCreate, onClose }: {
  workspace: string; ru: boolean; filesOnly: boolean; onCreate(rootId: string, path: string): Promise<void>; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [places, setPlaces] = useState<FileLocation[]>([]);
  const [path, setPath] = useState("");
  const [root, setRoot] = useState<FileRootDescriptor | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Keep late replies and cleanup scoped to the guest workspace that opened the dialog.
  async function remote<T>(run: () => Promise<T>): Promise<T> {
    const state = duoWorkspace.get();
    if (!state.connected || state.reply?.state.workspaceId !== workspace || !state.reply.state.manage)
      throw Error(ru ? "Нет управления хостом" : "Host control unavailable");
    return run();
  }
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    void remote(() => window.canvasTTY.files.locations()).then(items => {
      if (active) { setPlaces(items); setPath(items.find(p => p.kind === "home")?.path ?? items[0]?.path ?? ""); }
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [workspace]);
  useEffect(() => {
    if (!path) return;
    let active = true;
    let handle: FileRootDescriptor | null = null;
    const release = () => { if (handle) void remote(() => window.canvasTTY.files.closeRoot(handle!.rootId)).catch(() => {}); };
    setRoot(null); setEntries([]); setError("");
    void (async () => {
      handle = await remote(() => window.canvasTTY.files.registerRoot({ rootType: "folder", folderPath: path }));
      if (!active) { release(); return; }
      if (!handle?.available) throw Error(ru ? "Папка недоступна" : "Folder unavailable");
      const items = await remote(() => window.canvasTTY.files.list(handle!.rootId, ""));
      if (active) { setRoot(handle); setEntries(items.filter(item => item.kind === "directory")); }
    })().catch(e => { if (active) setError(String(e)); });
    return () => { active = false; release(); };
  }, [path, workspace]);
  async function create() {
    if (!root) return;
    setBusy(true);
    try { await onCreate(root.rootId, root.folderPath ?? path); onClose(); }
    catch (e) { setError(String(e)); setBusy(false); }
  }
  return <dialog ref={dialog} className="duo-folder-dialog" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }} aria-labelledby="host-folder-title">
    <h2 id="host-folder-title">{filesOnly ? (ru ? "Папка на хосте" : "Host folder") : (ru ? "Терминал на хосте" : "Terminal on host")}</h2>
    <fieldset disabled={busy}>
      <select aria-label={ru ? "Расположение" : "Location"} value={path} onChange={e => setPath(e.target.value)}>
        {!places.some(p => p.path === path) && <option>{path}</option>}
        {places.map(p => <option key={p.path} value={p.path}>{p.path}</option>)}
      </select>
      <div className="duo-folder-list">
        {root && <button onClick={() => setPath(path.replace(/[^/\\]+[/\\]?$/, "") || path)}>↑ {ru ? "Выше" : "Up"}</button>}
        {entries.map(e => <button key={e.name} onClick={() => setPath(path.replace(/[/\\]$/, "") + "/" + e.name)}>{e.name}</button>)}
      </div>
      {error && <p role="alert">{error}</p>}
      <footer><button onClick={onClose}>{ru ? "Отмена" : "Cancel"}</button>
        <button disabled={!root} onClick={() => void create()}>{filesOnly ? (ru ? "Выбрать папку" : "Choose folder") : (ru ? "Открыть терминал здесь" : "Open terminal here")}</button></footer>
    </fieldset>
  </dialog>;
}
