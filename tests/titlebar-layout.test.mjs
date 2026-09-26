import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/renderer/src/App.tsx", import.meta.url);
const titleBarPath = new URL("../src/renderer/src/components/TitleBar.tsx", import.meta.url);
const startupPagePath = new URL("../src/main/startupPage.ts", import.meta.url);
const stylesPath = new URL("../src/renderer/src/styles/app.css", import.meta.url);

test("viewport-bound overlays and camera sizing share the titlebar boundary", async () => {
  const [app, titleBar, startupPage, styles] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(titleBarPath, "utf8"),
    readFile(startupPagePath, "utf8"),
    readFile(stylesPath, "utf8")
  ]);

  assert.match(styles, /\.titlebar \{[^}]*height: var\(--titlebar-height\);/);
  assert.match(styles, /\.dialog-backdrop, \.settings-backdrop \{[^}]*inset: var\(--titlebar-height\) 0 0;/);
  assert.doesNotMatch(app, /window\.innerHeight - 44/);
  assert.match(app, /document\.querySelector<HTMLElement>\("\.app__content"\)/);
  assert.match(startupPage, /--titlebar-height: \$\{titlebarHeight\}px;/);
  assert.match(startupPage, /grid-template-rows: var\(--titlebar-height\) 1fr;/);
  assert.match(titleBar, /import appManifest from "\.\.\/\.\.\/\.\.\/\.\.\/package\.json";/);
  assert.match(titleBar, /import\.meta\.env\.DEV \|\| import\.meta\.env\.VITE_BUILD_CHANNEL === "DEV" \? "DEV" : "RELEASE"/);
  assert.match(titleBar, /`\$\{BUILD_CHANNEL\} v\$\{appManifest\.version\}`/);
  assert.match(styles, /\.titlebar__build--dev \{/);
  assert.match(styles, /\.titlebar__build--release \{/);
});
