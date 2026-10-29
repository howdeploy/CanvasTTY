#!/usr/bin/env node
// Startup readiness of the built app on a fixed restored profile: three shell cards, one browser card (a page served
// from 127.0.0.1 by this script) and one plugin canvas card (examples/plugins/studio-kit), session restore on.
//
//   npx electron-vite build
//   node --experimental-strip-types scripts/bench/startup.mjs [--cold 5] [--warm 10] [--json report.json] [--frames]
//
// Cold: every launch gets a fresh copy of the seeded profile without Chromium's caches (code cache, GPU cache).
// Warm: one copy is reused; a first, discarded launch fills its caches. Launches run one after another. Every launch
// gets a fresh short HOME (GROK_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, XDG_* inside); windows are hidden, off-screen
// and unfocusable; the keychain is refused (scripts/bench-runtime/app).
//
// Marks (ms since the Electron process started; median and p90 across launches):
//   main      appReady, windowCreateStart, windowCreated, criticalServicesReady / coreServicesReady (the IPC groups
//             the first frame needs, where the build registers them in groups), servicesReady (every service up),
//             applicationLoadStart, applicationLoaded (surface did-finish-load), allSurfacesMounted (the three
//             terminals, the plugin and the browser card in the DOM, observed by the harness)
//   renderer  rendererFirstPaint, firstStableFrame (no loader, real data), homeActionable,
//             restoredTerminalInteractive (first restored xterm forwards input)
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { invalidateTrial, readTrial, reapTrial, successfulTrials } from "./trial.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HERE = join(ROOT, "scripts", "bench");
const TEMP = realpathSync("/tmp");
const CHROMIUM_CACHES = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Shared Dictionary",
  "blob_storage", "Session Storage", "Partitions"];

function options(argv) {
  const result = { cold: 5, warm: 10, json: null, frames: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--cold") result.cold = Number(argv[++i]);
    else if (flag === "--warm") result.warm = Number(argv[++i]);
    else if (flag === "--json") result.json = resolve(argv[++i]);
    else if (flag === "--frames") result.frames = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  return result;
}

function appFolder(folder) {
  mkdirSync(join(folder, "src"), { recursive: true });
  mkdirSync(join(folder, "scripts"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "canvastty-bench-startup", private: true, main: "startup.cjs", type: "commonjs" }));
  cpSync(join(HERE, "app", "startup.cjs"), join(folder, "startup.cjs"));
  cpSync(join(ROOT, "src", "agent-runtime"), join(folder, "src", "agent-runtime"), { recursive: true });
  cpSync(join(ROOT, "src", "agent-browser"), join(folder, "src", "agent-browser"), { recursive: true });
  cpSync(join(ROOT, "scripts", "canvastty-control.mjs"), join(folder, "scripts", "canvastty-control.mjs"));
  if (existsSync(join(ROOT, "build", "native-helpers"))) {
    mkdirSync(join(folder, "build"), { recursive: true });
    symlinkSync(join(ROOT, "build", "native-helpers"), join(folder, "build", "native-helpers"));
  }
}

function run(command, args, env, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stderr = "";
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
    const timer = setTimeout(kill, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      kill();
      if (code === 0 && signal === null) resolvePromise();
      else reject(new Error(`${command} exited code=${code}, signal=${signal}: ${stderr.slice(-1500)}`));
    });
  });
}

