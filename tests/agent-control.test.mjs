import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { controlRequest, parseArguments, runCli } from "../scripts/canvastty-control.mjs";
import xterm from "@xterm/headless";
import { AgentControlGateway, CONTROL_REFUSAL_MESSAGE, codexComposerReady } from "../src/main/services/agent-control/AgentControlGateway.ts";
import { IPC } from "../src/shared/contracts.ts";
import { PixelSkinPackRegistry } from "../src/main/services/PixelSkinPackRegistry.ts";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
import { TerminalManager, terminalEnvironment } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import {
  AGENT_RUNTIME_ENV,
  CAPTURE_ANSWER_ENV,
  CAPTURE_ANSWER_EXPIRES_AT_ENV,
  CAPTURE_RESULT_ENV,
  MAX_ANSWER_CHARS,
  MAX_RESULT_CHARS,
  MAX_RUNTIME_MESSAGE_BYTES
} from "../src/agent-runtime/runtime-protocol.mjs";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const localSocket = { skip: process.platform === "win32" ? "Unix socket tests; native Windows pipe relay has its own suite." : false };
const PROMPT = "\x1b[2J\x1b[H>_ OpenAI Codex\r\nmodel: test\r\npermissions: YOLO mode\r\n\r\n› Ask Codex to do anything";

function registry() {
  return { get: (provider) => ({ state: "available", provider, executable: "/resolved/codex", launcher: "native",
    environment: {}, checked: [] }), snapshot: () => ({}) };
}

async function fixture(t, gatewayOptions = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-control-test-")));
  const calls = [];
  let gateway;
  const terminals = new TerminalManager((channel, payload) => gateway?.observe(channel, payload), registry(), undefined, undefined, true,
    (command, args, options) => {
      let onData = () => {};
      let onExit = () => {};
      const pty = { write(text) { this.writes.push(text); }, writes: [], resize() {}, kill() {},
        onData(fn) { onData = fn; }, onExit(fn) { onExit = fn; },
        data(text) { onData(text); }, exit(code) { onExit({ exitCode: code }); } };
      calls.push({ command, args, options, pty });
      return pty;
    });
  let lifecycleEnabled = true;
  const pixelSkinPacks = new PixelSkinPackRegistry(root);
  await pixelSkinPacks.initialize();
  const settings = new SettingsStore(root, "en");
  await settings.load();
  let notifiedSettings = null;
  gateway = new AgentControlGateway({ userDataPath: root, terminals, pixelSkinPacks, settings,
    onSettingsChanged: (next) => { notifiedSettings = next; }, lifecycleEnabled: () => lifecycleEnabled, ...gatewayOptions });
  const connectionPath = await gateway.start();
  const clientPath = join(root, "client-a.json");
  t.after(async () => { await gateway.close(); await terminals.shutdown(); });
  const request = (method, params = {}, requestId = randomUUID(), client = clientPath) =>
    controlRequest({ connectionPath, clientPath: client, method, params, requestId });
  const create = (requestId) => request("create", { provider: "codex", profile: "yolo", cwd: root, title: "Owned worker" }, requestId);
  const signal = (id, state, turnId = "provider-turn", result) => {
    terminals.applyProviderSignal(id, { kind: "lifecycle", state });
    gateway.onSignal(id, { state, event: state === "working" ? "UserPromptSubmit" : "Stop", turnId,
      ...(result === undefined ? {} : { result }) });
  };
  const ready = async (id, pty = calls.at(-1).pty) => {
    pty.data(PROMPT);
    for (let i = 0; i < 30; i++) {
      if (codexComposerReady((await request("screen", { sessionId: id })).text)) return;
      await delay(5);
    }
    assert.fail("fixture composer not ready");
  };
  return { root, gateway, terminals, calls, connectionPath, clientPath, pixelSkinPacks, settings,
    get notifiedSettings() { return notifiedSettings; }, request, create, signal, ready,
    disableLifecycle() { lifecycleEnabled = false; } };
}

test("agent skin API lists and activates persistent themes", localSocket, async (t) => {
  const f = await fixture(t);
  assert.ok((await f.request("skin-list")).builtIn.includes("matrix"));
  assert.ok((await f.request("skin-list")).builtIn.includes("gothic-eclipse"));
  assert.equal((await f.request("skin-select", { skinId: "gothic-eclipse" })).activeId, "gothic-eclipse");
  const selected = await f.request("skin-select", { skinId: "matrix", detail: "minimal" });
  assert.equal(selected.activeId, "matrix");
  assert.equal(selected.detail, "minimal");
  assert.equal(f.notifiedSettings.terminalBorderSkin, "matrix");
  assert.equal((await f.request("skin-list")).activeId, "matrix");
  assert.equal((await new SettingsStore(f.root, "en").load()).terminalBorderSkin, "matrix");
  await assert.rejects(f.request("skin-select", { skinId: "pixel:missing" }), (error) => error.code === "INVALID_PARAMS");
});

test("agent ZIP import accepts per-level terminal openings from a JSON file", localSocket, async (t) => {
  const f = await fixture(t);
  const archivePath = join(f.root, "theme.zip");
  const aperturesPath = join(f.root, "apertures.json");
  const apertures = {
    minimal: { left: 10, right: 10, top: 16, bottom: 16 },
    detailed: { left: 14, right: 14, top: 18, bottom: 19 },
    master: { left: 15, right: 15, top: 21, bottom: 22 }
  };
  await writeFile(archivePath, "test ZIP placeholder");
  await writeFile(aperturesPath, JSON.stringify(apertures));
  let received;
  f.pixelSkinPacks.installZip = async (archive, name, openings) => {
    received = { archive: archive.toString(), name, apertures: openings };
    return { id: `pixel:${randomUUID()}`, name, aperture: apertures.detailed, apertures: openings };
  };
  const response = await runCli(["--connection", f.connectionPath, "--client-file", f.clientPath,
    "skin-install", "--archive", archivePath, "--name", "Agent theme", "--apertures", aperturesPath,
    "--activate", "--detail", "detailed"]);
  assert.deepEqual(received, { archive: "test ZIP placeholder", name: "Agent theme", apertures });
  assert.equal(response.result.pack.name, "Agent theme");
  assert.equal(f.notifiedSettings.terminalBorderSkin, response.result.pack.id);
  assert.equal(f.notifiedSettings.terminalSkinDetail, "detailed");
});

