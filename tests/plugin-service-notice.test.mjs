import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PluginManager } from "../src/main/services/PluginManager.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";
import {
  PLUGIN_NATIVE_CODE_OFF_ERROR,
  PLUGIN_SERVICE_MODULE_OFF_ERROR,
  pluginServiceNoticeKind,
  pluginServiceNoticeSection,
  pluginServiceNoticeText
} from "../src/shared/pluginServiceNotice.ts";

// A plugin page whose service cannot run because the person has not turned its native code (or its module) on gets
// an actionable notice instead of "Plugin service is not running."; a trusted service that crashed keeps the generic
// text, now with its last error.
const root = fileURLToPath(new URL("..", import.meta.url));
const example = new URL("../examples/plugins/service-echo/", import.meta.url);
const exampleManifest = JSON.parse(await readFile(new URL("canvastty.plugin.json", example), "utf8"));
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function supervisor(manager, options = {}) {
  return new PluginServiceSupervisor({
    command: process.execPath,
    hostVersion: "9.9.9",
    locale: () => "en",
    requestTimeoutMs: 2_000,
    stopGraceMs: 300,
    restartDelaysMs: [30],
    host: {
      storageGet: (pluginId, key) => manager.storageGet(pluginId, key),
      storageSet: (pluginId, key, value) => manager.storageSet(pluginId, key, value),
      emit: () => undefined
    },
    ...options
  });
}

/** What registerIpc's requestPluginService does: the manager's check, then the supervisor. */
async function pageRequest(manager, instance, pluginId, serviceId, method, params) {
  manager.assertService(pluginId, serviceId);
  return instance.request(pluginId, serviceId, method, params);
}

test("native code off: the page's request names the switch, and the notice is localized with a way to Agents", async (t) => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-service-notice-"));
  const manager = new PluginManager(userData, async (_url, destination) => { await cp(example, destination, { recursive: true }); });
  const instance = supervisor(manager);
  manager.setServiceObserver((specs) => instance.sync(specs));
  t.after(async () => {
    await instance.dispose();
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
  });
  await manager.load();
  const { manifest } = await manager.install((await manager.previewInstall("https://github.com/example/service-echo")).token);

  await assert.rejects(pageRequest(manager, instance, manifest.id, "echo", "echo", { text: "x" }), (error) => {
    assert.equal(error.message, PLUGIN_NATIVE_CODE_OFF_ERROR);
    return true;
  });
  const kind = pluginServiceNoticeKind(PLUGIN_NATIVE_CODE_OFF_ERROR);
  assert.equal(kind, "native-code-off");
  assert.equal(pluginServiceNoticeSection(kind), "agents");
  assert.equal(
    pluginServiceNoticeText(kind, "ru"),
    "Нативный код этого плагина выключен — включите его в Настройки → Агенты → Нативный код расширений."
  );
  assert.match(pluginServiceNoticeText(kind, "en"), /native code is turned off — turn it on in Settings → Agents → Extension native code/u);
  assert.equal(pluginServiceNoticeText("open", "ru"), "Открыть настройки");
  assert.equal(pluginServiceNoticeText("open", "en"), "Open settings");
  // The renderer recognizes its own localized text again (the page reports it, the host shows the notice).
  assert.equal(pluginServiceNoticeKind(pluginServiceNoticeText(kind, "ru")), "native-code-off");
  assert.equal(pluginServiceNoticeKind(pluginServiceNoticeText(kind, "en")), "native-code-off");

  // Trusted: the same request reaches the service.
  await manager.setNativeCodeTrusted(manifest.id, true);
  assert.equal((await pageRequest(manager, instance, manifest.id, "echo", "echo", { text: "x" })).count, 1);
  // Disabling revokes the trust; the disabled plugin itself is refused as before.
  await manager.setEnabled(manifest.id, false);
  await manager.setEnabled(manifest.id, true);
  assert.throws(() => manager.assertService(manifest.id, "echo"), (error) => error.message === PLUGIN_NATIVE_CODE_OFF_ERROR);
  assert.throws(() => manager.assertService(manifest.id, "other"), /does not exist/u);
});

test("a service whose module is off says so and points to Plugins", async (t) => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-service-notice-modules-"));
  const files = {
    "apps/echo.html": await readFile(new URL("apps/echo.html", example)),
    "services/echo.mjs": await readFile(new URL("services/echo.mjs", example)),
    "services/extra.mjs": Buffer.from("process.stdin.resume();\n")
  };
  const asset = (path) => ({ path, bytes: files[path].length, sha256: sha256(files[path]) });
  const manifest = {
    ...exampleManifest,
    coreFiles: [asset("apps/echo.html"), asset("services/echo.mjs")],
    modules: [{ id: "extra", title: "Extra", defaultSelected: false, permissions: [], files: [asset("services/extra.mjs")] }],
    services: [...exampleManifest.services, { id: "extra", title: "Extra", entry: "services/extra.mjs", module: "extra" }]
  };
  const manager = new PluginManager(
    userData,
    async (_url, destination) => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "canvastty.plugin.json"), JSON.stringify(manifest));
    },
    async (_url, destination, requested) => {
      for (const file of requested) {
        await mkdir(join(destination, file.path, ".."), { recursive: true });
        await writeFile(join(destination, file.path), files[file.path]);
      }
    }
  );
  t.after(async () => {
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
  });
  await manager.load();
  const installed = await manager.install((await manager.previewInstall("https://github.com/example/service-echo")).token, []);
  await manager.setNativeCodeTrusted(installed.manifest.id, true);
  manager.assertService(installed.manifest.id, "echo");
  assert.throws(() => manager.assertService(installed.manifest.id, "extra"), (error) => error.message === PLUGIN_SERVICE_MODULE_OFF_ERROR);
  const kind = pluginServiceNoticeKind(PLUGIN_SERVICE_MODULE_OFF_ERROR);
  assert.equal(kind, "module-off");
  assert.equal(pluginServiceNoticeSection(kind), "plugins");
  assert.match(pluginServiceNoticeText(kind, "ru"), /Модуль этого плагина с нативным кодом выключен — включите его в Настройки → Плагины/u);
});

