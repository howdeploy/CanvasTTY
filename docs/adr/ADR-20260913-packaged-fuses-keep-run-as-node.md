# ADR: Keep `runAsNode` Enabled in Packaged Builds

**Date:** 2026-09-13
**Scope / Component:** Electron packaging, binary fuse configuration, and bundled helper execution
**Risk/Strictness Profile:** Production
**Status:** Accepted
**Related:** [ADR: Selective Intake from the v1.2.1 Line](./ADR-20260913-selective-intake-from-v121.md)
**Implementation:** [`electron-builder.yml`](../../electron-builder.yml), [`src/main/index.ts`](../../src/main/index.ts), [`src/agent-runtime/`](../../src/agent-runtime/), [`agent-browser/ProviderLaunch.ts`](../../src/main/services/agent-browser/ProviderLaunch.ts), and [`agent-runtime/ProviderRuntimeLaunch.ts`](../../src/main/services/agent-runtime/ProviderRuntimeLaunch.ts)

## Context and Problem Statement

Electron's fuses harden a packaged binary against living-off-the-land (LoTL) execution: a packaged
app that still honours environment-provided Node options, inspect arguments, or a re-executable
Node mode can be turned into a general-purpose Node runtime by anything that can influence its
launch.

CanvasTTY cannot simply close every fuse. Its agent integration runs bundled JavaScript helpers as
child processes, and the cheapest reliable way to run them with the packaged binary is
`{ command: process.execPath, args: [helper], env: { ELECTRON_RUN_AS_NODE: "1" } }`. Three
execution paths depend on it:

- the main process launches the browser, agent-runtime, and plugin-hook helpers through the
  packaged executable (`src/main/index.ts`);
- the shipped runtime bundles spawn further helpers themselves
  (`src/agent-runtime/opencode-plugin.mjs`, `src/agent-runtime/plugin-hook-runner.mjs`);
- the generated provider entries — MCP helper commands for Claude/Codex/Qwen/OpenCode/Kimi and the
  lifecycle hook commands — are written into provider CLI configuration and executed by the
  provider CLI, not by our main process.

The question is where the fuse line is drawn: which protections are worth their cost, and whether
`runAsNode` is one of them.

## Decision Drivers

- Close the fuse vectors that cost the application nothing.
- Do not break the agent integration, which is the product's core capability.
- A fuse is applied at package time, so a wrong choice is a release-wide defect, not a runtime one.
- The packaging allow-list and asar integrity must carry the defenses the fuses cannot.
- Avoid irreversible packaging transitions that later releases cannot back out.

## Options Considered

### Close `runAsNode` (`runAsNode: false`)

This is the strongest single fuse, since it prevents the packaged binary from acting as a Node
runtime at all. It also disables every helper launch above: the main-process bridge helpers, the
runtime bundles' own spawns, and the provider-config entries executed by the provider CLI. The
agent integration would fail in packaged builds while working in development. Rejected.

### Replace helper spawns with `utilityProcess`

Electron's `utilityProcess` does not need `runAsNode`. It would only address the launches our main
process owns; the helper entries written into provider CLI configurations and the runtime bundles'
own spawns would remain on `ELECTRON_RUN_AS_NODE`. Migrating the remaining paths would change the
provider integration contract rather than the fuse configuration. Rejected.

### Leave every fuse at its default

This keeps the helper path working but also leaves environment-injected Node options, CLI inspect
arguments, and unvalidated asar loading available in the shipped binary, at no benefit. Rejected.

### Close the environment and integrity fuses, keep `runAsNode`

Close what costs the application nothing and keep the one fuse the helper contract depends on.
Selected.

## Decision Outcome

```yaml
electronFuses:
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableEmbeddedAsarIntegrityValidation: true
```

`runAsNode` is deliberately left enabled. `onlyLoadAppFromAsar` is likewise left off, so the helper
`.mjs` files remain loadable from `resourcesPath`, outside the application asar. The distributable
stays an explicit allow-list (`out/**`, `package.json`, `LICENSE`), so no source tree, docs, local
agent context, settings, logs, or credentials ship inside the package, and the shipped helper
bundles are the only JavaScript reachable outside the asar.

`enableCookieEncryption` is intentionally **omitted** rather than set to `false`: the fuse is a
one-way transition, so a release that enabled it would leave every later build without the key
reading the encrypted store as plaintext and corrupting the profile's cookies. Leaving the key
absent keeps the current behavior explicit without committing the profile to a transition the
project is not ready to keep.

The accepted consequence is that the packaged binary still becomes a Node runtime when launched
with `ELECTRON_RUN_AS_NODE`. Whoever can already set that variable on an app launch gains a Node
runtime under the user's privileges — the same capability the agent integration itself uses.

