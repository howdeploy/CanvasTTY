import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
import { RemoteProviderAccess } from "../src/main/services/RemoteProviderAccess.ts";
import {
  PROVIDER_API_ENDPOINTS,
  providerApiUrl,
  providerPermittedOnHost,
  remoteHostInvalidReason
} from "../src/shared/contracts.ts";

const validHost = {
  id: "ru-box",
  label: "Russian build box",
  sshHost: "ru.internal.example"
};

// The full beacon table, pinned literally so an accidental endpoint edit (or
// a dropped provider) fails here instead of silently re-routing probes.
const EXPECTED_ENDPOINTS = {
  codex: "api.openai.com",
  claude: "api.anthropic.com",
  qwen: "dashscope.aliyuncs.com",
  kimi: "api.moonshot.ai",
  opencode: "opencode.ai",
  hermes: "nousresearch.com",
  grok: "api.x.ai",
  omp: "omp.sh",
  pi: "pi.dev",
  cursor: "api2.cursor.sh",
  minimax: "api.minimax.io",
  devin: "api.devin.ai",
  antigravity: "antigravity.google"
};

function fakeRunner(output) {
  const calls = [];
  const runner = (host, command, timeoutMs) => {
    calls.push({ host, command, timeoutMs });
    return Promise.resolve(output);
  };
  return { calls, runner };
}

// Multi-line scripts ride the same single sh -lc '<script>' argument as the
// discovery probe; [\s\S] spans the newlines the probe blocks introduce.
function scriptFromCommand(command) {
  assert.equal(command.length, 1);
  assert.match(command[0], /^sh -lc '[\s\S]*'$/u);
  const script = command[0].slice("sh -lc '".length, -1);
  assert.equal(script.includes("'"), false, "the quoted script must not contain single quotes");
  return script;
}

function probeBlockCount(script) {
  return (script.match(/\) &/gu) || []).length;
}

test("one ssh round-trip probes every provider endpoint in background subshells, then waits", async () => {
  const { calls, runner } = fakeRunner({ code: 0, stdout: "", stderr: "" });
  const result = await new RemoteProviderAccess(runner).probe(validHost);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, validHost);
  assert.equal(calls[0].timeoutMs, 15000);

  const script = scriptFromCommand(calls[0].command);
  assert.equal(probeBlockCount(script), Object.keys(EXPECTED_ENDPOINTS).length);
  assert.match(script, /\nwait\nexit 0$/u, "the script must wait for background probes and exit 0");
  for (const [provider, hostname] of Object.entries(EXPECTED_ENDPOINTS)) {
    assert.ok(script.includes(`"https://${hostname}/"`), `${provider} endpoint must be probed`);
  }
  assert.ok(script.includes("curl -s -o /dev/null -m 6 -w \"%{http_code}\""));
  assert.equal(result.hostId, "ru-box");
  assert.equal(result.reachable, true);
});

test("HTTP answers establish reachability except transport errors and explicit access blocks", async () => {
  const { calls, runner } = fakeRunner({
    code: 0,
    // grok=000 is what a blocked endpoint emits before the case filter, and
    // the parser must survive it leaking through anyway.
    stdout: "Welcome to the build farm\r\ncodex=1\nclaude=1\ngrok=000\n=qwen\nkimi=1x\nqwen=1\n",
    stderr: ""
  });
  const result = await new RemoteProviderAccess(runner).probe(validHost);

  assert.equal(result.reachable, true);
  assert.deepEqual(result.providers, {
    codex: true,
    claude: true,
    qwen: true,
    grok: false,
    kimi: false,
    opencode: false,
    hermes: false,
    omp: false,
    pi: false,
    cursor: false,
    minimax: false,
    devin: false,
    antigravity: false
  });

  assert.equal(calls.length, 1);
});

// Executes the real probe script locally against fake curl/wget binaries: no network.
async function runProbeScript(t, tools) {
  const providers = ["codex", "claude", "kimi"];
  const { calls, runner } = fakeRunner({ code: 0, stdout: "", stderr: "" });
  await new RemoteProviderAccess(runner).probe(validHost, 15_000, providers);
  const script = scriptFromCommand(calls[0].command);
  const bin = await mkdtemp(join(tmpdir(), "canvastty-probe-bin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  for (const tool of ["sed", "tail"]) await symlink(execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
  for (const [name, body] of Object.entries(tools)) await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const stdout = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { PATH: bin } });
  const parsed = await new RemoteProviderAccess(async () => ({ code: 0, stdout, stderr: "" })).probe(validHost, 15_000, providers);
  return { stdout, providers: parsed.providers };
}

test("curl verdicts: HTTP replies are reachable, 000/403/451 are blocked", async t => {
  const { providers } = await runProbeScript(t, {
    curl: 'case "$*" in *openai*) printf 401 ;; *anthropic*) printf 451 ;; *) printf 000; exit 7 ;; esac'
  });
  assert.deepEqual(providers, { codex: true, claude: false, kimi: false });
});

