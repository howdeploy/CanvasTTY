import assert from "node:assert/strict";
import test from "node:test";

// OpenCode 1.18 runs every exported function of a plugin module as a plugin and reads the hooks object it returns.
// A helper exported next to the plugin returned no hooks and broke OpenCode's start for every CanvasTTY launch
// ("plugin config hook failed: N.config", then "undefined is not an object (evaluating 'n.provider')").
test("the OpenCode plugin module exports only plugin functions that return a hooks object", async () => {
  const module = await import("../src/agent-runtime/opencode-plugin.mjs");
  const exported = Object.entries(module);
  assert.deepEqual(exported.map(([name]) => name), ["CanvasTTYLifecycle"]);
  for (const [name, plugin] of exported) {
    assert.equal(typeof plugin, "function", name);
    const hooks = await plugin({ client: undefined, directory: process.cwd(), worktree: process.cwd() });
    assert.ok(hooks && typeof hooks === "object", `${name} returns a hooks object`);
    assert.equal(typeof hooks.event, "function");
  }
});
