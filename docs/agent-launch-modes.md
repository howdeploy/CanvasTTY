# Agent launch modes

Reviewed on 2026-10-30. The launcher, settings, session validation and orchestration
share `src/shared/autoMode.ts`. Modes below describe the current adapters with
CanvasTTY isolation **off**. Enabling isolation also offers contained Auto for
CLIs without a native Auto mapping; it runs their bypass inside that layer.
Manual retains the person's CLI configuration. No personal config is rewritten.

| CLI | Modes offered without CanvasTTY isolation | Launch mapping and limits |
| --- | --- | --- |
| Codex | Auto, Manual, Accept edits, No prompts, Plan, Bypass | Auto uses `--approve-for-me`; edits use workspace-write/on-request; No prompts uses workspace-write/never and refuses escalation; Plan uses read-only/on-request, not a separate planner. |
| Claude Code | Auto, Manual, Ask for approval, Accept edits, No prompts, Plan, Bypass | Native `--permission-mode auto`, `manual`, `acceptEdits`, `dontAsk`, `plan`; Bypass uses `--dangerously-skip-permissions`. No prompts denies actions requiring approval; it is not bypass. |
| Qwen Code | Auto, Manual, Ask for approval, Accept edits, Plan, Bypass | `--approval-mode auto`, `default`, `auto-edit`, `plan`; Bypass uses `--yolo`. |
| Kimi | Auto, Manual, Plan, Bypass | Kimi 2.4+: Auto is Ask When Needed (`--yolo`); Bypass is Never Ask (`--auto`); Plan uses `--plan`. No edit-only mode. Plans still require review in Never Ask. |
| OpenCode | Auto, Manual, Accept edits, Plan, Bypass | Launch-only permission configuration; Plan uses `--agent plan`. Auto retains personal deny/ask rules and asks for shell commands unless the existing CanvasTTY shell guard applies. The CLI's dangerous `--auto` is not used for this profile. |
| Hermes | Manual, Bypass | `--yolo` is supported. Smart/manual/off comes from `approvals.mode` in the shared user config; neither root nor `chat` has an approval/config-overlay launch flag. Changing shared config would affect other sessions. Plan requires a plugin. These need additional integration rather than a flag mapping. |
| Grok Build | Auto, Manual, Ask for approval, Accept edits, No prompts, Plan, Bypass | Native `--permission-mode auto`, `default`, `acceptEdits`, `dontAsk`, `plan`; Bypass uses `--always-approve`. |
| OMP | Manual, Ask for approval, Remember approvals, Accept edits, Bypass | `--approval-mode always-ask`, `always-ask-cached`, `write`; Bypass uses `--auto-approve`. Cached mode also asks for ungranted file reads; its dialog controls cross-session persistence. `--plan <id>` selects a model. The `--config` overlay setting `plan.defaultOnStartup` applies only to empty sessions without saved mode changes; it cannot enforce Plan on resumed cards, so a reliable Plan profile needs additional integration. |
| Pi | Manual, Bypass | Pi has no built-in permission tiers or Plan mode. The existing Bypass option only passes `--approve` for project-file trust; it does not add an approval system. Extensions can add other behavior. |
| Cursor | Manual, Plan, Read only, Bypass | Native `--mode plan`, `--mode ask`, `--force`. Ask is a separate native read-only mode. `--sandbox enabled/disabled` is an independent execution setting, not an automatic-approval mode. |
| MiniMax Code | Manual, Bypass | Interactive permission/plan choices exist in the TUI, but neither the public source nor the published 0.7.1 interactive parser has permission/plan launch flags. Its exec-only `--permission` and `--config` are not valid for interactive cards. `--mode standard/lightweight` changes context, not permissions. Existing Bypass adds no flag and retains personal settings. |
| Devin | Auto, Manual, Ask for approval, Accept edits, Autonomous, Bypass | `--permission-mode smart`, `normal`, `accept-edits`, `autonomous`, `dangerous`. Autonomous also passes `--sandbox` (Linux/macOS); direct file edits can still ask. Smart availability can depend on the account. Native 3000.11.228 rejects `--permission-mode plan`; `/plan` is an in-session command. |
| Antigravity | Auto, Manual, Ask for approval, Accept edits, Plan, Bypass | `--mode auto`, `default`, `accept-edits`, `plan`; Bypass uses `--dangerously-skip-permissions`. Native Auto requires the terminal sandbox and CLI 1.3.5+ on Linux/macOS or 1.4.4+ on Windows. Plan is the CLI's planning workflow, not a filesystem sandbox. |
| Terminal | Manual | Ordinary shell. |

