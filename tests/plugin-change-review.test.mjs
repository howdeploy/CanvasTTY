import assert from "node:assert/strict";
import test from "node:test";
import { PluginCards } from "../src/main/services/PluginCards.ts";
import { normalizeCardActionInput, normalizeCardReview } from "../src/main/services/PluginChangeReviews.ts";

const textPage = (text, label) => ({ text, label, startLine: 0, totalLines: 1, hasMore: false });
const review = () => ({
  title: "Task results", acceptActionId: "accept", rejectActionId: "reject",
  groups: [{ sessionId: "worker", title: "Worker", files: [{ path: "source.txt", diff: "+ PRIVATE_KEY_VALUE",
    conflict: { current: textPage("current PRIVATE_KEY_VALUE", "Agent: peer PRIVATE_KEY_VALUE"), agent: textPage("agent PRIVATE_KEY_VALUE", "Agent: worker") } }] }]
});
const mask = text => text.replaceAll("PRIVATE_KEY_VALUE", "[MASKED]");
const actions = new Set(["review", "accept", "reject"]);

test("card actions retain their trusted session and mask structured file review and both conflict sides", async () => {
  const calls = [];
  const trustedSession = { id: "root", role: "orchestrator", provider: "codex" };
  const cards = new PluginCards({
    providers: () => [{ pluginId: "environments", pluginName: "Environments", serviceId: "results", actions: [...actions].map(id => ({ id, title: id })) }],
    trustedPlugins: () => new Set(["environments"]),
    session: id => id === "root" ? trustedSession : null,
    call: async (_plugin, _service, _method, params) => { calls.push(params); return { tone: "info", review: review() }; },
    redact: mask, changed() {}
  });
  const input = { agentSessionId: "worker", files: ["source.txt"], resolutions: { "source.txt": "agent" }, session: { id: "forged" } };
  const result = await cards.invoke("environments", "review", "root", input);
  assert.deepEqual(calls[0].session, trustedSession);
  assert.equal(calls[0].sessionId, "root");
  assert.deepEqual(calls[0].input, input);
  assert.ok(result.review);
  assert.doesNotMatch(JSON.stringify(result.review), /PRIVATE_KEY_VALUE/u);
  assert.match(result.review.groups[0].files[0].conflict.current.text, /\[MASKED\]/u);
  assert.match(result.review.groups[0].files[0].conflict.agent.text, /\[MASKED\]/u);
  assert.match(result.review.groups[0].files[0].conflict.current.label, /\[MASKED\]/u);
  assert.equal(result.review.groups[0].files[0].conflict.agent.label, "Agent: worker");
  assert.equal(result.review.acceptActionId, "accept");
});

test("review cannot name another plugin's actions and bounds text, files and total size", () => {
  const unknown = review(); unknown.acceptActionId = "undeclared";
  assert.throws(() => normalizeCardReview(unknown, mask, actions), /not declared/u);
  const long = review(); long.groups[0].files[0].diff = "x".repeat(20_000);
  const normalized = normalizeCardReview(long, mask, actions);
  assert.equal(normalized.groups[0].files[0].diff.length, 16_384);
  assert.equal(normalized.groups[0].files[0].truncated, true);
  const many = review(); many.groups[0].files = Array.from({ length: 401 }, () => ({ path: "a", diff: "" }));
  assert.throws(() => normalizeCardReview(many, mask, actions), /files are invalid/u);
  const oversized = review(); oversized.groups[0].files[0].diff = "x".repeat(512 * 1024);
  assert.throws(() => normalizeCardReview(oversized, mask, actions), /too large/u);
});

test("human card action input is a bounded JSON object and is copied before plugin dispatch", () => {
  assert.equal(normalizeCardActionInput(undefined), undefined);
  for (const input of [null, "wrong", ["wrong"]]) assert.throws(() => normalizeCardActionInput(input), /invalid/u);
  const input = { files: ["source.txt"] };
  const copy = normalizeCardActionInput(input);
  input.files.push("later.txt");
  assert.deepEqual(copy, { files: ["source.txt"] });
  const files = Array.from({ length: 400 }, (_, index) => `${index}/${"p".repeat(290)}.txt`);
  const selection = { files, resolutions: Object.fromEntries(files.map(path => [path, "agent"])) };
  assert.ok(Buffer.byteLength(JSON.stringify(selection)) > 16 * 1024);
  assert.doesNotThrow(() => normalizeCardActionInput(selection), "a valid 400-file selection fits the host action limit");
  assert.deepEqual(normalizeCardActionInput(selection), selection);
  assert.throws(() => normalizeCardActionInput({ text: "x".repeat(1024 * 1024) }), /too large/u);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => normalizeCardActionInput(cycle), /must be JSON/u);
});
