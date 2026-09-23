import type { AgentProviderId } from '../../shared/contracts.ts';
import type { CapsuleReview } from '../../shared/capsules.ts';
import type { TerminalManager } from './TerminalManager.ts';
import type { AgentControlService } from './AgentControlService.ts';
import type { CapsuleLaunchService } from './CapsuleLaunchService.ts';
import type { CapsuleTestService } from './CapsuleTestService.ts';
import { validateOrchestrationArguments } from '../../agent-browser/orchestration-catalog.mjs';

const PAGE_CHARS = 8192;

/** Authenticated host parents can act only on output captured under their current delegation. */
export class ScopedCapsuleControl {
  private readonly terminals: TerminalManager;
  private readonly control: AgentControlService;
  private readonly capsules: CapsuleLaunchService;
  private readonly tests?: CapsuleTestService;
  constructor(terminals: TerminalManager, control: AgentControlService, capsules: CapsuleLaunchService, tests?: CapsuleTestService) {
    this.terminals = terminals; this.control = control; this.capsules = capsules;
    this.tests = tests;
    capsules.configureParentAuthority(id => terminals.capsuleAuthority(id));
  }

  async execute(parent: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const validation = validateOrchestrationArguments(tool, args);
    if (!validation.ok) throw new Error(validation.error);
    args = validation.value;
    if (tool === 'list_capsule_test_profiles') { this.terminals.capsuleAuthority(parent); return { profiles: this.requireTests().profiles() }; }
    if (tool === 'get_capsule_test_result' || tool === 'cancel_capsule_test') return this.testResult(parent, tool, args, signal);
    if (tool === 'spawn_capsule_agent') return this.spawn(parent, args, signal);
    if (tool === 'list_capsules') {
      const result = await this.list(parent, args.offset as number | undefined); signal?.throwIfAborted(); return result;
    }
    const id = args.capsuleId as string;
    const assertCurrent = (): void => { signal?.throwIfAborted(); this.capsules.assertParent(id, parent); };
    assertCurrent();
    if (tool === 'test_capsule') {
      const { output: _output, ...result } = await this.requireTests().start(id, args.reviewId as string, args.testProfileId as string, assertCurrent);
      return { runId: result.id, capsuleId: id, state: result.state, reviewDigest: result.reviewDigest };
    }
    if (tool === 'list_capsule_tests') {
      const items = await this.requireTests().list(id); assertCurrent();
      const offset = (args.offset as number | undefined) ?? 0;
      return { tests: items.slice(offset, offset + 16).map(item => ({ runId: item.id, state: item.state, reviewId: item.reviewId, reviewDigest: item.reviewDigest, testProfileId: item.testProfileId, createdAt: item.createdAt, stopped: item.stopped })), nextOffset: offset + 16 < items.length ? offset + 16 : null };
    }
    if (tool === 'review_capsule') {
      const review = await this.capsules.review(id); assertCurrent();
      return this.page(review, 0);
    }
    if (tool === 'read_capsule_patch') {
      const review = await this.capsules.exportReview(id, args.reviewId as string); assertCurrent();
      return this.page(review, args.offset as number);
    }
    if (tool === 'apply_capsule') return { ...await this.capsules.apply(id, args.reviewId as string, assertCurrent) };
    if (tool === 'recover_capsule_apply') {
      await this.capsules.recoverApply(id, args.reviewId as string, assertCurrent);
      assertCurrent(); return { capsuleId: id, recovered: true };
    }
    throw new Error('Unsupported capsule operation.');
  }

  private requireTests(): CapsuleTestService { if (!this.tests) throw new Error('Saved test execution is unavailable.'); return this.tests; }
  private async testResult(parent: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const tests = this.requireTests();
    let result: Awaited<ReturnType<CapsuleTestService['get']>>;
    try { result = await tests.get(args.runId as string); this.capsules.assertParent(result.capsuleId, parent); }
    catch { throw new Error('Test operation is not authorized for this session.'); }
    signal?.throwIfAborted();
    if (tool === 'cancel_capsule_test') { await tests.cancel(result.id); return { runId: result.id, cancelRequested: true }; }
    const offset = (args.offset as number | undefined) ?? 0;
    if (offset > result.output.length) throw new Error('Output offset is beyond this test result.');
    const end = Math.min(offset + PAGE_CHARS, result.output.length);
    return { runId: result.id, capsuleId: result.capsuleId, reviewDigest: result.reviewDigest, testProfileId: result.testProfileId, profileDigest: result.profileDigest, imageId: result.imageId,
      state: result.state, stopped: result.stopped, exitCode: result.exitCode, truncated: result.truncated, reason: result.reason,
      output: result.output.slice(offset, end), offset, nextOffset: end < result.output.length ? end : null, totalChars: result.output.length };
  }

  private async spawn(parent: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const capsule = await this.capsules.prepareForParent(parent, args.files as string[], args.task as string);
    signal?.throwIfAborted();
    this.capsules.assertParent(capsule.id, parent);
    const child = await this.control.spawnCapsule({
      parentSessionId: parent, provider: args.provider as AgentProviderId, cwd: capsule.sourceDirectory,
      isolation: { mode: 'container', profileId: args.containerProfileId as string, capsuleId: capsule.id },
      allowSubagents: false,
      ...(args.accountId !== undefined ? { accountId: args.accountId as string } : {}),
      ...(args.model !== undefined ? { model: args.model as string } : {}),
      ...(args.title !== undefined ? { title: args.title as string } : {})
    });
    return { capsuleId: capsule.id, sessionId: child.id, provider: child.provider, dataClass: child.dataClass, status: child.status };
  }

  private async list(parent: string, offset = 0): Promise<Record<string, unknown>> {
    const authority = this.terminals.capsuleAuthority(parent);
    const items = (await this.capsules.storage.list()).filter(item => {
      if (item.owner?.parentSessionId !== parent || item.owner.generation !== authority.generation) return false;
      try { this.capsules.assertParent(item.id, parent); return true; } catch { return false; }
    });
    if (this.terminals.capsuleAuthority(parent).generation !== authority.generation) throw new Error('Capsule operation is not authorized for this session.');
    return { capsules: items.slice(offset, offset + 16).map(item => ({ capsuleId: item.id, state: item.state, dataClass: item.dataClass, fileCount: item.files.length, createdAt: item.createdAt, ...(item.recoveryReviewId ? { recoveryReviewId: item.recoveryReviewId } : {}) })),
      nextOffset: offset + 16 < items.length ? offset + 16 : null };
  }

  private page(review: CapsuleReview, offset: number): Record<string, unknown> {
    if (offset > review.patch.length) throw new Error('Patch offset is beyond this reviewed snapshot.');
    const end = Math.min(offset + PAGE_CHARS, review.patch.length);
    return { capsuleId: review.workspaceId, reviewId: review.reviewId, digest: review.digest, createdAt: review.createdAt,
      changedFiles: review.changedFiles.slice(0, 16), changedFilesCount: review.changedFiles.length,
      changedFilesComplete: review.changedFiles.length <= 16, patch: review.patch.slice(offset, end), offset,
      nextOffset: end < review.patch.length ? end : null, totalChars: review.patch.length };
  }
}