test("CLI creates native YOLO with requested directory/title, including concurrent replay", localSocket, async (t) => {
  const f = await fixture(t);
  const args = ["--connection", f.connectionPath, "--client-file", f.clientPath, "--request-id", "same-create",
    "create", "--cwd", f.root, "--title", "API worker", "--yolo"];
  const [a, b] = await Promise.all([runCli(args), runCli(args)]);
  assert.equal(a.result.session.id, b.result.session.id);
  assert.equal(f.calls.length, 1);
  assert.equal(a.result.session.provider, "codex");
  assert.equal(a.result.session.profile, "yolo");
  assert.equal(a.result.session.cwd, f.root);
  assert.equal(a.result.session.title, "API worker");
  assert.ok(f.calls[0].args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!f.calls[0].args.includes("read-only"));
  assert.equal(f.calls[0].options.cwd, f.root);
  const descriptor = JSON.parse(await readFile(f.connectionPath, "utf8"));
  assert.equal((await stat(descriptor.endpoint)).mode & 0o777, 0o600);
  assert.equal((await stat(descriptor.tokenFile)).mode & 0o777, 0o600);
  await assert.rejects(runCli([...args.slice(0, 6), "create", "--cwd", f.root, "--title", "Different"]),
    (e) => e.code === "REQUEST_CONFLICT");
  assert.equal(f.calls.length, 1);
});

test("request receipts are bounded without locking the gateway, and a refused request can be retried", localSocket, async (t) => {
  const f = await fixture(t, { maxReceipts: 3 });
  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(f.request("interrupt", { sessionId: `missing-${index}` }, `missing-${index}`), (e) => e.code === "SESSION_NOT_FOUND");
  }
  // Before: the fourth mutating request (successful or not) got LIMIT_REACHED until restart.
  const { session } = await f.create("create-after-limit");
  assert.equal((await f.create("create-after-limit")).session.id, session.id, "a recent receipt still replays");
  await f.ready(session.id);
  await f.request("send", { sessionId: session.id, text: "first" }, "send-first");
  f.signal(session.id, "working", "turn-one");
  await assert.rejects(f.request("send", { sessionId: session.id, text: "second" }, "send-second"), (e) => e.code === "BUSY");
  f.signal(session.id, "idle", "turn-one", { text: "done", truncated: false });
  // BUSY wrote nothing, so the same request id is performed on retry instead of replaying BUSY.
  const retried = await f.request("send", { sessionId: session.id, text: "second" }, "send-second");
  assert.equal(retried.sessionId, session.id);
  assert.equal(f.calls[0].pty.writes.length, 2);
});

test("a create whose controller setup fails closes the card instead of leaving it running unowned", localSocket, async (t) => {
  const f = await fixture(t);
  const geometry = f.terminals.geometry.bind(f.terminals);
  f.terminals.geometry = () => { throw new Error("no geometry"); };
  await assert.rejects(f.create("create-broken"));
  assert.equal(f.calls.length, 1, "the card was started");
  assert.deepEqual(f.terminals.listMetadata(), [], "and closed again");
  f.terminals.geometry = geometry;
  const { session } = await f.create("create-after-failure");
  assert.deepEqual(f.terminals.listMetadata().map((card) => card.id), [session.id]);
});

test("closing stops draining new PTY output instead of letting it grow the shutdown wait forever", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.create();
  await f.ready(session.id);

  let writes = 0;
  const original = xterm.Terminal.prototype.write;
  xterm.Terminal.prototype.write = function(data, callback) {
    writes += 1;
    return original.call(this, data, callback);
  };
  t.after(() => { xterm.Terminal.prototype.write = original; });

  const closePromise = f.gateway.close();
  const writesAtCloseStart = writes;
  // Output arriving after close() started must not keep extending the session's pending-write
  // chain: observe() is closing's own signal to stop accepting more of it.
  let offset = 0;
  for (let i = 0; i < 25; i += 1) {
    const chunk = `flood-${i}`;
    offset += chunk.length;
    f.gateway.observe(IPC.terminalData, { id: session.id, data: chunk, outputOffset: offset });
  }
  await closePromise;
  assert.equal(writes, writesAtCloseStart, "no write was queued for output observed after close() began");
});

test("a failed start leaves nothing listening, so the same gateway can start again", localSocket, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-control-start-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userDataPath = join(root, "user-data");
  await writeFile(userDataPath, "a file where the folder should be");
  const gateway = new AgentControlGateway({ userDataPath, terminals: {}, lifecycleEnabled: () => true });
  t.after(() => gateway.close());
  await assert.rejects(gateway.start());
  await rm(userDataPath);
  const connection = await gateway.start();
  const descriptor = JSON.parse(await readFile(connection, "utf8"));
  assert.equal((await stat(descriptor.endpoint)).isSocket(), true);
});

