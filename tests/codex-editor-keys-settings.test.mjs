/**
 * The Codex editor keys (Settings → Keyboard → Codex editor) the owned Codex frontend reads from
 * CANVASTTY_CODEX_KEYBOARD: submit, line break, alternate line break and select, all always bound.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeSettings, SettingsStore } from "../src/main/services/SettingsStore.ts";
import { resolveTerminalLaunch } from "../src/main/services/terminalLaunch.ts";
import { DEFAULT_SHORTCUTS, keyboardPresetShortcuts, shortcutsShareContext } from "../src/shared/contracts.ts";

const settingsPanelPath = new URL("../src/renderer/src/features/settings/SettingsPanel.tsx", import.meta.url);
const NEW_DEFAULTS = { codexSubmit: "Meta+Enter", codexSubmitAlternate: "", codexSubmitSuper: "", codexNewline: "Enter",
  codexNewlineAlternate: "Shift+Enter", codexCopy: "Meta+C", codexCut: "Meta+X", codexClear: "Backspace" };
const OTHER_SYSTEMS = { codexSubmit: "Enter", codexSubmitAlternate: "Ctrl+Enter", codexSubmitSuper: "Meta+Enter",
  codexNewline: "Shift+Enter", codexNewlineAlternate: "", codexSelectAll: "Ctrl+A", codexCopy: "", codexCut: "", codexClear: "" };
const OLD_DEFAULTS = { codexSubmit: "Enter", codexSubmitAlternate: "Ctrl+Enter", codexSubmitSuper: "Meta+Enter", codexNewline: "Shift+Enter" };
const codexKeys = (shortcuts) => Object.fromEntries(Object.keys(shortcuts).filter((action) => action.startsWith("codex"))
  .map((action) => [action, shortcuts[action]]));
const withoutCodex = Object.fromEntries(Object.entries(keyboardPresetShortcuts("macos")).filter(([action]) => !action.startsWith("codex")));

test("Codex editor defaults: Command+Enter submits, Enter and Shift+Enter break the line, Command+A selects on macOS", () => {
  assert.deepEqual(codexKeys(keyboardPresetShortcuts("macos")), { ...NEW_DEFAULTS, codexSelectAll: "Meta+A" });
  assert.deepEqual(codexKeys(keyboardPresetShortcuts("linux", true)), { ...NEW_DEFAULTS, codexSelectAll: "Meta+A" },
    "a macOS host keeps them under any preset");
  // Linux and Windows keep the keys they had.
  for (const shortcuts of [DEFAULT_SHORTCUTS, keyboardPresetShortcuts("linux"), keyboardPresetShortcuts("windows"),
    keyboardPresetShortcuts("macos", false)]) {
    assert.deepEqual(codexKeys(shortcuts), { ...OTHER_SYSTEMS, codexSelectAll: shortcuts.codexSelectAll });
  }
});

test("settings still at the old Codex defaults take the new ones; the extra submit keys are gone", () => {
  const defaults = new SettingsStore("unused-settings-test-path", "en").get();
  const saved = { keyboardPreset: "custom", shortcuts: { ...withoutCodex, ...OLD_DEFAULTS } };
  const migrated = normalizeSettings(saved, defaults, "macos").shortcuts;
  assert.deepEqual(codexKeys(migrated), { ...NEW_DEFAULTS, codexSelectAll: "Meta+A" });
  assert.equal(migrated.terminalCopy, "Meta+C", "other keys are untouched");
  const again = normalizeSettings({ ...saved, shortcuts: migrated }, defaults, "macos").shortcuts;
  assert.deepEqual(codexKeys(again), codexKeys(migrated), "saved after the migration, nothing moves");
});

test("Linux and Windows settings are not migrated", () => {
  const linux = normalizeSettings({}, new SettingsStore("unused-settings-test-path", "en").get(), "linux");
  const defaults = { ...linux, shortcuts: keyboardPresetShortcuts("linux") };
  const custom = { ...OTHER_SYSTEMS, codexSubmit: "Ctrl+Enter", codexSubmitAlternate: "Alt+Enter" };
  delete custom.codexNewlineAlternate;
  const kept = normalizeSettings({ shortcuts: { ...keyboardPresetShortcuts("linux"), ...custom } }, defaults, "linux").shortcuts;
  assert.deepEqual(codexKeys(kept), { ...custom, codexNewlineAlternate: "" });
});

test("customized Codex submit and line-break keys are kept through the migration", () => {
  const defaults = new SettingsStore("unused-settings-test-path", "en").get();
  const custom = normalizeSettings({ shortcuts: { ...withoutCodex, ...OLD_DEFAULTS, codexSubmit: "Ctrl+Enter", codexSubmitAlternate: "" } },
    defaults, "macos").shortcuts;
  assert.deepEqual(codexKeys(custom), { ...NEW_DEFAULTS, codexSubmit: "Ctrl+Enter", codexNewline: "Shift+Enter",
    codexNewlineAlternate: "Enter", codexSelectAll: "Meta+A" }, "Shift+Enter is taken, so the alternate line break gets Enter");
  const other = normalizeSettings({ shortcuts: { ...withoutCodex, ...OLD_DEFAULTS, codexNewline: "Alt+Enter" } }, defaults, "macos").shortcuts;
  assert.deepEqual(codexKeys(other), { ...NEW_DEFAULTS, codexSubmit: "Enter", codexNewline: "Alt+Enter", codexSelectAll: "Meta+A" });
  const both = normalizeSettings({ shortcuts: { ...withoutCodex, ...OLD_DEFAULTS, codexSubmitAlternate: "" } }, defaults, "macos").shortcuts;
  assert.deepEqual(codexKeys(both), { ...NEW_DEFAULTS, codexSubmit: "Enter", codexNewline: "Shift+Enter",
    codexNewlineAlternate: "Alt+Enter", codexSelectAll: "Meta+A" }, "Enter and Shift+Enter both taken");
  // Settings saved after the migration keep their keys.
  const current = normalizeSettings({ shortcuts: { ...withoutCodex, ...NEW_DEFAULTS, codexSubmit: "Ctrl+Enter",
    codexNewline: "Shift+Enter", codexNewlineAlternate: "Alt+Enter", codexSelectAll: "Ctrl+L" } }, defaults, "macos").shortcuts;
  assert.deepEqual(codexKeys(current), { ...NEW_DEFAULTS, codexSubmit: "Ctrl+Enter", codexNewline: "Shift+Enter",
    codexNewlineAlternate: "Alt+Enter", codexSelectAll: "Ctrl+L" });
});

test("no Codex editor key can be switched off", () => {
  const defaults = new SettingsStore("unused-settings-test-path", "en").get();
  const off = { codexSubmit: "", codexNewline: "", codexNewlineAlternate: "", codexSelectAll: "", codexSubmitAlternate: "",
    codexSubmitSuper: "", codexCopy: "", codexCut: "", codexClear: "" };
  const normalized = normalizeSettings({ shortcuts: { ...keyboardPresetShortcuts("macos"), ...off } }, defaults, "macos").shortcuts;
  assert.deepEqual(codexKeys(normalized), { ...codexKeys(defaults.shortcuts), codexCopy: "", codexCut: "", codexClear: "" },
    "copy, cut and delete can be switched off");
});

test("Codex draft copy, cut and delete clash with the Codex editor's keys, not with the terminal's Copy", () => {
  assert.equal(shortcutsShareContext("codexCopy", "terminalCopy"), false);
  assert.equal(shortcutsShareContext("codexCut", "terminalPaste"), false);
  assert.equal(shortcutsShareContext("codexClear", "codexNewline"), true);
  assert.equal(shortcutsShareContext("codexCopy", "toggleDetail"), true);
  assert.equal(shortcutsShareContext("codexSubmit", "terminalCopy"), true, "the other Codex keys keep their context");
  const defaults = new SettingsStore("unused-settings-test-path", "en").get();
  const { codexCopy, codexCut, codexClear, ...older } = keyboardPresetShortcuts("macos");
  const custom = normalizeSettings({ shortcuts: { ...older, codexNewline: "Backspace", codexNewlineAlternate: "Enter" } },
    defaults, "macos").shortcuts;
  assert.deepEqual([custom.codexNewline, custom.codexCopy, custom.codexCut, custom.codexClear], ["Backspace", "Meta+C", "Meta+X", ""],
    "a new default that clashes with a kept key starts off");
});

test("the Codex editor group lists the four keys, and the frontend gets them in CANVASTTY_CODEX_KEYBOARD", async () => {
  const source = await readFile(settingsPanelPath, "utf8");
  assert.match(source, /\["codexSubmit", "codexNewline", "codexNewlineAlternate", "codexSelectAll", "codexCopy", "codexCut", "codexClear"\] as ShortcutAction\[\]\s+: \["codexSubmit", "codexSubmitAlternate", "codexSubmitSuper", "codexNewline", "codexSelectAll"\]/);
  const providerCli = { state: "available", provider: "codex", executable: "/official/codex", launcher: "native",
    environment: {}, checked: [] };
  const launch = resolveTerminalLaunch("codex", "normal", [], { platform: "darwin", providerCli, fileExists: () => true,
    environment: { CANVASTTY_CODEX_TUI_QA: "/qa/codex-tui", CANVASTTY_CODEX_TUI_LAUNCHER_QA: "/qa/launch.mjs" },
    shortcuts: { ...keyboardPresetShortcuts("macos"), codexNewlineAlternate: "Alt+Enter" } });
  assert.deepEqual(JSON.parse(launch.environment.CANVASTTY_CODEX_KEYBOARD),
    { submit: "Meta+Enter", newline: "Enter", newlineAlternate: "Alt+Enter", selectAll: "Meta+A", copy: "Meta+C", cut: "Meta+X",
      clear: "Backspace" });
  const linux = resolveTerminalLaunch("codex", "normal", [], { platform: "linux", providerCli, fileExists: () => true,
    environment: { CANVASTTY_CODEX_TUI_QA: "/qa/codex-tui", CANVASTTY_CODEX_TUI_LAUNCHER_QA: "/qa/launch.mjs" },
    shortcuts: keyboardPresetShortcuts("linux") });
  assert.deepEqual(JSON.parse(linux.environment.CANVASTTY_CODEX_KEYBOARD),
    { submit: "Enter", submitAlternate: "Ctrl+Enter", submitSuper: "Meta+Enter", newline: "Shift+Enter", selectAll: "Ctrl+A" },
    "Linux gets what it got before");
});
