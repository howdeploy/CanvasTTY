# Verifying the post-1.7 agent features

How to repeat the checks for the orchestration, workspace and protection features added after 1.7. Every command runs from the repository root. Nothing here needs a real account, a paid agent or your own CanvasTTY data.

## Use a throwaway home

Tests and smokes read the same folders as the CLIs they imitate. Point them at an empty home so no real token, account or setting is read:

```sh
export HOME="$(mktemp -d)"
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share"
export CODEX_HOME="$HOME/.codex" GROK_HOME="$HOME/.grok" CLAUDE_CONFIG_DIR="$HOME/.claude"
git config --global user.name "CanvasTTY test" && git config --global user.email "test@example.invalid"
```

The git identity is needed by the worktree acceptance tests.

## Core checks

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run audit:secrets
```

CI uses Node 22, which loads TypeScript test imports and `node:sqlite` without flags. On Node 23 add `NODE_OPTIONS='--experimental-strip-types --experimental-sqlite'`. Tests that start local gateways need permission to open local sockets.

Behavior that is easy to break has its own test file, for example:

| Area | Test |
| --- | --- |
| Typing into a terminal before its code has loaded; a failed load or a failing card | `tests/deferred-terminal-card.test.mjs` |
| Dragging one card does not render the others | `tests/canvas-card-render-cost.test.mjs` |
| A damaged saved preset does not hide the others | `tests/workspace-presets-validation.test.mjs` |
| Account attribution and the default sign-in | `tests/launch-contributors.test.mjs` |

Run one file with `node --test tests/<name>.test.mjs`.

## Real application smokes

Each smoke starts the built app (`npm run build` first) with a fresh home and stub agents:

```sh
npm run smoke:backlog          # task tree, flows and their approval, task board, checkpoints, usage, broadcast
npm run smoke:plugin-review    # plugin change review dialog
npm run smoke:accounts-limit   # limit notice and handoff preview (CANVASTTY_ACCOUNTS_PLUGIN_DIR = an accounts plugin checkout)
npm run smoke:github-auth      # showcase sign-in, cancel and retry
```

The terminal loading smoke needs a dedicated build: `npx electron-vite build --mode terminal-smoke`, then `node scripts/smoke-terminal-loading-electron.mjs`. Rebuild normally afterwards.

## Mutation check

`npm run test:mutation:backlog` changes selected guards one at a time and expects a test to fail for each. It requires a clean checkout (or `--source-ref <commit>`) and writes its report to `artifacts/backlog-mutation-report.md`, which is not tracked. It covers the listed guards only, not the whole application.

## Measurements

`scripts/bench-renderer-graph.mjs` (static JavaScript the window loads), `scripts/bench-startup-optimization.mjs` (hidden-window startup), `scripts/bench-usage-optimization.mjs` (usage counters) and `scripts/bench-redaction-optimization.mjs` (masking throughput) measure one machine with synthetic input. Compare two builds by running each several times, interleaved; a single run is not a result.

## Linux socket guard

The strict network modes on Linux need the packaged native helper and Landlock ABI 9 or newer. On such a Linux machine with Go installed: `cd native/canvastty-helper && go test ./...`. An older kernel must refuse strict launches with a reason.

## Plugins

The accounts, assistant, context and environments plugins live in their own repositories; run `npm test` and `npm run build` in each.

## Not covered by automated checks

- The full bubblewrap and provider launch on Linux with strict network modes, and amd64 runtime.
- Pausing a budget stops the agent's process group and the descendants found by parent process at pause time, including ones that started their own session; a process already re-parented to init is not attributable, and Windows cannot pause running work.
- Live providers: resumed conversations, routing quality of the assistant plugin, every provider's question and approval forwarding.
- Physical phone and Even G2 delivery.