test("agent control brings the Windows pipe host back after it fails and republishes the endpoint", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-control-win-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transports = [];
  let restarted;
  const republished = new Promise((resolve) => { restarted = resolve; });
  const gateway = new AgentControlGateway({
    userDataPath: root, terminals: {}, lifecycleEnabled: () => true, platform: "win32", windowsHostPath: "C:\\fake\\host.exe",
    onTransportRestarted: (path) => restarted(path),
    windowsPipeHostFactory: () => {
      const transport = new EventEmitter();
      const index = transports.length;
      transport.start = async () => `\\\\.\\pipe\\canvastty-agent-${index}`;
      transport.close = async () => undefined;
      transports.push(transport);
      return transport;
    }
  });
  t.after(() => gateway.close());
  const connection = await gateway.start();
  assert.match(JSON.parse(await readFile(connection, "utf8")).endpoint, /agent-0$/);
  const grant = gateway.grantSession("orchestrator-one");
  assert.ok(grant);
  const before = JSON.parse(await readFile(grant, "utf8"));
  const token = await readFile(before.tokenFile, "utf8");
  const controllerPath = join(dirname(grant), "controller.json");
  const controller = await readFile(controllerPath, "utf8");
  const revoked = gateway.grantSession("orchestrator-closed");
  transports[0].emit("fatal", new Error("host exited"));
  assert.equal(gateway.grantSession("while-offline"), null, "no dead endpoint is handed out");
  gateway.revokeSession("orchestrator-closed");
  t.mock.timers.tick(500);
  assert.equal(await republished, connection);
  assert.match(JSON.parse(await readFile(connection, "utf8")).endpoint, /agent-1$/);
  const after = JSON.parse(await readFile(grant, "utf8"));
  assert.match(after.endpoint, /agent-1$/, "the same session descriptor follows the recovered host");
  assert.equal(after.scope, "session");
  assert.equal(after.tokenFile, before.tokenFile);
  assert.equal(await readFile(after.tokenFile, "utf8"), token);
  assert.equal(await readFile(controllerPath, "utf8"), controller);
  await assert.rejects(readFile(revoked), { code: "ENOENT" }, "revoked grants are not recreated");
  await gateway.close();
  transports[1].emit("fatal", new Error("late"));
  t.mock.timers.tick(10_000);
  assert.equal(transports.length, 2);
});

test("agent control keeps bringing a failing Windows pipe host back, less often, instead of giving up after three tries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-control-win-retry-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transports = [];
  let failing = true;
  let restarted;
  const republished = new Promise((resolve) => { restarted = resolve; });
  const gateway = new AgentControlGateway({
    userDataPath: root, terminals: {}, lifecycleEnabled: () => true, platform: "win32", windowsHostPath: "C:\\fake\\host.exe",
    onTransportRestarted: (path) => restarted(path),
    windowsPipeHostFactory: () => {
      const transport = new EventEmitter();
      const index = transports.length;
      transport.start = async () => {
        if (index > 0 && failing) throw new Error("pipe host did not start");
        return `\\\\.\\pipe\\canvastty-agent-${index}`;
      };
      transport.close = async () => undefined;
      transports.push(transport);
      return transport;
    }
  });
  t.after(() => gateway.close());
  const connection = await gateway.start();
  transports[0].emit("fatal", new Error("host exited"));
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
  for (let i = 0; i < 6; i++) {
    t.mock.timers.tick(60_000);
    await flush();
  }
  assert.ok(transports.length > 4, `${transports.length} starts: it did not give up after three`);
  failing = false;
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(await republished, connection);
});

test("controller cannot list, read, interrupt or send to other controllers or UI sessions", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.create();
  const clientB = join(f.root, "client-b.json");
  assert.deepEqual((await f.request("list", {}, undefined, clientB)).sessions, []);
  for (const method of ["status", "screen", "result", "interrupt", "send", "choose", "dismiss"]) {
    await assert.rejects(f.request(method, { sessionId: session.id, ...(method === "send" ? { text: "task" } : {}) }, undefined, clientB),
      (e) => e.code === "SESSION_NOT_FOUND");
  }
  const ui = f.terminals.create({ provider: "codex", profile: "normal", cwd: f.root, position: { x: 0, y: 0 } });
  await assert.rejects(f.request("status", { sessionId: ui.id }), (e) => e.code === "SESSION_NOT_FOUND");
});

test("literal prompt delivery, busy guard, result revisions and stale-result separation", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.create();
  await f.ready(session.id);
  const text = 'Check "$1" and $(literal text)\nsecond line';
  const first = await f.request("send", { sessionId: session.id, text }, "send-one");
  await f.request("send", { sessionId: session.id, text }, "send-one");
  assert.deepEqual(f.calls[0].pty.writes, [`\x1b[200~${text}\x1b[201~\r`]);
  assert.equal(first.resultRevisionBefore, 0);
  assert.equal((await f.request("result", { sessionId: session.id })).fresh, false);
  f.signal(session.id, "idle", "old-turn", { text: "stale", truncated: false });
  assert.equal((await f.request("result", { sessionId: session.id })).fresh, false);
  f.signal(session.id, "working", "native-one");
  await assert.rejects(f.request("send", { sessionId: session.id, text: "another" }), (e) => e.code === "BUSY");
  f.signal(session.id, "idle", "old-turn", { text: "stale", truncated: false });
  assert.equal((await f.request("result", { sessionId: session.id })).fresh, false);
  f.signal(session.id, "idle", "native-one", { text: "done-one", truncated: false });
  const result = await f.request("result", { sessionId: session.id, after: 0 });
  assert.equal(result.resultRevision, 1);
  assert.equal(result.turn.result.text, "done-one");
  assert.equal((await f.request("result", { sessionId: session.id, after: 1 })).fresh, false);
  await f.request("send", { sessionId: session.id, text: "next" }, "send-two");
  const old = await f.request("result", { sessionId: session.id, after: 0 });
  assert.equal(old.turn.id, "send-one");
  assert.equal(old.turn.state, "completed");
  assert.equal((await f.request("result", { sessionId: session.id, after: 1 })).fresh, false);
});

test("interrupt affects one owned turn and reports completion only after lifecycle confirmation", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.create();
  await f.ready(session.id);
  await f.request("send", { sessionId: session.id, text: "work" });
  f.signal(session.id, "working");
  const result = await f.request("interrupt", { sessionId: session.id }, "interrupt-one");
  await f.request("interrupt", { sessionId: session.id }, "interrupt-one");
  assert.equal(result.stopped, false);
  assert.equal(f.calls[0].pty.writes.filter((x) => x === "\x03").length, 1);
  assert.equal((await f.request("result", { sessionId: session.id })).fresh, false);
  f.signal(session.id, "idle");
  assert.equal((await f.request("result", { sessionId: session.id })).turn.state, "interrupted");
});

