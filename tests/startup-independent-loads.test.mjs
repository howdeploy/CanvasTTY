/**
 * initializeServices() (src/main/index.ts) starts four persistence loads that read no state from
 * one another: SettingsStore, SkinRegistry, PixelSkinPackRegistry and PluginManager, each rooted
 * in its own subfolder of userDataPath. Awaiting them one after another only adds their latencies
 * together before the renderer's application surface can load; they belong in one Promise.all.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const mainPath = new URL("../src/main/index.ts", import.meta.url);

async function persistenceStartup() {
  const source = await readFile(mainPath, "utf8");
  const start = source.indexOf("async function initializeServices(");
  const end = source.indexOf('protocol.handle("canvastty-plugin"', start);
  assert.ok(start >= 0 && end > start, "run the real initialization through its persistence barrier");
  const started = [];
  const loads = {};
  const store = (name, method) => function () {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    loads[name] = { resolve, reject };
    return { [method]: () => { started.push(name); return promise; } };
  };
  const context = {
    session: { defaultSession: {
      setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}
    } },
    providerClis: null,
    buildProviderCliRegistry: () => ({}),
    providerCliAvailability: () => ({}),
    resolveHermesHomeDirectory: () => "/fixture/hermes",
    resolveKimiHomeDirectory: () => "/fixture/kimi",
    recoverHermesConfigurationOnStartup() {},
    recoverKimiConfigurationOnStartup() {},
    HermesHudService: class {},
    hermesHudService: null,
    app: { getPath: () => "/fixture/user-data", getLocale: () => "en" },
    process: { platform: "linux" },
    editMenuLocale: null,
    pluginManager: null,
    SettingsStore: store("settings", "load"),
    SkinRegistry: store("borders", "initialize"),
    PixelSkinPackRegistry: store("pixel", "initialize"),
    PluginManager: store("plugins", "load")
  };
  const initialize = runInNewContext(`${stripTypeScriptTypes(`${source.slice(start, end)}\n}`)}; initializeServices`, context);
  return { initialize, started, loads };
}

test("initializeServices starts every independent load before waiting and propagates a load failure", async () => {
  const startup = await persistenceStartup();
  let finished = false;
  const running = startup.initialize({}).then(() => { finished = true; });
  assert.deepEqual(startup.started.toSorted(), ["borders", "pixel", "plugins", "settings"]);
  startup.loads.settings.resolve();
  startup.loads.borders.resolve();
  startup.loads.pixel.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false, "initialization must wait for the last store");
  startup.loads.plugins.resolve();
  await running;
  assert.equal(finished, true);

  const failed = await persistenceStartup();
  const failure = new Error("plugin state could not be read");
  const rejected = assert.rejects(failed.initialize({}), (error) => error === failure);
  assert.deepEqual(failed.started.toSorted(), ["borders", "pixel", "plugins", "settings"]);
  failed.loads.plugins.reject(failure);
  for (const name of ["settings", "borders", "pixel"]) failed.loads[name].resolve();
  await rejected;
});
