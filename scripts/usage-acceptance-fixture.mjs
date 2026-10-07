/**
 * Acceptance fixture for the packaged usage smoke: synthetic SOURCE logs (Codex rollouts, a Claude
 * transcript) in an isolated home, read by the real LocalUsageCollector inside the real
 * UsageHistoryService, persisted to an isolated directory, disposed and reloaded by a fresh
 * service. The reloaded history is what the packaged renderer receives.
 *
 * Nothing outside `root` is read or written: the collector gets an explicit home and an empty
 * environment (no HERMES_HOME / CODEX_HOME leak), limits snapshots are scripted, the clock is
 * injected. Every timestamp is in the past relative to `now`, and the last collection runs long
 * after every interval's maturity, so the renderer (which reports at its own Date.now()) sees
 * mature, fully estimated intervals.
 *
 * Expected numbers are derived by hand below, not taken from the report under test.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LocalUsageCollector } from "../src/main/services/LocalUsageCollector.ts";
import { UsageHistoryService } from "../src/main/services/UsageHistoryService.ts";
import { buildUsageReport } from "../src/shared/usageReport.ts";

export const FIXTURE_LABEL = "TEST FIXTURE — synthetic data, not real usage";
const MIN = 60_000;
export const CODEX_SCOPE = "test-fixture-codex-scope-0001";
export const CLAUDE_SCOPE = "test-fixture-claude-scope-0001";
const iso = (ms) => new Date(ms).toISOString();

const tokens = ([input, cached, output]) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const codexMeta = (id, at) => JSON.stringify({ timestamp: iso(at), type: "session_meta", payload: { id, timestamp: iso(at), cwd: "/tmp/fixture-private-cwd", originator: "codex_cli_rs", cli_version: "0.50.0", source: "cli", model_provider: "openai" } });
const codexCount = (at, total, last) => JSON.stringify({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: tokens(total), last_token_usage: tokens(last), model_context_window: 258_400 }, rate_limits: null } });
const assistant = (session, id, at, [input, read, write, output]) => JSON.stringify({
  parentUuid: null, isSidechain: false, userType: "external", cwd: "/tmp/fixture-private-cwd", sessionId: session, version: "2.1.0",
  type: "assistant", uuid: randomUUID(), timestamp: iso(at), requestId: `req_${id}`,
  message: { id, type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "PRIVATE fixture body" }], stop_reason: null,
    usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output, service_tier: "standard" } }
});
const windowOf = (id, usedPercent, resetsAt) => ({ id, bucketId: id.split(":")[0], slot: "primary", isDefaultBucket: true, label: "5h", usedPercent, used: null, limit: null, windowMinutes: 300, resetsAt });

/**
 * Timeline (T = now rounded to the second):
 *   E1 = T − 3 h  Codex session C: +2 pp in (E1+1, E1+2], 2 200 uncached tokens.   (inside 24 h, outside 1 h)
 *   E2 = T − 30 m Codex A 3 300 uncached / B 1 100 uncached + 2 000 cached in (E2+1, E2+2] (+2 pp),
 *                 Codex A only in (E2+2, E2+3] (+3 pp); Claude one session, +1 then +3 pp.
 *   Collection every minute around each episode and every minute over the last 12 minutes up to T − 1 m;
 *   the idle hours between episodes are a genuine collection gap (never measured).
 */
export function expectations() {
  const allA = 3_300, allB = 3_100; // basis "all": input incl. cache + output
  return {
    "24h": {
      uncached: {
        "codex:primary": { measured: 7, local: 7, sessions: { A: 4.5, B: 0.5, C: 2 }, apps: { "Codex CLI": 7 } },
        "claude:five_hour": { measured: 4, local: 4, sessions: { claude: 4 }, apps: { "Claude Code": 4 } }
      },
      all: {
        "codex:primary": { measured: 7, local: 7, sessions: { A: 3 + 2 * allA / (allA + allB), B: 2 * allB / (allA + allB), C: 2 }, apps: { "Codex CLI": 7 } },
        "claude:five_hour": { measured: 4, local: 4, sessions: { claude: 4 }, apps: { "Claude Code": 4 } }
      }
    },
    "1h": {
      uncached: {
        "codex:primary": { measured: 5, local: 5, sessions: { A: 4.5, B: 0.5 }, apps: { "Codex CLI": 5 } },
        "claude:five_hour": { measured: 4, local: 4, sessions: { claude: 4 }, apps: { "Claude Code": 4 } }
      }
    }
  };
}

async function writeLines(path, lines) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join("\n") + "\n");
}

