#!/usr/bin/env node
// Runtime cost benchmark: memory and CPU of the built app in hidden windows (idle, N terminal cards, a
// fixed-rate output flood in every card, 10 s after it, a canvas pan) plus micro-benchmarks of the
// main-process hot paths. Every run gets its own throw-away HOME, userData and working folder, and the app
// never reads the keychain or shows a window. See docs/performance-benchmark.md.
//
//   npx electron-vite build            # the app scenarios measure out/
//   node scripts/bench-runtime.mjs [--runs 3] [--terminals 8] [--kbps 1024] [--flood-seconds 20]
//                                  [--micro-only | --app-only | --pan-only] [--json report.json]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, cpus, totalmem, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { invalidateTrial, readTrial, reapTrial, successfulTrials } from "./bench/trial.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HERE = join(ROOT, "scripts", "bench-runtime");
// Short temporary paths: the app puts Unix sockets under userData, and macOS caps a socket path at 104 bytes.
const TEMP = process.env.BENCH_TMPDIR || (process.platform === "win32" ? tmpdir() : "/tmp");

function options(argv) {
  const result = { runs: 3, terminals: 8, kbps: 1024, floodSeconds: 20, micro: true, app: true, panOnly: false, json: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => argv[++i];
    if (flag === "--runs") result.runs = Number(value());
    else if (flag === "--terminals") result.terminals = Number(value());
    else if (flag === "--kbps") result.kbps = Number(value());
    else if (flag === "--flood-seconds") result.floodSeconds = Math.max(15, Number(value()));
    else if (flag === "--micro-only") result.app = false;
    else if (flag === "--app-only") result.micro = false;
    else if (flag === "--pan-only") { result.micro = false; result.panOnly = true; }
    else if (flag === "--json") result.json = resolve(value());
    else throw new Error(`Unknown option ${flag}`);
  }
  return result;
}

/** A fresh HOME and every tool home inside it, so nothing reads or writes the person's own configuration. */
function isolatedEnvironment(extra = {}) {
  const home = mkdtempSync(join(TEMP, "ctb-home-"));
  writeFileSync(join(home, ".zshrc"), "");
  return {
    home,
    env: {
      HOME: home, USER: process.env.USER ?? "bench", LOGNAME: process.env.USER ?? "bench", TMPDIR: TEMP, LANG: "en_US.UTF-8",
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: "/bin/zsh",
      GROK_HOME: join(home, ".grok"), CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
      XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
      ...extra
    }
  };
}

function run(command, args, env, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const kill = () => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch { /* The owned process group may already have exited. */ }
    };
    const timer = setTimeout(kill, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      kill();
      if (code === 0 && signal === null) resolvePromise(stdout);
      else reject(new Error(`${command} exited code=${code}, signal=${signal}: ${stderr.slice(-2000)}`));
    });
  });
}

async function microRun() {
  const { home, env } = isolatedEnvironment();
  try {
    const stdout = await run(process.execPath, ["--experimental-strip-types", "--no-warnings", join(HERE, "micro.mjs"), ROOT], env, 300_000);
    const measurements = JSON.parse(stdout.trim().split("\n").at(-1));
    if (!measurements || typeof measurements !== "object" || Array.isArray(measurements)) throw new Error("the micro benchmark wrote no measurement object");
    for (const field of ["orchestratorToolCallMs", "observeAgentMs", "listAgentsMs", "evenG2FeedMs", "kimiFirstLaunchBlockMs"]) {
      if (!Number.isFinite(measurements[field])) throw new Error(`missing or invalid micro measurement: ${field}`);
    }
    return { ...measurements, valid: true };
  } catch (error) {
    return { valid: false, validationErrors: [error.message] };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function appRun(settings) {
  const electron = createRequire(import.meta.url)("electron");
  const userData = mkdtempSync(join(TEMP, "ctb-u-"));
  const work = mkdtempSync(join(TEMP, "ctb-w-"));
  const flood = join(work, "flood.mjs");
  cpSync(join(HERE, "flood.mjs"), flood);
  const out = join(userData, "..", `${userData.split("/").at(-1)}-report.json`);
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ settingsVersion: 21, locale: "en", sessionRestoreMode: "off" }));
  const { home, env } = isolatedEnvironment({
    BENCH_ROOT: ROOT, BENCH_OUT: out, BENCH_USERDATA: userData, BENCH_WORK: work,
    BENCH_NODE: process.execPath, BENCH_FLOOD: flood, BENCH_KBPS: String(settings.kbps),
    BENCH_TERMINALS: String(settings.terminals), BENCH_FLOOD_SECONDS: String(settings.floodSeconds),
    BENCH_PAN_ONLY: settings.panOnly ? "1" : "0"
  });
  let report;
  try {
    let exit = null;
    await run(electron, [join(HERE, "app")], env, 240_000 + settings.floodSeconds * 1000).catch((error) => { exit = error; });
    report = readTrial(out, { exitError: exit, requiredNumbers: [
      "readyAfterMs", "scenarios.pan.moves", "scenarios.pan.commits", "scenarios.pan.rendererMsPerMove.task",
      ...(!settings.panOnly ? ["idle", "terminals", "flood", "after"].map((name) => `scenarios.${name}.rssMb.total`) : [])
    ] });
    if (!settings.panOnly && settings.terminals > 0 && !(report.scenarios?.flood?.terminalDataToRendererMb > 0)) {
      invalidateTrial(report, "the flood delivered no terminal output to the renderer");
    }
    return report;
  } finally {
    try {
      if (process.platform !== "win32") reapTrial([userData, work, home]);
    } catch (error) {
      if (report) invalidateTrial(report, `process cleanup: ${error.message}`);
      else throw error;
    } finally {
      for (const path of [userData, work, home, out]) rmSync(path, { recursive: true, force: true });
    }
  }
}

