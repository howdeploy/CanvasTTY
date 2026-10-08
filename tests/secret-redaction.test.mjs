/**
 * The secret redaction registry (EP-8), ported from the local chain's credential and child-text redaction tests.
 * Every key-shaped fixture is assembled at run time, so the repository secret audit has nothing to find here.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SecretRedactionRegistry, redactCredentials } from "../src/main/services/safety/SecretRedaction.ts";
import { ProviderSecretsService } from "../src/main/services/ProviderSecretsService.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { SECRET_PATTERNS } from "../scripts/audit-secrets.mjs";

const run = (character, length) => character.repeat(length);
const sk = (...parts) => ["sk", ...parts].join("-");
const mixed = ["Q7vX2mK9", "pL4sT8wZ", "1nB6cR3y", "H5jD0fGa"].join(""); // 32 characters, high entropy
const secrets = {
  "private-key": `-----${"BEGIN"} RSA ${"PRIVATE"} KEY-----\n${run("M", 40)}\n-----${"END"} RSA ${"PRIVATE"} KEY-----`,
  anthropic: ["sk", "ant", run("a", 24)].join("-"),
  openai: sk(run("b", 30)),
  github: `${"ghp"}_${run("c", 30)}`,
  "github-pat": `${"github"}_pat_${run("D", 30)}`,
  slack: `${"xoxb"}-${run("1", 20)}`,
  aws: `${"AKIA"}${"ABCDEFGHIJKLMNOP"}`,
  jwt: [`${"eyJ"}${run("a", 12)}`, run("b", 12), run("c", 12)].join("."),
  xai: `${"xai"}-${run("Z", 30)}`,
  google: `${"AIza"}${run("Q", 35)}`
};

test("every credential shape is masked, including the ones the repository secret audit checks", () => {
  for (const [kind, secret] of Object.entries(secrets)) {
    const text = redactCredentials(`before ${secret} after`);
    assert.equal(text.includes(secret), false, kind);
    assert.match(text, /^before <redacted:[a-z-]+> after$/u, kind);
  }
  assert.equal(redactCredentials(`Authorization: Bearer ${run("t", 24)}`), "Authorization: <redacted:authorization>");
  assert.equal(redactCredentials(`curl -H "Bearer ${run("u", 24)}"`), `curl -H "Bearer <redacted:bearer>"`);
  assert.equal(redactCredentials(`https://deploy:${run("p", 12)}@example.test/repo`), "https://<redacted:url-credentials>@example.test/repo");
  assert.equal(redactCredentials("https://git@example.test/repo"), "https://git@example.test/repo", "a plain user name is not a credential");
  assert.equal(redactCredentials(`https://example.test/cb?code=7&access_token=${run("z", 16)}&sig=abc123`), "https://example.test/cb?code=7&access_token=<redacted:url-secret>&sig=<redacted:url-secret>");
  const clientSecret = ["client", "secret"].join("_");
  assert.equal(
    redactCredentials(`OPENAI_API_KEY=plainvalue123\n${clientSecret}: "two words here"\nPASSWD=hunter22 apiToken=abcd1234`),
    `OPENAI_API_KEY=<redacted:assignment>\n${clientSecret}: <redacted:assignment>\nPASSWD=<redacted:assignment> apiToken=<redacted:assignment>`
  );
  assert.equal(redactCredentials(`random ${mixed} end`), "random <redacted:high-entropy> end");
  assert.equal(redactCredentials(`ANTHROPIC_API_KEY=${secrets.anthropic}`), "ANTHROPIC_API_KEY=<redacted:anthropic>");
});

test("every positive fixture of the audit's credential patterns is masked", () => {
  const fixtures = {
    "private key": secrets["private-key"], "Anthropic token": secrets.anthropic, "OpenAI-style token": secrets.openai,
    "GitHub token": secrets.github, "Slack token": secrets.slack, "AWS access key": secrets.aws, JWT: secrets.jwt,
    "hard-coded secret assignment": `${["api", "key"].join("_")} = "${run("k", 16)}"`
  };
  for (const [rule, pattern] of SECRET_PATTERNS) {
    if (rule === "personal home path") continue;
    const fixture = fixtures[rule];
    assert.ok(fixture, `a fixture exists for ${rule}`);
    pattern.lastIndex = 0;
    assert.ok(pattern.test(fixture), `the fixture is positive for ${rule}`);
    pattern.lastIndex = 0;
    assert.equal(pattern.test(redactCredentials(fixture)), false, rule);
  }
});

test("ordinary text, paths and commit SHAs are unchanged; masking is idempotent", () => {
  for (const text of [
    "Fix the settings panel so that Save works; run npm test afterwards.",
    "src/renderer/src/features/settings/ProviderAccountsSettings2.tsx and /work/project/src/main/index.ts",
    `commit ${"3f2a9c1d4e5b6a7f8c9d0e1f2a3b4c5d6e7f8a9b"} fixed it`,
    "max_tokens: 4096, monkey = banana, keyboard=qwerty, the key point is clarity",
    "uuid 123e4567-e89b-12d3-a456-426614174000 and handleProviderAccountLaunchServiceFixture",
    "Hello world 1234\nline two 5678", "tokens: 4096", "secretary: Jane Doe", "TOKEN_COUNT=4096"
  ]) assert.equal(redactCredentials(text), text, text);
  const once = redactCredentials(`${secrets.openai} ${secrets.github} Authorization: Bearer ${run("t", 20)}`);
  assert.equal(redactCredentials(once), once);
});

test("masking stays linear on long runs of name-like text", () => {
  for (const unit of ["a-", "ab.", "Token-", "key_", "x.", "Ab1\n"]) {
    const started = performance.now();
    redactCredentials(unit.repeat(Math.floor(60000 / unit.length)));
    assert.ok(performance.now() - started < 1000, `${JSON.stringify(unit)} took ${Math.round(performance.now() - started)} ms`);
  }
});

test("registry: known-value matching avoids text-sized typed arrays", () => {
  const registry = new SecretRedactionRegistry();
  const key = "custom-secret-value-not-a-token";
  registry.add("vault", [key]);
  const plain = `${"x".repeat(1_000_000)}${key}`;
  const wrappedKey = `${key.slice(0, 12)}\n│ ${key.slice(12)}`;
  const wrapped = `${"x".repeat(1_000_000)}${wrappedKey}`;
  const NativeInt32Array = globalThis.Int32Array;
  const NativeUint32Array = globalThis.Uint32Array;
  let largestAllocation = 0;
  const track = (Native) => new Proxy(Native, {
    construct(target, args, newTarget) {
      largestAllocation = Math.max(largestAllocation, Number(args[0]) || 0);
      return Reflect.construct(target, args, newTarget);
    }
  });
  try {
    globalThis.Int32Array = track(NativeInt32Array);
    globalThis.Uint32Array = track(NativeUint32Array);
    assert.equal(registry.redact(plain), `${"x".repeat(1_000_000)}<redacted:secret>`);
    assert.equal(registry.redact(wrapped), `${"x".repeat(1_000_000)}<redacted:secret>`);
  } finally {
    globalThis.Int32Array = NativeInt32Array;
    globalThis.Uint32Array = NativeUint32Array;
  }
  assert.ok(largestAllocation < 256, `allocated a typed array with ${largestAllocation} elements for a short held value`);
});

test("high-entropy checks do not build per-character match arrays for long ordinary runs", () => {
  const ordinary = "x".repeat(1_000_000);
  const originalMatch = String.prototype.match;
  const largeMatchCalls = [];
  try {
    String.prototype.match = function (pattern) {
      if (this.length >= ordinary.length) largeMatchCalls.push(pattern.source);
      return originalMatch.call(this, pattern);
    };
    assert.equal(redactCredentials(ordinary), ordinary);
  } finally {
    String.prototype.match = originalMatch;
  }
  assert.deepEqual(largeMatchCalls, [], "entropy classification counts characters without collecting regex matches");
});

test("redaction handles max-cap ordinary runs with and without wrapped continuations", () => {
  for (const suffix of ["", "\nplain123"]) {
    const ordinary = `${"x".repeat(16_000_000)}${suffix}`;
    assert.equal(redactCredentials(ordinary), ordinary);
  }
});

/** What OpenCode printed in a live run: the config with its key, wrapped by the terminal inside a box. */
function boxedDump(key) {
  const config = `{"provider":{"x":{"options":{"baseURL":"https://api.example.test/v1","apiKey":"${key}"}}}}`;
  const lines = [];
  for (let at = 0; at < config.length; at += 40) lines.push(`│   ${config.slice(at, at + 40)}`);
  return `Error: Config file is not valid JSON(C):\n${lines.join("\r\n")}\n└─ fix the config and try again\n`;
}

