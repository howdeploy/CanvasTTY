import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_CAPABILITIES } from "../src/shared/contracts.ts";

// The expected agent roster at the time of this test; a provider added to the
// union without a capability descriptor must update this list and fail here.
const EXPECTED_AGENTS = [
  "codex", "claude", "qwen", "kimi", "opencode", "hermes", "grok",
  "omp", "pi", "cursor", "minimax", "devin", "antigravity"
];

test("every agent provider declares capabilities", () => {
  for (const provider of EXPECTED_AGENTS) {
    assert.ok(provider in PROVIDER_CAPABILITIES, provider);
    const capabilities = PROVIDER_CAPABILITIES[provider];
    assert.equal(typeof capabilities.send, "boolean", provider);
    assert.equal(typeof capabilities.observe, "boolean", provider);
    assert.ok(["structured", "hooks", "process", "none"].includes(capabilities.lifecycle), provider);
    assert.ok(["structured", "final-message", "terminal", "none"].includes(capabilities.result), provider);
    assert.ok(["structured", "terminal", "none"].includes(capabilities.approvals), provider);
    assert.ok(["mcp", "none"].includes(capabilities.browser), provider);
    assert.equal(typeof capabilities.acp, "boolean", provider);
  }
});

test("the capability roster covers exactly the current agent union", () => {
  assert.deepEqual(Object.keys(PROVIDER_CAPABILITIES).sort(), [...EXPECTED_AGENTS].sort());
});

test("structured lifecycle is reserved for the OpenCode event plugin", () => {
  assert.equal(PROVIDER_CAPABILITIES.opencode.lifecycle, "structured");
  for (const [provider, capabilities] of Object.entries(PROVIDER_CAPABILITIES)) {
    if (provider !== "opencode") assert.notEqual(capabilities.lifecycle, "structured", provider);
  }
});

test("browser bridging matches the TerminalManager exclusion list", () => {
  // Providers without a measured browser adapter take no bridge; the list
  // mirrors the exclusion in TerminalManager.spawnProcess.
  const excluded = new Set(["grok", "omp", "pi", "cursor", "minimax", "devin", "antigravity"]);
  for (const [provider, capabilities] of Object.entries(PROVIDER_CAPABILITIES)) {
    assert.equal(
      capabilities.browser,
      excluded.has(provider) ? "none" : "mcp",
      provider
    );
  }
});

test("no provider claims ACP before the adapter exists", () => {
  for (const [provider, capabilities] of Object.entries(PROVIDER_CAPABILITIES)) {
    assert.equal(capabilities.acp, false, provider);
  }
});
