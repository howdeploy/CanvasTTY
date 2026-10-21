/**
 * The Claude editor keys (Settings → Keyboard → Claude editor): their own context, so the terminal's Command+C/V/A
 * do not count as conflicts; submit, line break and select always keep a key; old settings get the defaults.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeSettings, SettingsStore } from "../src/main/services/SettingsStore.ts";
import { DEFAULT_SHORTCUTS, keyboardPresetShortcuts, shortcutsShareContext } from "../src/shared/contracts.ts";

const settingsPanelPath = new URL("../src/renderer/src/features/settings/SettingsPanel.tsx", import.meta.url);
const CLAUDE_DEFAULTS = { claudeSubmit: "Meta+Enter", claudeNewline: "Enter", claudeNewlineAlternate: "Shift+Enter", claudeSelectAll: "Meta+A",
  claudeCopy: "Meta+C", claudeCut: "Meta+X", claudeClear: "Backspace" };
const claudeKeys = (shortcuts) => Object.fromEntries(Object.keys(CLAUDE_DEFAULTS).map((action) => [action, shortcuts[action]]));

test("Claude editor defaults are the same in every preset and in older settings without them", () => {
  for (const preset of ["macos", "windows", "linux"]) assert.deepEqual(claudeKeys(keyboardPresetShortcuts(preset)), CLAUDE_DEFAULTS);
  const defaults = new SettingsStore("unused-settings-test-path", "en").get();
  const { claudeSubmit, claudeNewline, claudeNewlineAlternate, claudeSelectAll, claudeCopy, claudeCut, claudeClear, ...older } = keyboardPresetShortcuts("macos");
  const restored = normalizeSettings({ keyboardPreset: "custom", shortcuts: older }, defaults, "macos");
  assert.deepEqual(claudeKeys(restored.shortcuts), CLAUDE_DEFAULTS);
  assert.equal(restored.shortcuts.terminalCopy, "Meta+C", "the terminal keeps its own Command+C");
});

test("Claude editor keys conflict only with each other (and the detail toggle every context shares)", () => {
  assert.equal(shortcutsShareContext("claudeCopy", "terminalCopy"), false);
  assert.equal(shortcutsShareContext("claudeSelectAll", "codexSelectAll"), false);
  assert.equal(shortcutsShareContext("claudeNewline", "codexSubmit"), false);
  assert.equal(shortcutsShareContext("claudeSubmit", "commandPalette"), false);
  assert.equal(shortcutsShareContext("claudeCopy", "claudeCut"), true);
  assert.equal(shortcutsShareContext("claudeClear", "toggleDetail"), true);
  const defaults = new SettingsStore("unused-settings-test-path", "en").get();
  const rebound = normalizeSettings({ shortcuts: { ...DEFAULT_SHORTCUTS, claudeCopy: "Meta+K", claudeSubmit: "Ctrl+Enter" } }, defaults, "macos");
  assert.equal(rebound.shortcuts.claudeCopy, "Meta+K");
  assert.equal(rebound.shortcuts.claudeSubmit, "Ctrl+Enter");
  const clash = normalizeSettings({ shortcuts: { ...DEFAULT_SHORTCUTS, claudeCut: "Meta+C", claudeCopy: "Meta+C" } }, defaults, "macos");
  assert.deepEqual(clash.shortcuts, defaults.shortcuts, "a saved clash inside the Claude editor falls back as a whole");
});

test("submit, both line breaks and select keep a key; copy, cut and delete can be switched off", () => {
  const defaults = new SettingsStore("unused-settings-test-path", "en").get();
  const off = Object.fromEntries(Object.keys(CLAUDE_DEFAULTS).map((action) => [action, ""]));
  const normalized = normalizeSettings({ shortcuts: { ...DEFAULT_SHORTCUTS, ...off } }, defaults, "macos");
  assert.deepEqual(claudeKeys(normalized.shortcuts), { ...CLAUDE_DEFAULTS, claudeCopy: "", claudeCut: "", claudeClear: "" });
});

test("the Claude editor group sits in Keyboard on macOS only, with the draft-keys switch at its top", async () => {
  const source = await readFile(settingsPanelPath, "utf8");
  assert.match(source, /\["keyboardClaude", \["claudeSubmit", "claudeNewline", "claudeNewlineAlternate", "claudeSelectAll", "claudeCopy", "claudeCut", "claudeClear"\]\]/);
  assert.match(source, /group !== "keyboardClaude" \|\| window\.canvasTTY\.window\.isMacOS/);
  assert.equal(source.match(/claudeDraftKeysEnabled: value === "on"/g)?.length, 1, "one switch, in the Claude editor group");
  assert.match(source, /onDisable=\{REQUIRED_SHORTCUTS\.includes\(action\)/);
});
