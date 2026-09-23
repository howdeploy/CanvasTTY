# Project context and conventions

Open **Settings → Context** to register a project folder and keep its instructions, preferences and design tokens. Context delivery is off by default. Enable it when you want compatible agent launches to receive the project's selected rules; a launch can also opt out independently.

## Create and preview rules

Register the source project folder, choose a category and add a rule with a stable key and a plain-text or JSON value. Rules can belong to your defaults, user, organization, project or a saved task. Current launch instructions have the most specific scope. At the same scope explicit rules take precedence over imported rules, which take precedence over eligible learned rules.

Use the preview to see the actual selected text at a data-class ceiling. A private winning rule is omitted for an ineligible route; its less specific public counterpart does not silently return. Security and dependency categories are considered even when other categories are filtered. Complete rules fit within bounded context budgets; the preview reports permitted omissions.

The launcher can select a saved task, categories and current instructions alongside a literal initial task. Its route preview reflects the selected account, model and host without starting an agent. Actual launch checks them again. Native CLI startup receives context once where the adapter supports it; ACP refreshes context for each actual task. A fresh restart obtains current rules. Disabling or deleting context cannot erase the classification of data already disclosed in an existing conversation.

## Import selected project files

Edit the registered project and enable selected sources. Imports read the current files when context is captured or previewed. There is no background project scan. The source list accepts:

- Literal instructions from `AGENTS.md`, `CLAUDE.md` and `CONTRIBUTING.md`.
- Development, contributing, testing and code-style sections under ATX headings in README files, including their Russian equivalents.
- Always-applied Cursor `.mdc` rules; scoped or unsupported frontmatter is reported rather than applied globally.
- Literal `.editorconfig` records and static JSON/YAML Prettier or ESLint mappings.
- Custom properties in selected top-level CSS `:root`, class or `data-theme` blocks.

Executable JavaScript/TypeScript configurations remain references and are never run. Imports are limited to 32 selected files, 64 KiB per file and 256 KiB total, within the registered project. Symlinks, hardlinks and nested separately registered projects cannot extend this boundary. The parser supports a small static subset; it does not evaluate the CSS cascade, media queries, Sass, executable configs or general Markdown.

An imported row is read only and shows its permitted source path, line and content digest. **Create explicit override** creates an editable rule with the same key. Missing files stop contributing rules; unsafe or malformed sources produce an error, without serving an old preview. A replaced project folder must be registered again.

Unknown source files have a D2 classification. Explicit path policies and source minimum classifications determine the effective class; a source minimum can only raise it. Provider-facing rule text does not contain local provenance paths or hashes.

## Design tokens

The editor offers colors, typography, spacing, radius and component foreground/background helpers. Component helpers save ordinary JSON rules; color references such as `var(--brand-cream)` remain literal. CSS root imports use keys such as `design.css.--brand-cream`. Selected additional themes have separate keys, so a dark-theme variable does not overwrite the root theme.

These are agent instructions and literal conventions, not a rendering engine or proof that a model obeyed them. Review the actual changes before applying them.

## Learn from explicit corrections

Select a project and expand **Project corrections and learning**. **Configure learning** controls that project only. Both learning and automatic application start off. **Capture correction** records a user correction, a user-attested accepted change, or an unconfirmed agent suggestion. You may select a verified running session from this project; its source and disclosure history raise the evidence classification when necessary. Terminal output is never interpreted as user confirmation.

A unique confirmed event adds evidence to its exact value. One, two and three or more confirmations yield heuristic scores of 0.45, 0.71 and 0.90. Each conflicting confirmation subtracts 0.30. Replaying an event or recording an unconfirmed suggestion does not increase the score. These numbers are a documented heuristic, not measured probabilities of correctness.

Automatic application uses a configurable threshold (default 0.85; allowed 0.50–1.00). The advisory threshold defaults to 0.60. Manual acceptance admits a candidate while learning is enabled, regardless of score, and takes priority over automatic alternatives for the same key. The candidate remains inferred; explicit and imported rules still take precedence.

Reject, disable or undo application removes the candidate from future context until you explicitly accept it again. Undoing an evidence record removes its vote while keeping its provenance and conservative classification. Disabling learning keeps records for inspection and excludes learned rules from new launches and new ACP tasks. It does not erase information already sent to a provider. Nothing is promoted to another project or a global rule automatically.

