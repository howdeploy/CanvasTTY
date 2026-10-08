/** N3: a resumed conversation's earlier usage is not counted as this period's or this task's usage. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionTimelineService } from "../src/main/services/SessionTimelineService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";

const THREAD = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const SOURCE = "codex-cli conversation counter";
const context = { provider: "codex", accountId: "default", taskId: "root", model: "gpt-test" };
const counter = (total) => ({ input: Math.floor(total * 0.75), output: total - Math.floor(total * 0.75), total });

async function timelineFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ctty-resumed-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const timeline = new SessionTimelineService(root, value => value);
  await timeline.load();
  return { root, timeline };
}

const dayTotal = async (timeline, sessionId) =>
  (await timeline.breakdown("day", "root")).filter(row => row.sessionId === sessionId).reduce((sum, row) => sum + (row.tokens.total ?? 0), 0);
const taskTokens = (timeline) =>
  timeline.taskBudgetUsageByTask([{ taskId: "root", sessionIds: ["root", "card"] }]).get("root").contributions.reduce((sum, row) => sum + row.tokens, 0);

test("the first sample after a resume is a baseline for the day and for the task budget", async t => {
  const { root, timeline } = await timelineFixture(t);
  // The conversation already used 50 000 tokens in earlier runs that this journal never saw.
  await timeline.recordCumulativeUsage("card", counter(50_000), SOURCE, THREAD, context, { resumed: true });
  assert.equal(await dayTotal(timeline, "card"), 0, "earlier runs are not today's usage");
  assert.equal(taskTokens(timeline), 0, "earlier runs are not this task's usage");
  await timeline.recordCumulativeUsage("card", counter(50_600), SOURCE, THREAD, context, { resumed: true });
  assert.equal(await dayTotal(timeline, "card"), 600);
  assert.equal(taskTokens(timeline), 600);
  assert.equal((await timeline.breakdown("all", "root")).find(row => row.sessionId === "card").tokens.total, 50_600,
    "the all-time view still shows the conversation's cumulative total");
  // The baseline survives a restart: the reloaded index and journal agree.
  const reloaded = new SessionTimelineService(root, value => value);
  await reloaded.load();
  assert.equal(await dayTotal(reloaded, "card"), 600);
  assert.equal(taskTokens(reloaded), 600);
});

test("a conversation started in this card, or resumed after the journal saw it, keeps counting its usage", async t => {
  const { timeline } = await timelineFixture(t);
  await timeline.recordCumulativeUsage("card", counter(1_200), SOURCE, OTHER, context);
  assert.equal(await dayTotal(timeline, "card"), 1_200, "a new conversation's first sample is real usage");
  await timeline.recordCumulativeUsage("root", counter(1_500), SOURCE, OTHER, context, { resumed: true });
  assert.equal(await dayTotal(timeline, "root"), 300, "a known counter continues from its last sample on the resuming card");
  assert.equal(taskTokens(timeline), 1_500);
});

function fakeManager(t) {
  const registry = { get: provider => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: {}, checked: [] }), snapshot: () => ({}) };
  const pty = () => ({ pid: 4242, process: "codex", write() {}, resize() {}, kill() {}, pause() {}, resume() {},
    onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; } });
  const manager = new TerminalManager(() => undefined, registry, undefined, undefined, true, pty);
  t.after(() => manager.shutdown());
  return manager;
}

test("cards report which conversation their launch resumed", t => {
  const manager = fakeManager(t);
  const position = { x: 0, y: 0 };
  const exact = manager.create({ provider: "codex", profile: "normal", cwd: process.cwd(), position, resumeThreadId: THREAD });
  const fresh = manager.create({ provider: "codex", profile: "normal", cwd: process.cwd(), position });
  for (const card of [exact, fresh]) manager.resize(card.id, 100, 30);
  assert.equal(manager.resumedConversation(exact.id, THREAD), true);
  manager.applyProviderSignal(fresh.id, { kind: "lifecycle", state: "idle", threadId: OTHER });
  assert.equal(manager.resumedConversation(fresh.id, OTHER), false, "a new conversation was not resumed");
  assert.equal(manager.resumedConversation(exact.id, OTHER), false);
});

test("a restart that resumes the previous conversation marks that conversation once the provider names it", t => {
  const exits = [];
  const registry = { get: provider => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: {}, checked: [] }), snapshot: () => ({}) };
  const manager = new TerminalManager(() => undefined, registry, undefined, undefined, true, () => ({ pid: 4243, process: "codex",
    write() {}, resize() {}, kill() {}, pause() {}, resume() {}, onData() { return { dispose() {} }; },
    onExit(handler) { exits.push(handler); return { dispose() {} }; } }));
  t.after(() => manager.shutdown());
  const card = manager.create({ provider: "codex", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
  manager.resize(card.id, 100, 30);
  manager.applyProviderSignal(card.id, { kind: "lifecycle", state: "idle", threadId: THREAD });
  assert.equal(manager.resumedConversation(card.id, THREAD), false);
  exits.at(-1)({ exitCode: 0 });
  manager.restart(card.id, { resume: true });
  manager.resize(card.id, 100, 30);
  manager.applyProviderSignal(card.id, { kind: "lifecycle", state: "idle", threadId: THREAD });
  assert.equal(manager.resumedConversation(card.id, THREAD), true);
  exits.at(-1)({ exitCode: 0 });
  manager.restart(card.id);
  manager.resize(card.id, 100, 30);
  manager.applyProviderSignal(card.id, { kind: "lifecycle", state: "idle", threadId: OTHER });
  assert.equal(manager.resumedConversation(card.id, OTHER), false, "a plain restart starts a new conversation");
});
