# ADR: Declarative Provider CLI Command Definitions

**Date:** 2026-09-21
**Scope / Component:** provider CLI discovery (`providerCliRegistry.ts`)
**Risk/Strictness Profile:** Production
**Status:** Proposed

**Implementation:** [`providerCliRegistry.ts`](../../src/main/services/providerCliRegistry.ts)

## Context and Problem Statement

Provider resolution historically derived every candidate path from the provider ID itself:
`codex` → `<dir>/codex`, `qwen` → `<dir>/qwen`. Per-provider knowledge lived in an
`if (provider === …)` chain inside `knownProviderDirectories` (OpenCode, Kimi, Grok home
directories, the Codex Windows LOCALAPPDATA path). That coupling is already false for incoming
providers: MiniMax Code installs as `mcode`, Cursor as `agent`, Google Antigravity as `agy`.
Without a change, each such provider would grow a new special case in the resolution loop, and
`executable === provider` would remain a hidden invariant no type enforces.

## Decision Drivers

- Adding a provider whose executable differs from its ID must not require changes to the
  resolution algorithm, only data.
- Existing providers must keep resolving to byte-identical executables, candidate orders, and
  child `PATH` values.
- The registry stays an immutable, startup-once snapshot; nothing here may introduce per-launch
  lookups.
- Definitions are trusted, in-repo configuration: structural mistakes (duplicate provider,
  empty command list) should fail fast and loudly rather than silently resolve nothing.

## Options Considered

### Keep the ID-derived mapping and add per-provider overrides where needed

Each new mismatched provider adds both a `commands` special case and possibly a directory
special case. Rejected: the special-case count grows with every provider and the invariant
stays implicit.

### Resolve through the user's shell (`which`/`where`) per launch

Rejected earlier and unchanged: startup-once resolution without shell startup scripts is a
documented product invariant.

## Decision Outcome

Resolution is driven by `ProviderCliDefinition`:

```ts
interface ProviderCliDefinition {
  id: AgentProviderId;
  commands: readonly string[];
  knownDirectories?: readonly ProviderCliKnownDirectory[];
}
```

`PROVIDER_CLI_DEFINITIONS` is a frozen, exhaustive `Record<AgentProviderId, …>` — adding a
provider to the union without a definition is a compile error. Candidate generation walks
directories in the established order (inherited `PATH`, platform defaults, known provider
directories, shared user directories) and, within each directory, tries each command in
declaration order with each platform launcher extension. `knownDirectories` replaces the
`if`-chain with `home`-relative and Windows `LOCALAPPDATA`-relative specifiers resolved at
startup. `createProviderCliRegistry` accepts an optional `definitions` override used by tests
to exercise definitions for providers not yet in the union; production always passes none.

Definitions with an empty `commands` list or duplicate IDs throw at registry creation.

## Consequences

- The executable may legitimately differ from the provider ID; consumers already work from
  `AvailableProviderCli.executable`, so no downstream change is needed.
- Command declaration order is a real priority within one directory: the first listed command
  wins when several are installed in the same directory.
- Per-provider directory knowledge is now reviewable data instead of control flow; a reviewer
  can diff provider support without reading the resolution algorithm.

## Invariants

- With default definitions, every pre-existing provider resolves exactly as before this change
  (same executable, same candidate order, same child `PATH`).
- A provider with no definition cannot compile into the union; a definition without commands
  cannot create a registry.