function median(values) {
  const numbers = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

/** The median of every numeric leaf across runs, keeping the report's shape. */
function medianOf(reports) {
  const first = reports[0];
  if (typeof first === "number") return median(reports);
  if (!first || typeof first !== "object" || Array.isArray(first)) return first;
  return Object.fromEntries(Object.keys(first).map((key) => [key, medianOf(reports.map((report) => report?.[key]))]));
}

function bundle() {
  const assets = join(ROOT, "out", "renderer", "assets");
  if (!existsSync(assets)) return null;
  const files = readdirSync(assets).map((name) => ({ name, bytes: statSync(join(assets, name)).size }));
  const sum = (filter) => files.filter(filter).reduce((total, file) => total + file.bytes, 0);
  return {
    rendererJsKb: Math.round(sum((file) => file.name.endsWith(".js")) / 1024),
    rendererCssKb: Math.round(sum((file) => file.name.endsWith(".css")) / 1024),
    rendererImagesKb: Math.round(sum((file) => /\.(png|ico|svg|webp)$/u.test(file.name)) / 1024),
    largestImage: files.filter((file) => /\.(png|ico|webp)$/u.test(file.name)).sort((a, b) => b.bytes - a.bytes)[0] ?? null
  };
}

function machine() {
  let os = `${process.platform} ${release()}`;
  try {
    if (process.platform === "darwin") {
      const version = readFileSync("/System/Library/CoreServices/SystemVersion.plist", "utf8").match(/<key>ProductVersion<\/key>\s*<string>([^<]+)/u)?.[1];
      if (version) os = `macOS ${version}`;
    }
  } catch {}
  return { os, cpu: cpus()[0]?.model ?? "unknown", cores: cpus().length, ramGb: Math.round(totalmem() / 1024 ** 3), node: process.version };
}

function table(result) {
  const lines = [];
  const scenarios = result.app?.scenarios ?? {};
  for (const name of ["idle", "terminals", "flood", "after"]) {
    const s = scenarios[name];
    if (!s) continue;
    lines.push(`${name.padEnd(10)} RSS total ${s.rssMb.total} MB (electron ${s.rssMb.electron}, main ${s.rssMb.main}, renderer ${s.rssMb.renderer}, gpu ${s.rssMb.gpu}, pty ${s.rssMb.pty}) peak ${s.peakRssMb} MB | CPU main ${s.cpu.main}% renderer ${s.cpu.renderer}% gpu ${s.cpu.gpu}% utility ${s.cpu.utility}%`);
  }
  if (scenarios.flood?.terminalDataToRendererMb !== undefined) lines.push(`flood      terminal:data to renderer ${scenarios.flood.terminalDataToRendererMb} Mi UTF-16 code units`);
  if (scenarios.pan) lines.push(`pan        ${JSON.stringify(scenarios.pan)}`);
  if (result.micro) lines.push(`micro      ${JSON.stringify(result.micro)}`);
  if (result.bundle) lines.push(`bundle     ${JSON.stringify(result.bundle)}`);
  return lines.join("\n");
}

async function main() {
  const settings = options(process.argv.slice(2));
  if (settings.app && !existsSync(join(ROOT, "out", "main", "index.js"))) {
    throw new Error("Build the app first: npx electron-vite build");
  }
  const result = { machine: machine(), settings, runs: { micro: [], app: [] } };
  for (let i = 0; i < settings.runs; i++) {
    if (settings.micro) {
      process.stderr.write(`micro run ${i + 1}/${settings.runs}\n`);
      const report = await microRun();
      if (!report.valid) process.stderr.write(`  invalid trial: ${JSON.stringify(report.validationErrors)}\n`);
      result.runs.micro.push(report);
    }
    if (settings.app) {
      process.stderr.write(`app run ${i + 1}/${settings.runs}\n`);
      const report = await appRun(settings);
      if (!report.valid) process.stderr.write(`  invalid trial: ${JSON.stringify(report.validationErrors)}\n`);
      result.runs.app.push(report);
    }
  }
  result.trials = Object.fromEntries(Object.entries(result.runs).map(([kind, reports]) => [kind, {
    total: reports.length, valid: successfulTrials(reports).length, invalid: reports.filter((report) => !report.valid).length
  }]));
  if (settings.micro) result.micro = medianOf(successfulTrials(result.runs.micro).map(({ valid, ...measurements }) => measurements)) ?? null;
  if (settings.app) result.app = { scenarios: medianOf(successfulTrials(result.runs.app).map((report) => report.scenarios)) ?? null };
  result.bundle = bundle();
  if (settings.json) writeFileSync(settings.json, `${JSON.stringify(result, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify(result.machine)}\nTrials: ${JSON.stringify(result.trials)}\n${table(result)}\n`);
  if (Object.values(result.trials).some((counts) => counts.invalid > 0)) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
