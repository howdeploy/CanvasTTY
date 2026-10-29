import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_PROVIDERS } from "../src/shared/contracts.ts";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-settings-preservation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(root, "settings.json"), store: new SettingsStore(root, "en", process.platform) };
}

test("keeps a future settings file byte-for-byte through load and every settings writer", async (t) => {
  const { root, path, store } = await fixture(t);
  const original = JSON.stringify({
    ...store.get(), settingsVersion: 99, palette: "night", futureSetting: { savedData: [1, 2, 3] }
  }, null, 4);
  await writeFile(path, original);
  assert.equal((await store.load()).palette, "night");
  assert.equal(await readFile(path, "utf8"), original);
  await assert.rejects(store.update({ palette: "lilac" }), /version 99 is newer/);
  await assert.rejects(store.setAvailableProviders(Object.fromEntries(AGENT_PROVIDERS.map((id) => [id, false]))), /version 99 is newer/);
  assert.equal(store.get().palette, "night");
  assert.equal(await readFile(path, "utf8"), original);
  assert.deepEqual(await readdir(root), ["settings.json"]);
});

test("resumes persistence after a future profile is replaced by a compatible one", async (t) => {
  const { path, store } = await fixture(t);
  await writeFile(path, JSON.stringify({ settingsVersion: 99, palette: "night" }));
  await store.load();
  await assert.rejects(store.update({ palette: "lilac" }), /newer/);
  await writeFile(path, JSON.stringify({ settingsVersion: 0, palette: "night" }));
  await store.load();
  assert.notEqual(JSON.parse(await readFile(path, "utf8")).settingsVersion, 0);
  await store.update({ palette: "lilac" });
  assert.equal(JSON.parse(await readFile(path, "utf8")).palette, "lilac");
});

test("backs up malformed JSON and invalid roots before saving defaults", async (t) => {
  const { root, path, store } = await fixture(t);
  for (const original of ['{"palette":"night",', '[{"settingsVersion":99}]', "null"]) {
    await writeFile(path, original);
    await store.load();
    await store.update({ palette: "lilac" });
    assert.equal(JSON.parse(await readFile(path, "utf8")).palette, "lilac");
  }
  const backups = (await readdir(root)).filter((name) => name.startsWith("settings.json.corrupt-"));
  assert.equal(backups.length, 3);
  assert.deepEqual((await Promise.all(backups.map((name) => readFile(join(root, name), "utf8")))).sort(),
    ['{"palette":"night",', '[{"settingsVersion":99}]', "null"].sort());
});

test("refuses later writes when settings could not be read", async (t) => {
  const { path, store } = await fixture(t);
  await mkdir(path);
  await writeFile(join(path, "owner.txt"), "keep this unreadable source");
  await store.load();
  await assert.rejects(store.update({ palette: "night" }), /original settings are preserved/);
  assert.equal(await readFile(join(path, "owner.txt"), "utf8"), "keep this unreadable source");
  await rm(path, { recursive: true });
  await writeFile(path, JSON.stringify({ palette: "night" }));
  await store.load();
  await store.update({ palette: "lilac" });
  assert.equal(JSON.parse(await readFile(path, "utf8")).palette, "lilac");
});

test("preserves a permission-denied source and blocks subsequent updates", {
  skip: process.platform === "win32" || process.getuid?.() === 0
}, async (t) => {
  const { path, store } = await fixture(t);
  const original = JSON.stringify({ palette: "night", privateData: "preserve" });
  await writeFile(path, original);
  await chmod(path, 0o000);
  try {
    await store.load();
  } finally {
    await chmod(path, 0o600);
  }
  await assert.rejects(store.update({ palette: "lilac" }), /original settings are preserved/);
  assert.equal(await readFile(path, "utf8"), original);
});

test("leaves corrupt settings untouched when making their backup fails", {
  skip: process.platform === "win32" || process.getuid?.() === 0
}, async (t) => {
  const { root, path, store } = await fixture(t);
  const original = '{"palette":"night",';
  await writeFile(path, original);
  await chmod(root, 0o500);
  try {
    await store.load();
  } finally {
    await chmod(root, 0o700);
  }
  await assert.rejects(store.update({ palette: "lilac" }), /could not be preserved/);
  assert.equal(await readFile(path, "utf8"), original);
  assert.deepEqual(await readdir(root), ["settings.json"]);
});

test("a failed compatible settings write rolls back memory and the queue can retry", async (t) => {
  const { path, store } = await fixture(t);
  await store.load();
  const before = store.get();
  const original = await readFile(path, "utf8");
  await mkdir(`${path}.tmp`);
  await assert.rejects(store.update({ palette: "night" }), /EISDIR|EPERM|EACCES/);
  assert.deepEqual(store.get(), before);
  assert.equal(await readFile(path, "utf8"), original);
  await rm(`${path}.tmp`, { recursive: true });
  await store.update({ palette: "night" });
  assert.equal(JSON.parse(await readFile(path, "utf8")).palette, "night");
});
