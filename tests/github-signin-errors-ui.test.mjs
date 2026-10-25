// The GitHub sign-in buttons show localized outcomes; main-process error text (IPC prefix, HTTP codes) only goes to the log.
import assert from "node:assert/strict";
import test from "node:test";
import { findAll, importWithFakeReact, tick } from "./helpers/fake-react.mjs";

const section = await importWithFakeReact("src/renderer/src/features/plugins/PluginSettingsSection.tsx", "PluginSettingsSection");

function harness(t, locale, githubAuth) {
  const oldWindow = globalThis.window;
  const warnings = [];
  t.mock.method(console, "warn", (...args) => { warnings.push(args); });
  globalThis.window = { setTimeout, clearTimeout, canvasTTY: { githubAuth, appVersion: async () => "1.8.1" } };
  t.after(() => { section.__unmount(); globalThis.window = oldWindow; });
  section.__reset();
  const none = async () => ({});
  const props = { settings: { locale }, plugins: [], open: false, onPreviewPlugin: none, onInstallPlugin: none, onSearchPlugins: async () => [],
    onShowcasePlugins: async () => [], onFetchPluginIcons: none, onPreviewManifests: none, onOpenBrowser: none, onCheckPluginUpdates: none,
    onUpdatePlugin: none, onSetPluginModules: none, onSetPluginEnabled: none, onUninstallPlugin: none, onOpenPluginContribution: none };
  let tree;
  const render = () => { section.__flush(); tree = section.__render(section.PluginSettingsSection, props); return tree; };
  const settle = async () => { for (let i = 0; i < 6; i++) { render(); await tick(); } render(); };
  const button = (label) => findAll(tree, (node) => node.type === "button" && node.props?.children === label)[0];
  return { render, settle, button, warnings, tree: () => tree };
}

const ipcFailure = new Error("Error invoking remote method 'github-auth:start': Error: GitHub device flow failed with HTTP 404.");

test("a sign-in that cannot start shows the localized failure in the GitHub block and logs the details (ru)", async (t) => {
  const status = { configured: true, authorized: false, login: null, tokenExpiresAt: null, deviceFlowState: "idle" };
  const ui = harness(t, "ru", { status: async () => status, start: async () => { throw ipcFailure; } });
  await ui.settle();
  const signIn = ui.button("Войти в системном браузере");
  assert.ok(signIn, "the sign-in button");
  signIn.props.onClick();
  await ui.settle();
  const json = JSON.stringify(ui.tree());
  assert.match(json, /Не удалось завершить вход в GitHub/u);
  assert.doesNotMatch(json, /Error invoking|github-auth:start|HTTP 404/u);
  assert.ok(ui.warnings.some(([, reason]) => reason === ipcFailure), "the details are logged");
});

test("a build without an OAuth client shows its own line, not the raw error", async (t) => {
  let configured = true;
  const ui = harness(t, "en", {
    status: async () => ({ configured, authorized: false, login: null, tokenExpiresAt: null, deviceFlowState: "idle" }),
    start: async () => { configured = false; throw new Error("Error invoking remote method 'github-auth:start': Error: GitHub OAuth is not configured (missing client id)."); }
  });
  await ui.settle();
  ui.button("Sign in with the system browser").props.onClick();
  await ui.settle();
  const json = JSON.stringify(ui.tree());
  assert.match(json, /this build has no OAuth Client ID/u);
  assert.doesNotMatch(json, /Error invoking|missing client id/u);
});

test("a failed, denied or expired sign-in reads as an error; a cancelled one as a plain status line", async (t) => {
  const line = (tree, text) => findAll(tree, (node) => node.type === "p" && node.props?.children === text)[0];
  for (const [state, text, error] of [
    ["failed", "Не удалось завершить вход в GitHub. Можно попробовать снова.", true],
    ["denied", null, true],
    ["expired", null, true],
    ["cancelled", null, false]
  ]) {
    const ui = harness(t, "ru", { status: async () => ({ configured: true, authorized: false, login: null, tokenExpiresAt: null, deviceFlowState: state }) });
    await ui.settle();
    const notice = text ? line(ui.tree(), text)
      : findAll(ui.tree(), (node) => node.type === "p" && /plugin-github-unavailable|plugin-settings__error/u.test(node.props?.className ?? ""))[0];
    assert.ok(notice, state);
    assert.equal(notice.props.className, error ? "plugin-settings__error" : "plugin-github-unavailable", state);
    assert.equal(notice.props.role, error ? "alert" : "status", state);
  }
});