The registry allows 512 candidates total, 128 per project, 2048 evidence records total and 32 per candidate, within the existing 8 MiB store bound. Failed saves preserve the draft. Deleting a registered project also removes its tasks, rules and feedback.

## Check a reviewed snapshot against conventions

Edit a registered project and enable **Explicit convention checks**. This starts off independently of context delivery and learning. In **Settings → Execution → Workspaces → Selected-file capsules**, review stopped output and expand **Project convention checks**. Choose the report clearance and run the check explicitly. An authenticated parent can use `validate_capsule_conventions` only for its own current capsule and delegation generation; it cannot supply source paths, patches, rules or a higher clearance.

The validator reads immutable main-owned before/after file bytes, never renderer patches. It does not run a model, a formatter, ESLint, package commands or executable project configuration. Existing capsule source verification still checks repository identity. Results are advisory and never apply a fix. Report identifiers are ephemeral: at most eight latest capsule reports remain available, and a new check for a capsule replaces its old report. **Check currentness** rejects changed source/output, context imports, learning eligibility or path policies. Returning to the window or leaving the settings section clears the displayed snapshot; external edits require a fresh currentness check or rerun.

Only structured JSON rules whose key starts with `validate.` are executable checks. The Context editor offers presets. Existing scope/source precedence, inferred-rule eligibility, classification filtering and context budgets apply before validation. Unsupported visible rules and uncovered files produce diagnostics; ordinary prose remains agent context. A private winning rule cannot revive a weaker public rule. Files above the selected clearance are omitted without names or contents.

Supported values are deliberately narrow:

| `kind` | Other fields | Coverage |
| --- | --- | --- |
| `forbidden-colors` | `colors: ["#000000"]` | Complete six- or eight-digit hexadecimal literals on changed CSS property/value lines for `color`, `background`, `background-color`, `border-color`, `outline-color`, `fill`, `stroke`. |
| `forbidden-pair` | `foreground: "#000000", background: "#ffffff"` | A single `color` and `background`/`background-color` declaration in the same simple block, with at least one changed property/value line. Duplicate declarations are omitted. |
| `formatter-config` | `file: ".prettierrc.json", required: {"semi": true}` | Selected basename `.prettierrc` or `.prettierrc.json/yaml/yml`, `.eslintrc.json/yaml/yml`; up to 16 required top-level scalar values. Newly changed mismatches have exact scalar/declaration lines. Removal of a previously correct property is a diagnostic without a fabricated after-line. |
| `filename` | `extension: "tsx", style: "PascalCase"` | Extension `ts/tsx/js/jsx/css`; ASCII `kebab-case`, `camelCase` or `PascalCase`. Capsules select existing files, so a mismatching edited filename is an **existing-name advisory**, not a newly introduced violation. |
| `dependencies` | `section: "dependencies", allow: ["react"], deny: ["example-package"]` | Added or value-changed package names in the selected `dependencies`, `devDependencies`, `peerDependencies` or `optionalDependencies` section of `package.json`. Either allow or deny is required; deny takes precedence. No version interpretation, package resolution or dependency execution. |

CSS covers simple top-level tag, class, ID and `:root` selectors only. It does not evaluate nesting, at-rules, cascade, computed values, three-digit colors, shorthand, priorities, selector programs or strings as declarations. Comments and strings cannot create matches. JSON/YAML are strict static mappings, with duplicate keys, tags and aliases rejected. Unrelated bounded arrays such as package keywords/workspaces are allowed; configuration depth is at most four, each collection at most 64 entries and total nodes at most 2048. Existing unchanged violations do not become new warnings merely because a different line changed. No general user regex or glob runs.

Coverage is bounded to 64 executable rules, 256 KiB per file, 2 MiB combined before/after text, 10,000 lines per file, a one-million-cell changed-line comparison per file/four-million cells total and 250,000 CSS declaration checks. There are at most 128 warnings and 64 diagnostics; reaching a bound is explicit partial coverage. Binary/non-UTF-8, deleted, unsupported and deletion-only files never receive an invented pass. The report names the immutable review and context digests and includes permitted exact file/line coordinates. Absence of warnings is not whole-project validation.