test("registry: a held value is removed also when wrapping split it across box lines, and in its JSON-escaped form", () => {
  const registry = new SecretRedactionRegistry();
  const key = `${sk("cp", "Qx7vN2mK9pL4")}\\${"rT8wY1zB5cD3fG6hJ0aE"}`; // a key holding a backslash
  registry.add("vault", [key, "cat"]);
  const screen = boxedDump(JSON.stringify(key).slice(1, -1));
  const redacted = registry.redact(screen);
  for (const part of [key.slice(0, 12), key.slice(12, 24), key.slice(24)]) assert.equal(redacted.replace(/\s|│/gu, "").includes(part), false, part);
  assert.match(redacted, /not valid JSON\(C\)/u, "the rest of the screen stays readable");
  const escaped = JSON.stringify(key).slice(1, -1);
  assert.equal(registry.redact(`key: ${escaped.slice(0, 15)}\n      ${escaped.slice(15)} done`), "key: <redacted:secret> done");
  assert.equal(registry.redact(redacted), redacted, "idempotent");
  assert.equal(registry.redact("the cat sat"), "the cat sat", "values too short to be keys are ignored");
  // Owners are forgotten on their own: a closed card's launch secret stops being searched for.
  const launch = ["launch", "secret", "4d9e1b77"].join("-");
  registry.add("session:a", [launch]);
  assert.equal(registry.redact(`x ${launch}`), "x <redacted:secret>");
  registry.clear("session:a");
  assert.equal(registry.redact(`x ${launch}`), `x ${launch}`);
});

test("registry: overlapping registered secrets are masked as one complete range", () => {
  const registry = new SecretRedactionRegistry();
  registry.add("vault", ["abcdefgh", "abcdefghi", "defghijklmnop"]);
  assert.equal(registry.redact("abc\n│ defghi tail"), "<redacted:secret> tail", "wrapped match at one start chooses the longer value");
  assert.equal(registry.redact("abcdefghi tail"), "<redacted:secret> tail", "unwrapped matches at one start choose the longer value");
  assert.equal(registry.redact("abcdefghi"), "<redacted:secret>", "wrap-free input preserves longest-match precedence");
  assert.equal(registry.redact("abcdefghijklmnop tail"), "<redacted:secret> tail", "a later overlapping secret cannot expose its suffix");
});

