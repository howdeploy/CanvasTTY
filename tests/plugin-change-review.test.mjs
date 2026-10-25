import assert from "node:assert/strict";
import test from "node:test";
import { PluginCards } from "../src/main/services/PluginCards.ts";
import { normalizeCardActionInput, normalizeCardReview } from "../src/main/services/PluginChangeReviews.ts";

const textPage = (text, label) => ({ text, label, startLine: 0, totalLines: 1, hasMore: false });
const review = () => ({
  title: "Task results", acceptActionId: "accept", rejectActionId: "reject",
  groups: [{ sessionId: "worker", title: "Worker", files: [{ path: "source.txt", diff: "+ PRIVATE_KEY_VALUE",
    conflict: { current: textPage("current PRIVATE_KEY_VALUE", "Agent: peer PRIVATE_KEY_VALUE"), agent: textPage("agent PRIVATE_KEY_VALUE", "Agent: worker") } }] }]
});
const mask = text => text.replaceAll("PRIVATE_KEY_VALUE", "[MASKED]");
const actions = new Set(["review", "accept", "reject"]);

test("card actions retain their trusted session and mask structured file review and both conflict sides", async () => {
  const calls = [];
  const trustedSession = { id: "root", role: "orchestrator", provider: "codex" };
  const cards = new PluginCards({
    locale: () => "en",
    providers: () => [{ pluginId: "environments", pluginName: "Environments", serviceId: "results", actions: [...actions].map(id => ({ id, title: id })) }],
    trustedPlugins: () => new Set(["environments"]),
    session: id => id === "root" ? trustedSession : null,
    call: async (_plugin, _service, _method, params) => { calls.push(params); return { tone: "info", review: review() }; },
    redact: mask, changed() {}
  });
  const input = { agentSessionId: "worker", files: ["source.txt"], resolutions: { "source.txt": "agent" }, session: { id: "forged" } };
  const result = await cards.invoke("environments", "review", "root", input);
  assert.deepEqual(calls[0].session, trustedSession);
  assert.equal(calls[0].sessionId, "root");
  assert.deepEqual(calls[0].input, input);
  assert.ok(result.review);
  assert.doesNotMatch(JSON.stringify(result.review), /PRIVATE_KEY_VALUE/u);
  assert.match(result.review.groups[0].files[0].conflict.current.text, /\[MASKED\]/u);
  assert.match(result.review.groups[0].files[0].conflict.agent.text, /\[MASKED\]/u);
  assert.match(result.review.groups[0].files[0].conflict.current.label, /\[MASKED\]/u);
  assert.equal(result.review.groups[0].files[0].conflict.agent.label, "Agent: worker");
  assert.equal(result.review.acceptActionId, "accept");
});

test("review cannot name another plugin's actions and bounds text, files and total size", () => {
  const unknown = review(); unknown.acceptActionId = "undeclared";
  assert.throws(() => normalizeCardReview(unknown, mask, actions), /not declared/u);
  const long = review(); long.groups[0].files[0].diff = "x".repeat(20_000);
  const normalized = normalizeCardReview(long, mask, actions);
  assert.equal(normalized.groups[0].files[0].diff.length, 16_384);
  assert.equal(normalized.groups[0].files[0].truncated, true);
  const many = review(); many.groups[0].files = Array.from({ length: 401 }, () => ({ path: "a", diff: "" }));
  assert.throws(() => normalizeCardReview(many, mask, actions), /files are invalid/u);
  const oversized = review(); oversized.groups[0].files[0].diff = "x".repeat(512 * 1024);
  assert.throws(() => normalizeCardReview(oversized, mask, actions), /too large/u);
});

test("human card action input is a bounded JSON object and is copied before plugin dispatch", () => {
  assert.equal(normalizeCardActionInput(undefined), undefined);
  for (const input of [null, "wrong", ["wrong"]]) assert.throws(() => normalizeCardActionInput(input), /invalid/u);
  const input = { files: ["source.txt"] };
  const copy = normalizeCardActionInput(input);
  input.files.push("later.txt");
  assert.deepEqual(copy, { files: ["source.txt"] });
  const files = Array.from({ length: 400 }, (_, index) => `${index}/${"p".repeat(290)}.txt`);
  const selection = { files, resolutions: Object.fromEntries(files.map(path => [path, "agent"])) };
  assert.ok(Buffer.byteLength(JSON.stringify(selection)) > 16 * 1024);
  assert.doesNotThrow(() => normalizeCardActionInput(selection), "a valid 400-file selection fits the host action limit");
  assert.deepEqual(normalizeCardActionInput(selection), selection);
  assert.throws(() => normalizeCardActionInput({ text: "x".repeat(1024 * 1024) }), /too large/u);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => normalizeCardActionInput(cycle), /must be JSON/u);
});

