import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runElectronSmoke } from "./lib/run-electron-smoke.mjs";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const self = fileURLToPath(import.meta.url);
const electron = createRequire(import.meta.url)("electron");
const marker = "CANVASTTY_PLUGIN_REVIEW_ELECTRON_OK";

if (typeof electron === "string") {
  const root = await mkdtemp("/private/tmp/ctv-review-");
  const userData = join(root, "data");
  const home = join(root, "home");
  const project = join(root, "project");
  const pluginWorktrees = join(userData, "plugin-data", "canvastty-environments", "worktrees");
  await Promise.all([mkdir(home), mkdir(userData, { recursive: true }), mkdir(project, { recursive: true }), mkdir(pluginWorktrees, { recursive: true, mode: 0o700 })]);
  const fixture = await createFixture({ root, userData, project, pluginWorktrees });
  const environment = {
    HOME: home, PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    TMPDIR: process.env.TMPDIR || "/private/tmp", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    SHELL: fixture.shell, CANVASTTY_USER_DATA_DIR: userData,
    CANVASTTY_PLUGIN_REVIEW_FIXTURE: JSON.stringify(fixture)
  };
  try {
    const { errorOutput } = await runElectronSmoke(electron, self, environment, marker);
    assert.doesNotMatch(errorOutput, /Terminal output history is (?:shutting down|closed)/u,
      "ordinary application shutdown does not warn for canceled background history updates");
    await verifyCleanup(fixture);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
} else {
  let ran = false;
  electron.app.on("browser-window-created", (_event, window) => {
    window.webContents.once("did-finish-load", async () => {
      if (ran) return;
      ran = true;
      try {
        const result = await window.webContents.executeJavaScript(
          `(${probe.toString()})(${process.env.CANVASTTY_PLUGIN_REVIEW_FIXTURE})`, true
        );
        console.log(marker + " " + JSON.stringify(result));
        electron.app.quit();
      } catch (error) {
        console.error("Plugin review smoke failed:", error);
        electron.app.exit(1);
      }
    });
  });
  // Keep the actual main, preload, plugin supervisor, IPC validation and renderer in this test.
  void import(pathToFileURL(join(repo, "out/main/index.js")).href);
}

async function createFixture({ root, userData, project, pluginWorktrees }) {
  const pluginSource = resolve(repo, "../canvastty-work/canvastty-plugin-environments");
  const sourceManifestPath = join(pluginSource, "canvastty.plugin.json");
  const manifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
  const resultsModule = manifest.modules.find(module => module.id === "results");
  const worktreeModule = manifest.modules.find(module => module.id === "worktree");
  const resultsService = manifest.services.find(service => service.id === "results");
  const worktreeService = manifest.services.find(service => service.id === "worktree");
  assert.ok(resultsModule && worktreeModule && resultsService && worktreeService, "the environments plugin declares its results and worktree modules and services");
  const serviceAsset = resultsModule.files.find(file => file.path === resultsService.entry);
  assert.ok(serviceAsset, "the results service entry is a declared module asset");
  assert.ok(worktreeModule.files.some(file => file.path === worktreeService.entry), "the worktree service entry is a declared module asset");

  const installedPlugin = join(userData, "plugins", manifest.id);
  const metadataDir = join(installedPlugin, "metadata");
  await mkdir(metadataDir, { recursive: true });
  await copyFile(sourceManifestPath, join(metadataDir, "canvastty.plugin.json"));
  const selectedModules = [resultsModule.id, worktreeModule.id];
  const selectedAssets = [...(manifest.coreFiles ?? []), ...resultsModule.files, ...worktreeModule.files];
  for (const asset of selectedAssets) {
    const source = join(pluginSource, ...asset.path.split("/"));
    const destination = join(installedPlugin, ...asset.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const bytes = await readFile(destination);
    assert.equal(bytes.length, asset.bytes, `fixture plugin asset length: ${asset.path}`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256, `fixture plugin asset hash: ${asset.path}`);
  }
  const serviceHash = async service => createHash("sha256").update(await readFile(join(installedPlugin, ...service.entry.split("/")))).digest("hex");
  await writeFile(join(userData, "plugins.json"), JSON.stringify({
    [manifest.id]: {
      sourceUrl: "https://github.com/BIackFIame/canvastty-plugin-environments.git",
      enabled: true,
      installedAt: Date.now(),
      selectedModules,
      enabledHooks: [],
      // This disposable fixture trusts only the local worktree and results services; no router, SSH, or hooks run.
      trustedServices: {
        [resultsService.id]: await serviceHash(resultsService),
        [worktreeService.id]: await serviceHash(worktreeService)
      }
    }
  }, null, 2));

  await writeFile(join(project, "shared.txt"), "SHARED=BASE\n");
  await writeFile(join(project, "kept.txt"), "BASE=KEEP\n");
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  await git(project, "config", "user.name", "CanvasTTY Fixture");
  await git(project, "config", "user.email", "fixture@example.invalid");
  await git(project, "add", "shared.txt", "kept.txt");
  await commit(project, "fixture base");
  const base = (await git(project, "rev-parse", "HEAD")).trim();

  const oneDir = join(pluginWorktrees, "project-review-agent-one");
  const twoDir = join(pluginWorktrees, "project-review-agent-two");
  await git(project, "worktree", "add", "--quiet", "-b", "fixture-agent-one", oneDir, base);
  await git(project, "worktree", "add", "--quiet", "-b", "fixture-agent-two", twoDir, base);
  await Promise.all([
    writeFile(join(oneDir, "shared.txt"), "SHARED=AGENT_ONE\n"),
    writeFile(join(oneDir, "unique-one.txt"), "UNIQUE=AGENT_ONE\n"),
    writeFile(join(oneDir, "unselected-one.txt"), "UNSELECTED=AGENT_ONE\n"),
    writeFile(join(twoDir, "shared.txt"), "SHARED=AGENT_TWO\n"),
    writeFile(join(twoDir, "unique-two.txt"), "UNIQUE=AGENT_TWO\n")
  ]);
  for(let index=0;index<150;index++)await writeFile(join(oneDir,`large-${String(index).padStart(3,'0')}.txt`),
    Array.from({length:index===0 ? 5002 : 40},(_,line)=>`LARGE_PROOF_${index}_${line}`).join('\n')+'\n');
  const shell=join(root,'review-echo-shell');
  const shellQuote=value=>`'${value.replaceAll("'","'\\''")}'`;
  await writeFile(shell,`#!/bin/sh\nprintf 'REVIEW_REFRESH_READY\\n'\nwhile IFS= read -r line; do\n  if [ "$line" = 'REFRESH_PROOF' ]; then\n    printf 'REFRESH_PROOF\\n' > ${shellQuote(join(oneDir,'refresh-one.txt'))}\n    exit 0\n  fi\ndone\n`,{mode:0o700});
  await writeFile(join(project, "shared.txt"), "SHARED=CURRENT\n");
  await git(project, "add", "shared.txt");
  await commit(project, "fixture current version");

  const baseSession = {
    provider: "codex", profile: "normal", titleCustomized: true, cwd: project,
    size: { width: 600, height: 420 }, lastState: "exited", exitCode: 0, restore: true
  };
  const worktreeRef = (dir, branch) => ({
    repo: project, dir, branch, createdBranch: true, sub: "", base, baseBranch: "main"
  });
  await writeFile(join(userData, "terminal-sessions.json"), JSON.stringify({ version: 2, sessions: [
    { ...baseSession, id: "review-parent", title: "Review fixture", role: "orchestrator", position: { x: 80, y: 60 } },
    { ...baseSession, id: "review-agent-one", title: "Agent one", role: "subagent", parentSessionId: "review-parent",
      position: { x: 720, y: 60 }, environment: { pluginId: manifest.id, kind: "worktree", label: "Fixture worktree", ref: worktreeRef(oneDir, "fixture-agent-one") } },
    { ...baseSession, id: "review-agent-two", title: "Agent two", role: "subagent", parentSessionId: "review-parent",
      position: { x: 720, y: 520 }, environment: { pluginId: manifest.id, kind: "worktree", label: "Fixture worktree", ref: worktreeRef(twoDir, "fixture-agent-two") } }
  ] }));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ locale: "en", sessionRestoreMode: "continue" }));
  return {
    shell,
    project,
    parentId: "review-parent",
    agentOneId: "review-agent-one",
    agentTwoId: "review-agent-two",
    worktreeDirs: [oneDir, twoDir]
  };
}

