import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { selectHomeModel } from "../src/renderer/src/features/home/homeModel.ts";

// Render the real row without changing its production exports or starting Electron.
const bundle = await build({
  stdin: {
    contents: 'export { LimitRow } from "./src/renderer/src/features/home/HomeZone.tsx"; export { createElement } from "react"; export { renderToStaticMarkup } from "react-dom/server";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts"
  },
  plugins: [{ name: "test-limit-row", setup(build) {
    build.onLoad({ filter: /[/\\]HomeZone\.tsx$/ }, async ({ path }) => ({
      contents: await readFile(path, "utf8") + "\nexport { LimitRow };", loader: "tsx"
    }));
  } }],
  bundle: true, platform: "node", format: "esm", jsx: "automatic", write: false,
  loader: { ".svg": "dataurl", ".png": "dataurl", ".ico": "dataurl", ".css": "empty" }, logLevel: "silent",
  banner: { js: `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(import.meta.url)});` }
});
const { LimitRow, createElement, renderToStaticMarkup } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

for (const [locale, label, errorLabel] of [
  ["en", "API profile: subscription limits unavailable", "Protocol error"],
  ["ru", "API-профиль: лимиты подписки недоступны", "Ошибка протокола"]
]) test(`HOME explains API-profile limits in ${locale} and preserves real protocol errors`, () => {
  const now = 1_786_100_000_000;
  const render = (reason) => {
    const snapshot = { fetchedAt: now, providers: [
      { provider: "codex", source: "codex-app-server", state: "unavailable", checkedAt: now, reason }
    ] };
    const row = selectHomeModel([], snapshot, "ready", now, ["codex"]).limitRows[0];
    return renderToStaticMarkup(createElement(LimitRow, { row, locale, now }));
  };
  const api = render("api-profile");
  assert.ok(api.includes(label));
  assert.ok(!api.includes(errorLabel));
  assert.ok(!api.includes("limit-row__fill"), "unavailable subscription limits must not become a quota bar");
  assert.ok(render("protocol-error").includes(errorLabel));
});
