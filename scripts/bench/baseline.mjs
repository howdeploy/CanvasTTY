#!/usr/bin/env node
// Performance and size baseline of the built app: per-card memory (N = 1, 5, 10 plain shells or stub agents, every
// process kind including the MCP and hook helpers CanvasTTY attaches), CPU while idle / under load / during a canvas
// pan and zoom, startup time to the first interactive frame, heaps, and optionally the size of a packaged app.
//
//   npx electron-vite build
//   node scripts/bench/baseline.mjs [--runs 2] [--modes shell,opencode,claude] [--ladder 1,5,10]
//        [--idle-seconds 60] [--settled-ms 10000] [--load-seconds 30] [--kbps 256] [--churn-period-ms 3000]
//        [--size path/to/CanvasTTY.app] [--json report.json] [--helpers auto|node|native]
//   node scripts/bench/baseline.mjs --size-only path/to/CanvasTTY.app
//
// Modes run one after another, never in parallel. The agent modes put a stub `opencode` / `claude`
// (scripts/bench/fake-agent.mjs) first on PATH: CanvasTTY launches it like the real CLI with its MCP helpers,
// lifecycle plugin and hooks, and the stub starts them the way the real CLI does, without a model or network.
// Every run gets a fresh HOME (GROK_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, XDG_* inside), userData and working
// folder; windows are hidden, off-screen and unfocusable; the keychain is refused (scripts/bench-runtime/app).
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, release, totalmem, loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appSize, formatSize } from "./size.mjs";
import { invalidateTrial, readTrial, reapTrial, successfulTrials } from "./trial.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HERE = join(ROOT, "scripts", "bench");
// Short paths: the app keeps Unix sockets in userData and macOS caps a socket path at 104 bytes. Real paths
// (/tmp is a link to /private/tmp): the helpers only start when argv[1] equals their resolved module path.
const TEMP = realpathSync(process.env.BENCH_TMPDIR || "/tmp");

function options(argv) {
  const result = {
    runs: 2, modes: ["shell", "opencode", "claude"], ladder: "1,5,10", idleSeconds: 60, loadSeconds: 30,
    kbps: 256, churnPeriodMs: 3000, settleMs: 10_000, settledMs: 10_000, size: null, sizeOnly: false, json: null, helpers: "auto"
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => argv[++i];
    if (flag === "--runs") result.runs = Number(value());
    else if (flag === "--modes") result.modes = value().split(",");
    else if (flag === "--ladder") result.ladder = value();
    else if (flag === "--idle-seconds") result.idleSeconds = Number(value());
    else if (flag === "--load-seconds") result.loadSeconds = Math.max(10, Number(value()));
    else if (flag === "--kbps") result.kbps = Number(value());
    else if (flag === "--churn-period-ms") result.churnPeriodMs = Number(value());
    else if (flag === "--settle-ms") result.settleMs = Number(value());
    else if (flag === "--settled-ms") result.settledMs = Number(value());
    else if (flag === "--size") result.size = resolve(value());
    else if (flag === "--size-only") { result.size = resolve(value()); result.sizeOnly = true; }
    else if (flag === "--json") result.json = resolve(value());
    else if (flag === "--helpers") result.helpers = value();
    else throw new Error(`Unknown option ${flag}`);
  }
  return result;
}

/** The stub CLIs (`opencode`, `claude`) in a bin folder that goes first on PATH. `claude` links to
 * versions/<version> like the native installer, so CanvasTTY reads its version from the path (HTTP hooks). */
function stubBin(folder) {
  mkdirSync(join(folder, "versions"), { recursive: true });
  const stub = join(folder, "fake-agent.mjs");
  cpSync(join(HERE, "fake-agent.mjs"), stub);
  for (const provider of ["opencode", "claude"]) {
    const path = provider === "claude" ? join(folder, "versions", "2.1.281") : join(folder, provider);
    writeFileSync(path, `#!/bin/sh\nBENCH_FAKE_PROVIDER=${provider} exec "${process.execPath}" "${stub}" "$@"\n`);
    chmodSync(path, 0o755);
  }
  symlinkSync(join(folder, "versions", "2.1.281"), join(folder, "claude"));
}

