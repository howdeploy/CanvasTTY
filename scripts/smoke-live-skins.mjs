// Uses an isolated Electron fixture with the actual React skin components and production CSP.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { electronSmokeLaunchBlockReason } from "./lib/electron-smoke-launch-guard.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repo, "package.json"));
const electron = require("electron");
if (typeof electron === "string") {
  const reason = electronSmokeLaunchBlockReason(process.platform, process.env);
  if (reason) throw new Error(reason);
  const { build } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const temporary = await mkdtemp(join(tmpdir(), "ct-live-"));
  try {
    await build({ configFile: false, root: join(repo, "tests/fixtures/live-skins-renderer"), base: "./", plugins: [react()], logLevel: "error", build: { outDir: join(temporary, "renderer"), emptyOutDir: true, target: "esnext", assetsInlineLimit: 0 } });
    const { build: bundle } = await import("esbuild");
    await bundle({ entryPoints: [join(repo, "src/main/windowState.ts")], bundle: true, platform: "node", format: "cjs", outfile: join(temporary, "window-state.cjs") });
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const output = resolve(process.argv[2] || join(repo, "../live-skins-smoke"));
    await mkdir(output, { recursive: true });
    const child = spawn(electron, [fileURLToPath(import.meta.url), "--probe", join(temporary, "renderer/index.html"), output, join(temporary, "window-state.cjs"), `--user-data-dir=${join(temporary, "profile")}`], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", bytes => { stdout += bytes; process.stdout.write(bytes); });
    child.stderr.on("data", bytes => process.stderr.write(bytes));
    const timer = setTimeout(() => child.kill("SIGKILL"), 50_000);
    try {
      const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
      assert.equal(code, 0);
      assert.match(stdout, /LIVE_SKINS_SMOKE_OK/);
    } finally { clearTimeout(timer); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
} else {
  void probe();
}
async function probe() {
  const { app, BrowserWindow, ipcMain } = electron;
  try {
    await app.whenReady();
    const index = process.argv.indexOf("--probe");
    const [html, output, stateModule] = process.argv.slice(index + 1, index + 4);
    const { readWindowState, observeWindowState } = require(stateModule);
    const window = new BrowserWindow({ width: 800, height: 760, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, preload: join(repo, "tests/fixtures/live-skins-renderer/preload.cjs") } });
    ipcMain.handle("probe:window-get", () => readWindowState(window));
    const stopObserving = observeWindowState(window, state => window.webContents.send("probe:window-state", state));
    const errors = [];
    window.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
    await window.loadFile(html);
    window.showInactive();
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const run = source => window.webContents.executeJavaScript(source);
    for (let tries = 0; tries < 100; tries++) { if (await run("Boolean(window.skinProbe && document.querySelector('#frame img'))")) break; await delay(50); }
    assert.equal(await run("window.skinProbe.decode()"), true);
    await delay(300);
    const video = await run("window.skinProbe.snapshot()");
    assert.equal(video.length, 2);
    assert.ok(video.every(item => !item.paused && item.muted && item.loop && item.readyState >= 2 && !item.error), JSON.stringify(video));
    assert.equal(await run("CSS.supports('clip-path', getComputedStyle(document.querySelector('#frame .terminal-skin-media')).clipPath)"), true);
    const frameRect = await run("(() => { const r = document.querySelector('#frame').getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),width:320,height:200}; })()");
    // Two native compositor captures must show moving borders, not a frozen canvas copy.
    const first = (await window.webContents.capturePage(frameRect)).toBitmap();
    let second = first;
    for (let tries = 0; tries < 15 && first.equals(second); tries++) {
      await delay(100);
      second = (await window.webContents.capturePage(frameRect)).toBitmap();
    }
    assert.notDeepEqual(first, second, "animated border must change on screen");
    // Output region stays identical while the border moves.
    const center = bytes => { const result = []; for (let y = 35; y < 170; y++) result.push(bytes.subarray((y * 320 + 30) * 4, (y * 320 + 290) * 4)); return Buffer.concat(result); };
    assert.deepEqual(center(first), center(second), "animation must not cover terminal text");
    await writeFile(join(output, "live-skins.png"), (await window.webContents.capturePage()).toPNG());
    await run("window.skinProbe.pause(true)");
    await delay(150);
    const paused = await run("window.skinProbe.snapshot()");
    assert.ok(paused.every(item => item.paused));
    assert.equal(await run("Boolean(document.querySelector('#frame [data-skin-media] canvas'))"), true, "frame animation respects the pause setting");
    await delay(150);
    assert.deepEqual(await run("window.skinProbe.snapshot().map(v => v.currentTime)"), paused.map(v => v.currentTime));
    await run("window.skinProbe.pause(false)");
    await delay(150);
    assert.ok((await run("window.skinProbe.snapshot()")).every(item => !item.paused));
    await run("window.skinProbe.offscreen(true)");
    await delay(150);
    assert.ok((await run("window.skinProbe.snapshot()")).every(item => item.paused), "offscreen media pauses");
    await run("window.skinProbe.offscreen(false)");
    await delay(150);
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await delay(150);
    assert.ok((await run("window.skinProbe.snapshot()")).every(item => item.paused), "system motion preference pauses media");
    assert.equal(await run("document.querySelectorAll('[data-skin-media] canvas').length"), 2, "animated images become still frames");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
    window.webContents.debugger.detach();
    await delay(150);
    window.hide();
    await delay(700);
    assert.ok((await run("window.skinProbe.snapshot()")).every(item => item.paused), "hidden window pauses media");
    assert.deepEqual(errors, [], "no renderer errors or CSP violations");
    const report = { result: "passed", formats: ["H.264 MP4", "VP9 WebM", "animated WebP", "APNG"], checks: ["actual React components", "production media CSP", "moving frame pixels", "terminal aperture unchanged", "video silent and looping", "pause/resume", "hidden-window pause", "offscreen pause", "reduced motion"], errors };
    await writeFile(join(output, "verification.json"), JSON.stringify(report, null, 2));
    console.log("LIVE_SKINS_SMOKE_OK " + JSON.stringify(report));
    stopObserving();
    window.destroy();
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
}
