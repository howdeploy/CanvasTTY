import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeSettings, SettingsStore } from "../src/main/services/SettingsStore.ts";
import { attentionQueueRenderedAt, attentionSessions } from "../src/renderer/src/features/home/attentionQueue.ts";

const settingsPanelPath = new URL("../src/renderer/src/features/settings/SettingsPanel.tsx", import.meta.url);
const workspacePath = new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url);
const i18nPath = new URL("../src/renderer/src/lib/i18n.ts", import.meta.url);
const appStylesPath = new URL("../src/renderer/src/styles/app.css", import.meta.url);

const PLACEMENTS = ["top-left", "top-right", "bottom-left", "bottom-right"];

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-attention-queue-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("fresh installs show the attention panel in the bottom-right corner", async () => {
  await withStore(async (dir) => {
    const store = new SettingsStore(dir, "en-US");
    await store.load();
    assert.equal(store.get().attentionQueueVisible, true);
    assert.equal(store.get().attentionQueuePlacement, "bottom-right");
    const persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(persisted.attentionQueueVisible, true);
    assert.equal(persisted.attentionQueuePlacement, "bottom-right");
  });
});

test("the panel toggle and OS notifications persist independently in all four combinations", async () => {
  for (const attentionNotifications of [true, false]) {
    for (const attentionQueueVisible of [true, false]) {
      await withStore(async (dir) => {
        const store = new SettingsStore(dir, "en-US");
        await store.load();
        await store.update({ attentionNotifications, attentionQueueVisible });

        const reloaded = new SettingsStore(dir, "en-US");
        await reloaded.load();
        assert.equal(reloaded.get().attentionNotifications, attentionNotifications);
        assert.equal(reloaded.get().attentionQueueVisible, attentionQueueVisible);
      });
    }
  }
});

test("the placement persists and a malformed value falls back", async () => {
  await withStore(async (dir) => {
    const store = new SettingsStore(dir, "en-US");
    await store.load();
    await store.update({ attentionQueuePlacement: "top-left" });

    const reloaded = new SettingsStore(dir, "en-US");
    await reloaded.load();
    assert.equal(reloaded.get().attentionQueuePlacement, "top-left");

    const persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    await writeFile(join(dir, "settings.json"), JSON.stringify({
      ...persisted,
      attentionQueueVisible: "nope",
      attentionQueuePlacement: "middle"
    }));
    const repaired = new SettingsStore(dir, "en-US");
    await repaired.load();
    assert.equal(repaired.get().attentionQueueVisible, true);
    assert.equal(repaired.get().attentionQueuePlacement, "bottom-right");
  });
});

test("profiles written before the panel settings existed are migrated to the defaults", async () => {
  await withStore(async (dir) => {
    const store = new SettingsStore(dir, "en-US");
    await store.load();
    const persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    delete persisted.attentionQueueVisible;
    delete persisted.attentionQueuePlacement;
    await writeFile(join(dir, "settings.json"), JSON.stringify(persisted));

    const migrated = new SettingsStore(dir, "en-US");
    await migrated.load();
    assert.equal(migrated.get().attentionQueueVisible, true);
    assert.equal(migrated.get().attentionQueuePlacement, "bottom-right");
    const rewritten = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(rewritten.attentionQueueVisible, true);
    assert.equal(rewritten.attentionQueuePlacement, "bottom-right");
  });
});

test("normalizeSettings keeps explicit values and rejects unknown placements", async () => {
  await withStore(async (dir) => {
    const store = new SettingsStore(dir, "en-US");
    await store.load();
    const fallback = store.get();

    const kept = normalizeSettings({ ...fallback, attentionQueueVisible: false, attentionQueuePlacement: "top-right" }, fallback);
    assert.equal(kept.attentionQueueVisible, false);
    assert.equal(kept.attentionQueuePlacement, "top-right");

    const repaired = normalizeSettings({ ...fallback, attentionQueueVisible: 1, attentionQueuePlacement: "center" }, fallback);
    assert.equal(repaired.attentionQueueVisible, true);
    assert.equal(repaired.attentionQueuePlacement, "bottom-right");
  });
});

