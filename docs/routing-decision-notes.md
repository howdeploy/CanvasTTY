# Routing, search and context selection

The user's September 21 follow-up expands the experimental routing work to token savings through three optional operations: selecting an agent/model or next action, semantic code search, and selecting relevant context. Agent/model selection is implemented as opt-in routing (below); semantic search and context selection are not implemented yet. The original roadmap remains unchanged; these notes record the follow-up and researched integration boundaries.

## Product contract

- Exact names and literal patterns use local deterministic search. Semantic search can score a bounded set of candidate source excerpts and return original file paths, line numbers and text. It must never invent evidence or report an incomplete search as exhaustive.
- Routing chooses only among candidates already permitted by data policy, account-to-host binding, capabilities and current resource limits. A decision model cannot waive those checks or generate an executable command.
- Context selection keeps source material verbatim. Current user instructions, approvals, active constraints, failures and unresolved work are mandatory context. Selection cannot delete the original history or break tool-call/result pairs. Only context owned by CanvasTTY may be compacted; vendor CLI histories require a verified provider adapter.
- A common decision interface can support deterministic rules, opt-in Jev and opt-in Laya. Feature-off means no helper, model download, request or polling. Laya runs in a separate lazily started process on a chosen host, outside Electron.
- Router metadata contains only bounded categorical features and opaque eligible IDs. Semantic search and context selection have a different disclosure surface: any source/text sent to a cloud backend requires an explicitly configured, eligible data-handling path. No silent endpoint fallback may change that path.
- Quality gates compare relevant-code recall, task completion, wrong routing, retained required context, input/output volume, measured cost where available, latency, CPU and memory. Savings are measured against a baseline; they are not guaranteed from a demo or model price.

## Primary implementation references

- [TypeSafe API](https://docs.typesafe.ai/api): typed choices, yes/no scores and ordinal scores over supplied state. It does not scan a repository or execute tools by itself.
- [jegrep](https://github.com/can1357/jegrep): semantic repository navigation with compact evidence output. Its automatic backend fallback must not be copied across CanvasTTY privacy boundaries.
- [jevgrep](https://github.com/nassim-arifette/jevgrep): CLI/MCP search with source excerpts and score caching; advertised transport verification varies by backend.
- [jev-router](https://github.com/gargpratyush/jev-router): per-turn Claude/Codex model selection through CLI proxies. A reference for routing policy, not an automatic replacement for CanvasTTY account and host controls.
- [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction): verbatim history selection. Its demonstrated compression does not establish preservation of every fact needed by a later task.
- [Laya](https://github.com/NandhaKishorM/laya): Apache-2.0 local decision model. The maintainers explicitly distinguish fine-tuned results from weak base-model zero-shot results and recommend calibration. It needs CanvasTTY-specific evaluation before automatic use.
- [System One adapter](https://github.com/typesafe-ai/system-one-adapter-python): an official open adapter implementing a similar decision interface over other LLM APIs. This provides an interface alternative, not evidence of equal latency, cost or calibration.

Source and documentation inspection is not a live integration test. No external project was installed and no project code, history or credentials were submitted to these models during research.

## Source review findings

The six reviewed Jev integrations publish MIT-licensed integration code; Laya is Apache-2.0. These licenses do not make Jev model weights open. The useful patterns are a local shortlist before cloud scoring (`jegrep`), explicit source-sharing configuration and exact excerpts (`jevgrep`), routing at a new-turn boundary with cache costs considered (`jev-router`), and selecting old tool pairs while preserving retained text (`fast-jev-compaction`).

CanvasTTY must filter candidates before sending any request, then recheck the selected action before executing it. [JevRouter](https://github.com/BillionsBobby/JevRouter/blob/f944acb6530621bced023352e2358a63218bf4d9/src/router.ts) demonstrates typed model/tool/subagent decisions, but filters candidates after the provider call. That order is unsuitable for CanvasTTY's disclosure boundary.

The [compactor's candidate construction](https://github.com/tamaratran/fast-jev-compaction/blob/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0/src/state.ts) sends conversation text and tool inputs, omits actual outputs from scoring, and does not inherently protect old writes or failures. Its positional pinning is insufficient for this product's mandatory facts. A separate author's [small held-out experiment](https://github.com/jcressler/fast-jev-compaction-codex/blob/main/benchmarks/HELDOUT-RESULTS-2026-09-18.md) found no exact-pass improvement from Jev and stopped that integration. This is limited evidence, but reinforces the requirement to benchmark quality and total cost before enabling automatic selection.

## Implemented agent routing (September 23)

Routing is off by default. When enabled, candidates are the configured routes plus, by default, automatically assembled tuples: every configured account for an agent (or the ordinary CLI login when the agent has no accounts), on each computer where the CLI was detected (remote hosts use only the last cached discovery, never a new probe), each concrete model from the account's model list (up to three), and each selected reasoning effort the CLI supports. A broken configured account never falls back to the ambient login. Every candidate still passes launch policy, capacity, data class and runtime checks before any evaluator call; automatic routing enforces the ambient provider estimate instead of warning.

Reasoning effort is a launch dimension with verified per-CLI flags only: Claude `--effort` (low, medium, high, xhigh, max), Codex `-c model_reasoning_effort="…"` (minimal, low, medium, high, xhigh) and Grok `--reasoning-effort` (low, medium, high, xhigh). Other agents reject an explicit effort; Cursor selects thinking through its model name. Effort reaches ordinary launches, subagents (`spawn_agent`), restart/restore and saved sessions, and is refused for ACP and containers.

Each route carries relative cost and quality (operator estimates, otherwise derived from effort). Without a matching rule, a stated task difficulty orders routes deterministically: simple prefers the cheapest, hard the strongest, normal the medium effort. With Jev enabled and the separate metadata grant, Jev receives task category, difficulty, data class and, per candidate, agent, model, effort, cost, quality, subscription limit headroom (from the ambient LimitsService snapshot, when available) and local/remote. Paths, route and account identities, sources and context are not sent. Task text is sent only with an explicit grant up to D1 or D2; D3 text is never sent.

Response validation follows the documented contract (`model`, `answers`, `usage`) but tolerates `jev-latest` or dotted versions, extra metadata fields, partial or rounded distributions (1% tolerance), a missing confidence and `prompt_tokens`/`completion_tokens` usage names. Duplicate keys, unknown choices, invalid distributions, oversized or deeply nested payloads and a different pinned version still fall back to rules. No live TypeSafe call has been made: there is no key in this environment.
