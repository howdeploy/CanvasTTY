import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { USAGE_HISTORY_REFRESH_MS, startUsageHistoryPoller } from "../src/renderer/src/features/usage/usageHistoryPoller.ts";
import { UsageHistoryUnavailableError, loadUsageHistory, resolveUsageHistoryApi } from "../src/renderer/src/features/usage/usageHistoryApi.ts";

const root = new URL("..", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const RESET = NOW + 3 * 60 * MIN;

function fakeTimers() {
  const timers = new Map();
  let next = 0;
  return {
    setTimer(callback, ms) { next += 1; timers.set(next, { callback, ms }); return next; },
    clearTimer(handle) { timers.delete(handle); },
    pending() { return [...timers.values()]; },
    fire() {
      const [[handle, timer]] = [...timers.entries()];
      timers.delete(handle);
      timer.callback();
    }
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test("poller loads immediately, never overlaps requests and refreshes every minute", async () => {
  const timers = fakeTimers();
  const requests = [];
  const results = [];
  const loading = [];
  const poller = startUsageHistoryPoller({
    load: () => { const request = deferred(); requests.push(request); return request.promise; },
    onLoading: (value) => loading.push(value),
    onResult: (value, at) => results.push([value, at]),
    onError: () => assert.fail("no error expected"),
    now: () => 42,
    ...timers
  });
  assert.equal(requests.length, 1);
  poller.refresh();
  assert.equal(requests.length, 1, "a running request is not duplicated");
  requests[0].resolve("first");
  await settle();
  assert.deepEqual(results, [["first", 42]]);
  assert.deepEqual(loading, [true, false]);
  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0].ms, USAGE_HISTORY_REFRESH_MS);
  assert.equal(USAGE_HISTORY_REFRESH_MS, 60_000);
  timers.fire();
  assert.equal(requests.length, 2, "scheduled refresh");
  requests[1].resolve("second");
  await settle();
  poller.refresh();
  assert.equal(requests.length, 3, "manual refresh");
  assert.equal(timers.pending().length, 0, "manual refresh restarts the interval");
  requests[2].resolve("third");
  await settle();
  assert.equal(timers.pending().length, 1);
  poller.stop();
});

test("poller surfaces errors, keeps its schedule and delivers nothing after stop", async () => {
  const timers = fakeTimers();
  const errors = [];
  const results = [];
  let call = 0;
  const pendingAfterStop = deferred();
  const poller = startUsageHistoryPoller({
    load: () => {
      call += 1;
      if (call === 1) throw new Error("synchronous failure");
      if (call === 2) return Promise.reject(new Error("ipc failed"));
      return pendingAfterStop.promise;
    },
    onLoading: () => undefined,
    onResult: (value) => results.push(value),
    onError: (error) => errors.push(error.message),
    ...timers
  });
  await settle();
  assert.deepEqual(errors, ["synchronous failure"]);
  assert.equal(timers.pending().length, 1, "failure keeps polling");
  timers.fire();
  await settle();
  assert.deepEqual(errors, ["synchronous failure", "ipc failed"]);
  timers.fire();
  poller.stop();
  pendingAfterStop.resolve("late");
  await settle();
  assert.deepEqual(results, []);
  assert.equal(timers.pending().length, 0);
});

test("the bridge is discovered structurally, so the UI works before and after the backend contract lands", async () => {
  assert.equal(resolveUsageHistoryApi(undefined), null);
  assert.equal(resolveUsageHistoryApi({}), null);
  assert.equal(resolveUsageHistoryApi({ usageHistory: {} }), null);
  assert.equal(resolveUsageHistoryApi({ usageHistory: { get: "nope" } }), null);
  await assert.rejects(loadUsageHistory(null), UsageHistoryUnavailableError);

  const payload = { version: 1, startedAt: 1, collectedAt: 2, samples: [], events: [], health: [], coverage: ["c"], providerStatus: ["p"], error: null };
  const bridge = { usageHistory: { payload, get() { return Promise.resolve(this.payload); } } };
  const api = resolveUsageHistoryApi(bridge);
  assert.deepEqual(await loadUsageHistory(api), payload);

  await assert.rejects(
    loadUsageHistory(resolveUsageHistoryApi({ usageHistory: { get: async () => ({ version: 7 }) } })),
    /Unsupported usage history version/
  );
  await assert.rejects(
    loadUsageHistory(resolveUsageHistoryApi({ usageHistory: { get: async () => { throw new Error("main crashed"); } } })),
    /main crashed/
  );
});

const bundle = await build({
  stdin: {
    contents: [
      'export { renderToStaticMarkup } from "react-dom/server";',
      'export { createElement } from "react";',
      'export { UsageHistoryView } from "./src/renderer/src/features/usage/UsageHistoryView.tsx";',
      'export { buildUsageReport } from "./src/shared/usageReport.ts";'
    ].join("\n"),
    resolveDir: fileURLToPath(root),
    loader: "ts"
  },
  bundle: true,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  loader: { ".svg": "dataurl", ".css": "empty" },
  banner: { js: `import { createRequire as __usageRequire } from "node:module"; const require = __usageRequire(${JSON.stringify(import.meta.url)});` },
  logLevel: "silent",
  write: false
});
const { renderToStaticMarkup, createElement, UsageHistoryView, buildUsageReport } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);

