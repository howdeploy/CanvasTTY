import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const READY_MARKER = "CANVASTTY_SMOKE_READY";
const DEFAULT_TIMEOUT_MS = 20_000;

export async function findAppImage(releaseDirectory = join(PROJECT_ROOT, "release")) {
  const candidates = (await readdir(releaseDirectory))
    .filter((name) => name.endsWith(".AppImage"))
    .sort();
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one AppImage in ${releaseDirectory}, found ${candidates.length}.`);
  }
  return join(releaseDirectory, candidates[0]);
}

export async function smokeAppImage(appImagePath, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userData = await mkdtemp(join(tmpdir(), "canvastty-appimage-smoke-"));
  const startedAt = performance.now();
  let output = "";
  let child;

  try {
    child = (options.spawn ?? spawn)(appImagePath, [
      "--disable-gpu",
      `--user-data-dir=${userData}`
    ], {
      env: {
        ...process.env,
        APPIMAGELAUNCHER_DISABLE: "1",
        CANVASTTY_SMOKE_TEST: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const elapsedMs = await new Promise((resolveElapsed, reject) => {
      let ready = false;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`AppImage did not render within ${timeoutMs} ms. Output:\n${output}`));
      }, timeoutMs);

      const consume = (chunk) => {
        output += chunk.toString();
        if (!ready && output.includes(READY_MARKER)) {
          ready = true;
          clearTimeout(timer);
          resolveElapsed(Math.round(performance.now() - startedAt));
        }
      };
      child.stdout.on("data", consume);
      child.stderr.on("data", consume);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (ready) return;
        clearTimeout(timer);
        reject(new Error(`AppImage exited before rendering (code=${code}, signal=${signal}). Output:\n${output}`));
      });
    });
    const exit = await waitForExit(child, 5_000);
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`AppImage exited unsuccessfully (code=${exit.code}, signal=${exit.signal}). Output:\n${output}`);
    }

    return { elapsedMs, output };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 2_000).catch(() => child.kill("SIGKILL"));
    }
    await rm(userData, { recursive: true, force: true });
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`AppImage process did not exit within ${timeoutMs} ms.`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolveExit({ code, signal });
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appImagePath = await findAppImage();
  const result = await smokeAppImage(appImagePath);
  console.log(`${basename(appImagePath)} rendered in ${result.elapsedMs} ms.`);
}
