import { randomUUID } from 'node:crypto';
import type { AppSettings, CreateSessionRequest, SessionSnapshot } from '../../shared/contracts.ts';
import { accountSupportsRuntime } from '../../shared/providerAccountPolicy.ts';
import { accountSupportsModel } from '../../shared/contracts.ts';
import type { AdvisoryReviewChoices, AdvisoryReviewRoute, AdvisoryReviewPreview, AdvisoryReviewRequest } from '../../shared/capsules.ts';
import type { CapsuleLaunchService } from './CapsuleLaunchService.ts';
import type { TerminalManager, OwnedContextLaunch } from './TerminalManager.ts';
import type { AgentControlService } from './AgentControlService.ts';
import type { ContainerExecutionService } from './ContainerExecutionService.ts';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
interface Prepared {
  input: AdvisoryReviewRequest; request: CreateSessionRequest; context: OwnedContextLaunch; assertCurrent(): void;
  controller: AbortController; expires: number; launched: boolean;
}
/** Explicit, ordinary budgeted child launch. No renderer patch, inferred owner or background model call. */
export class PreferenceReviewService {
  private readonly pending = new Map<string, Prepared>();
  private readonly capsules: CapsuleLaunchService;
  private readonly terminals: TerminalManager;
  private readonly control: AgentControlService;
  private readonly containers: ContainerExecutionService;
  private readonly settings: () => Pick<AppSettings, 'providerAccounts' | 'apiProfiles' | 'containerProfiles'>;
  constructor(capsules: CapsuleLaunchService, terminals: TerminalManager, control: AgentControlService, containers: ContainerExecutionService, settings: () => Pick<AppSettings, 'providerAccounts' | 'apiProfiles' | 'containerProfiles'>) {
    this.capsules = capsules; this.terminals = terminals; this.control = control; this.containers = containers; this.settings = settings;
  }