/** A throw-away Electron app folder: the harness entry plus a copy of the helper sources the app resolves from
 * app.getAppPath() (a copy, not a link: helpers compare argv[1] with their real path). */
function appFolder(folder) {
  mkdirSync(join(folder, "src"), { recursive: true });
  mkdirSync(join(folder, "scripts"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "canvastty-bench-baseline", private: true, main: "boot.cjs", type: "commonjs" }));
  cpSync(join(HERE, "app", "boot.cjs"), join(folder, "boot.cjs"));
  cpSync(join(ROOT, "src", "agent-runtime"), join(folder, "src", "agent-runtime"), { recursive: true });
  cpSync(join(ROOT, "src", "agent-browser"), join(folder, "src", "agent-browser"), { recursive: true });
  cpSync(join(ROOT, "scripts", "canvastty-control.mjs"), join(folder, "scripts", "canvastty-control.mjs"));
  // The native helper where it was built (npm run build:helpers -- --host): the app finds it next to the sources. A
  // link, not a copy: the first exec of a new file costs macOS ~0.2 s of checks, which an installed app pays once.
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
      kill(); // whatever the app left behind (shells, helpers) goes with its process group
      if (code === 0 && signal === null) resolvePromise();
      else reject(new Error(`${command} exited code=${code}, signal=${signal}: ${stderr.slice(-1500)}`));
    });
  });
}

async function appRun(mode, settings) {
  const electron = createRequire(import.meta.url)("electron");
  const base = mkdtempSync(join(TEMP, "ctbl-"));
  const home = join(base, "h");
  const userData = join(base, "u");
  const work = join(base, "w");
  const app = join(base, "app");
  const bin = join(base, "bin");
  for (const folder of [home, userData, work]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(home, ".zshrc"), "");
  appFolder(app);
  stubBin(bin);
  const flood = join(base, "flood.mjs");
  cpSync(join(ROOT, "scripts", "bench-runtime", "flood.mjs"), flood);
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ settingsVersion: 21, locale: "en", sessionRestoreMode: "off" }));
  const out = join(base, "report.json");
  const env = {
    HOME: home, USER: process.env.USER ?? "bench", LOGNAME: process.env.USER ?? "bench", TMPDIR: TEMP, LANG: "en_US.UTF-8",
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: "/bin/zsh",
    GROK_HOME: join(home, ".grok"), CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
    BENCH_MODE: mode, BENCH_ROOT: ROOT, BENCH_OUT: out, BENCH_USERDATA: userData, BENCH_WORK: work,
    BENCH_NODE: process.execPath, BENCH_FLOOD: flood,
    BENCH_LADDER: settings.ladder, BENCH_IDLE_SECONDS: String(settings.idleSeconds), BENCH_LOAD_SECONDS: String(settings.loadSeconds),
    BENCH_KBPS: String(settings.kbps), BENCH_CHURN_PERIOD_MS: String(settings.churnPeriodMs), BENCH_SETTLE_MS: String(settings.settleMs),
    BENCH_SETTLED_MS: String(settings.settledMs),
    // node: the .mjs helpers under Electron-as-Node; native: canvastty-helper; auto: what the app picks by itself.
    ...(settings.helpers === "auto" ? {} : { CANVASTTY_HELPERS: settings.helpers })
  };
  const started = Date.now();
  let report;
  try {
    let exit = null;
    await run(electron, [app], env, 600_000).catch((error) => { exit = error; });
    const ladder = settings.ladder.split(",").map(Number);
    const labels = ["empty", ...ladder.map((n) => `n${n}`), "afterLoad", "end", "endSettled"];
    if (mode !== "shell") labels.push(`n${ladder.at(-1)}+orchestrator`);
    report = readTrial(out, { exitError: exit, requiredNumbers: [
      ...["bootMs", "appReadyMs", "mainImportedMs", "windowCreatedMs", "firstLoadMs", "interactiveMs"].map((mark) => `startup.${mark}`),
      ...labels.map((label) => `snapshots.${label}.total.rssMb`),
      ...["idleEmpty", "idle60", "load", "panZoom"].map((label) => `cpu.${label}.seconds`),
      "pan.events", "pan.commits", "pan.rendererMsPerEvent.task"
    ] });
    if (report.startup?.interactiveViaRaf !== true) {
      invalidateTrial(report, "interactive readiness used the timer fallback, not an animation frame");
    }
    if (mode === "shell" && !(report.cpu?.load?.terminalDataToRendererMb > 0)) {
      invalidateTrial(report, "the load delivered no terminal output to the renderer");
    }
    if (mode !== "shell") {
      const entries = Array.isArray(report.agentLog) ? report.agentLog : [];
      if (!entries.some((entry) => entry.turn !== undefined)) invalidateTrial(report, "the stub agents completed no workload turn");
      for (const entry of entries) {
        if (entry.error || entry.ok === false) invalidateTrial(report, `stub agent: ${entry.error ?? "MCP initialization failed"}`);
      }
    }
    report.wallSeconds = Math.round((Date.now() - started) / 1000);
    report.load1 = loadavg()[0];
    return report;
  } finally {
    try { reapTrial([base]); }
    catch (error) { if (report) invalidateTrial(report, `process cleanup: ${error.message}`); else throw error; }
    finally { rmSync(base, { recursive: true, force: true }); }
  }
}

