// docs/UI_CONTRACT.md for the dialogs a card opens: theme tokens and em sizes in their CSS, official icons instead of
// glyphs, no native select or confirm, every text from lib/i18n.ts in both app languages, and App owns them.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [styles, i18n, app] = await Promise.all([read("src/renderer/src/styles/app.css"), read("src/renderer/src/lib/i18n.ts"), read("src/renderer/src/App.tsx")]);

const CARD_DIALOG_CSS = ["/* Card dialogs: the shared frame", "/* End of card dialogs. */"];
const DIALOGS = [
  { name: "change review", source: "src/renderer/src/features/terminal/PluginChangesReviewDialog.tsx",
    css: ["/* Change review of a plugin card action", "/* End of change review. */"],
    textModule: "src/renderer/src/features/terminal/pluginReviewText.ts", textFunction: "pluginReviewText" },
  { name: "rollback points", source: "src/renderer/src/features/terminal/CheckpointsDialog.tsx",
    css: ["/* Rollback points of a card", "/* End of rollback points. */"],
    textModule: "src/renderer/src/features/terminal/checkpointsText.ts", textFunction: "checkpointsText" }
];

function cssBlock([start, end]) {
  const from = styles.indexOf(start);
  const to = styles.indexOf(end);
  assert.ok(from >= 0 && to > from, `${start} block exists in app.css`);
  return styles.slice(from, to);
}

for (const dialog of DIALOGS) {
  test(`${dialog.name}: CSS uses theme tokens and scales with --ui-scale`, () => {
    // Each dialog is the shared card dialog frame plus its own rules; both must follow the contract.
    const block = cssBlock(CARD_DIALOG_CSS) + cssBlock(dialog.css);
    assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/iu, "no hex colors");
    assert.doesNotMatch(block, /\b(rgba?|hsla?)\(/iu, "no literal rgb/hsl colors");
    assert.doesNotMatch(block, /:\s*(white|black)\b|,\s*(white|black)\)/iu, "no named colors");
    assert.doesNotMatch(block, /opacity:\s*\.[6-9]/u, "secondary text uses --text-muted-on-dark, not opacity");
    const pixels = [...block.matchAll(/(\d+(?:\.\d+)?)px/gu)].map((match) => match[0]);
    assert.deepEqual([...new Set(pixels)].sort(), ["13px", "1px", "760px"].sort(),
      "only hairline borders, the 13px × --ui-scale base and the narrow-window media query are in px");
    assert.match(block, /font-size: calc\(13px \* var\(--ui-scale, 1\)\)/u);
  });

  test(`${dialog.name}: official icons, no glyphs, no native select/confirm, no portal outside the themed tree`, async () => {
    const source = await read(dialog.source);
    assert.doesNotMatch(source, /[×✕✖↻⟳…]\s*<|>\s*[×✕✖↻⟳]/u, "no literal close or reload glyphs");
    assert.doesNotMatch(source, /<select|<svg|<path|window\.confirm|globalThis\.confirm|createPortal/u);
    assert.doesNotMatch(source, /locale === "ru"/u, "no inline dictionary");
    assert.match(source, /<dialog\b/u);
    assert.match(source, /showModal\(\)/u);
    assert.match(source, /<UiIcon name="close"/u);
    assert.match(source, /className="card-dialog [a-z-]+"/u, "the dialog uses the shared card dialog frame");
  });

  test(`${dialog.name}: its texts are complete in ru and en and load only with the lazy dialog`, async () => {
    const [source, texts] = await Promise.all([read(dialog.source), read(dialog.textModule)]);
    const block = (name) => {
      const start = texts.indexOf(`const ${name}`);
      assert.ok(start >= 0, `${name} texts exist`);
      return texts.slice(start, texts.indexOf("\n};", start));
    };
    const keys = (name) => new Set([...block(name).matchAll(/^  ([a-zA-Z]+):/gmu)].map((match) => match[1]));
    const ru = keys("RU"), en = keys("EN");
    assert.ok(ru.size > 5, "the dialog's texts are in its text module");
    assert.deepEqual([...en].sort(), [...ru].sort(), "the same keys in ru and en");
    for (const [, key] of source.matchAll(/(?<![.\w])text\.([a-zA-Z]+)/gu)) assert.ok(ru.has(key), `${key} is defined`);
    assert.match(source, new RegExp(`const text = ${dialog.textFunction}\\(locale\\)`, "u"));
    // Only the dialog (a lazy chunk) imports its texts: the app's first paint carries none of them.
    for (const eager of ["src/renderer/src/App.tsx", "src/renderer/src/features/terminal/TerminalCard.tsx",
      "src/renderer/src/features/workspace/WorkspaceCanvas.tsx", "src/renderer/src/lib/i18n.ts"]) {
      assert.doesNotMatch(await read(eager), new RegExp(dialog.textFunction, "u"), eager);
    }
  });
}

test("a disabled dialog button is quiet: no fill, muted text, not-allowed cursor, unlike any available button", () => {
  const rule = styles.match(/\.card-dialog__primary:disabled, \.card-dialog__secondary:disabled, \.card-dialog__danger:disabled \{([^}]*)\}/u);
  assert.ok(rule, "one rule for every disabled dialog button");
  assert.match(rule[1], /background: transparent/u);
  assert.match(rule[1], /color: var\(--text-muted-on-dark\)/u);
  assert.match(rule[1], /cursor: not-allowed/u);
  assert.match(styles, /\.card-dialog__primary:hover:not\(:disabled\)/u, "hover never lights a disabled button");
});

test("App renders the card dialogs inside the themed tree, hides the native Browser and blocks canvas shortcuts", () => {
  assert.match(app, /const modalDialogOpen = shortcutReferenceOpen \|\| pluginReview !== null \|\| checkpointsFor !== null/u);
  assert.match(app, /browserViewVisible=\{[^}]*!modalDialogOpen/u);
  assert.equal(app.match(/if \(modalDialogOpen[ )]/gu)?.length, 2, "keyboard and pointer shortcuts");
  assert.match(app, /<PluginReviewHost request=\{pluginReview\}/u);
  assert.match(app, /<CheckpointsHost request=\{checkpointsFor\}/u);
});

test("every rollback point error code has a localized text, and the card menu label is in ru and en", async () => {
  const [source, contracts] = await Promise.all([read("src/renderer/src/features/terminal/CheckpointsDialog.tsx"), read("src/shared/contracts.ts")]);
  const union = contracts.slice(contracts.indexOf("export type CheckpointErrorCode"), contracts.indexOf(";", contracts.indexOf("export type CheckpointErrorCode")));
  const codes = [...union.matchAll(/"([a-z-]+)"/gu)].map((match) => match[1]);
  assert.ok(codes.length >= 8);
  for (const code of codes) assert.match(source, new RegExp(`"?${code}"?: "error[A-Za-z]+"`, "u"), code);
  assert.equal(i18n.match(/^  checkpointsMenu: "/gmu)?.length, 2, "checkpointsMenu exists in ru and en");
});