  async choices(capsuleId: string, reviewId: string): Promise<AdvisoryReviewChoices> {
    this.ids(capsuleId, reviewId);
    const source = this.capsules.storage.describe(capsuleId);
    if (source.kind === 'advisory-review') return { parents: [], routes: [], unavailable: 'advisory-source' };
    const owner = source.owner?.parentSessionId;
    if (!owner) return { parents: [], routes: [], unavailable: 'ownerless' };
    try { this.capsules.assertParent(capsuleId, owner); } catch { return { parents: [], routes: [], unavailable: 'owner-unavailable' }; }
    const snapshot = await this.capsules.conventionSnapshot(capsuleId, reviewId);
    this.capsules.assertParent(capsuleId, owner);
    if (!snapshot.files.length) return { parents: [], routes: [], unavailable: 'unchanged' };
    const session = this.terminals.list().find(s => s.id === owner)!;
    return { parents: [{ id: owner, title: session.title, provider: session.provider }], routes: this.routes() };
  }
  private ids(...values: string[]): void { if (values.some(value => typeof value !== 'string' || !UUID.test(value))) throw new Error('Invalid review identity.'); }
  private routes(): AdvisoryReviewRoute[] {
    const settings = this.settings(), result: AdvisoryReviewRoute[] = [];
    for (const account of settings.providerAccounts) {
      if ((account.hostId ?? 'local') !== 'local' || account.bindingRequired || account.binding?.kind !== 'api-profile') continue;
      const backend = settings.apiProfiles.find(p => account.binding?.kind === 'api-profile' && p.id === account.binding.profileId);
      if (!backend) continue;
      try { if (!accountSupportsRuntime(account, account.provider, settings.apiProfiles)) continue; } catch { continue; }
      const models = [...new Set([backend.defaultModel, ...(account.models ?? []).filter(m => !m.includes('*'))].filter((m): m is string => typeof m === 'string' && !!m && m.length <= 100 && !/[\x00-\x1f\x7f]/u.test(m)))];
      for (const model of models.filter(m => accountSupportsModel(account, m))) for (const profile of settings.containerProfiles) {
        if (profile.hostId !== 'local' || profile.network !== 'bridge' || !profile.commands[account.provider]) continue;
        if (result.length >= 128) throw new Error('Too many review routes; narrow the configured models and profiles.');
        result.push({ accountId: account.id, provider: account.provider, accountLabel: account.label, model, containerProfileId: profile.id, containerLabel: profile.label, hostId: 'local' });
      }
    }
    return result;
  }
  async preview(input: AdvisoryReviewRequest, signal?: AbortSignal): Promise<AdvisoryReviewPreview> {
    this.validate(input); input = structuredClone(input); signal?.throwIfAborted();
    this.capsules.assertParent(input.capsuleId, input.parentSessionId);
    const route = this.routes().find(r => r.accountId === input.accountId && r.model === input.model && r.containerProfileId === input.containerProfileId);
    if (!route) throw new Error('Choose an exact configured local API account, model and container.');
    const source = this.capsules.storage.describe(input.capsuleId);
    if (source.kind === 'advisory-review') throw new Error('Advisory review cannot delegate another review.');
    // Conservative original capsule floor also covers path metadata, task and parent disclosure.
    const request: CreateSessionRequest = { provider: route.provider, profile: 'normal', cwd: source.sourceDirectory, position: { x: 0, y: 0 }, parentSessionId: input.parentSessionId, role: 'subagent', allowSubagents: false, accountId: route.accountId, model: route.model, dataClass: this.terminals.capsuleAuthority(input.parentSessionId).dataClass, isolation: { mode: 'container', profileId: route.containerProfileId, capsuleId: source.id } };
    const context = this.terminals.prepareContextLaunch(request);
    const evaluated = this.terminals.evaluateContextLaunch(request, context); // Ordinary budgets before allocation/credentials/engine.
    const snapshot = await this.capsules.conventionSnapshot(source.id, input.reviewId); signal?.throwIfAborted();
    if (!snapshot.files.length || Buffer.byteLength(snapshot.review.patch) > 1024 * 1024) throw new Error('Review must contain a nonempty patch of at most 1 MiB.');
    const freshness = this.capsules.storage.freshnessGuard(source.id, true);
    await this.capsules.conventionSnapshot(source.id, input.reviewId); signal?.throwIfAborted(); freshness();
    const controller = new AbortController(), config = JSON.stringify(this.settings());
    const assertCurrent = (): void => {
      signal?.throwIfAborted(); controller.signal.throwIfAborted(); freshness();
      this.capsules.assertParent(source.id, input.parentSessionId); context.assertAuthority?.(); context.capture?.assertCurrent(); context.context?.assertCurrent();
      if (JSON.stringify(this.settings()) !== config) throw new Error('Review route configuration changed. Preview again.');
    };
    assertCurrent();
    for (const [id, value] of this.pending) if (value.expires < Date.now() && !value.launched) this.pending.delete(id);
    if (this.pending.size >= 64) throw new Error('Review preparation limit reached. Cancel an unused preview.');
    const previewId = randomUUID();
    this.pending.set(previewId, { input, request: evaluated, context, assertCurrent, controller, expires: Date.now() + 10 * 60_000, launched: false });
    return { previewId, route, dataClass: evaluated.dataClass!, text: context.context?.text ?? '', contextDataClass: context.context?.includedDataClass ?? 'D0', contextBytes: Buffer.byteLength(context.context?.text ?? ''), reviewDigest: snapshot.review.digest };
  }
  private validate(input: AdvisoryReviewRequest): void {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== ['capsuleId', 'reviewId', 'parentSessionId', 'accountId', 'model', 'containerProfileId'].sort().join(',')) throw new Error('Invalid advisory review fields.');
    this.ids(input.capsuleId, input.reviewId, input.parentSessionId);
    if (![input.accountId, input.containerProfileId].every(value => typeof value === 'string' && ID.test(value)) || typeof input.model !== 'string' || !input.model || input.model.length > 100 || /[\x00-\x1f\x7f]/u.test(input.model)) throw new Error('Invalid review route.');
  }
  cancel(previewId: string, parent?: string): void {
    this.ids(previewId); const prepared = this.pending.get(previewId);
    if (!prepared) return;
    if (parent !== undefined) this.capsules.assertParent(prepared.input.capsuleId, parent);
    prepared.controller.abort(new Error('Advisory review cancelled.'));
    if (!prepared.launched) this.pending.delete(previewId);
  }
  async launch(previewId: string, parent?: string, signal?: AbortSignal): Promise<SessionSnapshot> {
    this.ids(previewId); const prepared = this.pending.get(previewId);
    if (!prepared || prepared.launched || prepared.expires < Date.now()) throw new Error('Advisory preview expired. Preview again.');
    if (parent !== undefined && parent !== prepared.input.parentSessionId) throw new Error('Review is owned by another parent.');
    const abort = (): void => prepared.controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const active = (): void => { signal?.throwIfAborted(); prepared.assertCurrent(); };
    let derived: Awaited<ReturnType<CapsuleLaunchService['prepareAdvisory']>> | undefined;
    let child: SessionSnapshot | undefined;
    try {
      active(); this.terminals.evaluateContextLaunch(prepared.request, prepared.context); prepared.launched = true;
      derived = await this.capsules.prepareAdvisory(prepared.input.capsuleId, prepared.input.reviewId, prepared.input.parentSessionId, prepared.controller.signal, prepared.assertCurrent, { accountId: prepared.input.accountId, model: prepared.input.model, containerProfileId: prepared.input.containerProfileId }); active();
      child = await this.control.spawnCapsule({ parentSessionId: prepared.input.parentSessionId, provider: prepared.request.provider as AdvisoryReviewRoute['provider'], cwd: derived.sourceDirectory, accountId: prepared.input.accountId, model: prepared.input.model, profile: 'normal', title: 'Advisory review', allowSubagents: false, isolation: { mode: 'container', profileId: prepared.input.containerProfileId, capsuleId: derived.id } }, prepared.controller.signal, { context: prepared.context, assertCurrent: prepared.assertCurrent });
      const owned = derived, sessionId = child.id;
      // Keep the session as ordinary advisory output, even on launch failure. Cleanup only verified stopped, unused payload.
      void this.terminals.waitForLaunch(sessionId).finally(async () => {
        this.pending.delete(previewId); signal?.removeEventListener('abort', abort);
        const session = this.terminals.list().find(s => s.id === sessionId);
        if ((!session || session.exitCode !== null) && !await this.containers.blocksWorkspace(owned.id).catch(() => true)) await this.capsules.cleanup(owned.id).catch(() => {});
      }).catch(() => {});
      return child;
    } catch (error) {
      this.pending.delete(previewId); signal?.removeEventListener('abort', abort);
      if (derived && !child && !await this.containers.blocksWorkspace(derived.id).catch(() => true)) await this.capsules.cleanup(derived.id).catch(() => {});
      throw error;
    }
  }
}
