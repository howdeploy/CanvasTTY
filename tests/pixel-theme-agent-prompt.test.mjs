import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PIXEL_THEME_AGENT_GUIDE_URL, pixelThemeAgentPrompt } from "../src/renderer/src/features/settings/pixelThemeAgentPrompt.ts";

test("agent brief starts from the repository and specifies the install artifact", async () => {
  assert.equal(PIXEL_THEME_AGENT_GUIDE_URL, "https://github.com/teo-nex/CanvasTTY-design-for-agents/blob/main/AGENT_START.md");
  const guide = await readFile(new URL("../docs/pixel-skin-agent-start.md", import.meta.url), "utf8");
  assert.match(guide, /validate-pixel-skin-zip\.mjs/);
  assert.match(guide, /exactly ten final PNG/);
  for (const locale of ["ru", "en"]) {
    const prompt = pixelThemeAgentPrompt(locale);
    assert.match(prompt, /github\.com\/teo-nex\/CanvasTTY-design-for-agents/);
    assert.match(prompt, /github\.com\/howdeploy\/CanvasTTY/);
    assert.ok(prompt.includes(PIXEL_THEME_AGENT_GUIDE_URL));
    for (const value of ["minimal", "detailed", "master", "idle", "working", "completed"]) {
      assert.ok(prompt.includes(value));
    }
    assert.match(prompt, /background\.png/);
    assert.match(prompt, /pack_terminal_theme\.py/); assert.match(prompt, /--require-live/); assert.match(prompt, /encode_animation\.py/);
  }
});

test("theme creation dialog exposes copy and GitHub guide actions", async () => {
  const dialog = await readFile(new URL("../src/renderer/src/features/settings/PixelSkinPackCreator.tsx", import.meta.url), "utf8");
  assert.match(dialog, /window\.canvasTTY\.clipboard\.writeText\(pixelThemeAgentPrompt\(locale\)\)/);
  assert.match(dialog, /window\.canvasTTY\.external\.openUrl\(PIXEL_THEME_AGENT_GUIDE_URL\)/);
});