test("startup/trust/permission menus, slash commands and terminal escape input are not task submission", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.create();
  await assert.rejects(f.request("send", { sessionId: session.id, text: "task" }), (e) => e.code === "NOT_READY");
  await f.ready(session.id);
  for (const text of ["/permissions", "\x1b[2J", "abc\rdef", "\0", "x".repeat(16001)]) {
    await assert.rejects(f.request("send", { sessionId: session.id, text }), (e) => e.code === "INVALID_PARAMS");
  }
  assert.equal(f.calls[0].pty.writes.length, 0);
  assert.equal(codexComposerReady("Do you trust the contents\n› Ask Codex to do anything"), false);
  assert.equal(codexComposerReady("model: loading\n› Ask Codex to do anything"), false);
  assert.equal(codexComposerReady("› 1. Yes, continue\nPress enter to confirm"), false);
  assert.equal(codexComposerReady("› partially typed human text"), false);
});

test("explicit menu choices use the observed revision and deduplicate PTY input", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.create();
  const pty = f.calls[0].pty;
  const observe = async (text, expected) => {
    pty.data(text);
    for (let i = 0; i < 30; i++) {
      const current = await f.request("screen", { sessionId: session.id });
      if (current.text.includes(expected)) return current;
      await delay(5);
    }
    assert.fail("batched PTY output did not arrive");
  };
  const screen = await observe("\x1b[2J\x1b[HHooks need review\r\n› 1. Review hooks\r\n  2. Trust all and continue\r\n  3. Continue without hooks\r\nPress enter to confirm or esc to cancel", "Press enter");
  assert.equal(screen.interaction.selected, 1);
  assert.equal(screen.interaction.options[1].label, "Trust all and continue");
  await assert.rejects(f.request("send", { sessionId: session.id, text: "task" }), (e) => e.code === "NOT_READY");
  await assert.rejects(f.request("choose", { sessionId: session.id, choice: 2, revision: "old" }), (e) => e.code === "STALE_MENU");
  await assert.rejects(f.request("choose", { sessionId: session.id, choice: 4, revision: screen.revision }), (e) => e.code === "INVALID_PARAMS");
  const params = { sessionId: session.id, choice: 2, revision: screen.revision };
  await f.request("choose", params, "choose-once");
  await f.request("choose", params, "choose-once");
  assert.deepEqual(pty.writes, ["\x1b[B\r"]);
  const detail = await observe("\x1b[2J\x1b[HHooks\r\n6 hooks reviewed\r\nPress esc to close", "Press esc");
  await assert.rejects(f.request("dismiss", { sessionId: session.id, revision: screen.revision }), (e) => e.code === "STALE_MENU");
  await f.request("dismiss", { sessionId: session.id, revision: detail.revision }, "dismiss-once");
  await f.request("dismiss", { sessionId: session.id, revision: detail.revision }, "dismiss-once");
  assert.deepEqual(pty.writes, ["\x1b[B\r", "\x1b"]);
  await f.ready(session.id);
  const ready = await f.request("screen", { sessionId: session.id });
  await assert.rejects(f.request("dismiss", { sessionId: session.id, revision: ready.revision }), (e) => e.code === "NOT_MENU");
  await assert.rejects(f.request("choose", { sessionId: session.id, choice: 1, revision: ready.revision }), (e) => e.code === "STALE_MENU");
  assert.equal(pty.writes.length, 2);
});

test("invalid socket credentials cannot launch a native session", localSocket, async (t) => {
  const f = await fixture(t);
  const descriptor = JSON.parse(await readFile(f.connectionPath, "utf8"));
  const reply = await new Promise((resolveReply, reject) => {
    const socket = createConnection(descriptor.endpoint);
    socket.on("error", reject);
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("missing rejection")); });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\n")) { socket.destroy(); resolveReply(JSON.parse(buffer.trim())); }
    });
    socket.on("connect", () => socket.write(JSON.stringify({ v: 1, id: "unauthorized-create", instanceId: descriptor.instanceId,
      token: "0".repeat(64), controller: "1".repeat(64), method: "create",
      params: { provider: "codex", profile: "yolo", cwd: f.root } }) + "\n"));
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, "INVALID_REQUEST");
  assert.equal(reply.error.message, CONTROL_REFUSAL_MESSAGE);
  assert.equal(f.calls.length, 0);
});

/** Sends raw bytes to the control socket and collects everything until the gateway closes the connection. */
function rawExchange(endpoint, bytes) {
  return new Promise((resolveReply, reject) => {
    const socket = createConnection(endpoint);
    const chunks = [];
    socket.on("error", reject);
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("the gateway did not close the refused connection")); });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => { socket.destroy(); resolveReply(Buffer.concat(chunks).toString("utf8")); });
    socket.on("connect", () => socket.write(bytes));
  });
}

test("unauthenticated, garbage and HTTP requests get the same guidance and a closed connection", localSocket, async (t) => {
  const f = await fixture(t);
  const descriptor = JSON.parse(await readFile(f.connectionPath, "utf8"));
  const guessed = await rawExchange(descriptor.endpoint, JSON.stringify({ method: "list", params: {} }) + "\n");
  const garbage = await rawExchange(descriptor.endpoint, "hello?\n");
  for (const text of [guessed, garbage]) {
    const reply = JSON.parse(text.trim());
    assert.deepEqual(reply, { v: 1, ok: false, error: { code: "INVALID_REQUEST", message: CONTROL_REFUSAL_MESSAGE } });
  }
  const http = await rawExchange(descriptor.endpoint, "GET / HTTP/1.1\r\nHost: localhost\r\nUser-Agent: curl/8\r\nAccept: */*\r\n\r\n");
  const [head, body] = http.split("\r\n\r\n");
  assert.match(head, /^HTTP\/1\.1 403 Forbidden\r\n/u);
  assert.match(head, /\r\nConnection: close/u);
  assert.equal(Number(/Content-Length: (\d+)/u.exec(head)[1]), Buffer.byteLength(body));
  assert.equal(body, `${CONTROL_REFUSAL_MESSAGE}\n`);
  // The guidance names the way in and nothing about the protocol, the token or where anything lives.
  assert.match(CONTROL_REFUSAL_MESSAGE, /Orchestrator role/u);
  assert.match(CONTROL_REFUSAL_MESSAGE, /canvastty_agents tools/u);
  assert.match(CONTROL_REFUSAL_MESSAGE, /list_providers/u);
  assert.doesNotMatch(CONTROL_REFUSAL_MESSAGE, /token|instanceId|controller|\.sock|connection\.json|agent-control|ndjson|json/iu);
  assert.equal(f.calls.length, 0);
});