// ---- aggregation ----
const median = (values) => {
  const numbers = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : Math.round(((numbers[middle - 1] + numbers[middle]) / 2) * 10) / 10;
};
/** Median of every numeric leaf across runs; keys present in any run are kept. */
function medianOf(values) {
  const present = values.filter((value) => value !== undefined && value !== null);
  if (!present.length) return null;
  if (typeof present[0] === "number") return median(present);
  if (typeof present[0] !== "object" || Array.isArray(present[0])) return present[0];
  const keys = [...new Set(present.flatMap((value) => Object.keys(value)))];
  return Object.fromEntries(keys.map((key) => [key, medianOf(present.map((value) => value[key]))]));
}
/** Hook and MCP statistics from the stub agents' logs. */
function agentSummary(entries) {
  if (!entries?.length) return null;
  const hooks = {};
  for (const entry of entries.filter((item) => item.hook)) {
    const key = `${entry.hook}:${entry.kind ?? "in-process"}${entry.helper ? `:${entry.helper}` : ""}`;
    (hooks[key] ??= []).push(entry);
  }
  const mcp = entries.filter((item) => item.mcp && item.readyMs !== undefined);
  return {
    turns: entries.filter((item) => item.turn !== undefined).length,
    turnMs: median(entries.filter((item) => item.turn !== undefined).map((item) => item.ms)),
    mcpServers: mcp.length,
    mcpReadyMs: median(mcp.map((item) => item.readyMs)),
    mcpOk: mcp.filter((item) => item.ok).length,
    errors: entries.filter((item) => item.error).map((item) => item.error).slice(0, 5),
    hooks: Object.fromEntries(Object.entries(hooks).map(([key, list]) => [key, {
      runs: list.length,
      ms: median(list.map((item) => item.ms)),
      maxRssMb: median(list.map((item) => item.maxRssKb / 1024)),
      cpuMs: median(list.map((item) => ((item.userS ?? NaN) + (item.sysS ?? NaN)) * 1000))
    }]))
  };
}

