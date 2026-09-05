import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  normalizeHomeGridSize,
  normalizeHomeLayout,
  normalizeSettings,
  SettingsStore
} from "../src/main/services/SettingsStore.ts";

const fallback = {
  locale: "en",
  restoreTerminalSessions: false,
  persistCanvasRegions: true,
  persistStickyNotes: true,
  palette: "sage",
  homeAccentPreset: "classic",
  homeAccentColors: {
    clock: "#D8E1C5",
    launcher: "#B8CF99",
    browser: "#9CC7DC",
    settings: "#D5A2C9",
    media: "#D5A2C9"
  },
  sessionRowColorMode: "status",
  homeLauncherProviders: ["codex", "claude", "qwen", "kimi", "opencode", "hermes", "grok"],
  homeLimitProviders: ["codex", "claude", "qwen", "kimi", "opencode", "grok"],
  canvasLauncherItems: ["codex", "claude", "qwen", "opencode", "terminal"],
  radialLauncherItems: ["codex", "claude", "qwen", "opencode", "note", "terminal", "browser", "settings"],
  agentLifecycleHooksEnabled: true,
  uiScale: 1,
  canvasColor: "sage",
  pattern: "dots",
  snapToGrid: true,
  invertTerminalWheel: true,
  invertCanvasWheel: false,
  edgePan: true,
  edgePanSpeed: "normal",
  zoomSensitivity: "normal",
  canvasWheelCaptureMode: "key",
  useScrollWheelToZoom: false,
  canvasWheelOverride: "Meta",
  canvasNavigationOverride: "Alt",
  focusActivation: "off",
  hoverFocus: false,
  hoverFocusSpeed: "normal",
  showShortcutHints: true,
  minimapPlacement: "top-right",
  minimapInteractionMode: "click",
  shortcutHintsPlacement: "bottom-right",
  canvasControlsPlacement: "bottom-left",
  shortcuts: { home: "Home", renameWindow: "F2" },
  mediaPath: null,
  mediaFit: "cover",
  lastDirectory: "/",
  acknowledgedDangerousProfiles: [],
  homeGridSize: { columns: 16, rows: 12 },
  homeLayout: [
    { widgetId: "core.clock", column: 0, row: 0, columnSpan: 10, rowSpan: 6 },
    { widgetId: "core.settings", column: 10, row: 6, columnSpan: 2, rowSpan: 2 }
  ],
  canvasRegions: [],
  stickyNotes: [],
  pluginCanvas: [],
  browserCanvas: null,
  browserAgentAccess: true,
  browserShowAgentPresence: true,
  browserRestoreTabs: true
};

test("keeps valid wheel, edge pan, zoom, and focus values", () => {
  const normalized = normalizeSettings(
    {
      invertTerminalWheel: false,
      invertCanvasWheel: true,
      edgePan: false,
      edgePanSpeed: "fast",
      zoomSensitivity: "slow",
      canvasWheelCaptureMode: "always",
      minimapInteractionMode: "drag",
      hoverFocus: true,
      hoverFocusSpeed: "fast"
    },
    fallback
  );
  assert.equal(normalized.invertTerminalWheel, false);
  assert.equal(normalized.invertCanvasWheel, true);
  assert.equal(normalized.edgePan, false);
  assert.equal(normalized.edgePanSpeed, "fast");
  assert.equal(normalized.zoomSensitivity, "slow");
  assert.equal(normalized.canvasWheelCaptureMode, "always");
  assert.equal(normalized.minimapInteractionMode, "drag");
  assert.equal(normalized.hoverFocus, true);
  assert.equal(normalized.hoverFocusSpeed, "fast");
});

test("falls back when edge pan and zoom values are garbage", () => {
  const normalized = normalizeSettings(
    { edgePan: "yes", edgePanSpeed: "warp", zoomSensitivity: 11 },
    fallback
  );
  assert.equal(normalized.edgePan, fallback.edgePan);
  assert.equal(normalized.edgePanSpeed, fallback.edgePanSpeed);
  assert.equal(normalized.zoomSensitivity, fallback.zoomSensitivity);
  assert.equal(normalized.canvasWheelCaptureMode, fallback.canvasWheelCaptureMode);
  assert.equal(normalized.invertTerminalWheel, fallback.invertTerminalWheel);
  assert.equal(normalized.invertCanvasWheel, fallback.invertCanvasWheel);
  assert.equal(normalized.focusActivation, fallback.focusActivation);
  assert.equal(normalized.hoverFocus, fallback.hoverFocus);
  assert.equal(normalized.hoverFocusSpeed, fallback.hoverFocusSpeed);
  assert.equal(normalized.showShortcutHints, fallback.showShortcutHints);
  assert.equal(normalized.sessionRowColorMode, fallback.sessionRowColorMode);
  assert.equal(normalized.minimapPlacement, fallback.minimapPlacement);
  assert.equal(normalized.minimapInteractionMode, fallback.minimapInteractionMode);
  assert.equal(normalized.shortcutHintsPlacement, fallback.shortcutHintsPlacement);
  assert.equal(normalized.canvasControlsPlacement, fallback.canvasControlsPlacement);
  assert.deepEqual(normalized.shortcuts, fallback.shortcuts);
});

