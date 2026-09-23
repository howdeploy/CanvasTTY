import { ORCHESTRATION_ENV } from './agent-browser/orchestration-protocol.ts';
import { assertOrchestrationHelperAvailable } from './agent-browser/ProviderLaunch.ts';
import type { AgentProvider } from './agent-browser/protocol.ts';
import { assertDelegationRoute, requestsDelegation } from '../../shared/delegationLaunch.ts';
import { assertContextLaunchSelection } from '../../shared/contextRuntime.ts';
import type { ContextLaunchCapture, ContextLaunchIntent, ContextLaunchService, OwnedContextSource, PreparedLaunchContext } from './ContextLaunchService.ts';
import { startupArguments, type AgentStartup } from "./AgentStartup.ts";
import { ACPAdapter, assertAcpPrompt, miniMaxModelIdentity, miniMaxModelValue, type AcpOptions } from "./ACPAdapter.ts";
import { assertIsolationRequest } from "../../shared/isolation.ts";
import { assertContainerPlacementRequest } from '../../shared/containerPlacement.ts';
import type { ContainerAutoLaunchRequest, ContainerPlacementPreview } from '../../shared/containerPlacement.ts';
import type { ContainerPlacementService } from './ContainerPlacement.ts';
import type { PreparedProviderAccountLaunch, ProviderAccountLaunchCoordinator } from "./ProviderAccountLaunchService.ts";
import { createHash, randomUUID } from "node:crypto";
import { statSync, realpathSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { pathWithin } from './pathWithin.ts';
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type {
  CreateSessionRequest,
  DataClass,
  Point,
  ProviderId,
  ProviderAccount,
  RemoteHost,
  SessionBounds,
  SessionRole,
  SessionEvent,
  SessionMetadata,
  SessionRemovedEvent,
  SessionSnapshot,
  TerminalBufferSnapshot,
  TerminalDataEvent
} from "../../shared/contracts.ts";
import {
  ACP_PROVIDERS,
  CANVAS_LAUNCHER_ITEMS,
  INITIAL_TERMINAL_COLS,
  INITIAL_TERMINAL_ROWS,
  IPC,
  remotePathForHost
} from "../../shared/contracts.ts";
import type {
  AgentBrowserLaunchCoordinator,
  PreparedAgentBrowserPtyLaunch
} from "./agent-browser/AgentBrowserBridge.ts";
import { AGENT_BROWSER_ENV } from "./agent-browser/AgentBrowserBridge.ts";
import type { OrchestrationLaunchCoordinator, PreparedOrchestrationPtyLaunch } from "./agent-browser/OrchestrationBridge.ts";
import type {
  AgentRuntimeLaunchCoordinator,
  PreparedAgentRuntimePtyLaunch
} from "./agent-runtime/AgentRuntimeBridge.ts";
import { AGENT_RUNTIME_ENV } from "../../agent-runtime/runtime-protocol.mjs";
import { mergeOpenCodeLaunchEnvironment } from "./agent-runtime/ProviderRuntimeLaunch.ts";
import { SessionLaunchPolicy, assertLaunchPolicyFields, maxClass } from "./SessionLaunchPolicy.ts";
import { tryPtyOperation } from "./ptySafety.ts";
import { terminalFailureDetails } from "./terminalFailureDetails.ts";
import { remoteAgentLaunch } from "./remoteAgentLaunch.ts";
import { remoteTerminalLaunch } from "./remoteTerminalLaunch.ts";
import { resolveTerminalLaunch, type TerminalLaunch } from "./terminalLaunch.ts";
import {
  persistedTerminalSession,
  type PersistedTerminalSession,
  type TerminalSessionStore
} from "./TerminalSessionStore.ts";
import type { ProviderCliRegistry, UnavailableProviderCli } from "./providerCliRegistry.ts";
import { PROVIDER_CLI_DEFINITIONS } from "./providerCliRegistry.ts";
import {
  createProviderLifecycleParser,
  initialSessionStatus,
  type ProviderLifecycleParser
} from "./providerLifecycle.ts";

const MAX_PENDING_INPUT_CHARS = 131_072;
const MAX_SCROLLBACK_CHARS = 240_000;
const OUTPUT_BATCH_MS = 16;
const DEFAULT_TERMINAL_SIZE = { width: 700, height: 430 };
const MIN_TERMINAL_SIZE = { width: 420, height: 260 };
const MAX_TERMINAL_SIZE = { width: 1_600, height: 1_100 };

export interface OwnedContextLaunch {
  capture?: ContextLaunchCapture;
  context?: PreparedLaunchContext;
  intent?: ContextLaunchIntent;
  source?: OwnedContextSource;
  parentFloor?: DataClass;
  dataClassInherited?: boolean;
  assertAuthority?(): void;
}
interface ManagedSession {
  contextLaunch?: OwnedContextLaunch;
  /** Cleared after startup; later ACP turns capture fresh rules from the retained intent/source. */
  contextStartupActive?: boolean;
  confirmedPolicyModel?: string;

  metadata: SessionMetadata;
  process: IPty | null;
  acp: ACPAdapter | null;
  disposing?: boolean;
  initialPrompt?: string;
  cols: number;
  rows: number;
  bufferChunks: string[];
  bufferStart: number;
  bufferLength: number;
  outputOffset: number;
  pendingOutput: string[];
  pendingInput: string;
  outputTimer: ReturnType<typeof setTimeout> | null;
  agentBrowser: PreparedAgentBrowserPtyLaunch | null;
  agentRuntime: PreparedAgentRuntimePtyLaunch | null;
  agentOrchestration: PreparedOrchestrationPtyLaunch | null;
  lifecycle: ProviderLifecycleParser | null;
  awaitingInitialResize: boolean;
  resumeOnLaunch: boolean;
  providerLaunch: PreparedProviderAccountLaunch | null;
  launchGeneration: number;
  delegationGeneration: string;
  launchTask: Promise<void> | null;
  /** Initial auto selection only. Never serialized or reused by restart. */
  routeGuard?: () => void;
}

export interface ProviderLifecycleSignal {
  kind: "lifecycle";
  state: "idle" | "working" | "needs_approval";
  requestId?: string;
}

type Emit = (
  channel: typeof IPC.terminalData | typeof IPC.terminalSession | typeof IPC.terminalRemoved,
  payload: TerminalDataEvent | SessionEvent | SessionRemovedEvent
) => void;

export class TerminalManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly emit: Emit;
  private readonly providerClis: ProviderCliRegistry;
  private readonly agentBrowser?: AgentBrowserLaunchCoordinator;
  private readonly agentRuntime?: AgentRuntimeLaunchCoordinator;
  private acpOptions: AcpOptions = {};
  private readonly spawnPty: typeof pty.spawn;
  private lifecycleHooksEnabled: boolean;
  private agentOrchestration: OrchestrationLaunchCoordinator | null = null;
  private resolveRemoteHost: ((hostId: string) => RemoteHost | null) | null = null;
  private launchPolicy: SessionLaunchPolicy | null = null;
  private contextService?: ContextLaunchService;
  private contextEnabled: () => boolean = () => false;

  private providerLaunch: ProviderAccountLaunchCoordinator | null = null;
  private containerPlacement: Pick<ContainerPlacementService, 'preview' | 'resolve'> | null = null;
  private sessionStore: TerminalSessionStore | null = null;
  private sessionPersistenceEnabled = false;
  private suppressPersistence = false;
  private shuttingDown = false;

  constructor(
    emit: Emit,
    providerClis: ProviderCliRegistry,
    agentBrowser?: AgentBrowserLaunchCoordinator,
    agentRuntime?: AgentRuntimeLaunchCoordinator,
    lifecycleHooksEnabled = true,
    spawnPty: typeof pty.spawn = pty.spawn
  ) {
    this.emit = emit;
    this.providerClis = providerClis;
    this.agentBrowser = agentBrowser;
    this.agentRuntime = agentRuntime;
    this.spawnPty = spawnPty;
    this.lifecycleHooksEnabled = lifecycleHooksEnabled;
  }

  configureAcp(options: AcpOptions): void { this.acpOptions = options; }

  configureLaunchPolicy(policy: SessionLaunchPolicy): void {
    this.launchPolicy = policy;
  }

  configureContextLaunch(service: ContextLaunchService, enabled: () => boolean): void { this.contextService = service; this.contextEnabled = enabled; }

  /** Explicit trusted-renderer preview: no reservation, credentials, workspace or process. */
  async previewContextLaunch(input: CreateSessionRequest): Promise<import('../../shared/contextRuntime.ts').LaunchContextPreview> {
    assertCreateRequest(input); assertTransport(input);
    this.assertDelegationAvailable(input);
    if (input.parentSessionId !== undefined || input.role && input.role !== 'interactive') throw new Error('Context preview belongs to the interactive launcher.');
    if (input.containerPlacement !== undefined) assertContainerPlacementRequest(input);
    if (!this.contextEnabled() || input.context?.enabled === false || input.provider === 'terminal') return { enabled: false, text: '', bytes: 0, dataClass: 'D0' };
    let request = structuredClone(input);
    const launch = this.prepareContextLaunch(request);
    if (request.containerPlacement !== undefined) {
      const pending = this.containerPlacementRequest(request);
      const resolved = await this.containerPlacement!.resolve(pending.request, launch.capture);
      pending.assertAuthority(); resolved.assertCurrent();
      request = resolved.request; launch.context = resolved.context;
    } else request = this.evaluateContextLaunch(request, launch);
    if (!this.contextEnabled()) throw new Error('Context delivery was disabled; refresh the preview.');
    launch.assertAuthority?.(); launch.capture?.assertCurrent();
    if (request.transport !== 'acp') startupArguments(request.provider, { task: request.isolation?.mode === 'container' && request.isolation.capsuleId ? 'Read /workspace/Task.md and perform the task using only the selected files in /workspace.' : request.initialPrompt, context: launch.context?.text || undefined });
    const context = launch.context, text = context?.text ?? '';
    return { enabled: true, text, bytes: Buffer.byteLength(text), dataClass: context?.includedDataClass ?? 'D0',
      ...(context ? { revision: context.ref.revision, digest: context.digest } : {}),
      route: { accountId: request.accountId, hostId: request.hostId, model: request.model, ...(request.isolation?.mode === 'container' ? { profileId: request.isolation.profileId } : {}) } };
  }

  /** Main-only capture, reused throughout a placement operation. */
  prepareContextLaunch(request: CreateSessionRequest): OwnedContextLaunch {
    const parent = request.parentSessionId ? this.sessions.get(request.parentSessionId) : undefined;
    if (request.parentSessionId !== undefined && !parent) throw new Error('Parent terminal session does not exist.');
    const dataClassInherited = request.dataClass === undefined;
    const parentFloor = parent && request.initialPrompt?.trim() ? parent.metadata.disclosureClass ?? parent.metadata.dataClass : undefined;
    const generation = parent?.delegationGeneration;
    const assertAuthority = (): void => { if (this.shuttingDown || request.parentSessionId && (!parent || this.sessions.get(request.parentSessionId) !== parent || parent.disposing || parent.metadata.exitCode !== null || parent.delegationGeneration !== generation)) throw new Error('Launch owner changed or is no longer running.'); };
    assertAuthority();
    const disabled = request.context?.enabled === false || parent?.metadata.contextDisabled || parent?.contextLaunch?.intent?.enabled === false;
    if (!this.contextEnabled() || !this.contextService || request.provider === 'terminal' || disabled) return { parentFloor, assertAuthority, dataClassInherited, ...(disabled ? { intent: { enabled: false, provider: request.provider } } : {}) };
    if (request.parentSessionId !== undefined && request.context !== undefined) throw new Error('Child context selection is inherited from its owner.');
    const source = this.contextSource(request);
    const inherited = parent?.contextLaunch?.intent && parent.contextLaunch.capture?.ref.projectId
      ? { projectId: parent.contextLaunch.capture.ref.projectId, intent: parent.contextLaunch.intent } : undefined;
    const intent: ContextLaunchIntent = { ...request.context, enabled: true, provider: request.provider };
    const capture = this.contextService.capture(intent, source, inherited);
    return { source, capture, assertAuthority, dataClassInherited, intent: capture ? this.contextService.intent(capture) : undefined, parentFloor };
  }

  private contextSource(request: Pick<CreateSessionRequest, 'cwd' | 'parentSessionId'>): OwnedContextSource {
    const parent = request.parentSessionId ? this.sessions.get(request.parentSessionId) : undefined;
    if (!request.parentSessionId) return { sourceCwd: request.cwd, assertCurrent() {} };
    const generation = parent?.delegationGeneration;
    let assertExecution: (() => void) | undefined;
    let parentSource: OwnedContextSource | undefined;
    const assertCurrent = (): void => {
      if (!parent || parent.disposing || this.sessions.get(request.parentSessionId!) !== parent || parent.metadata.exitCode !== null || parent.delegationGeneration !== generation || (!parent.process && !parent.acp)) throw new Error('Parent context source changed or is no longer running.');
      if (parent.metadata.isolation?.mode === 'container' && parent.metadata.isolation.capsuleId) throw new Error('Capsule delegation is unavailable.');
      parentSource?.assertCurrent();
      parent.providerLaunch?.assertCurrent(parent.metadata); assertExecution?.();
    };
    assertCurrent();
    const execution = parent!.providerLaunch?.execution;
    const executionCwd = execution?.executionCwd ?? parent!.metadata.cwd;
    parentSource = parent!.contextLaunch?.source ?? (parent!.metadata.parentSessionId ? this.contextSource({ cwd: parent!.metadata.cwd, parentSessionId: parent!.metadata.parentSessionId }) : undefined);
    const logical = parentSource?.sourceCwd ?? parent!.metadata.cwd;
    const localExecution = parent!.metadata.hostId === undefined ? execution?.mode === 'container' ? execution.hostWorkspace : executionCwd : undefined;
    if (localExecution) {
      const canonical = realpathSync(localExecution), stat = statSync(canonical), identity = `${stat.dev}:${stat.ino}`;
      assertExecution = (): void => { const live = statSync(localExecution); if (realpathSync(localExecution) !== canonical || `${live.dev}:${live.ino}` !== identity || !live.isDirectory()) throw new Error('Owned execution directory changed before child launch.'); };
    }
    let sourceCwd = request.cwd;
    if (execution?.mode === 'container' || parent!.metadata.hostId !== undefined) {
      // Only a live main-owned execution path may authorize remote/container mapping.
      if (execution && pathWithin(executionCwd, request.cwd)) sourceCwd = join(logical, relative(executionCwd, request.cwd));
    } else {
      const canonical = realpathSync(request.cwd), base = realpathSync(executionCwd);
      if (pathWithin(base, canonical)) sourceCwd = join(logical, relative(base, canonical));
    }
    return { sourceCwd, assertCurrent };
  }

  /** Main-owned provenance for a user-attested correction; never reads or interprets PTY text. */
  contextFeedbackEvidence(id: string): import('./ContextFeedback.ts').ContextSessionEvidence {
    const session = this.sessions.get(id), generation = session?.delegationGeneration;
    const source = session?.contextLaunch?.source ?? (session ? this.contextSource({ cwd: session.metadata.cwd, parentSessionId: session.metadata.parentSessionId }) : undefined);
    const launchGeneration = session?.launchGeneration;
    const assertCurrent = (): void => {
      if (!session || this.shuttingDown || session.disposing || this.sessions.get(id) !== session || session.metadata.exitCode !== null || session.delegationGeneration !== generation || session.launchGeneration !== launchGeneration || (!session.process && !session.acp)) throw new Error('Context evidence session is no longer current.');
      source?.assertCurrent(); session.providerLaunch?.assertCurrent(session.metadata);
    };
    assertCurrent();
    return { sessionId: id, generation: `${generation}:${launchGeneration}`, sourceCwd: source!.sourceCwd, dataClass: session!.metadata.disclosureClass ?? session!.metadata.dataClass ?? 'D2', assertCurrent };
  }

  resolveOwnedChildCwd(cwd: string, parentSessionId: string): string {
    if (!this.contextEnabled() || !this.contextService) return cwd;
    const parent = this.sessions.get(parentSessionId), execution = parent?.providerLaunch?.execution;
    if (!execution || execution.mode !== 'container' && parent?.metadata.hostId === undefined || !execution.executionCwd || !pathWithin(execution.executionCwd, cwd)) return cwd;
    return this.contextSource({ cwd, parentSessionId }).sourceCwd;
  }

  evaluateContextLaunch<T extends CreateSessionRequest>(request: T, launch: OwnedContextLaunch, excludeId?: string): T {
    launch.assertAuthority?.();
    const input = { ...request, ...(launch.dataClassInherited ? { dataClassInherited: true } : {}), ...(launch.parentFloor ? { disclosureClass: launch.parentFloor } : {}) };
    const evaluated = this.launchPolicy?.evaluateFixed(input, this.listMetadata(), excludeId, launch.capture);
    launch.context = evaluated?.context;
    return evaluated?.request ?? request;
  }

  nativePlacementCandidates(request: CreateSessionRequest, launch: OwnedContextLaunch): Array<{ request: CreateSessionRequest; launch: OwnedContextLaunch }> {
    const base = { ...request, ...(launch.parentFloor ? { disclosureClass: launch.parentFloor } : {}) };
    const candidates = this.launchPolicy?.fixedPlacementRequests(base) ?? [base];
    const accepted: Array<{ request: CreateSessionRequest; launch: OwnedContextLaunch }> = [];
    for (const candidate of candidates) {
      try { const selected = { ...launch }; accepted.push({ request: this.evaluateContextLaunch(candidate, selected), launch: selected }); } catch { /* An ineligible fixed tuple must never reach host probes. */ }
    }
    if (!accepted.length) throw new Error('No eligible account/host route satisfies this task and context.');
    launch.capture?.assertCurrent();
    return accepted;
  }

  /** Main-only fixed plan selected before probes; no fallback after this call. */
  createPlanned(request: CreateSessionRequest, launch: OwnedContextLaunch, guard?: () => void): SessionSnapshot { return this.createFixed(request, guard, launch); }

  configureProviderLaunch(coordinator: ProviderAccountLaunchCoordinator): void { this.providerLaunch = coordinator; }

  configureContainerPlacement(placement: Pick<ContainerPlacementService, 'preview' | 'resolve'>): void { this.containerPlacement = placement; }

  async previewContainerPlacement(input: CreateSessionRequest): Promise<ContainerPlacementPreview> {
    const { request, assertAuthority } = this.containerPlacementRequest(input);
    const launch = this.prepareContextLaunch(request);
    const result = await this.containerPlacement!.preview(request, launch.capture);
    assertAuthority();
    return result;
  }

  async createWithPlacement(input: CreateSessionRequest, signal?: AbortSignal): Promise<SessionSnapshot> {
    signal?.throwIfAborted();
    const { request, assertAuthority } = this.containerPlacementRequest(input, signal);
    const launch = this.prepareContextLaunch(request);
    const resolved = await this.containerPlacement!.resolve(request, launch.capture, launch.parentFloor);
    launch.context = resolved.context;
    const guard = (excludeSessionId?: string): void => { assertAuthority(); resolved.assertCurrent(excludeSessionId); };
    return this.createFixed(resolved.request, guard, launch);
  }

  private containerPlacementRequest(input: CreateSessionRequest, signal?: AbortSignal): { request: ContainerAutoLaunchRequest; assertAuthority(): void } {
    assertDelegationRoute(input);
    assertContainerPlacementRequest(input);
    const request = structuredClone(input);
    assertCreateRequest(request); assertTransport(request);
    startupArguments(request.provider, { task: request.initialPrompt });
    assertDirectory(request.cwd);
    if (!this.containerPlacement || !this.providerLaunch?.handlesTerminals || !this.launchPolicy) throw new Error('Container auto-placement is unavailable.');
    const parent = request.parentSessionId === undefined ? undefined : this.sessions.get(request.parentSessionId);
    const generation = parent?.delegationGeneration;
    const assertAuthority = (): void => {
      signal?.throwIfAborted();
      if (this.shuttingDown) throw new Error('Terminal manager has shut down; container placement was cancelled.');
      if (request.parentSessionId !== undefined && (!parent || this.sessions.get(request.parentSessionId) !== parent || parent.disposing || parent.metadata.exitCode !== null || parent.delegationGeneration !== generation)) throw new Error('Parent session changed or is no longer active during container placement.');
    };
    assertAuthority();
    return { request, assertAuthority };
  }

  private needsPreparedLaunch(provider: ProviderId): boolean { return !!this.providerLaunch && (provider !== "terminal" || !!this.providerLaunch.handlesTerminals); }

  async waitForLaunch(id: string): Promise<void> { await this.sessions.get(id)?.launchTask; }

  hasLaunchPolicy(): boolean {
    return this.launchPolicy !== null;
  }

  /** Main-only authority: a persisted session id never restores delegation rights. */
  capsuleAuthority(id: string): { generation: string; binding: string; cwd: string; dataClass: DataClass } {
    const session = this.sessions.get(id), metadata = session?.metadata;
    if (!session || !metadata || session.disposing || !this.launchPolicy || metadata.exitCode !== null || (!session.process && !session.acp) || metadata.hostId !== undefined || (metadata.isolation && metadata.isolation.mode !== 'direct') || metadata.provider === 'terminal' || (metadata.role !== 'orchestrator' && metadata.allowSubagents !== true)) throw new Error('Capsule operation is not authorized for this session.');
    const current = this.launchPolicy.classify(metadata);
    if (current.accountId !== metadata.accountId || current.model !== metadata.model || current.dataClass !== metadata.dataClass) throw new Error('Parent launch policy changed; capsule operation is not authorized.');
    session.providerLaunch?.assertCurrent(metadata);
    return { generation: session.delegationGeneration, cwd: metadata.cwd, dataClass: current.dataClass,
      binding: createHash('sha256').update(JSON.stringify([metadata.provider, metadata.profile, metadata.accountId, metadata.model, metadata.launchBinding, current.dataClass])).digest('hex') };
  }

  classifyLaunchRequest<T extends CreateSessionRequest>(request: T, forPlacement = false): T {
    assertTransport(request);
    return this.launchPolicy?.classify(request, forPlacement) ?? request;
  }

  placementAccounts(request: CreateSessionRequest): ProviderAccount[] | undefined {
    return this.launchPolicy?.placementAccounts(request);
  }

  configureOrchestration(coordinator: OrchestrationLaunchCoordinator | null): void {
    this.agentOrchestration = coordinator;
  }

  // Remote sessions — shells and agents alike — resolve their host through
  // this injected lookup so the manager never imports settings itself
  // (mirrors configureOrchestration). Callers read their live host registry
  // on every resolve.
  configureRemoteHosts(resolve: (hostId: string) => RemoteHost | null): void {
    this.resolveRemoteHost = resolve;
  }

  configureSessionPersistence(store: TerminalSessionStore, enabled: boolean): void {
    this.sessionStore = store;
    this.sessionPersistenceEnabled = Boolean(enabled);
  }

  async restorePersistedSessions(): Promise<void> {
    const store = this.sessionStore;
    if (!store) return;
    const persisted = await store.load();
    if (!this.sessionPersistenceEnabled) {
      if (persisted.length > 0) await store.clear();
      return;
    }

    // A subagent whose owning session is gone restores as nothing: its
    // parent's runtime state no longer exists to collect its result.
    const restorable = persisted.filter((descriptor) => (
      descriptor.role !== "subagent"
      || persisted.some((candidate) => candidate.id === descriptor.parentSessionId)
      || this.sessions.has(descriptor.parentSessionId ?? "")
    ));
    for (const descriptor of restorable) this.restorePersistedSession(descriptor);
    await this.persistSessions();
  }

  async setSessionPersistenceEnabled(enabled: boolean): Promise<void> {
    const next = Boolean(enabled);
    if (this.sessionPersistenceEnabled === next) return;
    this.sessionPersistenceEnabled = next;
    if (next) await this.persistSessions();
    else await this.sessionStore?.clear();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.persistSessions().catch((error) => {
      console.warn("CanvasTTY terminal window state could not be saved during shutdown.", error);
    });
    this.suppressPersistence = true;
    const stoppedAcp = [...this.sessions.values()].flatMap(session => session.acp ? [session.acp.stopped] : []);
    const pendingLaunches = [...this.sessions.values()].flatMap((session) => session.launchTask ? [session.launchTask] : []);
    const preparedLaunches = [...this.sessions.values()].flatMap((session) => session.providerLaunch && !session.acp ? [session.providerLaunch] : []);
    this.disposeAll();
    await Promise.allSettled([...stoppedAcp, ...pendingLaunches, ...preparedLaunches.map((prepared) => prepared.cleanup())]);
    if (this.sessionStore) await this.sessionStore.flush().catch(() => undefined);
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()].filter(session => !session.disposing).map((session) => snapshot(session));
  }

  listMetadata(): SessionMetadata[] {
    return [...this.sessions.values()].map(session => structuredClone(session.metadata));
  }

  geometry(id: string): { cols: number; rows: number } {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Terminal unavailable");
    return { cols: session.cols, rows: session.rows };
  }

  inputChecked(id: string, data: string): boolean {
    const session = this.sessions.get(id);
    if (!session?.process || session.metadata.exitCode !== null) return false;
    return tryPtyOperation(() => session.process!.write(data));
  }

  readBuffer(id: string): TerminalBufferSnapshot {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Terminal session does not exist.");
    return {
      buffer: session.bufferChunks.slice(session.bufferStart).join(""),
      outputOffset: session.outputOffset
    };
  }

  create(request: CreateSessionRequest): SessionSnapshot {
    if (request?.containerPlacement !== undefined) throw new Error('Container placement requires the asynchronous launch boundary.');
    return this.createFixed(request);
  }

  private createFixed(request: CreateSessionRequest, routeGuard?: (excludeSessionId?: string) => void, ownedLaunch?: OwnedContextLaunch): SessionSnapshot {
    routeGuard?.();
    if (ownedLaunch) { const { disclosureClass: _floor, dataClassInherited: _inherited, ...publicRequest } = request as CreateSessionRequest & { disclosureClass?: DataClass; dataClassInherited?: boolean }; assertCreateRequest(publicRequest); }
    else assertCreateRequest(request);
    this.assertDelegationAvailable(request);
    if (request.transport !== "acp") startupArguments(request.provider, { task: request.initialPrompt });
    if (request.isolation?.mode === 'container' && request.isolation.capsuleId && request.initialPrompt !== undefined) throw new Error('Capsule tasks must be classified and captured in Task.md before launch.');
    assertTransport(request);
    assertDirectory(request.cwd);
    if (request.isolation?.mode === "container" && !this.providerLaunch?.handlesTerminals) throw new Error("Container launch preparation is unavailable.");
    if (request.isolation?.mode === "worktree" && (!this.providerLaunch?.handlesTerminals || request.hostId !== undefined)) throw new Error("Local worktree launch preparation is required for this isolation mode.");
    const dataClassInherited = ownedLaunch?.dataClassInherited ?? request.dataClass === undefined;
    const contextLaunch = ownedLaunch ?? this.prepareContextLaunch(request);
    contextLaunch.assertAuthority?.(); contextLaunch.capture?.assertCurrent();
    request = this.evaluateContextLaunch(request, contextLaunch);
    const startup: AgentStartup = { task: request.initialPrompt, context: contextLaunch.context?.text || undefined };
    if (request.transport !== 'acp') startupArguments(request.provider, { ...startup, ...(request.isolation?.mode === 'container' && request.isolation.capsuleId ? { task: 'Read /workspace/Task.md.' } : {}) });

    const role = request.role ?? "interactive";
    if (request.parentSessionId !== undefined && !this.sessions.has(request.parentSessionId)) {
      throw new Error("Parent terminal session does not exist.");
    }
    // A remote session must resolve to a configured host before anything
    // spawns: an unknown host fails the create loudly, the same way the
    // request assertions above do, instead of leaving a dead session behind.
    // Agent sessions additionally need their project folder mapped on that
    // host — the remote launch cds into the mapped workspace — so an unmapped
    // folder fails the create here too.
    if (request.hostId !== undefined) {
      const host = this.requireRemoteHost(request.hostId);
      if (request.provider !== "terminal") this.requireRemoteWorkspace(host, request.cwd);
    }

    const id = randomUUID();
    const metadata: SessionMetadata = {
      id,
      ...(contextLaunch.intent?.enabled === false ? { contextDisabled: true } : {}),
      ...((request as CreateSessionRequest & { disclosureClass?: DataClass }).disclosureClass ? { disclosureClass: (request as CreateSessionRequest & { disclosureClass?: DataClass }).disclosureClass } : {}),
      ...(request.initialPrompt?.trim() ? { disclosureClass: maxClass((request as CreateSessionRequest & { disclosureClass?: DataClass }).disclosureClass ?? 'D0', 'D2') } : {}),
      ...(contextLaunch.context ? { contextSummary: { ...contextLaunch.context.ref, digest: contextLaunch.context.digest, status: contextLaunch.context.text ? 'waiting' as const : 'empty' as const, highestDisclosedClass: 'D0' as const, ...(contextLaunch.intent?.categories ? { categories: contextLaunch.intent.categories } : {}), ...(request.model ? { policyModel: request.model } : {}) } } : {}),
      ...(request.transport === "acp" ? { transport: "acp" as const, acp: { phase: "starting" as const, output: "", models: [], permissions: [] } } : {}),
      revision: 0,
      provider: request.provider,
      profile: request.profile,
      title: request.title?.trim() || defaultTitle(request.provider, request.cwd),
      titleCustomized: Boolean(request.title?.trim()),
      cwd: request.cwd,
      ...(request.isolation ? { isolation: structuredClone(request.isolation) } : {}),
      ...(this.needsPreparedLaunch(request.provider) ? { execution: { mode: request.isolation?.mode ?? "direct", sourceCwd: request.cwd, filesystemRestricted: false, state: "preparing" } as const } : {}),
      position: request.position,
      size: DEFAULT_TERMINAL_SIZE,
      role,
      ...(request.parentSessionId !== undefined ? { parentSessionId: request.parentSessionId } : {}),
      ...(request.hostId !== undefined ? { hostId: request.hostId } : {}),
      ...(request.accountId !== undefined ? { accountId: request.accountId } : {}),
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.dataClass !== undefined ? { dataClass: request.dataClass } : {}),
      ...(role === "subagent" || request.allowSubagents !== undefined ? { allowSubagents: request.allowSubagents ?? false } : {}),
      ...(this.launchPolicy ? { dataClassInherited } : {}),
      status: initialSessionStatus(request.provider),
      startedAt: Date.now(),
      exitCode: null,
      failureDetails: null
    };
    // Grok's runtime bridge measures the grid before launching locally; a
    // remote grok takes no runtime bridge (the helper runs on this machine,
    // not the host), so it launches immediately instead of awaiting a resize.
    const awaitMeasuredGrid = request.provider === "grok"
      && request.hostId === undefined
      && this.providerClis.get(request.provider).state === "available";
    const launched = request.transport === "acp" || awaitMeasuredGrid || (this.needsPreparedLaunch(request.provider))
      ? { process: null, agentBrowser: null, agentRuntime: null, agentOrchestration: null, failure: null }
      : this.spawnProcess(metadata, INITIAL_TERMINAL_COLS, INITIAL_TERMINAL_ROWS, false, undefined, startup);
    if (launched.failure) applyLaunchFailure(metadata, launched.failure);

    const session: ManagedSession = {
      contextLaunch, contextStartupActive: true,
      metadata,
      process: launched.process,
      acp: null, initialPrompt: request.transport === "acp" || awaitMeasuredGrid || this.needsPreparedLaunch(request.provider) ? request.initialPrompt : undefined,
      cols: INITIAL_TERMINAL_COLS,
      rows: INITIAL_TERMINAL_ROWS,
      bufferChunks: [],
      bufferStart: 0,
      bufferLength: 0,
      outputOffset: 0,
      pendingOutput: [],
      pendingInput: "",
      outputTimer: null,
      agentBrowser: launched.agentBrowser,
      agentRuntime: launched.agentRuntime,
      agentOrchestration: launched.agentOrchestration,
      lifecycle: this.lifecycleHooksEnabled
        ? createProviderLifecycleParser(request.provider, request.cwd)
        : null,
      awaitingInitialResize: awaitMeasuredGrid,
      resumeOnLaunch: false,
      providerLaunch: null, launchGeneration: 0, delegationGeneration: randomUUID(), launchTask: null,
      ...(routeGuard ? { routeGuard: () => routeGuard(id) } : {})
    };
    this.sessions.set(id, session);
    if ((this.needsPreparedLaunch(request.provider) || request.transport === "acp") && !awaitMeasuredGrid) this.startPreparedLaunch(id, session, false);
    if (launched.process) { session.contextStartupActive = false; this.bindProcess(id, session, launched.process); }
    const runtimeStatus = this.agentRuntime?.currentStatus(id);
    if (runtimeStatus) session.metadata.status = runtimeStatus;

    this.emitSession(metadata);
    this.schedulePersistence();
    return snapshot(session);
  }

  restart(id: string): SessionSnapshot {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Terminal session does not exist.");
    if (session.metadata.exitCode === null) throw new Error("Terminal session is still running.");

    if (this.launchPolicy) Object.assign(session.metadata, this.launchPolicy.check(session.metadata, this.listMetadata(), id));
    assertTransport(session.metadata);
    this.assertDelegationAvailable(session.metadata);
    session.routeGuard = undefined;
    session.contextLaunch = this.refreshContext(session, true); session.contextStartupActive = true;
    if (session.contextLaunch) {
      const evaluated = this.launchPolicy?.evaluateFixed(session.metadata, this.listMetadata(), id, session.contextLaunch.capture);
      session.contextLaunch.context = evaluated?.context;
      if (evaluated) Object.assign(session.metadata, evaluated.request);
      if (evaluated?.context) {
        const context = evaluated.context;
        session.metadata.contextSummary = { ...context.ref, digest: context.digest, status: context.text ? 'waiting' : 'empty', highestDisclosedClass: session.metadata.contextSummary?.highestDisclosedClass ?? 'D0', ...(session.contextLaunch.intent?.categories ? { categories: session.contextLaunch.intent.categories } : {}), ...(session.metadata.model ? { policyModel: session.metadata.model } : {}) };
      }
    } else if (session.metadata.contextSummary) session.metadata.contextSummary.status = 'empty';
    session.delegationGeneration = randomUUID();
    session.pendingInput = ""; session.initialPrompt = undefined;
    if (session.metadata.transport === "acp" || this.needsPreparedLaunch(session.metadata.provider)) {
      session.launchGeneration++; session.acp?.dispose(); session.acp = null;
      this.releaseProviderLaunch(session);
      session.agentBrowser?.cleanup(); session.agentRuntime?.cleanup(); session.agentOrchestration?.cleanup();
      session.agentBrowser = null; session.agentRuntime = null; session.agentOrchestration = null; session.process = null;
      session.metadata.startedAt = Date.now(); session.metadata.status = initialSessionStatus(session.metadata.provider);
      session.metadata.exitCode = null; session.metadata.failureDetails = null;
      session.awaitingInitialResize = session.metadata.provider === "grok" && session.metadata.hostId === undefined;
      session.resumeOnLaunch = false;
      if (session.metadata.transport === "acp") session.metadata.acp = { phase: "starting", output: "", models: [], permissions: [] };
      session.lifecycle = this.lifecycleHooksEnabled ? createProviderLifecycleParser(session.metadata.provider, session.metadata.cwd) : null;
      if (!session.awaitingInitialResize) this.startPreparedLaunch(id, session, false);
      this.emitSession(session.metadata); this.schedulePersistence();
      return snapshot(session);
    }

    if (session.metadata.provider === "grok" && session.metadata.hostId === undefined) {
      session.agentBrowser?.cleanup();
      session.agentRuntime?.cleanup();
      session.agentOrchestration?.cleanup();
      session.process = null;
      session.agentBrowser = null;
      session.agentRuntime = null;
      session.lifecycle = this.lifecycleHooksEnabled
        ? createProviderLifecycleParser(session.metadata.provider, session.metadata.cwd)
        : null;
      session.awaitingInitialResize = true;
      session.resumeOnLaunch = false;
      session.metadata.startedAt = Date.now();
      session.metadata.status = initialSessionStatus(session.metadata.provider);
      session.metadata.exitCode = null;
      session.metadata.failureDetails = null;
      this.emitSession(session.metadata);
      return snapshot(session);
    }

    session.agentOrchestration?.cleanup();
    const launched = this.spawnProcess(session.metadata, session.cols, session.rows, false, undefined, { context: session.contextLaunch?.context?.text || undefined });
    session.contextStartupActive = false;
    session.process = launched.process;
    session.agentBrowser = launched.agentBrowser;
    session.agentRuntime = launched.agentRuntime;
    session.agentOrchestration = launched.agentOrchestration;
    session.awaitingInitialResize = false;
    session.lifecycle = this.lifecycleHooksEnabled
      ? createProviderLifecycleParser(session.metadata.provider, session.metadata.cwd)
      : null;
    session.metadata.startedAt = Date.now();
    if (launched.failure) {
      applyLaunchFailure(session.metadata, launched.failure);
    } else {
      session.metadata.status = initialSessionStatus(session.metadata.provider);
      session.metadata.exitCode = null;
      session.metadata.failureDetails = null;
      if (launched.process) this.bindProcess(id, session, launched.process);
      const runtimeStatus = this.agentRuntime?.currentStatus(id);
      if (runtimeStatus) session.metadata.status = runtimeStatus;
    }
    this.emitSession(session.metadata);
    return snapshot(session);
  }

  input(id: string, data: string): void {
    if (typeof data !== "string" || data.length === 0) return;
    const session = this.sessions.get(id);
    if (!session || session.metadata.exitCode !== null) return;
    if (session.metadata.transport === "acp") return; // ACP never accepts terminal keystrokes.
    if (session.awaitingInitialResize || session.launchTask) {
      if (session.pendingInput.length + data.length > MAX_PENDING_INPUT_CHARS) throw new Error("Agent pending input exceeds the limit.");
      session.pendingInput += data;
      return;
    }
    if (!session.process) return;
    const process = session.process;
    tryPtyOperation(() => process.write(data));
  }

  sendAgentPrompt(id: string, text: string, submit = true): void {
    const session = this.sessions.get(id);
    if (!session || session.disposing || session.metadata.exitCode !== null) throw new Error("Agent session is unavailable.");
    if (session.metadata.transport === "acp") {
      if (!submit) throw new Error("ACP requires a complete submitted prompt.");
      if (!session.acp) throw new Error("ACP session is still starting.");
      assertAcpPrompt(text);
      session.providerLaunch?.assertCurrent(session.metadata);
      session.acp.validatePolicy();
      const plan = session.contextStartupActive ? session.contextLaunch : this.refreshContext(session);
      plan?.capture?.assertCurrent(); plan?.assertAuthority?.();
      const parent = session.metadata.parentSessionId ? this.sessions.get(session.metadata.parentSessionId) : undefined;
      const floor = maxClass(session.metadata.disclosureClass ?? 'D0', parent?.metadata.disclosureClass ?? parent?.metadata.dataClass ?? 'D0');
      const input = { ...session.metadata, disclosureClass: floor, model: session.confirmedPolicyModel, initialPrompt: text };
      const evaluated = this.launchPolicy?.evaluateFixed(input, this.listMetadata(), id, plan?.capture);
      const context = evaluated?.context;
      const combined = context?.text ? `CanvasTTY context:\n${context.text}\n\nCanvasTTY task:\n${text}` : text;
      assertAcpPrompt(combined);
      if (evaluated) session.metadata.dataClass = evaluated.request.dataClass;
      session.metadata.disclosureClass = maxClass(floor, maxClass('D2', context?.includedDataClass ?? 'D0'));
      if (context) {
        session.contextLaunch = { ...plan, context };
        session.metadata.contextSummary = { ...context.ref, digest: context.digest, status: context.text ? 'delivered' : 'empty', highestDisclosedClass: maxClass(session.metadata.contextSummary?.highestDisclosedClass ?? 'D0', context.includedDataClass), ...(plan?.intent?.categories ? { categories: plan.intent.categories } : {}), ...(session.confirmedPolicyModel ? { policyModel: session.confirmedPolicyModel } : {}) };
      }
      // Record before the first possibly successful disclosure; failed sends never lower history.
      this.schedulePersistence();
      session.acp.send(combined);
      appendScrollback(session, `\n› ${combined}\n`); this.queueOutput(id, session, `\n› ${combined}\n`);
    } else {
      if (typeof text !== "string" || text.length === 0 || text.length >= MAX_PENDING_INPUT_CHARS) throw new Error("Agent pending input exceeds the limit or is invalid.");
      const parent = session.metadata.parentSessionId ? this.sessions.get(session.metadata.parentSessionId) : undefined;
      const floor = maxClass(session.metadata.disclosureClass ?? 'D0', parent?.metadata.disclosureClass ?? parent?.metadata.dataClass ?? 'D0');
      const checked = this.launchPolicy?.check({ ...session.metadata, initialPrompt: text, disclosureClass: floor }, this.listMetadata(), id);
      session.providerLaunch?.assertCurrent(session.metadata);
      if (checked && (checked.accountId !== session.metadata.accountId || checked.model !== session.metadata.model || checked.hostId !== session.metadata.hostId)) throw new Error('Running agent route changed; start a fresh session before sending a task.');
      if (checked) session.metadata.dataClass = checked.dataClass;
      session.metadata.disclosureClass = maxClass(floor, 'D2'); this.schedulePersistence();
      this.input(id, submit ? `${text}\r` : text);
    }
  }

  cancelAgentTurn(id: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Agent session is unavailable.");
    if (session.metadata.transport !== "acp") { this.dispose(id); return; }
    // A cancelling owner must not leave delegated processes behind.
    for (const [childId, child] of this.sessions) if (child.metadata.parentSessionId === id) this.dispose(childId);
    if (!session.acp || session.metadata.acp?.phase === "starting") { this.dispose(id); return; }
    session.acp.cancel();
  }

  decideAcpPermission(id: string, requestId: string, optionId: string): void {
    const session = this.sessions.get(id);
    if (!session?.acp || typeof requestId !== "string" || typeof optionId !== "string") throw new Error("ACP permission session is unavailable.");
    session.providerLaunch?.assertCurrent(session.metadata);
    session.acp.validatePolicy();
    session.acp.decide(requestId, optionId);
  }

  async selectAcpModel(id: string, value: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session?.acp || typeof value !== "string") throw new Error("ACP model session is unavailable.");
    session.providerLaunch?.assertCurrent(session.metadata);
    await session.acp.setModel(value);
  }

  private deliverInitialPrompt(id: string, session: ManagedSession): void {
    const text = session.initialPrompt; session.initialPrompt = undefined;
    if (text) this.sendAgentPrompt(id, text);
  }

  resize(id: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    const session = this.sessions.get(id);
    if (!session) return;
    const safeCols = Math.max(20, Math.min(400, Math.floor(cols)));
    const safeRows = Math.max(5, Math.min(200, Math.floor(rows)));
    session.cols = safeCols;
    session.rows = safeRows;
    if (session.awaitingInitialResize) {
      this.launchAwaitingSession(id, session);
      return;
    }
    if (session.metadata.exitCode !== null || !session.process) return;
    const process = session.process;
    tryPtyOperation(() => process.resize(safeCols, safeRows));
  }

  setBounds(id: string, bounds: SessionBounds): void {
    if (!isSessionBounds(bounds)) return;
    const session = this.sessions.get(id);
    if (!session) return;

    session.metadata.position = bounds.position;
    session.metadata.size = {
      width: clamp(bounds.size.width, MIN_TERMINAL_SIZE.width, MAX_TERMINAL_SIZE.width),
      height: clamp(bounds.size.height, MIN_TERMINAL_SIZE.height, MAX_TERMINAL_SIZE.height)
    };
    this.emitSession(session.metadata);
    this.schedulePersistence();
  }

  rename(id: string, title: string): SessionMetadata {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Terminal session does not exist.");
    if (typeof title !== "string") throw new Error("Window title is invalid.");

    const nextTitle = title.trim();
    if (nextTitle.length === 0) throw new Error("Window title cannot be empty.");
    session.metadata.title = nextTitle.slice(0, 80);
    session.metadata.titleCustomized = true;
    this.emitSession(session.metadata);
    this.schedulePersistence();
    return structuredClone(session.metadata);
  }

  applyProviderSignal(id: string, signal: ProviderLifecycleSignal): void {
    const session = this.sessions.get(id);
    if (!this.lifecycleHooksEnabled || !session || session.metadata.status === "done" || session.metadata.status === "failed") return;

    const nextStatus = signal.state;
    if (session.metadata.status === nextStatus) return;
    session.metadata.status = nextStatus;
    this.emitSession(session.metadata);
  }

  setLifecycleHooksEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    if (this.lifecycleHooksEnabled === next) return;
    this.lifecycleHooksEnabled = next;
    if (next) return;
    for (const session of this.sessions.values()) {
      session.lifecycle = null;
      if (
        session.metadata.transport === "acp"
        || session.metadata.provider === "terminal"
        || session.metadata.status === "done"
        || session.metadata.status === "failed"
        || session.metadata.status === "unavailable"
      ) continue;
      session.metadata.status = "unavailable";
      this.emitSession(session.metadata);
    }
  }

  dispose(id: string): void {
    // Remove descendants first so their processes and capabilities cannot
    // outlive the ownership chain. The visited set also bounds corrupt legacy
    // descriptor cycles instead of recursing forever.
    const pending = [id];
    const ordered = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (ordered.has(current)) continue;
      ordered.add(current);
      for (const [childId, child] of this.sessions) {
        if (child.metadata.parentSessionId === current) pending.push(childId);
      }
    }
    for (const sessionId of [...ordered].reverse()) this.disposeSession(sessionId);
  }

  private disposeSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.disposing) return;

    this.flushOutput(id, session);
    session.disposing = true;
    const awaitAcpExit = !!session.acp && session.metadata.exitCode === null;
    if (!awaitAcpExit) this.sessions.delete(id);
    session.launchGeneration++;
    session.initialPrompt = undefined; session.contextLaunch = undefined; session.contextStartupActive = false; session.acp?.dispose();
    if (!awaitAcpExit) this.releaseProviderLaunch(session);
    session.agentBrowser?.cleanup();
    session.agentRuntime?.cleanup();
    session.agentOrchestration?.cleanup();
    if (session.process) {
      try {
        session.process.kill();
      } catch (error) {
        console.warn(`PTY ${id} could not be killed cleanly.`, error);
      }
    }
    this.emit(IPC.terminalRemoved, { id });
    this.schedulePersistence();
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.dispose(id);
    }
  }

  private restorePersistedSession(descriptor: PersistedTerminalSession): void {
    if (this.sessions.has(descriptor.id)) return;
    const metadata: SessionMetadata = {
      id: descriptor.id,
      ...(descriptor.contextDisabled ? { contextDisabled: true } : {}),
      ...(descriptor.disclosureClass ? { disclosureClass: descriptor.disclosureClass } : {}),
      ...(descriptor.contextSummary ? { contextSummary: descriptor.contextSummary } : {}),
      ...(descriptor.transport === "acp" ? { transport: "acp" as const, acpResume: descriptor.acpResume } : {}),
      revision: 0,
      provider: descriptor.provider,
      profile: descriptor.profile,
      title: descriptor.title,
      titleCustomized: descriptor.titleCustomized,
      cwd: descriptor.cwd,
      ...(descriptor.isolation ? { isolation: structuredClone(descriptor.isolation) } : {}),
      ...(descriptor.workspaceId ? { execution: { workspaceId: descriptor.workspaceId, mode: descriptor.isolation?.mode === 'container' ? 'container' : 'worktree', sourceCwd: descriptor.cwd, filesystemRestricted: false, state: "preparing" } as const } : {}),
      position: descriptor.position,
      size: descriptor.size,
      role: descriptor.role ?? "interactive",
      ...(descriptor.parentSessionId !== undefined ? { parentSessionId: descriptor.parentSessionId } : {}),
      ...(descriptor.hostId !== undefined ? { hostId: descriptor.hostId } : {}),
      ...(descriptor.accountId !== undefined ? { accountId: descriptor.accountId } : {}),
      ...(descriptor.model !== undefined ? { model: descriptor.model } : {}),
      ...(descriptor.launchBinding !== undefined ? { launchBinding: descriptor.launchBinding } : {}),
      ...(descriptor.dataClass !== undefined ? { dataClass: descriptor.dataClass } : {}),
      ...(descriptor.role === "subagent" || descriptor.allowSubagents !== undefined ? { allowSubagents: descriptor.allowSubagents ?? false } : {}),
      ...(this.launchPolicy || descriptor.dataClassInherited !== undefined
        ? { dataClassInherited: descriptor.dataClassInherited ?? (descriptor.dataClass === undefined) } : {}),
      status: initialSessionStatus(descriptor.provider),
      startedAt: Date.now(),
      exitCode: null,
      failureDetails: null
    };

    let process: IPty | null = null;
    let agentBrowser: PreparedAgentBrowserPtyLaunch | null = null;
    let agentRuntime: PreparedAgentRuntimePtyLaunch | null = null;
    let agentOrchestration: PreparedOrchestrationPtyLaunch | null = null;
    let directoryReady = true;
    try {
      assertDirectory(descriptor.cwd);
      assertTransport(metadata);
      this.assertDelegationAvailable(metadata);
      if (metadata.transport !== 'acp' && metadata.contextSummary && (metadata.contextSummary.status !== 'empty' || metadata.contextSummary.highestDisclosedClass !== 'D0')) throw new Error('Native context resume cannot verify the previous conversation. Use Restart for an explicit fresh launch.');
      if (metadata.transport === "acp" && !metadata.acpResume) throw new Error("ACP resume unavailable: no saved conversation binding.");
      if (this.launchPolicy && metadata.transport === 'acp' && metadata.contextSummary?.policyModel) this.launchPolicy.check({ ...metadata, model: metadata.contextSummary.policyModel }, this.listMetadata(), descriptor.id);
      if (this.launchPolicy) Object.assign(metadata, this.launchPolicy.check(metadata, this.listMetadata(), descriptor.id));
    } catch (error) {
      directoryReady = false;
      metadata.status = "failed";
      if (metadata.execution) metadata.execution.state = "failed";
      metadata.exitCode = 1;
      metadata.failureDetails = error instanceof Error ? error.message : String(error);
    }
    const awaitMeasuredGrid = directoryReady
      && descriptor.provider === "grok"
      && descriptor.hostId === undefined
      && this.providerClis.get(descriptor.provider).state === "available";

    if (directoryReady && metadata.transport !== "acp" && !awaitMeasuredGrid && !(this.needsPreparedLaunch(descriptor.provider))) {
      try {
        const launched = this.spawnProcess(metadata, INITIAL_TERMINAL_COLS, INITIAL_TERMINAL_ROWS, descriptor.provider !== "terminal");
        process = launched.process;
        agentBrowser = launched.agentBrowser;
        agentRuntime = launched.agentRuntime;
        agentOrchestration = launched.agentOrchestration;
        if (launched.failure) applyLaunchFailure(metadata, launched.failure);
      } catch (error) {
        metadata.status = "failed";
        metadata.exitCode = 1;
        metadata.failureDetails = error instanceof Error ? error.message : String(error);
      }
    }

    const session: ManagedSession = {
      metadata,
      process, acp: null,
      cols: INITIAL_TERMINAL_COLS,
      rows: INITIAL_TERMINAL_ROWS,
      bufferChunks: [],
      bufferStart: 0,
      bufferLength: 0,
      outputOffset: 0,
      pendingOutput: [],
      pendingInput: "",
      outputTimer: null,
      agentBrowser,
      agentRuntime,
      agentOrchestration,
      lifecycle: this.lifecycleHooksEnabled
        ? createProviderLifecycleParser(descriptor.provider, descriptor.cwd)
        : null,
      awaitingInitialResize: awaitMeasuredGrid,
      resumeOnLaunch: awaitMeasuredGrid && descriptor.provider !== "terminal",
      providerLaunch: null, launchGeneration: 0, delegationGeneration: randomUUID(), launchTask: null
    };
    if (directoryReady && metadata.transport === 'acp') {
      try { session.contextLaunch = this.refreshContext(session, true); session.contextStartupActive = true; }
      catch (error) { directoryReady = false; metadata.status = 'failed'; metadata.exitCode = 1; metadata.failureDetails = error instanceof Error ? error.message : String(error); }
    }
    this.sessions.set(descriptor.id, session);
    if (directoryReady && !awaitMeasuredGrid && (metadata.transport === "acp" || this.needsPreparedLaunch(descriptor.provider))) this.startPreparedLaunch(descriptor.id, session, true);
    if (process) this.bindProcess(descriptor.id, session, process);
    const runtimeStatus = this.agentRuntime?.currentStatus(descriptor.id);
    if (runtimeStatus) session.metadata.status = runtimeStatus;
    this.emitSession(metadata);
  }

  private persistSessions(): Promise<void> {
    if (!this.sessionPersistenceEnabled || this.suppressPersistence || !this.sessionStore) {
      return Promise.resolve();
    }
    return this.sessionStore.replace(
      [...this.sessions.values()].filter(session => !session.disposing).map((session) => persistedTerminalSession(session.metadata))
    );
  }

  private schedulePersistence(): void {
    void this.persistSessions().catch((error) => {
      console.warn("CanvasTTY terminal window state could not be saved.", error);
    });
  }

  private emitSession(metadata: SessionMetadata): void {
    metadata.revision += 1;
    this.emit(IPC.terminalSession, { session: structuredClone(metadata) });
  }

  private launchAwaitingSession(id: string, session: ManagedSession): void {
    if (!session.awaitingInitialResize) return;
    session.awaitingInitialResize = false;
    const resumePrevious = session.resumeOnLaunch;
    session.resumeOnLaunch = false;
    if (this.needsPreparedLaunch(session.metadata.provider)) { this.startPreparedLaunch(id, session, resumePrevious); return; }
    try {
      this.assertLaunchCurrent(session);
      const startup = { task: session.initialPrompt, context: session.contextLaunch?.context?.text || undefined }; session.initialPrompt = undefined;
      const launched = this.spawnProcess(session.metadata, session.cols, session.rows, resumePrevious, undefined, startup);
      session.process = launched.process;
      session.agentBrowser = launched.agentBrowser;
      session.agentRuntime = launched.agentRuntime;
      session.agentOrchestration = launched.agentOrchestration;
      if (launched.failure) {
        applyLaunchFailure(session.metadata, launched.failure);
      } else {
        session.metadata.status = initialSessionStatus(session.metadata.provider);
        session.metadata.exitCode = null;
        session.metadata.failureDetails = null;
        if (launched.process) {
          this.bindProcess(id, session, launched.process);
          if (session.pendingInput.length > 0) tryPtyOperation(() => launched.process!.write(session.pendingInput));
        }
        const runtimeStatus = this.agentRuntime?.currentStatus(id);
        if (runtimeStatus) session.metadata.status = runtimeStatus;
      }
    } catch (error) {
      session.process = null;
      session.agentBrowser = null;
      session.agentRuntime = null;
      session.metadata.status = "failed";
      session.metadata.exitCode = 1;
      session.metadata.failureDetails = error instanceof Error ? error.message : String(error);
    }
    session.pendingInput = ""; session.initialPrompt = undefined; session.contextStartupActive = false;
    this.emitSession(session.metadata);
    this.schedulePersistence();
  }

  private markContextDisclosure(metadata: SessionMetadata): void {
    if (!metadata.contextSummary || metadata.contextSummary.status === 'empty') return;
    metadata.contextSummary.status = 'delivered';
    metadata.contextSummary.highestDisclosedClass = maxClass(metadata.contextSummary.highestDisclosedClass, metadata.disclosureClass ?? 'D0');
    this.schedulePersistence();
  }

  private refreshContext(session: ManagedSession, restore = false): OwnedContextLaunch | undefined {
    if (!this.contextEnabled() || !this.contextService || session.metadata.provider === 'terminal' || session.metadata.contextDisabled || session.contextLaunch?.intent?.enabled === false) return;
    const summary = session.metadata.contextSummary;
    const source = session.contextLaunch?.source ?? this.contextSource({ cwd: session.metadata.cwd });
    const intent: ContextLaunchIntent = restore || !session.contextLaunch?.intent
      ? { enabled: true, provider: session.metadata.provider, ...(summary?.taskId ? { taskId: summary.taskId } : {}), ...(summary?.categories ? { categories: summary.categories } : {}) }
      : session.contextLaunch.intent;
    const capture = this.contextService.capture(intent, source);
    if (restore && summary && (capture?.ref.projectId !== summary.projectId || capture?.ref.taskId !== summary.taskId)) throw new Error('Saved context source/task binding changed; start a fresh session.');
    return { source, intent, capture };
  }

  private assertDelegationAvailable(route: Pick<CreateSessionRequest, 'provider' | 'role' | 'allowSubagents' | 'hostId' | 'transport' | 'isolation' | 'containerPlacement'>): void {
    if (!requestsDelegation(route)) return;
    assertDelegationRoute(route);
    if (!this.agentOrchestration?.isEnabled) throw new Error('Delegation gateway is unavailable.');
    const cli = this.providerClis.get(route.provider as Exclude<ProviderId, 'terminal'>);
    if (cli.state !== 'available') throw new Error(`Delegation runtime is unavailable: ${cli.diagnostic}`);
    if (route.transport === 'acp') {
      if (cli.launcher !== 'native' || !this.acpOptions.orchestrationCommand) throw new Error('Delegation requires the local ACP orchestration helper and native runtime.');
      assertOrchestrationHelperAvailable(this.acpOptions.orchestrationCommand);
    } else {
      if (!this.agentBrowser?.assertOrchestrationAvailable) throw new Error('Delegation MCP launch adapter is unavailable.');
      this.agentBrowser.assertOrchestrationAvailable(route.provider as AgentProvider);
    }
  }

  private assertLaunchCurrent(session: ManagedSession): void {
    this.assertDelegationAvailable(session.metadata);
    session.routeGuard?.();
    if (session.contextStartupActive) {
      if (session.contextLaunch?.capture && !this.contextEnabled()) throw new Error('Context delivery was disabled during launch; launch again.');
      session.contextLaunch?.assertAuthority?.(); session.contextLaunch?.capture?.assertCurrent();
    }
    if (this.launchPolicy) {
      const checked = this.launchPolicy.check(session.metadata, this.listMetadata(), session.metadata.id);
      if (checked.accountId !== session.metadata.accountId || checked.model !== session.metadata.model || checked.hostId !== session.metadata.hostId) throw new Error('Selected launch route changed; launch again.');
      Object.assign(session.metadata, checked);
    }
  }

  private startPreparedLaunch(id: string, session: ManagedSession, resumePrevious: boolean): void {
    const coordinator = this.providerLaunch;
    if ((!coordinator && session.metadata.transport !== "acp") || session.launchTask) return;
    const generation = ++session.launchGeneration;
    if (session.metadata.execution) session.metadata.execution.state = "preparing";
    const active = (): boolean => this.sessions.get(id) === session && session.launchGeneration === generation && session.metadata.exitCode === null;
    const operation = async (): Promise<void> => {
      let prepared: PreparedProviderAccountLaunch | null = null;
      try {
        this.assertLaunchCurrent(session);
        if (!coordinator && session.metadata.accountId) throw new Error("ACP selected accounts require launch preparation.");
        const startup = session.metadata.transport === "acp" ? undefined : { task: session.initialPrompt, context: session.contextLaunch?.context?.text || undefined };
        if (session.metadata.transport !== "acp") session.initialPrompt = undefined;
        prepared = coordinator ? await coordinator.prepare(structuredClone(session.metadata), resumePrevious, { isCurrent: active, assertRoute: () => this.assertLaunchCurrent(session), onStartupDisclosure: () => this.markContextDisclosure(session.metadata), startup }) : {
          args: [], environment: {}, unsetEnvironment: [], model: session.metadata.model, acpModel: session.metadata.model,
          skipBridges: true, bindingDigest: createHash("sha256").update(JSON.stringify([session.metadata.provider, session.metadata.cwd, session.metadata.model])).digest("hex"),
          assertCurrent() {}, async cleanup() {}
        };
        if (requestsDelegation(session.metadata) && (prepared.process || session.metadata.transport !== 'acp' && prepared.skipBridges)) throw new Error('Delegation is unavailable for this prepared execution route.');
        prepared.startup = startup;
        if (!active()) { await prepared.cleanup(); return; }
        this.assertLaunchCurrent(session);
        // Live policy cannot authorize stale prepared credentials or endpoint configuration.
        prepared.assertCurrent(session.metadata);
        await prepared.beforeSpawn?.();
        if (!active()) { await prepared.cleanup(); return; }
        this.assertLaunchCurrent(session);
        prepared.assertCurrent(session.metadata);
        session.providerLaunch = prepared;
        if (prepared.execution) session.metadata.execution = structuredClone(prepared.execution);
        session.lifecycle = this.lifecycleHooksEnabled ? createProviderLifecycleParser(session.metadata.provider, prepared.execution?.executionCwd ?? session.metadata.cwd) : null;
        if (prepared.skipBridges) session.metadata.integrationNote = prepared.integrationNote ?? "Custom account home: runtime hooks and browser bridge are unavailable; PTY/process integration only.";
        else delete session.metadata.integrationNote;
        if (session.metadata.transport === "acp") {
          await this.startAcp(id, session, prepared, generation, resumePrevious);
          if (active()) this.deliverInitialPrompt(id, session);
          return;
        }
        this.assertLaunchCurrent(session);
        const launched = this.spawnProcess(session.metadata, session.cols, session.rows, resumePrevious, prepared);
        session.process = launched.process; session.agentBrowser = launched.agentBrowser;
        session.agentRuntime = launched.agentRuntime; session.agentOrchestration = launched.agentOrchestration;
        if (launched.failure) { applyLaunchFailure(session.metadata, launched.failure); if (session.metadata.execution) session.metadata.execution.state = "failed"; this.releaseProviderLaunch(session); }
        else {
          prepared.processStarted?.();
          if (session.metadata.execution) session.metadata.execution.state = "running";
          session.metadata.launchBinding = prepared.bindingDigest;
          session.metadata.status = initialSessionStatus(session.metadata.provider);
          session.metadata.failureDetails = null;
          if (launched.process) {
            this.bindProcess(id, session, launched.process);
            if (session.pendingInput) tryPtyOperation(() => launched.process!.write(session.pendingInput));
          }
          const runtimeStatus = this.agentRuntime?.currentStatus(id);
          if (runtimeStatus) session.metadata.status = runtimeStatus;
        }
      } catch (error) {
        const acpStarted = !!session.acp && session.metadata.transport === "acp";
        if (acpStarted) session.acp!.dispose();
        else if (prepared) await prepared.cleanup().catch(() => undefined);
        if (!active()) return;
        if (!acpStarted) {
          session.providerLaunch = null; session.process = null; session.metadata.exitCode = 1;
          session.agentOrchestration?.cleanup(); session.agentOrchestration = null;
          if (session.metadata.execution) session.metadata.execution.state = "failed";
        }
        session.metadata.status = "failed";
        session.metadata.failureDetails = error instanceof Error ? error.message : "Provider launch preparation failed.";
      } finally {
        if (this.sessions.get(id) === session && session.launchGeneration === generation) {
          session.pendingInput = ""; session.initialPrompt = undefined; session.launchTask = null;
          session.routeGuard = undefined; session.contextStartupActive = false;
          this.emitSession(session.metadata); this.schedulePersistence();
        }
      }
    };
    // Yield once so the reservation and promise exist before preparation starts.
    session.launchTask = Promise.resolve().then(operation);
  }

  private async startAcp(id: string, session: ManagedSession, prepared: PreparedProviderAccountLaunch, generation: number, resume: boolean): Promise<void> {
    const metadata = session.metadata;
    assertTransport(metadata);
    const cli = this.providerClis.get(metadata.provider as Exclude<ProviderId, "terminal">);
    if (cli.state !== "available") throw new Error(cli.diagnostic);
    if (cli.launcher !== "native") throw new Error("ACP requires a resolved native executable.");
    const cwd = prepared.execution?.executionCwd ?? metadata.cwd;
    const binding = createHash("sha256").update(JSON.stringify([metadata.provider, metadata.accountId ?? null, metadata.hostId ?? "local", metadata.cwd, cwd, prepared.bindingDigest])).digest("hex");
    if (resume && (!metadata.acpResume || metadata.acpResume.binding !== binding)) throw new Error("ACP resume unavailable: account, host or workspace binding changed.");
    const environment = terminalEnvironment();
    for (const name of prepared.unsetEnvironment) delete environment[name];
    Object.assign(environment, cli.environment, prepared.environment);
    for (const name of Object.keys(environment)) if (name.startsWith("CANVASTTY_ORCHESTRATION_") || name === "CANVASTTY_TERMINAL_SESSION_ID") delete environment[name];
    const current = (): boolean => this.sessions.get(id) === session && session.launchGeneration === generation;
    const mcpServers: Record<string, unknown>[] = [];
    const helper = this.acpOptions.orchestrationCommand;
    if ((metadata.role === "orchestrator" || metadata.allowSubagents) && helper && this.agentOrchestration?.isEnabled) {
      session.agentOrchestration = this.agentOrchestration.prepareLaunch({ terminalSessionId: id });
      if (session.agentOrchestration) mcpServers.push({ name: "canvastty_agents", command: helper.command, args: helper.args, env: Object.entries({ ...helper.environment, ...session.agentOrchestration.environment }).map(([name, value]) => ({ name, value })) });
    }
    if (requestsDelegation(metadata) && !session.agentOrchestration) throw new Error('Delegation capability could not be prepared for ACP.');
    metadata.integrationNote = "ACP v1, local direct/worktree only. Agent tools run with CLI permissions; no filesystem sandbox. Browser bridge and native subagent inheritance are unavailable. Permissions require an explicit decision, including YOLO.";
    session.lifecycle = null;
    let restoring = resume;
    const checkModel = (value: string | undefined): void => {
      if (!current()) throw new Error("Stale ACP session.");
      prepared.assertCurrent(metadata);
      if (metadata.accountId && !value) throw new Error("ACP account model is unconfirmed.");
      let model = value;
      if (metadata.provider === "minimax" && value) {
        const identity = miniMaxModelIdentity(value);
        if (prepared.acpModel) {
          const expected = miniMaxModelIdentity(prepared.acpModel);
          if (identity.provider !== expected.provider) throw new Error("ACP switched to a different MiniMax provider route.");
          model = prepared.acpPolicyModelKind === "wire" ? value : prepared.acpPolicyModelKind === "qualified" ? `${identity.provider}/${identity.model}` : identity.model;
        } else model = `${identity.provider}/${identity.model}`;
      }
      const checked = this.launchPolicy?.check({ ...metadata, model }, this.listMetadata(), id);
      if (checked && checked.accountId !== metadata.accountId) throw new Error("ACP effective model requires a different account.");
      const actual = session.acp?.snapshot().effectiveModel;
      if (value === actual) {
        if (restoring && metadata.contextSummary?.policyModel && metadata.contextSummary.policyModel !== model) throw new Error('ACP saved context model binding changed.');
        session.confirmedPolicyModel = model;
        if (metadata.contextSummary && model) { metadata.contextSummary.policyModel = model; this.schedulePersistence(); }
      }
    };
    session.acp = new ACPAdapter({ command: cli.executable, args: ["acp"], cwd, environment, provider: metadata.provider,
      expectedModel: resume && metadata.contextSummary?.policyModel
        ? metadata.provider === 'minimax' && prepared.acpPolicyModelKind === 'qualified'
          ? qualifiedMiniMaxValue(metadata.contextSummary.policyModel) : metadata.contextSummary.policyModel
        : prepared.acpModel ?? prepared.model, requireModel: !!metadata.accountId,
      ...(resume ? { restoreId: metadata.acpResume!.sessionId } : {}), mcpServers,
      checkModel,
      onSessionId: sessionId => { if (current()) { metadata.acpResume = { sessionId, binding }; this.schedulePersistence(); } },
      onText: text => { if (current()) { appendScrollback(session, text); this.queueOutput(id, session, text); } },
      onState: state => {
        if (!current()) return;
        metadata.acp = state;
        metadata.status = state.phase === "failed" ? "failed" : state.permissions.length ? "needs_approval" : state.phase === "running" || state.phase === "starting" ? "working" : "idle";
        metadata.failureDetails = state.error ?? null;
        this.emitSession(metadata);
      },
      onExit: async () => {
        if (current()) {
          metadata.exitCode = 1; if (metadata.execution) metadata.execution.state = "retained";
          session.agentOrchestration?.cleanup(); session.agentOrchestration = null;
          this.flushOutput(id, session); this.emitSession(metadata); this.schedulePersistence();
        } else if (this.sessions.get(id) === session && session.disposing) {
          this.sessions.delete(id); this.schedulePersistence();
        }
        await prepared.processExited?.().catch(() => undefined);
        await prepared.cleanup().catch(() => undefined);
      }
    }, this.acpOptions);
    prepared.processStarted?.();
    if (metadata.execution) metadata.execution.state = "running";
    metadata.launchBinding = prepared.bindingDigest;
    await session.acp.ready; restoring = false;
  }

  private releaseProviderLaunch(session: ManagedSession): void {
    const prepared = session.providerLaunch; session.providerLaunch = null;
    if (prepared) void prepared.cleanup().catch(() => { console.warn("CanvasTTY could not remove a temporary provider launch directory."); });
  }

  private spawnProcess(
    metadata: SessionMetadata,
    cols = INITIAL_TERMINAL_COLS,
    rows = INITIAL_TERMINAL_ROWS,
    resumePrevious = false,
    prepared?: PreparedProviderAccountLaunch,
    startup?: AgentStartup
  ): {
    process: IPty | null;
    agentBrowser: PreparedAgentBrowserPtyLaunch | null;
    agentRuntime: PreparedAgentRuntimePtyLaunch | null;
    agentOrchestration: PreparedOrchestrationPtyLaunch | null;
    failure: UnavailableProviderCli | null;
  } {
    this.assertDelegationAvailable(metadata);
    if (requestsDelegation(metadata) && (prepared?.process || metadata.transport !== 'acp' && prepared?.skipBridges)) throw new Error('Delegation is unavailable for this prepared execution route.');
    if (prepared?.process) {
      prepared.assertCurrent(metadata);
      this.markContextDisclosure(metadata);
      const launch = prepared.process;
      return { process: this.spawnPty(launch.command, launch.args, { name: "xterm-256color", cols, rows, cwd: launch.cwd, env: launch.environment }), agentBrowser: null, agentRuntime: null, agentOrchestration: null, failure: null };
    }
    const { id, provider, profile, role: sessionRole, hostId, allowSubagents } = metadata;
    const cwd = hostId === undefined ? prepared?.execution?.executionCwd ?? metadata.cwd : metadata.cwd;
    const model = prepared ? prepared.model : metadata.model;
    // Remote agents use the discovered executable and the same measured
    // model/profile/resume arguments, but cannot use local bridge processes.
    const remoteAgent = provider !== "terminal" && hostId !== undefined;
    const providerCli = provider === "terminal" || remoteAgent
      ? undefined
      : this.providerClis.get(provider);
    if (providerCli?.state === "unavailable") {
      return { process: null, agentBrowser: null, agentRuntime: null, agentOrchestration: null, failure: providerCli };
    }
    let agentRuntime: PreparedAgentRuntimePtyLaunch | null = null;
    let agentOrchestration: PreparedOrchestrationPtyLaunch | null = null;
    let agentBrowser: PreparedAgentBrowserPtyLaunch | null = null;
    try {
      agentRuntime = provider === "terminal" || remoteAgent || prepared?.skipBridges
        ? null : this.agentRuntime?.prepareLaunch({ terminalSessionId: id, provider, cwd }) ?? null;
      agentOrchestration = (sessionRole === "orchestrator" || allowSubagents) && !remoteAgent && !prepared?.skipBridges && this.agentOrchestration?.isEnabled
        ? this.agentOrchestration.prepareLaunch({ terminalSessionId: id }) : null;
      // omp and pi take no browser bridge, exactly like grok: the adapter chain below
      // ends in the Kimi MCP configuration, which would hand them foreign launch flags.
      // cursor stays out too until its CLI grows a measured browser adapter,
      // and minimax until its MCP configuration is wired (plain PTY for now).
      // Devin has no verified browser adapter yet,
      // and antigravity keeps plain PTY integration for the same reason.
      // Remote agents take none either: the bridge helper is a local process
      // the remote CLI could never talk to.
      agentBrowser = prepared?.skipBridges || remoteAgent || provider === "terminal" || provider === "grok" || provider === "omp" || provider === "pi" || provider === "cursor" || provider === "minimax" || provider === "devin" || provider === "antigravity"
        ? null
        : this.agentBrowser?.prepareLaunch({
          terminalSessionId: id,
          provider,
          cwd,
          ...((sessionRole === "orchestrator" || allowSubagents) ? { includeOrchestration: true } : {})
        }) ?? null;
      if (requestsDelegation(metadata) && (!agentOrchestration || !agentBrowser)) throw new Error('Delegation MCP configuration or capability could not be prepared.');
      const baseEnvironment = terminalEnvironment();
      for (const name of prepared?.unsetEnvironment ?? []) delete baseEnvironment[name];
      const browserEnvironment = agentBrowser?.environment ?? {};
      const runtimeEnvironment = agentRuntime?.environment ?? {};
      const orchestrationEnvironment = agentOrchestration?.environment ?? {};
      const bridgeEnvironment = provider === "opencode"
        ? { ...mergeOpenCodeLaunchEnvironment(browserEnvironment, runtimeEnvironment), ...orchestrationEnvironment }
        : { ...browserEnvironment, ...runtimeEnvironment, ...orchestrationEnvironment };
      const providerEnvironment = provider === "opencode"
        ? mergeOpenCodeLaunchEnvironment(bridgeEnvironment, prepared?.environment ?? {})
        : { ...bridgeEnvironment, ...prepared?.environment };
      const providerArgs = [...(agentRuntime?.args ?? []), ...(agentBrowser?.args ?? []), ...(prepared?.args ?? [])];
      // A session bound to a remote host swaps its local launch for an
      // interactive ssh session spawned through the same PTY with the same
      // TERM/COLORTERM environment: a terminal session runs the remote shell,
      // an agent session runs its provider CLI (by name, from the provider
      // definitions) inside the host's mapped workspace. Everything below
      // resolves the host and workspace mapping here too, so restore paths
      // that bypass create()'s pre-checks still fail loudly per session.
      const remoteHost = hostId !== undefined ? this.requireRemoteHost(hostId) : null;
      let launch: TerminalLaunch;
      if (remoteHost && provider !== "terminal") {
        const command = prepared?.remoteExecutable ?? PROVIDER_CLI_DEFINITIONS[provider].commands[0];
        const remoteArguments = resolveTerminalLaunch(provider, profile, providerArgs, {
          providerCli: { state: "available", provider, executable: command, launcher: "native", environment: {}, checked: [] },
          environment: providerEnvironment, model, resumePrevious, startup: startup ?? prepared?.startup
        });
        launch = remoteAgentLaunch(remoteHost, this.requireRemoteWorkspace(remoteHost, cwd), command, {
          args: remoteArguments.args as string[], environment: { ...providerEnvironment, ...remoteArguments.environment },
          unsetEnvironment: prepared?.unsetEnvironment, absoluteExecutable: !!prepared, accountHome: prepared?.remoteAccountHome
        });
      } else if (remoteHost) {
        launch = remoteTerminalLaunch(remoteHost, baseEnvironment);
      } else {
        launch = resolveTerminalLaunch(provider, profile, providerArgs, {
          environment: { ...baseEnvironment, ...providerEnvironment },
          ...(providerCli ? { providerCli } : {}),
          resumePrevious, model, startup: startup ?? prepared?.startup
        });
      }
      prepared?.assertCurrent(metadata);
      this.markContextDisclosure(metadata);
      return {
        process: this.spawnPty(launch.command, launch.args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env: { ...baseEnvironment, ...providerEnvironment, ...launch.environment }
        }),
        agentBrowser,
        agentRuntime,
        agentOrchestration,
        failure: null
      };
    } catch (error) {
      agentBrowser?.cleanup();
      agentRuntime?.cleanup();
      agentOrchestration?.cleanup();
      throw error;
    }
  }

  // Resolves a session's remote host or throws. Called from create() before
  // anything spawns (failing the create loudly) and from spawnProcess when
  // composing an ssh launch; restore catches the throw per session instead.
  private requireRemoteHost(hostId: string): RemoteHost {
    const host = this.resolveRemoteHost ? this.resolveRemoteHost(hostId) : null;
    if (!host) throw new Error(`Remote host ${hostId} is not configured.`);
    return host;
  }

  // The remote counterpart of a local project folder, or a throw: an agent
  // launch can only cd into a workspace the host maps, so an unmapped folder
  // names itself and the host in the error. Same call sites and failure
  // surfaces as requireRemoteHost.
  private requireRemoteWorkspace(host: RemoteHost, localWorkspace: string): string {
    const remoteWorkspace = remotePathForHost(host, localWorkspace);
    if (remoteWorkspace === null) {
      throw new Error(`Workspace ${localWorkspace} is not mapped on host ${host.id}.`);
    }
    return remoteWorkspace;
  }

  private bindProcess(id: string, session: ManagedSession, process: IPty): void {
    const preparedLaunch = session.providerLaunch;
    process.onData((data) => {
      const current = this.sessions.get(id);
      if (!current || current !== session || current.process !== process) return;

      const lifecycleState = current.lifecycle?.push(data);
      if (lifecycleState) this.applyProviderSignal(id, { kind: "lifecycle", state: lifecycleState });
      appendScrollback(current, data);
      this.queueOutput(id, current, data);
    });

    process.onExit(({ exitCode }) => {
      void preparedLaunch?.processExited?.().catch(() => { console.warn("CanvasTTY could not persist workspace process exit."); });
      const current = this.sessions.get(id);
      if (!current || current !== session || current.process !== process) return;

      this.flushOutput(id, current);
      current.metadata.exitCode = exitCode;
      if (current.metadata.execution) current.metadata.execution.state = "retained";
      current.metadata.status = exitCode === 0 ? "done" : "failed";
      current.metadata.failureDetails = exitCode === 0
        ? null
        : terminalFailureDetails(current.bufferChunks.slice(current.bufferStart).join(""));
      this.releaseProviderLaunch(current);
      current.agentBrowser?.cleanup();
      current.agentBrowser = null;
      current.agentRuntime?.cleanup();
      current.agentRuntime = null;
      current.agentOrchestration?.cleanup();
      current.agentOrchestration = null;
      this.emitSession(current.metadata);
    });
  }

  private queueOutput(id: string, session: ManagedSession, data: string): void {
    session.pendingOutput.push(data);
    if (session.outputTimer !== null) return;
    // Keep a TUI's clear-and-redraw sequence in one renderer update whenever possible.
    session.outputTimer = setTimeout(() => this.flushOutput(id, session), OUTPUT_BATCH_MS);
  }

  private flushOutput(id: string, session: ManagedSession): void {
    if (session.outputTimer !== null) {
      clearTimeout(session.outputTimer);
      session.outputTimer = null;
    }
    if (session.pendingOutput.length === 0) return;

    const data = session.pendingOutput.join("");
    session.pendingOutput.length = 0;
    this.emit(IPC.terminalData, { id, data, outputOffset: session.outputOffset });
  }
}