function markdown(result) {
  const lines = [];
  const row = (cells) => lines.push(`| ${cells.join(" | ")} |`);
  for (const [mode, data] of Object.entries(result.modes)) {
    const m = data.median;
    lines.push(`\n### ${mode}\n`);
    lines.push(`Valid trials: ${data.trials.valid}/${data.trials.total}; invalid trials remain in runs.`);
    if (!m) { lines.push("No valid measurements."); continue; }
    lines.push(`Startup (ms from process start): ${JSON.stringify(m.startup)}\n`);
    const labels = Object.keys(m.snapshots ?? {});
    const kinds = [...new Set(labels.flatMap((label) => Object.keys(m.snapshots[label].kinds)))].sort();
    row(["kind", ...labels.map((label) => `${label} n / RSS / footprint MB`)]);
    row(["---", ...labels.map(() => "--:")]);
    for (const kind of kinds) row([kind, ...labels.map((label) => { const k = m.snapshots[label].kinds[kind]; return k ? `${k.count} / ${k.rssMb} / ${k.footprintMb}` : "–"; })]);
    row(["**total**", ...labels.map((label) => { const t = m.snapshots[label].total; return `${t.count} / ${t.rssMb} / ${t.footprintMb}`; })]);
    row(["renderer heap used MB", ...labels.map((label) => m.snapshots[label].rendererHeapMb?.used ?? "–")]);
    row(["main heap used MB", ...labels.map((label) => m.snapshots[label].mainHeapMb?.used ?? "–")]);
    lines.push("");
    const windows = Object.keys(m.cpu ?? {});
    const cpuKinds = [...new Set(windows.flatMap((w) => Object.keys(m.cpu[w].percent)))].filter((k) => k !== "total").sort();
    row(["CPU % of one core", ...windows]);
    row(["---", ...windows.map(() => "--:")]);
    for (const kind of cpuKinds) row([kind, ...windows.map((w) => m.cpu[w].percent[kind] ?? "–")]);
    row(["**total**", ...windows.map((w) => m.cpu[w].percent.total)]);
    lines.push(`\nLoad: ${m.cpu?.load?.what ?? ""}${m.cpu?.load?.terminalDataToRendererMb !== undefined ? `, ${m.cpu.load.terminalDataToRendererMb} Mi UTF-16 code units to the renderer` : ""}`);
    lines.push(`Pan/zoom: ${JSON.stringify(m.pan)}`);
    if (data.agent) lines.push(`Agents: ${JSON.stringify(data.agent)}`);
  }
  if (result.size) lines.push(`\n### Size\n\n${formatSize(result.size)}`);
  return lines.join("\n");
}

function machine() {
  let os = `${process.platform} ${release()}`;
  try { os = `macOS ${execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()}`; } catch {}
  return { os, cpu: cpus()[0]?.model ?? "unknown", cores: cpus().length, ramGb: Math.round(totalmem() / 1024 ** 3), node: process.version };
}

async function main() {
  const settings = options(process.argv.slice(2));
  const result = { machine: machine(), settings, modes: {}, runs: {} };
  if (!settings.sizeOnly) {
    if (!existsSync(join(ROOT, "out", "main", "index.js"))) throw new Error("Build the app first: npx electron-vite build");
    for (let i = 0; i < settings.runs; i++) {
      for (const mode of settings.modes) {
        process.stderr.write(`${mode} run ${i + 1}/${settings.runs}\n`);
        const report = await appRun(mode, settings);
        if (!report.valid) process.stderr.write(`  invalid trial: ${JSON.stringify(report.validationErrors)}\n`);
        (result.runs[mode] ??= []).push(report);
      }
    }
    for (const [mode, reports] of Object.entries(result.runs)) {
      const valid = successfulTrials(reports);
      result.modes[mode] = {
        trials: { total: reports.length, valid: valid.length, invalid: reports.length - valid.length },
        median: medianOf(valid.map(({ startup, snapshots, cpu, pan }) => ({ startup, snapshots, cpu, pan }))),
        agent: medianOf(valid.map((report) => agentSummary(report.agentLog)))
      };
    }
  }
  if (settings.size) result.size = appSize(settings.size, ROOT);
  if (settings.json) {
    // Raw agent logs are large; keep their summaries.
    for (const reports of Object.values(result.runs)) for (const report of reports) {
      report.agentSummary = agentSummary(report.agentLog);
      if (report.valid) delete report.agentLog;
    }
    writeFileSync(settings.json, `${JSON.stringify(result, null, 1)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result.machine)}\n${markdown(result)}\n`);
  if (Object.values(result.runs).some((reports) => reports.some((report) => !report.valid))) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
