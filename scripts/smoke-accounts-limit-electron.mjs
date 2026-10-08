import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runElectronSmoke } from "./lib/run-electron-smoke.mjs";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const self = fileURLToPath(import.meta.url);
const electron = createRequire(import.meta.url)("electron");
const accountsPlugin = resolve(process.env.CANVASTTY_ACCOUNTS_PLUGIN_DIR
  ?? resolve(repo, "../canvastty-work/canvastty-plugin-accounts"));
const marker = "CANVASTTY_ACCOUNTS_LIMIT_ELECTRON_OK";
const pluginId = "canvastty-accounts";

if (typeof electron === "string") {
  const root = await mkdtemp("/private/tmp/ctv-accounts-limit-");
  try {
    const fixture = await createFixture(root);
    const environment = {
      HOME: fixture.home,
      CODEX_HOME: fixture.codexHome,
      CANVASTTY_USER_DATA_DIR: fixture.userData,
      CANVASTTY_ACCOUNTS_LIMIT_STAMP: fixture.stamp,
      CANVASTTY_ACCOUNTS_LIMIT_PROJECT: fixture.project,
      TMPDIR: fixture.tmp,
      PATH: [fixture.providerBin, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
      SHELL: "/bin/sh",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8"
    };
    await runElectronSmoke(electron, self, environment, marker);
    const stamp = JSON.parse(await readFile(fixture.stamp, "utf8"));
    assert.equal(stamp.method, "account/rateLimits/read", "the real limits adapter queried the fake local Codex app-server");
    assert.equal(stamp.usedPercent, 100, "the fixture returned an exhausted default Codex quota bucket");
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
        const proof = await window.webContents.executeJavaScript(
          `(${probe.toString()})(${JSON.stringify({ pluginId, project: process.env.CANVASTTY_ACCOUNTS_LIMIT_PROJECT })})`, true
        );
        console.log(`${marker} ${JSON.stringify(proof)}`);
        electron.app.quit();
      } catch (error) {
        console.error("Accounts quota Electron smoke failed:", error);
        electron.app.exit(1);
      }
    });
  });
  // Exercise the built app's real main process, preload, plugin supervisor, IPC and renderer.
  void import(pathToFileURL(join(repo, "out/main/index.js")).href);
}

