import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  AGENT_PROVIDERS,
  LIMIT_PROVIDERS,
  homeLauncherColumnCount,
  resolveHomeLimitProviders,
  resolveHomeLauncherProviders,
  setHomeLimitProviderEnabled,
  setHomeLauncherProviderEnabled
} from "../src/renderer/src/lib/providers.ts";

test("HOME terminal clicks do not pass mouse events as canvas positions", async () => {
  const source = await readFile(new URL("../src/renderer/src/features/home/HomeZone.tsx", import.meta.url), "utf8");
  const handler = source.match(/<button\b[^>]*className="launcher-button launcher-button--terminal"[^>]*onClick=\{([^}]+)\}/)?.[1];
  assert.ok(handler, "HOME terminal button has a click handler");
  const calls = [];
  const onClick = runInNewContext(`(${handler})`, {
    onOpenTerminal: (...args) => calls.push(args)
  });

  onClick({ type: "click", clientX: 500, clientY: 300 });

  assert.deepEqual(calls, [[]]);
});

test("stale settings keep every current agent visible in the HOME launcher", () => {
  assert.deepEqual(resolveHomeLauncherProviders({}), AGENT_PROVIDERS);
});

test("the HOME launcher keeps one row while it fits and wraps a full set into two", () => {
  assert.equal(homeLauncherColumnCount([]), 2);
  assert.equal(homeLauncherColumnCount(["claude", "qwen", "kimi", "grok"]), 6);
  // A full agent set used to force one overloaded row; it must wrap instead.
  const total = AGENT_PROVIDERS.length + 2;
  const columns = homeLauncherColumnCount(AGENT_PROVIDERS);
  assert.ok(columns < total, "a full launcher set must wrap rather than form one row");
  assert.equal(Math.ceil(total / columns), 2, "a full launcher set fits in exactly two rows");
});

test("the HOME launcher follows the persisted provider subset in canonical order", () => {
  assert.deepEqual(
    resolveHomeLauncherProviders({ homeLauncherProviders: ["hermes", "codex"] }),
    ["codex", "hermes"]
  );
  assert.deepEqual(resolveHomeLauncherProviders({ homeLauncherProviders: [] }), []);
});

test("toggling one launcher provider preserves every unrelated choice", () => {
  assert.deepEqual(
    setHomeLauncherProviderEnabled(["codex", "kimi", "hermes"], "opencode", true),
    ["codex", "kimi", "opencode", "hermes"]
  );
  assert.deepEqual(
    setHomeLauncherProviderEnabled(["codex", "kimi", "opencode", "hermes"], "opencode", false),
    ["codex", "kimi", "hermes"]
  );
});

test("stale settings keep every real limit provider visible", () => {
  assert.deepEqual(resolveHomeLimitProviders({}), LIMIT_PROVIDERS);
});

test("HOME limit visibility is canonical and independent from launcher visibility", () => {
  assert.deepEqual(
    resolveHomeLimitProviders({
      homeLauncherProviders: ["grok"],
      homeLimitProviders: ["grok", "qwen", "kimi", "opencode", "codex"]
    }),
    ["codex", "qwen", "kimi", "opencode", "grok"]
  );
  assert.deepEqual(resolveHomeLimitProviders({ homeLimitProviders: [] }), []);
});

test("toggling a HOME limit provider preserves the other limit choices", () => {
  assert.deepEqual(
    setHomeLimitProviderEnabled(["codex", "kimi", "grok"], "opencode", true),
    ["codex", "kimi", "opencode", "grok"]
  );
  assert.deepEqual(
    setHomeLimitProviderEnabled(["codex", "kimi", "opencode", "grok"], "opencode", false),
    ["codex", "kimi", "grok"]
  );
});
