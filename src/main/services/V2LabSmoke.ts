/** Explicit local-alpha acceptance only; creates and removes its own real PTYs. */
import type { BrowserWindow } from "electron";
import { parseDuoInvite } from "./CanvasDuoService";
import { IPC } from "../../shared/contracts";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function runV2LabSmoke(window: BrowserWindow, output: string): Promise<string[]> {
  const checks: string[] = [];
  const run = async <T = any>(source: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([window.webContents.executeJavaScript(source), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("V2 probe timeout: " + source.slice(0, 80))), 15_000); })]); }
    catch (error) { throw new Error("V2 probe failed at " + source.split("(")[0], { cause: error }); }
    finally { if (timer) clearTimeout(timer); }
  };
  const api = <T = any>(name: string, ...args: unknown[]): Promise<T> => run(`window.canvasTTY.${name}(${args.map(v => JSON.stringify(v)).join(",")})`);
  const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const original = await api("settings.get");
  const created: string[] = [];
  let presetId: string | undefined;
  let remote: ReturnType<typeof spawn> | null = null;
  const note = { id: "v2-acceptance-note", text: "Workspace preset acceptance", position: { x: 3000, y: 30 }, size: { width: 300, height: 220 } };
  try {
    const first = await api("terminal.create", { provider: "terminal", profile: "normal", cwd: output, position: { x: 2400, y: 40 } }); created.push(first.id);
    const second = await api("terminal.create", { provider: "terminal", profile: "normal", cwd: output, position: { x: 3200, y: 40 } }); created.push(second.id);
    await api("terminal.rename", first.id, "Duo acceptance shell");
    await api("terminal.rename", second.id, "Private acceptance shell");
    const next = await api("settings.update", { stickyNotes: [...original.stickyNotes, note] }); window.webContents.send(IPC.settingsChanged, next);
    const tab = await api("browser.newTab", "https://example.com/");
    await api("workspacePresets.save", "Alpha3 acceptance workspace");
    presetId = (await api("workspacePresets.list")).find((p: any) => p.name === "Alpha3 acceptance workspace").id;
    await api("terminal.dispose", first.id);
    await api("browser.closeTab", tab.activeTabId);
    const cleared = await api("settings.update", { stickyNotes: original.stickyNotes }); window.webContents.send(IPC.settingsChanged, cleared);
    await run("window.__v2PresetSeen=0; window.__v2PresetUnsub=window.canvasTTY.settings.onChanged(s=>{if(s.stickyNotes.some(n=>n.id===\"v2-acceptance-note\"))window.__v2PresetSeen++}); true");
    const restored = await api("workspacePresets.restore", presetId, "continue");
    if (restored.cards.find((c: any) => c.id === first.id)?.state !== "opened" || restored.cards.find((c: any) => c.id === second.id)?.state !== "existing") throw new Error("Preset lost process/card identities");
    if (restored.surfaces.browserTabsOpened !== 1 || !(await api("settings.get")).stickyNotes.some((n: any) => n.id === note.id)) throw new Error("Preset layout/browser restore failed");
    await wait(300);
    if (!(await run("window.__v2PresetSeen > 0"))) throw new Error("Restored layout was not broadcast to the live renderer");
    const twice = await api("workspacePresets.restore", presetId, "continue");
    if (twice.cards.some((c: any) => c.state !== "existing") || twice.surfaces.browserTabsOpened !== 0) throw new Error("Repeated preset load duplicated a session/tab");
    checks.push("packaged preset: real terminal reopened, running terminal retained, layout broadcast, browser tab restored, repeat idempotent");
    await api("terminal.input", second.id, "printf 'DO_NOT_SHARE_CANVAS_PRIVATE\\n'\r");
    const host = await api("duo.command", { action: "host", transport: "lan", selected: [first.id], controlled: [] });
    if (!host.state.invites.length) throw new Error("Duo host has no invitation");
    const machine = process.env.CANVASTTY_DUO_LAB_SSH;
    if (machine) {
      if (machine !== "pc2") throw new Error("Lab SSH target must be the configured pc2");
      remote = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", machine, "node /dev/shm/canvastty-alpha3-lab/duo-lab-guest.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
      const client = remote;
      const lines = createInterface({ input: client.stdout! })[Symbol.asyncIterator]();
      let errorText = ""; client.stderr!.on("data", data => { errorText = (errorText + String(data)).slice(-4000); });
      const nextLine = async (): Promise<any> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const value = await Promise.race([lines.next(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("LAN peer timeout: " + errorText)), 20_000); })]);
          if (value.done) throw new Error("LAN peer disconnected: " + errorText);
          const result = JSON.parse(value.value); if (result.phase === "failed") throw new Error(result.error); return result;
        } finally { if (timer) clearTimeout(timer); }
      };
      const wantedHost = process.env.CANVASTTY_DUO_LAB_ADDRESS;
      const invite = host.state.invites.find((code: string) => !wantedHost || (parseDuoInvite(code) as {host:string}).host === wantedHost);
      if (!invite) throw new Error("Requested lab interface is not available.");
      client.stdin!.write(JSON.stringify({ invite, cardId: first.id }) + "\n");
      const joined = await nextLine(); if (joined.phase !== "joined") throw new Error("LAN peer did not join");
      const view = await api("duo.command", { action: "snapshot" });
      if (!view.snapshot.comments.some((c: any) => c.author === "guest") || !view.snapshot.cursors.length) throw new Error("LAN annotations did not arrive");
      await api("duo.command", { action: "select", selected: [first.id], controlled: [first.id] });
      client.stdin!.end('{"grant":true}\n');
      const completed = await nextLine(); if (completed.phase !== "complete") throw new Error("LAN input roundtrip failed");
      checks.push("Mac packaged host ↔ Ubuntu pc2: encrypted selected-card sharing, denied input, comments, cursor, explicit grant, real shell command roundtrip");
      await writeFile(join(output, "duo-lan.json"), JSON.stringify({ host: "macOS packaged CanvasTTY", guest: "Ubuntu pc2", joined, completed }, null, 2));
    }
    await run("document.querySelector('.duo-launch').click()");
    for (let i = 0; i < 60; i++) { if (await run("Boolean(document.querySelector('.duo-card pre')?.textContent)")) break; await wait(100); }
    if (!(await run("Boolean(document.querySelector('.duo-panel') && document.querySelector('.duo-card pre'))"))) throw new Error("Duo panel failed to render live shared terminal");
    const panelFits = await run(`(() => { const p=document.querySelector('.duo-panel'); const r=p.getBoundingClientRect(); return getComputedStyle(p.parentElement).position==='fixed' && r.width>400 && r.height>300 && r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight; })()`);
    if (!panelFits) throw new Error("Duo panel is not visible inside the application viewport");
    await writeFile(join(output, "duo-panel.png"), (await window.webContents.capturePage()).toPNG());
    await run("document.querySelector('.duo-panel>header button').click()");
    await api("duo.command", { action: "stop" });
    if ((await api("duo.command", { action: "state" })).state.role !== "idle") throw new Error("Duo failed to revoke access");
    checks.push("packaged Duo panel renders the shared terminal and revokes its listener");
    return checks;
  } finally {
    await run("window.__v2PresetUnsub?.()").catch(() => undefined);
    if (remote && remote.exitCode === null) remote.kill();
    await api("duo.command", { action: "stop" }).catch(() => undefined);
    for (const id of created) await api("terminal.dispose", id).catch(() => undefined);
    if (presetId) await api("workspacePresets.remove", presetId).catch(() => undefined);
    const currentBrowser = await api("browser.getState");
    for (const tab of currentBrowser.tabs.filter((t: any) => t.url === "https://example.com/")) await api("browser.closeTab", tab.id).catch(() => undefined);
    const next = await api("settings.update", { stickyNotes: original.stickyNotes }); window.webContents.send(IPC.settingsChanged, next);
  }
}