async function createFixture(root) {
  const userData = join(root, "data");
  const project = join(root, "project");
  const providerBin = join(root, "provider-bin");
  const home = join(root, "home");
  const codexHome = join(root, "codex-home");
  const tmp = join(root, "tmp");
  const pluginDir = join(userData, "plugins", pluginId);
  const metadataDir = join(pluginDir, "metadata");
  const stamp = join(root, "provider-limit-response.json");
  await Promise.all([userData, project, providerBin, home, codexHome, tmp, metadataDir].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(join(project, "fixture.txt"), "Synthetic quota UI fixture.\n");

  const manifest = JSON.parse(await readFile(join(accountsPlugin, "canvastty.plugin.json"), "utf8"));
  assert.equal(manifest.id, pluginId, "the current Accounts plugin bundle is the one installed into the fixture");
  const service = manifest.services?.find(candidate => candidate.id === "accounts");
  assert.ok(service?.entry, "Accounts declares its actual bundled service entry");
  await writeFile(join(metadataDir, "canvastty.plugin.json"), JSON.stringify(manifest, null, 2));
  for (const asset of manifest.coreFiles ?? manifest.files ?? []) {
    assert.ok(typeof asset.path === "string" && !asset.path.split("/").includes(".."), "plugin assets stay within the package");
    const source = join(accountsPlugin, ...asset.path.split("/"));
    const destination = join(pluginDir, ...asset.path.split("/"));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    const bytes = await readFile(destination);
    assert.equal(bytes.length, asset.bytes, `Accounts fixture asset size: ${asset.path}`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256, `Accounts fixture asset hash: ${asset.path}`);
  }
  const serviceBytes = await readFile(join(pluginDir, ...service.entry.split("/")));
  const serviceHash = createHash("sha256").update(serviceBytes).digest("hex");
  await writeFile(join(userData, "plugins.json"), JSON.stringify({
    [pluginId]: {
      sourceUrl: "https://github.com/BIackFIame/canvastty-plugin-accounts",
      enabled: true,
      installedAt: Date.now(),
      trustedServices: { [service.id]: serviceHash }
    }
  }, null, 2));
  await writeFile(join(userData, "settings.json"), JSON.stringify({
    locale: "en",
    sessionRestoreMode: "continue",
    agentIsolation: "off",
    agentControlEnabled: false,
    agentLifecycleHooksEnabled: false,
    browserAgentAccess: false,
    browserRestoreTabs: false
  }));

  const server = join(root, "fake-codex-app-server.mjs");
  await writeFile(server, `import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
const stamp = process.env.CANVASTTY_ACCOUNTS_LIMIT_STAMP;
const reply = (message, result) => process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (typeof message.id !== "number") continue;
  if (message.method === "initialize") { reply(message, {}); continue; }
  if (message.method === "account/rateLimits/read") {
    const usedPercent = 100;
    await writeFile(stamp, JSON.stringify({ method: message.method, usedPercent, at: Date.now() }));
    reply(message, { rateLimits: { limitId: "codex_default", limitName: "Codex", primary: {
      usedPercent, windowDurationMins: 300, resetsAt: Date.now() + 60 * 60 * 1000
    } } });
    continue;
  }
  process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Unsupported fixture method." } }) + "\\n");
}
`);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(join(providerBin, "codex"), `#!/bin/sh
set -eu
if [ "\${1:-}" = "app-server" ]; then exec ${quote(process.execPath)} ${quote(server)}; fi
printf 'FAKE_CODEX_AGENT_READY\\n'
while IFS= read -r line; do [ "$line" = "EXIT_FIXTURE" ] && exit 0; done
`, { mode: 0o700 });
  // The core checks PATH before macOS's global install directories. Put a
  // non-networking fixture command ahead of every known provider name so the
  // isolated app can never select a CLI installed on the host.
  for (const command of ["claude", "qwen", "kimi", "opencode", "hermes", "grok", "omp", "pi", "cursor-agent", "agent", "mcode", "devin", "agy"]) {
    await symlink("codex", join(providerBin, command));
  }
  await writeFile(stamp, JSON.stringify({ method: "not-requested", usedPercent: null, at: 0 }));
  return { userData, project, providerBin, home, codexHome, tmp, stamp };
}

async function probe({ pluginId, project }) {
  const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
  const until = async (read, name, timeoutMs = 15_000, intervalMs = 30) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      await delay(intervalMs);
    }
    throw new Error(`Timed out: ${name}`);
  };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const api = await until(() => window.canvasTTY, "the actual preload API");

  const report = await until(async () => {
    const value = await api.plugins.serviceReport(pluginId);
    return value.services.some(service => service.serviceId === "accounts" && service.state === "running") ? value : null;
  }, "the actual trusted Accounts service process is running");
  const actions = await until(async () => {
    const value = await api.plugins.cardDecorations();
    return value.actions.some(action => action.pluginId === pluginId && action.actionId === "handoff") ? value : null;
  }, "the real Accounts service's declared handoff card action");
  check(report.services.some(service => service.serviceId === "accounts" && service.state === "running"), "Accounts service is running");
  check(actions.actions.some(action => action.pluginId === pluginId && action.actionId === "handoff"), "the real handoff action is registered");

  // A fresh, exhausted fixture quota before there is a card must not emit an offer for an unknown session.
  const warm = await api.limits.get();
  const warmCodex = warm.providers.find(provider => provider.provider === "codex");
  check(warmCodex?.state === "available" && warmCodex.windows.some(window => window.isDefaultBucket && window.usedPercent === 100),
    "the built-in limits adapter reads a real response from the fake Codex app-server");

  const session = await api.terminal.create({ provider: "codex", profile: "normal", cwd: project,
    title: "Accounts quota UI fixture", position: { x: 80, y: 80 },
    launchOptions: { [pluginId]: { account: "none" } } });
  check(typeof session.id === "string" && session.id.length > 0, "the core created a real Codex-backed session");
  await until(async () => (await api.terminal.readBuffer(session.id)).buffer.includes("FAKE_CODEX_AGENT_READY"), "the fixture Codex session became live");
  const card = await until(() => {
    const element = document.querySelector(`.terminal-card[data-session-id="${session.id}"]`);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const inViewport = rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0
      && rect.left < innerWidth && rect.top < innerHeight;
    return style.display !== "none" && style.visibility !== "hidden" && inViewport ? element : null;
  }, "the known session card is actually rendered inside the viewport");

  // Force a fresh limits snapshot after account=none was persisted for this actual session.
  // The only exhausted signal is generated by LimitsService.onSnapshot from the fake Codex app-server response.
  const accountServiceEvents = [];
  api.plugins.onServiceEvent(event => { if (event.pluginId === pluginId) accountServiceEvents.push(event); });
  await api.agents.recheck();
  const snapshot = await api.limits.get();
  const codex = snapshot.providers.find(provider => provider.provider === "codex");
  check(codex?.state === "available" && codex.windows.some(window => window.isDefaultBucket && window.usedPercent === 100),
    "the post-launch provider snapshot contains an exhausted default bucket");

  const event = await until(async () => {
    const page = await api.backlog.timeline(session.id, undefined, 30, { types: ["limit"] });
    return page.items.find(item => item.summary === "Provider quota exhausted") ?? null;
  }, "the real host limit event was recorded for the known card", 3_000);
  let badge;
  try {
    badge = await until(() => {
      const current = document.querySelector(`.terminal-card[data-session-id="${session.id}"]`);
      if (!current) return null;
      const rendered = [...current.querySelectorAll(".terminal-card__plugin-badge")]
        .find(element => element.textContent?.trim() === "quota: handoff");
      if (!rendered) return null;
      const rect = rendered.getBoundingClientRect();
      const style = getComputedStyle(rendered);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" ? rendered : null;
    }, "the Accounts offer rendered on the session card", Math.max(1, 5_000 - (Date.now() - event.at)), 20);
  } catch (error) {
    const currentDecorations = await api.plugins.cardDecorations();
    const serviceState = await api.plugins.serviceReport(pluginId);
    const liveSession = (await api.terminal.list()).find(candidate => candidate.id === session.id);
    throw new Error(`${error.message}; event=${JSON.stringify({ at: event.at, type: event.type, summary: event.summary })}; liveSession=${JSON.stringify(liveSession && { status: liveSession.status, exitCode: liveSession.exitCode })}; hostBadge=${JSON.stringify(currentDecorations.badges[session.id] ?? [])}; serviceEvents=${JSON.stringify(accountServiceEvents)}; service=${JSON.stringify(serviceState.services)}`);
  }
  const renderedAt = Date.now();
  const latencyMs = renderedAt - event.at;
  check(latencyMs >= 0 && latencyMs < 5_000, `the card offer rendered within five seconds of the limit event (${latencyMs} ms)`);

  const visibleCard = document.querySelector(`.terminal-card[data-session-id="${session.id}"]`);
  const options = visibleCard?.querySelector(".terminal-card__action--options");
  check(Boolean(options), "the visible card exposes its options menu");
  options.click();
  const handoff = await until(() => [...document.querySelectorAll(".terminal-card__menu-action")]
    .find(button => button.textContent?.trim() === "Continue after quota") ?? null,
  "the handoff action is visible in the actual card menu", 3_000);
  return {
    sessionId: session.id,
    provider: "codex",
    accountSelection: "none (provider default)",
    hostEvent: { type: event.type, summary: event.summary, at: event.at },
    limitsBucket: { default: true, usedPercent: 100 },
    badge: badge.textContent.trim(),
    action: handoff.textContent.trim(),
    latencyMs,
    visibleBounds: (() => { const rect = card.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })()
  };
}
