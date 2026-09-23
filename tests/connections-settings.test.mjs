import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
import { accountRouteBinding, accountRouteMaxDataClass } from "../src/shared/providerAccountPolicy.ts";

const profile = { id: "api", name: "API", protocol: "openai-compatible", baseUrl: "https://api.example/v1", secretRef: "OPENAI_API_KEY", defaultModel: "model-a" };
const account = { id: "one", label: "One", provider: "opencode", binding: { kind: "api-profile", profileId: "api" } };
const native = (id, provider = "codex", hostId = "local") => ({ id, provider, label: id, hostId, binding: { kind: "cli-home", directory: `/tmp/fake-${id}` } });
const assessment = (a = account, profiles = [profile]) => ({ profile: { training: "none", retention: "bounded", thirdPartyProcessing: "no", contractualMode: "api" }, evidence: { kind: "user-attested", reviewedAt: "2026-01-01", sources: [], note: "Operator reviewed this route", binding: accountRouteBinding(a, profiles), models: "*" } });
async function fixture(t, initial) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-connections-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (initial) await writeFile(join(root, "settings.json"), JSON.stringify({ settingsVersion: 24, ...initial }));
  const store = new SettingsStore(root, "en"); await store.load();
  return { root, store };
}

test("edited invalid rows reject without disappearing or changing the confirmed catalog", async t => {
  const { store } = await fixture(t);
  await store.update({ apiProfiles: [profile], providerAccounts: [account] });
  const before = store.get();
  for (const bad of [{ ...account, label: "" }, { ...account, models: ["ok", 7] }, { ...account, binding: { kind: "cli-home", directory: "relative" } }]) {
    await assert.rejects(store.update({ providerAccounts: [bad] }), /account|model|binding/i);
    assert.deepEqual(store.get(), before);
  }
  await assert.rejects(store.update({ apiProfiles: [{ ...profile, baseUrl: "https://user:pass@example.test" }] }), /API|URL/i);
  assert.deepEqual(store.get(), before);
});

test("failed disk persistence leaves main memory and the next save based on confirmed settings", async t => {
  const { root, store } = await fixture(t);
  const before = store.get(); const persisted = await readFile(join(root, "settings.json"), "utf8");
  await mkdir(join(root, "settings.json.tmp"));
  await assert.rejects(store.update({ locale: "ru" }));
  assert.deepEqual(store.get(), before);
  assert.equal(await readFile(join(root, "settings.json"), "utf8"), persisted);
  await rm(join(root, "settings.json.tmp"), { recursive: true });
  await Promise.all([store.update({ defaultDataClass: "D1" }), store.update({ uiScale: 1.1 })]);
  assert.equal(store.get().locale, before.locale);
  assert.equal(store.get().defaultDataClass, "D1");
  assert.equal(store.get().uiScale, 1.1);
});

test("a repair preserves unrelated legacy-disabled rows and invalid evidence", async t => {
  const legacy = { id: "legacy", label: "Legacy", provider: "claude", hostIds: ["first", "second"], assessment: { invalid: true } };
  const { store } = await fixture(t, { providerAccounts: [legacy, native("one")] });
  const preserved = store.get().providerAccounts[0];
  assert.equal(preserved.bindingRequired, true); assert.equal(preserved.assessmentInvalid, true);
  await store.update({ providerAccounts: [preserved, { ...native("one"), label: "Repaired" }] });
  assert.deepEqual(store.get().providerAccounts[0], preserved);
});

test("new active bindings respect host/service capacity and credential aliases", async t => {
  const { store } = await fixture(t);
  await store.update({ providerAccounts: [native("one")] });
  await assert.rejects(store.update({ providerAccounts: [native("one"), native("two")] }), /limit|capacity/i);
  await store.update({ maxAccountsPerProviderPerHost: 2, providerAccounts: [native("one"), native("two"), native("claude", "claude")] });
  await assert.rejects(store.update({ providerAccounts: [...store.get().providerAccounts, native("three")] }), /limit|capacity/i);
  await store.update({ providerAccounts: [...store.get().providerAccounts, { ...native("three"), models: [] }] });
  const alias = { ...native("alias"), binding: native("one").binding, models: [] };
  await assert.rejects(store.update({ providerAccounts: [...store.get().providerAccounts, alias] }), /Duplicate|alias/i);
});

test("API aliases are one account identity even across compatible runtimes", async t => {
  const { store } = await fixture(t);
  await store.update({ apiProfiles: [profile], providerAccounts: [account] });
  await assert.rejects(store.update({ providerAccounts: [account, { ...account, id: "two", provider: "minimax" }] }), /Duplicate|alias/i);
  await assert.rejects(store.update({ apiProfiles: [profile, { ...profile, id: "other", baseUrl: "https://other.example" }], providerAccounts: [account, { ...account, id: "two", binding: { kind: "api-profile", profileId: "other" } }] }), /Duplicate|alias/i);
});