test("older settings files without the new keys inherit defaults", () => {
  const normalized = normalizeSettings({ locale: "ru", snapToGrid: false }, fallback);
  assert.equal(normalized.locale, "ru");
  assert.equal(normalized.snapToGrid, false);
  assert.equal(normalized.homeAccentPreset, fallback.homeAccentPreset);
  assert.deepEqual(normalized.homeAccentColors, fallback.homeAccentColors);
  assert.equal(normalized.sessionRowColorMode, fallback.sessionRowColorMode);
  assert.deepEqual(normalized.homeLauncherProviders, fallback.homeLauncherProviders);
  assert.deepEqual(normalized.homeLimitProviders, fallback.homeLimitProviders);
  assert.equal(normalized.canvasColor, fallback.canvasColor);
  assert.equal(normalized.edgePan, fallback.edgePan);
  assert.equal(normalized.edgePanSpeed, fallback.edgePanSpeed);
  assert.equal(normalized.zoomSensitivity, fallback.zoomSensitivity);
  assert.equal(normalized.canvasWheelCaptureMode, fallback.canvasWheelCaptureMode);
  assert.equal(normalized.invertTerminalWheel, fallback.invertTerminalWheel);
  assert.equal(normalized.invertCanvasWheel, fallback.invertCanvasWheel);
  assert.equal(normalized.hoverFocus, fallback.hoverFocus);
  assert.equal(normalized.hoverFocusSpeed, fallback.hoverFocusSpeed);
  assert.equal(normalized.agentLifecycleHooksEnabled, true);
  assert.equal(normalized.persistCanvasRegions, true);
  assert.equal(normalized.persistStickyNotes, true);
});

test("preserves an explicit lifecycle hook revocation", () => {
  const normalized = normalizeSettings({ agentLifecycleHooksEnabled: false }, fallback);
  assert.equal(normalized.agentLifecycleHooksEnabled, false);
});

test("terminal restore remains opt-in and canvas regions are bounded and normalized", () => {
  const normalized = normalizeSettings({
    restoreTerminalSessions: true,
    canvasRegions: [{
      id: "region-1",
      title: "  Backend  ",
      color: "#aabbcc",
      position: { x: 20, y: 30 },
      size: { width: 120, height: 9_000 }
    }]
  }, fallback);

  assert.equal(normalized.restoreTerminalSessions, true);
  assert.deepEqual(normalized.canvasRegions, [{
    id: "region-1",
    title: "Backend",
    color: "#AABBCC",
    position: { x: 20, y: 30 },
    size: { width: 360, height: 3_000 }
  }]);
  assert.equal(normalizeSettings({ restoreTerminalSessions: "yes" }, fallback).restoreTerminalSessions, false);
});