function fixtureHistory(patch = {}) {
  const samples = [];
  [10, 11, 13, 13, 16].forEach((percent, index) => {
    samples.push({ provider: "codex", scope: "acct-0123456789abcdef", windowId: "codex:primary", at: NOW - 30 * MIN + index * MIN, reset: RESET, percent });
    samples.push({ provider: "codex", scope: "acct-0123456789abcdef", windowId: "codex:secondary", at: NOW - 30 * MIN + index * MIN, reset: null, percent: percent / 2 });
  });
  const events = [
    { id: "h1", provider: "codex", app: "Hermes", profile: "work", session: "20260921_hermes_a", from: NOW - 29 * MIN, to: NOW - 28 * MIN, input: 300, output: 20, cached: 100, timing: "poll-delta", title: "PRIVATE TITLE" },
    { id: "x1", provider: "codex", app: "Codex CLI", profile: "", session: "019a-codex-session", from: NOW - 28 * MIN - 5_000, to: NOW - 28 * MIN - 5_000, input: 100, output: 10, cached: 0, timing: "event", content: "PRIVATE BODY" },
    { id: "c1", provider: "claude", app: "Claude Code", profile: "", session: "claude-session-7", from: NOW - 5 * MIN, to: NOW - 5 * MIN, input: 50, output: 5, cached: 0, timing: "event" }
  ];
  return {
    version: 1, startedAt: NOW - 86_400_000, collectedAt: NOW - 20_000, samples, events,
    health: Array.from({ length: 40 }, (_, index) => ({ at: NOW - (40 - index) * MIN, complete: true })),
    coverage: ["Hermes work: 3 accounting rows read-only"], providerStatus: ["claude: unavailable (cli-not-found)"], error: null,
    ...patch
  };
}

function render(props = {}) {
  const report = "report" in props ? props.report : buildUsageReport(props.history ?? fixtureHistory(), {
    now: NOW, period: "1h", weightBasis: props.weightBasis ?? "uncached"
  });
  return renderToStaticMarkup(createElement(UsageHistoryView, {
    locale: "ru", timeZone: "Europe/Moscow", now: NOW, report, reportError: null, loading: false, loadError: null,
    loadedAt: NOW, period: "1h", weightBasis: "uncached", titleId: "t", descriptionId: "d",
    onPeriodChange() {}, onWeightBasisChange() {}, onRefresh() {}, onClose() {},
    ...props
  }));
}

test("renders measured change as unattributed, with evidence tree and explicit unknown", () => {
  const html = render();
  assert.match(html, /Не атрибутировано/);
  assert.match(html, /доказанной нет/);
  assert.match(html, /\+6 п\. п\./);
  assert.match(html, /codex:primary/);
  assert.match(html, /codex:secondary/);
  assert.match(html, /время сброса неизвестно/, "unknown reset of the weekly series is explicit");
  assert.match(html, /title="acct-0123456789abcdef"/);
  assert.match(html, /acct-0123456…/);
  assert.match(html, /Hermes/);
  assert.match(html, /профиль work/);
  assert.match(html, /20260921_hermes_a/);
  assert.match(html, /Codex CLI/);
  assert.match(html, /Claude Code/);
  assert.match(html, /claude-session-7/);
  assert.match(html, /Неизвестно \/ не записано локально/);
  assert.match(html, /Нет наблюдений квоты этого провайдера/);
  assert.match(html, /claude: unavailable \(cli-not-found\)/);
  assert.match(html, /Europe\/Moscow/);
  assert.match(html, /checked="" value="1h"/);
  assert.match(html, /сопоставимых интервалов: 4, 4 мин/);
  assert.match(html, /не измерено — нет сопоставимых интервалов/, "no comparable interval is not shown as +0");
  assert.match(html, /неизвестно — изменение не измерено/);
  assert.doesNotMatch(html, /PRIVATE/);
  assert.doesNotMatch(html, /<svg|<path/);
});

