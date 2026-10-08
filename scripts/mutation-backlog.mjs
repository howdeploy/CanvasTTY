import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
// A local result (artifacts/ is not tracked); the JSON summary is also printed.
const reportPath = join(repoRoot, "artifacts", "backlog-mutation-report.md");
const refIndex=process.argv.indexOf("--source-ref");
const sourceRef=refIndex<0 ? "HEAD" : process.argv[refIndex+1];
const baselineOnly = process.argv.includes("--baseline-only");
const sourcePaths = ["src", "tests", "scripts", "native", "integrations", "examples/plugins", "package.json", "package-lock.json",
  "tsconfig.json", "tsconfig.node.json", "tsconfig.web.json", "electron.vite.config.ts"];
if (refIndex < 0) {
  const clean = spawnSync("git", ["diff", "--quiet", "HEAD", "--", ...sourcePaths], { cwd: repoRoot });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", ...sourcePaths], {cwd:repoRoot,encoding:"utf8"});
  if (clean.status !== 0 || untracked.trim()) throw new Error("Source files differ from HEAD. Pass --source-ref with an immutable Git object id to test the intended source tree.");
}
if(!sourceRef || !/^(?:HEAD|[a-f0-9]{7,40})$/i.test(sourceRef))throw new Error("--source-ref must be HEAD or an immutable Git object id.");
const sourceTree=execFileSync("git",["rev-parse","--verify",`${sourceRef}^{tree}`],{cwd:repoRoot,encoding:"utf8"}).trim();
const copyRoot = mkdtempSync(join(tmpdir(), "canvastty-mutation-"));
const commonArgs = ["--experimental-strip-types", "--test", `--test-concurrency=${baselineOnly ? 8 : 1}`, "--test-force-exit", "--test-reporter=spec"];

function defineMutation(target, [id, before, after, pattern]) {
  return { ...target, id, before, after, ...(pattern === undefined ? {} : { pattern }) };
}

// Repeated source/test pairs share one definition; mutation order and selectors stay explicit.
const mutationTargets = {
  githubAuth: {"file":"src/main/services/GithubAuthService.ts","test":"tests/github-auth.test.mjs"},
  timelinePages: {"file":"src/main/services/SessionTimelineService.ts","test":"tests/timeline-large-pages.test.mjs"},
  checkpoints: {"file":"src/main/services/GitCheckpoints.ts","test":"tests/checkpoint-object-replacement.test.mjs"},
  budgets: {"file":"src/main/services/OrchestrationBudgetService.ts","test":"tests/orchestration-backlog-core.test.mjs"},
  redaction: {"file":"src/main/services/safety/SecretRedaction.ts","test":"tests/secret-redaction.test.mjs"},
  archives: {"file":"src/main/services/WorkspaceArchive.ts","test":"tests/backlog-persistence.test.mjs"},
  isolationPaths: {"file":"src/main/services/isolation/isolationPaths.ts","test":"tests/agent-isolation.test.mjs"},
  history: {"file":"src/main/services/TerminalOutputHistory.ts","test":"tests/terminal-full-history.test.mjs"},
  historyWorker: {"file":"src/main/services/TerminalOutputHistoryWorker.ts","test":"tests/terminal-full-history.test.mjs"},
  secretGrants: {"file":"src/main/services/SecretGrantService.ts","test":"tests/secret-grants.test.mjs"},
  networkPolicy: {"file":"src/main/services/isolation/networkPolicy.ts","test":"tests/network-isolation.test.mjs"}
};

