import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const READY_MARKER = "CANVASTTY_BROWSER_SMOKE_READY";
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const layeringOnly = process.argv.includes("--layering-only");

const fixture = await startFixture();
// Keep the macOS Unix-domain-socket endpoint below its 104-byte kernel limit.
// tmpdir() expands into /var/folders/... there, while /tmp resolves to a short,
// private random test directory just like the Linux CI path.
const smokeTempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
const userDataPath = await mkdtemp(join(smokeTempRoot, "ctb-"));
const fakeHomePath = join(userDataPath, "home");
await mkdir(fakeHomePath, { recursive: true, mode: 0o700 });
let child;
let output = "";

try {
  const electronArgs = [PROJECT_ROOT, `--user-data-dir=${userDataPath}`, "--disable-gpu"];
  // GitHub hosted Linux runners cannot install Electron's chrome-sandbox with
  // root ownership and mode 4755. Product WebContents security is asserted by
  // unit tests; only this isolated CI process disables the outer Chromium sandbox.
  if (process.platform === "linux" && process.env.CI === "true") electronArgs.push("--no-sandbox");
  const smokeEnv = {
    ...process.env,
    HOME: fakeHomePath,
    CODEX_HOME: join(fakeHomePath, ".codex"),
    XDG_CONFIG_HOME: join(fakeHomePath, ".config"),
    XDG_DATA_HOME: join(fakeHomePath, ".local", "share"),
    XDG_STATE_HOME: join(fakeHomePath, ".local", "state"),
    XDG_CACHE_HOME: join(fakeHomePath, ".cache"),
    CANVASTTY_USER_DATA_DIR: userDataPath,
    CANVASTTY_BROWSER_SMOKE_URL: fixture.origin,
    CANVASTTY_BROWSER_SMOKE_LAYERING_ONLY: layeringOnly ? "1" : "0"
  };
  if (process.platform === "win32") {
    smokeEnv.USERPROFILE = fakeHomePath;
    smokeEnv.APPDATA = join(fakeHomePath, "AppData", "Roaming");
    smokeEnv.LOCALAPPDATA = join(fakeHomePath, "AppData", "Local");
  }
  // This smoke opens only a loopback fixture and must not inherit a usable provider account.
  for (const name of Object.keys(smokeEnv)) {
    if (/(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|OAUTH_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|APPLICATION_CREDENTIALS|GITHUB_TOKEN|TOKEN)$/i.test(name)) {
      delete smokeEnv[name];
    }
  }
  child = spawn(electronPath, electronArgs, {
    env: smokeEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolveReady, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Browser smoke timed out. Output:\n${output}`));
    }, TIMEOUT_MS);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      reject(error);
    };
    const consume = (chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-MAX_OUTPUT_BYTES);
      if (!settled && output.includes("CanvasTTY startup failed.")) {
        fail(new Error(`Browser smoke reported a startup failure. Output:\n${output}`));
      } else if (!settled && output.includes(READY_MARKER)) {
        settled = true;
        clearTimeout(timer);
        resolveReady();
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("error", (error) => {
      fail(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      fail(new Error(`Browser smoke exited early (code=${code}, signal=${signal}). Output:\n${output}`));
    });
  });
  const exit = await waitForExit(child, 8_000);
  if (exit.code !== 0 || exit.signal !== null) {
    throw new Error(`Browser smoke exited unsuccessfully (code=${exit.code}, signal=${exit.signal}). Output:\n${output}`);
  }
  process.stdout.write(output);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await waitForExit(child, 2_000).catch(() => child.kill("SIGKILL"));
  }
  await fixture.close();
  // Chromium's helper processes can still be flushing the partition when the main process exits; retry the
  // removal so a cleanup race cannot replace the smoke's real result with ENOTEMPTY.
  await rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function startFixture() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/download") {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": "attachment; filename=fixture.txt"
      });
      response.end("CanvasTTY download fixture");
      return;
    }
    if (url.pathname === "/popup") {
      html(response, "<title>Popup fixture</title><main><h1>Popup ready</h1></main>");
      return;
    }
    if (url.pathname === "/next") {
      html(response, "<title>Next fixture</title><main><h1>Navigation ready</h1></main>");
      return;
    }
    html(response, fixtureHtml());
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser fixture did not bind a local port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    })
  };
}

function waitForExit(process, timeoutMs) {
  if (process.exitCode !== null || process.signalCode !== null) {
    return Promise.resolve({ code: process.exitCode, signal: process.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      process.removeListener("exit", onExit);
      reject(new Error(`Electron did not exit within ${timeoutMs} ms.`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    };
    process.once("exit", onExit);
  });
}

function html(response, body) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`<!doctype html><html><body>${body}</body></html>`);
}

function fixtureHtml() {
  return `
  <title>CanvasTTY browser fixture</title>
  <style>
    body { font: 16px system-ui; margin: 24px; min-height: 1200px; }
    label, button, a, select { display: block; margin: 12px 0; }
    #drag-source, #drag-target { width: 150px; height: 42px; border: 1px solid #777; padding: 8px; }
  </style>
  <main>
    <h1>Browser fixture</h1>
    <label>Message <input aria-label="Message"></label>
    <label>Password <input aria-label="Password" type="password" value="canvastty-secret-must-not-leak"></label>
    <label>Mode
      <select aria-label="Mode">
        <option value="fast">Fast</option>
        <option value="safe">Safe</option>
      </select>
    </label>
    <label>Upload <input aria-label="Upload file" type="file"></label>
    <button id="submit">Submit</button>
    <button id="dialog">Open dialog</button>
    <a href="/popup" target="_blank">Open popup</a>
    <a href="/download" download="fixture.txt">Download fixture</a>
    <div id="drag-source" role="button" tabindex="0" aria-label="Drag source">Drag source</div>
    <div id="drag-target" role="button" tabindex="0" aria-label="Drag target">Drag target</div>
    <p id="drag-status" role="status">Drag waiting</p>
    <p id="scroll-status" role="status">Scroll waiting</p>
    <p id="viewport-status" role="status"></p>
    <p id="status" role="status">Waiting</p>
  </main>
  <script>
    const message = document.querySelector('[aria-label="Message"]');
    const mode = document.querySelector('[aria-label="Mode"]');
    document.querySelector('#submit').addEventListener('click', () => {
      document.querySelector('#status').textContent = 'Submitted: ' + message.value + ' / ' + mode.value;
    });
    document.querySelector('#dialog').addEventListener('click', () => {
      document.querySelector('#status').textContent = 'Dialog requested';
      alert('CanvasTTY dialog fixture');
      document.querySelector('#status').textContent = 'Dialog handled';
    });
    const dragSource = document.querySelector('#drag-source');
    const dragTarget = document.querySelector('#drag-target');
    let pointerDragActive = false;
    dragSource.addEventListener('mousedown', () => { pointerDragActive = true; });
    dragTarget.addEventListener('mouseup', () => {
      if (pointerDragActive) document.querySelector('#drag-status').textContent = 'Drag completed';
      pointerDragActive = false;
    });
    document.addEventListener('mouseup', () => { pointerDragActive = false; });
    window.addEventListener('scroll', () => {
      if (window.scrollY > 0) document.querySelector('#scroll-status').textContent = 'Scroll completed';
    }, { passive: true });
    const reportViewport = () => {
      document.querySelector('#viewport-status').textContent = 'Viewport width: ' + window.innerWidth;
    };
    window.addEventListener('resize', reportViewport);
    reportViewport();
  </script>
`;
}