test("colored regions and notes use independent exit persistence gates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-settings-canvas-persistence-"));
  const region = {
    id: "region-persisted",
    title: "Work",
    color: "#AABBCC",
    position: { x: 20, y: 30 },
    size: { width: 500, height: 400 }
  };
  const note = {
    id: "note-persisted",
    text: "Current-session note",
    position: { x: 60, y: 80 },
    size: { width: 300, height: 220 }
  };

  try {
    const store = new SettingsStore(dir, "en");
    await store.load();
    await store.update({ canvasRegions: [region], stickyNotes: [note] });

    const liveAfterDisable = await store.update({
      persistCanvasRegions: false,
      persistStickyNotes: false
    });
    assert.deepEqual(liveAfterDisable.canvasRegions, [region]);
    assert.deepEqual(liveAfterDisable.stickyNotes, [note]);

    let persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(persisted.persistCanvasRegions, false);
    assert.equal(persisted.persistStickyNotes, false);
    assert.deepEqual(persisted.canvasRegions, []);
    assert.deepEqual(persisted.stickyNotes, []);

    const liveAfterRegionEnable = await store.update({ persistCanvasRegions: true });
    assert.deepEqual(liveAfterRegionEnable.canvasRegions, [region]);
    assert.deepEqual(liveAfterRegionEnable.stickyNotes, [note]);

    persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.deepEqual(persisted.canvasRegions, [region]);
    assert.deepEqual(persisted.stickyNotes, []);

    const restored = await new SettingsStore(dir, "en").load();
    assert.equal(restored.persistCanvasRegions, true);
    assert.equal(restored.persistStickyNotes, false);
    assert.deepEqual(restored.canvasRegions, [region]);
    assert.deepEqual(restored.stickyNotes, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normalizes HOME accents, Canvas colors, and the expanded pattern set", () => {
  const normalized = normalizeSettings({
    homeAccentPreset: "custom",
    homeAccentColors: {
      clock: "#102030",
      launcher: "#aabbcc",
      browser: "#334455",
      settings: "#DDEEFF",
      media: "#778899"
    },
    canvasColor: "slate",
    pattern: "rings"
  }, fallback);

  assert.equal(normalized.homeAccentPreset, "custom");
  assert.deepEqual(normalized.homeAccentColors, {
    clock: "#102030",
    launcher: "#AABBCC",
    browser: "#334455",
    settings: "#DDEEFF",
    media: "#778899"
  });
  assert.equal(normalized.canvasColor, "slate");
  assert.equal(normalized.pattern, "rings");

  const invalid = normalizeSettings({
    homeAccentPreset: "rainbow",
    homeAccentColors: {
      clock: "red",
      launcher: "#123",
      browser: "url(file:///tmp/nope)",
      settings: "#12345678",
      media: null
    },
    canvasColor: "transparent",
    pattern: "noise"
  }, fallback);
  assert.equal(invalid.homeAccentPreset, fallback.homeAccentPreset);
  assert.deepEqual(invalid.homeAccentColors, fallback.homeAccentColors);
  assert.equal(invalid.canvasColor, fallback.canvasColor);
  assert.equal(invalid.pattern, fallback.pattern);
});

test("normalizes the persisted session-row color mode", () => {
  assert.equal(normalizeSettings({ sessionRowColorMode: "monochrome" }, fallback).sessionRowColorMode, "monochrome");
  assert.equal(normalizeSettings({ sessionRowColorMode: "status" }, fallback).sessionRowColorMode, "status");
  assert.equal(normalizeSettings({ sessionRowColorMode: "rainbow" }, fallback).sessionRowColorMode, "status");
});

test("migrates legacy palette-backed Canvas colors to an independent concrete background", () => {
  assert.equal(normalizeSettings({ palette: "night", canvasColor: "palette" }, fallback).canvasColor, "night");
  assert.equal(normalizeSettings({ palette: "lilac" }, fallback).canvasColor, "lilac");
});

test("normalizes the HOME launcher provider selection in canonical order", () => {
  assert.deepEqual(
    normalizeSettings({ homeLauncherProviders: ["hermes", "opencode", "unknown", "hermes"] }, fallback)
      .homeLauncherProviders,
    ["opencode", "hermes"]
  );
  assert.deepEqual(normalizeSettings({ homeLauncherProviders: [] }, fallback).homeLauncherProviders, []);
  assert.deepEqual(
    normalizeSettings({ homeLauncherProviders: "codex" }, fallback).homeLauncherProviders,
    fallback.homeLauncherProviders
  );
});

test("normalizes the HOME limit provider selection independently in canonical order", () => {
  const normalized = normalizeSettings({
    homeLauncherProviders: ["grok"],
    homeLimitProviders: ["kimi", "unknown", "opencode", "codex", "kimi", "grok"]
  }, fallback);
  assert.deepEqual(normalized.homeLauncherProviders, ["grok"]);
  assert.deepEqual(normalized.homeLimitProviders, ["codex", "kimi", "opencode", "grok"]);
  assert.deepEqual(normalizeSettings({ homeLimitProviders: [] }, fallback).homeLimitProviders, []);
  assert.deepEqual(
    normalizeSettings({ homeLimitProviders: "kimi" }, fallback).homeLimitProviders,
    fallback.homeLimitProviders
  );
});