test("the token file is private (0600) in a private folder (0700), even under a loose umask or a loose folder", localSocket, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-control-hygiene-")));
  await mkdir(join(root, "agent-control"), { mode: 0o777 });
  await chmod(join(root, "agent-control"), 0o777);
  const previous = process.umask(0);
  const terminals = { create() { throw new Error("unused"); }, listMetadata: () => [], readBuffer() { throw new Error("unused"); },
    inputChecked: () => false, geometry: () => ({ cols: 80, rows: 24 }) };
  const gateway = new AgentControlGateway({ userDataPath: root, terminals, lifecycleEnabled: () => false });
  t.after(async () => { process.umask(previous); await gateway.close(); await rm(root, { recursive: true, force: true }); });
  let connectionPath;
  try { connectionPath = await gateway.start(); } finally { process.umask(previous); }
  const descriptor = JSON.parse(await readFile(connectionPath, "utf8"));
  assert.equal((await stat(join(root, "agent-control"))).mode & 0o777, 0o700);
  assert.equal((await stat(descriptor.tokenFile)).mode & 0o777, 0o600);
  assert.equal((await stat(connectionPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(descriptor.endpoint, ".."))).mode & 0o777, 0o700);
});

test("a control write waiting on terminal replay cannot reach a restarted session", localSocket, async (t) => {
  const held = [];
  const original = xterm.Terminal.prototype.write;
  xterm.Terminal.prototype.write = function(data, callback) {
    return original.call(this, data, () => { if (typeof callback === "function") held.push(callback); });
  };
  t.after(() => { xterm.Terminal.prototype.write = original; for (const callback of held) callback(); });
  const f = await fixture(t);
  const { session } = await f.create();
  const pending = f.request("send", { sessionId: session.id, text: "must not reach the new pty" });
  await delay(20);
  f.calls[0].pty.exit(1);
  f.terminals.restart(session.id);
  for (const callback of held.splice(0)) callback();
  await assert.rejects(pending, (error) => error.code === "STALE_SESSION");
  assert.equal(f.calls.at(-1).pty.writes.filter((text) => text.includes("must not reach")).length, 0);
});