/** Builds source logs, runs the real collector/service, persists, reloads. */
export async function buildAcceptanceHistory(root, now = Math.floor(Date.now() / 1000) * 1000) {
  const home = join(root, "source-home");
  const directory = join(root, "usage-state");
  await mkdir(directory, { recursive: true }); // the service writes into an existing directory only
  const E1 = now - 3 * 60 * MIN;
  const E2 = now - 30 * MIN;
  const reset = now + 4 * 60 * MIN;
  const ids = { A: randomUUID(), B: randomUUID(), C: randomUUID(), claude: randomUUID() };
  const rollout = (id) => join(home, ".codex", "sessions", "2026", "09", "20", `rollout-2026-09-20T10-00-00-${id}.jsonl`);
  const transcript = join(home, ".claude", "projects", "-tmp-fixture", `${ids.claude}.jsonl`);
  const created = [[rollout(ids.C), E1 - 5 * MIN, codexMeta(ids.C, E1 - 5 * MIN)], [rollout(ids.A), E2 - 5 * MIN, codexMeta(ids.A, E2 - 5 * MIN)], [rollout(ids.B), E2 - 5 * MIN, codexMeta(ids.B, E2 - 5 * MIN)]];
  const pending = [
    [rollout(ids.C), E1 + 1.5 * MIN, codexCount(E1 + 1.5 * MIN, [2_000, 0, 200], [2_000, 0, 200])],
    [rollout(ids.A), E2 + 1.5 * MIN, codexCount(E2 + 1.5 * MIN, [3_000, 0, 300], [3_000, 0, 300])],
    [transcript, E2 + 1.6 * MIN, assistant(ids.claude, "msg_fixture_1", E2 + 1.6 * MIN, [100, 0, 0, 10])],
    [rollout(ids.B), E2 + 1.7 * MIN, codexCount(E2 + 1.7 * MIN, [3_000, 2_000, 100], [3_000, 2_000, 100])],
    [rollout(ids.A), E2 + 2.5 * MIN, codexCount(E2 + 2.5 * MIN, [5_000, 0, 500], [2_000, 0, 200])],
    [transcript, E2 + 2.6 * MIN, assistant(ids.claude, "msg_fixture_2", E2 + 2.6 * MIN, [300, 0, 0, 30])]
  ];
  // A file exists from its first line on; its mtime is the time of its last line (logs are backdated).
  const feed = async (at) => {
    while (created.length && created[0][1] <= at) {
      const [path, time, line] = created.shift();
      await writeLines(path, [line]);
      await utimes(path, new Date(time), new Date(time));
    }
    while (pending.length && pending[0][1] <= at) {
      const [path, time, line] = pending.shift();
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, line + "\n");
      await utimes(path, new Date(time), new Date(time));
    }
  };

  let clock = E1 - 10 * MIN;
  let next = null;
  const snapshot = (at, codex, claude, jitter) => ({
    fetchedAt: at,
    providers: [
      { provider: "codex", state: "available", source: "codex-app-server", fetchedAt: at, accountScope: CODEX_SCOPE, windows: [windowOf("codex:primary", codex, reset)] },
      { provider: "claude", state: "available", source: "claude-usage-api", fetchedAt: at, accountScope: CLAUDE_SCOPE, windows: [windowOf("claude:five_hour", claude, reset + jitter)] }
    ]
  });
  const service = (start) => {
    clock = start;
    return new UsageHistoryService({
      directory,
      limits: { getProviders: async () => structuredClone(next) },
      createCollector: (state) => new LocalUsageCollector(home, state, {}, {}),
      now: () => clock,
      initialDelayMs: 3_600_000
    });
  };
  const first = service(E1 - 10 * MIN);
  await first.load();
  const run = async (at, codex, claude, jitter = 0) => {
    clock = at;
    await feed(at);
    next = snapshot(at, codex, claude, jitter);
    await first.collect();
  };
  // Episode 1: collection starts 10 minutes early, so the baseline warm-up is long over.
  for (let minute = -4; minute <= 5; minute += 1) await run(E1 + minute * MIN, minute >= 2 ? 7 : 5, 20);
  // Episode 2, with observed Claude reset jitter (all within 1 s).
  const jitters = [0, -323, 396, 36, -67, 8];
  const codex2 = [10, 10, 12, 15, 15, 15];
  const claude2 = [20, 20, 21, 24, 24, 24];
  for (let index = 0; index < 6; index += 1) await run(E2 + index * MIN, codex2[index], claude2[index], jitters[index]);
  // Steady tail up to T − 1 m: every interval matured (Codex 2 min, Claude 7 min) before the last run.
  for (let at = now - 12 * MIN; at <= now - MIN; at += MIN) await run(at, 15, 24, 8);
  const beforeDispose = first.get();
  const reference = buildUsageReport(beforeDispose, { now, period: "24h" });
  await first.dispose();

  // Reload in a fresh service (fresh collector state from disk); no collection after reload.
  const second = service(now);
  await second.load();
  const reloaded = second.get();
  await second.dispose();
  const labelled = { ...reloaded, coverage: [...(reloaded.coverage ?? []), FIXTURE_LABEL] };
  return { home, directory, ids, history: labelled, reference, reloadedReport: buildUsageReport(reloaded, { now, period: "24h" }), now };
}

