import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  radialItemAtPointer,
  radialItemOffset,
  setRadialLauncherItemEnabled
} from "../src/renderer/src/features/launcher/radialLauncher.ts";
import { normalizeRadialLauncherItems, normalizeSettings, SettingsStore } from "../src/main/services/SettingsStore.ts";

test("radial launcher defaults off and persists explicit choices without losing actions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-radial-opt-in-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory, "en", "darwin");
  const defaults = await store.load();
  assert.equal(defaults.radialLauncherEnabled, false);
  assert.equal(normalizeSettings({ radialLauncherEnabled: "true" }, defaults).radialLauncherEnabled, false);

  for (const enabled of [true, false]) {
    await store.update({ radialLauncherEnabled: enabled, radialLauncherItems: ["terminal", "note"] });
    const reloaded = await new SettingsStore(directory, "en", "darwin").load();
    assert.equal(reloaded.radialLauncherEnabled, enabled);
    assert.deepEqual(reloaded.radialLauncherItems, ["terminal", "note"]);
  }

  const file = join(directory, "settings.json");
  const legacy = JSON.parse(await readFile(file, "utf8"));
  delete legacy.radialLauncherEnabled;
  await writeFile(file, JSON.stringify(legacy));
  const migrated = await new SettingsStore(directory, "en", "darwin").load();
  assert.equal(migrated.radialLauncherEnabled, false);
  assert.deepEqual(migrated.radialLauncherItems, ["terminal", "note"]);
  assert.equal(JSON.parse(await readFile(file, "utf8")).radialLauncherEnabled, false);
});

test("radial pointer handling is gated by the persisted settings toggle", async () => {
  const workspace = await readFile(new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url), "utf8");
  const settings = await readFile(new URL("../src/renderer/src/features/settings/SettingsPanel.tsx", import.meta.url), "utf8");
  assert.match(workspace, /if \(!settings\.radialLauncherEnabled \|\| event\.button !== 2 \|\| shouldKeepCanvasContextMenu\(event\.target\)\) return false/);
  assert.match(workspace, /if \(!settings\.radialLauncherEnabled\) closeRadialLauncher\(\)/);
  assert.match(settings, /onChange\(\{ radialLauncherEnabled: value === "on" \}\)/);
});

test("direction selection follows the visual radial positions", () => {
  const anchor = { x: 400, y: 300 };
  for (let index = 0; index < 8; index += 1) {
    const offset = radialItemOffset(index, 8);
    assert.equal(
      radialItemAtPointer(anchor, { x: anchor.x + offset.x, y: anchor.y + offset.y }, 8),
      index
    );
  }
  assert.equal(radialItemAtPointer(anchor, anchor, 8), null);
});

test("custom launcher contents preserve user order and enforce the eight-item limit", () => {
  assert.deepEqual(
    normalizeRadialLauncherItems([
      "note", "codex", "unknown", "note", "settings", "browser", "terminal",
      "claude", "qwen", "kimi", "grok"
    ]),
    ["note", "codex", "settings", "browser", "terminal", "claude", "qwen", "kimi"]
  );
});

test("launcher toggles retain at least one action", () => {
  let items = ["codex", "note"];
  items = setRadialLauncherItemEnabled(items, "browser", true);
  assert.deepEqual(items, ["codex", "note", "browser"]);
  items = setRadialLauncherItemEnabled(items, "browser", false);
  assert.deepEqual(items, ["codex", "note"]);
  assert.deepEqual(setRadialLauncherItemEnabled(["note"], "note", false), ["note"]);
});

test("invalid or empty persisted configurations recover to defaults", () => {
  assert.deepEqual(normalizeRadialLauncherItems([]), [
    "codex", "claude", "qwen", "opencode", "note", "terminal", "browser", "settings"
  ]);
  assert.deepEqual(normalizeRadialLauncherItems("codex", ["note"]), ["note"]);
});

test("a custom launcher selection persists through SettingsStore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-radial-settings-"));
  try {
    const store = new SettingsStore(directory, "en", "darwin");
    await store.load();
    await store.update({ radialLauncherItems: ["codex", "note"] });
    const reloaded = await new SettingsStore(directory, "en", "darwin").load();
    assert.deepEqual(reloaded.radialLauncherItems, ["codex", "note"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