test("registry: exact streams retain an overlap after an earlier match skips intervening hits", () => {
  const registry = new SecretRedactionRegistry();
  const overlapping = "abcabcabcabc";
  registry.add("vault", ["xyabcabc", overlapping]);
  assert.equal(registry.redact(`xy${"abc".repeat(8)}`), "<redacted:secret>");
});

test("registry: every terminal wrap character is removed from the search view", () => {
  const registry = new SecretRedactionRegistry();
  const value = "wrap-character-equivalence-key";
  registry.add("vault", [value]);
  const wrapCharacters = [
    ...Array.from({ length: 5 }, (_, index) => String.fromCharCode(0x09 + index)), " ", "\u00a0", "\u1680",
    ...Array.from({ length: 11 }, (_, index) => String.fromCharCode(0x2000 + index)),
    "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff",
    ...Array.from({ length: 0x80 }, (_, index) => String.fromCharCode(0x2500 + index))
  ];
  const gaps = Array.from({ length: value.length - 1 }, () => []);
  for (let index = 0; index < wrapCharacters.length; index++) {
    gaps[Math.floor(index * gaps.length / wrapCharacters.length)].push(wrapCharacters[index]);
  }
  let wrapped = "";
  for (let index = 0; index < value.length; index++) wrapped += value[index] + (gaps[index]?.join("") ?? "");
  assert.equal(registry.redact(wrapped), "<redacted:secret>");
});

test("registry: an invalid longer wrapped candidate does not hide a valid shorter candidate", () => {
  const registry = new SecretRedactionRegistry();
  const shorter = "custom-secret-value-not-a-token";
  const longer = `${shorter}-tail`;
  registry.add("vault", [shorter, longer]);
  const text = `${shorter}${" ".repeat(65)}-tail`;
  assert.equal(registry.redact(text), `<redacted:secret>${" ".repeat(65)}-tail`);
});

test("registry: exact-only wrapped values work when no bare candidate is present", () => {
  const registry = new SecretRedactionRegistry();
  registry.add("vault", ["abc    def", "not-present-secret"]);
  assert.equal(registry.redact("abc    def"), "<redacted:secret>");
});

test("registry: wrapped overlaps survive the shared offset horizon and UTF-16 tail cut", () => {
  const registry = new SecretRedactionRegistry();
  registry.add("vault", ["a".repeat(8), "a".repeat(10)]);
  const tail = 4_000;
  const base = scrollback(80_000);
  const sample = `😀${Array.from({ length: 12 }, () => "a").join("\n│ ")}`;
  // Place the first match three UTF-16 code units before the masked output's tail cut.
  const removed = 12 + 11 * 3 - "<redacted:secret>".length;
  const at = base.length + sample.length - removed - tail - 3 - "😀".length;
  const text = `${base.slice(0, at)}${sample}${base.slice(at)}`;
  const masked = registry.redact(text);
  const marker = masked.indexOf("<redacted:secret>");
  assert.equal(marker, masked.length - tail - 3);
  assert.equal(masked.slice(marker - 2, marker), "😀");
  assert.ok(masked.includes("<redacted:secret>"));
  assert.ok(!masked.includes("\n│ a"), "every overlapping wrapped suffix is masked");
  assert.equal(registry.redactTail(text, tail), masked.slice(-tail));
});

test("registry: a value added again stays masked when an owner is full; only the least recently added one goes", (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (message) => warnings.push(String(message)));
  const registry = new SecretRedactionRegistry();
  const value = (index) => `custom-value-${String(index).padStart(4, "0")}-qwertyuiop`;
  registry.add("vault", Array.from({ length: 64 }, (_, index) => value(index)));
  // The first key is read again (still in use), then a new one arrives.
  registry.add("vault", [value(0)]);
  registry.add("vault", [value(64)]);
  assert.equal(registry.redact(`a ${value(0)} b`).includes(value(0)), false, "the key still in use stays masked");
  assert.equal(registry.redact(`a ${value(64)} b`).includes(value(64)), false);
  assert.equal(registry.redact(`a ${value(1)} b`).includes(value(1)), true, "the least recently added one was dropped");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes("qwertyuiop"), false, "the log never names a value");
});

test("registry: generic shapes without a held value, including keys the terminal wrapped over lines", () => {
  const registry = new SecretRedactionRegistry();
  const unknown = ["Zp8Rk2Wq", "5Tn9Xm3V", "b7Lc4Hd1", "Gs6Jf0Ay"].join("");
  const json = registry.redact(`{"apiKey":"${unknown.slice(0, 10)}\n    ${unknown.slice(10)}","baseURL":"https://x.example"}`);
  assert.equal(json.includes(unknown.slice(0, 10)) || json.includes(unknown.slice(10)), false);
  assert.match(json, /"baseURL":"https:\/\/x\.example"/u);
  const key = sk("A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6");
  const wrapped = registry.redact(`${key.slice(0, 25)}\n${key.slice(25)} ok\nnext line`);
  assert.equal(wrapped, "<redacted:openai> ok\nnext line");
  const random = registry.redact(`token ${unknown.slice(0, 16)}\n  ${unknown.slice(16)}\nplain words`);
  assert.equal(random.includes(unknown.slice(16)), false);
  assert.match(random, /plain words/u);
});

