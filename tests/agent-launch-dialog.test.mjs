import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dialogPath = new URL("../src/renderer/src/features/launcher/AgentLaunchDialog.tsx", import.meta.url);

test("agent launcher can import its project path from the clipboard", async () => {
  const source = await readFile(dialogPath, "utf8");

  assert.match(source, /window\.canvasTTY\.clipboard\.readText\(\)/);
  assert.match(source, /directoryPathFromClipboard/);
  assert.match(source, /folder-field__paste/);
  assert.match(source, /aria-label=\{t\(locale, "pasteProjectPath"\)\}/);
});