test("the conditional app → profile → session estimate is shown first and automatically, with no share input", () => {
  const html = render();
  assert.doesNotMatch(html, /usage-history-share/, "the manual share input is gone");
  assert.doesNotMatch(html, /Доля локальных сеансов/);
  const conditional = html.indexOf("usage-history__section--conditional");
  assert.ok(conditional > 0 && conditional < html.indexOf("usage-history-quota"), "the estimate precedes the measurement details");
  assert.match(html, /Условная оценка: приложения → профили → сеансы/);
  assert.match(html, /Измерено: \+6 п\. п\./);
  assert.match(html, /Условно на локальные сеансы: ≈ 2 п\. п\./);
  assert.match(html, /неизвестен, от 0 до 6 п\. п\./, "external stays a 0..measured range");
  assert.match(html, /Не оценено: 4 п\. п\./);
  assert.match(html, /нет локальных событий этого провайдера: 4 п\. п\./);
  // Hermes 220 : Codex CLI 110 uncached tokens in the +2 cluster.
  assert.match(html, /usage-history__tree-row--app[^]*?Hermes[^]*?≈ 1,33/);
  assert.match(html, /usage-history__tree-row--profile[^]*?профиль work[^]*?≈ 1,33/);
  assert.match(html, /usage-history__tree-row--session[^]*?20260921_hermes_a[^]*?≈ 1,33/);
  assert.match(html, /Codex CLI[^]*?≈ 0,67/);
  assert.match(html, /Покрытие логов: по записанному состоянию каждого сбора/);
  assert.match(html, /Логи не доказывают/);
  assert.match(html, /Не атрибутировано/, "measured attribution is unchanged");
  assert.match(html, /Изменение не измерено — оценивать нечего/, "the weekly series without a reset is not estimated");
  assert.doesNotMatch(html, /PRIVATE/);
});

test("time before the first recorded collection stays unrecorded, without inferred coverage tiers", () => {
  const health = [{ at: NOW - 22 * MIN + 5_000, complete: true }, { at: NOW - MIN, complete: true }];
  const html = render({ history: fixtureHistory({ health }) });
  assert.match(html, /для этого времени состояние сбора логов не записано: 2 п\. п\./);
  assert.doesNotMatch(html, /usage-history__coverage-legacy|usage-history__tier/);
  assert.match(html, /неизвестен, от 0 до 6 п\. п\./, "external stays unknown 0..measured");
  assert.match(html, /Не атрибутировано/);
});

test("unestimable reasons, backlog and unknown-provider overlap are explicit", () => {
  const backlog = render({ history: fixtureHistory({
    health: [{ at: NOW - 40 * MIN, complete: true }, { at: NOW - MIN, complete: false }],
    coverage: ["Logs: read budget reached; 2 changed logs continue next collection."]
  }) });
  assert.match(backlog, /сборщик ещё не дочитал логи \(очередь чтения\): 2 п\. п\./);
  assert.match(backlog, /Нет пригодных интервалов/);
  assert.doesNotMatch(backlog, /Условно на локальные сеансы/);

  const problem = render({ history: fixtureHistory({ coverage: ["Hermes work: database is busy; not collected this time."] }) });
  assert.match(problem, /Источники с ошибкой в последнем сборе[^<]*Hermes work: database is busy/);
});

test("load failures, missing bridge, collector errors and staleness are surfaced honestly", () => {
  const unavailable = render({ report: null, loadError: { kind: "unavailable", message: "x", at: NOW } });
  assert.match(unavailable, /role="alert"/);
  assert.match(unavailable, /Источник истории использования недоступен/);
  assert.doesNotMatch(unavailable, /Квоты: измеренные изменения/);

  const failed = render({ loadError: { kind: "failed", message: "ipc boom", at: NOW } });
  assert.match(failed, /Не удалось получить историю: ipc boom/);
  assert.match(failed, /Показаны последние успешно полученные данные/);

  const stale = render({ history: fixtureHistory({ collectedAt: NOW - 20 * MIN, error: "sqlite busy" }) });
  assert.match(stale, /Сборщик сообщил об ошибке: sqlite busy/);
  assert.match(stale, /Данные сборщика устарели: последний сбор 20 мин назад/);
  assert.match(stale, /ряд устарел/);

  const loading = render({ report: null, loading: true });
  assert.match(loading, /Загрузка истории…/);
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /disabled=""/);
});