test("registry: held structural words cannot disable generic credential masking", () => {
  const registry = new SecretRedactionRegistry();
  const privateKeyWords = ["PRIVATE", "KEY"].join(" ");
  const passwordLabel = ["pass", "word"].join("");
  const authorizationLabel = ["Author", "ization"].join("");
  const embeddedToken = sk(run("R", 30));
  const fullRegisteredValue = `credential-envelope-${embeddedToken}-private-suffix`;
  registry.add("vault", [privateKeyWords, passwordLabel, authorizationLabel, fullRegisteredValue]);

  const pem = `-----BEGIN RSA ${privateKeyWords}-----\n${run("M", 64)}\n-----END RSA ${privateKeyWords}-----`;
  assert.equal(registry.redact(pem), "<redacted:private-key>", "a held header fragment must not hide the PEM structure");

  const assignment = `${passwordLabel}: ${"ordinary-secret-value-123"}`;
  const redactedAssignment = registry.redact(assignment);
  assert.equal(redactedAssignment.includes("ordinary-secret-value-123"), false, "the assignment value remains hidden after its label is masked");
  assert.match(redactedAssignment, /<redacted:assignment>/u);

  const json = `{"${passwordLabel}":"${"ordinary-json-secret-456"}"}`;
  const redactedJson = registry.redact(json);
  assert.equal(redactedJson.includes("ordinary-json-secret-456"), false, "the JSON value remains hidden after its key is masked");

  const authorization = `${authorizationLabel}: Basic ${"opaqueCredentialValue123"}`;
  const redactedAuthorization = registry.redact(authorization);
  assert.equal(redactedAuthorization.includes("opaqueCredentialValue123"), false, "the authorization value remains hidden after its header is masked");
  assert.match(redactedAuthorization, /<redacted:authorization>/u);

  assert.equal(registry.redact(fullRegisteredValue), "<redacted:secret>", "an inner generic token cannot split a longer registered value");
});

test("registry: empty-registry fast path preserves overlapping JSON and generic redaction", () => {
  const empty = new SecretRedactionRegistry();
  const rangePath = new SecretRedactionRegistry();
  rangePath.add("vault", ["unrelated-held-fixture-value-32"]);
  const privateKeyWords = ["PRIVATE", "KEY"].join(" ");
  const pem = (body) => `-----BEGIN RSA ${privateKeyWords}-----\n${body}\n-----END RSA ${privateKeyWords}-----`;
  const apiKey = ["api", "Key"].join("");
  const authorization = ["Author", "ization"].join("");
  const basic = ["B", "asic"].join("");
  const url = `https://u:pw@fixture.example/?access_token=${run("Q", 12)}`;
  const samples = [
    [`{"${apiKey}":"${pem(run("M", 24))}"}`, `{"${apiKey}":"<redacted:secret>"}`],
    [`{"${authorization}":"${authorization}: ${basic} ${"opaqueCredentialValue123"}"}`, `{"${authorization}":"<redacted:secret>"}`],
    [`{"token":"${url}"}`, `{"token":"<redacted:secret>"}`],
    [pem(`{"${apiKey}":"${"ordinary-json-secret-456"}"}`), "<redacted:private-key>"]
  ];

  for (const [sample, expected] of samples) {
    const fastPath = empty.redact(sample);
    assert.equal(fastPath, rangePath.redact(sample), sample.slice(0, 32));
    assert.equal(fastPath, expected, sample.slice(0, 32));
    assert.equal(fastPath.includes("opaqueCredentialValue123") || fastPath.includes("ordinary-json-secret-456"), false);
  }
});

test("the vault hands every value it reads or writes to the registry; agent-readable text is masked", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-redaction-vault-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new SecretRedactionRegistry();
  const encryption = { isAvailable: () => true, encrypt: (value) => Buffer.from(value, "utf8"), decrypt: (value) => value.toString("utf8") };
  const value = ["vault", "value", "9c1e7a55"].join("-");
  await new ProviderSecretsService(directory, encryption, (values) => registry.add("vault", values)).set("OPENAI_API_KEY", value);
  const reread = new SecretRedactionRegistry();
  await new ProviderSecretsService(directory, encryption, (values) => reread.add("vault", values)).status();
  assert.equal(reread.redact(`key ${value}`), "key <redacted:secret>", "read back in a later run too");

  const manager = new TerminalManager(() => undefined, { get: () => ({ state: "unavailable" }), snapshot: () => ({}) });
  manager.configureRedaction(registry);
  const control = new AgentControlService({
    getMetadata: (id) => (id === "s1" ? { id: "s1", provider: "claude", status: "working", exitCode: null } : null),
    readBuffer: () => ({ buffer: `env OPENAI=${value}\n${secrets.github}\n` }),
    redactSecrets: (text) => manager.redactSecrets(text)
  });
  const observed = control.observe("s1").output;
  assert.equal(observed.includes(value) || observed.includes(secrets.github), false);
  assert.match(observed, /env OPENAI=<redacted:secret>/u);
});

// A custom secret with no generic token shape: once its head is cut away, nothing but the full value identifies it.
const PLAIN_SECRET = "purple-otter-marmalade-sings-loudly";
const fragments = (text) => {
  const found = [];
  for (let size = 6; size < PLAIN_SECRET.length; size++) {
    for (let start = 0; start + size <= PLAIN_SECRET.length; start++) {
      const piece = PLAIN_SECRET.slice(start, start + size);
      if (/[a-z]-[a-z]/u.test(piece) && text.includes(piece)) found.push(piece);
    }
  }
  return found;
};