## Request an advisory agent review

For an immutable changed capsule review, expand **Review with agent**, load the available routes, select an exact local API account/model/container, and use **Preview route and context**. **Launch paid review** is a separate explicit action that consumes that account's quota. No model, credential lookup or engine probe occurs while loading choices or previewing. The route shows the account's fixed host; this initial diff-only review supports local bridge-network API containers. Ordinary full-workspace remote containers remain available separately.

The capsule must belong to its original live local parent with delegation enabled. A capsule created without a parent does not silently acquire one. The parent, its generation, ordinary child/depth/concurrency budgets, account/model clearance and current path policies are checked again during launch. A preview expires after ten minutes and is single use. Changed source files, reviewed output, context or route configuration invalidate it. Draft route selection survives errors; refresh never changes the account/model/profile merely because the list was reordered.

The review child mounts only main-created `Review.patch` and a fixed `Task.md`, read only, plus its normal private temporary API configuration. It receives the exact previewed, route-filtered optional context once through the ordinary launch path. Global or inherited per-session context opt-out still applies. Mandatory diff classification includes changed and deleted source bytes, context lines and path metadata; the parent disclosure floor remains conservative. Disabling optional context cannot downgrade the diff. The patch is bounded to 1 MiB.

The result is an ordinary retained **Advisory review** session on the canvas; **Open review** shows its launch status and response. The output is untrusted advice, with no automatic application, source-file access or child delegation. The derived artifact has no source baseline and cannot use normal apply/recovery, convention or test-snapshot actions. Once its container is confirmed stopped, its immutable review files may be removed. After app restart the retained files may be cleaned, but saved identifiers cannot reconstruct launch authority: prepare a new review. Unknown container ownership remains retained for explicit generation cleanup.

Authenticated agents can explicitly use `preview_capsule_review_agent` and then `launch_capsule_review_agent` for their own reviewed capsule. The preview tool returns route/identity metadata, not filtered preference text that might exceed the parent's clearance. Provider-internal subagents are not involved. No model quality, cost reduction or token savings is assumed or measured by this feature.

### Explicit delegation at launch

The ordinary agent launcher includes **Allow launching subagents**, initially off. Its choice survives a failed launch and a Settings round trip alongside the task, account, model, context and isolation draft. An enabled launch stays an interactive session with explicit delegation permission; the session card shows Delegation. Main checks both this permission and legacy orchestrator requests before preparation and at restart/restore boundaries. Existing account-per-service/per-host affinity, classifications, context floors, budgets and parent ownership remain in force.

Delegation is separate from browser access. With browser access off, supported native launches receive only `canvastty_agents` MCP configuration and an authenticated orchestration capability. No browser capability, server entry or browser permission grant is added. The helper uses the exact connection identity issued for that launch; the bootstrap token expires and is single-use, reconnect keeps the same identity, and exit/restart/disposal revokes old authority. Browser-on configuration keeps its existing behavior. Shared Hermes/Kimi temporary configurations refuse a browser permission change while in use; close the existing sessions before changing that mode. Owned cleanup/recovery preserves unrelated user configuration.

Supported parent routes are local direct and worktree PTY for Claude, Codex, Qwen, OpenCode, Hermes and Kimi, plus local direct/worktree ACP for Cursor, MiniMax and Kimi. The installed runtime and local helper must be available. ACP v1 uses stdio MCP in `session/new`/`session/load`; HTTP/SSE capability flags do not imply stdio refusal. A provider rejecting the request leaves a failed session and revokes its capability. This is transport/configuration support, not a claim about provider login, subscription or model entitlement. PTY with custom Hermes/Kimi account homes, unsupported native providers, remote parents and container parents reject delegation before credentials or engine preparation. Custom Kimi homes remain usable through configured ACP. Selected-file capsule/review delegation still requires an original live local **direct** parent; worktree support does not broaden capsule authority.

The application retains its existing local orchestration gateway socket and heartbeat timer from startup. Off launches create no orchestration capability, MCP config or helper process; this feature adds no new resident worker or polling loop. There is no claim of zero startup sockets.