Auto on a third-party model uses Accept edits where that mapping exists. Kimi
has no edit-only tier and retains Ask When Needed; the card does not falsely
label that launch as Accept edits. Approval flags and names are provider-owned:
Kimi's `--auto` must not be mistaken for CanvasTTY's supervised Auto profile.

Manual deliberately adds no permission switch and retains saved CLI choices.
Ask for approval explicitly selects a native approval mode for this run; it
does not erase the CLI's allow/deny rules. Provider-specific defaults, restored
cards, plugin sessions and orchestration accept the new profile ids too. The
subagent ceiling also applies when its provider lacks the inherited profile:
a read-only/planning parent cannot silently fall back to a writable Manual child.

## Evidence and verification limits

Local `--version`/`--help` probes used empty temporary homes: Codex 0.163.0,
Claude Code 2.1.312, Kimi 2.4.0, Grok 1.0.70, OpenCode 1.18.29, and the installed
Hermes 0.21.0 derivative. Claude and Kimi produced empty output inside the agent
sandbox; their native probes were repeated outside it. No account configuration
or model calls were needed. The official Devin 3000.11.228 Linux artifact was
downloaded into the ignored review directory, checked against its manifest's
SHA-256, and probed under an empty HOME: Smart, Normal and Autonomous passed
argument parsing with `--help`; Plan was rejected. No CLI was installed.
MiniMax's published 0.7.1 npm archive was checked against its registry SHA-512
and its bundled interactive parser inspected without executing the package.
Qwen, OMP, Pi, Cursor and Antigravity were reviewed against primary
documentation/source, not executed locally. Hermes root and `chat` help and
the approval/config loaders were inspected in both the installed derivative
and upstream source.

These mappings target the documented current CLI interfaces. CanvasTTY does not
currently discover permission capabilities by installed version; old CLI builds
or unavailable native sandboxes can reject a selected mode. Real sessions and
native Windows/macOS behavior were not checked in this review. Application
tests, typecheck, build and UI checks were not run for this follow-up change.

Primary references:

Raw local probes and the inspected public artifacts are saved in the ignored
`tmp/launch-mode-review/` directory; they are review evidence, not release assets.

- [Kimi command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html) and [permission semantics](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/interaction).
- [Qwen approval modes](https://github.com/QwenLM/qwen-code/blob/70be140e148f8fc7527cc51717603a6dd84abc19/docs/users/features/approval-mode.md) and [CLI options](https://github.com/QwenLM/qwen-code/blob/70be140e148f8fc7527cc51717603a6dd84abc19/packages/cli/src/config/top-level-options.ts).
- [Devin launch flags](https://docs.devin.ai/cli/reference/commands) and [Smart mode](https://docs.devin.ai/cli/reference/permissions).
- [Antigravity execution modes](https://antigravity.google/docs/cli/modes).
- [OMP approval rules](https://github.com/can1357/oh-my-pi/blob/5dabff10fa5f069ec619c54d0daf7b269687b19c/docs/approval-mode.md) and [CLI reference](https://github.com/can1357/oh-my-pi/blob/5dabff10fa5f069ec619c54d0daf7b269687b19c/docs/cli-reference.md).
- [OMP startup Plan condition](https://github.com/can1357/oh-my-pi/blob/5dabff10fa5f069ec619c54d0daf7b269687b19c/packages/coding-agent/src/modes/interactive-mode.ts) (`shouldEnterPlanModeOnStartup`).
- [Hermes approval configuration](https://hermes-agent.nousresearch.com/docs/user-guide/security) and [Plan plugin](https://hermes-agent.nousresearch.com/docs/plugins/plan-mode).
- [Pi](https://github.com/earendil-works/pi/blob/1be312b46abe45d3914743a4d7837ebaf534d390/packages/coding-agent/README.md).
- [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters).
- [MiniMax interactive versus exec contracts](https://github.com/MiniMax-AI/minimax-code/blob/50448abe3c753391cbfb24df835518d844504862/packages/tui/src/cli/contract.ts).
- [MiniMax published package](https://www.npmjs.com/package/@minimax-ai/code/v/0.7.1) and [Devin artifact manifest](https://static.devin.ai/cli/current/manifest.json).