function applyLaunchFailure(metadata: SessionMetadata, failure: UnavailableProviderCli): void {
  metadata.status = "failed";
  metadata.exitCode = 127;
  metadata.failureDetails = failure.diagnostic;
}

export function terminalEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const reserved = new Set<string>([
    ...Object.values(ORCHESTRATION_ENV),
    ...Object.values(AGENT_BROWSER_ENV),
    ...Object.values(AGENT_RUNTIME_ENV)
  ]);
  const environment = Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string"
      && !reserved.has(entry[0])
      && !entry[0].startsWith("CANVASTTY_PLUGIN_HOOK_")
      && entry[0] !== "CANVASTTY_LIFECYCLE_HOOKS_ENABLED"
      && entry[0] !== "ELECTRON_RUN_AS_NODE"
    ))
  );
  return { ...environment, TERM: "xterm-256color", COLORTERM: "truecolor" };
}

function defaultTitle(provider: ProviderId, cwd: string): string {
  const project = basename(cwd) || cwd;
  if (provider === "terminal") return `Terminal · ${project}`;
  if (provider === "opencode") return `${project} · OpenCode`;
  if (provider === "hermes") return `${project} · Hermes`;
  if (provider === "qwen") return `${project} · Qwen Code`;
  if (provider === "grok") return `${project} · Grok Build`;
  if (provider === "omp") return `${project} · OMP`;
  if (provider === "pi") return `${project} · Pi`;
  return `${project} · ${provider[0].toUpperCase()}${provider.slice(1)}`;
}