const mutants = [
  defineMutation(mutationTargets.githubAuth, [
    "round5-github-denial-keeps-denied-state",
    'this.finishDeviceFlow(generation, "denied");',
    'this.finishDeviceFlow(generation, "expired");',
    "status distinguishes denial"
  ]),
  defineMutation(mutationTargets.githubAuth, [
    "round5-github-late-response-no-profile-request",
    "if (!this.isCurrentFlow(generation, signal)) return;\n      if (!isRecord(payload))",
    "if (!isRecord(payload))",
    "cancelling a device flow preserves"
  ]),
  defineMutation(mutationTargets.githubAuth, [
    "round5-github-cancel-preserves-account",
    "flow.controller.abort();",
    "flow.controller.abort();\n    this.tokens = null;",
    "cancelling a device flow preserves"
  ]),
  defineMutation(mutationTargets.githubAuth, ["round5-github-expired-flow-does-not-poll", "if (this.now() - started >= lifetimeMs) {", "if (false) {", "expires after elapsed time"]),
  defineMutation(mutationTargets.timelinePages, ["round4-large-pages-must-stream", "if(segmentSize>SEGMENT_BYTES) {", "if(false) {", "large imported timeline pages"]),
  defineMutation(mutationTargets.timelinePages, ["round4-page-ring-newest-first", "rows.reverse();", "// mutation: oldest first", "large imported timeline pages"]),
  defineMutation(mutationTargets.timelinePages, ["round4-page-valid-row-ordinals", "const index=validCount++;", "const index=0;validCount++;", "large imported timeline pages"]),
  defineMutation(mutationTargets.timelinePages, ["round4-page-filters-survive-streaming", "&& matches(event))ring.push", "&& true)ring.push", "large imported timeline pages"]),
  defineMutation(mutationTargets.timelinePages, [
    "round4-legacy-cursor-latest-duplicate",
    "if(event.id===cursor)latestCursorIndex=validIndex;",
    "if(event.id===cursor && latestCursorIndex===null)latestCursorIndex=validIndex;",
    "large imported timeline pages"
  ]),
  defineMutation(mutationTargets.timelinePages, [
    "round4-page-out-of-range-cursor",
    "if(cursorIndex!==undefined && cursorIndex>=window.validCount)throw",
    "if(false)throw",
    "large imported timeline pages"
  ]),
  defineMutation(mutationTargets.timelinePages, [
    "round4-grown-journal-discards-stale-search-index",
    "this.segmentIndexes.delete(name);",
    "// mutation: keep stale search index",
    "journal growth invalidates stale"
  ]),
  defineMutation(mutationTargets.timelinePages, [
    "round4-own-journal-needs-fresh-size",
    "const metadata=await stat(join(this.directory,name));",
    "const metadata=recordedSegmentIndex?.mtimeMs===0 && !cachedPageSegment ? {size:recordedSegmentIndex.size,mtimeMs:0} : await stat(join(this.directory,name));",
    "newly appended journal"
  ]),
  defineMutation(mutationTargets.checkpoints, ["round3-checkpoint-interrupted-pack-cleanup", "} finally {await this.removePackStaging(staging);}", "} finally {}", "an interrupted pack"]),
  defineMutation(mutationTargets.checkpoints, [
    "round3-checkpoint-dead-owner-staging-cleanup",
    "await this.pruneAbandonedPackStaging();",
    "// mutation: abandoned staging is retained",
    "startup removes interrupted staging"
  ]),
  defineMutation(mutationTargets.checkpoints, ["round3-checkpoint-unused-reverse-index-cleanup", ',rm(path.slice(0,-5)+".rev",{force:true})', "", "a failed registry replacement"]),
  defineMutation({file:"src/main/services/isolation/seatbelt.ts",test:"tests/diff-only-review-isolation.test.mjs"}, [
    "round2-reviewer-cannot-read-unsupplied-regular-files",
    '"(deny file-read* (vnode-type REGULAR-FILE))"',
    '"(allow file-read* (vnode-type REGULAR-FILE))"',
    "native macOS sandbox exposes review.diff"
  ]),
  defineMutation({file:"src/main/services/safety/commandFacts.ts",test:"tests/base-protection-app-private.test.mjs"}, [
    "round2-project-parent-cannot-reopen-private-store",
    "if (ctx.privatePaths.some(path => isPathInside(ctx.rootReal, path) && isPathInside(path, abs))) return true;",
    "if (false) return true;",
    "choosing a parent folder"
  ]),
  defineMutation({file:"src/main/services/safety/baseProtection.ts",test:"tests/base-protection-app-private.test.mjs"}, [
    "round2-new-private-stores-reach-command-guard",
    "'checkpoints.json', 'checkpoint-objects', 'flow-approvals.json',",
    "'checkpoints.json',",
    "own tokens"
  ]),
  defineMutation(mutationTargets.checkpoints, [
    "round2-checkpoint-ignores-replacement-objects",
    'const safe = ["--no-replace-objects", "-c", "core.hooksPath=/dev/null",',
    'const safe = ["-c", "core.hooksPath=/dev/null",',
    "replacement refs"
  ]),
  defineMutation(mutationTargets.checkpoints, [
    "round2-checkpoint-pack-survives-repository-gc",
    "if(!this.storagePath)return undefined;",
    "if(true)return undefined;",
    "protected checkpoint packs survive"
  ]),
  defineMutation(mutationTargets.budgets, ["round2-new-agent-is-provisional", "provisional=options.provisional===true;", "provisional=false;", "first usage replaces"]),
  defineMutation(mutationTargets.budgets, [
    "round2-cost-data-recovery-releases-pause",
    "record.paused=false;delete record.pauseCause;pauseStateChanged=true;",
    "record.paused=true;pauseStateChanged=true;",
    "provisional launch"
  ]),
  defineMutation({file:"src/main/services/TimelineIndexScan.ts",test:"tests/orchestration-backlog-core.test.mjs"}, [
    "round2-counter-reset-keeps-earlier-epoch",
    "const tokens=previous===undefined || reset ? current.total! : current.total!-previous.total!;",
    "const tokens=previous===undefined ? current.total! : Math.max(0,current.total!-previous.total!);",
    "many task budgets share timeline passes and retain legacy, resumed, and repriced usage after reload"
  ]),
  defineMutation(mutationTargets.redaction, [
    "round2-source-ranges-preserve-longer-known-value",
    "return redactKnownAndCredentials(text, forms);",
    "return redactKnownAndCredentials(redactCredentials(text), forms);",
    "held structural words"
  ]),
  defineMutation(mutationTargets.redaction, [
    "round2-registered-label-keeps-json-secret-rule",
    "streams.push(jsonSecretRanges(text));",
    "if (!forms.bare.length && !forms.exact.length) streams.push(jsonSecretRanges(text));",
    "held structural words"
  ]),
  defineMutation({file:"src/main/services/OrchestrationTemplateService.ts",test:"tests/orchestration-flow-approval.test.mjs"}, [
    "round2-flow-requires-host-approval",
    "if (!this.approvedTemplates.has(template)) throw new Error",
    "if (false) throw new Error",
    "approval"
  ]),
  defineMutation({file:"src/main/services/WorkspaceArchive.ts",test:"tests/workspace-presets-validation.test.mjs"}, [
    "round2-malformed-preset-keeps-neighbors",
    "// A damaged record is skipped on read so it cannot hide its valid neighbors.",
    "return [];",
    "one invalid saved workspace preset is isolated"
  ]),
  defineMutation({file:"src/main/services/isolation/seatbelt.ts",test:"tests/mac-dns-isolation.test.mjs"}, [
    "round2-macos-denies-dns-mach-service",
    "lines.push(\"(deny mach-lookup)\");",
    "// mutation: strict mode allows Mach-service lookups.",
    "strict macOS network modes deny Mach-service lookups"
  ]),
  defineMutation(mutationTargets.redaction, [
    "streamed-known-secrets-enforce-wrap-gap",
    "if (oversizedAfter[endSlot]! - oversizedAfter[startSlot]! > 0) return null;",
    "if (false) return null;",
    "invalid longer wrapped candidate|held values of 4k, 16k and 64k"
  ]),
  defineMutation(mutationTargets.redaction, [
    "streamed-known-secrets-keep-longest-match",
    "end = Math.max(end, next.value.end);",
    "end = Math.min(end, next.value.end);",
    "overlapping registered secrets"
  ]),
  defineMutation({file:"src/main/services/SessionTimelineService.ts",test:"tests/backlog-persistence.test.mjs"}, [
    "review-budget-source-counter-identity",
    "return {id:key,legacyId:value.counterId ?? sessionId,tokens:totalTokens(value),costUsd:pricedCost(value,prices),",
    "return {id:value.counterId ?? sessionId,legacyId:value.counterId ?? sessionId,tokens:totalTokens(value),costUsd:pricedCost(value,prices),",
    "source identity"
  ]),
  defineMutation({file:"src/main/services/agent-browser/OrchestrationTools.ts",test:"tests/orchestration-backlog-core.test.mjs"}, [
    "review-effort-keeps-router-enabled",
    "humanChoice: null,",
    "humanChoice: {provider, ...(requestedEffort ? {reasoningEffort:requestedEffort} : {})},",
    "routing"
  ]),
  defineMutation({file:"src/main/services/isolation/worktreeGitAccess.ts",test:"tests/agent-isolation.test.mjs"}, [
    "review-worktree-subfolder-root",
    "const workingTree = nearestGitLayout(launchCwd)?.worktree;",
    "const workingTree = gitLayout(launchCwd)?.worktree;",
    "linked worktree Git metadata"
  ]),
  defineMutation({file:"src/main/services/SecretCommandExecutor.ts",test:"tests/secret-command-executor.test.mjs"}, [
    "review-secret-must-stay-out-of-env",
    'environment.ELECTRON_RUN_AS_NODE = "1";',
    'environment.ELECTRON_RUN_AS_NODE = "1"; environment.REVIEW_SECRET = request.secret;',
    "slow API worker"
  ]),
  defineMutation({file:"src/main/services/OrchestrationTaskBoard.ts",test:"tests/orchestration-backlog-core.test.mjs"}, [
    "review-closed-task-human-authority",
    'if (!person && (task.status === "closed" || task.status === "done")) {',
    'if (false && !person && (task.status === "closed" || task.status === "done")) {',
    "task board serializes competing claims"
  ]),
  defineMutation({file:"src/main/services/AgentControlService.ts",test:"tests/orchestration-backlog-core.test.mjs"}, [
    "review-parallel-retry-reservation",
    "this.retryCounts.set(sourceId, count + 1);",
    "this.retryCounts.set(sourceId, count);",
    "parallel retry requests"
  ]),
  defineMutation(mutationTargets.budgets, ["review-unknown-cost-pauses", "const over = overLimit || unknownCostLimit;", "const over = overLimit;", "cost budgets retain"]),
  defineMutation(mutationTargets.budgets, [
    "review-cost-repricing-can-decrease",
    "      costUsd,...(provisional ? {provisional:true} : {})};",
    "      costUsd: costUsd===null ? null : Math.max(previous?.costUsd ?? 0,costUsd),...(provisional ? {provisional:true} : {})};",
    "cost budgets retain"
  ]),
  defineMutation(mutationTargets.budgets, [
    "review-pending-usage-replaced",
    "if(id!==sessionId && Object.hasOwn(sessions,id)){delete sessions[id];removedPending=true;}",
    "if(false && id!==sessionId && Object.hasOwn(sessions,id)){delete sessions[id];removedPending=true;}",
    "first usage replaces"
  ]),
  defineMutation(mutationTargets.archives, ["review-preset-new-conversation", "this.parse(text).map(({threadId:_threadId,...record})=>record)", "this.parse(text)", "workspace export"]),
  defineMutation({file:"src/main/services/GitCheckpoints.ts",test:"tests/backlog-persistence.test.mjs"}, [
    "review-checkpoint-immutable-object",
    "return row.oid;",
    "return id;",
    "git checkpoints leave staged and unstaged edits intact, preview and restore both"
  ]),
  defineMutation({file:"src/main/services/LaunchPipeline.ts",test:"tests/launch-contributors.test.mjs"}, [
    "review-only-accounts-can-attribute",
    "contributor.pluginId!==ACCOUNTS_PLUGIN_ID",
    "false",
    "trusted Accounts contributor"
  ]),
  defineMutation({file:"src/main/services/AccountLimitsService.ts",test:"tests/account-limits-service.test.mjs"}, [
    "review-account-clients-stay-bounded",
    'this.maxClients = boundedClientCount(options.maxClients);',
    'this.maxClients = 32;',
    "isolated and bounded"
  ]),
  defineMutation({file:"src/main/services/accountHomeIsolation.ts",test:"tests/account-home-isolation.test.mjs"}, [
    "accounts-home-matches-selected-account",
    "basename(selected) !== `${prefix}${selectedAccountId}`",
    "!basename(selected).startsWith(prefix)",
    "Accounts home grant refuses"
  ]),
  defineMutation({file:"src/main/services/LaunchPipeline.ts",test:"tests/account-home-isolation.test.mjs"}, [
    "accounts-selected-home-reaches-isolation",
    "...(accountHome ? { accountHome } : {})",
    "...{}",
    "host-authorized account home grant"
  ]),
  defineMutation({file:"src/main/services/isolation/AgentIsolation.ts",test:"tests/account-home-isolation.test.mjs"}, [
    "accounts-home-revalidated-before-sandbox",
    "validateSelectedAccountHome(this.options.userDataPath, launch.provider, launch.accountHome)",
    "launch.accountHome",
    "AgentIsolation.wrap refuses a symlinked Accounts home"
  ]),
  defineMutation(mutationTargets.isolationPaths, ["plan-refuses-overlapping-provider-state", "if (input.readOnlyProject) {", "if (false && input.readOnlyProject) {", "Plan refuses provider state"]),
  defineMutation(mutationTargets.history, [
    "history-recovery-retains-older-supported-sessions",
    "for (const sessionId of [...sessionIds].reverse()) {",
    "for (const sessionId of sessionIds.slice(-256).reverse()) {",
    "more than 256 live sessions"
  ]),
  defineMutation(mutationTargets.isolationPaths, [
    "worktree-plugin-parent-is-private",
    '"github-oauth.json", "launch-runs", "plugin-data",',
    '"github-oauth.json", "launch-runs",',
    "linked worktree Git"
  ]),
  defineMutation({file:"src/main/services/isolation/worktreeGitAccess.ts",test:"tests/agent-isolation.test.mjs"}, [
    "worktree-checks-primary-branch-owner",
    "anotherWorktreeOwns([...otherAdminDirs, taskLayout.gitDir, commonDir], branch)",
    "anotherWorktreeOwns(otherAdminDirs, branch)",
    "host validation checks the common primary HEAD when the task root is itself a linked worktree"
  ]),
  defineMutation(mutationTargets.isolationPaths, ["worktree-shared-objects-stay-read-only", "[worktree.adminDir, worktree.commonDir]", "[worktree.adminDir]", "seatbelt, for real: a plugin worktree"]),
  defineMutation({file:"src/main/services/GitCheckpoints.ts",test:"tests/review-fix-boundaries.test.mjs"}, [
    "review-untracked-growth-read-bound",
    "const raw = await readBoundedUntrackedFile(file);",
    "const raw = await file.readFile();",
    "untracked checkpoint reads stay capped"
  ]),
  defineMutation({file:"src/main/services/SessionTimelineService.ts",test:"tests/review-fix-boundaries.test.mjs"}, [
    "timeline-rejects-out-of-range-cursor",
    "Number(position[2]) >= events.length",
    "false",
    "timeline rejects a positional cursor beyond"
  ]),
  defineMutation(mutationTargets.historyWorker, [
    "history-match-cap-retains-gap-metadata",
    "const prunedSessionIds = [...histories].filter(([id, history]) => (!allowed || allowed.has(id)) && history.pruned).map(([id]) => id);",
    "const prunedSessionIds = [];",
    "match limit still reports"
  ]),
  defineMutation({file:"src/main/services/SecretCommandExecutor.ts",test:"tests/secret-command-executor.test.mjs"}, [
    "secret-worker-utf8-chunk-boundary",
    "output += decoder.write(chunk);",
    'output += chunk.toString("utf8");',
    "executor preserves UTF-8"
  ]),
  defineMutation(mutationTargets.historyWorker, ["history-unicode-source-offsets", "offset: lineStart", "offset: sliceView(view, 0, lineStart).toLocaleLowerCase().length", "Unicode case expansion"]),
  defineMutation(mutationTargets.history, ["history-recovery-aggregate-bound", "let remaining = maxChars;", "let remaining = Number.MAX_SAFE_INTEGER;", "recovery reads only tails"]),
  defineMutation(mutationTargets.secretGrants, [
    "secret-profile-must-use-approved-key",
    'if (profile.secretRef !== secretId) throw new Error("The selected API profile uses a different provider secret.");',
    "void secretId;",
    "invalid API requests"
  ]),
  defineMutation(mutationTargets.secretGrants, [
    "legacy-secret-executables-fail-closed",
    'throw new Error("Arbitrary secret-bearing commands are disabled. Use a typed provider API request.");',
    "return undefined;",
    "legacy arbitrary secret commands fail closed"
  ]),
  defineMutation({file:"src/main/services/SessionTimelineService.ts",test:"tests/backlog-persistence.test.mjs"}, [
    "timeline-cursor-exclusive-position",
    "Number(position[2]) - 1",
    "Number(position[2])",
    "timeline cursors preserve"
  ]),
  defineMutation(mutationTargets.history, [
    "history-crash-reseeds-pty-tail",
    "this.worker = null;\n    this.needsRecovery = true;\n    this.generation++;",
    "this.worker = null;\n    this.needsRecovery = false;\n    this.generation++;",
    "crashed output worker"
  ]),
  defineMutation({file:"src/main/services/shutdownSteps.ts",test:"tests/shutdown-steps.test.mjs"}, [
    "shutdown-continues-after-failed-flush",
    'catch (error) { warn(`CanvasTTY shutdown: ${step.name} failed.`, error); }',
    "catch (error) { throw error; }",
    "report and timeline flush failures do not skip budget flush"
  ]),
  defineMutation({file:"src/main/services/GitCheckpoints.ts",test:"tests/git-review-diff.test.mjs"}, [
    "review-includes-untracked-source",
    "parts.push(hunk); bytes += Buffer.byteLength(hunk);",
    "bytes += Buffer.byteLength(hunk);",
    "review diffs include masked untracked source"
  ]),
  defineMutation({file:"src/main/services/PluginChangeReviews.ts",test:"tests/plugin-change-review.test.mjs"}, [
    "review-action-large-valid-selection",
    "const MAX_ACTION_BYTES = 256 * 1024;",
    "const MAX_ACTION_BYTES = 16 * 1024;",
    "human card action input"
  ]),
  defineMutation(mutationTargets.networkPolicy, [
    "proxy-invalid-http-host-denial",
    'catch { return sendResponse(response, 403, "Destination is not allowed"); }',
    'catch { throw new Error("Invalid destination"); }',
    "allowlist"
  ]),
  defineMutation({file:"scripts/mutation-backlog.mjs",test:"tests/mutation-source-selection.test.mjs"}, [
    "mutation-default-dirty-source-guard",
    '\n  if (clean.status !== 0 || untracked.trim()) throw new Error("Source files differ from HEAD. Pass --source-ref with an immutable Git object id to test the intended source tree.");\n',
    "\n  void clean;\n"
  ]),
  defineMutation({file:"src/main/ipc/registerBacklogIpc.ts",test:"tests/backlog-broadcast.test.mjs"}, [
    "task-board-renderer-invalidation",
    "window.webContents.send(BACKLOG_EVENTS.taskBoardChanged,{rootSessionId:change.rootSessionId,revision:change.revision});",
    "void change;",
    "task mutations publish"
  ]),
  defineMutation({file:"src/main/services/PluginManager.ts",test:"tests/plugin-tools-events-cards.test.mjs"}, [
    "plugin-card-actions-bounded-cap",
    "value.length > MAX_CARD_ACTIONS",
    "false",
    "manifests: tools need"
  ]),
  defineMutation(mutationTargets.budgets, ["budget-token-limit-equality", "usage>=limit*threshold", "usage>limit*threshold", "account continuation preserves task budgets and children"]),
  defineMutation(mutationTargets.budgets, ["budget-session-usage-monotonicity", "Math.max(previous?.tokens ?? 0,tokens)", "tokens", "task usage ledger retains closed agents"]),
  defineMutation({file:"src/main/services/OrchestrationBudgetService.ts",test:"tests/backlog-mutation-regressions.test.mjs"}, [
    "budget-token-warning-at-80-percent",
    "reached(limits.tokens,usage.tokens,0.8)",
    "reached(limits.tokens,usage.tokens,0.95)",
    "an 80% token budget warns once"
  ]),
  defineMutation(mutationTargets.secretGrants, [
    "secret-request-expiry-inclusive-boundary",
    "if (request.expiresAt <= now)",
    "if (request.expiresAt < now)",
    "request expiry, denial, invalid API requests, and missing isolation"
  ]),
  defineMutation(mutationTargets.secretGrants, [
    "secret-grant-expiry-inclusive-boundary",
    'if (grant.expiresAt !== null && grant.expiresAt <= now) this.removeGrant(grant, "expired");',
    'if (grant.expiresAt !== null && grant.expiresAt < now) this.removeGrant(grant, "expired");',
    "grant expiry is checked for every run"
  ]),
  defineMutation({file:"src/main/services/SecretGrantService.ts",test:"tests/backlog-mutation-regressions.test.mjs"}, [
    "secret-grant-recheck-after-secret-read",
    "if (this.grants.get(grantKey(sessionId, request.secretId)) !== grant || (grant.expiresAt !== null && grant.expiresAt <= this.now())) {",
    "if (grant.expiresAt !== null && grant.expiresAt <= this.now()) {",
    "revoking a grant while its secret lookup is pending"
  ]),
  defineMutation({file:"src/main/services/SecretGrantService.ts",test:"tests/backlog-mutation-regressions.test.mjs"}, [
    "secret-expiry-aborts-active-command",
    '    for (const run of this.activeRuns) {\n      if (run.sessionId === grant.sessionId && run.secretIds.has(grant.secretId)) run.controller.abort();\n    }\n    this.emit(() => this.options.onRevoke?.({ sessionId: grant.sessionId, secretId: grant.secretId, reason }));',
    '    this.emit(() => this.options.onRevoke?.({ sessionId: grant.sessionId, secretId: grant.secretId, reason }));',
    "expiry discovered while a secret API request is active"
  ]),
  defineMutation(mutationTargets.networkPolicy, ["network-proxy-token-authentication", "if (timingSafeEqual(presentedDigest, grant.tokenDigest)) matched = grant;", "matched = grant;", "allowlist"]),
  defineMutation(mutationTargets.networkPolicy, ["network-exact-domain-allowlist", "!domainAllowed(target.hostname, grant.domains)", "false", "allowlist"]),
  defineMutation(mutationTargets.networkPolicy, [
    "network-public-dns-pinning",
    'if (!address) return refuseSocket(client, 403, "Destination DNS is not public");',
    'if (false && !address) return refuseSocket(client, 403, "Destination DNS is not public");',
    "allowlist"
  ]),
  defineMutation({file:"src/main/services/isolation/AgentIsolation.ts",test:"tests/network-isolation.test.mjs"}, [
    "network-offline-is-still-strict",
    'const strictNetwork = networkMode !== "open";',
    'const strictNetwork = networkMode === "allowed-domains";',
    "strict network policy follows the project root"
  ]),
  defineMutation({file:"src/main/services/agent-runtime/ClaudeHttpHooks.ts",test:"tests/terminal-network-policy.test.mjs"}, [
    "claude-linux-strict-network-uses-socket-hooks",
    `    if (this.platform === "linux" && facts.networkMode !== undefined && facts.networkMode !== "open") {\n      return { ok: false, reason: "Linux strict network isolation cannot reach the loopback HTTP hook listener" };\n    }\n`,
    "",
    "Claude strict-network launches"
  ]),
  defineMutation({file:"src/main/services/OrchestrationTaskBoard.ts",test:"tests/backlog-core-integration.test.mjs"}, [
    "task-claim-dependency-gate",
    "      const waiting = task.dependencies.map((id) => findTask(state, rootSessionId, id)).filter((dependency) => dependency.status !== \"done\");\n      if (waiting.length > 0) throw new Error(`Task ${task.id} is waiting for dependencies: ${waiting.map((item) => item.title).join(\", \")}.`);\n      task.ownerSessionId = actorSessionId;",
    "      const waiting = task.dependencies.map((id) => findTask(state, rootSessionId, id)).filter(() => false);\n      if (waiting.length > 0) throw new Error(`Task ${task.id} is waiting for dependencies: ${waiting.map((item) => item.title).join(\", \")}.`);\n      task.ownerSessionId = actorSessionId;",
    "authenticated orchestration gateway carries"
  ]),
  defineMutation({file:"src/main/services/agent-browser/OrchestrationTools.ts",test:"tests/orchestration-backlog-core.test.mjs"}, [
    "read-only-reviewer-execution-guard",
    "if (this.control.isReadOnlyReviewer(sessionId)) {",
    "if (false) {",
    "task board tools are visible"
  ]),
  defineMutation(mutationTargets.archives, [
    "workspace-bypass-confirmation",
    "if (records.some((record) => record.profile === \"yolo\") && confirmBypass !== true) throw new Error(\"Confirm Bypass profiles before opening this workspace.\");",
    "if (records.some((record) => record.profile === \"yolo\") && false) throw new Error(\"Confirm Bypass profiles before opening this workspace.\");",
    "workspace export excludes credentials"
  ]),
  defineMutation(mutationTargets.archives, [
    "workspace-parent-id-remap",
    "...(record.parentSessionId ? {parentSessionId:idMap.get(record.parentSessionId)!} : {}),",
    "...(record.parentSessionId ? {parentSessionId:record.parentSessionId} : {}),",
    "workspace export excludes credentials"
  ]),
  defineMutation({file:"src/main/services/AgentControlService.ts",test:"tests/agent-delegation-invariants.test.mjs"}, [
    "spawn-budget-recheck-after-environment",
    "    this.requireSession(parent.id);\n    this.requireBudgetActive(parent.id);\n    const { childrenCount } = this.assertSpawnCapacity(parent.id);",
    "    this.requireSession(parent.id);\n    const { childrenCount } = this.assertSpawnCapacity(parent.id);",
    "budget reached while an environment resolves"
  ]),
  defineMutation({file:"src/main/services/AgentControlService.ts",test:"tests/agent-delegation-invariants.test.mjs"}, [
    "spawn-capacity-recheck-after-environment",
    "    const { childrenCount } = this.assertSpawnCapacity(parent.id);",
    "    const childrenCount = 0;",
    "concurrent environment resolutions"
  ]),
  defineMutation({file:"src/main/services/safety/SecretRedaction.ts",test:"tests/search-worker-redaction.test.mjs"}, [
    "worker-mirror-all-secret-owners",
    "values.slice(i,i+MAX_VALUES_PER_OWNER)",
    "values.slice(0,MAX_VALUES_PER_OWNER)",
    "trusted worker mirror retains all owners"
  ]),
  defineMutation({file:"src/main/services/SessionReports.ts",test:"tests/session-reports.test.mjs"}, [
    "report-cancellation-generation",
    "    this.generations.set(id,(this.generations.get(id) ?? 0)+1);this.pending.delete(id);",
    "    this.pending.delete(id);",
    "later turn/removal"
  ]),
  defineMutation({file:"src/main/services/isolation/networkPolicy.ts",test:"tests/configured-api-domains.test.mjs"}, [
    "network-configured-api-actual-grant",
    "const domains=this.getEffectivePolicy(projectPath,provider).domains;",
    "const domains=[];",
    "global model gateways extend actual sandbox grants"
  ]),
  defineMutation({file:"src/main/services/AgentControlService.ts",test:"tests/reviewer-model-usage.test.mjs"}, [
    "review-default-worker-model-resolution",
    "workerModel=await this.options.workerModel?.(worker) ?? undefined;",
    "workerModel=undefined;",
    "default-model worker"
  ]),
  defineMutation({file:"src/main/services/AgentControlService.ts",test:"tests/reviewer-model-usage.test.mjs"}, [
    "review-observed-cost-attribution",
    "return typeof cost===\"number\" && Number.isFinite(cost) && cost>=0 ? {...review,costUsd:cost} : review;",
    "return review;",
    "default-model worker"
  ]),
  defineMutation({file:"src/main/services/PluginChangeReviews.ts",test:"tests/plugin-change-review.test.mjs"}, [
    "plugin-review-own-action-boundary",
    "typeof value !== \"string\" || !actions.has(value)",
    "typeof value !== \"string\"",
    "review cannot name another plugin's actions"
  ]),
  defineMutation(mutationTargets.historyWorker, ["full-history-retention-beyond-old-ring", "const MAX_GLOBAL_CHARS = 16_000_000;", "const MAX_GLOBAL_CHARS = 240_000;", "ten full terminal histories"]),
  defineMutation(mutationTargets.historyWorker, [
    "history-new-secrets-mask-cached-output",
    "            redactor = redactionRegistryFromWorkerSnapshot(message.values);",
    "            // Mutant: ignore newly registered secret values.",
    "newly registered secret"
  ]),
  defineMutation({file:"src/main/services/SessionReports.ts",test:"tests/session-reports.test.mjs"}, [
    "saved-report-refreshes-late-audit-events",
    "    if(this.ready.has(id) && generation!==undefined){",
    "    if(false && this.ready.has(id) && generation!==undefined){",
    "completion automatically saves a masked timeline report"
  ]),
];