test("a persisted pre-Grok launcher subset gains Grok exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-settings-grok-migration-"));
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({
      ...fallback,
      homeLauncherProviders: ["codex", "kimi", "hermes"]
    }));
    const store = new SettingsStore(dir, "en");
    const loaded = await store.load();
    assert.deepEqual(loaded.homeLauncherProviders, ["codex", "kimi", "hermes", "grok"]);

    await store.update({ homeLauncherProviders: ["codex", "claude", "kimi", "opencode", "hermes"] });
    const reloaded = new SettingsStore(dir, "en");
    assert.deepEqual(
      (await reloaded.load()).homeLauncherProviders,
      ["codex", "claude", "kimi", "opencode", "hermes"]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the pre-Qwen default selections gain Qwen while curated subsets remain unchanged", async () => {
  const defaultDir = await mkdtemp(join(tmpdir(), "canvastty-settings-qwen-default-"));
  const curatedDir = await mkdtemp(join(tmpdir(), "canvastty-settings-qwen-curated-"));
  try {
    const preQwen = {
      ...fallback,
      settingsVersion: 5,
      homeLauncherProviders: ["codex", "claude", "kimi", "opencode", "hermes", "grok"],
      homeLimitProviders: ["codex", "claude", "kimi", "opencode", "grok"]
    };
    await writeFile(join(defaultDir, "settings.json"), JSON.stringify(preQwen));
    const migrated = await new SettingsStore(defaultDir, "en").load();
    assert.deepEqual(migrated.homeLauncherProviders, fallback.homeLauncherProviders);
    assert.deepEqual(migrated.homeLimitProviders, fallback.homeLimitProviders);

    await writeFile(join(curatedDir, "settings.json"), JSON.stringify({
      ...preQwen,
      homeLauncherProviders: ["codex", "hermes"],
      homeLimitProviders: ["kimi"]
    }));
    const curated = await new SettingsStore(curatedDir, "en").load();
    assert.deepEqual(curated.homeLauncherProviders, ["codex", "hermes"]);
    assert.deepEqual(curated.homeLimitProviders, ["kimi"]);
  } finally {
    await Promise.all([
      rm(defaultDir, { recursive: true, force: true }),
      rm(curatedDir, { recursive: true, force: true })
    ]);
  }
});

