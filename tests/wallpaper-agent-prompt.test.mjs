import test from "node:test";
import assert from "node:assert/strict";
import { wallpaperAgentPrompt } from "../src/renderer/src/features/settings/wallpaperAgentPrompt.ts";
import { DEFAULT_WALLPAPER_RECIPE } from "../src/shared/wallpaper.ts";
for (const locale of ["ru", "en"]) test(`agent brief is portable without a published design-kit update (${locale})`, () => {
  const prompt = wallpaperAgentPrompt(locale, "clock", { ...DEFAULT_WALLPAPER_RECIPE, x: 35, clockFont: "pixel" });
  assert.match(prompt, /"schemaVersion": 1/); assert.match(prompt, /"kind": "canvastty-wallpaper"/);
  assert.match(prompt, /"clockFont": "pixel"/); assert.match(prompt, /"x": 35/);
  assert.match(prompt, /ACTUAL_SOURCE_WIDTH/); assert.match(prompt, /BASE64_OF_ORIGINAL_FILE/);
  assert.match(prompt, /LIVE_ENGINE\.md/); assert.match(prompt, /GIF/);
  assert.match(prompt, /encode_animation\.py/); assert.match(prompt, /--require-live/); assert.match(prompt, /APNG/);
});