/** One launch with a fresh short HOME; returns the harness report. */
async function launch(bench, phase, userData) {
  const electron = createRequire(import.meta.url)("electron");
  const home = mkdtempSync(join(TEMP, "s."));
  writeFileSync(join(home, ".zshrc"), "");
  const out = join(home, "report.json");
  const env = {
    HOME: home, USER: "bench", LOGNAME: "bench", TMPDIR: TEMP, LANG: "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh",
    GROK_HOME: join(home, ".grok"), CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    BENCH_PHASE: phase, BENCH_ROOT: ROOT, BENCH_OUT: out, BENCH_USERDATA: userData, BENCH_WORK: bench.work,
    BENCH_PAGE_URL: bench.pageUrl,
    ...(bench.frames && phase === "measure" ? { BENCH_FRAMES: "1" } : {})
  };
  let report;
  try {
    let exit = null;
    await run(electron, [bench.app], env, 120_000).catch((error) => { exit = error; });
    report = readTrial(out, { exitError: exit,
      requiredNumbers: phase === "seed" ? ["seeded"] : MARKS
        .filter(([, name]) => !OPTIONAL_READINESS.has(name)).map(([side, name]) => `${side}.${name}`)
    });
    if (phase === "seed" && report.seeded !== 3) {
      invalidateTrial(report, "the seed did not contain the three requested terminal sessions");
    }
    if (phase === "measure" && ![report.main?.criticalServicesReady, report.main?.coreServicesReady]
      .some((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
      invalidateTrial(report, "neither criticalServicesReady nor coreServicesReady was observed");
    }
    return report;
  } finally {
    try { reapTrial([userData, home]); }
    catch (error) { if (report) invalidateTrial(report, `process cleanup: ${error.message}`); else throw error; }
    finally { rmSync(home, { recursive: true, force: true }); }
  }
}

async function installPlugin(userData) {
  const { PluginManager } = await import(join(ROOT, "src", "main", "services", "PluginManager.ts"));
  const fixture = join(ROOT, "examples", "plugins", "studio-kit");
  const manager = new PluginManager(userData, async (_url, destination) => { await cp(fixture, destination, { recursive: true }); });
  await manager.load();
  const preview = await manager.previewInstall("https://github.com/example/studio-kit");
  await manager.install(preview.token);
}

const pct = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const MARKS = [
  ["main", "windowCreateStart"], ["main", "criticalServicesReady"], ["main", "coreServicesReady"],
  ["main", "appReady"], ["main", "windowCreated"], ["main", "applicationLoadStart"], ["renderer", "rendererFirstPaint"],
  ["main", "servicesReady"], ["main", "applicationLoaded"], ["renderer", "firstStableFrame"], ["renderer", "homeActionable"],
  ["renderer", "restoredTerminalInteractive"], ["main", "allSurfacesMounted"]
];
// Older instrumented builds report one readiness group; require at least one, and label both optional columns.
const OPTIONAL_READINESS = new Set(["criticalServicesReady", "coreServicesReady"]);
function summarize(reports) {
  const rows = {};
  const valid = successfulTrials(reports);
  for (const [side, name] of MARKS) {
    const values = valid.map((report) => report[side]?.[name]).filter((value) => typeof value === "number" && Number.isFinite(value));
    rows[name] = { n: values.length, median: pct(values, 50), p90: pct(values, 90), optional: OPTIONAL_READINESS.has(name) };
  }
  return rows;
}

async function main() {
  const settings = options(process.argv.slice(2));
  const root = mkdtempSync(join(TEMP, "s."));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>bench</title><body style=\"font:16px sans-serif\"><h1>Bench page</h1></body>");
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const bench = { app: join(root, "app"), work: join(root, "w"), pageUrl: `http://127.0.0.1:${server.address().port}/`, frames: settings.frames };
  mkdirSync(bench.work, { recursive: true });
  appFolder(bench.app);
  const template = join(root, "t");
  mkdirSync(template, { recursive: true });
  writeFileSync(join(template, "settings.json"), JSON.stringify({ settingsVersion: 21, locale: "en", sessionRestoreMode: "reopen" }));
  const result = { cold: [], warm: [], errors: [], seed: null, warmup: null };
  try {
    await installPlugin(template);
    const seeded = result.seed = await launch(bench, "seed", template);
    if (!seeded.valid) throw new Error(`seed invalid: ${seeded.validationErrors.join("; ")}`);
    for (const cache of CHROMIUM_CACHES) await rm(join(template, cache), { recursive: true, force: true });
    const sessions = JSON.parse(await readFile(join(template, "terminal-sessions.json"), "utf8").catch(() => "{}"));
    process.stderr.write(`seeded: ${seeded.seeded} sessions; store: ${sessions.sessions?.length ?? "?"}\n`);

    for (let i = 0; i < settings.cold; i++) {
      const userData = join(root, `c${i}`);
      await cp(template, userData, { recursive: true });
      const report = await launch(bench, "measure", userData);
      result.cold.push(report);
      process.stderr.write(`cold ${i + 1}: ${JSON.stringify({ ...report.main, ...report.renderer })} valid=${report.valid} ${report.validationErrors.join("; ")}\n`);
      await rm(userData, { recursive: true, force: true });
    }
    const warmData = join(root, "wd");
    await cp(template, warmData, { recursive: true });
    result.warmup = await launch(bench, "measure", warmData); // fills Chromium's caches; not counted
    if (!result.warmup.valid) throw new Error(`warmup invalid: ${result.warmup.validationErrors.join("; ")}`);
    for (let i = 0; i < settings.warm; i++) {
      const report = await launch(bench, "measure", warmData);
      result.warm.push(report);
      process.stderr.write(`warm ${i + 1}: ${JSON.stringify({ ...report.main, ...report.renderer })} valid=${report.valid} ${report.validationErrors.join("; ")}\n`);
    }
  } catch (error) {
    result.errors.push(error.message);
  } finally {
    server.close();
    try { reapTrial([root]); }
    catch (error) { result.errors.push(`process cleanup: ${error.message}`); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
  const measured = [...result.cold, ...result.warm];
  const all = [result.seed, result.warmup, ...measured].filter(Boolean);
  const summary = {
    cold: summarize(result.cold),
    warm: summarize(result.warm),
    trials: Object.fromEntries(["cold", "warm"].map((phase) => [phase, {
      requested: settings[phase], total: result[phase].length, valid: successfulTrials(result[phase]).length,
      invalid: result[phase].filter((report) => !report.valid).length
    }])),
    errors: [...result.errors, ...all.flatMap((report) => report.validationErrors)],
    ...(settings.frames ? { frames: successfulTrials(measured).map((report) => report.frames ?? []) } : {}),
    rendererErrors: [...new Set(all.flatMap((report) => report.rendererErrors ?? []))].slice(0, 10)
  };
  if (settings.json) writeFileSync(settings.json, JSON.stringify({ summary, runs: result }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  if (summary.errors.length) process.exitCode = 1;
}

await main();