test("the Qwen migration does not rerun the older expanded-limit migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-settings-qwen-limit-subset-"));
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({
      ...fallback,
      settingsVersion: 5,
      homeLimitProviders: ["codex", "claude", "kimi"]
    }));
    const loaded = await new SettingsStore(dir, "en").load();
    assert.deepEqual(loaded.homeLimitProviders, ["codex", "claude", "kimi"]);

    const persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(persisted.settingsVersion, 14);
    assert.equal(persisted.agentLifecycleHooksEnabled, true);
    assert.deepEqual(persisted.homeLimitProviders, ["codex", "claude", "kimi"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the limit-display migration preserves a version-three launcher subset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-settings-limit-migration-"));
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({
      ...fallback,
      settingsVersion: 3,
      homeLauncherProviders: ["codex", "kimi"],
      homeLimitProviders: ["codex", "claude", "kimi"]
    }));
    const store = new SettingsStore(dir, "en");
    const loaded = await store.load();
    assert.deepEqual(loaded.homeLauncherProviders, ["codex", "kimi"]);
    assert.deepEqual(loaded.homeLimitProviders, fallback.homeLimitProviders);

    const persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(persisted.settingsVersion, 14);
    assert.equal(persisted.agentLifecycleHooksEnabled, true);
    assert.deepEqual(persisted.homeLimitProviders, fallback.homeLimitProviders);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the expanded limit migration preserves a curated version-four subset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-settings-limit-subset-migration-"));
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({
      ...fallback,
      settingsVersion: 4,
      homeLimitProviders: ["kimi"]
    }));
    const loaded = await new SettingsStore(dir, "en").load();
    assert.deepEqual(loaded.homeLimitProviders, ["kimi"]);

    const persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(persisted.settingsVersion, 14);
    assert.equal(persisted.agentLifecycleHooksEnabled, true);
    assert.deepEqual(persisted.homeLimitProviders, ["kimi"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the HOME limit selection persists without changing the launcher selection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-settings-limit-selection-"));
  try {
    const store = new SettingsStore(dir, "en");
    await store.load();
    await store.update({ homeLimitProviders: ["kimi"] });

    const reloaded = new SettingsStore(dir, "en");
    const loaded = await reloaded.load();
    assert.deepEqual(loaded.homeLimitProviders, ["kimi"]);
    assert.deepEqual(loaded.homeLauncherProviders, fallback.homeLauncherProviders);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpenCode and Hermes dangerous-profile acknowledgements survive normalization", () => {
  const normalized = normalizeSettings({
    acknowledgedDangerousProfiles: ["opencode", "hermes", "unknown", "codex"]
  }, fallback);
  assert.deepEqual(normalized.acknowledgedDangerousProfiles, ["opencode", "hermes", "codex"]);
});

test("a non-object candidate yields the fallback wholesale", () => {
  assert.equal(normalizeSettings(null, fallback), fallback);
  assert.equal(normalizeSettings("settings", fallback), fallback);
});

test("fresh installs default to scroll pan and key-gated widget wheel input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-settings-"));
  try {
    const store = new SettingsStore(dir, "en");
    await store.load();
    assert.equal(store.get().edgePan, false);
    assert.equal(store.get().edgePanSpeed, "normal");
    assert.equal(store.get().zoomSensitivity, "normal");
    assert.equal(store.get().canvasWheelCaptureMode, "key");
    assert.equal(store.get().useScrollWheelToZoom, false);
    assert.equal(store.get().canvasWheelOverride, process.platform === "darwin" ? "Meta" : "Ctrl");
    assert.equal(store.get().canvasNavigationOverride, "Alt");
    assert.equal(store.get().invertTerminalWheel, true);
    assert.equal(store.get().invertCanvasWheel, false);
    assert.equal(store.get().focusActivation, "off");
    assert.equal(store.get().hoverFocus, false);
    assert.equal(store.get().hoverFocusSpeed, "normal");
    assert.equal(store.get().showShortcutHints, true);
    assert.equal(store.get().minimapPlacement, "top-right");
    assert.equal(store.get().minimapInteractionMode, "click");
    assert.equal(store.get().shortcutHintsPlacement, "bottom-right");
    assert.equal(store.get().canvasControlsPlacement, "bottom-left");
    assert.equal(store.get().homeAccentPreset, "classic");
    assert.equal(store.get().sessionRowColorMode, "status");
    assert.deepEqual(store.get().homeAccentColors, fallback.homeAccentColors);
    assert.deepEqual(store.get().homeLauncherProviders, fallback.homeLauncherProviders);
    assert.deepEqual(store.get().homeLimitProviders, fallback.homeLimitProviders);
    assert.equal(store.get().canvasColor, "sage");
    assert.equal(store.get().pattern, "dots");
    assert.deepEqual(store.get().homeGridSize, { columns: 16, rows: 12 });
    assert.equal(store.get().browserCanvas, null);
    assert.equal(store.get().browserAgentAccess, true);
    assert.equal(store.get().browserShowAgentPresence, true);
    assert.equal(store.get().browserRestoreTabs, true);
    assert.equal(store.get().persistCanvasRegions, true);
    assert.equal(store.get().persistStickyNotes, true);
    assert.deepEqual(store.get().shortcuts, { home: "Home", renameWindow: "F2" });
    const persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(Object.hasOwn(persisted, "zoomOverApplications"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fresh wheel capture binding follows the host platform", async () => {
  const macDir = await mkdtemp(join(tmpdir(), "canvastty-settings-mac-wheel-"));
  const otherDir = await mkdtemp(join(tmpdir(), "canvastty-settings-other-wheel-"));
  try {
    const mac = new SettingsStore(macDir, "en", "darwin");
    const other = new SettingsStore(otherDir, "en", "linux");
    await Promise.all([mac.load(), other.load()]);
    assert.equal(mac.get().canvasWheelOverride, "Meta");
    assert.equal(other.get().canvasWheelOverride, "Ctrl");
  } finally {
    await Promise.all([
      rm(macDir, { recursive: true, force: true }),
      rm(otherDir, { recursive: true, force: true })
    ]);
  }
});

test("existing profiles migrate minimap interaction to click and persist later changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-settings-minimap-interaction-"));
  try {
    const legacy = { ...fallback, settingsVersion: 10 };
    delete legacy.minimapInteractionMode;
    await writeFile(join(dir, "settings.json"), JSON.stringify(legacy));

    const store = new SettingsStore(dir, "en");
    assert.equal((await store.load()).minimapInteractionMode, "click");
    let persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(persisted.settingsVersion, 14);
    assert.equal(persisted.minimapInteractionMode, "click");

    await store.update({ minimapInteractionMode: "drag" });
    const reloaded = new SettingsStore(dir, "en");
    assert.equal((await reloaded.load()).minimapInteractionMode, "drag");
    persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(persisted.minimapInteractionMode, "drag");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing settings migrate to wheel zoom and preserve legacy widget capture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-settings-migration-"));
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({
      locale: "en",
      zoomOverApplications: false
    }), "utf8");

    const store = new SettingsStore(dir, "en");
    const migrated = await store.load();
    assert.equal(migrated.useScrollWheelToZoom, true);
    assert.equal(migrated.canvasWheelCaptureMode, "off");
    assert.equal(migrated.canvasNavigationOverride, "Alt");
    assert.equal(migrated.canvasWheelOverride, null);

    const persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(persisted.useScrollWheelToZoom, true);
    assert.equal(persisted.zoomOverApplications, false);
    assert.equal(persisted.canvasNavigationOverride, "Alt");
    assert.equal(persisted.canvasWheelOverride, null);
    assert.equal(persisted.homeAccentPreset, "classic");
    assert.deepEqual(persisted.homeLauncherProviders, fallback.homeLauncherProviders);
    assert.deepEqual(persisted.homeLimitProviders, fallback.homeLimitProviders);
    assert.equal(persisted.canvasColor, "sage");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing settings without the legacy key use key mode and keep the legacy key absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-settings-legacy-wheel-"));
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({ locale: "ru" }), "utf8");
    const store = new SettingsStore(dir, "ru");
    const migrated = await store.load();
    assert.equal(migrated.useScrollWheelToZoom, true);
    assert.equal(migrated.canvasWheelCaptureMode, "key");
    assert.equal(migrated.canvasWheelOverride, process.platform === "darwin" ? "Meta" : "Ctrl");

    const persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(Object.hasOwn(persisted, "zoomOverApplications"), false);

    await store.update({ palette: "night" });
    const updated = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(Object.hasOwn(updated, "zoomOverApplications"), false);

    await store.update({ canvasWheelCaptureMode: "always" });
    const explicitlyEnabled = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(explicitlyEnabled.zoomOverApplications, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration preserves an explicitly enabled legacy widget capture value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-settings-legacy-wheel-enabled-"));
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({
      locale: "en",
      zoomOverApplications: true
    }), "utf8");

    const store = new SettingsStore(dir, "en");
    const migrated = await store.load();
    assert.equal(migrated.canvasWheelCaptureMode, "always");

    const persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(persisted.zoomOverApplications, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy false with a valid wheel binding migrates to key mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-settings-legacy-wheel-key-"));
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({
      zoomOverApplications: false,
      canvasWheelOverride: "Alt"
    }), "utf8");
    const store = new SettingsStore(dir, "en", "darwin");
    const migrated = await store.load();
    assert.equal(migrated.canvasWheelCaptureMode, "key");
    assert.equal(migrated.canvasWheelOverride, "Alt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("selecting Key without a saved binding assigns the platform default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-settings-wheel-key-default-"));
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({
      zoomOverApplications: false,
      canvasWheelOverride: null
    }), "utf8");
    const store = new SettingsStore(dir, "en", "darwin");
    await store.load();
    assert.equal(store.get().canvasWheelCaptureMode, "off");
    await store.update({ canvasWheelCaptureMode: "key" });
    assert.equal(store.get().canvasWheelCaptureMode, "key");
    assert.equal(store.get().canvasWheelOverride, "Meta");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid explicit key mode fails closed without replacing action shortcuts", () => {
  const normalized = normalizeSettings({
    canvasWheelCaptureMode: "key",
    canvasWheelOverride: "Meta+Space",
    shortcuts: { home: "Meta+Space", renameWindow: "F2" }
  }, fallback, "darwin");
  assert.equal(normalized.canvasWheelCaptureMode, "off");
  assert.equal(normalized.canvasWheelOverride, null);
  assert.deepEqual(normalized.shortcuts, { home: "Meta+Space", renameWindow: "F2" });
});

