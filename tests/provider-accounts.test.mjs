import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { SettingsStore, normalizeProviderAccounts } from "../src/main/services/SettingsStore.ts";
import {
  accountEffectiveMaxDataClass,
  accountSupportsModel,
  eligibleAccountsForModel
} from "../src/shared/contracts.ts";

// One provider, several subscriptions: a $20 plus tier beside a $100 pro
// tier. Cheap tiers list only the models their plan can sensibly run.
const CHATGPT_PLUS = {
  id: "chatgpt-plus",
  provider: "codex",
  label: "ChatGPT Plus",
  tier: "chatgpt-plus",
  models: ["gpt-5-mini"]
};
const CHATGPT_PRO = {
  id: "chatgpt-pro",
  provider: "codex",
  label: "ChatGPT Pro",
  tier: "chatgpt-pro",
  models: ["gpt-5*", "gpt-5-astra"]
};
const CLAUDE_MAX = {
  id: "claude-max",
  provider: "claude",
  label: "Claude Max",
  tier: "claude-max",
  models: ["opus*", "sonnet*"]
};
// Shared/team account on a provider whose default path reaches D2: the
// shared flag alone must tighten it to D1.
const DEVIN_TEAM = {
  id: "devin-team",
  provider: "devin",
  label: "Devin Team",
  tier: "devin-team",
  models: ["devin-2*"],
  shared: true
};

const ACCOUNTS = {
  codex: [CHATGPT_PLUS, CHATGPT_PRO],
  claude: [CLAUDE_MAX],
  devin: [DEVIN_TEAM]
};
const accountsFor = (provider) => ACCOUNTS[provider] ?? [];

test("accountSupportsModel matches exactly, case-insensitively, and by prefix wildcard", () => {
  const plus = { ...CHATGPT_PLUS, models: ["gpt-5-mini", "GPT-5-Codex", "o4*"] };
  assert.equal(accountSupportsModel(plus, "gpt-5-mini"), true);
  assert.equal(accountSupportsModel(plus, "GPT-5-MINI"), true);
  assert.equal(accountSupportsModel(plus, "gpt-5-codex"), true);
  assert.equal(accountSupportsModel(plus, "o4-mini"), true);
  assert.equal(accountSupportsModel(plus, "o4"), true);
  assert.equal(accountSupportsModel(plus, "gpt-5-astra"), false);
  assert.equal(accountSupportsModel(plus, "gpt-5"), false);

  // Unrestricted accounts: no request model, no models list, empty list.
  assert.equal(accountSupportsModel(CHATGPT_PLUS, undefined), true);
  assert.equal(accountSupportsModel({ ...CHATGPT_PLUS, models: undefined }, "anything"), true);
  assert.equal(accountSupportsModel({ ...CHATGPT_PLUS, models: [] }, "anything"), true);
});

test("accountEffectiveMaxDataClass tightens without ever raising the ceiling", () => {
  // An explicit cap below the provider ceiling (codex tops out at D1).
  assert.equal(
    accountEffectiveMaxDataClass({ ...CHATGPT_PRO, maxDataClass: "D0" }),
    "D0"
  );
  // Shared caps a D2-ceiling provider (devin) down to D1.
  assert.equal(accountEffectiveMaxDataClass(DEVIN_TEAM), "D1");
  // A non-shared devin account keeps the provider's own D2.
  assert.equal(
    accountEffectiveMaxDataClass({ ...DEVIN_TEAM, shared: undefined }),
    "D2"
  );
  // Shared with an explicit D0 stays D0 — tightening never loosens.
  assert.equal(
    accountEffectiveMaxDataClass({ ...DEVIN_TEAM, maxDataClass: "D0" }),
    "D0"
  );
  // A devin account CLAIMING D3 reads as D2: an account never raises the
  // provider's ceiling.
  assert.equal(
    accountEffectiveMaxDataClass({ ...DEVIN_TEAM, shared: undefined, maxDataClass: "D3" }),
    "D2"
  );
  // No account fields at all: the provider default.
  assert.equal(accountEffectiveMaxDataClass(CHATGPT_PLUS), "D1");
});

