import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { t } from "../src/renderer/src/lib/i18n.ts";

const canvasPath = new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url);
const referencePath = new URL("../src/renderer/src/components/ShortcutReference.tsx", import.meta.url);
const settingsPath = new URL("../src/renderer/src/features/settings/SettingsPanel.tsx", import.meta.url);

// Latin words that may stay untranslated in Russian hints: keyboard and mouse key
// names, plus product names and the HOME zone label that the UI shows verbatim.
const allowedLatin = new Set([
  "Shift", "Command", "Super", "Ctrl", "Control", "Alt", "Option", "Meta",
  "Enter", "Escape", "Esc", "Space", "Tab", "Backspace", "Delete",
  "PageUp", "PageDown", "Mouse3", "Mouse4", "Mouse5",
  "HOME", "Codex", "CLI", "TUI"
]);

function latinWords(text) {
  return [...text.matchAll(/[A-Za-z][A-Za-z0-9]*/g)].map((match) => match[0])
    .filter((word) => !allowedLatin.has(word) && !/^F\d{1,2}$/.test(word));
}

async function hintKeys() {
  const [canvas, reference] = await Promise.all([readFile(canvasPath, "utf8"), readFile(referencePath, "utf8")]);
  const aside = canvas.slice(canvas.indexOf('<aside className="shortcut-hints"'), canvas.indexOf("</aside>"));
  assert.ok(aside.length > 0, "canvas shortcut hints panel found");
  const keys = new Set();
  for (const match of aside.matchAll(/t\(settings\.locale, "(\w+)"\)/g)) keys.add(match[1]);
  for (const match of reference.matchAll(/\], "(\w+)"\]/g)) keys.add(match[1]);
  for (const match of reference.matchAll(/title: "(\w+)"/g)) keys.add(match[1]);
  for (const match of reference.matchAll(/t\(locale, "(\w+)"\)/g)) keys.add(match[1]);
  return { keys: [...keys], aside, reference };
}

test("Russian shortcut hints contain no English words besides key names", async () => {
  const { keys } = await hintKeys();
  assert.ok(keys.includes("canvasWheelOverrideHint"));
  assert.ok(keys.includes("canvasNavigationOverrideHint"));
  assert.ok(keys.includes("marqueeSelectionHint"));
  assert.ok(keys.length >= 30, `collected ${keys.length} hint keys`);
  const offenders = keys.map((key) => [key, t("ru", key), latinWords(t("ru", key))])
    .filter(([, , words]) => words.length > 0);
  assert.deepEqual(offenders, []);
});

test("shortcut hint key caps do not hard-code English gesture words", async () => {
  const { aside, reference } = await hintKeys();
  for (const source of [aside, reference]) {
    const literals = [...source.matchAll(/<kbd>([^<{]+)<\/kbd>|\[\["([^"\]]+)"\]/g)]
      .map((match) => match[1] ?? match[2]);
    for (const literal of literals) assert.deepEqual(latinWords(literal), [], `kbd literal ${literal}`);
  }
  assert.equal(t("ru", "shortcutShiftDrag"), "Shift + перетаскивание");
  assert.equal(t("en", "shortcutShiftDrag"), "Shift + drag");
});

test("the Russian canvas wheel settings are translated, including the capture mode labels", async () => {
  const settings = await readFile(settingsPath, "utf8");
  const start = settings.indexOf('label={t(locale, "canvasWheelCapture")}');
  assert.ok(start > 0, "the wheel capture setting is found");
  const group = settings.slice(start, settings.indexOf("</SettingGroup>", start));
  const options = /options=\{(\[\[[\s\S]*?\]\])\}/u.exec(group)?.[1] ?? "";
  assert.ok(options.includes('"off"') && options.includes('"always"') && options.includes('"key"'), options);
  assert.deepEqual([...options.matchAll(/\["\w+", "([^"]*)"\]/gu)].map((match) => match[1]), [], "no hard-coded option labels");
  const keys = new Set(["canvasWheelCapture", "canvasWheelCaptureDescription", "canvasWheelOverride", "canvasWheelCaptureKey"]);
  for (const match of group.matchAll(/\bt\(locale, "(\w+)"\)/gu)) keys.add(match[1]);
  const offenders = [...keys].map((key) => [key, latinWords(t("ru", key))]).filter(([, words]) => words.length > 0);
  assert.deepEqual(offenders, []);
  assert.equal(t("en", "canvasWheelCaptureKey"), "Key");
});

test("the Russian canvas navigation override setting is translated", async () => {
  const settings = await readFile(settingsPath, "utf8");
  const start = settings.indexOf('label={t(locale, "canvasNavigationOverride")}');
  assert.ok(start > 0, "the navigation override setting is found");
  const group = settings.slice(start, settings.indexOf("</SettingGroup>", start));
  const keys = new Set(["canvasNavigationOverride", "canvasNavigationOverrideDescription", "canvasNavigationCaptureHint"]);
  for (const match of group.matchAll(/\bt\(locale, "(\w+)"\)/gu)) keys.add(match[1]);
  const offenders = [...keys].map((key) => [key, latinWords(t("ru", key))]).filter(([, words]) => words.length > 0);
  assert.deepEqual(offenders, []);
});

test("Russian hints and canvas settings name the drag gesture with one word", async () => {
  const { keys } = await hintKeys();
  const all = [...keys, "canvasWheelCaptureDescription", "canvasNavigationOverrideDescription", "canvasOverrideBindingsMatch"];
  const other = all.filter((key) => /тян(уть|ите)|протаскив/iu.test(t("ru", key)));
  assert.deepEqual(other, []);
  // The key cap names the gesture; its label only says what it does.
  for (const locale of ["ru", "en"]) assert.ok(!t(locale, "marqueeSelectionHint").includes(t(locale, "shortcutShiftDrag")), locale);
  assert.equal(t("ru", "marqueeSelectionHint"), "Выделить группу");
  assert.equal(t("en", "marqueeSelectionHint"), "Select a group");
  assert.match(t("ru", "canvasNavigationOverrideDescription"), /перетаскивание/u);
});

test("the hints panel shows action shortcuts with the same key formatter as the shortcut reference", async () => {
  const { displayShortcutBinding } = await import("../src/renderer/src/lib/shortcuts.ts");
  assert.equal(displayShortcutBinding("Alt+ArrowUp", false), "Alt+↑");
  assert.equal(displayShortcutBinding("Meta+Comma", true), "Command+,");
  assert.equal(displayShortcutBinding("Meta+Shift+F", false), "Super+Shift+F");
  const { aside, reference } = await hintKeys();
  assert.doesNotMatch(aside, /<kbd>\{settings\.shortcuts\./u, "no raw binding in a hint key cap");
  assert.match(aside, /displayShortcutBinding\(settings\.shortcuts\[action\]/u);
  for (const action of ["home", "renameWindow", "toggleFullscreen", "focusUp"]) assert.match(aside, new RegExp(`\\["${action}", "\\w+"\\]`, "u"), action);
  assert.match(reference, /displayShortcutBinding\(/u);
});

test("long labels in the canvas navigation rows of Settings wrap instead of being cut off", async () => {
  const css = await readFile(new URL("../src/renderer/src/styles/app.css", import.meta.url), "utf8");
  const rule = /\.setting-group__control \.shortcut-editor__row > span \{([^}]*)\}/u.exec(css)?.[1] ?? "";
  assert.match(rule, /white-space: normal/u);
  assert.match(rule, /text-overflow: clip/u);
});
