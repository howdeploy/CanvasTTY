import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserWorkspace } from "../src/main/services/browser/BrowserWorkspace.ts";

export const actor = (id) => ({ kind: "agent", agentId: id, connectionId: `connection-${id}`, provider: "codex", terminalSessionId: `terminal-${id}`, cwd: "/tmp" });
export function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

/** Tabs each in-memory card retains per user-data root, like BrowserStore does across restarts. */
const retained = new Map();

/** Builds a BrowserWorkspace on in-memory browser services; pass a `directory` to restart from its persisted state. */
export async function fixture(t, directory) {
  const root = directory ?? await mkdtemp(join(tmpdir(), "ctty-multi-test-"));
  const instances = new Map();
  const records = [];
  const states = [];
  const workspace = new BrowserWorkspace({
    userDataPath: root,
    audit: { append: async (input) => { records.push(input); return { ...input, hash: "hash", previousHash: null, sequence: records.length, version: 1 }; } },
    onState: (state) => states.push(state),
    createInstance(id, onState) {
      const key = `${root}\0${id}`;
      const prior = retained.get(key);
      const state = { browserId: id, tabs: structuredClone(prior?.tabs ?? []), activeTabId: prior?.activeTabId ?? null, visible: false, agents: [], downloads: [], pendingDialog: null };
      retained.set(key, state);
      let number = prior?.number ?? 0;
      const makeTab = (url = "https://fixture.test/") => {
        const tab = { id: `${id}-tab-${++number}`, browserId: id, url, title: "Fixture", documentRevision: 1, status: "ready" };
        state.number = number;
        state.tabs.push(tab); state.activeTabId = tab.id; return tab;
      };
      const service = {
        commands: [], gate: null, viewport: null, focused: false, disposed: false,
        ready: async () => {}, getState: () => structuredClone(state),
        async open(url) { state.visible = true; if (!state.tabs.length) makeTab(url); onState(state); return structuredClone(state); },
        async close() { state.visible = false; onState(state); }, async dispose() { service.disposed = true; },
        normalizeInput(value) { return value; },
        executeInWorkspace(...args) { return this.core.executeScoped(...args); },
        setViewport(bounds) { this.viewport = bounds; }, setInputFocused(value) { this.focused = value; }, focus() {},
        core: {
          async executeScoped(_actor, command) {
            service.commands.push(command);
            state.visible = true;
            if (service.gate) { service.gate.started?.resolve(); await service.gate.promise; }
            if (command.type === "browser_new_tab") makeTab(command.url);
            if (command.type === "browser_activate_tab") state.activeTabId = command.tabId;
            if (command.type === "browser_navigate") state.tabs.find((tab) => tab.id === command.tabId).url = command.url;
            if (command.type === "browser_close_tab") {
              state.tabs = state.tabs.filter((tab) => tab.id !== command.tabId);
              if (state.activeTabId === command.tabId) state.activeTabId = state.tabs.at(-1)?.id ?? null;
            }
            onState(state);
            return { data: structuredClone(state), tabId: state.activeTabId };
          },
          agentDisconnected() {}, agentHeartbeat() {}, agentCursor() {}
        }
      };
      instances.set(id, service); return service;
    }
  });
  await workspace.ready();
  t.after(() => workspace.dispose());
  let request = 0;
  const call = (who, type, params = {}) => workspace.execute(who, { type, requestId: `request-${++request}`, ...params });
  const create = async (who, params = {}) => {
    const result = await call(who, "browser_new_window", params);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return { browserId: result.data.browserId, tabId: result.data.activeTabId };
  };
  return { workspace, root, instances, records, states, call, create };
}