test("eligibleAccountsForModel filters by provider and model, keeping settings order", () => {
  const eligible = eligibleAccountsForModel(
    [CLAUDE_MAX, CHATGPT_PRO, CHATGPT_PLUS, DEVIN_TEAM],
    "codex",
    "gpt-5-mini"
  );
  // Claude Max is another provider, devin another one still; both plus and
  // pro cover gpt-5-mini (exact and wildcard) and keep their input order.
  assert.deepEqual(eligible.map((account) => account.id), ["chatgpt-pro", "chatgpt-plus"]);
  assert.deepEqual(
    eligibleAccountsForModel([CHATGPT_PLUS, CHATGPT_PRO], "codex", "gpt-6").map((account) => account.id),
    []
  );
  // No model constrains nothing.
  assert.deepEqual(
    eligibleAccountsForModel([CHATGPT_PLUS], "codex", undefined).map((account) => account.id),
    ["chatgpt-plus"]
  );
});

test("normalizeProviderAccounts round-trips a valid catalog", () => {
  const valid = [
    {
      id: "chatgpt-plus",
      provider: "codex",
      label: "ChatGPT Plus",
      tier: "chatgpt-plus",
      models: ["gpt-5-mini", "gpt-5*"],
      shared: true,
      maxDataClass: "D1"
    },
    { id: "claude-max", provider: "claude", label: "Claude Max", models: ["opus*"] },
    { id: "grok-standard", provider: "grok", label: "Grok Standard" }
  ];
  assert.deepEqual(normalizeProviderAccounts(valid, []), valid);
});

test("normalizeProviderAccounts drops entries that no longer match the schema", () => {
  const valid = { id: "chatgpt-plus", provider: "codex", label: "ChatGPT Plus" };
  // Unknown provider union members ("terminal" is not an agent provider).
  assert.deepEqual(
    normalizeProviderAccounts([
      valid,
      { ...valid, id: "shell", provider: "terminal", label: "Shell" },
      { ...valid, id: "openai", provider: "openai", label: "OpenAI" },
      { ...valid, id: "no-label", provider: "codex", label: "  " },
      { ...valid, id: "bad-tier", provider: "codex", label: "Bad tier", tier: "  " },
      { ...valid, id: "bad-tier-type", provider: "codex", label: "Bad tier type", tier: 20 },
      { ...valid, id: "bad-class", provider: "codex", label: "Bad class", maxDataClass: "D9" },
      { ...valid, id: "bad-shared", provider: "codex", label: "Bad shared", shared: "yes" },
      { ...valid, id: "bad-models", provider: "codex", label: "Bad models", models: "gpt-5" }
    ], []),
    [valid]
  );
});

test("normalizeProviderAccounts keeps the first of duplicated ids", () => {
  assert.deepEqual(
    normalizeProviderAccounts([
      { id: "chatgpt-plus", provider: "codex", label: "First" },
      { id: "chatgpt-plus", provider: "codex", label: "Second" }
    ], []).map((account) => account.label),
    ["First"]
  );
});

test("normalizeProviderAccounts drops invalid model entries, not the account", () => {
  const normalized = normalizeProviderAccounts([{
    ...CHATGPT_PLUS,
    models: ["gpt-5-mini", "", "   ", 7, "GPT-5-MINI", "gpt-5*"]
  }], []);
  assert.deepEqual(normalized[0].models, ["gpt-5-mini", "gpt-5*"]);

  // A models list left empty by that filtering falls away: unrestricted.
  const emptied = normalizeProviderAccounts([{
    ...CHATGPT_PLUS,
    models: ["", "   "]
  }], []);
  assert.equal(emptied.length, 1);
  assert.equal("models" in emptied[0], false);
});

