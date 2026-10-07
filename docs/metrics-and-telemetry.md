# Metrics and telemetry

[English](metrics-and-telemetry.md) · [Русский](metrics-and-telemetry.ru.md) · [简体中文](metrics-and-telemetry.zh-CN.md) · [Docs home](README.md)

CanvasTTY treats telemetry as a truth problem before it treats it as a visualization problem. A polished progress rail is incorrect if its source cannot prove the value.

## Do not mix different measurements

| Measurement | Meaning | Example source |
|:--|:--|:--|
| Subscription quota | Usage inside a provider-defined time window and its reset time | Official account usage endpoint or structured CLI protocol |
| Session tokens | Input, output, and cache tokens attributed to one session | Structured provider lifecycle or usage events |
| Cost | Billed currency amount under a known model and price source | Official billing/usage record, not token multiplication with guessed prices |
| Elapsed time | Wall-clock duration since a known session timestamp | Local monotonic/wall clock plus real lifecycle timestamps |
| Activity state | Whether an agent is working or requires approval | Structured provider lifecycle signal |

A subscription percentage cannot be derived from session tokens. Token counts do not automatically prove cost. PTY output does not prove activity.

## What exists today

[`LimitsService`](../src/main/services/LimitsService.ts) reads provider subscription windows through structured adapters:

- Codex through the installed CLI app-server protocol.
- Claude and Kimi through their read-only usage endpoints when the installed CLI credentials and account type support them.
- A 60-second cache with stale fallback after a previously successful read.
- Sanitized `available`, `stale`, or `unavailable` snapshots; raw credentials and provider payloads never cross IPC.

CanvasTTY never parses a provider's terminal UI to recover limits. Unsupported subscription types remain explicitly unavailable.

## Usage history

Open **Usage history** to select a report period and view measured quota changes,
conditional estimates by application → profile → session, and local token counters.
The report period is not the quota window; primary and weekly windows remain separate.

- Codex/Claude quota observations are collected every minute while CanvasTTY runs.
- Local Codex, Claude Code and Hermes accounting stores are read-only; Hermes requires
  a SQLite CLI with `-safe` support on `PATH`. Missing sources are reported, not counted as zero.
- History and cursors are saved atomically in `usage-history.json` under the normal
  Electron `userData` directory, bounded to 30 days and 500,000 events.
- The automatic estimate splits a comparable interval's measured change by session token
  weight **if local logged activity explains that change**. This is not the provider's
  billing formula or proof of account attribution. External activity remains unknown.
- Incomplete collection, immature events, resets, account changes and gaps are shown
  explicitly. Earlier account percentages cannot be reconstructed from token totals.
- Only accounting metadata is exposed to the main renderer; prompts, responses and
  credentials are not part of the history. Plugins do not receive this history API.

The session-token API below remains a proposed extension contract. The built-in history
uses [`UsageHistory`](../src/shared/usageHistory.ts), not that proposed public API.
Its deterministic Electron check is `node scripts/smoke-usage-ui-packaged.mjs --app <package>`.

## Source priority

Use the highest available source and stop when none is trustworthy:

1. A structured provider event or local protocol tied to the session ID.
2. An official provider usage API with stable identifiers.
3. A documented CLI JSON output intended for automation.
4. `unavailable` with a specific reason.

Do not scrape ANSI output, infer work from terminal text, estimate tokens from characters and label them as actual, or expose auth data to the renderer. An estimate may exist only as a separately named estimate with its method and uncertainty visible; it must never replace a real usage field.

## Proposed session-token contract

A discriminated union prevents unavailable data from masquerading as zeros:

```ts
type SessionMetricSource =
  | "provider-event"
  | "provider-usage-api"
  | "cli-json";

type SessionMetricUnavailableReason =
  | "unsupported-provider"
  | "not-authenticated"
  | "not-reported"
  | "timeout"
  | "protocol-error";

interface SessionTokenValues {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number;
}

type SessionTokenUsage =
  | {
      sessionId: string;
      provider: AgentProviderId;
      state: "available";
      source: SessionMetricSource;
      fetchedAt: number;
      values: SessionTokenValues;
    }
  | {
      sessionId: string;
      provider: AgentProviderId;
      state: "stale";
      source: SessionMetricSource;
      fetchedAt: number;
      failedAt: number;
      reason: SessionMetricUnavailableReason;
      values: SessionTokenValues;
    }
  | {
      sessionId: string;
      provider: AgentProviderId;
      state: "unavailable";
      checkedAt: number;
      reason: SessionMetricUnavailableReason;
    };
```

Keep nullable sub-fields when a source reports only a reliable total. Never compute a missing input/output split. Validate every count as finite, non-negative, and safe before creating the snapshot.

## Data flow for a token widget

```text
structured provider source
        ↓
main-process adapter
  validate · normalize · cache · bind to session ID
        ↓
sanitized SessionTokenUsage snapshot
        ↓ allow-listed IPC + typed preload
pure renderer selector
        ↓
Home widget or terminal-card summary
```

The main adapter owns authentication, timeouts, provider-specific schemas, deduplication, and cleanup. The renderer owns only presentation and local selection. If a provider cannot bind usage to the exact CanvasTTY session, do not assign account-wide tokens to that session.

## Widget behavior

- Show a compact numeric total only when the state is `available` or `stale`.
- Mark stale data without replacing it with zero; keep its source timestamp available to assistive text or details.
- Use a localized unavailable reason instead of an empty rail.
- Use a determinate progress rail only when there is a real denominator. Token usage alone usually has no denominator.
- Keep lifetime/session totals separate from provider quota windows.
- Do not make a passive Home metric capture the mouse wheel.
- Bound any history by count or time. Aggregation must not grow renderer memory or persisted state without limit.

## Privacy and security

- Return counts and minimal source metadata, not prompts, responses, terminal buffers, account tokens, cookies, or raw provider payloads.
- Read provider credentials only in the trusted main process and send them only to the matching official endpoint.
- Redact subprocess stderr before logging; provider tools may include sensitive paths or identifiers.
- Avoid per-keystroke telemetry. Prefer provider-reported aggregates or coarse lifecycle events.
- Make network timeouts and subprocess termination explicit so a dead adapter cannot block app shutdown.

## Caching and freshness

Pick freshness from the semantics, not animation needs. Subscription quota may tolerate a minute-long cache; session token events can update on a structured completion/message event. Deduplicate concurrent refreshes. Preserve the last valid snapshot as `stale` after a transient failure, but do not preserve it forever without a visible age or expiry policy.

## Test matrix

At minimum, cover:

| Area | Cases |
|:--|:--|
| Normalization | complete payload, total-only payload, zero tokens, malformed/negative/non-finite values |
| Identity | correct session binding, unknown session, provider mismatch, account-wide response with no session key |
| State | loading, available, stale fallback, unavailable reason, first-read error |
| Lifecycle | concurrent refresh deduplication, timeout, subprocess cleanup, session disposal |
| Security | no credential/raw payload in snapshot or logs, only allow-listed IPC |
| Presentation | no fake denominator, stale label retained, unavailable localized, passive wheel behavior |

Run focused unit tests for adapters and pure selectors, then `npm test`, `npm run typecheck`, and `npm run build`. Finally inspect the real widget in Electron at normal scale and zoomed out.

For implementation placement and visual rules, return to [Widget authoring](widget-authoring.md).
