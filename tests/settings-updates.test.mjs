import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { updaterPresentation } from "../src/renderer/src/features/settings/updaterPresentation.ts";

const settingsPanelPath = new URL("../src/renderer/src/features/settings/SettingsPanel.tsx", import.meta.url);
const updatesPath = new URL("../src/renderer/src/features/settings/UpdatesSettings.tsx", import.meta.url);
const appStylesPath = new URL("../src/renderer/src/styles/app.css", import.meta.url);

const VERSION = "1.4.0";

test("idle: version shown, only Check is offered", () => {
  const view = updaterPresentation({ status: "idle" }, "en", VERSION);
  assert.equal(view.title, "No update found");
  assert.equal(view.detail, "Current version: v1.4.0");
  assert.equal(view.progress, null);
  assert.deepEqual(view.actions, { check: "enabled", download: false, install: false });
});

test("checking: Check is disabled and nothing else appears", () => {
  const view = updaterPresentation({ status: "checking" }, "ru", VERSION);
  assert.equal(view.title, "Проверяем обновления…");
  assert.equal(view.tone, "busy");
  assert.deepEqual(view.actions, { check: "disabled", download: false, install: false });
});

test("available: the version is named, Download is explicit and Check is hidden (it would download)", () => {
  const view = updaterPresentation({ status: "available", version: "1.5.0" }, "en", VERSION);
  assert.equal(view.title, "Update available · v1.5.0");
  assert.match(view.detail, /press Download/);
  assert.deepEqual(view.actions, { check: "hidden", download: true, install: false });
  assert.equal(view.progress, null);
});

test("downloading: percent only when the updater reported one, never invented", () => {
  const known = updaterPresentation({ status: "downloading", version: "1.5.0", percent: 42 }, "en", VERSION);
  assert.equal(known.title, "Downloading update · 42%");
  assert.equal(known.progress, 42);
  assert.deepEqual(known.actions, { check: "disabled", download: false, install: false });

  const unknown = updaterPresentation({ status: "downloading", version: "1.5.0", percent: null }, "en", VERSION);
  assert.equal(unknown.title, "Downloading update — progress not reported yet");
  assert.equal(unknown.progress, null);
  assert.doesNotMatch(unknown.title, /\d+%/);
});

test("downloaded: Install and restart is the only action and warns about the restart", () => {
  const view = updaterPresentation({ status: "downloaded", version: "1.5.0" }, "en", VERSION);
  assert.equal(view.title, "Update ready · v1.5.0");
  assert.match(view.detail, /restarts/);
  assert.deepEqual(view.actions, { check: "hidden", download: false, install: true });
});

test("install is never offered before the download finished", () => {
  const states = [
    { status: "idle" },
    { status: "checking" },
    { status: "available", version: "1.5.0" },
    { status: "downloading", version: "1.5.0", percent: 99 },
    { status: "unavailable", reason: "dev" },
    { status: "unavailable", reason: "offline" },
    { status: "unavailable", reason: "error" }
  ];
  for (const state of states) {
    assert.equal(updaterPresentation(state, "en", VERSION).actions.install, false, state.status);
  }
});

test("unavailable: dev, offline and error each get their own truthful explanation", () => {
  const dev = updaterPresentation({ status: "unavailable", reason: "dev" }, "en", VERSION);
  assert.equal(dev.title, "Updates unavailable");
  assert.match(dev.detail, /development/);
  assert.equal(dev.actions.check, "disabled");

  const offline = updaterPresentation({ status: "unavailable", reason: "offline" }, "en", VERSION);
  assert.match(offline.detail, /connection/);
  assert.equal(offline.actions.check, "enabled");

  const error = updaterPresentation({ status: "unavailable", reason: "error" }, "ru", VERSION);
  assert.equal(error.detail, "Проверка обновлений завершилась ошибкой. Попробуйте позже.");
  assert.equal(error.actions.check, "enabled");
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
  assert.match(panel, /section === "updates" && \(\s*<UpdatesSettings state=\{updaterState\} locale=\{locale\} currentVersion=\{appManifest\.version\} \/>/);
  assert.doesNotMatch(panel, /UpdaterRow|settings-update-row/);

  // The existing IPC plumbing stays: state subscription in the panel, actions in the section.
  assert.match(panel, /window\.canvasTTY\.updater\.onState\(/);
  assert.match(panel, /window\.canvasTTY\.updater\.state\(\)/);
  assert.match(updates, /window\.canvasTTY\.updater\.check\(\)/);
  assert.match(updates, /window\.canvasTTY\.updater\.install\(\)/);

  // Explicit actions: Download and Install are separate buttons, each gated by the presentation.
  assert.match(updates, /\{view\.actions\.download && \(/);
  assert.match(updates, /\{view\.actions\.install && \(/);
  assert.match(updates, /\{view\.progress !== null && \(\s*<progress/);
});

test("the Updates layout wraps text and buttons instead of overlapping the divider", async () => {
  const styles = await readFile(appStylesPath, "utf8");
  assert.doesNotMatch(styles, /\.settings-update-row/);
  assert.match(styles, /\.settings-updates__card \{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
  assert.match(styles, /\.settings-updates__status \{[^}]*min-width: 12em;[^}]*overflow-wrap: anywhere;/);
  assert.match(styles, /\.settings-updates__actions \{[^}]*flex-wrap: wrap;/);
  assert.match(styles, /\.settings-updates__button \{[^}]*min-width: 9em;/);
});
