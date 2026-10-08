// Shared harness of the native helper parity tests: the two implementations of every helper (the .mjs reference run
// by Node, and canvastty-helper when it is built for this computer), process runners, and scriptable fake gateways
// that record every line they receive.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
export const SCRIPTS = Object.freeze({
  gate: source("src/agent-runtime/permission-gate.mjs"),
  hook: source("src/agent-runtime/hook-helper.mjs"),
  browser: source("src/agent-browser/mcp-helper.mjs"),
  orchestration: source("src/agent-browser/orchestration-helper.mjs")
});

/** The native binary for this platform and architecture, or null when it was not built. */
export function nativeHelperBinary() {
  const override = process.env.CANVASTTY_NATIVE_HELPER_BINARY;
  if (override) return existsSync(override) ? override : null;
  const os = { darwin: "mac", linux: "linux", win32: "win" }[process.platform];
  const path = source(`build/native-helpers/${os}-${process.arch}/canvastty-helper${process.platform === "win32" ? ".exe" : ""}`);
  return existsSync(path) ? path : null;
}

export const NATIVE = nativeHelperBinary();
export const SKIP_NATIVE = NATIVE ? false : "canvastty-helper is not built for this computer (npm run build:helpers -- --host).";

export const IMPLEMENTATIONS = Object.freeze([
  {
    name: "node",
    gate: [process.execPath, SCRIPTS.gate, "pretool"],
    hook: (state, event) => [process.execPath, SCRIPTS.hook, state, event],
    browser: [process.execPath, SCRIPTS.browser],
    orchestration: [process.execPath, SCRIPTS.orchestration]
  },
  {
    name: "native",
    gate: [NATIVE, "permission-gate", "pretool"],
    hook: (state, event) => [NATIVE, "hook", state, event],
    browser: [NATIVE, "mcp-browser"],
    orchestration: [NATIVE, "mcp-orchestration"]
  }
]);

export const root = mkdtempSync(join(tmpdir(), "canvastty-native-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
let serial = 0;
/** An endpoint understood by Node's net server and both helper implementations on this host. */
export const socketPath = () => process.platform === "win32"
  ? `\\\\.\\pipe\\canvastty-native-${process.pid}-${serial++}`
  : join(root, `s${serial++}.sock`);

/** Only what a helper needs: PATH and the runner's (fake) HOME, never the person's environment. */
export function baseEnvironment(extra = {}) {
  return {
    PATH: process.env.PATH ?? (process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin"),
    HOME: root,
    ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...extra
  };
}

/** Runs one short-lived helper to its end: stdin written whole, stdout collected. */
export function runOnce(command, { env, input = "", shell = false }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command[0], command.slice(1), { env, shell, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    const err = [];
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => err.push(Buffer.from(error.message)));
    child.on("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), ms: Date.now() - started }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/** Runs at most `limit` async jobs at once (the machine stays cool). */
export async function limited(jobs, limit = 4) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await jobs[index]();
    }
  }));
  return results;
}

/**
 * A local socket server that records each connection's lines (raw text) and hands every parsed line to
 * `onLine(connection, message, raw)`. `connection.send(value | string)` writes a line.
 */
export async function lineServer(onLine = () => undefined, onConnection = () => undefined) {
  const path = socketPath();
  const connections = [];
  const server = createServer((socket) => {
    const connection = {
      index: connections.length,
      lines: [],
      socket,
      send(value) {
        if (!socket.destroyed) socket.write(typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
      }
    };
    connections.push(connection);
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let newline;
      while ((newline = buffer.indexOf(0x0a)) >= 0) {
        const raw = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        connection.lines.push(raw);
        let message;
        try { message = JSON.parse(raw); } catch { message = undefined; }
        onLine(connection, message, raw);
      }
    });
    onConnection(connection);
  });
  await new Promise((resolve) => server.listen(path, resolve));
  return {
    path,
    connections,
    close: () => new Promise((resolve) => {
      for (const connection of connections) connection.socket.destroy();
      server.close(() => resolve());
    })
  };
}

/** A long-lived stdio MCP helper: `send` writes a line, `until` waits for output, `end` closes stdin. */
export function startMcp(command, env) {
  const child = spawn(command[0], command.slice(1), { env, stdio: ["pipe", "pipe", "pipe"] });
  const output = [];
  let buffer = Buffer.alloc(0);
  const waiters = new Set();
  const settle = () => {
    for (const waiter of [...waiters]) {
      if (waiter.check()) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  };
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let newline;
    while ((newline = buffer.indexOf(0x0a)) >= 0) {
      output.push(buffer.subarray(0, newline).toString("utf8"));
      buffer = buffer.subarray(newline + 1);
    }
    settle();
  });
  child.stderr.on("data", () => undefined);
  child.stdin.on("error", () => undefined);
  const exited = new Promise((resolve) => child.on("close", (code, signal) => { settle(); resolve({ code, signal }); }));
  return {
    child,
    output,
    exited,
    send(value) {
      child.stdin.write(typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
    },
    until(predicate, timeoutMs = 5_000) {
      return new Promise((resolve, reject) => {
        const waiter = { check: () => predicate(output), resolve };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`MCP helper output did not arrive in time: ${JSON.stringify(output).slice(0, 400)}`));
        }, timeoutMs);
        if (waiter.check()) {
          clearTimeout(waiter.timer);
          resolve();
          return;
        }
        waiters.add(waiter);
      });
    },
    end() {
      child.stdin.end();
    },
    kill() {
      child.kill("SIGKILL");
    }
  };
}

export const outputHasId = (id) => (lines) => lines.some((line) => {
  try { return JSON.stringify(JSON.parse(line).id) === JSON.stringify(id); } catch { return false; }
});

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
