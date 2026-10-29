import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderLifecycleParser,
  initialSessionStatus
} from "../src/main/services/providerLifecycle.ts";

const working = "◐\uFE0E Qwen - project";
const approval = "✳\uFE0E Qwen - project";

test("only providers with typed terminal-title lifecycle signals start as observable", () => {
  assert.equal(initialSessionStatus("terminal"), "idle");
  assert.equal(initialSessionStatus("claude"), "unavailable");
  assert.equal(initialSessionStatus("qwen"), "unavailable");
  assert.equal(initialSessionStatus("codex"), "unavailable");
  assert.equal(initialSessionStatus("kimi"), "unavailable");
  assert.equal(createProviderLifecycleParser("opencode"), null);
});

test("Qwen title signals report working, input-needed, and idle without reading terminal text", () => {
  const parser = createProviderLifecycleParser("qwen", "/tmp/project");
  assert.ok(parser);

  assert.equal(parser.push(`\u001b]0;${"Qwen - project".padEnd(80)}\u0007`), "idle");
  assert.equal(parser.push(`ordinary output\u001b]0;${working.padEnd(80)}\u0007`), "working");
  assert.equal(parser.push(`\u001b]2;${approval.padEnd(80)}\u0007`), "needs_approval");
  assert.equal(parser.push(`\u001b]0;${"Qwen - project".padEnd(80)}\u0007`), "idle");
});

test("Claude and Qwen lifecycle parsing handles chunk boundaries and ST terminators", () => {
  const parser = createProviderLifecycleParser("claude");
  assert.ok(parser);

  assert.equal(parser.push("\u001b"), null);
  assert.equal(parser.push(`]2;${working.slice(0, 5)}`), null);
  assert.equal(parser.push(`${working.slice(5)}\u001b\\`), "working");
  assert.equal(parser.push("\u001b]2;shell command title\u0007"), null);
  assert.equal(parser.push("\u001b]2;Qwen - project\u0007"), "idle");
  assert.equal(parser.push("\u001b]2;◐ Qwen - project\u0007"), "working");
});

test("oversized incomplete OSC data is discarded", () => {
  const parser = createProviderLifecycleParser("qwen");
  assert.ok(parser);
  assert.equal(parser.push(`\u001b]2;${"x".repeat(5_000)}`), null);
  assert.equal(parser.push(`\u001b]2;${working}\u0007`), "working");
});

test("OSC 7501 root reports survive chunk boundaries and never treat done or error as process exit", () => {
  const parser = createProviderLifecycleParser("codex");
  assert.equal(parser.push("\x1b]7501;state=wor"), null);
  assert.equal(parser.push("king:app=codex\x1b"), null);
  assert.equal(parser.push("\\"), "working");
  assert.equal(parser.push("\x1b]7501;state=idle:app=codex\x07"), "idle");
  assert.equal(parser.programStatus, "idle");
  for (const body of ["state=working:app=other", "state=working:app=codex:id=child", "state=unknown:app=codex"]) {
    assert.equal(parser.push(`\x1b]7501;${body}\x07`), null);
    assert.equal(parser.programStatus, "idle");
  }
  for (const state of ["done", "error"]) {
    assert.equal(parser.push(`\x1b]7501;state=${state}:app=codex\x07`), "idle");
    assert.equal(parser.programStatus, state);
  }
  assert.equal(parser.push("\x1b]7501;?\x1b\\"), null);
  assert.match(parser.takeReply(), /^\x1b\]7501;\?:states=/u);
  assert.equal(parser.takeReply(), null);
  const claude = createProviderLifecycleParser("claude");
  assert.equal(claude.push("\x1b]7501;state=working:app=claude-code\x07"), "working");
  assert.equal(claude.push("\x1b]7501;state=blocked:kind=permission:app=claude-code\x07"), "needs_approval");
});