test("YOLO persists across native restart/restore while stale control grants fail", localSocket, async (t) => {
  const f = await fixture(t);
  f.terminals.configureSessionPersistence(new TerminalSessionStore(f.root), "continue");
  const { session } = await f.create();
  f.calls[0].pty.exit(1);
  await delay(2);
  f.terminals.restart(session.id);
  assert.ok(f.calls[1].args.includes("--dangerously-bypass-approvals-and-sandbox"));
  await assert.rejects(f.request("status", { sessionId: session.id }), (e) => e.code === "STALE_SESSION");
  await f.terminals.shutdown();
  const restoredCalls = [];
  const restored = new TerminalManager(() => {}, registry(), undefined, undefined, true,
    (_command, args) => { restoredCalls.push(args); return { onData() {}, onExit() {}, kill() {}, write() {}, resize() {} }; });
  restored.configureSessionPersistence(new TerminalSessionStore(f.root), "continue");
  await restored.restorePersistedSessions();
  t.after(() => restored.shutdown());
  assert.ok(restoredCalls[0].includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.equal(restored.listMetadata()[0].profile, "yolo");
});

test("disabled lifecycle and invalid parameters fail before launching a process", localSocket, async (t) => {
  const f = await fixture(t);
  for (const extra of [{ provider: "terminal" }, { profile: "read-only" }, { cwd: "relative" }, { title: "x".repeat(81) }, { unexpected: true }]) {
    await assert.rejects(f.request("create", { provider: "codex", profile: "yolo", cwd: f.root, ...extra }), (e) => e.code === "INVALID_PARAMS");
  }
  f.disableLifecycle();
  await assert.rejects(f.create(), (e) => e.code === "LIFECYCLE_DISABLED");
  assert.equal(f.calls.length, 0);
});

test("every agent provider can be a worker, with Codex-only result capture and menus declared honestly", localSocket, async (t) => {
  const f = await fixture(t);
  const codex = await f.create();
  assert.deepEqual(codex.capabilities, { result: true, menus: true });
  assert.ok(f.calls.at(-1).args.includes("tui.animations=false"));

  const claude = await f.request("create", { provider: "claude", profile: "yolo", cwd: f.root, title: "Claude worker" });
  assert.deepEqual(claude.capabilities, { result: false, menus: false });
  assert.equal(claude.session.provider, "claude");
  assert.equal(claude.session.profile, "yolo");
  assert.equal(claude.session.role, "agent");
  assert.ok(!f.calls.at(-1).args.includes("tui.animations=false"));
  assert.equal(CAPTURE_RESULT_ENV in f.calls.at(-1).options.env, false);

  const listed = (await f.request("list")).sessions;
  assert.deepEqual(listed.map((s) => [s.provider, s.capabilities]),
    [["codex", { result: true, menus: true }], ["claude", { result: false, menus: false }]]);

  const pty = f.calls.at(-1).pty;
  pty.data("\x1b[2J\x1b[H› 1. Yes, proceed\r\n  2. No\r\nPress enter to confirm");
  let screen;
  for (let i = 0; i < 30 && !screen?.text.includes("Yes, proceed"); i++) {
    await delay(5);
    screen = await f.request("screen", { sessionId: claude.session.id });
  }
  assert.ok(screen.text.includes("Yes, proceed"), "fixture screen reached the observer");
  assert.equal(screen.interaction, null, "non-Codex menus are never parsed");
  await assert.rejects(f.request("choose", { sessionId: claude.session.id, choice: 1, revision: screen.revision }), (e) => e.code === "NOT_SUPPORTED");
  await assert.rejects(f.request("dismiss", { sessionId: claude.session.id, revision: screen.revision }), (e) => e.code === "NOT_SUPPORTED");

  // send needs only an idle/unavailable status without an active turn; the screen is the sole evidence.
  const sent = await f.request("send", { sessionId: claude.session.id, text: "summarise the repository" });
  assert.equal(sent.delivery, "written-to-pty");
  assert.ok(pty.writes.at(-1).includes("summarise the repository"));
  await assert.rejects(f.request("send", { sessionId: claude.session.id, text: "again" }), (e) => e.code === "BUSY");
  f.signal(claude.session.id, "working");
  f.signal(claude.session.id, "idle");
  const result = await f.request("result", { sessionId: claude.session.id });
  assert.equal(result.fresh, true);
  assert.equal(result.turn.state, "no_result");

  for (const provider of ["terminal", "shell", ""]) {
    await assert.rejects(f.request("create", { provider, profile: "yolo", cwd: f.root }), (e) => e.code === "INVALID_PARAMS");
  }
});

test("CLI rejects inapplicable flags and never sends malformed result revisions", async () => {
  assert.deepEqual(parseArguments(["create", "--cwd", "folder with spaces", "--yolo"]).options, { cwd: "folder with spaces", yolo: true });
  await assert.rejects(runCli(["status", "session", "--profile", "yolo"]), /does not apply/);
  await assert.rejects(runCli(["result", "session", "--after", "NaN"]), /non-negative integer/);
  await assert.rejects(runCli(["create", "--cwd", ".", "--profile", "normal", "--yolo"]), /Conflicting/);
  await assert.rejects(runCli(["send", "session", "--text", "one", "--prompt-file", "two"]), /exactly one/);
});

test("opt-in hook result capture is authenticated, bounded and absent for ordinary sessions", localSocket, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ctty-control-result-"));
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal: (id, signal) => signals.push({ id, signal }) });
  await gateway.start();
  t.after(() => gateway.close());
  async function hook(id, capture, leaseCapture, text, answer = false, leaseAnswer = false) {
    const grantExpiresAt = Date.now() + 60_000;
    const cap = gateway.registerSession(id, "codex", leaseCapture, leaseAnswer ? grantExpiresAt : undefined);
    const env = { ...process.env, [AGENT_RUNTIME_ENV.address]: cap.address,
      [AGENT_RUNTIME_ENV.terminalSessionId]: cap.terminalSessionId, [AGENT_RUNTIME_ENV.provider]: cap.provider,
      [AGENT_RUNTIME_ENV.capabilityToken]: cap.capabilityToken, [CAPTURE_RESULT_ENV]: capture ? "1" : "0",
      [CAPTURE_ANSWER_ENV]: answer ? "1" : "0",
      [CAPTURE_ANSWER_EXPIRES_AT_ENV]: answer ? String(grantExpiresAt) : "" };
    const child = spawn(process.execPath, [resolve("src/agent-runtime/hook-helper.mjs"), "idle", "Stop"], { env, stdio: ["pipe", "ignore", "pipe"] });
    child.stdin.end(JSON.stringify({ turn_id: "turn", last_assistant_message: text }));
    await new Promise((done, reject) => { child.on("error", reject); child.on("exit", (code) => code === 0 ? done() : reject(new Error("Hook failed"))); });
  }
  await hook("normal", false, false, "private ordinary response");
  assert.equal(signals[0].signal.result, undefined);
  assert.equal(signals[0].signal.lastAssistantMessage, undefined);
  assert.equal(JSON.stringify(signals).includes("private ordinary response"), false);
  await hook("controlled", true, true, "x".repeat(MAX_RESULT_CHARS + 100));
  assert.equal(signals[1].signal.result.text.length, MAX_RESULT_CHARS);
  assert.equal(signals[1].signal.result.truncated, true);
  await hook("not-authorized", true, false, "must not arrive");
  assert.equal(signals.length, 2);
  assert.equal(terminalEnvironment({ [CAPTURE_RESULT_ENV]: "1", PATH: "/bin" })[CAPTURE_RESULT_ENV], undefined);
  assert.equal(terminalEnvironment({ [CAPTURE_ANSWER_ENV]: "1", PATH: "/bin" })[CAPTURE_ANSWER_ENV], undefined);

  // A Stop payload larger than the wire cap still reports the turn for an ordinary session.
  await hook("large", false, false, "z".repeat(MAX_RUNTIME_MESSAGE_BYTES + 1024));
  assert.equal(signals[2].signal.turnId, "turn");
  assert.equal(signals[2].signal.result, undefined);
  assert.equal(signals[2].signal.lastAssistantMessage, undefined);

  // Companion answer capture is a separate opt-in: bounded, and refused without its lease grant.
  await hook("companion", false, false, "y".repeat(MAX_ANSWER_CHARS + 5), true, true);
  assert.equal(signals[3].signal.result, undefined);
  assert.equal(signals[3].signal.lastAssistantMessage.length, MAX_ANSWER_CHARS);
  assert.equal(gateway.currentStatus("companion"), "idle");
  await hook("companion-unauthorized", false, false, "must not arrive either", true, false);
  assert.equal(signals.length, 5);
  assert.equal(signals[4].signal.lastAssistantMessage, undefined);
  assert.equal(JSON.stringify(signals[4]).includes("must not arrive either"), false);
});

const writes = new Map();

function serviceFixture() {
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls, { onWrite: (data, options) => writes.set(options?.name ?? calls.length, [...(writes.get(options?.name ?? calls.length) ?? []), data]) }));
  const control = new AgentControlService(terminals);
  return { calls, terminals, control };
}

