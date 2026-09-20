import test from "node:test";
import assert from "node:assert/strict";
import * as sdk from "@evenrealities/even_hub_sdk";
import { HudBridge } from "../src/hud-bridge.mjs";

const flush = () => new Promise(setImmediate);
test("microphone OFF waits for the last display ACK before sending its command", async () => {
  const calls = [];
  let displayDone, micDone;
  const native = {
    createStartUpPageContainer: async () => 0,
    textContainerUpgrade: () => {
      calls.push("display");
      return new Promise((resolve) => {
        displayDone = resolve;
      });
    },
    audioControl: (on) => {
      calls.push("mic:" + on);
      return new Promise((resolve) => {
        micDone = resolve;
      });
    },
  };
  const hud = new HudBridge(native, sdk);
  await hud.startPage();
  const first = hud.render("first"),
    off = hud.microphone(false);
  await flush();
  assert.deepEqual(calls, ["display"]);
  displayDone(true);
  await first;
  await flush();
  assert.deepEqual(calls, ["display", "mic:false"]);
  await flush();
  assert.deepEqual(calls, ["display", "mic:false"]);
  micDone(true);
  assert.equal(await off, true);
  const next = hud.render("next");
  assert.deepEqual(calls, ["display", "mic:false", "display"]);
  displayDone(true);
  assert.equal(await next, true);
});

test("failed microphone calls preserve failure and release queued display updates", async () => {
  const frames = [];
  const native = {
    createStartUpPageContainer: async () => 0,
    textContainerUpgrade: async (p) => {
      frames.push(p.content);
      return true;
    },
    audioControl: async () => {
      throw new Error("device rejected");
    },
  };
  const hud = new HudBridge(native, sdk);
  await hud.startPage();
  const off = hud.microphone(false),
    frame = hud.render("navigation still works");
  await assert.rejects(off, /device rejected/);
  assert.equal(await frame, true);
  assert.deepEqual(frames, ["navigation still works"]);
});

test("display frames wait for an unsettled microphone ACK and resume afterwards", async () => {
  const calls = [];
  let acknowledge;
  const native = {
    createStartUpPageContainer: async () => 0,
    textContainerUpgrade: async (frame) => {
      calls.push("display:" + frame.content);
      return true;
    },
    audioControl: (on) => {
      calls.push("audio:" + on);
      return new Promise((resolve) => {
        acknowledge = resolve;
      });
    },
  };
  const hud = new HudBridge(native, sdk);
  await hud.startPage();
  const audio = hud.microphone(false);
  await flush();
  const frame = hud.render("Home");
  await flush();
  assert.deepEqual(calls, ["audio:false"]);
  acknowledge(true);
  assert.equal(await audio, true);
  assert.equal(await frame, true);
  assert.deepEqual(calls, ["audio:false", "display:Home"]);
});

test("queued microphone stop has priority over a pending frame", async () => {
  const calls = [];
  let acknowledgeOn;
  const native = {
    createStartUpPageContainer: async () => 0,
    textContainerUpgrade: async (frame) => {
      calls.push("display:" + frame.content);
      return true;
    },
    audioControl: (on) => {
      calls.push("audio:" + on);
      return on
        ? new Promise((resolve) => {
            acknowledgeOn = resolve;
          })
        : Promise.resolve(true);
    },
  };
  const hud = new HudBridge(native, sdk);
  await hud.startPage();
  const on = hud.microphone(true);
  await flush();
  const frame = hud.render("Recording stopped"),
    off = hud.microphone(false);
  acknowledgeOn(true);
  await Promise.all([on, off, frame]);
  assert.deepEqual(calls, [
    "audio:true",
    "audio:false",
    "display:Recording stopped",
  ]);
});

test("a released hold cancels an enable waiting for a display acknowledgement", async () => {
  let finish;
  let wanted = true;
  const calls = [];
  const native = {
    createStartUpPageContainer: async () => 0,
    textContainerUpgrade: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    audioControl: async () => {
      calls.push("microphone");
      return true;
    },
  };
  const hud = new HudBridge(native, sdk);
  await hud.startPage();
  const frame = hud.render("Preparing");
  const mic = hud.microphone(true, {
    canStart: () => wanted,
    onDispatch: () => calls.push("dispatched"),
  });
  wanted = false;
  finish(true);
  assert.equal(await frame, true);
  assert.equal(await mic, false);
  assert.deepEqual(calls, []);
});
