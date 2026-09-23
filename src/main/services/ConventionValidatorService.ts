import { randomUUID } from 'node:crypto';
import { DATA_CLASSES, DATA_CLASS_RANK, type DataClass } from '../../shared/contracts.ts';
import { resolveContext } from '../../shared/contextProfiles.ts';
import type { ConventionReport } from '../../shared/conventions.ts';
import { contextRootIdentity } from './ProjectConventionImporter.ts';
import { checkConventions } from './ConventionChecks.ts';
import type { CapsuleLaunchService } from './CapsuleLaunchService.ts';
import type { ContextProfileStore } from './ContextProfileStore.ts';
const identity = (value: unknown): void => { if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)) throw new Error('Invalid convention review identity.'); };

/** Explicit deterministic review of main-owned bytes; never launches a model or a repository program. */
export class ConventionValidatorService {
  private readonly capsules: CapsuleLaunchService;
  private readonly context: ContextProfileStore;
  private readonly reports = new Map<string, { report: ConventionReport; assertCurrent(): void; authority(): void }>();
  constructor(capsules: CapsuleLaunchService, context: ContextProfileStore) { this.capsules = capsules; this.context = context; }
  async run(capsuleId: string, reviewId: string, maxDataClass: DataClass, authority: () => void = () => {}): Promise<ConventionReport> {
    identity(capsuleId); identity(reviewId);
    if (!DATA_CLASSES.includes(maxDataClass)) throw new Error('Invalid convention report clearance.');
    authority();
    const source = this.capsules.storage.describe(capsuleId).sourceDirectory, project = this.context.conventionProject(source);
    const report: ConventionReport = { id: randomUUID(), capsuleId, reviewId, maxDataClass, state: 'disabled', createdAt: Date.now(), warnings: [], diagnostics: [], coverage: [], truncated: false };
    if (!project?.validationEnabled) { report.diagnostics.push({ code: 'disabled', message: 'Enable deterministic checks for the registered source project in Context settings.' }); return report; }
    if (contextRootIdentity(project.root) !== project.rootIdentity) throw new Error('Convention project identity changed.');
    const snapshot = await this.capsules.conventionSnapshot(capsuleId, reviewId); authority();
    const capture = this.context.capture(source);
    const selected = resolveContext(capture.state.rules, { projectId: project.id, ...(project.organizationId ? { organizationId: project.organizationId } : {}), maxDataClass, byteBudget: 24576 }, new Set(capture.learnedRuleIds ?? []));
    const files = snapshot.files.filter(f => DATA_CLASS_RANK[f.dataClass] <= DATA_CLASS_RANK[maxDataClass]);
    const result = checkConventions(files, selected.included);
    const append = (diagnostic: typeof result.diagnostics[number]): void => { if (result.diagnostics.length < 64) result.diagnostics.push(diagnostic); else result.truncated = true; };
    if (files.length !== snapshot.files.length) append({ code: 'clearance', message: 'Some source scope is outside the selected clearance and was not inspected.' });
    if (selected.omitted) append({ code: 'context-budget', message: 'Some permitted context did not fit the context budget; coverage is partial.' });
    for (const diagnostic of capture.diagnostics ?? []) if (DATA_CLASS_RANK[diagnostic.dataClass] <= DATA_CLASS_RANK[maxDataClass]) append({ code: 'context-import', path: diagnostic.sourcePath, message: diagnostic.message });
    Object.assign(report, result, { state: 'complete', reviewDigest: snapshot.review.digest, contextDigest: capture.digest });
    const assertCurrent = (): void => { authority(); capture.assertCurrent(); if (contextRootIdentity(project.root) !== project.rootIdentity) throw new Error('Convention project identity changed.'); };
    assertCurrent(); await this.capsules.conventionSnapshot(capsuleId, reviewId); assertCurrent();
    for (const [id, saved] of this.reports) if (saved.report.capsuleId === capsuleId) this.reports.delete(id);
    if (this.reports.size >= 8) this.reports.delete(this.reports.keys().next().value!);
    this.reports.set(report.id, { report: structuredClone(report), assertCurrent, authority });
    return report;
  }
  /** Currentness only, no rule re-execution. Stale reports are removed rather than returned as a pass. */
  async current(id: string): Promise<ConventionReport> {
    identity(id); const saved = this.reports.get(id); if (!saved) throw new Error('Convention report expired. Validate the current review again.');
    try { saved.authority(); saved.assertCurrent(); await this.capsules.conventionSnapshot(saved.report.capsuleId, saved.report.reviewId); saved.assertCurrent(); return structuredClone(saved.report); }
    catch (error) { this.reports.delete(id); throw error; }
  }
}