test("profile and host dependencies cannot be silently deleted", async t => {
  const host = { id: "server", label: "Server", sshHost: "server.example" };
  const { store } = await fixture(t);
  await store.update({ apiProfiles: [profile], providerAccounts: [account, native("remote", "claude", "server")], remoteHosts: [host] });
  await assert.rejects(store.update({ apiProfiles: [] }), /referenc|used|depend/i);
  await assert.rejects(store.update({ remoteHosts: [] }), /referenc|used|depend/i);
  await store.update({ apiProfiles: [], providerAccounts: [native("remote", "claude", "server")] });
  assert.equal(store.get().apiProfiles.length, 0);
});

test("model edits stale only affected evidence; an explicit review restores current evidence", async t => {
  const { store } = await fixture(t);
  const reviewed = { ...account, assessment: assessment() };
  await store.update({ apiProfiles: [profile], providerAccounts: [reviewed] });
  const binding = accountRouteBinding(reviewed, [profile]);
  await store.update({ providerAccounts: [{ ...reviewed, label: "Renamed" }] });
  assert.equal(accountRouteBinding(store.get().providerAccounts[0], [profile]), binding);
  assert.equal(accountRouteMaxDataClass(store.get().providerAccounts[0], [profile]), "D2");
  await store.update({ providerAccounts: [{ ...store.get().providerAccounts[0], models: ["model-a"] }] });
  let edited = store.get().providerAccounts[0];
  assert.equal(edited.assessmentInvalid, true);
  assert.deepEqual(edited.assessment, reviewed.assessment);
  assert.throws(() => accountRouteMaxDataClass(edited, [profile]), /invalid|stale/i);
  await store.update({ providerAccounts: [{ ...edited, assessment: assessment(edited), assessmentInvalid: false }] });
  edited = store.get().providerAccounts[0];
  assert.equal(edited.assessmentInvalid, undefined);
  assert.equal(accountRouteMaxDataClass(edited, [profile]), "D2");
  await store.update({ apiProfiles: [{ ...profile, defaultModel: "model-b" }] });
  assert.equal(store.get().providerAccounts[0].assessmentInvalid, true);
});

test("review intent rejects stale binding and incomplete self-hosted claims", async t => {
  const { store } = await fixture(t);
  await store.update({ apiProfiles: [profile], providerAccounts: [account] });
  await assert.rejects(store.update({ providerAccounts: [{ ...account, assessment: { ...assessment(), evidence: { ...assessment().evidence, binding: "stale" } }, assessmentInvalid: false }] }), /review|binding|assessment/i);
  await assert.rejects(store.update({ providerAccounts: [{ ...account, assessment: { trustedSelfHosted: true }, assessmentInvalid: false }] }), /assessment/i);
});

test("account home inspection touches only realpath and stat of the selected directory", async () => {
  const { inspectAccountHome } = await import("../src/main/services/AccountHomeInspection.ts");
  const calls = [];
  const io = { realpath: async path => { calls.push(["realpath", path]); return "/tmp/canonical-home"; }, stat: async path => { calls.push(["stat", path]); return { isDirectory: () => true }; } };
  assert.deepEqual(await inspectAccountHome("/tmp/selected-home", io), { canonicalPath: "/tmp/canonical-home" });
  assert.deepEqual(calls, [["realpath", "/tmp/selected-home"], ["stat", "/tmp/canonical-home"]]);
  await assert.rejects(inspectAccountHome("relative", io), /absolute/);
  assert.equal(calls.length, 2);
  await assert.rejects(inspectAccountHome("/tmp/a-file", { ...io, stat: async () => ({ isDirectory: () => false }) }), /not a directory/);
});

test("omitting a stale marker from an ordinary edit cannot renew saved evidence", async t => {
  const { store } = await fixture(t);
  await store.update({ apiProfiles: [profile], providerAccounts: [{ ...account, assessment: assessment() }] });
  await store.update({ apiProfiles: [{ ...profile, defaultModel: "model-b" }] });
  const stale = store.get().providerAccounts[0];
  const { assessmentInvalid: _invalid, ...withoutMarker } = stale;
  await store.update({ providerAccounts: [{ ...withoutMarker, label: "Renamed" }] });
  assert.equal(store.get().providerAccounts[0].assessmentInvalid, true);
  assert.throws(() => accountRouteMaxDataClass(store.get().providerAccounts[0], store.get().apiProfiles), /invalid|stale/i);
});

test("a reviewed account assessment can replace stale inherited API evidence", async t => {
  const { store } = await fixture(t);
  await store.update({ apiProfiles: [{ ...profile, assessment: assessment() }], providerAccounts: [account] });
  await store.update({ apiProfiles: [{ ...store.get().apiProfiles[0], defaultModel: "model-b" }] });
  assert.equal(store.get().apiProfiles[0].assessmentInvalid, true);
  const reviewed = { ...account, assessment: assessment(account, store.get().apiProfiles), assessmentInvalid: false };
  await store.update({ providerAccounts: [reviewed] });
  assert.equal(accountRouteMaxDataClass(store.get().providerAccounts[0], store.get().apiProfiles), "D2");
});