function assertDirectory(cwd: string): void {
  try {
    if (!statSync(cwd).isDirectory()) throw new Error("Not a directory");
  } catch {
    throw new Error(`Project folder does not exist: ${cwd}`);
  }
}

const SESSION_PROVIDERS = new Set<ProviderId>(CANVAS_LAUNCHER_ITEMS);
const SESSION_ROLES = new Set<SessionRole>(["interactive", "orchestrator", "subagent"]);

function assertCreateRequest(request: CreateSessionRequest): void {
  if (request?.context !== undefined) assertContextLaunchSelection(request.context);
  if (request?.parentSessionId !== undefined && request.context !== undefined) throw new Error('Child context selection is inherited from its owner.');
  if (request && ['contextDisabled', 'contextSummary', 'disclosureClass', 'dataClassInherited', 'contextDigest', 'sourceCwd', 'projectId', 'historyClass', 'ownerGeneration', 'contextText'].some(key => key in request)) throw new Error('Context authority is owned by the main process.');
  if (request) { assertLaunchPolicyFields(request); assertIsolationRequest(request.isolation);
    if ("execution" in request || "workspaceId" in request || "launchBinding" in request || "acpResume" in request || "acp" in request) throw new Error("Execution identity is owned by the main process.");
  }
  if (request?.initialPrompt !== undefined && (typeof request.initialPrompt !== "string" || request.initialPrompt.length >= MAX_PENDING_INPUT_CHARS)) throw new Error("Initial agent prompt exceeds the input limit or is invalid.");
  if (request?.transport === "acp" && request.initialPrompt) assertAcpPrompt(request.initialPrompt);
  if (!request || !SESSION_PROVIDERS.has(request.provider)) throw new Error("Unknown terminal provider.");
  if (request.profile !== "normal" && request.profile !== "yolo") throw new Error("Unknown launch profile.");
  if (typeof request.cwd !== "string" || request.cwd.length === 0) throw new Error("Project folder is required.");
  if (!isPoint(request.position)) throw new Error("Session position is invalid.");
  const role = request.role ?? "interactive";
  if (!SESSION_ROLES.has(role)) throw new Error("Unknown session role.");
  if (role === "subagent" && typeof request.parentSessionId !== "string") {
    throw new Error("A subagent session requires a parent session.");
  }
  if (request.parentSessionId !== undefined && typeof request.parentSessionId !== "string") {
    throw new Error("Session parent id must be a string.");
  }
  if (request.hostId !== undefined && typeof request.hostId !== "string") {
    throw new Error("Session host id must be a string.");
  }
  if (request.accountId !== undefined && typeof request.accountId !== "string") {
    throw new Error("Session account id must be a string.");
  }
}