## Invariants

1. Environment-provided Node options, `NODE_EXTRA_CA_CERTS`, and CLI inspect arguments are ignored
   by the packaged binary.
2. The embedded asar is validated when `app.asar` is loaded.
3. `runAsNode` stays enabled only while the helper contract requires it.
4. Helper launches use the packaged executable; helper environment is restricted to the exact
   keys the integration allows, of which `ELECTRON_RUN_AS_NODE` is the only permitted one.
5. The distributable remains an allow-list for application code: no writable script ships inside the
   asar. The bundled helpers are the recorded exception — seven `.mjs` files placed outside the asar
   by `extraResources` (`electron-builder.yml:53-65`) and, on Windows, the agent pipe host
   executable (`electron-builder.yml:85-87`); the Decision Outcome above already calls the helper
   bundles "the only JavaScript reachable outside the asar". *(Scoped 2026-09-14: the original
   wording claimed that no writable script ships inside the package at all.)*
6. `enableCookieEncryption` is not written to the fuse configuration unless the project accepts the
   one-way transition.

## Consequences and Mitigations

- The agent integration keeps working in packaged builds. This is the reason the fuse stays on and
  it is not a temporary exception to be revisited without a replacement helper mechanism.
- A packaged binary can be re-executed as Node by anything that already controls the app's launch
  environment. The mitigations are the packaging allow-list (nothing writable or interesting ships
  inside the package), asar integrity validation on the application bundle, and the fact that the
  app runs with the user's own privileges rather than elevated ones.
- `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, and `--inspect` can no longer be injected through the
  environment, which removes the cheapest paths from an environment-only attacker to arbitrary code
  inside the app process.
- Because `onlyLoadAppFromAsar` stays off, the helper `.mjs` files must remain part of the
  distributable allow-list. Adding a new helper without adding it to packaging is a shipping bug.

## Validation and Confidence

The fuse values are the packaged configuration itself; the helper contract is verified by the three
call sites that build `ELECTRON_RUN_AS_NODE` launches and by the allow-lists in
`agent-browser/ProviderLaunch.ts`, `agent-runtime/ProviderRuntimeLaunch.ts`, and `hermesConfig.ts`,
which accept exactly that key. Development builds are unaffected, because fuses are applied at
package time; a packaged smoke of the agent integration is the required boundary check.

Confidence is high for the chosen fuse set and for the LoTL exposure it accepts, since the exposure
is the documented behavior of the fuse that is left enabled. It is medium for the claim that no
other packaged path needs `runAsNode`: that follows from the three call sites above, and a new
helper mechanism would have to be checked against it.

The decision is falsified if a packaged build can start an agent session without
`ELECTRON_RUN_AS_NODE` (the fuse could then be closed), or if the app can no longer reach its
helpers in a packaged build (the fuse choice would have to be revisited).

## Amendment 2026-09-14

This block is appended; the decision body above stays as the historical record.

- **The `onlyLoadAppFromAsar` rationale was replaced in place instead of being amended.** Commit
  `3aa685c` rewrote the recorded reason for leaving that fuse off. The original entry said the fuse
  was left off "so the helper `.mjs` files remain loadable from `resourcesPath`"; the sentence in the
  Decision Outcome now says the recorded reason "is therefore not helper loadability — it is that no
  packaged build has exercised the flip". The fuse values did not change in that commit.
  `docs/adr/README.md:12-14` requires an accepted record to be append-only, so the change of reason
  belongs here; this block, not the rewritten sentence, is the amendment of record.
- **Invariant 5 is scoped to application code.** `extraResources` ships seven `.mjs` helper files as
  plain files outside the asar (`electron-builder.yml:53-65`) and, on Windows, the agent pipe host
  executable (`electron-builder.yml:85-87`). The unqualified wording originally claimed that no
  writable script ships inside the package at all; the scoped wording in the invariant list is the
  live one, and the helper bundles remain the documented exception, as the Decision Outcome and the
  Consequences section already state.
- **Link.** [ADR: Selective Intake from the v1.2.1 Line](./ADR-20260913-selective-intake-from-v121.md)
  already listed this record; the `Related` entry in this record's header completes the pair.

## References

- [`electron-builder.yml`](../../electron-builder.yml)
- [`src/main/index.ts`](../../src/main/index.ts)
- [`agent-browser/ProviderLaunch.ts`](../../src/main/services/agent-browser/ProviderLaunch.ts)
- [`agent-runtime/ProviderRuntimeLaunch.ts`](../../src/main/services/agent-runtime/ProviderRuntimeLaunch.ts)
- [Architecture](../ARCHITECTURE.md)
