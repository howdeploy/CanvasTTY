import assert from "node:assert/strict";
import test from "node:test";
import { IpcReadinessGate } from "../src/main/ipc/IpcReadinessGate.ts";

// The renderer loads while the main-process services start: a call that arrives before its service must wait for
// it, never fail with "No handler registered" or reach an uninitialized service.

/** ipcMain as far as the gate uses it, with Electron's rule that a channel has at most one invoke handler. */
function fakeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handle(channel, listener) {
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
      handlers.set(channel, listener);
    },
    removeHandler(channel) { handlers.delete(channel); },
    on(channel, listener) { listeners.set(channel, [...(listeners.get(channel) ?? []), listener]); },
    removeListener(channel, listener) { listeners.set(channel, (listeners.get(channel) ?? []).filter((item) => item !== listener)); },
    async invoke(channel, ...args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler registered for '${channel}'`);
      return handler({ sender: "renderer" }, ...args);
    },
    send(channel, ...args) {
      const event = { sender: "renderer" };
      for (const listener of listeners.get(channel) ?? []) listener(event, ...args);
      return event;
    },
    listenerCount: (channel) => (listeners.get(channel) ?? []).length
  };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

test("an invoke that arrives before its service waits for the handler instead of failing", async () => {
  const ipc = fakeIpcMain();
  const gate = new IpcReadinessGate(ipc, { channels: ["terminal:list", "settings:get"] });
  let settled = false;
  const early = ipc.invoke("terminal:list", "arg").then((value) => { settled = true; return value; });
  await turn();
  assert.equal(settled, false, "the call waits while the terminal service is still starting");

  // The service group comes up and registers its handler through the gate (no "second handler" error).
  let seen = null;
  gate.handle("terminal:list", (event, arg) => { seen = { sender: event.sender, arg }; return ["restored"]; });
  assert.deepEqual(await early, ["restored"]);
  assert.deepEqual(seen, { sender: "renderer", arg: "arg" }, "the waiting call reaches the real handler with its own event");
  // Later calls go straight to the real handler.
  assert.deepEqual(await ipc.invoke("terminal:list"), ["restored"]);
  assert.deepEqual(gate.pendingChannels(), ["settings:get"]);
});

test("each service group releases only its own channels", async () => {
  const ipc = fakeIpcMain();
  const gate = new IpcReadinessGate(ipc, { channels: ["settings:get", "terminal:list"] });
  const settings = ipc.invoke("settings:get");
  let terminalsDone = false;
  const terminals = ipc.invoke("terminal:list").then(() => { terminalsDone = true; });
  gate.handle("settings:get", () => ({ locale: "en" }));
  assert.deepEqual(await settings, { locale: "en" });
  await turn();
  assert.equal(terminalsDone, false, "the critical group being up does not release the core group's channels");
  gate.handle("terminal:list", () => []);
  await terminals;
  assert.equal(terminalsDone, true);
});

test("fire-and-forget messages sent early are replayed in order to the real listener", () => {
  const ipc = fakeIpcMain();
  const gate = new IpcReadinessGate(ipc, { channels: ["terminal:input"] });
  ipc.send("terminal:input", "a", "1");
  ipc.send("terminal:input", "a", "2");
  const received = [];
  gate.on("terminal:input", (_event, id, data) => received.push(`${id}:${data}`));
  assert.deepEqual(received, ["a:1", "a:2"]);
  ipc.send("terminal:input", "a", "3");
  assert.deepEqual(received, ["a:1", "a:2", "a:3"]);
  assert.equal(ipc.listenerCount("terminal:input"), 1, "the placeholder is gone once the real listener exists");
});

test("synchronous sends are answered at once so the renderer never blocks on a service that is starting", () => {
  const ipc = fakeIpcMain();
  const gate = new IpcReadinessGate(ipc, { channels: ["canvas:owner-wheel"], syncReplies: { "canvas:owner-wheel": true } });
  const event = ipc.send("canvas:owner-wheel", { clientX: 1, clientY: 2 });
  assert.equal(event.returnValue, true);
  let real = 0;
  gate.on("canvas:owner-wheel", (replyEvent) => { real += 1; replyEvent.returnValue = "real"; });
  assert.equal(real, 0, "an already answered synchronous send is not replayed");
  assert.equal(ipc.send("canvas:owner-wheel", {}).returnValue, "real");
});

test("a failed startup rejects waiting and later calls with its error", async () => {
  const ipc = fakeIpcMain();
  const gate = new IpcReadinessGate(ipc, { channels: ["terminal:list"] });
  const early = ipc.invoke("terminal:list");
  gate.fail(new Error("gateway could not start"));
  await assert.rejects(early, /gateway could not start/);
  await assert.rejects(ipc.invoke("terminal:list"), /gateway could not start/);
});

test("settle removes placeholders nobody claimed, so they fail like an unregistered channel", async () => {
  const ipc = fakeIpcMain();
  const gate = new IpcReadinessGate(ipc, { channels: ["terminal:list", "window:state"] });
  gate.handle("terminal:list", () => []);
  const waiting = ipc.invoke("window:state");
  gate.settle();
  await assert.rejects(waiting, /No handler registered for 'window:state'/);
  await assert.rejects(ipc.invoke("window:state"), /No handler registered/);
  assert.deepEqual(await ipc.invoke("terminal:list"), []);
  assert.equal(ipc.listenerCount("window:state"), 0);
  // A group registered after settle (none today) still works.
  gate.handle("late:channel", () => "ok");
  assert.equal(await ipc.invoke("late:channel"), "ok");
});

test("queued early sends are bounded per channel", () => {
  const ipc = fakeIpcMain();
  const gate = new IpcReadinessGate(ipc, { channels: ["terminal:bounds"], maxQueuedPerChannel: 2 });
  for (const value of [1, 2, 3]) ipc.send("terminal:bounds", value);
  const received = [];
  gate.on("terminal:bounds", (_event, value) => received.push(value));
  assert.deepEqual(received, [2, 3], "the oldest are dropped past the bound");
});

test('internal Canvas capability adapter preserves handler validation and does not register a generic IPC bridge', async()=>{
  const ipc=fakeIpcMain(),gate=new IpcReadinessGate(ipc,{channels:['asset:read','asset:bounds']});
  const owner={sender:'owned-canvas',senderFrame:'owned-frame'};const seen=[];
  gate.handle('asset:read',(event,id)=>{assert.equal(event,owner);return {id};});
  gate.on('asset:bounds',(event,id,bounds)=>{assert.equal(event,owner);seen.push({id,bounds});});
  assert.deepEqual(await gate.invokeOwned('asset:read',owner,['shared-id']),{id:'shared-id'});
  await gate.invokeOwned('asset:bounds',owner,['shared-id',{x:10}]);assert.equal(seen.length,1);
  await assert.rejects(gate.invokeOwned('unregistered',owner,[]),/not ready/);
  await assert.rejects(ipc.invoke('invokeOwned','asset:read','shared-id'),/No handler/);
});
