import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { findAll, importWithFakeReact, tick } from "./helpers/fake-react.mjs";

const settingsPanelPath = new URL("../src/renderer/src/features/settings/SettingsPanel.tsx", import.meta.url);
const updatesPath = new URL("../src/renderer/src/features/settings/UpdateSettings.tsx", import.meta.url);
const appStylesPath = new URL("../src/renderer/src/styles/app.css", import.meta.url);

const { UpdatesSettings, __render, __flush, __reset, __unmount, __pending } = await importWithFakeReact(
  "src/renderer/src/features/settings/UpdatesSettings.tsx", "UpdatesSettings"
);

function content(node) {
  if (Array.isArray(node)) return node.map(content).join("");
  if (node && typeof node === "object") return content(node.props?.children);
  return node == null || typeof node === "boolean" ? "" : String(node);
}

function updates(t, actionResult = () => Promise.resolve()) {
  const previousWindow = globalThis.window;
  const initial = Promise.withResolvers();
  const version = Promise.withResolvers();
  const calls = [];
  let listener;
  let unsubscribed = 0;
  globalThis.window = { canvasTTY: {
    appVersion: () => version.promise,
    update: {
      status: () => initial.promise,
      onStatus: (callback) => { listener = callback; return () => { unsubscribed++; }; },
      check: () => { calls.push(["check"]); return actionResult(); },
      download: () => { calls.push(["download"]); return actionResult(); },
      install: () => { calls.push(["install"]); return actionResult(); }
    },
    external: { openUrl: (url) => { calls.push(["openUrl", url]); return actionResult(); } }
  } };
  __reset();
  const props = { locale: "en" };
  let tree = __render(UpdatesSettings, props);
  const render = () => { __flush(); tree = __render(UpdatesSettings, props); return tree; };
  t.after(() => { __unmount(); globalThis.window = previousWindow; });
  return {
    calls, initial, version, props, render,
    deliver: (status) => listener(status),
    emit(status) { listener(status); return render(); },
    unmount: __unmount,
    get unsubscribed() { return unsubscribed; },
    get tree() { return tree; },
    button: (label) => findAll(tree, (node) => node.type === "button" && content(node) === label)[0]
  };
}

test("the current Updates component renders its status matrix and gates install and download", async (t) => {
  const view = updates(t);
  view.version.resolve("1.8.5");
  await tick();
  view.render();
  assert.match(content(view.tree), /Current version: 1\.8\.5/);
  for (const [status, message, checkDisabled, extra] of [
    [{ type: "idle" }, "CanvasTTY updates", false, []],
    [{ type: "checking" }, "Checking for updates…", true, []],
    [{ type: "upToDate" }, "You have the latest version.", false, []],
    [{ type: "available", version: "1.9.0", notes: "Release notes" }, "Available version: 1.9.0Release notes", false, ["Download"]],
    [{ type: "available", version: "1.9.0", manualUrl: "https://example.invalid/release" }, "Available version: 1.9.0", false, ["Open release"]],
    [{ type: "downloading", percent: 42.4 }, "Downloading… 42%", true, []],
    [{ type: "downloading" }, "Downloading…", true, []],
    [{ type: "ready", version: "1.9.0" }, "Version 1.9.0 is ready to install.", true, ["Restart to update"]],
    [{ type: "installing" }, "Installing update…", true, []],
    [{ type: "error", message: "offline" }, "Update error: offline", false, []]
  ]) {
    view.emit(status);
    assert.ok(content(view.tree).includes(message), status.type);
    assert.deepEqual(findAll(view.tree, (node) => node.type === "button").map(content), ["Check for updates", ...extra]);
    assert.equal(view.button("Check for updates").props.disabled, checkDisabled);
    if (status.type === "idle") {
      assert.deepEqual(findAll(view.tree, (node) => node.type === "p").map(content), ["Current version: 1.8.5"]);
    }
    const progress = findAll(view.tree, (node) => node.type === "progress");
    assert.equal(progress.length, status.type === "downloading" ? 1 : 0);
    if (status.type === "downloading") {
      assert.equal(progress[0].props.max, 100);
      assert.equal(progress[0].props.value, status.percent);
      if (status.percent === undefined) assert.doesNotMatch(content(view.tree), /\d+%/);
    }
  }
  view.props.locale = "ru";
  view.emit({ type: "error", message: "Нет соединения" });
  assert.match(content(view.tree), /Ошибка обновления: Нет соединения/);
  view.emit({ type: "ready", version: "1.9.0" });
  assert.ok(view.button("Установить и перезапустить"));
  assert.deepEqual(view.calls, [], "status changes never download or install implicitly");
});

test("the current Updates buttons invoke distinct check, download, manual-link and install actions", async (t) => {
  const view = updates(t);
  view.initial.resolve({ type: "upToDate" });
  await tick();
  view.render();
  assert.match(content(view.tree), /You have the latest version\./, "initial status is used before any event");
  view.button("Check for updates").props.onClick();
  view.emit({ type: "available", version: "1.9.0" });
  view.button("Download").props.onClick();
  assert.equal(view.button("Restart to update"), undefined);
  view.emit({ type: "available", version: "1.9.0", manualUrl: "https://example.invalid/release" });
  assert.equal(view.button("Download"), undefined);
  view.button("Open release").props.onClick();
  view.emit({ type: "ready", version: "1.9.0" });
  view.button("Restart to update").props.onClick();
  await tick();
  assert.deepEqual(view.calls, [["check"], ["download"], ["openUrl", "https://example.invalid/release"], ["install"]]);
});