/** Last number in a rendered string; accepts "4,5" (ru) and "4.5" (en). Points never exceed 999. */
export function lastNumber(text) {
  const all = String(text).match(/\d+(?:[.,]\d+)?/g);
  return all ? Number(all[all.length - 1].replace(",", ".")) : NaN;
}
const near = (actual, expected) => Math.abs(actual - expected) <= 0.005 + 1e-9; // UI rounds to 2 decimals

/**
 * Semantic checks of one rendered state (list of conditional account blocks scraped from the
 * packaged renderer) against hand-derived expectations. Returns [{ name, ok, detail }].
 */
export function checkRenderedState(label, blocks, expected, ids) {
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name: `[${label}] ${name}`, ok: Boolean(ok), detail });
  const windows = Object.keys(expected);
  check("one conditional block per expected window", blocks.length === windows.length, `${blocks.length} block(s): ${blocks.map((b) => b.windowId).join(", ")}`);
  for (const windowId of windows) {
    const want = expected[windowId];
    const block = blocks.find((b) => b.windowId === windowId);
    if (!block) { check(`${windowId}: block rendered`, false); continue; }
    const [measuredLine = "", localLine = "", externalLine = ""] = block.summary;
    const measured = lastNumber(measuredLine), local = lastNumber(localLine), external = lastNumber(externalLine);
    check(`${windowId}: measured +${want.measured} pp`, near(measured, want.measured), measuredLine);
    check(`${windowId}: conditionally local ≈ ${want.local} pp`, near(local, want.local), localLine);
    check(`${windowId}: external unknown 0..${want.measured} pp`, /\b0\b/.test(externalLine) && near(external, want.measured), externalLine);
    const unestimated = block.summary.slice(3).find((line) => /^(Not estimated|Не оценено)/.test(line));
    const rest = unestimated ? lastNumber(unestimated.split("\n")[0]) : 0;
    check(`${windowId}: local + not estimated = measured`, near(local + rest, measured), `${local} + ${rest} vs ${measured}`);
    const apps = block.rows.filter((r) => r.level === "app");
    const profiles = block.rows.filter((r) => r.level === "profile");
    const sessions = block.rows.filter((r) => r.level === "session");
    const sum = (rows) => rows.reduce((total, r) => total + lastNumber(r.points), 0);
    check(`${windowId}: apps ${JSON.stringify(want.apps)}`,
      apps.length === Object.keys(want.apps).length && apps.every((r) => want.apps[r.label] !== undefined && near(lastNumber(r.points), want.apps[r.label])),
      apps.map((r) => `${r.label}=${r.points}`).join("; "));
    const wantSessions = Object.fromEntries(Object.entries(want.sessions).map(([key, points]) => [ids[key], points]));
    check(`${windowId}: sessions ${Object.entries(want.sessions).map(([k, v]) => `${k}=${Math.round(v * 1e4) / 1e4}`).join(" ")}`,
      sessions.length === Object.keys(wantSessions).length && sessions.every((r) => wantSessions[r.label] !== undefined && near(lastNumber(r.points), wantSessions[r.label])),
      sessions.map((r) => `${r.label.slice(0, 8)}…=${r.points}`).join("; "));
    check(`${windowId}: profile rows present and Σ profiles = Σ apps`, profiles.length >= apps.length && Math.abs(sum(profiles) - sum(apps)) <= 0.01 * profiles.length + 1e-9);
    check(`${windowId}: Σ sessions = Σ apps = local (rounding ≤ 0.01/row)`,
      Math.abs(sum(sessions) - local) <= 0.01 * sessions.length + 1e-9 && Math.abs(sum(apps) - local) <= 0.01 * apps.length + 1e-9,
      `sessions ${sum(sessions)}, apps ${sum(apps)}, local ${local}`);
    check(`${windowId}: every session row carries a token weight`, sessions.every((r) => /\d/.test(r.weight)));
  }
  return checks;
}
