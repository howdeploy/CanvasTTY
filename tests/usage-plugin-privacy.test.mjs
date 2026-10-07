import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The renderer receives the raw limits snapshot (including the local-only accountScope
// fingerprint used by usage history). Canvas plugins must never see that fingerprint.

const root = new URL("..", import.meta.url);

const bundle = await build({
  stdin: {
    contents: 'export { pluginLimitsResponse } from "./src/renderer/src/features/plugins/PluginFrame.tsx";',
    resolveDir: fileURLToPath(root),
    loader: "ts"
  },
  bundle: true,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  loader: { ".svg": "dataurl", ".css": "empty" },
  banner: { js: `import { createRequire as __privacyRequire } from "node:module"; const require = __privacyRequire(${JSON.stringify(import.meta.url)});` },
  logLevel: "silent",
  write: false
});
const { pluginLimitsResponse } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);

const SCOPE = "scope-fingerprint-0123456789abcdef";
const window5h = { id: "codex:primary", label: "5h", usedPercent: 12, used: null, limit: null, windowMinutes: 300, resetsAt: 1_000 };

function snapshot() {
  return {
    fetchedAt: 10,
    providers: [
      { provider: "codex", state: "available", source: "codex-app-server", fetchedAt: 10, windows: [window5h], accountScope: SCOPE },
      { provider: "claude", state: "stale", source: "claude-oauth", fetchedAt: 5, failedAt: 9, reason: "network", windows: [], accountScope: SCOPE },
      { provider: "qwen", state: "unavailable", source: "none", checkedAt: 9, reason: "unsupported" }
    ]
  };
}

test("limits.get response strips accountScope from every provider", () => {
  const input = snapshot();
  const response = pluginLimitsResponse(input);
  assert.equal(response.state, "ready");
  assert.doesNotMatch(JSON.stringify(response), /accountScope|scope-fingerprint/);
  for (const provider of response.snapshot.providers) assert.equal("accountScope" in provider, false);
  assert.deepEqual(response.snapshot.providers[0].windows, [window5h], "quota data is preserved");
  assert.equal(response.snapshot.providers[1].reason, "network");
  assert.deepEqual(response.snapshot.providers[2], input.providers[2]);
  assert.equal(input.providers[0].accountScope, SCOPE, "the host snapshot is not mutated");
  assert.notEqual(response.snapshot.providers[0].windows, input.providers[0].windows, "plugins get a copy, not host objects");
});

test("null scope and a missing snapshot are handled", () => {
  const input = snapshot();
  input.providers[0].accountScope = null;
  assert.equal("accountScope" in pluginLimitsResponse(input).snapshot.providers[0], false);
  assert.deepEqual(pluginLimitsResponse(null), { state: "loading", snapshot: null });
});

test("PluginFrame routes limits.get and every snapshot forwarded to a frame through the sanitizer", async () => {
  const frame = await readFile(new URL("src/renderer/src/features/plugins/PluginFrame.tsx", root), "utf8");
  assert.match(frame, /method === "limits\.get"[\s\S]{0,160}return pluginLimitsResponse\(limits\)/);
  assert.equal((frame.match(/snapshot: limits\b/g) ?? []).length, 0, "no raw snapshot is posted");
  const uses = [...frame.matchAll(/\blimits\b/g)].length;
  // Props, destructuring, effect deps, handleRequest args/types and the single sanitized return.
  assert.ok(uses <= 9, `unexpected new limits forwarding path (${uses} references)`);
});