test("review-only actions (menu: false) stay out of the card menu and never run without the review's input", async () => {
  const { validatePluginManifest } = await import("../src/main/services/PluginManager.ts");
  const { readFile } = await import("node:fs/promises");
  const example = JSON.parse(await readFile(new URL("../examples/plugins/collect-demo/canvastty.plugin.json", import.meta.url), "utf8"));
  const manifest = (cardActions) => ({ ...example, services: [{ ...example.services[0], cardActions }] });
  const validated = validatePluginManifest(manifest([{ id: "review", title: "Review" }, { id: "accept", title: "Accept", menu: false }]));
  assert.deepEqual(validated.services[0].cardActions, [{ id: "review", title: "Review" }, { id: "accept", title: "Accept", menu: false }]);
  assert.throws(() => validatePluginManifest(manifest([{ id: "accept", title: "Accept", menu: true }])), /menu must be false/u);

  const calls = [];
  const cards = new PluginCards({
    locale: () => "en",
    providers: () => [{ pluginId: "reviews", pluginName: "Reviews", serviceId: "results", actions: validated.services[0].cardActions }],
    trustedPlugins: () => new Set(["reviews"]),
    session: (id) => id === "root" ? { id: "root", role: "orchestrator", provider: "codex" } : null,
    call: async (_plugin, _service, _method, params) => { calls.push(params); return { tone: "info" }; },
    redact: (text) => text, changed() {}
  });
  assert.deepEqual(cards.decorations().actions.map((action) => action.actionId), ["review"], "only the menu action is listed");
  await assert.rejects(cards.invoke("reviews", "accept", "root"), /only from a change review/u);
  assert.equal(calls.length, 0);
  await cards.invoke("reviews", "accept", "root", { files: ["a.txt"] });
  await cards.invoke("reviews", "accept", "root", {});
  assert.deepEqual(calls.map((call) => call.input), [{ files: ["a.txt"] }, {}]);
});

test("card action titles may be localized like the manifest description; the card menu shows the UI language's", async () => {
  const { validatePluginManifest } = await import("../src/main/services/PluginManager.ts");
  const { cardActionTitle } = await import("../src/shared/pluginCardActions.ts");
  const { readFile } = await import("node:fs/promises");
  const example = JSON.parse(await readFile(new URL("../examples/plugins/collect-demo/canvastty.plugin.json", import.meta.url), "utf8"));
  const manifest = (cardActions) => ({ ...example, services: [{ ...example.services[0], cardActions }] });
  const localized = { id: "review", title: "Review changes", "title.ru": "Проверить изменения", "title.en": "Review changes" };
  const validated = validatePluginManifest(manifest([localized, { id: "plain", title: "Plain" }]));
  assert.deepEqual(validated.services[0].cardActions, [localized, { id: "plain", title: "Plain" }]);
  assert.throws(() => validatePluginManifest(manifest([{ ...localized, "title.ru": "ж".repeat(41) }])), /title\.ru/u, "40 characters, like title");
  assert.throws(() => validatePluginManifest(manifest([{ ...localized, "title.ru": "" }])), /title\.ru/u);
  assert.throws(() => validatePluginManifest(manifest([{ ...localized, "title.de": "Prüfen" }])), /title\.de/u, "only the app's languages");

  const cards = new PluginCards({
    locale: () => "en",
    providers: () => [{ pluginId: "reviews", pluginName: "Reviews", serviceId: "results", actions: validated.services[0].cardActions }],
    trustedPlugins: () => new Set(["reviews"]), session: () => null, call: async () => null, redact: (text) => text, changed() {}
  });
  const [entry, plain] = cards.decorations().actions;
  assert.equal(entry["title.ru"], "Проверить изменения", "the decorations carry the localized titles to the renderer");
  assert.equal(cardActionTitle(entry, "ru"), "Проверить изменения");
  assert.equal(cardActionTitle(entry, "en"), "Review changes");
  assert.equal(cardActionTitle(plain, "ru"), "Plain", "without a title for the language: title");
  assert.equal(cardActionTitle({ title: "Review", "title.en": "Review EN" }, "ru"), "Review");

  // The card's options menu and its "done" toast show the localized title.
  const card = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  assert.match(card, /const pluginActions = pluginDecorations\.actions\.map\(\(action\) => \(\{ \.\.\.action, title: cardActionTitle\(action, locale\) \}\)\);/u);
  assert.match(card, /\{pluginActions\.map\(\(action, index\) => \(/u);
  assert.match(card, /`\$\{cardActionTitle\(action, locale\)\}: \$\{t\(locale, "cardActionDone"\)\}`/u);
  assert.doesNotMatch(card, /\{pluginDecorations\.actions\.map\(/u, "the menu never lists the unlocalized actions");
});

test("bidirectional controls are removed from review text and refused in file names", () => {
  const actions = new Set(["accept", "reject"]);
  const value = review();
  value.title = "Res\u202Eults\u2066";
  value.groups[0].files[0].diff = "+ ok\u202E // tricky\u2069";
  const normalized = normalizeCardReview(value, mask, actions);
  assert.equal(normalized.title, "Results");
  assert.equal(normalized.groups[0].files[0].diff, "+ ok // tricky");
  const named = review();
  named.groups[0].files[0].path = "src/\u202Etxt.exe";
  assert.throws(() => normalizeCardReview(named, mask, actions), /file path is invalid/u);
});

test("a diff is marked truncated exactly when its shown text was cut", () => {
  const one = (diff, redact = text => text) => normalizeCardReview({ title: "T",
    groups: [{ sessionId: "worker", title: "W", files: [{ path: "a.txt", diff }] }] }, redact, actions).groups[0].files[0];
  // Masking can make the text longer than the cut: the shown diff is cut, so it is marked.
  const masked = one(`${"x".repeat(16_000)}${"PRIVATE_KEY_VALUE".repeat(20)}`, text => text.replaceAll("PRIVATE_KEY_VALUE", "[MASKED-LONGER-VALUE]"));
  assert.equal(masked.diff.length, 16_384);
  assert.equal(masked.truncated, true);
  // Control characters removed before the cut: nothing of the shown text was cut.
  const stripped = one(`${"y".repeat(16_380)}${"\u0001".repeat(10)}`);
  assert.equal(stripped.diff.length, 16_380);
  assert.equal(stripped.truncated, false);
});