async function verifyCleanup(fixture) {
  assert.equal(await readFile(join(fixture.project, "unique-one.txt"), "utf8"), "UNIQUE=AGENT_ONE\n",
    "the selected clean file was accepted into the generated project");
  assert.equal(await readFile(join(fixture.project, "shared.txt"), "utf8"), "SHARED=AGENT_ONE\n",
    "the explicitly selected conflict side was accepted into the generated project");
  for (const rejectedPath of ["unselected-one.txt", "unique-two.txt", "refresh-one.txt", "large-000.txt"]) {
    await assert.rejects(readFile(join(fixture.project, rejectedPath)), { code: "ENOENT" }, `${rejectedPath} was not accepted`);
  }
  const worktrees = git(fixture.project, "worktree", "list", "--porcelain");
  for (const dir of fixture.worktreeDirs) {
    await assert.rejects(stat(dir), { code: "ENOENT" }, `finished source worktree removed: ${dir}`);
    assert.ok(!worktrees.includes(`worktree ${dir}\n`), `git no longer registers source worktree ${dir}`);
  }
  assert.equal(git(fixture.project, "branch", "--list", "fixture-agent*").trim(), "", "full task rejection deletes both source branches");
  assert.equal(git(fixture.project, "branch", "--list", "canvastty/*").trim(), "", "full task rejection deletes every collected branch");
  assert.equal(git(fixture.project, "status", "--porcelain").trim(), "", "review and reject leave the project checkout clean");
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function commit(cwd, message) {
  return execFileSync("git", ["-c", "user.name=CanvasTTY Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "core.hooksPath=/dev/null", "commit", "-qm", message], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function probe(fixture) {
  const checks = [];
  const check = (condition, name) => { if (!condition) throw new Error(name); checks.push(name); };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (condition, name, timeoutMs = 15_000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const value = await condition();
      if (value) return value;
      await delay(50);
    }
    throw new Error(`Timed out: ${name}; review state: ${document.querySelector('.plugin-changes-review')?.textContent?.slice(-4000) ?? 'no dialog'}`);
  };
  const api = await until(() => window.canvasTTY, "preload API");
  await until(async () => (await api.terminal.list()).some(row => row.id === fixture.parentId), "restored orchestrator card");
  const decorations = await until(async () => {
    const value = await api.plugins.cardDecorations();
    return value.actions.some(action => action.pluginId === "canvastty-environments" && action.actionId === "review-task-changes") ? value : null;
  }, "trusted environments plugin card actions");
  check(decorations.actions.some(action => action.actionId === "reject-task-changes"), "actual installed results service publishes task review and reject actions");

  const openReview = async () => {
    // Lazy terminal loading renders a card placeholder before its real controls are available.
    const options = await until(() => document.querySelector(`[data-session-id="${fixture.parentId}"] .terminal-card__action--options`), "orchestrator options menu");
    options.focus();
    options.click();
    const item = await until(() => [...document.querySelectorAll(".terminal-card__menu-action")]
      .find(button => button.textContent?.trim() === "Review task changes"), "review task card action");
    item.click();
    return until(() => document.querySelector('.plugin-changes-review[role="dialog"]'), "task review dialog");
  };

  let dialog = await openReview();
  check(dialog.getAttribute("aria-modal") === "true", "review opens as a modal dialog through the card UI");
  const picker = await until(() => dialog.querySelector(".plugin-changes-review__group-picker select"), "two-agent group picker");
  check(picker.options.length === 2, "core review groups both finished subagents");
  const initialAgentOne = [...picker.options].find(option => option.value === fixture.agentOneId);
  if (!initialAgentOne) throw new Error("Agent one is absent from the core task review");
  picker.value = fixture.agentOneId;
  picker.dispatchEvent(new Event("change", { bubbles: true }));
  const names = () => [...dialog.querySelectorAll(".plugin-changes-review__files code")].map(node => node.textContent.trim());
  const findFileRow=async(path,currentDialog)=>{
    const list=currentDialog.querySelector('.plugin-changes-review__files');
    if(!list)throw new Error('No virtual file list');
    for(let top=0;top<=list.scrollHeight;top+=Math.max(56,list.clientHeight)){
      list.scrollTop=top;list.dispatchEvent(new Event('scroll',{bubbles:true}));
      await delay(20);
      const row=[...list.querySelectorAll('li[data-file-path]')].find(node=>node.dataset.filePath===path);
      if(row)return row;
    }
    throw new Error(`Missing reviewed file: ${path}`);
  };
  await until(()=>dialog.querySelector('.plugin-changes-review__files')?.dataset.totalFiles==='153','large agent-one review');
  check(names().length<40,'more than 5,000 diff lines use a virtual file list with bounded DOM rows');
  check([...picker.options].some(option => option.textContent.includes("Agent two")), "agent group selector names both subagents");
  const largeRow=await findFileRow('large-000.txt',dialog);
  (await until(()=>{const button=largeRow.querySelector('.plugin-changes-review__file-open');return button&&!button.disabled?button:null;},'large file navigation ready')).click();
  await until(()=>dialog.querySelector('.plugin-changes-review__diff')?.textContent.includes('LARGE_PROOF_0_0'),'large diff first page');
  check(!dialog.querySelector('.plugin-changes-review__diff').textContent.includes('LARGE_PROOF_0_5001'),'5,002-line diff loads only a bounded first page');
  const sharedRow=await findFileRow('shared.txt',dialog);
  (await until(()=>{const button=sharedRow.querySelector('.plugin-changes-review__file-open');return button&&!button.disabled?button:null;},'conflict file navigation ready')).click();
  const conflictSides = await until(()=>{
    const sides=[...dialog.querySelectorAll('.plugin-changes-review__version pre')].map(node=>node.textContent);
    return sides.some(value=>value.includes('SHARED=AGENT_ONE'))&&sides.some(value=>value.includes('SHARED=AGENT_TWO')) ? sides : null;
  },'shared-path conflict sides');
  check(conflictSides.some(value => value.includes("SHARED=AGENT_ONE")) && conflictSides.some(value => value.includes("SHARED=AGENT_TWO")),
    "review shows current and agent sides for the actual cross-agent conflict");
  const acceptAllTask = [...dialog.querySelectorAll(".plugin-changes-review__actions button")].find(button => button.textContent.includes("Accept the full task result"));
  check(Boolean(acceptAllTask?.disabled), "task-wide accept is disabled while the reviewed agents have conflicts");
  const trigger=await api.terminal.create({provider:'terminal',profile:'normal',cwd:fixture.project,role:'subagent',parentSessionId:fixture.parentId,title:'Refresh trigger',position:{x:1400,y:60}});
  await until(async()=> (await api.terminal.readBuffer(trigger.id)).buffer.includes('REVIEW_REFRESH_READY'),'live refresh child ready');
  api.terminal.input(trigger.id,'REFRESH_PROOF\r');
  await until(()=>dialog.querySelector('.plugin-changes-review__files')?.dataset.totalFiles==='154','open review refreshes after child completion');
  check(true,'already-open review recollects a newly changed file when a real child PTY completes');
  await api.terminal.dispose(trigger.id);

  await until(()=>!dialog.querySelector('.plugin-changes-review__busy'),'completion refresh settled');
  const conflictPreview=await api.plugins.invokeCardAction('canvastty-environments','review-task-changes',fixture.parentId,
    {agentSessionId:fixture.agentOneId,file:'shared.txt',page:0});
  check(Boolean(conflictPreview.review?.groups.some(group=>group.files.some(file=>file.path==='shared.txt'&&file.page===0))),
    'actual plugin records the conflict diff page before mutation attempts');
  const noSuchFile = await api.plugins.invokeCardAction("canvastty-environments", "accept-task-changes", fixture.parentId,
    { agentSessionId: fixture.agentOneId, files: ["never-reviewed.txt"] });
  check(noSuchFile.tone === "error" && /Review and open the selected file diffs/u.test(noSuchFile.message ?? ""), `core RPC refuses a file absent from the current review: ${JSON.stringify(noSuchFile)}`);
  const unresolved = await api.plugins.invokeCardAction("canvastty-environments", "accept-task-changes", fixture.parentId,
    { agentSessionId: fixture.agentOneId, files: ["shared.txt"] });
  check(unresolved.tone === "error" && /Choose the current or agent version/u.test(unresolved.message ?? ""), "core RPC refuses an unresolved conflict");

  const selectOnly = async (selectedPath, currentDialog) => {
    const clear=await until(()=>[...currentDialog.querySelectorAll('.plugin-changes-review__file-selection button')].find(node=>node.textContent==='Clear selection'&&!node.disabled),'clear file selection');
    clear.click();
    const row=await findFileRow(selectedPath,currentDialog);
    row.querySelector('input[type="checkbox"]').click();
    row.querySelector('.plugin-changes-review__file-open').click();
  };
  const dialogFocus = await until(() => dialog.contains(document.activeElement) ? document.activeElement : null, "focus enters review dialog");
  check(Boolean(dialogFocus), "opening review moves keyboard focus into the modal");
  const focusables = () => [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled])")]
    .filter(element => !element.hidden && element.getClientRects().length > 0);
  const first = focusables()[0], last = focusables().at(-1);
  last.focus();
  last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  check(document.activeElement === first, "Tab from the last review control wraps to the first control");
  first.focus();
  first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  check(document.activeElement === last, "Shift+Tab from the first review control wraps to the last control");
  last.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await until(() => !document.querySelector(".plugin-changes-review"), "Escape closes review");
  await until(() => document.querySelector(`[data-session-id="${fixture.parentId}"]`)?.contains(document.activeElement), "focus returns to the originating card");
  check(true, "Escape closes the dialog and restores focus to the orchestrator card");

  dialog = await openReview();
  await until(()=>dialog.querySelector('.plugin-changes-review__files')?.dataset.totalFiles==='154','reopened review files');
  await selectOnly("unique-one.txt", dialog);
  const acceptSelected = [...dialog.querySelectorAll(".plugin-changes-review__actions button")]
    .find(button => button.textContent.includes("Accept selected files"));
  await until(() => acceptSelected && !acceptSelected.disabled, "one clean file becomes selectable for acceptance");
  check(true, "per-file accept becomes available after selecting one clean file");
  acceptSelected.click();
  const confirm = await until(() => dialog.querySelector('.plugin-changes-review__confirm[role="alertdialog"]'), "per-file confirmation dialog");
  check(confirm.textContent.includes("Accept the selected files"), "per-file accept requires explicit confirmation");
  confirm.querySelector("button")?.click();
  await until(() => !document.querySelector(".plugin-changes-review"), "selected file acceptance completes");
  const acceptedToast = await until(() => [...document.querySelectorAll(".terminal-card__toast")]
    .find(node => node.textContent.includes("Accepted 1 selected file")), "per-file acceptance result");
  check(Boolean(acceptedToast), "renderer reports that the selected file was accepted");

  dialog = await openReview();
  const groupPicker = await until(() => dialog.querySelector(".plugin-changes-review__group-picker select"), "reopened group picker");
  const oneOption = [...groupPicker.options].find(option => option.value === fixture.agentOneId);
  if (oneOption) groupPicker.value = fixture.agentOneId;
  groupPicker.dispatchEvent(new Event("change", { bubbles: true }));
  await until(()=>dialog.querySelector('.plugin-changes-review__files'),'agent-one conflict file');
  await selectOnly("shared.txt", dialog);
  const agentChoice = await until(() => [...dialog.querySelectorAll('.plugin-changes-review__version input[type="radio"]')]
    .find(input => input.value === "agent"), "agent conflict resolution choice");
  agentChoice.click();
  const acceptConflict = [...dialog.querySelectorAll(".plugin-changes-review__actions button")]
    .find(button => button.textContent.includes("Accept selected files"));
  await until(() => acceptConflict && !acceptConflict.disabled, "selected conflict becomes acceptable after resolution");
  check(true, "choosing the agent conflict side enables per-file accept");
  acceptConflict.click();
  await until(() => dialog.querySelector(".plugin-changes-review__confirm"), "conflict accept confirmation");
  dialog.querySelector(".plugin-changes-review__confirm button")?.click();
  await until(() => !document.querySelector(".plugin-changes-review"), "chosen conflict acceptance completes");
  await until(() => [...document.querySelectorAll(".terminal-card__toast")]
    .some(node => node.textContent.includes("Accepted 1 selected file")), "chosen conflict acceptance result");
  check(true, "renderer reports completion of the explicitly chosen conflict side");

  dialog = await openReview();
  const rejectTask = await until(() => [...dialog.querySelectorAll(".plugin-changes-review__actions button")]
    .find(button => button.textContent.includes("Reject the full task result") && !button.disabled), "task-wide reject action");
  rejectTask.click();
  const rejectConfirmation = await until(() => dialog.querySelector('.plugin-changes-review__confirm[role="alertdialog"]'), "task reject confirmation");
  check(rejectConfirmation.textContent.includes("finished agent") && rejectConfirmation.textContent.includes("worktree"), "full rejection explains finished worktree cleanup");
  rejectConfirmation.querySelector("button")?.click();
  await until(() => !document.querySelector(".plugin-changes-review"), "full task rejection completes");
  await until(() => [...document.querySelectorAll(".terminal-card__toast")]
    .some(node => node.textContent.includes("Rejected changes from 2 agents")), "full task rejection result");
  check(true, "renderer completes full task rejection and reports both finished agents");
  return {
    checks: checks.length,
    evidence: checks,
    fixture: { project: fixture.project, worktreeDirs: fixture.worktreeDirs },
    scope: "Actual Electron main/preload/renderer and trusted environments results service; generated local Git repo/worktrees only; one inert local shell completion trigger; no paid models, SSH, or customer data."
  };
}