test("Updates status events beat a late initial reply and unmount unsubscribes and ignores late callbacks", async (t) => {
  const view = updates(t);
  view.emit({ type: "ready", version: "1.9.0" });
  view.initial.resolve({ type: "idle" });
  await tick();
  view.render();
  assert.ok(view.button("Restart to update"), "a stale initial reply cannot replace a newer event");
  assert.equal(view.unsubscribed, 0);
  view.unmount();
  assert.equal(view.unsubscribed, 1);
  view.version.resolve("late version");
  // Exercise the captured callback even if a transport delivers one after unsubscribe.
  view.deliver({ type: "error", message: "late event" });
  await tick();
  assert.equal(__pending(), 0);
});

test("Updates observes rejected actions without inventing success or losing the current status", async (t) => {
  let rejection;
  const view = updates(t, () => {
    rejection = Promise.withResolvers();
    return rejection.promise;
  });
  const expectedCalls = [];
  for (const [status, label, expectedCall, message] of [
    [{ type: "idle" }, "Check for updates", ["check"], "CanvasTTY updates"],
    [{ type: "available", version: "1.9.0" }, "Download", ["download"], "Available version: 1.9.0"],
    [{ type: "available", version: "1.9.0", manualUrl: "https://example.invalid/release" }, "Open release",
      ["openUrl", "https://example.invalid/release"], "Available version: 1.9.0"],
    [{ type: "ready", version: "1.9.0" }, "Restart to update", ["install"], "Version 1.9.0 is ready to install."]
  ]) {
    view.emit(status);
    const before = content(view.tree);
    assert.ok(before.includes(message));
    view.button(label).props.onClick();
    expectedCalls.push(expectedCall);
    assert.deepEqual(view.calls, expectedCalls);
    // No test-side rejection handler: a missing UI handler must surface to node:test while this case is active.
    rejection.reject(new Error("action failed"));
    await tick();
    view.render();
    assert.ok(view.button(label));
    assert.equal(content(view.tree), before, "failure must not invent success or reset the current status");
    assert.equal(view.button("Check for updates").props.disabled, status.type === "ready");
    assert.equal(findAll(view.tree, (node) => node.props.role === "alert").length, 0);
  }
});

test("Updates is its own top-level section directly above About, and General no longer hosts the row", async () => {
  const [panel, updates] = await Promise.all([
    readFile(settingsPanelPath, "utf8"),
    readFile(updatesPath, "utf8")
  ]);

  const sections = panel.match(/const SETTINGS_SECTIONS[\s\S]*?\];/)[0];
  const ids = [...sections.matchAll(/\{ id: "([a-z]+)"/g)].map((match) => match[1]);
  assert.equal(ids.at(-1), "about");
  assert.equal(ids.at(-2), "updates");
  assert.match(panel, /section === "updates" && \(\s*<UpdatesSettings locale=\{locale\} \/>/);
  assert.doesNotMatch(panel, /UpdaterRow|settings-update-row/);

  // The update section owns its status subscription and explicit actions.
  assert.match(updates, /window\.canvasTTY\.update\.onStatus\(/);
  assert.match(updates, /window\.canvasTTY\.update\.status\(\)/);
  assert.match(updates, /invoke\(window\.canvasTTY\.update\.check\)/);
  assert.match(updates, /invoke\(window\.canvasTTY\.update\.download\)/);
  assert.match(updates, /invoke\(window\.canvasTTY\.update\.install\)/);

  // Explicit actions: Download and Install are separate buttons, each gated by the presentation.
  assert.match(updates, /status\.type === "available"/);
  assert.match(updates, /status\.type === "ready"/);
  assert.match(updates, /status\.type === "downloading" && <>[\s\S]*?<progress max=\{100\} value=\{status\.percent\}/);
});

test("the Updates layout keeps the icon, status and actions on one grid", async () => {
  const styles = await readFile(appStylesPath, "utf8");
  assert.doesNotMatch(styles, /\.settings-update-row/);
  assert.match(styles, /\.settings-updates__card \{[^}]*display: grid;[^}]*grid-template-columns: 2\.3em minmax\(0, 1fr\) auto;/);
  assert.match(styles, /\.settings-updates__status \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
  assert.match(styles, /\.settings-updates__actions \{[^}]*flex-wrap: wrap;/);
  assert.match(styles, /\.settings-updates__button \{[^}]*min-width: 9em;/);
  assert.match(styles, /\.settings-updates \{[^}]*container-type: inline-size;/);
  assert.match(styles, /@container \(max-width: 46rem\) \{[^}]*\.settings-updates__card \{[^}]*grid-template-columns: 2\.3em minmax\(0, 1fr\);/);
});
