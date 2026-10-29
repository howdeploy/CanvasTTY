import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, accessSync, fstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// The kernel PTY pool is shared by all processes. Never run a stress test on a
// person's desktop, including a second Electron instance with a clean profile.
if (process.platform !== "darwin" || process.env.CI !== "true" ||
    process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
  throw new Error("PTY resource smoke requires an isolated macOS CI runner; no PTY was allocated.");
}

const require = createRequire(import.meta.url);
const runtimeStdioReuse = new Map();
const options = parseArguments(process.argv.slice(2));
if (options.worker) await runWorker(options);
else await runDriver(options);

function parseArguments(args) {
  const result = { cycles: 400, stdioMask: 0, worker: false, expectLeak: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--worker") result.worker = true;
    else if (arg === "--expect-leak") result.expectLeak = true;
    else if (["--cycles", "--stdio-mask", "--app", "--report", "--worker-report"].includes(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      if (arg === "--cycles" || arg === "--stdio-mask") {
        if (!/^\d+$/u.test(value)) throw new Error(`Invalid integer for ${arg}`);
        result[arg === "--cycles" ? "cycles" : "stdioMask"] = Number(value);
      } else result[arg.slice(2)] = resolve(value);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  assert.ok(result.cycles >= 1 && result.cycles <= 500, "cycles must be between 1 and 500");
  assert.ok(result.stdioMask >= 0 && result.stdioMask <= 7, "stdio mask must be between 0 and 7");
  if (result.app?.startsWith("/Applications/")) throw new Error("Refusing to test an installed application.");
  if (result.expectLeak && (result.cycles > 6 || result.stdioMask !== 0 || result.app)) {
    throw new Error("The unpatched control is restricted to at most six cycles of the source dependency.");
  }
  return result;
}

async function runDriver(config) {
  if (config.app) {
    config.app = await realpath(config.app);
    if (config.app.startsWith("/Applications/") || /\/Users\/[^/]+\/Applications\//u.test(config.app)) {
      throw new Error("Refusing a canonical path to an installed application.");
    }
  }
  const root = await mkdtemp(join(tmpdir(), "canvastty-pty-resources-"));
  try {
    const reportPath = join(root, "result.json");
    const executable = config.app ? join(config.app, "Contents", "MacOS", "CanvasTTY") : require("electron");
    const args = [fileURLToPath(import.meta.url), "--worker", "--cycles", String(config.cycles),
      "--stdio-mask", String(config.stdioMask), "--worker-report", reportPath];
    if (config.app) args.push("--app", config.app);
    if (config.expectLeak) args.push("--expect-leak");
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, CI: "true", GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: "github-hosted", ELECTRON_RUN_AS_NODE: "1" },
      stdio: "ignore"
    });
    const exited = new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    let timedOut = false;
    let timeout;
    const exit = await Promise.race([exited, new Promise((resolveTimeout) => {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
        resolveTimeout({ code: null, signal: "SIGKILL" });
      }, 600_000);
    })]).catch((error) => ({ code: 1, signal: null, error: error.message }))
      .finally(() => clearTimeout(timeout));
    if (timedOut) await Promise.race([exited, delay(2000)]);
    const report = await readFile(reportPath, "utf8").then(JSON.parse, () => ({
      ok: false, runtime: config.app ? "packaged" : "source", measurementsUnavailable: true,
      error: timedOut ? "Driver watchdog expired; its own worker was stopped." :
        (exit.error || "Worker exited without a measurement report.")
    }));
    if (timedOut) { report.ok = false; report.timedOut = true; }
    if (config.report) {
      await mkdir(dirname(config.report), { recursive: true });
      await writeFile(config.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    }
    console.log(`CANVASTTY_PTY_FD_REPORT ${JSON.stringify(report)}`);
    assert.equal(exit.signal, null, "the smoke must complete normally");
    assert.equal(exit.code, 0, "the worker reported a regression");
    assert.equal(report.ok, true, "the native resource checks failed");
  } finally {
    // Only the directory created by this invocation, never an application profile.
    await rm(root, { recursive: true, force: true });
  }
}

function census() {
  const text = execFileSync("/usr/sbin/lsof", ["-nP", "-p", String(process.pid), "-F", "fnt"], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"]
  });
  const entries = [];
  let entry;
  for (const line of text.split("\n")) {
    if (/^f\d+$/u.test(line)) { entry = {}; entries.push(entry); }
    else if (line.startsWith("f")) entry = undefined;
    else if (entry && line.startsWith("n")) entry.name = line.slice(1);
    else if (entry && line.startsWith("t")) entry.type = line.slice(1);
  }
  assert.ok(entries.length > 0, "a failed/empty descriptor census must not become a zero count");
  return {
    total: entries.length,
    ptmx: entries.filter((fd) => fd.name === "/dev/ptmx").length,
    slave: entries.filter((fd) => fd.name?.startsWith("/dev/ttys") || fd.name?.includes("(revoked)")).length,
    kqueue: entries.filter((fd) => fd.type === "KQUEUE").length
  };
}

