/**
 * initializeServices() (src/main/index.ts) starts four persistence loads that read no state from
 * one another: SettingsStore, SkinRegistry, PixelSkinPackRegistry and PluginManager, each rooted
 * in its own subfolder of userDataPath. Awaiting them one after another only adds their latencies
 * together before the renderer's application surface can load; they belong in one Promise.all.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginManager } from "../src/main/services/PluginManager.ts";
import { PixelSkinPackRegistry } from "../src/main/services/PixelSkinPackRegistry.ts";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
import { SkinRegistry } from "../src/main/services/SkinRegistry.ts";

const mainPath = new URL("../src/main/index.ts", import.meta.url);

test("initializeServices awaits the four independent persistence loads together, not one after another", async () => {
  const source = await readFile(mainPath, "utf8");
  const start = source.indexOf("async function initializeServices");
  const end = source.indexOf("// Secrets this app knows are masked", start);
  assert.ok(start !== -1 && end !== -1 && end > start, "the initializeServices boundaries must still exist");
  const body = source.slice(start, end);

  // Each independent load must appear inside one Promise.all(...) call, not behind its own await.
  const combined = body.match(/Promise\.all\(\s*\[([^\]]*)\]/su);
  assert.ok(combined, "the four independent loads must be combined in one Promise.all([...])");
  const group = combined[1];
  for (const call of ["settings.load()", "terminalBorderSkins.initialize()", "pixelSkinPacks.initialize()", "pluginManager.load()"]) {
    assert.ok(group.includes(call), `${call} must be inside the Promise.all group`);
  }
  // None of the four may still be awaited on its own line outside that group (the old, serial form).
  for (const call of ["settings.load()", "terminalBorderSkins.initialize()", "pixelSkinPacks.initialize()", "pluginManager.load()"]) {
    const soloAwaits = body.split("\n").filter((line) => line.trim().startsWith("await") && line.includes(call));
    assert.equal(soloAwaits.length, 0, `${call} must not also be awaited by itself`);
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("the startup group starts all four real persistence loads before awaiting any of them", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-startup-overlap-"));
  const registries = [];
  t.after(async () => {
    for (const registry of registries) registry.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  const source = await readFile(mainPath, "utf8");
  const start = source.indexOf("async function initializeServices");
  const end = source.indexOf("// Secrets this app knows are masked", start);
  const combined = source.slice(start, end).match(/Promise\.all\(\s*\[([^\]]*)\]\s*\)/su);
  assert.ok(combined, "the actual startup group must still exist");
  // Execute the production group with real stores, delaying entry with explicit gates. This
  // verifies parallel startup without assuming a CI runner's disk and scheduler have stable speed.
  const startGroup = new Function("settings", "terminalBorderSkins", "pixelSkinPacks", "pluginManager",
    `return ${combined[0]};`);

  const createLoads = (name) => {
    const root = join(directory, name);
    const settings = new SettingsStore(root, "en");
    const skin = new SkinRegistry(root);
    registries.push(skin);
    const pixels = new PixelSkinPackRegistry(root);
    const plugins = new PluginManager(root);
    const realLoads = [() => settings.load(), () => skin.initialize(), () => pixels.initialize(), () => plugins.load()];
    const gates = realLoads.map(() => deferred());
    const entered = realLoads.map(() => deferred());
    const finished = realLoads.map(() => deferred());
    const starts = [], completions = [];
    let active = 0, peak = 0;
    const loads = realLoads.map((load, index) => async () => {
      starts.push(index);
      active += 1;
      peak = Math.max(peak, active);
      entered[index].resolve();
      try {
        await gates[index].promise;
        await load();
        completions.push(index);
      } finally {
        active -= 1;
        finished[index].resolve();
      }
    });
    return { loads, gates, entered, finished, starts, completions, peak: () => peak, settings };
  };

  const serial = createLoads("serial");
  const serialWork = (async () => { for (const load of serial.loads) await load(); })();
  for (let index = 0; index < 4; index += 1) {
    await serial.entered[index].promise;
    assert.deepEqual(serial.starts, Array.from({ length: index + 1 }, (_, i) => i), "serial control cannot start the next load early");
    serial.gates[index].resolve();
    await serial.finished[index].promise;
  }
  await serialWork;
  assert.equal(serial.peak(), 1);
  assert.deepEqual(serial.completions, [0, 1, 2, 3]);

  const parallel = createLoads("parallel");
  let settled = false;
  const parallelWork = startGroup({ load: parallel.loads[0] }, { initialize: parallel.loads[1] },
    { initialize: parallel.loads[2] }, { load: parallel.loads[3] }).then(() => { settled = true; });
  assert.deepEqual(parallel.starts, [0, 1, 2, 3], "all four must start before any gate is released");
  assert.equal(parallel.peak(), 4);
  assert.deepEqual(parallel.completions, []);
  // Finish out of order: Promise.all must await the final real load, not merely the first.
  for (const index of [2, 0, 3]) {
    parallel.gates[index].resolve();
    await parallel.finished[index].promise;
    assert.equal(settled, false);
  }
  parallel.gates[1].resolve();
  await parallelWork;
  assert.deepEqual(parallel.completions, [2, 0, 3, 1]);
  assert.equal(settled, true);
  assert.equal(parallel.settings.get().locale, serial.settings.get().locale, "both paths initialized the real settings store");
});