function commandFor(files, pattern) {
  return [
    node,
    ...commonArgs,
    ...(pattern ? [`--test-name-pattern=${pattern}`] : []),
    ...files
  ];
}

function run(files, pattern, timeout = 20_000) {
  const args = commandFor(files, pattern);
  const result = spawnSync(node, args.slice(1), {
    cwd: copyRoot,
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    command: ["node", ...args.slice(1)].join(" "),
    exitCode: result.status,
    timedOut: result.error?.code === "ETIMEDOUT",
    error: result.error?.message ?? null,
    output
  };
}

function count(output, label) {
  return Number(new RegExp(`ℹ ${label} (\\d+)`).exec(output)?.[1] ?? 0);
}

function failureDetail(output) {
  const assertionIndex = output.indexOf("AssertionError");
  if (assertionIndex < 0) return "";
  return output.slice(assertionIndex, output.indexOf("\n", assertionIndex));
}

function classify(result) {
  if (result.timedOut) return "timedout";
  if (result.exitCode === 0) return count(result.output,"pass")>0 ? "survived" : "invalid";
  if (result.output.includes("AssertionError") && /^✖ .+$/mu.test(result.output)) return "killed";
  return "invalid";
}

function extractFiles() {
  mkdirSync(copyRoot, { recursive: true });
  const paths = execFileSync("git", ["ls-tree", "-rz", "--name-only", sourceTree, "--", ...sourcePaths],
    { cwd: repoRoot, encoding: "utf8" }).split("\0").filter(Boolean);
  if (!paths.length) throw new Error("The immutable source snapshot has no allowed source paths.");
  const archive = spawnSync("git", ["archive", sourceTree, "--", ...paths], {
    cwd: repoRoot,
    maxBuffer: 256 * 1024 * 1024
  });
  if (archive.status !== 0 || !archive.stdout) throw new Error("Could not create the immutable source snapshot with git archive.");
  const unpacked = spawnSync("tar", ["-x", "-f", "-", "-C", copyRoot], {
    input: archive.stdout,
    maxBuffer: 8 * 1024 * 1024
  });
  if (unpacked.status !== 0) throw new Error(`Could not unpack the source snapshot: ${unpacked.stderr?.toString() ?? "tar failed"}`);

  const dependencies = join(repoRoot, "node_modules");
  if (existsSync(dependencies)) {
    symlinkSync(dependencies, join(copyRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
}

function renderReport(report) {
  const lines = [
    "# Targeted backlog mutation report",
    "",
    `Source revision: \`${report.commit}\`; runtime: Node ${report.node}.`,
    "The harness used source and tests from one immutable Git tree archive and symlinked local `node_modules`. It applied one mutation at a time and restored each copied source file in a `finally` block. No production source in the shared checkout was changed.",
    "",
    "## Baseline",
    "",
    `\`${report.baseline.command}\` — exit ${report.baseline.exitCode}, ${report.baseline.passed} passed, ${report.baseline.failed} failed.`,
    "",
    "## Mutants",
    "",
    "| Mutant | Focused test | Result |",
    "|---|---|---|",
    ...report.mutations.map((item) => `| \`${item.id}\` | \`${item.test}${item.pattern ? ` (${item.pattern})` : ""}\` | ${item.status} |`),
    "",
    `Totals: ${report.totals.killed} killed by assertions, ${report.totals.survived} survived, ${report.totals.invalid} invalid/setup failures, ${report.totals.timedout} timed out.`,
    "",
    "A direct edit changing both post-read expiry comparisons from `<=` to `<` was excluded as equivalent: `pruneExpired()` removes the grant at that same boundary first. The valid boundary mutant changes the pruning comparison and is included above.",
    "Removing eager history-cache clearing alone is also equivalent: `getMasked()` checks the secret revision before using a cache. The valid history mutant instead removes propagation of new secret values. An exit-zero run matching no tests is classified as an invalid setup, never a surviving or killed mutant.",
    ""
  ];
  return lines.join("\n");
}

let report;
try {
  extractFiles();
  const baselineFiles = new Set(mutants.map(mutant => mutant.test));
  const baseline = run([...baselineFiles], null, 60_000);
  if (baseline.exitCode !== 0) throw new Error(`Mutation baseline failed.\n${baseline.output}`);
  if (baselineOnly) process.stdout.write(baseline.output);

  const mutations = [];
  for (const mutant of baselineOnly ? [] : mutants) {
    const path = join(copyRoot, mutant.file);
    const pristine = readFileSync(path, "utf8");
    const matches = pristine.split(mutant.before).length - 1;
    if (matches !== 1) {
      mutations.push({ ...mutant, status: "invalid", failure: "mutation source did not match exactly once", error: `matches=${matches}` });
      continue;
    }
    writeFileSync(path, pristine.replace(mutant.before, mutant.after));
    try {
      const result = run([mutant.test], mutant.pattern ?? null, 20_000);
      mutations.push({
        ...mutant,
        status: classify(result),
        exitCode: result.exitCode,
        failure: failureDetail(result.output) || (classify(result) === "invalid" ? result.output.trim().slice(-700) : ""),
        error: result.error
      });
    } finally {
      writeFileSync(path, pristine);
    }
  }

  report = {
    commit: sourceTree,
    node: execFileSync(node, ["--version"], { encoding: "utf8" }).trim(),
    baseline: {
      command: baseline.command,
      exitCode: baseline.exitCode,
      passed: count(baseline.output, "pass"),
      failed: count(baseline.output, "fail")
    },
    mutations,
    totals: Object.fromEntries(["killed", "survived", "invalid", "timedout"].map((status) => [status, mutations.filter((item) => item.status === status).length]))
  };
  if (!baselineOnly) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, renderReport(report));
  }
  console.log(JSON.stringify({ mode: baselineOnly ? "baseline-only" : "mutations", baseline: report.baseline, totals: report.totals, mutations: mutations.map(({ id, status, failure, error }) => ({ id, status, failure, error })) }, null, 2));
  if (report.totals.survived || report.totals.invalid || report.totals.timedout) process.exitCode = 1;
} finally {
  rmSync(copyRoot, { recursive: true, force: true });
}
