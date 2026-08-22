import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "darwin") {
  throw new Error("The packaged CLI-resolution smoke requires macOS.");
}

const PROVIDERS = ["codex", "claude", "kimi", "opencode", "hermes", "grok"];
const READY_MARKER = "CANVASTTY_CLI_RESOLUTION_SMOKE_READY ";
const MAX_OUTPUT_BYTES = 256 * 1024;
const root = await mkdtemp(join(tmpdir(), "canvastty-cli-resolution-"));

try {
  const appPath = await packagedApplication();
  const executable = join(appPath, "Contents", "MacOS", "CanvasTTY");
  const platformRoot = join(root, "platform-root");
  const home = join(root, "home");
  const homebrewBin = join(platformRoot, "opt", "homebrew", "bin");
  await Promise.all([
    mkdir(homebrewBin, { recursive: true, mode: 0o700 }),
    mkdir(home, { recursive: true, mode: 0o700 })
  ]);
  for (const provider of PROVIDERS) {
    const path = join(homebrewBin, provider);
    await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  }

  const available = await runSmoke(executable, platformRoot, home, "available");
  for (const provider of PROVIDERS) {
    const resolution = available[provider];
    if (resolution?.state !== "available") {
      throw new Error(`${provider} was not available in the packaged startup snapshot.`);
    }
    if (resolution.executable !== join(homebrewBin, provider)) {
      throw new Error(`${provider} resolved an unexpected executable: ${resolution.executable}`);
    }
  }

  await chmod(join(homebrewBin, "codex"), 0o600);
  const unavailable = await runSmoke(executable, platformRoot, home, "unavailable");
  if (unavailable.codex?.state !== "unavailable") {
    throw new Error("Non-executable Codex was not rejected in the packaged startup snapshot.");
  }
  const rejected = unavailable.codex.checked.find((candidate) => (
    candidate.path === join(homebrewBin, "codex") && candidate.result === "not-executable"
  ));
  if (!rejected || !unavailable.codex.diagnostic.includes(`${rejected.path}: not-executable`)) {
    throw new Error("Packaged unavailable diagnostics did not preserve the rejected Codex path.");
  }

  process.stdout.write("Packaged CLI resolution smoke passed.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function findApplication(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name === "CanvasTTY.app") return path;
    if (entry.isDirectory()) {
      const nested = await findApplication(path).catch(() => null);
      if (nested) return nested;
    }
  }
  throw new Error(`CanvasTTY.app was not found below ${directory}.`);
}

async function packagedApplication() {
  const preferred = join(process.cwd(), "release", "mac-arm64", "CanvasTTY.app");
  try {
    await access(preferred);
    return preferred;
  } catch {
    return findApplication(join(process.cwd(), "release"));
  }
}

async function runSmoke(executable, platformRoot, home, label) {
  const userData = join(root, `user-data-${label}`);
  await mkdir(userData, { recursive: true, mode: 0o700 });
  const child = spawn(executable, [`--user-data-dir=${userData}`, "--disable-gpu"], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      CANVASTTY_CLI_RESOLUTION_SMOKE: "1",
      CANVASTTY_CLI_RESOLUTION_SMOKE_ROOT: platformRoot,
      CANVASTTY_CLI_RESOLUTION_SMOKE_HOME: home
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const consume = (chunk) => {
    output = `${output}${chunk.toString("utf8")}`;
    if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  const result = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Packaged CLI-resolution smoke timed out.\n${output.slice(-16_384)}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`Packaged smoke exited unsuccessfully (code=${result.code}, signal=${result.signal}).\n${output.slice(-16_384)}`);
  }
  const markerIndex = output.indexOf(READY_MARKER);
  if (markerIndex === -1) throw new Error(`Packaged smoke marker was missing.\n${output.slice(-16_384)}`);
  const line = output.slice(markerIndex + READY_MARKER.length).split(/\r?\n/u, 1)[0];
  return JSON.parse(line);
}