test("mode changes persist the compatible legacy boolean and preserve the hidden binding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-settings-wheel-mode-"));
  try {
    const store = new SettingsStore(dir, "en", "darwin");
    await store.load();
    await store.update({ canvasWheelOverride: "Alt" });
    await store.update({ canvasWheelCaptureMode: "off" });
    assert.equal(store.get().canvasWheelOverride, "Alt");
    let persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(persisted.zoomOverApplications, false);

    await store.update({ canvasWheelCaptureMode: "always" });
    assert.equal(store.get().canvasWheelOverride, "Alt");
    persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(persisted.zoomOverApplications, true);

    await store.update({ canvasWheelCaptureMode: "key" });
    assert.equal(store.get().canvasWheelCaptureMode, "key");
    assert.equal(store.get().canvasWheelOverride, "Alt");
    persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(persisted.zoomOverApplications, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normalizes browser agent access, indicators, and tab restore preferences", () => {
  const disabled = normalizeSettings({
    browserAgentAccess: false,
    browserShowAgentPresence: false,
    browserRestoreTabs: false
  }, fallback);
  assert.equal(disabled.browserAgentAccess, false);
  assert.equal(disabled.browserShowAgentPresence, false);
  assert.equal(disabled.browserRestoreTabs, false);

  const invalid = normalizeSettings({
    browserAgentAccess: "yes",
    browserShowAgentPresence: "sometimes",
    browserRestoreTabs: 1
  }, fallback);
  assert.equal(invalid.browserAgentAccess, true);
  assert.equal(invalid.browserShowAgentPresence, true);
  assert.equal(invalid.browserRestoreTabs, true);
});

