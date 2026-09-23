import assert from "node:assert/strict";
import test from "node:test";
import { createWindowStateObserver, observeWindowState, readWindowState } from "../src/main/windowState.ts";

function windowStub({ maximized = false, fullScreen = false } = {}) {
  return {
    maximized,
    fullScreen,
    listeners: new Map(),
    isMaximized() { return this.maximized; },
    isFullScreen() { return this.fullScreen; },
    on(event, listener) {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
    },
    off(event, listener) { this.listeners.get(event)?.delete(listener); },
    listenerCount() { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); },
    emit(event) { for (const listener of this.listeners.get(event) ?? []) listener(); }
  };
}

test("reports platform and native window state", () => {
  const window = windowStub({ maximized: true, fullScreen: true });

  assert.deepEqual(readWindowState(window, "darwin"), {
    isMacOS: true,
    maximized: true,
    fullscreen: true
  });
  assert.deepEqual(readWindowState(null, "win32"), {
    isMacOS: false,
    maximized: false,
    fullscreen: false
  });
});

test("publishes native fullscreen changes", () => {
  const window = windowStub();
  const states = [];
  observeWindowState(window, (state) => states.push(state), "darwin");

  window.fullScreen = true;
  window.emit("enter-full-screen");
  window.fullScreen = false;
  window.emit("leave-full-screen");

  assert.deepEqual(states, [
    { isMacOS: true, maximized: false, fullscreen: true },
    { isMacOS: true, maximized: false, fullscreen: false }
  ]);
});

test("rebinds window state after close and reopen without leaking listeners", () => {
  const deliveries = [];
  const observe = createWindowStateObserver((window, state) => window.webContents.send("window:state", state), "darwin");
  const oldWindow = windowStub();
  oldWindow.webContents = { send() { assert.fail("closed window received a state update"); } };
  const newWindow = windowStub();
  newWindow.webContents = { sent: [], send(channel, state) { this.sent.push({ channel, state }); } };

  observe(oldWindow);
  assert.equal(oldWindow.listenerCount(), 4);
  observe(null);
  assert.equal(oldWindow.listenerCount(), 0);
  observe(newWindow);
  observe(newWindow);
  assert.equal(newWindow.listenerCount(), 4);

  newWindow.maximized = true;
  newWindow.emit("maximize");
  newWindow.fullScreen = true;
  newWindow.emit("enter-full-screen");
  deliveries.push(...newWindow.webContents.sent);

  assert.deepEqual(deliveries, [
    { channel: "window:state", state: { isMacOS: true, maximized: true, fullscreen: false } },
    { channel: "window:state", state: { isMacOS: true, maximized: true, fullscreen: true } }
  ]);
  assert.equal(oldWindow.listenerCount(), 0);
});
