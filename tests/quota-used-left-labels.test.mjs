import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { normalizeClaudeLimits, normalizeCodexLimits } from "../src/main/services/LimitsService.ts";
import { selectHomeModel } from "../src/renderer/src/features/home/homeModel.ts";
import { fill, quotaShareText, usageText } from "../src/renderer/src/features/usage/usageText.ts";

// The real HOME row, rendered without Electron (same harness as codex-api-limits-ui.test.mjs).
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

const now = 1_786_100_000_000;
const seconds = (ms) => Math.floor(ms / 1_000);

// `account/rateLimits/read` of `codex app-server`: usedPercent is the share already spent.
const codexPayload = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 9, windowDurationMins: 300, resetsAt: seconds(now + 2 * 3_600_000) },
    secondary: { usedPercent: 9, windowDurationMins: 10_080, resetsAt: seconds(now + 5 * 86_400_000) }
  },
  rateLimitsByLimitId: {}
};
// The Claude OAuth usage endpoint: utilization is the share already spent, too.
const claudePayload = {
  five_hour: { utilization: 9, resets_at: new Date(now + 2 * 3_600_000).toISOString() },
  seven_day: { utilization: 9, resets_at: new Date(now + 5 * 86_400_000).toISOString() }
};

/** What a person reads: text nodes only, not title/aria-label attributes. */
const visibleText = (html) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const attribute = (html, name) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";

const render = (provider, windows, locale) => {
  const snapshot = { fetchedAt: now, providers: [
    { provider, source: provider === "codex" ? "codex-app-server" : "claude-usage-api", state: "available", checkedAt: now, windows }
  ] };
  const row = selectHomeModel([], snapshot, "ready", now, [provider]).limitRows[0];
  return renderToStaticMarkup(createElement(LimitRow, { row, locale, now }));
};

test("the Codex and Claude normalizers keep 9 % spent as usedPercent 9 (not 91)", () => {
  assert.deepEqual(normalizeCodexLimits(codexPayload).map((window) => window.usedPercent), [9, 9]);
  assert.deepEqual(normalizeClaudeLimits(claudePayload).map((window) => window.usedPercent), [9, 9]);
});

for (const [locale, used, left] of [
  ["en", /9% used/, /91% left/],
  ["ru", /использовано/, /осталось 91%/]
]) {
  for (const [provider, windows] of [["codex", normalizeCodexLimits(codexPayload)], ["claude", normalizeClaudeLimits(claudePayload)]]) {
    test(`HOME ${provider} row in ${locale} says on screen that 9 % is used and 91 % is left`, () => {
      const html = render(provider, windows, locale);
      const text = visibleText(html);
      assert.match(text, /9\s?%/u, text);
      assert.match(text, used, `the visible row must say the share is used: ${text}`);
      assert.match(text, left, `the visible row must say what is left: ${text}`);
      assert.doesNotMatch(text, locale === "en" ? /\b9% left/ : /осталось 9%/u, text);
      // The hover/screen-reader line says both too.
      const label = attribute(html, "aria-label");
      assert.match(label, locale === "en" ? /9% used/ : /использовано 9%/u, label);
      assert.match(label, locale === "en" ? /91% left/ : /осталось 91%/u, label);
      // The bar is the used share.
      assert.match(html, /limit-row__fill" style="width:9%"/);
    });
  }
}

test("usage history says the latest quota observation is used, with what is left, in both languages", () => {
  assert.equal(quotaShareText("en", 9), "9% used · 91% left");
  assert.equal(quotaShareText("ru", 9), "использовано 9% · осталось 91%");
  assert.equal(quotaShareText("ru", 12.5), "использовано 12,5% · осталось 87,5%");
  assert.equal(quotaShareText("en", 140), "100% used · 0% left");
  for (const locale of ["en", "ru"]) {
    const text = usageText(locale);
    const latest = fill(text.latestValue, { share: quotaShareText(locale, 9), time: "T" });
    assert.ok(latest.includes(quotaShareText(locale, 9)), latest);
    const none = fill(text.noObservationsInPeriod, { share: quotaShareText(locale, 9), time: "T", account: "A" });
    assert.ok(none.includes(quotaShareText(locale, 9)), none);
    assert.ok(!/\{percent\}/u.test(text.latestValue + text.noObservationsInPeriod), "no bare percent template left");
  }
});
