// UI chrome follows the root --ui-scale (docs/UI_CONTRACT.md): the card options menu, the canvas
// shortcut-hints panel and the Settings → Plugins cards must not keep fixed pixel text sizes.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../src/renderer/src/styles/app.css", import.meta.url), "utf8");
const canvas = await readFile(new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url), "utf8");
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const rule = (selector) => css.match(new RegExp(`^${escape(selector)} \\{[^}]*\\}`, "mu"))?.[0] ?? "";
const declaration = (block, property) => block.match(new RegExp(`(?:^|[;{ ])${property}: ([^;]+);`, "u"))?.[1];
const scaledSource = String.raw`calc\(\d+(?:\.\d+)?px \* var\(--ui-scale, 1\)\)`;

test("the card options menu scales its font with --ui-scale and sizes everything else from it", () => {
  const menu = rule(".terminal-card__menu");
  assert.match(menu, /font-size: calc\(12px \* var\(--ui-scale, 1\)\)/u);
  for (const selector of [".terminal-card__menu", ".terminal-card__menu label", ".terminal-card__menu-action"]) {
    const block = rule(selector);
    assert.ok(block, selector);
    for (const property of ["padding", "gap", "border-radius", "right"]) {
      const value = declaration(block, property);
      if (value) assert.doesNotMatch(value, /\dpx/u, `${selector} ${property} follows the menu's font size`);
    }
  }
});

test("the shortcut-hints panel scales its font with --ui-scale and sizes everything else from it", () => {
  assert.match(rule(".shortcut-hints"), /font-size: calc\(11px \* var\(--ui-scale, 1\)\)/u);
  for (const selector of [".shortcut-hints", ".shortcut-hints > div", ".shortcut-hints kbd", ".shortcut-hints span", ".shortcut-hints__more"]) {
    const block = rule(selector);
    assert.ok(block, selector);
    for (const property of ["min-width", "padding", "gap", "border-radius", "grid-template-columns", "font", "font-size"]) {
      const value = declaration(block, property);
      if (value) assert.doesNotMatch(value.replace(new RegExp(scaledSource, "gu"), ""), /\dpx/u, `${selector} ${property} follows the panel's font size`);
    }
  }
  assert.match(canvas, /className="shortcut-hints__more"[\s\S]{0,300}?<UiIcon name="app-window" size="[\d.]+em" \/>/u,
    "the Keyboard shortcuts icon scales with the panel text");
});

test("Settings → Plugins text in the installed, preview, permission and contribution cards follows --ui-scale", () => {
  const prefixes = [".plugin-install-row", ".plugin-preview", ".plugin-permissions", ".plugin-hook-warning", ".plugin-modules", ".installed-plugin", ".plugin-contribution"];
  const blocks = css.split("\n").filter((line) => prefixes.some((prefix) => line.startsWith(prefix)) && line.includes("{"));
  assert.ok(blocks.length > 20, "plugin settings rules were found");
  let checked = 0;
  for (const block of blocks) {
    for (const property of ["font", "font-size"]) {
      const value = declaration(block, property);
      if (!value) continue;
      checked += 1;
      assert.doesNotMatch(value.replace(new RegExp(scaledSource, "gu"), ""), /\dpx/u, `${block.slice(0, block.indexOf("{")).trim()} ${property} follows --ui-scale`);
    }
  }
  assert.ok(checked > 15, "plugin settings font sizes were checked");
  for (const selector of [".plugin-permissions", ".plugin-contribution > span strong", ".plugin-contribution > span small"]) {
    assert.match(declaration(rule(selector), "font-size") ?? "", new RegExp(scaledSource, "u"), selector);
  }
});