test("normalizes the optional built-in browser canvas bounds", () => {
  assert.deepEqual(normalizeSettings({
    browserCanvas: { position: { x: 320, y: -40 }, size: { width: 900, height: 640 } }
  }, fallback).browserCanvas, {
    position: { x: 320, y: -40 }, size: { width: 900, height: 640 }
  });
  assert.deepEqual(normalizeSettings({
    browserCanvas: { position: { x: 0, y: 0 }, size: { width: 20, height: 9_000 } }
  }, fallback).browserCanvas?.size, { width: 560, height: 1_100 });
});

test("preserves plugin canvas bounds down to the manifest minimum floor", () => {
  const normalized = normalizeSettings({
    pluginCanvas: [{
      id: "instance-1",
      pluginId: "com.example.music",
      contributionId: "player",
      title: "Player",
      position: { x: 120, y: 80 },
      size: { width: 120, height: 90 }
    }]
  }, fallback);
  assert.deepEqual(normalized.pluginCanvas[0]?.size, { width: 240, height: 140 });
});

test("normalizes resizable Home boundaries within generous safety limits", () => {
  assert.deepEqual(normalizeHomeGridSize({ columns: 24, rows: 20 }), { columns: 24, rows: 20 });
  assert.deepEqual(normalizeHomeGridSize({ columns: 2, rows: 80 }), { columns: 12, rows: 36 });
  assert.deepEqual(normalizeHomeGridSize({ columns: "wide", rows: 20 }), { columns: 16, rows: 12 });
});

test("valid custom shortcuts survive normalization", () => {
  const normalized = normalizeSettings({
    focusActivation: "double",
    showShortcutHints: false,
    shortcuts: { home: "Ctrl+H", renameWindow: "Ctrl+Shift+R" }
  }, fallback);
  assert.equal(normalized.focusActivation, "double");
  assert.equal(normalized.showShortcutHints, false);
  assert.deepEqual(normalized.shortcuts, { home: "Ctrl+H", renameWindow: "Ctrl+Shift+R" });
});

test("mouse buttons survive action shortcut normalization", () => {
  const normalized = normalizeSettings({
    shortcuts: { home: "Mouse4", renameWindow: "Ctrl+Mouse5" }
  }, fallback);
  assert.deepEqual(normalized.shortcuts, { home: "Mouse4", renameWindow: "Ctrl+Mouse5" });
});

test("normalizes canvas overlay positions independently", () => {
  const normalized = normalizeSettings({
    minimapPlacement: "bottom-left",
    shortcutHintsPlacement: "top-left",
    canvasControlsPlacement: "top-right"
  }, fallback);
  assert.equal(normalized.minimapPlacement, "bottom-left");
  assert.equal(normalized.shortcutHintsPlacement, "top-left");
  assert.equal(normalized.canvasControlsPlacement, "top-right");

  const invalid = normalizeSettings({
    minimapPlacement: "center",
    shortcutHintsPlacement: null,
    canvasControlsPlacement: 42
  }, fallback);
  assert.equal(invalid.minimapPlacement, fallback.minimapPlacement);
  assert.equal(invalid.shortcutHintsPlacement, fallback.shortcutHintsPlacement);
  assert.equal(invalid.canvasControlsPlacement, fallback.canvasControlsPlacement);
});