test("spawn creates a subagent next to its parent and delivers the initial prompt", async () => {
  const { terminals, control } = serviceFixture();
  const parent = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 100, y: 100 }
  });
  const child = await control.spawn({
    parentSessionId: parent.id,
    provider: "cursor",
    cwd: process.cwd(),
    initialPrompt: "Fix the failing Button test"
  });

  assert.equal(child.role, "subagent");
  assert.equal(child.parentSessionId, parent.id);
  assert.equal(child.provider, "cursor");
  assert.ok(child.position.x > parent.position.x);
  assert.ok(child.position.y > parent.position.y);

  const sent = [...writes.values()].flat().join("");
  assert.match(sent, /Fix the failing Button test\r/u);
  terminals.disposeAll();
});

test("children lists only that parent's subagents in spawn order", () => {
  const { terminals, control } = serviceFixture();
  const parent = terminals.create({
    provider: "claude",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  control.spawn({ parentSessionId: parent.id, provider: "cursor", cwd: process.cwd() });
  control.spawn({ parentSessionId: parent.id, provider: "minimax", cwd: process.cwd() });

  const other = terminals.create({
    provider: "claude",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 500, y: 500 }
  });
  control.spawn({ parentSessionId: other.id, provider: "devin", cwd: process.cwd() });

  assert.deepEqual(control.children(parent.id).map((session) => session.provider), ["cursor", "minimax"]);
  assert.deepEqual(control.children(other.id).map((session) => session.provider), ["devin"]);
  terminals.disposeAll();
});

test("send appends submit unless told otherwise and rejects exited sessions", async () => {
  const { terminals, control } = serviceFixture();
  const parent = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  const child = await control.spawn({ parentSessionId: parent.id, provider: "qwen", cwd: process.cwd() });
  await control.send(child.id, "run the tests");
  await control.send(child.id, " --quiet", false);

  const sent = [...writes.values()].flat().join("");
  assert.match(sent, /run the tests\r --quiet/u);
  terminals.disposeAll();
});

test("observe returns a capped terminal tail and result reflects exit state", () => {
  const { terminals, control } = serviceFixture();
  const parent = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  const observation = control.observe(parent.id);
  assert.equal(observation.sessionId, parent.id);
  assert.equal(observation.output.length <= 8_192, true);

  const running = control.result(parent.id);
  assert.equal(running.state, "running");
  assert.equal(running.exitCode, null);
  terminals.disposeAll();
});

test("cancel disposes the subagent and plain terminals are not agents", async () => {
  const { terminals, control } = serviceFixture();
  const parent = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  const terminal = terminals.create({
    provider: "terminal",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  const child = await control.spawn({ parentSessionId: parent.id, provider: "pi", cwd: process.cwd() });
  control.cancel(child.id);
  assert.equal(terminals.list().some((session) => session.id === child.id), false);

  assert.throws(() => control.send(terminal.id, "text"), /not agents/u);
  assert.throws(() => control.observe(terminal.id), /not agents/u);
  assert.throws(() => control.result(terminal.id), /not agents/u);
  terminals.disposeAll();
});

test("a parent cannot exceed the person's live-subagent limit, nor the card cap", () => {
  const { terminals, control } = serviceFixture();
  const parent = terminals.create({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  for (let index = 0; index < 8; index += 1) control.spawn({ parentSessionId: parent.id, provider: "omp", cwd: process.cwd() });
  assert.throws(() => control.spawn({ parentSessionId: parent.id, provider: "omp", cwd: process.cwd() }),
    /already runs 8 live subagents, its limit \(Settings → Agents/u);
  terminals.disposeAll();

  const wide = new AgentControlService(terminals, { limits: () => ({ maxDepth: 2, maxSubagents: 32 }) });
  const other = terminals.create({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  for (let index = 0; index < 16; index += 1) wide.spawn({ parentSessionId: other.id, provider: "omp", cwd: process.cwd() });
  assert.throws(() => wide.spawn({ parentSessionId: other.id, provider: "omp", cwd: process.cwd() }), /16 subagent cards/u);
  terminals.disposeAll();
});

test("the control CLI screen masks a custom secret the viewport's top edge cuts", localSocket, async (t) => {
  const { SecretRedactionRegistry } = await import("../src/main/services/safety/SecretRedaction.ts");
  const secret = "purple-otter-marmalade-sings-loudly";
  const f = await fixture(t);
  const registry = new SecretRedactionRegistry();
  registry.add("plugin:p.custom", [secret]);
  f.terminals.configureRedaction(registry);
  const { session } = await f.create();
  const { cols, rows } = f.terminals.geometry(session.id);
  // The secret wraps: its head ends one row, its tail starts the next; that next row is the viewport's first.
  const pty = f.calls.at(-1).pty;
  pty.data(`${"a".repeat(cols - 10)}${secret}\r\n${Array.from({ length: rows - 1 }, (_value, index) => `line ${index}`).join("\r\n")}`);
  let text = "";
  for (let i = 0; i < 50 && !text.includes(`line ${rows - 2}`); i++) {
    await delay(10);
    ({ text } = await f.request("screen", { sessionId: session.id }));
  }
  assert.ok(text.includes(`line ${rows - 2}`) && text.split("\n").length <= rows, "the screen is the current viewport");
  assert.equal(text.includes(secret.slice(10)), false, "the tail on the top row is masked");
  assert.equal(/marmalade|loudly/u.test(text), false);
  assert.match(text, /<redacted:secret>/u, "masked where it stood, as one value");
});

test("an orchestrator tool call looks its sessions up by id: no other card's scrollback is copied", async () => {
  const { terminals, control } = serviceFixture();
  const parent = terminals.create({ provider: "claude", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  const child = await control.spawn({ parentSessionId: parent.id, provider: "codex", cwd: process.cwd() });
  const bystanders = Array.from({ length: 5 }, () => terminals.create({ provider: "claude", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } }));
  assert.equal(bystanders.length, 5);
  const copied = [];
  const list = terminals.list.bind(terminals);
  const readBuffer = terminals.readBuffer.bind(terminals);
  terminals.list = () => { copied.push("list"); return list(); };
  terminals.readBuffer = (id) => { copied.push(id); return readBuffer(id); };

  // What observe_agent, get_agent_result, list_agents and the ownership check do.
  assert.equal(control.status(child.id).id, child.id);
  assert.equal(control.isInSubtree(parent.id, child.id), true);
  assert.deepEqual(control.children(parent.id).map((session) => session.id), [child.id]);
  control.observe(child.id);
  control.result(child.id);
  assert.throws(() => control.status("missing"), /does not exist/u);

  assert.deepEqual(copied, [child.id, child.id], "only the observed card's own scrollback is read, and no list() snapshot of every card");
  terminals.disposeAll();
});

test("the providers command lists what CanvasTTY can create and an unknown provider points to it", localSocket, async (t) => {
  const f = await fixture(t, { providers: () => ({ providers: [{ id: "opencode", name: "OpenCode", installed: true, available: true,
    signIn: "unknown", subagent: true, orchestrator: true }], note: "n" }) });
  const listed = await f.request("providers");
  assert.deepEqual(listed.providers.map((entry) => entry.id), ["opencode"]);
  await assert.rejects(f.request("providers", { extra: 1 }), (e) => e.code === "INVALID_PARAMS");
  await assert.rejects(f.request("create", { provider: "glm", profile: "yolo", cwd: f.root }),
    (e) => e.code === "INVALID_PARAMS" && /providers command/u.test(e.message) && /opencode/u.test(e.message));
  const cli = await runCli(["--connection", f.connectionPath, "--client-file", f.clientPath, "providers"]);
  assert.equal(cli.result.providers[0].id, "opencode");
  await assert.rejects(runCli(["providers", "extra"]), /Unexpected or missing positional/u);
});

test("create passes a model and effort to the worker's CLI and refuses ones it cannot take", localSocket, async (t) => {
  const f = await fixture(t);
  const cli = await runCli(["--connection", f.connectionPath, "--client-file", f.clientPath, "create", "--cwd", f.root,
    "--model", "gpt-5.5", "--effort", "high"]);
  assert.equal(cli.result.session.model, "gpt-5.5");
  assert.equal(cli.result.session.effort, "high");
  const args = f.calls.at(-1).args;
  assert.ok(args.includes("--model") && args.includes("gpt-5.5"));
  assert.ok(args.includes("model_reasoning_effort=\"high\""));
  await assert.rejects(f.request("create", { provider: "codex", profile: "yolo", cwd: f.root, effort: "max" }),
    (e) => e.code === "INVALID_PARAMS" && /codex takes effort/u.test(e.message) && /providers command/u.test(e.message));
  await assert.rejects(f.request("create", { provider: "opencode", profile: "yolo", cwd: f.root, model: "glm" }),
    (e) => e.code === "INVALID_PARAMS" && /provider\/model/u.test(e.message));
});

test("create refuses a model the worker's CLI does not list, naming the closest", localSocket, async (t) => {
  const f = await fixture(t, { checkModel: async (provider, model) => provider === "opencode" && model !== "zai/glm-5.3-flash"
    ? "opencode does not list the model \"nosuch/model\". Closest: zai/glm-5.3-flash. Call list_providers for the models it lists." : null });
  const before = f.calls.length;
  await assert.rejects(f.request("create", { provider: "opencode", profile: "yolo", cwd: f.root, model: "nosuch/model" }),
    (e) => e.code === "INVALID_PARAMS" && /does not list the model/u.test(e.message) && /Run the providers command/u.test(e.message));
  assert.equal(f.calls.length, before);
});

test("the control CLI reads a connection's scope as the person's only when there is no connection file", { skip: process.platform === "win32" }, async (t) => {
  const { connectionScope } = await import("../scripts/canvastty-control.mjs");
  const folder = await mkdtemp(join(tmpdir(), "canvastty-control-scope-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  assert.equal(await connectionScope(join(folder, "missing.json")), "person");
  const path = join(folder, "connection.json");
  await writeFile(path, JSON.stringify({ scope: "session" }), { mode: 0o600 });
  assert.equal(await connectionScope(path), "session");
  // A read that fails for another reason is that error, never a guess that turns a subagent into a YOLO person launch.
  await chmod(path, 0o000);
  try {
    await assert.rejects(connectionScope(path), /EACCES|permission/iu);
  } finally {
    await chmod(path, 0o600);
  }
});

test("native control never sends into a draft after a historical suggestion", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.create();
  f.calls.at(-1).pty.data(PROMPT + "\r\n• reply\r\n\r\n› unfinished personal draft");
  for (let i = 0; i < 30; i++) {
    if ((await f.request("screen", { sessionId: session.id })).text.includes("unfinished personal draft")) break;
    await delay(5);
  }
  await assert.rejects(f.request("send", { sessionId: session.id, text: "task" }), (e) => e.code === "NOT_READY");
  assert.deepEqual(f.calls.at(-1).pty.writes, []);
});

test("native control handles soft-wrapped and dim clipped placeholders", localSocket, async (t) => {
  const f = await fixture(t);
  for (const clipped of [false, true]) {
    const { session } = await f.create();
    f.terminals.resize(session.id, 20, 24);
    const suggestion = "Check recently modified functions for compatibility";
    f.calls.at(-1).pty.data(`\x1b[2J\x1b[H› ${clipped ? "\x1b[2m" + suggestion.slice(0, 18) : suggestion}\x1b[0m\r\n`);
    for (let i = 0; i < 30; i++) {
      if ((await f.request("screen", { sessionId: session.id })).text.includes("Check recently")) break;
      await delay(5);
    }
    await f.request("send", { sessionId: session.id, text: "task" });
    assert.deepEqual(f.calls.at(-1).pty.writes, ["\x1b[200~task\x1b[201~\r"]);
  }
});