test("only the panel setting decides whether the panel renders; OS notifications never do", () => {
  for (const attentionNotifications of [true, false]) {
    for (const attentionQueueVisible of [true, false]) {
      const settings = { attentionNotifications, attentionQueueVisible, attentionQueuePlacement: "bottom-right" };
      assert.equal(attentionQueueRenderedAt(settings, "bottom-right"), attentionQueueVisible);
      for (const other of PLACEMENTS.filter((placement) => placement !== "bottom-right")) {
        assert.equal(attentionQueueRenderedAt(settings, other), false);
      }
    }
  }
});

test("the panel follows its placement setting into any of the four corners", () => {
  for (const placement of PLACEMENTS) {
    const settings = { attentionQueueVisible: true, attentionQueuePlacement: placement };
    const rendered = PLACEMENTS.filter((corner) => attentionQueueRenderedAt(settings, corner));
    assert.deepEqual(rendered, [placement]);
  }
});

test("rows keep insertion order when statuses change; the queue never re-sorts", () => {
  const snapshot = (id, status) => ({ id, title: id, status, provider: "terminal", position: { x: 0, y: 0 }, size: { width: 1, height: 1 } });
  const before = [snapshot("a", "failed"), snapshot("b", "working"), snapshot("c", "needs_approval")];
  const after = [snapshot("a", "needs_approval"), snapshot("b", "failed"), snapshot("c", "needs_approval")];

  assert.deepEqual(attentionSessions(before).map((session) => session.id), ["a", "c"]);
  assert.deepEqual(attentionSessions(after).map((session) => session.id), ["a", "b", "c"]);
});

test("the workspace renders the whole panel only through the placement helper", async () => {
  const [canvas, panel, i18n, styles] = await Promise.all([
    readFile(workspacePath, "utf8"),
    readFile(settingsPanelPath, "utf8"),
    readFile(i18nPath, "utf8"),
    readFile(appStylesPath, "utf8")
  ]);

  // No hard-coded corner and nothing of the panel (title, empty state, reserved box) outside the guard.
  assert.doesNotMatch(canvas, /placement === "bottom-right" && \(\s*<section className="attention-queue"/);
  assert.match(canvas, /\{attentionQueueRenderedAt\(settings, placement\) && \(\s*<section className="attention-queue"/);
  assert.match(canvas, /className="attention-queue__caption">\{t\(settings\.locale, "needsAttentionCaption"\)\}/);
  assert.match(canvas, /title=\{t\(settings\.locale, "needsAttentionHint"\)\}/);
  assert.match(canvas, /settings\.attentionQueuePlacement,\s*settings\.attentionQueueVisible,/);

  // Settings UI: the two new controls sit next to the OS notification toggle.
  const notifications = panel.indexOf('label={t(locale, "attentionNotifications")}');
  const queueToggle = panel.indexOf('label={t(locale, "attentionQueue")}');
  const placement = panel.indexOf('label={t(locale, "attentionQueuePlacement")}');
  assert.ok(notifications > 0 && queueToggle > notifications && placement > queueToggle);
  assert.match(panel, /onChange=\{\(value\) => void onChange\(\{ attentionQueueVisible: value === "on" \}\)\}/);
  assert.match(panel, /value=\{settings\.attentionQueuePlacement\}/);

  // Both locales explain what the queue lists.
  for (const key of ["attentionQueue", "attentionQueueDescription", "attentionQueuePlacement", "needsAttentionHint", "needsAttentionCaption"]) {
    assert.equal(i18n.match(new RegExp(`^  ${key}: "`, "gm"))?.length, 2, `${key} exists in ru and en`);
  }
  assert.match(i18n, /needsAttentionHint: "Sessions that need approval or have failed/);
  assert.match(styles, /\.attention-queue__caption \{/);
  assert.match(styles, /\.attention-queue__item:focus-visible \{/);
});