test("a trusted service that crashed keeps the generic text, with its last error, and no settings notice", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-service-notice-crash-"));
  const instance = supervisor({ storageGet: async () => null, storageSet: async () => undefined }, { maxRestarts: 0 });
  t.after(async () => { await instance.dispose(); await rm(dir, { recursive: true, force: true }); });
  const entry = [
    'import { createInterface } from "node:readline";',
    'createInterface({ input: process.stdin }).on("line", (line) => {',
    '  const m = JSON.parse(line);',
    '  if (m.method === "crash") process.exit(3);',
    '  if (m.method === "ping") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: "pong" }) + "\\n");',
    "});"
  ].join("\n");
  const entryPath = join(dir, "probe.mjs");
  await writeFile(entryPath, entry);
  await instance.sync([{ pluginId: "com.example.a", serviceId: "probe", root: dir, entryPath, sha256: sha256(entry), dataDir: join(dir, "data"), permissions: [] }]);
  assert.equal(await instance.request("com.example.a", "probe", "ping", null), "pong");
  await assert.rejects(instance.request("com.example.a", "probe", "crash", null), /stopped/u);
  assert.equal(instance.report("com.example.a").services[0].state, "failed");
  await assert.rejects(instance.request("com.example.a", "probe", "ping", null), (error) => {
    assert.match(error.message, /^Plugin service is not running\. Last error: The service stopped unexpectedly \(exit code 3\) too often/u);
    assert.equal(pluginServiceNoticeKind(error.message), null, "a real crash is not a settings notice");
    return true;
  });
  // A service the supervisor never ran (no record) keeps the plain text.
  await assert.rejects(instance.request("com.example.b", "probe", "ping", null), (error) => error.message === "Plugin service is not running.");
});

test("the toast shows the notice's button only when it has one", async (t) => {
  const outdir = await mkdtemp(join(tmpdir(), "canvastty-toast-"));
  t.after(() => rm(outdir, { recursive: true, force: true }));
  await build({
    stdin: {
      contents: [
        'export { Toast } from "./src/renderer/src/components/Toast";',
        'export { createElement } from "react";',
        'export { renderToStaticMarkup } from "react-dom/server";'
      ].join("\n"),
      resolveDir: root,
      loader: "ts"
    },
    jsx: "automatic", bundle: true, platform: "node", format: "cjs", outfile: join(outdir, "toast.cjs"), logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' }
  });
  const { Toast, createElement, renderToStaticMarkup } = createRequire(import.meta.url)(join(outdir, "toast.cjs"));
  const plain = renderToStaticMarkup(createElement(Toast, { message: "Saved" }));
  assert.match(plain, /class="toast toast--visible"/u);
  assert.doesNotMatch(plain, /<button/u);
  const text = pluginServiceNoticeText("native-code-off", "ru");
  const actionable = renderToStaticMarkup(createElement(Toast, { message: text, action: { label: pluginServiceNoticeText("open", "ru"), run: () => undefined } }));
  assert.match(actionable, /toast--action/u);
  assert.match(actionable, /<button class="toast__action" type="button">Открыть настройки<\/button>/u);
  assert.ok(actionable.includes(text));
});

test("the notice is wired: frames localize it, App shows it with Open settings, Settings opens Extension native code", async () => {
  const [frame, app, settings, ipc] = await Promise.all([
    source("src/renderer/src/features/plugins/PluginFrame.tsx"),
    source("src/renderer/src/App.tsx"),
    source("src/renderer/src/features/settings/SettingsPanel.tsx"),
    source("src/main/ipc/registerIpc.ts")
  ]);
  assert.match(frame, /pluginServiceNoticeKind\(raw\)/u);
  assert.match(frame, /pluginServiceNoticeText\(notice, locale\)/u);
  assert.match(app, /onPluginError=\{showPluginError\}/u);
  assert.doesNotMatch(app, /onPluginError=\{showToast\}/u);
  assert.match(app, /openSectionRequest=\{openSectionRequest\}/u);
  assert.match(app, /<Toast message=\{toast\} action=\{toastAction\} \/>/u);
  assert.match(settings, /setSection\(openSectionRequest\.section\)/u);
  assert.match(settings, /querySelector<HTMLElement>\("\.plugin-services"\)/u);
  // The service request path still checks the manager before the supervisor.
  assert.match(ipc, /plugins\.assertService\(pluginId, serviceId\);\n\s+return pluginServices\.request/u);
});
