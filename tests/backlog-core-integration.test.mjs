import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { OrchestrationBudgetService } from "../src/main/services/OrchestrationBudgetService.ts";
import { OrchestrationTaskBoard } from "../src/main/services/OrchestrationTaskBoard.ts";
import { OrchestrationTemplateService } from "../src/main/services/OrchestrationTemplateService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { OrchestrationGateway } from "../src/main/services/agent-browser/OrchestrationGateway.ts";
import { OrchestrationClient } from "../src/agent-browser/orchestration-helper.mjs";
import { SecretGrantService } from "../src/main/services/SecretGrantService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const position = { x: 0, y: 0 };
const PIPE_HOST = join(process.cwd(), "build", "windows-agent-pipe-host", "canvastty-windows-agent-pipe-host.exe");

test("authenticated orchestration gateway carries templates, routed review/retry, task dependencies, budgets, and secret grants end to end", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-backlog-integration-"));
  const project = join(root, "project");
  const storage = join(root, "host-state");
  await mkdir(project);
  const canonicalProject = await realpath(project);
  const calls = [];
  const writes = [];
  let terminals;
  let reviewerAnswerRecorded = false;
  const spawner = fakeSpawner(calls, {
    onWrite(data) {
      writes.push(data);
      if (!data.includes("Review only the supplied answer")) return;
      const reviewer = [...terminals.listMetadata()].reverse().find((session) => session.title.startsWith("Review:"));
      assert.ok(reviewer, "the review request reaches an actual read-only reviewer card");
      terminals.applyProviderSignal(reviewer.id, { state: "working" }, "hook");
      terminals.recordAnswer(reviewer.id, { text: JSON.stringify({ verdict: "accept", findings: "No issue." }), truncated: false });
      terminals.applyProviderSignal(reviewer.id, { state: "idle", event: "Stop" }, "hook");
      reviewerAnswerRecorded = true;
    }
  });
  terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, (...args) => {
    const process = spawner(...args);
    queueMicrotask(() => process.emitData("Ask anything…\nctrl+p commands"));
    return process;
  });
  // Automatic Plan reviews must exercise the isolated launch path; this stub records the
  // launch shape without weakening production's fail-closed requirement for a real OS layer.
  terminals.configureIsolation({
    containment: () => true,
    decide: ({ profile }) => profile === "plan"
      ? { apply: true, profile, isolation: { state: "on", layer: "seatbelt" } }
      : { apply: false, profile },
    wrap: (launch) => ({ command: launch.command, args: [...launch.args], env: launch.env, cleanup() {} })
  });
  t.after(() => { terminals.disposeAll(); });
  const budget = new OrchestrationBudgetService(join(storage, "budgets.json"));
  await budget.load();
  const control = new AgentControlService(terminals, {
    budget,
    waitTiming: { checkMs: 1, settleMs: 0, quietMs: 10 },
    reviewModel: () => "openai/gpt-4.1",
    reviewStartupMs: 100, // the fixture emits the real OpenCode home-screen readiness marker
    reviewDiff: async () => "diff --git a/example b/example\n+safe result\n"
  });
  terminals.configureInputGate((sessionId) => control.assertInputAllowed(sessionId));
  const routes = [];
  const taskBoard = new OrchestrationTaskBoard(storage);
  const templates = new OrchestrationTemplateService();
  const observedSecretRequests = [];
  const secretValue = "test-secret-value-for-integration";
  const secretGrants = new SecretGrantService({
    getSecret: async (id) => id === "OPENAI_API_KEY" ? secretValue : null,
    getSession: (sessionId) => {
      const session = terminals.getMetadata(sessionId);
      return session ? { provider: session.provider, cwd: session.cwd, profile: session.profile, active: session.exitCode === null } : null;
    },
    execute: async (request) => {
      observedSecretRequests.push({ secret: request.secret, cwd: request.cwd, launchProfile: request.launchProfile, apiProfile: request.apiProfile, method: request.method, path: request.path });
      return { status: 200, body: request.secret, truncated: false };
    },
    rememberSecret() {},
    redact: (text) => text.replaceAll(secretValue, "[MASKED]")
  });
  const providerModels = ["zai-coding-plan/glm-5.3-flash", "openai/gpt-4.1"];
  const providers = {
    cli: () => "available",
    limits: () => null,
    models: (provider) => provider === "opencode" ? { models: providerModels, checkedAt: Date.now() } : null,
    checkModel: async () => null
  };
  const handler = new ScopedOrchestrationHandler(control, null, providers, {
    router: { async route(request) {
      routes.push(request);
      return { candidateId: request.candidates.find((candidate) => candidate.model === providerModels[0]).id, reason: "Selected a listed OpenCode model." };
    } },
    taskBoard,
    budget,
    templates,
    secretGrants,
    onRouting: (sessionId, modelRoute) => terminals.setTaskMetadata(sessionId, { modelRoute }),
    onReview: (sessionId) => terminals.setTaskMetadata(sessionId, { reviewRequested: true })
  });
  const gateway = new OrchestrationGateway({ runtimeDirectory: join(root, "runtime"), handler, windowsHostPath: PIPE_HOST });
  await gateway.start();
  t.after(() => gateway.stop());
  t.after(() => rm(root, { recursive: true, force: true }));

  const orchestrator = terminals.create({ provider: "codex", profile: "normal", cwd: project, position, role: "orchestrator" });
  const capability = gateway.registerOrchestrator({ terminalSessionId: orchestrator.id });
  const client = new OrchestrationClient({ ...capability, address: gateway.address }, { connectTimeoutMs: 5_000, callTimeoutMs: 5_000 });
  t.after(() => client.close());
  await client.connect();

  const tools = await client.listTools();
  for (const name of ["spawn_agent", "retry_agent", "claim_task", "get_task_budget", "apply_orchestration_template", "request_secret", "run_secret_request"]) {
    assert.ok(tools.some((tool) => tool.name === name), `${name} is advertised by the authenticated gateway`);
  }

  const listedFlows = await client.call("list_orchestration_templates", {});
  assert.ok(listedFlows.templates.some((flow) => flow.id === "executor-reviewer"));
  const appliedFlow = await client.call("apply_orchestration_template", { templateId: "executor-reviewer", task: "Implement the task and verify it." });
  assert.match(appliedFlow.instructions, /Implement the task and verify it\./u);
  assert.match(appliedFlow.instructions, /Expected subagents: 2/u);

  const prerequisite = await taskBoard.addTask(project, orchestrator.id, orchestrator.id, { title: "Prepare interface" });
  const dependent = await taskBoard.addTask(project, orchestrator.id, orchestrator.id, { title: "Verify interface", dependencies: [prerequisite.id] });
  await assert.rejects(client.call("claim_task", { taskId: dependent.id }), /waiting for dependencies: Prepare interface/u);
  await client.call("complete_task", { taskId: prerequisite.id, result: "Interface is ready." });
  const claimed = await client.call("claim_task", { taskId: dependent.id });
  assert.equal(claimed.task.status, "claimed");
  assert.equal(claimed.task.ownerSessionId, orchestrator.id);

  const spawned = await client.call("spawn_agent", {
    provider: "opencode", cwd: project, model: "auto", prompt: "Implement the task and verify it.", title: "Integration worker", review: true
  });
  assert.equal(spawned.model, providerModels[0]);
  assert.equal(spawned.routing.source, "router");
  assert.equal(terminals.getMetadata(spawned.sessionId).modelRoute.source, "router");
  assert.equal(routes.length, 1);
  assert.equal(routes[0].candidates.some((candidate) => candidate.model === providerModels[0]), true);
  const workerProcess = calls.at(-1).process;
  terminals.applyProviderSignal(spawned.sessionId, { state: "working" }, "hook");
  terminals.recordAnswer(spawned.sessionId, { text: "Worker result.", truncated: false });
  terminals.applyProviderSignal(spawned.sessionId, { state: "idle", event: "Stop" }, "hook");
  workerProcess.emitData("worker failure tail for retry\r\n");
  await new Promise((resolve) => setTimeout(resolve, 20));
  workerProcess.emitExit(1);

  let waited = await client.call("wait_for_agent", { sessionId: spawned.sessionId, timeoutSeconds: 1 });
  assert.equal(waited.review.status, "pending", "the tool does not wait indefinitely for review");
  for (let i = 0; waited.review?.status === "pending" && i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    waited = await client.call("wait_for_agent", { sessionId: spawned.sessionId, timeoutSeconds: 1 });
  }
  assert.equal(waited.reason, "failed");
  assert.equal(waited.review.status, "accepted");
  assert.equal(reviewerAnswerRecorded, true);
  assert.equal(terminals.listMetadata().filter((session) => session.title.startsWith("Review:")).length, 1);
  const reviewer = terminals.listMetadata().find((session) => session.title.startsWith("Review:"));
  assert.ok(reviewer && control.isReadOnlyReviewer(reviewer.id));
  assert.deepEqual(handler.listTools(reviewer.id), []);

  const retried = await client.call("retry_agent", { sessionId: spawned.sessionId, reason: "The worker exited unexpectedly." });
  const retrySession = terminals.getMetadata(retried.sessionId);
  assert.equal(retried.provider, spawned.provider);
  assert.equal(retried.model, spawned.model);
  assert.equal(retrySession.cwd, canonicalProject);
  assert.equal(retrySession.profile, spawned.profile);
  assert.equal(calls.at(-1).options.cwd, canonicalProject);
  assert.ok(calls.at(-1).args.includes(spawned.model), "the retry command preserves the selected provider model");
  assert.match(writes.at(-1), /worker failure tail for retry/u);

  await budget.setLimits(orchestrator.id, { tokens: 1, costUsd: null, durationMs: null }, orchestrator.startedAt);
  budget.recordSessionUsage(orchestrator.id, orchestrator.id, { tokens: 1, costUsd: null }, {rootStartedAt:orchestrator.startedAt});
  const budgetView = await client.call("get_task_budget", {});
  assert.equal(budgetView.budget.paused, true);
  assert.throws(() => control.assertInputAllowed(orchestrator.id), /Budget reached/u);
  assert.equal(terminals.inputChecked(orchestrator.id, "blocked during budget pause"), false);
  await assert.rejects(client.call("send_to_agent", { sessionId: retried.sessionId, prompt: "This must not reach the agent." }), /Budget reached/u);
  assert.equal(terminals.getMetadata(orchestrator.id).exitCode, null, "the budget pause blocks input without killing the root PTY");
  await budget.clearLimits(orchestrator.id, orchestrator.startedAt);
  await budget.flush();
  const reloadedBoard = new OrchestrationTaskBoard(storage);
  const persistedTasks = await reloadedBoard.listTasks(project, orchestrator.id);
  assert.deepEqual(persistedTasks.tasks.map((task) => task.status), ["done", "claimed"]);
  const reloadedBudget = new OrchestrationBudgetService(join(storage, "budgets.json"));
  await reloadedBudget.load();
  assert.equal(reloadedBudget.snapshot(orchestrator.id, orchestrator.startedAt).limits.tokens, null);

  const request = await client.call("request_secret", { secretId: "OPENAI_API_KEY", reason: "Run a provider API diagnostic." });
  assert.equal(request.pendingApproval, true);
  assert.equal(request.request.secretId, "OPENAI_API_KEY");
  assert.equal(JSON.stringify(request).includes(secretValue), false);
  assert.equal(secretGrants.pending([orchestrator.id]).length, 1);
  secretGrants.approve(request.request.id, "10m");
  const secretResult = await client.call("run_secret_request", {
    secretId: "OPENAI_API_KEY", method: "GET", path: "models"
  });
  assert.deepEqual(secretResult, { status: 200, body: "[MASKED]", truncated: false });
  assert.equal(observedSecretRequests[0].secret, secretValue);
  assert.equal(observedSecretRequests[0].apiProfile.baseUrl, "https://api.openai.com/v1");
  assert.equal(observedSecretRequests[0].method, "GET");
  assert.equal(observedSecretRequests[0].path, "models");
  assert.equal(observedSecretRequests[0].cwd, terminals.getMetadata(orchestrator.id).cwd);
  assert.equal(JSON.stringify(secretResult).includes(secretValue), false);
  assert.equal(JSON.stringify(secretGrants.listGrants([orchestrator.id])).includes(secretValue), false);
});