test("the wget fallback reads the status line, so a 4xx still proves the network path", async t => {
  const { providers } = await runProbeScript(t, {
    wget: 'case "$*" in *openai*) echo "  HTTP/1.1 401 Unauthorized" >&2; exit 8 ;; *anthropic*) echo "  HTTP/1.1 403 Forbidden" >&2; exit 8 ;; *) echo "failed: Connection timed out." >&2; exit 4 ;; esac'
  });
  assert.deepEqual(providers, { codex: true, claude: false, kimi: false });
});

test("a host without curl or wget leaves providers unknown instead of blocking them", async t => {
  const { stdout, providers } = await runProbeScript(t, {});
  assert.match(stdout, /codex=\?/u);
  assert.deepEqual(providers, {});
});

test("a provider subset limits the script and the reported providers", async () => {
  const { calls, runner } = fakeRunner({ code: 0, stdout: "codex=1\n", stderr: "" });
  const result = await new RemoteProviderAccess(runner).probe(validHost, 5_000, ["codex", "qwen"]);

  assert.equal(calls[0].timeoutMs, 5000);
  const script = scriptFromCommand(calls[0].command);
  assert.equal(probeBlockCount(script), 2);
  assert.ok(script.includes("https://api.openai.com/"));
  assert.ok(script.includes("https://dashscope.aliyuncs.com/"));
  assert.equal(script.includes("https://api.anthropic.com/"), false);
  assert.deepEqual(result.providers, { codex: true, qwen: false });
});

test("subset probing deduplicates entries and drops unknown provider ids", async () => {
  const { calls, runner } = fakeRunner({ code: 0, stdout: "", stderr: "" });
  const result = await new RemoteProviderAccess(runner).probe(validHost, 15_000, ["codex", "codex", "claude", "bogus"]);

  const script = scriptFromCommand(calls[0].command);
  assert.equal(probeBlockCount(script), 2);
  assert.deepEqual(Object.keys(result.providers).sort(), ["claude", "codex"]);
});

test("an explicitly empty subset probes nothing but still answers reachability", async () => {
  const { calls, runner } = fakeRunner({ code: 0, stdout: "codex=1\n", stderr: "" });
  const result = await new RemoteProviderAccess(runner).probe(validHost, 15_000, []);

  const script = scriptFromCommand(calls[0].command);
  assert.equal(probeBlockCount(script), 0);
  assert.match(script, /\nwait\nexit 0$/u);
  assert.equal(result.reachable, true);
  assert.deepEqual(result.providers, {});
});

test("a failing ssh exit reports an unreachable host with no provider claims", async () => {
  const { runner } = fakeRunner({
    code: 255,
    stdout: "",
    stderr: "ssh: connect to host ru.internal.example port 22: Connection refused\r\n"
  });
  const result = await new RemoteProviderAccess(runner).probe(validHost);
  assert.equal(result.hostId, "ru-box");
  assert.equal(result.reachable, false);
  assert.deepEqual(result.providers, {});
  assert.equal(result.detail, "ssh: connect to host ru.internal.example port 22: Connection refused");
});

test("a killed ssh process (timeout) reports unreachable without throwing", async () => {
  const { runner } = fakeRunner({ code: null, stdout: "", stderr: "" });
  const result = await new RemoteProviderAccess(runner).probe(validHost);
  assert.equal(result.reachable, false);
  assert.deepEqual(result.providers, {});
  assert.equal(result.detail, "ssh exited with code unknown");
});

test("a throwing runner reports an unreachable host instead of rejecting", async () => {
  const result = await new RemoteProviderAccess(() => Promise.reject(new Error("probe timed out"))).probe(validHost);
  assert.equal(result.hostId, "ru-box");
  assert.equal(result.reachable, false);
  assert.deepEqual(result.providers, {});
  assert.equal(result.detail, "probe timed out");
});

test("unreachable detail is excerpted to 300 characters", async () => {
  const { runner } = fakeRunner({ code: 255, stdout: "", stderr: "x".repeat(1_000) });
  const result = await new RemoteProviderAccess(runner).probe(validHost);
  assert.equal(result.reachable, false);
  assert.equal(result.detail.length, 300);
});

test("an invalid host never reaches the runner and explains why", async () => {
  let calls = 0;
  const service = new RemoteProviderAccess(() => {
    calls += 1;
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  });
  const result = await service.probe({ ...validHost, sshHost: "ru.internal.example rm -rf" });
  assert.equal(result.hostId, "ru-box");
  assert.equal(result.reachable, false);
  assert.deepEqual(result.providers, {});
  assert.match(result.detail, /sshHost/);
  assert.equal(calls, 0);
});

