/** Opt-in acceptance probe. Only runs in an explicitly selected local alpha test profile. */
import { app, type BrowserWindow } from "electron";
import { HOME_GRID_CELL_WIDTH, HOME_GRID_GAP, IPC } from "../../shared/contracts";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
export async function runHomeLabSmoke(window: BrowserWindow, output: string): Promise<void> {
  if (!isAbsolute(output)) throw new Error("Lab smoke output must be absolute.");
  await mkdir(output, { recursive: true });
  const run = async <T = any>(source: string): Promise<T> => {
    try { return await window.webContents.executeJavaScript(source); }
    catch (error) { throw new Error(`Home probe expression failed: ${source.slice(0, 500)}`, { cause: error }); }
  };
  const apply = async (patch: Record<string, unknown>): Promise<void> => {
    const settings = await run(`window.canvasTTY.settings.update(${JSON.stringify(patch)})`);
    window.webContents.send(IPC.settingsChanged, settings);
    await new Promise(resolve => setTimeout(resolve, 120));
  };
  const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (source: string, message: string): Promise<void> => {
    for (let i = 0; i < 120; i++) { if (await run(source)) return; await wait(75); }
    throw new Error(message);
  };
  const click = async (selector: string): Promise<void> => {
    const target = `document.querySelector(${JSON.stringify(selector)})`;
    if (await run(`Boolean(${target}?.disabled)`)) console.log("HOME_PROBE_WAIT_ENABLED", selector);
    await until(`Boolean(${target} && !${target}.disabled)`, `Control not ready: ${selector}`);
    await run(`${target}.click()`); await wait(100);
  };
  const settingsButton = ".home-zone .settings-button";
  const avatarMove = "document.querySelector('.home-widget-slot:has(.mini-media) .home-widget-slot__move')";
  const openHomeEditor = async (): Promise<void> => {
    await click(settingsButton);
    await click("#settings-tab-appearance");
    await click(".home-appearance-settings .setting-inline-action");
    await until(`Boolean(document.querySelector('.home-editor-toolbar') && ${avatarMove})`, "Home editor controls missing");
  };
  await until("Boolean(document.querySelector('.mini-media [data-skin-media=gif] img')?.complete && document.querySelector('.clock-tile [data-skin-media=gif] img')?.complete)", "Home media missing");
  const original = await run("window.canvasTTY.settings.get()");
  const checks: string[] = [];
  const motion = async (selector: string): Promise<void> => {
    const rect = await run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x:Math.round(r.x)+3, y:Math.round(r.y)+3, width:Math.max(1,Math.round(r.width)-6), height:Math.max(1,Math.round(r.height)-6) }; })()`);
    const first = (await window.webContents.capturePage(rect)).toBitmap();
    for (let i = 0; i < 32; i++) { await wait(125); if (!first.equals((await window.webContents.capturePage(rect)).toBitmap())) return; }
    throw new Error(`No changing GIF pixels: ${selector}`);
  };
  await wait(500); await motion(".mini-media"); await motion(".clock-tile__background");
  checks.push("separate avatar and clock GIF pixels animate in actual renderer");
  const geometry = [];
  for (const [width, height] of [[1440, 1000], [1100, 800], [920, 680]]) {
    window.setSize(width, height); await wait(250);
    for (const scale of [0.85, 1, 1.25]) {
      await apply({ uiScale: scale });
      await click('[aria-label="Домой"]');
      const result = await run(`(() => {
        const canvas = document.querySelector('.workspace').getBoundingClientRect();
        const selectors = ['.clock-tile__time','.clock-tile__configure','.home-timers__start','.home-timers article:nth-child(2) .home-timers__start','.launcher-button--browser','.launcher-button--files','.mini-media',${JSON.stringify(settingsButton)}];
        return selectors.map(selector => { const e = document.querySelector(selector); if (!e) return {selector,error:'missing'};
          const r=e.getBoundingClientRect(); const p=e.closest('.home-widget-slot')?.getBoundingClientRect() ?? canvas;
          const hit = document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); const reachable = e.tagName!=='BUTTON' || e.contains(hit);
          return {selector,reachable,x:r.x,y:r.y,width:r.width,height:r.height, fits:r.width>0 && r.height>0 && r.left>=p.left-1 && r.top>=p.top-1 && r.right<=p.right+1 && r.bottom<=p.bottom+1 && r.left>=canvas.left-1 && r.top>=canvas.top-1 && r.right<=canvas.right+1 && r.bottom<=canvas.bottom+1}; }); })()`);
      if (result.some((item: any) => !item.fits || !item.reachable)) throw new Error(`Home geometry ${width}x${height}@${scale}: ${JSON.stringify(result)}`);
      geometry.push({ width, height, scale, elements: result });
      await writeFile(join(output, `home-${width}-${height}-${scale}.png`), (await window.webContents.capturePage()).toPNG());
    }
  }
  checks.push("9 window-size/UI-scale combinations: actual text and control bounds");
  await apply({ uiScale: 1 }); window.setSize(1440, 1000); await wait(200); await click('[aria-label="Домой"]');
  // The default avatar has four columns. Shrink one, then drag it one column right at actual canvas scale.
  await openHomeEditor();
  // Use the widget ID-independent slot lookup because focus IDs are implementation details.
  await run(`${avatarMove}.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',shiftKey:true,bubbles:true}))`); await wait(100);
  const columnStep = HOME_GRID_CELL_WIDTH + HOME_GRID_GAP;
  const drag = await run(`(() => {const e=${avatarMove}; const r=e.getBoundingClientRect(); const zone=document.querySelector('.home-zone');return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),dx:Math.round(zone.getBoundingClientRect().width / zone.offsetWidth * ${columnStep})};})()`);
  window.webContents.sendInputEvent({ type: "mouseMove", x: drag.x, y: drag.y });
  window.webContents.sendInputEvent({ type: "mouseDown", x: drag.x, y: drag.y, button: "left", clickCount: 1 });
  window.webContents.sendInputEvent({ type: "mouseMove", x: drag.x + drag.dx, y: drag.y, movementX: drag.dx, movementY: 0 });
  window.webContents.sendInputEvent({ type: "mouseUp", x: drag.x + drag.dx, y: drag.y, button: "left", clickCount: 1 });
  await wait(200);
  await writeFile(join(output, "home-editor.png"), (await window.webContents.capturePage()).toPNG());
  await click('.home-editor-toolbar__done');
  const changed = await run("window.canvasTTY.settings.get()");
  const avatar = changed.homeLayout.find((item: any) => item.widgetId === "core.media");
  const before = original.homeLayout.find((item: any) => item.widgetId === "core.media");
  if (avatar.columnSpan !== before.columnSpan - 1 || avatar.column !== before.column + 1) throw new Error(`Scaled drag/keyboard resize did not persist: ${JSON.stringify(avatar)}`);
  checks.push("keyboard resize and mouse drag at canvas zoom persist via Save");
  await openHomeEditor();
  await run(`${avatarMove}.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',shiftKey:true,bubbles:true}))`);
  await click('.home-editor-toolbar > button:first-of-type');
  const afterCancel = await run("window.canvasTTY.settings.get()");
  if (JSON.stringify(afterCancel.homeLayout) !== JSON.stringify(changed.homeLayout)) throw new Error("Cancel changed saved layout");
  checks.push("Cancel discards draft resize and preserves saved layout");
  await apply({ homeLayout: original.homeLayout, uiScale: 1 }); await wait(100);
  // Quick start, pause/resume/reset and a short real deadline, independently from the user's seeded timers.
  await click('.home-timers__presets button');
  let time = await run("window.canvasTTY.settings.get().then(s=>s.homeTime)");
  const quick = time.timers.at(-1);
  if (time.timers.length !== original.homeTime.timers.length + 1 || quick.status !== "running") throw new Error("Quick timer did not start");
  const timerSelector = `[data-timer-id="${quick.id}"]`;
  await click(`${timerSelector} .home-timers__start`);
  time = await run("window.canvasTTY.settings.get().then(s=>s.homeTime)");
  await until("window.canvasTTY.settings.get().then(s=>s.homeTime.timers.at(-1)?.status==='paused')", "Timer pause failed");
  await click(`${timerSelector} .home-timers__start`);
  await click(`${timerSelector} [aria-label^="Сбросить"]`);
  time = await run("window.canvasTTY.settings.get().then(s=>s.homeTime)");
  await until("window.canvasTTY.settings.get().then(s=>s.homeTime.timers.at(-1)?.status==='idle')", "Timer reset failed");
  const short = { ...quick, durationMs: 2000, remainingMs: 2000, status: "running", endsAt: Date.now() + 2000 };
  await apply({ homeTime: { ...time, timers: [...time.timers.slice(0, -1), short] } });
  await until(`document.querySelector(${JSON.stringify(timerSelector)})?.dataset.timerStatus==='done'`, "Timer did not complete");
  checks.push("quick timer start/pause/resume/reset and actual deadline completion");
  await apply({ homeTime: original.homeTime });
  // Exercise the existing clock editor through its actual controls and persisted settings.
  await click('.clock-tile__configure');
  await until("Boolean(document.querySelector('.home-time-editor[open]'))", "Clock editor missing");
  const clockTheme = await run("(() => {const e=document.querySelector('.home-time-editor');return {inApp:Boolean(e.closest('.app')),background:getComputedStyle(e).backgroundColor,surface:getComputedStyle(document.querySelector('.app')).getPropertyValue('--surface').trim()}})()");
  if (!clockTheme.inApp || clockTheme.background === 'rgba(0, 0, 0, 0)') throw new Error('Clock editor lost the app theme');
  await writeFile(join(output, "clock-settings.png"), (await window.webContents.capturePage()).toPNG());
  await click('.home-time-editor__options label:nth-child(1) input');
  await click('.home-time-editor__options label:nth-child(2) input');
  await click('.home-time-editor__save');
  await until("!document.querySelector('.home-time-editor')", "Clock editor failed to save");
  const clockSaved = await run("window.canvasTTY.settings.get().then(s=>s.homeTime)");
  if (clockSaved.hour12 !== !original.homeTime.hour12 || clockSaved.showSeconds !== !original.homeTime.showSeconds) throw new Error("Clock format options did not persist");
  await click('.clock-tile__configure');
  await until("Boolean(document.querySelector('.home-time-editor[open]'))", "Clock editor failed to reopen");
  if (!(await run(`document.querySelector('.home-time-editor__options label:nth-child(1) input').checked === ${clockSaved.hour12} && document.querySelector('.home-time-editor__options label:nth-child(2) input').checked === ${clockSaved.showSeconds}`))) throw new Error("Reopened clock controls lost their values");
  await click('.home-time-editor header button');
  await apply({ homeTime: original.homeTime });
  checks.push("clock 12/24-hour and seconds controls save and reopen with persisted values");
  if (await run("Boolean(document.querySelector('.launcher-button--apps'))")) throw new Error("Canceled App Windows launcher remains");
  if ((await run("window.canvasTTY.plugins.list()")).some((plugin: any) => plugin.manifest.id === "com.canvastty.app-windows")) throw new Error("Canceled App Windows plugin remains in alpha profile");
  checks.push("canceled App Windows launcher and bundled plugin absent");
  // Core Files uses the same card as the canvas context menu, with no plugin dependency.
  await writeFile(join(output, "acceptance-note.md"), "# Canvas Files\nCANVAS_CORE_FILE_OK\n");
  const shell = await run(`window.canvasTTY.terminal.create(${JSON.stringify({ provider: "terminal", profile: "normal", cwd: output, position: { x: 2400, y: 40 } })})`);
  try {
    await run(`window.canvasTTY.terminal.rename(${JSON.stringify(shell.id)}, "Files acceptance shell")`);
    await click('.launcher-button--files');
    await until("Boolean(document.querySelector('.file-browser-card__path input')?.value && document.querySelector('.file-browser-card__places button'))", "Files dock did not open Home with filesystem locations");
    const cardId = await run("document.querySelector('.file-browser-card').dataset.fileCardId");
    await until("Boolean(document.querySelector('.file-browser-card__session-options [title=\"Files acceptance shell\"]'))", "Session folder option missing");
    await click('.file-browser-card__session-options [title="Files acceptance shell"]');
    await until("Boolean(document.querySelector('.file-browser-card__tree-row[title=\"acceptance-note.md\"]'))", "Core directory listing failed");
    await click('.file-browser-card__tree-row[title="acceptance-note.md"]');
    await until("document.querySelector('.file-browser-card__viewer')?.textContent.includes('CANVAS_CORE_FILE_OK')", "Core file preview failed");
    await writeFile(join(output, "core-files.png"), (await window.webContents.capturePage()).toPNG());
    if (process.env.CANVASTTY_CORE_FILES_LAB === "1") {
      const { runCoreFilesLabSmoke } = await import("./CoreFilesLabSmoke");
      checks.push(...await runCoreFilesLabSmoke(window, output));
    }
    await click('[aria-label="Домой"]');
    await click('.launcher-button--files');
    await until(`document.querySelector('.file-browser-card')?.dataset.fileCardId === ${JSON.stringify(cardId)}`, "Files dock lost the existing card");
    const cards = await run("window.canvasTTY.settings.get().then(s=>s.fileCards)");
    if (cards.length !== original.fileCards.length + 1) throw new Error("Files dock duplicated a card");
    await click('.file-browser-card__close');
    await until("!document.querySelector('.file-browser-card')", "Core Files card did not close");
    checks.push("Files dock opens built-in browser, registers real terminal cwd, previews Markdown, reuses and closes the same card");
  } finally {
    await run(`window.canvasTTY.terminal.dispose(${JSON.stringify(shell.id)})`);
  }
  if (process.env.CANVASTTY_FILES_LAB_ROOT) {
    const { runFileExplorerLabSmoke } = await import("./FileExplorerLabSmoke");
    checks.push(...await runFileExplorerLabSmoke(window, output));
  }
  await click('[aria-label="Домой"]'); await wait(300);
  await writeFile(join(output, "live-home-app.png"), (await window.webContents.capturePage()).toPNG());
  if (process.env.CANVASTTY_V2_LAB_SMOKE === "1") {
    const { runV2LabSmoke } = await import("./V2LabSmoke");
    checks.push(...await runV2LabSmoke(window, output));
  }
  const report = { result: "passed", app: app.getName(), version: app.getVersion(), packaged: app.isPackaged, profile: app.getPath("userData"), checks, geometry };
  await writeFile(join(output, "verification.json"), JSON.stringify(report, null, 2));
  console.log("CANVASTTY_HOME_LAB_OK " + JSON.stringify({ ...report, geometry: geometry.length }));
  app.quit();
}