test("changing a route and changing it back does not silently renew evidence", async t => {
  const { store } = await fixture(t);
  await store.update({ apiProfiles: [profile], providerAccounts: [{ ...account, assessment: assessment() }] });
  await store.update({ apiProfiles: [{ ...profile, baseUrl: "https://other.example/v1" }] });
  await store.update({ apiProfiles: [profile] });
  assert.equal(store.get().providerAccounts[0].assessmentInvalid, true);
});

test("metadata and reviewed account serialization keep distinct evidence intents", async () => {
  const { accountDraft, draftAccount, reviewedDraftAccount } = await import("../src/renderer/src/features/settings/accountSettingsDraft.ts");
  const source = { ...account, assessment: assessment(), assessmentInvalid: true, models: [] };
  const draft = accountDraft(source);
  draft.value.hostId = "server";
  draft.modelsMode = "list"; draft.modelText = " model-a \nmodel-b\n";
  assert.equal(draftAccount(draft).assessmentInvalid, true);
  assert.deepEqual(draftAccount(draft).assessment, source.assessment);
  assert.deepEqual(draftAccount(draft).models, ["model-a", "model-b"]);
  draft.value.hostId = "local";
  const reviewed = reviewedDraftAccount(draft, [profile]);
  assert.equal(reviewed.assessmentInvalid, false);
  assert.equal(reviewed.assessment.evidence.binding, accountRouteBinding(reviewed, [profile]));
  draft.modelsMode = "all"; assert.equal(Object.hasOwn(draftAccount(draft), "models"), false);
  draft.modelsMode = "disabled"; assert.deepEqual(draftAccount(draft).models, []);
});

test("failed new-key reference writes remove only the allocated key; existing-key failures never remove it", async () => {
  const { saveProfileCredential } = await import("../src/renderer/src/features/settings/profileCredentialTransaction.ts");
  const ref = "secret:00000000-0000-4000-8000-000000000001", calls = [];
  const secrets = { create: async owner => { calls.push(["create", owner]); return { ref, owner, configured: true }; }, update: async (ref, owner) => { calls.push(["update", ref, owner]); throw new Error("key update rejected"); }, remove: async (ref, owner) => { calls.push(["remove", ref, owner]); } };
  await assert.rejects(saveProfileCredential(profile, "fixture-only", undefined, [profile], async patch => { assert.equal(JSON.stringify(patch).includes("fixture-only"), false); throw new Error("metadata rejected"); }, secrets), /metadata rejected/);
  assert.deepEqual(calls, [["create", { profileId: "api", hostId: "local" }], ["remove", ref, { profileId: "api", hostId: "local" }]]);
  calls.length = 0;
  await assert.rejects(saveProfileCredential({ ...profile, secretRef: ref }, "fixture-only", true, [], async () => assert.fail(), secrets), /key update rejected/);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "update");
  calls.length = 0;
  const replaced = await saveProfileCredential({ ...profile, secretRef: ref }, "fixture-only", false, [{ ...profile, secretRef: ref }], async () => undefined, secrets);
  assert.equal(replaced, ref); assert.equal(calls[0][0], "create");
});

test("raw capacity settings cannot bypass the normalized one-or-two limit", async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.update({ maxAccountsPerProviderPerHost: 3, providerAccounts: [native("one"), native("two"), native("three")] }), /limit|capacity/i);
  assert.equal(store.get().providerAccounts.length, 0);
});

test("an invalid replacement host cannot disappear underneath an existing account", async t => {
  const { store } = await fixture(t);
  const host = { id: "server", label: "Server", sshHost: "server.example" };
  await store.update({ remoteHosts: [host], providerAccounts: [native("remote", "codex", "server")] });
  await assert.rejects(store.update({ remoteHosts: [{ ...host, sshHost: "" }] }), /referenc|host/i);
  assert.deepEqual(store.get().remoteHosts, [host]);
});

test("same-reference key rotation persists stale evidence before changing the key", async t => {
  const { mutateProviderCredential } = await import("../src/main/services/ProviderCredentialSettings.ts");
  const { root, store } = await fixture(t);
  await store.update({ apiProfiles: [profile], providerAccounts: [{ ...account, assessment: assessment() }] });
  await mutateProviderCredential(store, profile.secretRef, async () => { assert.equal(store.get().providerAccounts[0].assessmentInvalid, true); });
  const reviewed = { ...account, assessment: assessment(), assessmentInvalid: false };
  await store.update({ providerAccounts: [reviewed] });
  await mkdir(join(root, "settings.json.tmp"));
  let mutated = false;
  await assert.rejects(mutateProviderCredential(store, profile.secretRef, async () => { mutated = true; }));
  assert.equal(mutated, false);
  assert.equal(store.get().providerAccounts[0].assessmentInvalid, undefined);
});