test("normalizeProviderAccounts caps the catalog at 32 and falls back on non-arrays", () => {
  const many = Array.from({ length: 40 }, (_value, index) => ({
    ...CHATGPT_PLUS,
    id: `account-${index}`,
    label: `Account ${index}`
  }));
  assert.equal(normalizeProviderAccounts(many, []).length, 32);
  assert.deepEqual(normalizeProviderAccounts("nope", []), []);
  assert.deepEqual(normalizeProviderAccounts(undefined, [CHATGPT_PLUS]), [CHATGPT_PLUS]);
});

test("provider accounts persist through the settings store and settingsVersion reaches 24", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-settings-providersaccounts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory, "en");
  const loaded = await store.load();
  assert.deepEqual(loaded.providerAccounts, []);

  const accounts = [CHATGPT_PLUS, CHATGPT_PRO, CLAUDE_MAX];
  await store.update({ providerAccounts: accounts });
  const reloaded = await new SettingsStore(directory, "en").load();
  assert.deepEqual(reloaded.providerAccounts, accounts);

  const persisted = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
  assert.equal(persisted.settingsVersion, 24);
  assert.equal(persisted.providerAccounts.length, 3);
});

test("legacy version-22 settings migrate to an empty account catalog and persist version 24", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-settings-providersaccounts-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "settings.json"), JSON.stringify({ settingsVersion: 22 }));
  const loaded = await new SettingsStore(directory, "en").load();
  assert.deepEqual(loaded.providerAccounts, []);
  const persisted = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
  assert.equal(persisted.settingsVersion, 24);
  assert.deepEqual(persisted.providerAccounts, []);
});

function fakeSpawner(calls) {
  return (command, args, options) => {
    const process = {
      pid: 30_000 + calls.length,
      write() {},
      resize() {},
      kill() {},
      pause() {},
      resume() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; }
    };
    calls.push({ command, args, options });
    return process;
  };
}

function availableRegistry() {
  return {
    get(provider) {
      return {
        state: "available",
        provider,
        executable: `/resolved/${provider}`,
        launcher: "native",
        environment: { PATH: "/resolved:/usr/bin" },
        checked: [{ path: `/resolved/${provider}`, result: "selected" }]
      };
    },
    snapshot() { return {}; }
  };
}

function fixture(options) {
  const calls = [];
  const terminals = new TerminalManager(
    () => undefined,
    availableRegistry(),
    undefined,
    undefined,
    true,
    fakeSpawner(calls)
  );
  const control = new AgentControlService(terminals, undefined, options);
  return { calls, terminals, control };
}

function parentUnder(terminals) {
  return terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
}

test("an explicit accountId that exists and covers the work is recorded on the session", () => {
  const { terminals, control } = fixture({ accounts: accountsFor });
  const parent = parentUnder(terminals);

  const child = control.spawn({
    parentSessionId: parent.id,
    provider: "codex",
    cwd: process.cwd(),
    accountId: "chatgpt-pro",
    model: "gpt-5-astra",
    dataClass: "D1"
  });
  assert.equal(child.accountId, "chatgpt-pro");
  assert.equal(control.status(child.id).accountId, "chatgpt-pro");

  // Without a model the account still must belong to the provider, but no
  // model coverage applies.
  const modelless = control.spawn({
    parentSessionId: parent.id,
    provider: "codex",
    cwd: process.cwd(),
    accountId: "chatgpt-plus"
  });
  assert.equal(modelless.accountId, "chatgpt-plus");
  terminals.disposeAll();
});

