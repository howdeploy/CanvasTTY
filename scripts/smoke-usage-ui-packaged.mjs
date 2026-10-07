#!/usr/bin/env node
/**
 * PACKAGED renderer smoke test for the usage history overlay.
 *
 * Loads the renderer and preload that ship inside the packaged app (app.asar → out/renderer,
 * out/preload) — not the dev bundle — in a hidden window of the repository's Electron binary.
 * The packaged MAIN process is never started: it pins the live data root, and this test must
 * not touch live state. Instead this harness answers the preload's IPC channels itself:
 * usage history with a labelled fixture, list-style channels with [], the rest with null.
 *
 * The usage history is not handwritten: the Node orchestrator writes synthetic SOURCE logs
 * (Codex rollouts, a Claude transcript) into an isolated home, runs the real LocalUsageCollector
 * inside the real UsageHistoryService, persists, reloads in a fresh service and hands the
 * reloaded history to the harness (scripts/usage-acceptance-fixture.mjs). The harness then drives
 * the packaged renderer (default 24 h / uncached, weight basis "all", period 1 h), scrapes the
 * conditional blocks, and the orchestrator checks exact measured, local and external points,
 * app/profile/session points and their conservation against hand-derived numbers.
 *
 * userData, HOME, source logs, state, logs and caches live in a fresh folder under TMPDIR (or
 * --scratch <dir>); network is blocked. No installed app is launched.
 *
 *   node scripts/smoke-usage-ui-packaged.mjs [--app <path/to/CanvasTTY.app | resources dir>] [--scratch <dir>] [--keep]
 *
 * Run after packaging (npm run package). Exit 0 only when every check passes.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_FLAG = "--packaged-usage-harness";
const USAGE_CHANNEL = "usage-history:get";
const PRIVATE_MARKERS = ["PRIVATE", "fixture-private-cwd"];
const TIMEOUT_MS = 90_000;

if (process.versions.electron && process.argv.includes(HARNESS_FLAG)) void runHarness();
else await runOrchestrator();

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resolveAsar() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const given = argument("--app");
  const candidates = given
    ? [join(given, "Contents", "Resources", "app.asar"), join(given, "app.asar"), given]
    : [
        join(root, "release", "mac-arm64", "CanvasTTY.app", "Contents", "Resources", "app.asar"),
        join(root, "release", "mac", "CanvasTTY.app", "Contents", "Resources", "app.asar"),
        join(root, "release", "linux-unpacked", "resources", "app.asar"),
        join(root, "release", "win-unpacked", "resources", "app.asar")
      ];
  return candidates.map((candidate) => resolve(candidate)).find((candidate) => candidate.endsWith(".asar") && existsSync(candidate)) ?? null;
}

// ---------------------------------------------------------------- Node side

async function runOrchestrator() {
  const { spawn } = await import("node:child_process");
  const asar = resolveAsar();
  if (!asar) {
    console.log("packaged usage UI smoke: FAIL — no packaged app.asar found (run `npm run package` or pass --app)");
    process.exitCode = 1;
    return;
  }
  const keep = process.argv.includes("--keep");
  const scratchRoot = resolve(argument("--scratch") ?? tmpdir());
  await mkdir(scratchRoot, { recursive: true });
  const dir = await mkdtemp(join(scratchRoot, "canvastty-usage-packaged-smoke-"));
  const nodeChecks = [];
  const nodeCheck = (name, ok, detail = "") => { nodeChecks.push({ name, ok: Boolean(ok), detail }); };

  const fixture = await import("./usage-acceptance-fixture.mjs");
  // Real collector → persisted state → reload, all inside `dir`.
  const { isDeepStrictEqual } = await import("node:util");
  const built = await fixture.buildAcceptanceHistory(join(dir, "fixture"));
  const historyFile = join(dir, "fixture", "reloaded-history.json");
  await writeFile(historyFile, JSON.stringify(built.history));
  nodeCheck("fixture: history persisted and reloaded by a fresh UsageHistoryService", built.history.samples.length > 0 && built.history.events.length === 6,
    `${built.history.samples.length} samples, ${built.history.events.length} events`);
  nodeCheck("fixture: reloaded report equals the report before dispose",
    isDeepStrictEqual(built.reloadedReport.providers, built.reference.providers) && isDeepStrictEqual(built.reloadedReport.attribution, built.reference.attribution));
  nodeCheck("fixture: labelled as a test fixture", built.history.coverage.includes(fixture.FIXTURE_LABEL));
  nodeCheck("fixture: no conversation text or working directory left the collector", PRIVATE_MARKERS.every((marker) => !JSON.stringify(built.history).includes(marker)));
  const expectedSessions = [...new Set(built.history.events.map((event) => event.session))];

  const electronBinary = createRequire(import.meta.url)("electron");
  const env = {
    ...process.env, HOME: join(dir, "home"), SMOKE_USAGE_DIR: dir, SMOKE_USAGE_ROOT: scratchRoot, SMOKE_USAGE_ASAR: asar, SMOKE_USAGE_HISTORY: historyFile,
    SMOKE_USAGE_EXPECT_SESSIONS: JSON.stringify(expectedSessions)
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const child = spawn(electronBinary, [fileURLToPath(import.meta.url), HARNESS_FLAG, `--user-data-dir=${join(dir, "userData")}`], {
    cwd: dir, env, stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { if (process.env.SMOKE_VERBOSE) process.stderr.write(chunk); });
  const killer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS + 10_000);
  const code = await new Promise((done) => child.on("exit", (exitCode, signal) => done(signal ? 128 : exitCode ?? 1)));
  clearTimeout(killer);
  const line = stdout.split("\n").find((entry) => entry.startsWith("SMOKE_RESULT "));
  const result = line ? JSON.parse(line.slice("SMOKE_RESULT ".length)) : { ok: false, checks: [], error: "harness produced no result" };

  const states = result.states ?? {};
  const captured = [["24h/uncached", states.initial], ["24h/all", states.weightAll], ["1h/uncached", states.period1h]];
  // Semantic checks of what the packaged renderer displayed, against hand-derived numbers.
  const expected = fixture.expectations();
  const wants = { "24h/uncached": expected["24h"].uncached, "24h/all": expected["24h"].all, "1h/uncached": expected["1h"].uncached };
  const semantic = captured.flatMap(([label, state]) => state
    ? [{ name: `[${label}] controls show this period and weight basis`, ok: state.period === label.split("/")[0] && state.weight === label.split("/")[1], detail: `${state.period}/${state.weight}` },
      ...fixture.checkRenderedState(label, state.blocks, wants[label], built.ids)]
    : [{ name: `[${label}] state captured from the packaged renderer`, ok: false }]);

  console.log(`packaged renderer: ${asar}`);
  console.log("input: SYNTHETIC TEST FIXTURE (collector → persist → reload)");
  const checks = [...nodeChecks, ...result.checks, ...semantic];
  for (const check of checks) console.log(`${check.ok ? "✔" : "✖"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
  if (result.error) console.log(`✖ ${result.error}`);
  if (result.screenshot) console.log(`screenshot: ${result.screenshot}`);
  const ok = code === 0 && result.ok && checks.every((check) => check.ok);
  if (keep || (!ok && result.screenshot)) console.log(`kept test directory: ${dir}`);
  else await rm(dir, { recursive: true, force: true });
  const kind = "collector → persist → reload fixture";
  console.log(ok
    ? `packaged usage UI smoke: PASS (packaged renderer; ${kind}; ${checks.length} checks)`
    : `packaged usage UI smoke: FAIL (${kind}; exit ${code}; ${checks.filter((check) => !check.ok).length} failed)`);
  process.exitCode = ok ? 0 : 1;
}

// ---------------------------------------------------------------- Electron side

async function runHarness() {
  const { app, BrowserWindow, ipcMain, session } = createRequire(import.meta.url)("electron");
  const dir = process.env.SMOKE_USAGE_DIR;
  const asar = process.env.SMOKE_USAGE_ASAR;
  const checks = [];
  const check = (name, ok, detail = "") => { checks.push({ name, ok: Boolean(ok), detail }); };
  const finish = (extra = {}) => {
    const ok = !extra.error && checks.length > 0 && checks.every((entry) => entry.ok);
    console.log(`SMOKE_RESULT ${JSON.stringify({ ok, checks, ...extra })}`);
    app.exit(ok ? 0 : 1);
  };
  const root = process.env.SMOKE_USAGE_ROOT;
  const historyFile = process.env.SMOKE_USAGE_HISTORY;
  if (!dir || !root || !resolve(dir).startsWith(resolve(root) + sep) || !asar || !historyFile || !resolve(historyFile).startsWith(resolve(dir) + sep)) {
    console.log(`SMOKE_RESULT ${JSON.stringify({ ok: false, checks: [], error: "SMOKE_USAGE_DIR must be inside SMOKE_USAGE_ROOT, SMOKE_USAGE_HISTORY inside it, and SMOKE_USAGE_ASAR set" })}`);
    app.exit(1);
    return;
  }
  const history = JSON.parse(await readFile(historyFile, "utf8"));
  app.setPath("userData", join(dir, "userData"));
  app.setPath("sessionData", join(dir, "userData", "session"));
  app.setPath("crashDumps", join(dir, "crashDumps"));
  app.setAppLogsPath(join(dir, "logs"));
  app.commandLine.appendSwitch("use-mock-keychain");
  app.commandLine.appendSwitch("disk-cache-dir", join(dir, "cache"));
  let stage = "waiting for app ready";
  setTimeout(() => finish({ error: `timed out after ${TIMEOUT_MS} ms (${stage})` }), TIMEOUT_MS).unref();

  await app.whenReady();
  const preload = join(asar, "out", "preload", "index.cjs");
  const rendererHtml = join(asar, "out", "renderer", "index.html");
  // Electron reads inside app.asar transparently; these are the shipped files.
  const preloadSource = await readFile(preload, "utf8").catch(() => "");
  check("packaged preload present in app.asar", preloadSource.length > 0, preload);
  check("packaged renderer present in app.asar", existsSync(rendererHtml), rendererHtml);

  let usageCalls = 0;
  let servedHistory = history;
  const channels = new Set([...preloadSource.matchAll(/["']([a-z][\w-]*:[\w:-]+)["']/g)].map((match) => match[1]));
  channels.add(USAGE_CHANNEL);
  for (const channel of channels) {
    try {
      ipcMain.handle(channel, () => {
        if (channel === USAGE_CHANNEL) {
          usageCalls += 1;
          return servedHistory;
        }
        if (channel === "update:status") return { type: "idle" };
        if (channel === "materials:snapshot") return { revision: 0, materials: [], remarks: [], storage: { usedBytes: 0, limitBytes: 0 } };
        if (channel === "settings:get") throw new Error("smoke harness: settings are not provided (renderer defaults are used)");
        if (channel === "window:get-state") return { isMacOS: process.platform === "darwin", maximized: false, fullscreen: false };
        if (channel === "app:version") return "smoke-fixture";
        return /list|search|snapshot|sessions/i.test(channel) ? [] : null;
      });
    } catch { /* already handled */ }
  }
  check("usage history channel exposed by packaged preload", preloadSource.includes(USAGE_CHANNEL));

  const partition = "smoke-usage-packaged"; // in-memory only
  const blocked = [];
  session.fromPartition(partition).webRequest.onBeforeRequest((details, callback) => {
    const allowed = /^(file|data|devtools|blob|canvastty-[a-z]+):/.test(details.url);
    if (!allowed) blocked.push(details.url);
    callback({ cancel: !allowed });
  });
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { partition, preload, contextIsolation: true, sandbox: false, nodeIntegration: false }
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const pageErrors = [];
  win.webContents.on("console-message", (details) => { if (details.level === "error") pageErrors.push(details.message); });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const waitFor = async (code, label, timeout = 20_000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await js(code).catch(() => false)) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  try {
    stage = "loading packaged renderer";
    await win.loadFile(rendererHtml);
    check("renderer document comes from app.asar, not a dev server", (await js("location.href")).includes("app.asar"), await js("location.protocol"));
    stage = "opening the usage panel";
    await waitFor(`Boolean(document.querySelector(".usage-history-trigger"))`, "usage trigger in packaged App");
    check("trigger renders closed", await js(`!document.querySelector('.usage-history[role="dialog"]') &&
      document.querySelector(".usage-history-trigger").getAttribute("aria-expanded") === "false"`));
    await js(`document.querySelector(".usage-history-trigger").focus(); document.querySelector(".usage-history-trigger").click(); true`);
    await waitFor(`Boolean(document.querySelector('.usage-history[role="dialog"] .usage-history__section--conditional'))`, "conditional section");
    check("dialog is named, described and linked to its expanded trigger", await js(`(() => {
      const dialog = document.querySelector('.usage-history[role="dialog"]');
      const trigger = document.querySelector(".usage-history-trigger");
      return dialog.getAttribute("aria-modal") === "true" && trigger.getAttribute("aria-expanded") === "true" &&
        trigger.getAttribute("aria-controls") === dialog.id &&
        Boolean(document.getElementById(dialog.getAttribute("aria-labelledby"))?.textContent.trim()) &&
        Boolean(document.getElementById(dialog.getAttribute("aria-describedby"))?.textContent.trim());
    })()`));
    await waitFor(`document.activeElement?.classList.contains("usage-history__close")`, "focus on Close");
    check("focus moves to Close", true);
    const sessionIds = JSON.parse(process.env.SMOKE_USAGE_EXPECT_SESSIONS ?? "null") ?? [...new Set(history.events.map((event) => event.session))];
    // Session ids are matched on the tree rows' code[title] (layout-independent, never abbreviated).
    const treeIds = `[...document.querySelectorAll('.usage-history[role="dialog"] .usage-history__tree-row--session code')].map((code) => code.getAttribute("title") || code.textContent)`;
    try {
      await waitFor(`((ids) => ${JSON.stringify(sessionIds)}.every((id) => ids.includes(id)))(${treeIds})`, "expected tree");
    } catch (error) {
      const dump = await js(`JSON.stringify({ treeIds: ${treeIds}, rows: document.querySelectorAll('.usage-history[role="dialog"] .usage-history__tree-row').length,
        blocks: [...document.querySelectorAll('.usage-history[role="dialog"] .usage-history__conditional-result')].map((b) => b.textContent.slice(0, 600)),
        text: document.querySelector('.usage-history[role="dialog"]').textContent.slice(0, 1500) })`).catch(() => "unavailable");
      throw new Error(`${error.message}; expected ${JSON.stringify(sessionIds)}; DOM ${dump}`);
    }
    const text = await js(`document.querySelector('.usage-history[role="dialog"]').innerText`);
    const html = await js(`document.querySelector('.usage-history[role="dialog"]').innerHTML`);
    const has = (...needles) => needles.some((needle) => text.includes(needle));
    check("history loaded through the packaged preload bridge", usageCalls >= 1, `${usageCalls} call(s)`);
    check("synthetic fixture label shown", text.includes(history.coverage.at(-1)));
    check("provider sections and window series rendered", ["codex:primary", "claude:five_hour"].every((id) => text.includes(id)));
    const scopes = [...new Set(history.samples.map((sample) => sample.scope))];
    check("account scopes shown shortened with full titles", await js(`((scopes) => scopes.every((scope) =>
      [...document.querySelectorAll('.usage-history[role="dialog"] code[title]')].some((code) =>
        code.title === scope && code.textContent !== scope && code.textContent.includes("…"))))(${JSON.stringify(scopes)})`));
    check("conditional estimate section is first", html.indexOf("usage-history__section--conditional") < html.indexOf("usage-history-quota"));
    check("app → profile → session tree rendered", ["app", "profile", "session"].every((level) => html.includes(`usage-history__tree-row--${level}`)));
    check("not-proven label present", has("The logs do not prove", "Логи не доказывают"));
    check("no manual share input (no share field, no number/text inputs in the dialog)",
      !html.includes("usage-history-share") && (await js(`document.querySelectorAll('.usage-history[role="dialog"] input:not([type="radio"]), .usage-history[role="dialog"] textarea').length`)) === 0);
    check("measured change stays unattributed", has("Unattributed", "Не атрибутировано"));
    check("private fixture fields never rendered", PRIVATE_MARKERS.every((marker) => !html.includes(marker)));

    // Scrape the conditional blocks in the current period / weight basis; numbers are checked by the orchestrator.
    const scrape = async () => js(`(() => {
      const dialog = document.querySelector('.usage-history[role="dialog"]');
      const checked = (name) => dialog.querySelector('input[name="' + name + '"]:checked')?.value ?? null;
      return {
        period: checked("usage-history-period"),
        weight: checked("usage-history-weight"),
        blocks: [...dialog.querySelectorAll(".usage-history__conditional-result")].map((block) => ({
          windowId: block.querySelector("h5 code")?.textContent ?? "",
          summary: [...block.querySelectorAll(".usage-history__conditional-summary > li")].map((li) => li.innerText.trim()),
          rows: [...block.querySelectorAll(".usage-history__tree-row")].map((row) => ({
            level: (row.className.match(/--(app|profile|session)\\b/) ?? [])[1] ?? "",
            label: (row.cells[0].querySelector("code")?.getAttribute("title") || row.cells[0].textContent).trim(),
            points: row.cells[1].innerText.trim(),
            weight: row.cells[2].innerText.trim()
          }))
        }))
      };
    })()`);
    const choose = async (name, value) => {
      stage = `choosing ${name}=${value}`;
      await js(`document.querySelector('.usage-history[role="dialog"] input[name="${name}"][value="${value}"]').click(); true`);
      await waitFor(`document.querySelector('.usage-history[role="dialog"] input[name="${name}"][value="${value}"]').checked`, `${name}=${value}`);
      await new Promise((done) => setTimeout(done, 200));
    };
    const states = { initial: await scrape() };
    await choose("usage-history-weight", "all");
    states.weightAll = await scrape();
    await choose("usage-history-weight", "uncached");
    await choose("usage-history-period", "1h");
    states.period1h = await scrape();

    let screenshot = null;
    try {
      const image = await win.webContents.capturePage();
      if (!image.isEmpty()) {
        screenshot = join(dir, "usage-history-packaged-smoke.png");
        await writeFile(screenshot, image.toPNG());
      }
    } catch { /* optional */ }
    // Native input only: a dispatched DOM KeyboardEvent would hide a broken native path.
    stage = "closing with native Escape";
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await waitFor(`!document.querySelector('.usage-history[role="dialog"]')`, "native Escape closes dialog");
    check("native Escape closes dialog", true);
    await waitFor(`document.activeElement === document.querySelector(".usage-history-trigger") &&
      document.activeElement.getAttribute("aria-expanded") === "false"`, "focus restored to closed trigger");
    check("focus restored to trigger", true);

    // Separate renderer-only edge fixture, not collector output. Do not alter the
    // persisted history or the numeric acceptance states captured above.
    servedHistory = {
      ...history,
      samples: history.samples.filter((sample) => sample.provider !== "claude"),
      events: [...history.events, {
        id: "fixture-unknown", provider: "unknown", app: "Fixture Unknown (test)", profile: "", session: "fixture-unknown-session",
        from: history.collectedAt, to: history.collectedAt, input: 20, output: 2, cached: 0, timing: "event",
        title: "PRIVATE fixture title", content: "PRIVATE fixture body", cwd: "/fixture-private-cwd"
      }],
      providerStatus: ["claude: unavailable (TEST FIXTURE — no quota observations)"]
    };
    stage = "loading renderer-only unknown-provider fixture";
    const callsBeforeReopen = usageCalls;
    await js(`document.querySelector(".usage-history-trigger").click(); true`);
    await waitFor(`document.querySelector('.usage-history[role="dialog"]')?.textContent.includes("fixture-unknown-session")`, "unknown-provider fixture");
    const edgeText = await js(`document.querySelector('.usage-history[role="dialog"]').innerText`);
    const edgeHtml = await js(`document.querySelector('.usage-history[role="dialog"]').innerHTML`);
    const edgeHas = (...needles) => needles.some((needle) => edgeText.includes(needle));
    check("reopening reloads through packaged preload", usageCalls > callsBeforeReopen);
    check("unknown / not recorded label", edgeHas("Unknown / not recorded locally", "Неизвестно / не записано локально"));
    check("provider without quota observations is unknown", edgeHas("No quota observations for this provider", "Нет наблюдений квоты этого провайдера"));
    check("unidentified provider is labelled", edgeHas("Provider not identified", "Провайдер не определён"));
    check("unavailable provider status shown", edgeText.includes(servedHistory.providerStatus[0]));
    check("private fields injected into renderer-only fixture never rendered", PRIVATE_MARKERS.every((marker) => !edgeHtml.includes(marker)));
    check("no network requests left the harness", blocked.length === 0, blocked.slice(0, 3).join(", "));
    const usageErrors = pageErrors.filter((message) => /usage/i.test(message));
    check("no usage-related renderer console errors", usageErrors.length === 0, usageErrors.slice(0, 3).join(" | "));
    finish({ screenshot, states, otherConsoleErrors: pageErrors.length - usageErrors.length });
  } catch (error) {
    finish({ error: `${error instanceof Error ? error.message : String(error)} (${stage}); console: ${pageErrors.slice(0, 3).join(" | ")}` });
  }
}