function cutFixture(t) {
  const registry = new SecretRedactionRegistry();
  registry.add("plugin:p.custom", [PLAIN_SECRET]);
  const prints = [];
  const exits = [];
  let sessions;
  const terminals = new TerminalManager((channel, payload) => sessions?.observe(channel, payload),
    { get: (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: {}, checked: [] }), snapshot: () => ({}) },
    undefined, undefined, true, () => ({ pid: 1, write() {}, resize() {}, kill() {},
      onData(listener) { prints.push(listener); return { dispose() {} }; },
      onExit(listener) { exits.push(listener); return { dispose() {} }; } }));
  t.after(() => terminals.shutdown());
  terminals.configureRedaction(registry);
  const card = terminals.create({ provider: "claude", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
  return { terminals, card, print: (text) => prints.forEach((listener) => listener(text)), exit: (code) => exits.forEach((listener) => listener({ exitCode: code })),
    attach: (value) => { sessions = value; } };
}

test("observe_agent and get_agent_result mask the whole buffer before cutting the tail: no fragment of a custom secret survives", async (t) => {
  const f = cutFixture(t);
  const control = new AgentControlService(f.terminals);
  // The 300-character observation starts 12 characters before the secret ends.
  f.print(`${"a".repeat(1_000)}${PLAIN_SECRET}${"b".repeat(288)}`);
  const observed = control.observe(f.card.id, 300).output;
  assert.ok(observed.length <= 300, "the bound is kept");
  assert.deepEqual(fragments(observed), []);
  // get_agent_result's 8 192-character tail, cut inside the secret the same way.
  f.print(`${PLAIN_SECRET}${"c".repeat(8_192 - 10)}`);
  const result = control.result(f.card.id).output;
  assert.ok(result.length <= 8_192);
  assert.deepEqual(fragments(result), []);
  // Wrapped secrets are still masked whole.
  f.print(`\r\n${PLAIN_SECRET.slice(0, 15)}\r\n${PLAIN_SECRET.slice(15)}\r\n`);
  assert.deepEqual(fragments(control.observe(f.card.id, 8_192).output), []);
});

test("plugin screen text and failure details mask the whole buffer before cutting", async (t) => {
  const { PluginSessions } = await import("../src/main/services/PluginSessions.ts");
  const f = cutFixture(t);
  const screens = [];
  const sessions = new PluginSessions({ terminals: f.terminals, notify: (_p, _s, _m, event) => { if (event.screen !== undefined) screens.push(event.screen); return true; } });
  f.attach(sessions);
  sessions.handle("p.reader", "svc", "sessions.subscribe", {}, ["sessions:events", "sessions:read-screen"]);
  // The 4 000-character screen starts 12 characters before the secret ends.
  f.print(`${PLAIN_SECRET}${"d".repeat(4_000 - 12)}`);
  f.terminals.applyProviderSignal(f.card.id, { kind: "lifecycle", state: "working" });
  f.terminals.applyProviderSignal(f.card.id, { kind: "lifecycle", state: "idle" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(screens.length > 0 && screens.every((screen) => screen.length <= 4_000));
  assert.deepEqual(fragments(screens.join("\n")), []);
  // Failure details keep the last 8 000 characters of the output: cut inside the secret too.
  f.print(`\r\n${"e".repeat(50)}${PLAIN_SECRET}${"f".repeat(8_000 - 1 - 12)}`);
  f.exit(3);
  const failed = f.terminals.list().find((session) => session.id === f.card.id);
  assert.equal(failed.status, "failed");
  assert.ok(failed.failureDetails.length <= 8_000);
  assert.deepEqual(fragments(failed.failureDetails), []);
});

// Ordinary agent output around the secrets below: colour, paths, numbers, box sides.
function scrollback(chars) {
  let text = "";
  for (let i = 0; text.length < chars; i++) {
    text += `\x1b[32m✓\x1b[0m step ${i} src/main/Example.ts:${i} took ${i % 97} ms\r\n`;
    if (i % 9 === 0) text += `│ ${"─".repeat(40)} │\r\n`;
  }
  return text.slice(0, chars);
}

test("redactTail matches whole-text masking at selected tail and masking-window boundaries", () => {
  const registry = new SecretRedactionRegistry();
  registry.add("plugin:p.custom", [PLAIN_SECRET]);
  const wrapped = `${PLAIN_SECRET.slice(0, 15)}\r\n${PLAIN_SECRET.slice(15)}`;
  const pem = (body) => `-----${"BEGIN"} RSA ${"PRIVATE"} KEY-----\n${body}\n-----${"END"} RSA ${"PRIVATE"} KEY-----`;
  const base = scrollback(240_000);
  const replace = (sample, at) => {
    assert.ok(at >= 0 && at + sample.length <= base.length, "replacement fits within the fixed-length scrollback");
    const text = `${base.slice(0, at)}${sample}${base.slice(at + sample.length)}`;
    assert.equal(text.length, base.length, "replacement keeps the returned-tail boundary fixed");
    return text;
  };
  const assertTailEquivalent = (name, sample, tail, at) => {
    const cut = base.length - tail;
    assert.ok(at < cut && at + sample.length > cut, `${name} straddles the returned-tail boundary`);
    const text = replace(sample, at);
    assert.equal(registry.redactTail(text, tail), registry.redact(text).slice(-tail), name);
  };
  const tailCases = [
    ["held plain", PLAIN_SECRET, 300],
    ["held wrapped", wrapped, 4_000],
    ["OpenAI token", secrets.openai, 8_192],
    ["GitHub token", secrets.github, 300],
    ["JWT", secrets.jwt, 4_000],
    ["Google key", secrets.google, 8_192],
    ["high-entropy value", mixed, 300],
    ["wrapped OpenAI token", `\r\n${sk(run("q", 18))}\r\n${run("7", 12)}x${run("R", 8)}\r\n`, 4_000],
    ["JSON assignment", `"apiKey": "${run("k", 30)}"`, 8_192],
    ["environment assignment", `export OPENAI_API_KEY=${run("v", 24)}`, 300],
    ["Bearer credential", `Authorization: Bearer ${run("t", 24)}`, 4_000],
    ["URL credentials", `https://deploy:${run("p", 12)}@example.test/repo`, 8_192],
    ["closed PEM", pem(run("M", 64)), 300],
    ["long PEM", pem(`${run("N", 64)}\n`.repeat(400)), 16_384]
  ];
  for (const [name, sample, tail] of tailCases) {
    const cut = base.length - tail;
    assertTailEquivalent(`${name} centered across tail cut`, sample, tail, cut - Math.floor(sample.length / 2));
  }

  // Exercise both extreme overlaps: only one source code unit sits on either side of the cut.
  for (const [name, sample, tail] of [
    ["held plain", PLAIN_SECRET, 300],
    ["held wrapped", wrapped, 4_000],
    ["environment assignment", `export OPENAI_API_KEY=${run("v", 24)}`, 8_192]
  ]) {
    const cut = base.length - tail;
    assertTailEquivalent(`${name} starts one unit before tail cut`, sample, tail, cut - 1);
    assertTailEquivalent(`${name} ends one unit after tail cut`, sample, tail, cut - sample.length + 1);
  }

  // Cross the bounded redaction-window edge and the actual tail with unbounded multiline matches.
  const tail = 16_384;
  const cut = base.length - tail;
  const windowStart = cut - 16_384;
  for (const [name, sample] of [
    ["wrapped token", `${sk(run("w", 22))}${`\n${run("1", 3)}${run("x", 76)}`.repeat(400)}`],
    ["multiline authorization", `Authorization:${"\n".repeat(20_000)}${run("A", 24)}`],
    ["multiline JSON assignment", `"apiKey":${"\n".repeat(20_000)}"${run("J", 30)}"`],
    ["long PEM", pem(`${run("P", 64)}\n`.repeat(400))]
  ]) {
    assertTailEquivalent(`${name} crosses masking window and tail`, sample, tail, windowStart - 1);
  }

  // An open PEM header before the window controls masking through the tail, despite having no footer.
  const openHeader = `-----${"BEGIN"} ${"PRIVATE"} KEY-----\n`;
  const openTail = 4_000;
  const openCut = base.length - openTail;
  const openWindowStart = openCut - 16_384;
  const openAt = openWindowStart - 1;
  const open = replace(openHeader, openAt);
  assert.ok(openAt < openWindowStart && openAt + openHeader.length < openCut && openCut < base.length, "open PEM begins before the masking window and remains open through the tail");
  assert.equal(registry.redactTail(open, openTail), registry.redact(open).slice(-openTail));

  // Empty input and an empty tail are stable edge cases.
  assert.equal(registry.redactTail("", 10), "");
  assert.equal(registry.redactTail(`x ${PLAIN_SECRET}`, 0), "");
});

test("redactTail masks a window around the tail, not the whole scrollback", () => {
  class Measured extends SecretRedactionRegistry {
    lengths = [];
    redact(text) { this.lengths.push(text.length); return super.redact(text); }
  }
  const registry = new Measured();
  registry.add("plugin:p.custom", [PLAIN_SECRET]);
  const text = `${scrollback(240_000)}${PLAIN_SECRET}${"z".repeat(100)}`;
  const masked = registry.redactTail(text, 8_192);
  assert.deepEqual(fragments(masked), []);
  assert.ok(Math.max(...registry.lengths) <= 8_192 + 16_384 + 4_096, `masked ${registry.lengths} characters`);
  // A held value that could wrap over the margin widens the window with it (each gap may hold 64 characters);
  // one that could span the whole scrollback means masking the whole text.
  registry.lengths.length = 0;
  registry.add("plugin:p.long", [run("L", 400)]);
  assert.deepEqual(fragments(registry.redactTail(text, 8_192)), []);
  const widened = Math.max(...registry.lengths);
  assert.ok(widened > 8_192 + 2 * 400 * 65 && widened < text.length, `masked ${widened} characters`);
  registry.lengths.length = 0;
  registry.add("plugin:p.longer", [run("K", 2_000)]);
  registry.redactTail(text, 8_192);
  assert.equal(Math.max(...registry.lengths), text.length);
});

test("observe_agent, get_agent_result and the plugin screen mask a bounded window of a full scrollback", async (t) => {
  const f = cutFixture(t);
  const masked = [];
  const registry = f.terminals.redaction;
  const redact = registry.redact.bind(registry);
  registry.redact = (text) => { masked.push(text.length); return redact(text); };
  f.print(scrollback(250_000));
  f.print(`${PLAIN_SECRET}${"g".repeat(200)}`);
  const control = new AgentControlService(f.terminals);
  assert.deepEqual(fragments(control.observe(f.card.id).output), []);
  assert.deepEqual(fragments(control.result(f.card.id).output), []);
  const { PluginSessions } = await import("../src/main/services/PluginSessions.ts");
  const screens = [];
  const sessions = new PluginSessions({ terminals: f.terminals, notify: (_p, _s, _m, event) => { if (event.screen !== undefined) screens.push(event.screen); return true; } });
  f.attach(sessions);
  sessions.handle("p.reader", "svc", "sessions.subscribe", {}, ["sessions:events", "sessions:read-screen"]);
  f.terminals.applyProviderSignal(f.card.id, { kind: "lifecycle", state: "working" });
  f.terminals.applyProviderSignal(f.card.id, { kind: "lifecycle", state: "idle" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(screens.length > 0);
  assert.deepEqual(fragments(screens.join("\n")), []);
  assert.ok(masked.length >= 3 && Math.max(...masked) < 40_000, `masked ${masked} characters per call`);
});

/**
 * A held value of `length` characters that no generic rule would catch (short lower-case runs between `.`, `/`
 * and `:`), so only the registry can mask it; `quoted` adds a quote and a backslash (its JSON form differs).
 */
function longSecret(length, seed = 7, quoted = false) {
  let state = seed;
  const next = () => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return Math.floor(state / 65_536); };
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789";
  let value = quoted ? 'q"\\' : "";
  while (value.length < length) {
    for (let i = 3 + (next() % 5); i > 0; i--) value += letters[next() % letters.length];
    value += ".:/"[next() % 3];
  }
  return value.slice(0, length);
}

/** Slices of the value that must not survive masking: a 24-character piece every 997 characters, and its end. */
function longFragments(text, value) {
  const found = [];
  for (let at = 0; at + 24 <= value.length; at += 997) if (text.includes(value.slice(at, at + 24))) found.push(at);
  if (text.includes(value.slice(-24))) found.push(value.length - 24);
  return found;
}

/** What a terminal of `columns` columns shows: the text cut into lines, each after a box side. */
function wrapped(text, columns = 80) {
  const lines = [];
  for (let at = 0; at < text.length; at += columns) lines.push(text.slice(at, at + columns));
  return lines.join("\r\n│ ");
}

test("registry: held values of 4k, 16k and 64k characters are masked whole, also wrapped and JSON-escaped", () => {
  for (const length of [3_800, 4_096, 16_384, 65_536]) {
    const registry = new SecretRedactionRegistry();
    const value = longSecret(length, length, true);
    registry.add("vault", [value, PLAIN_SECRET]);
    const plain = registry.redact(`before ${value} after ${PLAIN_SECRET}`);
    assert.equal(plain, "before <redacted:secret> after <redacted:secret>", `${length} plain`);
    const screen = registry.redact(`$ cat key\r\n${wrapped(value)}\r\n$ `);
    assert.equal(screen, "$ cat key\r\n<redacted:secret>\r\n$ ", `${length} wrapped`);
    const json = registry.redact(JSON.stringify({ value, note: "kept" }));
    assert.deepEqual(longFragments(json, JSON.stringify(value).slice(1, -1)), [], `${length} JSON-escaped`);
    assert.match(json, /"note":"kept"/u);
    // Two halves further apart than a wrap gap are two unrelated texts, not the value.
    const apart = `${value.slice(0, length / 2)}${" ".repeat(65)}${value.slice(length / 2)}`;
    assert.equal(registry.redact(apart), apart, `${length} split by more than a wrap gap`);
  }
});

test("registry: maximum-length repetitive values mask dense overlapping occurrences", () => {
  const registry = new SecretRedactionRegistry();
  const value = "a".repeat(65_536);
  registry.add("vault", [value]);
  const text = "a".repeat(150_000);
  assert.equal(registry.redact(text), "<redacted:secret>");
});

test("registry: long native-prefix skips preserve UTF-16 matches", () => {
  const registry = new SecretRedactionRegistry();
  const value = `😀${"x".repeat(127)}`;
  const distinctPrefix = `abcdefgH${"x".repeat(130)}`;
  registry.add("vault", [value, distinctPrefix]);
  assert.equal(registry.redact(`before 🛡️${value} after`), "before 🛡️<redacted:secret> after");
  assert.equal(registry.redact(distinctPrefix), "<redacted:secret>");
});

test("registry: a long held value never breaks masking of anything else", () => {
  const registry = new SecretRedactionRegistry();
  registry.add("plugin:p.big", [longSecret(4_000)]);
  registry.add("session:a", [PLAIN_SECRET]);
  assert.doesNotThrow(() => registry.redact("nothing to see"));
  assert.equal(registry.redact(`x ${PLAIN_SECRET} ${secrets.openai}`), "x <redacted:secret> <redacted:openai>");
  assert.equal(registry.redactTail(`x ${PLAIN_SECRET}`, 100), "x <redacted:secret>");
  // Longer than any key the registry holds: ignored, as a value shorter than a key is.
  const oversized = longSecret(65_537);
  registry.add("plugin:p.huge", [oversized]);
  assert.equal(registry.redact(`y ${PLAIN_SECRET}`), "y <redacted:secret>");
});

test("registry: masking held values stays linear, even for values that overlap themselves", () => {
  const registry = new SecretRedactionRegistry();
  // Every position of the text starts a near-match: a naive search would compare ~4 000 characters at each.
  registry.add("vault", [`${"a".repeat(4_000)}b`, `${"a".repeat(64_000)}c`, "a".repeat(9), longSecret(16_384)]);
  for (const text of ["a".repeat(240_000), `${"a ".repeat(120_000)}`, `${"a\r\n│ ".repeat(60_000)}`]) {
    const started = performance.now();
    const masked = registry.redact(text);
    assert.ok(performance.now() - started < 1_500, `${JSON.stringify(text.slice(0, 6))} took ${Math.round(performance.now() - started)} ms`);
    assert.ok(!/a{9}/u.test(masked.replace(/<redacted:[a-z-]+>/gu, "")), "the short held value is masked where it stands");
  }
});

test("redactTail with long held values equals masking the whole text and cutting it, wherever the value falls", () => {
  const base = scrollback(240_000);
  for (const length of [4_096, 16_384]) {
    const registry = new SecretRedactionRegistry();
    const value = longSecret(length, length + 1);
    registry.add("plugin:p.long", [value]);
    for (const sample of [value, wrapped(value)]) {
      for (const tail of [4_000, 8_192]) {
        for (const at of [base.length - tail - Math.floor(sample.length / 2), base.length - tail - 16_384 - Math.floor(sample.length / 2), base.length - 10]) {
          const text = `${base.slice(0, at)}${sample}${base.slice(at)}`;
          const cut = registry.redactTail(text, tail);
          assert.equal(cut, registry.redact(text).slice(-tail), `${length} ${tail} ${at}`);
          assert.deepEqual(longFragments(cut, value), [], `${length} ${tail} ${at}: no fragment of the value survives the cut`);
        }
      }
    }
  }
});

test("registry: an accepted value is masked where it stands even when its wrap characters leave fewer than eight others", () => {
  const registry = new SecretRedactionRegistry();
  const spaced = ["abc", "defg"].join(" ");
  const tabbed = ["abc", "defg"].join("\t");
  const broken = ["abc", "defg"].join("\n");
  const sparse = ["a", "b"].join(" ".repeat(7));
  // Two halves further apart than a wrap gap, but that is how the value itself is written.
  const gapped = ["abcd", "efgh"].join(" ".repeat(70));
  registry.add("test", [spaced, tabbed, broken, sparse, gapped]);
  for (const value of [spaced, tabbed, broken, sparse, gapped]) {
    assert.equal(registry.redact(`x ${value} y`), "x <redacted:secret> y", JSON.stringify(value));
    assert.equal(registry.redact(`{"v":"${JSON.stringify(value).slice(1, -1)}"}`), `{"v":"<redacted:secret>"}`, `${JSON.stringify(value)} JSON-escaped`);
  }
  // Only the value as written: its characters alone, or with other gaps, are ordinary text.
  for (const text of ["a b", "ab", "a  b", "abcdefg"]) assert.equal(registry.redact(`x ${text} y`), `x ${text} y`, text);
  const base = scrollback(60_000);
  for (const at of [base.length - 8_192 - 3, base.length - 8_192 - 16_384 - 4]) {
    const text = `${base.slice(0, at)}${spaced}${base.slice(at)}`;
    assert.equal(registry.redactTail(text, 8_192), registry.redact(text).slice(-8_192), `tail at ${at}`);
  }
});

test("redactTail equals masking the whole text when a match with no length bound starts before the window", () => {
  const registry = new SecretRedactionRegistry();
  const pem = (body) => `-----${"BEGIN"} RSA ${"PRIVATE"} KEY-----\n${body}\n-----${"END"} RSA ${"PRIVATE"} KEY-----`;
  const wrappedToken = `${sk(run("w", 22))}${`\n${run("1", 3)}${run("x", 76)}`.repeat(500)}`;
  const long = {
    "quoted assignment": `password="${"a ".repeat(20_000)}"`,
    "single-quoted assignment": `api_key='${"b ".repeat(20_000)}'`,
    "unquoted assignment": `export GITHUB_TOKEN=${"c".repeat(40_000)}`,
    "assignment over blank lines": `SECRET_KEY =${"\n".repeat(30_000)}${run("d", 12)}`,
    "authorization over spaces": `Authorization:${" ".repeat(30_000)}${run("e", 12)}`,
    "bearer over lines": `Bearer${"\r\n".repeat(15_000)}${run("f", 12)}`,
    "url query": `https://example.test/?token=${"g".repeat(40_000)}`,
    "url userinfo": `https://${"h".repeat(40_000)}:pw@example.test/`,
    "json key over lines": `"apiKey":${"\n".repeat(30_000)}"${run("i", 30)}"`,
    "wrapped token": wrappedToken,
    "nested private-key header": pem(`${run("N", 64)}\n`.repeat(200) + pem(run("M", 64)).split("\n-----END")[0])
  };
  const base = scrollback(40_000);
  for (const [name, sample] of Object.entries(long)) {
    for (const maxChars of [300, 8_192]) {
      // The match ends just inside the tail, a little before it, and far before it.
      for (const after of [maxChars - 40, maxChars + 200, maxChars + 12_000]) {
        const at = base.length - after;
        const text = `${base.slice(0, at)}\n${sample}\n${base.slice(at)}`;
        assert.equal(registry.redactTail(text, maxChars), registry.redact(text).slice(-maxChars), `${name} ${maxChars} ${after}`);
      }
    }
  }
  // A held value that holds a private key: masking it decides where the PEM rule sees a block.
  const armoured = new SecretRedactionRegistry();
  const keyValue = `{"private_key": "${pem(run("K", 64)).replace(/\n/gu, "\\n")}", "id": "${run("j", 12)}"}`;
  armoured.add("plugin:p.sa", [pem(`${run("P", 64)}\n`.repeat(3)), keyValue]);
  for (const after of [8_192 - 40, 8_192 + 200, 8_192 + 16_384 + 100]) {
    const at = base.length - after;
    const text = `${base.slice(0, at)}\n${pem(`${run("P", 64)}\n`.repeat(3))}\n${pem(run("Q", 64))}\n${base.slice(at)}`;
    assert.equal(armoured.redactTail(text, 8_192), armoured.redact(text).slice(-8_192), `held private key ${after}`);
  }
  // The case from review: an otherwise empty registry and one long quoted value.
  const text = `start\n${long["quoted assignment"]}\nend`;
  assert.equal(registry.redactTail(text, 8_192), registry.redact(text).slice(-8_192));
  assert.equal(registry.redactTail(text, 8_192).includes("a a a"), false);
});