test("normalizes minimap interaction independently", () => {
  assert.equal(normalizeSettings({ minimapInteractionMode: "drag" }, fallback).minimapInteractionMode, "drag");
  assert.equal(normalizeSettings({ minimapInteractionMode: "click" }, fallback).minimapInteractionMode, "click");
  assert.equal(normalizeSettings({ minimapInteractionMode: "pan" }, fallback).minimapInteractionMode, "click");
});

test("conflicting or malformed shortcuts fall back together", () => {
  assert.deepEqual(
    normalizeSettings({ shortcuts: { home: "F2", renameWindow: "F2" } }, fallback).shortcuts,
    fallback.shortcuts
  );
  assert.deepEqual(
    normalizeSettings({ shortcuts: { home: "???", renameWindow: "F2" } }, fallback).shortcuts,
    fallback.shortcuts
  );
});

test("normalization preserves action shortcuts and allows modifier-only navigation overrides", () => {
  const conflict = normalizeSettings({
    shortcuts: { home: "Alt+H", renameWindow: "F2" },
    canvasNavigationOverride: "Alt"
  }, fallback, "darwin");
  assert.deepEqual(conflict.shortcuts, { home: "Alt+H", renameWindow: "F2" });
  assert.equal(conflict.canvasNavigationOverride, "Alt");

  const reserved = normalizeSettings({ canvasNavigationOverride: "Meta" }, fallback, "darwin");
  assert.equal(reserved.canvasNavigationOverride, "Meta");
  assert.equal(normalizeSettings({ canvasNavigationOverride: null }, fallback).canvasNavigationOverride, null);

  const migratedConflict = normalizeSettings({
    shortcuts: { home: "Alt+H", renameWindow: "F2" }
  }, fallback, "darwin");
  assert.deepEqual(migratedConflict.shortcuts, { home: "Alt+H", renameWindow: "F2" });
  assert.equal(migratedConflict.canvasNavigationOverride, "Alt");
});

test("both overrides accept zoom modifiers without swallowing ordinary shortcuts", () => {
  const normalized = normalizeSettings({
    shortcuts: { home: "Meta+H", renameWindow: "F2" },
    canvasWheelOverride: "Meta",
    canvasNavigationOverride: "Meta"
  }, fallback, "darwin");
  assert.equal(normalized.canvasWheelOverride, "Meta");
  assert.equal(normalized.canvasNavigationOverride, "Meta");

  const conflictingChord = normalizeSettings({
    shortcuts: { home: "Meta+Space", renameWindow: "F2" },
    canvasWheelOverride: "Meta+Space"
  }, fallback, "darwin");
  assert.equal(conflictingChord.canvasWheelOverride, null);

  const mouseBindings = normalizeSettings({
    canvasWheelOverride: "Mouse4",
    canvasNavigationOverride: "Shift+Mouse5"
  }, fallback);
  assert.equal(mouseBindings.canvasWheelOverride, "Mouse4");
  assert.equal(mouseBindings.canvasNavigationOverride, "Shift+Mouse5");
});

test("a saved edge pan preference survives normalization", () => {
  const normalized = normalizeSettings({ edgePan: true, edgePanSpeed: "fast" }, fallback);
  assert.equal(normalized.edgePan, true);
  assert.equal(normalized.edgePanSpeed, "fast");
});

test("keeps a valid custom Home grid including plugin widgets", () => {
  const layout = normalizeHomeLayout([
    { widgetId: "core.clock", column: 0, row: 0, columnSpan: 8, rowSpan: 4 },
    { widgetId: "plugin:com.example.clock:weather", column: 8, row: 0, columnSpan: 4, rowSpan: 4 },
    { widgetId: "core.settings", column: 10, row: 6, columnSpan: 2, rowSpan: 2 }
  ]);

  assert.deepEqual(layout.map((item) => item.widgetId), [
    "core.clock",
    "plugin:com.example.clock:weather",
    "core.settings"
  ]);
});

test("drops overlapping Home placements and always preserves a Settings entry point", () => {
  const layout = normalizeHomeLayout([
    { widgetId: "core.clock", column: 0, row: 0, columnSpan: 12, rowSpan: 8 },
    { widgetId: "core.media", column: 0, row: 0, columnSpan: 2, rowSpan: 2 }
  ]);

  assert.deepEqual(layout.map((item) => item.widgetId), ["core.settings"]);
});