// --- providerAccess validation and policy -----------------------------------

test("a valid providerAccess rule keeps the host valid, in both modes", () => {
  assert.equal(remoteHostInvalidReason({
    ...validHost,
    providerAccess: { mode: "allowlist", providers: ["qwen", "kimi"] }
  }), null);
  assert.equal(remoteHostInvalidReason({
    ...validHost,
    providerAccess: { mode: "blocklist", providers: ["codex", "grok"] }
  }), null);
});

test("providerAccess rejects an unknown mode", () => {
  assert.equal(
    remoteHostInvalidReason({ ...validHost, providerAccess: { mode: "denylist", providers: ["codex"] } }),
    "providerAccess.mode must be allowlist or blocklist"
  );
  assert.equal(
    remoteHostInvalidReason({ ...validHost, providerAccess: { providers: ["codex"] } }),
    "providerAccess must have exactly the mode and providers keys"
  );
});

test("providerAccess rejects duplicated provider ids", () => {
  assert.equal(
    remoteHostInvalidReason({ ...validHost, providerAccess: { mode: "allowlist", providers: ["codex", "codex"] } }),
    "providerAccess.providers must not repeat a provider id"
  );
});

test("providerAccess rejects empty and oversized provider lists", () => {
  assert.equal(
    remoteHostInvalidReason({ ...validHost, providerAccess: { mode: "allowlist", providers: [] } }),
    "providerAccess.providers must hold between 1 and 16 provider ids"
  );
  // Only 13 agent providers exist, so 17 entries must repeat — the size bound
  // fires before the duplicate check.
  const seventeen = [...Object.keys(EXPECTED_ENDPOINTS), "qwen", "kimi", "codex", "claude"];
  assert.equal(seventeen.length, 17);
  assert.equal(
    remoteHostInvalidReason({ ...validHost, providerAccess: { mode: "allowlist", providers: seventeen } }),
    "providerAccess.providers must hold between 1 and 16 provider ids"
  );
});

test("providerAccess rejects unknown provider ids, extra keys, and non-objects", () => {
  assert.equal(
    remoteHostInvalidReason({ ...validHost, providerAccess: { mode: "allowlist", providers: ["codex", "terminal"] } }),
    "providerAccess.providers contains an unknown provider id"
  );
  assert.equal(
    remoteHostInvalidReason({ ...validHost, providerAccess: { mode: "allowlist", providers: ["codex"], note: "x" } }),
    "providerAccess must have exactly the mode and providers keys"
  );
  assert.equal(
    remoteHostInvalidReason({ ...validHost, providerAccess: ["codex"] }),
    "providerAccess must be an object"
  );
});

test("providerPermittedOnHost: absent rule is unrestricted, allowlist only listed, blocklist all but listed", () => {
  assert.equal(providerPermittedOnHost(validHost, "codex"), true);
  assert.equal(providerPermittedOnHost(validHost, "grok"), true);

  const chineseOnly = { ...validHost, providerAccess: { mode: "allowlist", providers: ["qwen", "kimi"] } };
  assert.equal(providerPermittedOnHost(chineseOnly, "qwen"), true);
  assert.equal(providerPermittedOnHost(chineseOnly, "kimi"), true);
  assert.equal(providerPermittedOnHost(chineseOnly, "claude"), false);

  const notFromRu = { ...validHost, providerAccess: { mode: "blocklist", providers: ["codex", "claude", "grok"] } };
  assert.equal(providerPermittedOnHost(notFromRu, "codex"), false);
  assert.equal(providerPermittedOnHost(notFromRu, "claude"), false);
  assert.equal(providerPermittedOnHost(notFromRu, "grok"), false);
  assert.equal(providerPermittedOnHost(notFromRu, "qwen"), true);
});

test("PROVIDER_API_ENDPOINTS is the pinned beacon table and providerApiUrl builds its URLs", () => {
  assert.deepEqual({ ...PROVIDER_API_ENDPOINTS }, EXPECTED_ENDPOINTS);
  assert.equal(Object.isFrozen(PROVIDER_API_ENDPOINTS), true);
  assert.equal(providerApiUrl("codex"), "https://api.openai.com/");
  assert.equal(providerApiUrl("antigravity"), "https://antigravity.google/");
});

test("a provider access rule survives the settings store round-trip", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-access-rule-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory, "en");
  await store.load();
  await store.update({
    remoteHosts: [{
      id: "ru-server",
      label: "RU server",
      sshHost: "ru.example.internal",
      providerAccess: { mode: "allowlist", providers: ["qwen", "minimax", "kimi"] }
    }]
  });
  const reloaded = await new SettingsStore(directory, "en").load();
  assert.deepEqual(
    reloaded.remoteHosts[0].providerAccess,
    { mode: "allowlist", providers: ["qwen", "minimax", "kimi"] }
  );
});