function isPoint(value: unknown): value is Point {
  return Boolean(
    value
    && typeof value === "object"
    && "x" in value
    && "y" in value
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
  );
}

function isSessionBounds(value: unknown): value is SessionBounds {
  if (!value || typeof value !== "object" || !("position" in value) || !("size" in value)) return false;
  const size = value.size;
  return isPoint(value.position)
    && Boolean(
      size
      && typeof size === "object"
      && "width" in size
      && "height" in size
      && Number.isFinite(size.width)
      && Number.isFinite(size.height)
    );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function snapshot(session: ManagedSession): SessionSnapshot {
  return {
    ...structuredClone(session.metadata),
    buffer: session.bufferChunks.slice(session.bufferStart).join("")
  };
}

function appendScrollback(session: ManagedSession, data: string): void {
  session.outputOffset += data.length;
  session.bufferChunks.push(data);
  session.bufferLength += data.length;

  while (session.bufferLength > MAX_SCROLLBACK_CHARS) {
    const first = session.bufferChunks[session.bufferStart];
    if (first === undefined) {
      session.bufferChunks.length = 0;
      session.bufferStart = 0;
      session.bufferLength = 0;
      return;
    }
    const overflow = session.bufferLength - MAX_SCROLLBACK_CHARS;
    if (first.length <= overflow) {
      session.bufferStart += 1;
      session.bufferLength -= first.length;
      continue;
    }
    session.bufferChunks[session.bufferStart] = first.slice(overflow);
    session.bufferLength -= overflow;
  }

  if (session.bufferStart > 256 && session.bufferStart * 2 >= session.bufferChunks.length) {
    session.bufferChunks = session.bufferChunks.slice(session.bufferStart);
    session.bufferStart = 0;
  }
}

function assertTransport(request: Pick<CreateSessionRequest, "provider" | "transport" | "hostId" | "isolation">): void {
  if (request.transport !== undefined && request.transport !== "pty" && request.transport !== "acp") throw new Error("Unknown session transport.");
  if (request.transport !== "acp") return;
  if (!ACP_PROVIDERS.includes(request.provider)) throw new Error("ACP is supported only for Cursor, MiniMax and Kimi.");
  if (request.hostId !== undefined || request.isolation?.mode === "container") throw new Error("ACP supports local direct/worktree launches only; remote and container transports are unavailable.");
}


function qualifiedMiniMaxValue(value: string): string { const split = value.indexOf('/'); if (split < 1) throw new Error('Invalid saved MiniMax model identity.'); return miniMaxModelValue(value.slice(0, split), value.slice(split + 1)); }