test("an explicit accountId from another provider or configured nowhere throws", () => {
  const { terminals, control } = fixture({ accounts: accountsFor });
  const parent = parentUnder(terminals);
  assert.throws(
    () => control.spawn({
      parentSessionId: parent.id,
      provider: "codex",
      cwd: process.cwd(),
      accountId: "claude-max"
    }),
    /Account claude-max belongs to provider claude, not codex\./u
  );
  assert.throws(
    () => control.spawn({
      parentSessionId: parent.id,
      provider: "codex",
      cwd: process.cwd(),
      accountId: "ghost"
    }),
    /Account ghost is not configured\./u
  );
  terminals.disposeAll();
});

test("a chosen account that does not cover the model throws, naming the eligible accounts", () => {
  const { calls, terminals, control } = fixture({ accounts: accountsFor });
  const parent = parentUnder(terminals);
  const before = calls.length;
  assert.throws(
    () => control.spawn({
      parentSessionId: parent.id,
      provider: "codex",
      cwd: process.cwd(),
      accountId: "chatgpt-plus",
      model: "gpt-5-astra",
      dataClass: "D1"
    }),
    /Account ChatGPT Plus \(tier chatgpt-plus\) does not cover model gpt-5-astra; eligible accounts: ChatGPT Pro\./u
  );
  assert.equal(calls.length, before);
  terminals.disposeAll();
});

test("a model no account covers throws before anything launches", () => {
  const { calls, terminals, control } = fixture({ accounts: accountsFor });
  const parent = parentUnder(terminals);
  const before = calls.length;
  assert.throws(
    () => control.spawn({
      parentSessionId: parent.id,
      provider: "codex",
      cwd: process.cwd(),
      model: "gpt-6"
    }),
    /No codex account covers model gpt-6\./u
  );
  assert.equal(calls.length, before);
  terminals.disposeAll();
});

test("a covered model routes to the FIRST eligible account, deterministically", () => {
  const { terminals, control } = fixture({ accounts: accountsFor });
  const parent = parentUnder(terminals);

  // Both plus (exact) and pro (gpt-5* wildcard) cover gpt-5-mini; settings
  // order picks plus.
  const light = control.spawn({
    parentSessionId: parent.id,
    provider: "codex",
    cwd: process.cwd(),
    model: "gpt-5-mini",
    dataClass: "D1"
  });
  assert.equal(light.accountId, "chatgpt-plus");

  // Only the pro tier covers the heavyweight model.
  const heavy = control.spawn({
    parentSessionId: parent.id,
    provider: "codex",
    cwd: process.cwd(),
    model: "gpt-5-astra",
    dataClass: "D1"
  });
  assert.equal(heavy.accountId, "chatgpt-pro");
  terminals.disposeAll();
});

test("a shared account refuses D2 work even though the provider ceiling allows D2", () => {
  const { calls, terminals, control } = fixture({ accounts: accountsFor });
  const parent = parentUnder(terminals);
  const before = calls.length;

  // devin's default path reaches D2, so the PROVIDER gate passes — but the
  // shared team account tightens the cap to D1 and the spawn must stop
  // before the launch layer.
  assert.throws(
    () => control.spawn({
      parentSessionId: parent.id,
      provider: "devin",
      cwd: process.cwd(),
      model: "devin-2.1",
      dataClass: "D2"
    }),
    /Account Devin Team handles at most D1; this task is D2\./u
  );
  assert.equal(calls.length, before);

  // The same shared account accepts internal-only work.
  const internal = control.spawn({
    parentSessionId: parent.id,
    provider: "devin",
    cwd: process.cwd(),
    model: "devin-2.1",
    dataClass: "D1"
  });
  assert.equal(internal.accountId, "devin-team");
  terminals.disposeAll();
});

test("without an accounts getter every model passes through unrestricted", () => {
  const { terminals, control } = fixture();
  const parent = parentUnder(terminals);
  const child = control.spawn({
    parentSessionId: parent.id,
    provider: "codex",
    cwd: process.cwd(),
    model: "gpt-6-ultra-heavy"
  });
  assert.equal(child.provider, "codex");
  assert.equal(child.accountId, undefined);
  terminals.disposeAll();
});