function returnedToBaseline(before, after) {
  // lsof's synchronous child and Node's asynchronous pipe cleanup can differ by
  // two ordinary descriptors. PTY masters/slaves and exit kqueues have NO allowance.
  return Math.abs(after.total - before.total) <= 2 && after.ptmx === before.ptmx &&
    after.slave === before.slave && after.kqueue === before.kqueue;
}

async function settledCensus(before) {
  let after;
  for (let attempt = 0; attempt < 15; attempt++) {
    await delay(20);
    after = census();
    if (returnedToBaseline(before, after)) break;
  }
  return after;
}

function verifyClosedStdio(mask) {
  for (let fd = 0; fd < 3; fd++) {
    if (!(mask & (1 << fd))) continue;
    let metadata;
    try { metadata = fstatSync(fd); }
    catch (error) { if (error.code === "EBADF") continue; throw error; }
    // Node/libuv may reuse a vacant stdio number for its own wakeup pipe or
    // queue after the native function returns. That is not a leaked PTY. The
    // pure native harness requires the original holes to remain closed; this
    // integration test rejects PTY reuse and still demands stable FD counts.
    let kind = metadata.isFIFO() ? "PIPE" : metadata.isSocket() ? "socket" : undefined;
    if (!kind) {
      const details = execFileSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(process.pid), "-d", String(fd), "-F", "tn"], {
        encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024
      }).split("\n");
      const type = details.find((line) => line.startsWith("t"))?.slice(1);
      if (type === "KQUEUE") kind = "KQUEUE";
      else if (details.includes("n/dev/null")) kind = "/dev/null";
      else throw new Error(`Unexpected reuse of stdio FD ${fd}: ${type || "unknown"}; no PTY reuse is permitted`);
    }
    runtimeStdioReuse.set(fd, kind);
  }
}