test("renders in English when the app locale is English", () => {
  const html = render({ locale: "en" });
  assert.match(html, /Usage history/);
  assert.match(html, /Unattributed/);
  assert.match(html, /Conditional estimate: apps → profiles → sessions/);
  assert.match(html, /Conditionally local: ≈ 2 pp/);
  assert.match(html, /unknown, 0 to 6 pp/);
  assert.match(html, /The logs do not prove/);
});

test("App mounts the trigger beside the title bar and portals the overlay outside the canvas", async () => {
  const app = await source("src/renderer/src/App.tsx");
  assert.match(app, /import \{ UsageHistoryPanel \} from "\.\/features\/usage\/UsageHistoryPanel";/);
  assert.match(app, /<div ref=\{setOverlayHost\} className=\{rootClasses\}/);
  assert.match(app, /<TitleBar[^\n]*\/>\n\s*<UsageHistoryPanel\n\s*locale=\{settings\.locale\}\n\s*open=\{usageHistoryOpen\}\n\s*container=\{overlayHost\}/);
  assert.match(app, /browserViewVisible=\{!settingsOpen && !usageHistoryOpen && /);
  assert.equal((app.match(/if \(usageHistoryOpen\) return;/g) ?? []).length, 2);
  const workspaceIndex = app.indexOf("<WorkspaceCanvas");
  assert.ok(app.indexOf("<UsageHistoryPanel") < workspaceIndex, "not inside the transformed canvas");
});

test("overlay is an accessible modal with Escape, focus containment, restore and scheduled refresh", async () => {
  const panel = await source("src/renderer/src/features/usage/UsageHistoryPanel.tsx");
  assert.match(panel, /createPortal\(/);
  assert.match(panel, /role="dialog"/);
  assert.match(panel, /aria-modal="true"/);
  assert.match(panel, /aria-labelledby=\{titleId\}/);
  assert.match(panel, /aria-haspopup="dialog"/);
  assert.match(panel, /aria-expanded=\{open\}/);
  assert.match(panel, /event\.key === "Escape"/);
  assert.match(panel, /addEventListener\("keydown", handleKeyDown, true\)/);
  assert.match(panel, /addEventListener\("focusin", keepFocusInside\)/);
  assert.match(panel, /closeButtonRef\.current\?\.focus/);
  assert.match(panel, /target\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(panel, /startUsageHistoryPoller\(/);
  assert.match(panel, /poller\.stop\(\)/);
  assert.match(panel, /pollerRef\.current\?\.refresh\(\)/);

  // Hooks are never conditional: every hook call precedes the component's only return.
  const body = panel.slice(panel.indexOf("export function UsageHistoryPanel"), panel.indexOf("function wrapFocus"));
  const componentReturn = body.indexOf("\n  return (");
  const hookCalls = [...body.matchAll(/\buse(State|Effect|Memo|Ref|Id|Callback)\(/g)].map((match) => match.index);
  assert.ok(hookCalls.length >= 10);
  assert.ok(hookCalls.every((index) => index < componentReturn));
  assert.doesNotMatch(body.slice(0, componentReturn), /^  (if|for|while)\b/m, "no top-level branch before hooks finish");

  const view = await source("src/renderer/src/features/usage/UsageHistoryView.tsx");
  assert.doesNotMatch(view, /\buse(State|Effect|Memo|Ref|Id|Callback|Context)\(/, "the view is stateless");
  for (const file of [panel, view]) assert.doesNotMatch(file, /<svg|<path/);
});

test("overlay styles keep the trigger clickable in the drag region and the content scrollable", async () => {
  const css = await source("src/renderer/src/features/usage/usageHistory.css");
  assert.match(css, /\.usage-history-trigger \{[^}]*position: fixed;[^}]*-webkit-app-region: no-drag;/);
  assert.match(css, /\.usage-history-backdrop \{[^}]*position: fixed;[^}]*inset: var\(--titlebar-height, 44px\) 0 0;/);
  assert.match(css, /\.usage-history__body \{[^}]*overflow: auto;/);
  assert.match(css, /\.usage-history__table-wrap \{[^}]*overflow-x: auto;/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /\.app--macos \.usage-history-trigger/);
  assert.match(css, /\.app--macos-fullscreen \.usage-history-trigger/);
});