async function runWorker(config) {
  assert.ok(config["worker-report"], "the worker must have a dedicated result file");
  assert.ok(process.versions.electron, "the worker must run in actual Electron");
  // Allocate the result FD before closing stdio, so native reservations cannot
  // accidentally overwrite the test's reporting channel.
  const reportFd = openSync(config["worker-report"], "wx", 0o600);
  const report = { ok: false, runtime: config.app ? "packaged" : "source", pid: process.pid,
    cyclesRequested: config.cycles, cyclesCompleted: 0, stdioMask: config.stdioMask,
    expectedLeak: config.expectLeak, normalExits: 0, stopped: 0, spawnFailures: 0 };
  let activeTerminal;
  const watchdog = setTimeout(() => {
    report.ok = false;
    report.timedOut = true;
    report.error = "Worker watchdog expired.";
    try { activeTerminal?.kill("SIGKILL"); } catch {}
    writeSync(reportFd, `${JSON.stringify(report, null, 2)}\n`);
    closeSync(reportFd);
    process.exit(1);
  }, 600_000);
  watchdog.unref();
  try {
    // Follow the application's real ASAR import route. node-pty rewrites the
    // helper's ASAR path itself; importing from .unpacked would double it.
    const moduleRoot = config.app ? join(config.app, "Contents", "Resources", "app.asar", "node_modules", "node-pty") :
      dirname(require.resolve("node-pty/package.json"));
    const physicalModuleRoot = config.app ? join(config.app, "Contents", "Resources", "app.asar.unpacked", "node_modules", "node-pty") : moduleRoot;
    const native = require(join(moduleRoot, "lib", "utils.js")).loadNativeModule("pty");
    assert.equal(native.dir, "../build/Release/", "the smoke must load the rebuilt addon, not an unpatched prebuild");
    const binary = join(physicalModuleRoot, "build", "Release", "pty.node");
    accessSync(join(physicalModuleRoot, "build", "Release", "spawn-helper"), constants.X_OK);
    report.addonSha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
    report.electron = process.versions.electron;
    report.arch = process.arch;
    const pty = require(moduleRoot);
    for (let fd = 0; fd < 3; fd++) if (config.stdioMask & (1 << fd)) closeSync(fd);

    async function cycle(stop = false) {
      // This smoke measures resource ownership, so keep a normal child alive
      // until its actual output reached the consumer. node-pty forcibly closes
      // its socket 200 ms after an early exit; an instantaneous printf can lose
      // unread data under scheduling pressure even though its exit code is zero.
      // The ACK differs from the marker, so terminal input echo cannot pass the
      // output check. Missing output still times out and fails this cycle.
      const terminal = pty.spawn(stop ? "/bin/sleep" : "/bin/sh", stop ? ["30"] : ["-c",
        'printf "PTY_CYCLE_OK\\n" && IFS= read -r reply && test "$reply" = PTY_CYCLE_ACK'], {
        name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" }
      });
      activeTerminal = terminal;
      let output = "";
      let acknowledged = false;
      const data = terminal.onData((text) => {
        output = (output + text).slice(-1024);
        if (!stop && !acknowledged && output.includes("PTY_CYCLE_OK")) {
          acknowledged = true;
          terminal.write("PTY_CYCLE_ACK\n");
        }
      });
      let ended = false;
      let timer;
      let subscription;
      const exited = new Promise((resolveExit) => {
        subscription = terminal.onExit((event) => { ended = true; resolveExit(event); });
      });
      let result;
      try {
        if (stop) terminal.kill("SIGTERM");
        result = await Promise.race([exited, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("one PTY exceeded its five-second budget")), 5000);
        })]);
      } finally {
        clearTimeout(timer);
        data.dispose();
        if (!ended) {
          try { terminal.kill("SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
          await Promise.race([exited, delay(1000)]);
        }
        subscription.dispose();
        activeTerminal = undefined;
      }
      if (stop) report.stopped++;
      else {
        assert.equal(result.exitCode, 0);
        assert.ok(output.includes("PTY_CYCLE_OK"), "a completed process must produce the actual command output");
        report.normalExits++;
      }
      await delay(20);
      verifyClosedStdio(config.stdioMask);
    }

    // Warm libuv's lazy resources in the SAME parent; no parent is restarted
    // between any warmup, measured cycle, termination or failed native spawn.
    for (let i = 0; i < 3; i++) await cycle();
    report.before = census();
    report.peakSettled = { ...report.before };
    for (let i = 0; i < config.cycles; i++) {
      await cycle(i % 5 === 4);
      const after = await settledCensus(report.before);
      report.after = after;
      for (const key of Object.keys(after)) report.peakSettled[key] = Math.max(report.peakSettled[key], after[key]);
      report.cyclesCompleted++;
      if (!returnedToBaseline(report.before, after)) {
        report.leakDetected = true;
        if (config.expectLeak) {
          assert.ok(after.ptmx > report.before.ptmx, "the control must reproduce the specific extra-master leak");
          report.ok = true;
          return;
        }
        // Abort at FIRST growth; do not use a failing implementation to consume
        // the shared kernel pool for the remaining 400 cycles.
        throw new Error(`FD growth after cycle ${i + 1}: ${JSON.stringify({ before: report.before, after })}`);
      }
    }
    assert.equal(config.expectLeak, false, "the unpatched control unexpectedly passed; no RED evidence");

    const argmax = Number(execFileSync("/usr/sbin/sysctl", ["-n", "kern.argmax"], { encoding: "utf8", timeout: 5000 }));
    assert.ok(Number.isSafeInteger(argmax) && argmax > 0 && argmax <= 4 * 1024 * 1024);
    for (let i = 0; i < 2; i++) {
      // A missing target only fails INSIDE a successfully spawned helper. An
      // oversized argv fails posix_spawn itself and exercises native ownership.
      assert.throws(() => pty.spawn("/usr/bin/true", ["x".repeat(argmax * 2)], {
        cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" }
      }), (error) => error.errno === osConstants.errno.E2BIG && /posix_spawnp failed/u.test(error.message),
      "the failure must come from native posix_spawn with E2BIG, not JS validation or an unrelated exception");
      report.spawnFailures++;
      const after = await settledCensus(report.before);
      assert.ok(returnedToBaseline(report.before, after), `failed spawn leaked: ${JSON.stringify(after)}`);
      verifyClosedStdio(config.stdioMask);
    }
    // A fresh PTY still starts after the complete run and both native failures.
    await cycle();
    report.after = await settledCensus(report.before);
    assert.ok(returnedToBaseline(report.before, report.after));
    report.freshPtyAfterFailures = true;
    report.ok = true;
  } catch (error) {
    report.error = String(error.message).slice(0, 2000);
    if (Number.isInteger(error.errno)) report.errno = error.errno;
    if (typeof error.code === "string") report.code = error.code;
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    report.stdioReusedByRuntime = [...runtimeStdioReuse].map(([fd, kind]) => ({ fd, kind }));
    writeSync(reportFd, `${JSON.stringify(report, null, 2)}\n`);
    closeSync(reportFd);
    // A broken native watcher can retain a NAPI reference even after its child
    // was killed. Save the real failure first, then end ONLY this test worker.
    if (process.exitCode) process.exit(process.exitCode);
  }
}
