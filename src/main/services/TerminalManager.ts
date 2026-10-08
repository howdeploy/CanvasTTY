import { ReviewDiffTracker } from "./ReviewDiffTracker.ts";
import { GitCheckpoints } from "./GitCheckpoints.ts";
import { constants as osConstants } from "node:os";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isPathInside } from "../../agent-runtime/path-inside.mjs";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type {
  CreateSessionRequest,
  GitRiskReport,
  Point,
  ProviderId,
  SessionBounds,
  SessionEnvironmentChoice,
  SessionRole,
  SessionEvent,
  SessionMetadata,
  SessionRemovedEvent,
  SessionRestoreMode,
  SessionSnapshot,
  ShortcutBindings,
  TerminalBufferSnapshot,
  TerminalDataEvent
} from "../../shared/contracts.ts";
import {
  CANVAS_LAUNCHER_ITEMS,
  INITIAL_TERMINAL_COLS,
  INITIAL_TERMINAL_ROWS,
  IPC
} from "../../shared/contracts.ts";
import { DEFAULT_SHORTCUTS } from "../../shared/contracts.ts";
import type {
  AgentBrowserLaunchCoordinator,
  PreparedAgentBrowserPtyLaunch
} from "./agent-browser/AgentBrowserBridge.ts";
import { AGENT_BROWSER_ENV } from "./agent-browser/AgentBrowserBridge.ts";
import { ORCHESTRATION_TOOL_NAMES } from "../../agent-browser/orchestration-catalog.mjs";
import type { OrchestrationLaunchCoordinator, PreparedOrchestrationPtyLaunch } from "./agent-browser/OrchestrationBridge.ts";
import type {
  AgentRuntimeLaunchCoordinator,
  PreparedAgentRuntimePtyLaunch
} from "./agent-runtime/AgentRuntimeBridge.ts";
import {
  AGENT_RUNTIME_ENV,
  CAPTURE_ANSWER_ENV,
  CAPTURE_ANSWER_EXPIRES_AT_ENV,
  CAPTURE_RESULT_ENV,
  normalizeThreadId
} from "../../agent-runtime/runtime-protocol.mjs";
import {
  CONTROL_CLI_ENV,
  CONTROL_CONNECTION_ENV,
  controlEnvironment,
  type ControlConnection
} from "./agent-control/controlCapabilities.ts";
import { codexTrustArguments, mergeOpenCodeLaunchEnvironment } from "./agent-runtime/ProviderRuntimeLaunch.ts";
import { openCodeProjectFolderEnvironment } from "./openCodeConfig.ts";
import { onDiskPath } from "./onDiskPath.ts";
import { RESULT_CAPTURE_PROVIDERS } from "./resultCapture.ts";
import { launchEffortProblem, launchModelProblem, type ReasoningEffort } from "../../shared/launchModel.ts";
import { SecretRedactionRegistry } from "./safety/SecretRedaction.ts";
import type { DecisionSession } from "./DecisionHooks.ts";
import { tryPtyOperation } from "./ptySafety.ts";
import { terminalFailureDetails } from "./terminalFailureDetails.ts";
import { canResumeThreadById, resolveTerminalLaunch } from "./terminalLaunch.ts";
import { isLaunchProfile, PROFILE_RANK, profileAvailable, profileCeiling, type LaunchProfile } from "../../shared/autoMode.ts";
import type { AgentIsolation, IsolationDecision } from "./isolation/AgentIsolation.ts";
import { controlGrantFolder } from "./isolation/AgentIsolation.ts";
import { auditRepositories, neutralizeRepositories, type GitRiskRepository } from "./isolation/gitAudit.ts";
import { LaunchRefusal } from "./launchRefusal.ts";
import { configuredMode } from "./configuredMode.ts";
import { envKey, RESERVED_ENV, type LaunchPipeline, type PreparedLaunch } from "./LaunchPipeline.ts";
import { ACCOUNTS_PLUGIN_ID, selectedAccountId } from "./accountHomeIsolation.ts";
import type { EnvironmentRegistry } from "./EnvironmentRegistry.ts";
import {
  persistedTerminalSession,
  type PersistedEnvironmentRef,
  type PersistedSessionExtras,
  type PersistedTerminalSession,
  type TerminalSessionStore
} from "./TerminalSessionStore.ts";
import { chooseResume, planSessionRestore, restorableRecords, type ResumeRequest, type RestoreStep } from "./sessionRestorePlan.ts";
import type { ProviderCliRegistry, UnavailableProviderCli } from "./providerCliRegistry.ts";
import {
  createProviderLifecycleParser,
  initialSessionStatus,
  type ProviderLifecycleParser
} from "./providerLifecycle.ts";
import { ProcessTreePause, type ProcessTreePauseResult } from "./ProcessTreePause.ts";
import { isHostOwnedDiffOnlyReviewWorkspace, type DiffOnlyReviewWorkspace } from "./DiffOnlyReviewWorkspace.ts";

const MAX_SCROLLBACK_CHARS = 240_000;
const OUTPUT_BATCH_MS = 16;
/**
 * A flood of PTY output (e.g. `cat` on a huge file) can emit many `data` events before the batch timer's
 * callback runs, since each event only needs the event loop, not the timer's turn. Without a cap, pendingOutput
 * grows unbounded for that whole burst. Once a session's queued output crosses this many UTF-16 code units, it
 * is flushed immediately instead of waiting for the timer.
 */
const MAX_PENDING_OUTPUT_CHARS = 1_048_576;
/** How long repeated setBounds/rename/etc. calls are coalesced before the session store is rewritten once. */
const PERSISTENCE_DEBOUNCE_MS = 150;
const DEFAULT_TERMINAL_SIZE = { width: 700, height: 430 };
const MIN_TERMINAL_SIZE = { width: 420, height: 260 };
const MAX_TERMINAL_SIZE = { width: 1_600, height: 1_100 };

interface ManagedSession {
  accountId?:string;
  accountHome?:string;
  metadata: SessionMetadata;
  process: IPty | null;
  cols: number;
  rows: number;
  bufferChunks: string[];
  bufferStart: number;
  bufferLength: number;
  outputOffset: number;
  pendingOutput: string[];
  pendingOutputChars: number;
  agentBrowser: PreparedAgentBrowserPtyLaunch | null;
  agentRuntime: PreparedAgentRuntimePtyLaunch | null;
  agentOrchestration: PreparedOrchestrationPtyLaunch | null;
  lifecycle: ProviderLifecycleParser | null;
  awaitingInitialResize: boolean;
  resumeOnLaunch: ResumeRequest;
  /** The provider's own conversation id, once its hook reported it (or from the saved record). */
  threadId?: string;
  captureResult: boolean;
  captureReviewDiff?: boolean;
  inputBracketedPaste?: boolean;
  /** Turns the agent started (its status became working) since launch. */
  turnStarts?: number;
  /** turnStarts when the last submitted prompt was delivered; undefined while none was. */
  promptTurnMark?: number;
  /** Last accepted lifecycle state, also maintained when lifecycle UI updates are disabled. */
  acceptedLifecycleState?: ProviderLifecycleSignal["state"];
  inputGeneration?: number;
  answerTurnGeneration?: number;
  providerTurnId?: string;
  providerTurnGenerations?: Map<string, number>;
  /** The last turn's final answer its hook or plugin reported (captureResult only); cleared when a turn starts. */
  answer?: { text: string; truncated: boolean; at: number };
  /**
   * Plugin options, environment ref (or, until the plugin has prepared it, the launcher's environment choice)
   * and owning plugin carried into the saved record.
   */
  extras: PersistedSessionExtras;
  /** Bumped per launch attempt, so a late plugin answer never starts a superseded launch. */
  launchToken: number;
  /** Removes the current run's plugin files; called when the process exits. */
  launchCleanup: (() => Promise<void>) | null;
  /** Cleanup already started by an earlier exit; closing the card must drain it before deleting its parent. */
  launchCleanupPending?: Promise<void>;
  /** Whole contributed launches, including asynchronous preparation/wrapping and abandoned-run cleanup. */
  launchTasks?: Set<Promise<unknown>>;
  /** The pipelines that created this card's run folders, retained across host reconfiguration/restart. */
  launchFilePipelines?: Set<Pick<LaunchPipeline, "forgetSession">>;
  /** A restored grok card waits for its grid before launching; plugins still learn it is a restore. */
  restoringLaunch: boolean;
  /** The environment was prepared or resumed in this run of the app, so it can be wrapped now. */
  environmentReady: boolean;
  /** Bumped by every launch the person or the app asks for (create, restart, restore); input waits for one. */
  launchEpoch: number;
  /** Initial measured-grid launch was requested while its task budget was paused. */
  budgetDeferredLaunch?: boolean;
  /** Input waiting for this launch to start (deliverInput): woken whenever the launch moves on. */
  launchWaiters: Set<() => void>;
  inputQueue?: Promise<InputDelivery>;
  cliInputReady?: boolean;
  readinessOutput?: string;
  /** Brought back from the saved sessions at startup (plugins see a "restored" event, not "created"). */
  restored?: boolean;
  /** What the CLI's own title last showed (Claude: spinner working, «✳» no turn running). */
  titleState?: "idle" | "working" | "needs_approval";
  /** How often the agent's lifecycle hooks reported; Claude's title defers to hooks once they have. */
  hookSignals?: number;
  /** Set after the person answered a hooked Claude prompt; see settleAnsweredPrompt. */
  answeredPromptTimer?: ReturnType<typeof setTimeout>;
  /** Removed when a transient diff-only review PTY exits or its card is disposed. */
  reviewWorkspace?: DiffOnlyReviewWorkspace;
}

interface ReadOnlyReviewerLaunch {
  taskRootSessionId: string;
  workspace: DiffOnlyReviewWorkspace;
  deniedReadPaths: string[];
  /** A worker's model account, prepared for this reviewer before its card exists (prepareReviewerAccount). */
  account?: { id: string; contribution: LaunchContribution };
}

type EnvironmentService = Pick<EnvironmentRegistry,
  "available" | "unavailableReason" | "normalizeChoice" | "prepare" | "resume" | "wrap" | "release" | "describe">
  & Partial<Pick<EnvironmentRegistry, "keeps">>;
type LaunchOutcome = "launched" | "failed" | "superseded";
/** Why a launch did not start: the CLI is missing, or a launch rule refused it. */
interface LaunchFailure { diagnostic: string; exitCode?: number }
/**
 * Who asked for a card: the person (launcher, restore), a person-owned automation through the control endpoint, a
 * plugin service, or an orchestrator (a subagent). Only the person may start YOLO without a prior acknowledgement,
 * and never for a subagent.
 */
export type LaunchOrigin = "person" | "control" | "plugin" | "subagent";

interface PlannedSpawn {
  command: string;
  args: string[] | string;
  cwd: string;
  /** The full environment the PTY gets. */
  env: Record<string, string>;
  /** What CanvasTTY and launch contributors set for this launch (without the person's own environment). */
  launchEnvironment: Record<string, string>;
  agentBrowser: PreparedAgentBrowserPtyLaunch | null;
  agentRuntime: PreparedAgentRuntimePtyLaunch | null;
  agentOrchestration: PreparedOrchestrationPtyLaunch | null;
  cleanup(): void;
}
/** Quitting with saving off asks environments to stop compute, but never waits longer than this. */
const QUIT_RELEASE_TIMEOUT_MS = 3_000;
/**
 * Quitting waits this long for the PTYs it hung up to exit, then kills the rest and waits `PTY_KILL_WAIT_MS` more.
 * node-pty reports an exit through a native callback into JavaScript; one that arrives while Electron tears the
 * Node environment down cannot run there, and node-pty turns that into a C++ exception that aborts the app.
 */
export const PTY_EXIT_WAIT_MS = 2_000;
export const PTY_KILL_WAIT_MS = 1_000;
/** Longer than every plugin step of a launch together (prepare, resume, launch options, wrap). */
export const LAUNCH_INPUT_WAIT_MS = 60_000;

/** What happened to input handed to deliverInput. */
export type InputDelivery = { delivered: true } | { delivered: false; reason: string };

type LaunchContribution = Extract<PreparedLaunch, { ok: true }>;

export interface ProviderLifecycleSignal {
  kind: "lifecycle";
  state: "idle" | "working" | "needs_approval";
  event?: string;
  requestId?: string;
  threadId?: string;
}

/**
 * Why a snapshot reports a failing status, when that reason is not an ordinary
 * transition into failure: "restore" re-derived a persisted session's status
 * at launch, "user" is the outcome of a launch the user asked for in the UI.
 */
export type FailureOrigin = "restore" | "user";

type Emit = (
  channel: typeof IPC.terminalData | typeof IPC.terminalSession | typeof IPC.terminalRemoved | typeof IPC.terminalGitRisk,
  payload: TerminalDataEvent | SessionEvent | SessionRemovedEvent | GitRiskReport
) => void;

export class TerminalManager {
  private keyboardShortcuts: ShortcutBindings = { ...DEFAULT_SHORTCUTS };
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly emit: Emit;
  private readonly providerClis: ProviderCliRegistry;
  private readonly agentBrowser?: AgentBrowserLaunchCoordinator;
  private readonly agentRuntime?: AgentRuntimeLaunchCoordinator;
  private readonly inputWriteObservers = new Map<string, Set<(data: string, submitted: boolean) => (() => void) | void>>();
  private readonly reviewDiffTracker = new ReviewDiffTracker();
  private readonly spawnPty: typeof pty.spawn;
  private readonly processTreePause: ProcessTreePause;
  private readonly checkpointUnavailableGenerations=new Map<string,number>();
  private checkpointRestore: {cwd:string;ids:Set<string>;processes:Map<IPty,{session:ManagedSession;wasPaused:boolean}>;deferredResume:Set<IPty>;closes:Map<string,{keepEnvironmentData?:boolean}>;done:Promise<void>} | null=null;
  private readonly budgetPausedTaskRoots = new Set<string>();
  private readonly budgetResumeWaiters = new Map<string, Set<() => void>>();
  /**
   * The conversation each card's latest launch resumed: its id, or null until the provider reports which one a
   * "resume latest" launch picked. Usage counted before the resume belongs to earlier runs, not to this card.
   */
  private readonly resumedThreads = new Map<string, string | null>();
  // Renderer-reported card visibility, keyed by session and holding the
  // outputOffset at the moment it was hidden: the last offset the card saw.
  // Output keeps flowing through emit while hidden, addressed to the observers
  // only (see flushOutput), so the batch queue never holds renderer output.
  private readonly hiddenSinceOffset = new Map<string, number>();
  // Sessions with output waiting for the next batch, flushed together by one
  // timer: every session's batch leaves in the same task, so the renderer
  // transport can send them as one message (main/index.ts).
  private readonly queuedOutput = new Map<string, ManagedSession>();
  private outputTimer: ReturnType<typeof setTimeout> | null = null;
  private lifecycleHooksEnabled: boolean;
  private agentOrchestration: OrchestrationLaunchCoordinator | null = null;
  // Plugin tools a session of this role and agent gets in canvastty_agents (EP-6), read at launch.
  private pluginToolNames: (role: SessionRole, provider: ProviderId) => string[] = () => [];
  private launchPipeline: (Pick<LaunchPipeline, "normalizeOptions" | "unavailable" | "prepare" | "forgetSession"> & Partial<Pick<LaunchPipeline, "hasPolicy">>) | null = null;
  private sessionStore: TerminalSessionStore | null = null;
  private sessionRestoreMode: SessionRestoreMode = "off";
  // Without the registry a placed session can only come back stopped: it never runs locally.
  private environments: EnvironmentService | null = null;
  // Every text an agent reads from another card passes through it (EP-8).
  private redaction = new SecretRedactionRegistry();
  // Where each running card was actually started (an environment may move it) and its agent config folder.
  private readonly launchContexts = new Map<string, { cwd: string; configDir: string | null }>();
  private modelCheck: (provider: ProviderId, model: string) => string | null = () => null;
  // Whether base protection is on (Settings → Agents); OpenCode's auto profile lets shell commands run without asking
  // only then. Unknown counts as off.
  private baseProtectionOn: () => boolean = () => false;
  // The model and effort of a card whose first launch runs before the card is registered (create, restore).
  private readonly startingModels = new Map<string, LaunchModelChoice>();
  private quitting = false;
  private readonly quitReleases: Promise<void>[] = [];
  // Every PTY started here whose exit has not been reported yet, closed cards included, with that exit.
  private readonly liveProcesses = new Map<IPty, Promise<void>>();
  private suppressPersistence = false;
  // Coalesces rapid persistence requests (a drag fires setBounds many times a second) into one
  // normalize+stringify+atomic-write of the session store instead of one per call.
  private persistenceTimer: ReturnType<typeof setTimeout> | null = null;
  // The live agent-control descriptor, handed only to orchestrator-role sessions
  // spawned while it is set; null while the endpoint is off.
  private controlConnection: ControlConnection | null = null;
  // The operating-system isolation layer (null: none configured, e.g. in unit tests).
  private isolation: Pick<AgentIsolation, "decide" | "wrap" | "containment"> | null = null;
  // Removes a launch's isolation folder (profile, TMPDIR) once its process ended or the card closed.
  private readonly isolationCleanups = new Map<string, () => void>();
  /** Open git risk reports by id: the card it belongs to (none once closed) and what neutralize removes. */
  private readonly gitRisks = new Map<string, { sessionId: string | null; repositories: GitRiskRepository[] }>();
  /** When isolated launches started whose card did not exist yet (see wrapIsolated). */
  private readonly isolationStarts = new Map<string, number>();
  /** Host-owned platform restriction found while wrapping a launch, before its card may exist. */
  private readonly pendingIsolationReasons = new Map<string, string>();
  // Plugin owners of cards being created (before the card exists), so their first launch counts as delegated.
  private readonly startingOwners = new Map<string, string>();
  /** Reviewer-only launch authority is keyed by the exact host-created request object. */
  private readonly readOnlyReviewerRequests = new WeakMap<CreateSessionRequest, ReadOnlyReviewerLaunch>();
  // What a card's first launch found in its CLI's own configuration, before the card exists.
  private readonly pendingConfiguredModes = new Map<string, { mode: string; source: string }>();
  // Whether the person acknowledged YOLO for a CLI (Settings: acknowledgedDangerousProfiles); unset allows it.
  private yoloAcknowledged: (provider: ProviderId) => boolean = () => true;
  // Set and cleared around a single synchronous session emit (see emitSession):
  // the main process reads it from its emit callback to tell a failure that is
  // merely re-derived state from one the user just caused.
  private emittingFailureOrigin: FailureOrigin | null = null;
  private inputGate: ((id:string)=>void) | null = null;

  constructor(
    emit: Emit,
    providerClis: ProviderCliRegistry,
    agentBrowser?: AgentBrowserLaunchCoordinator,
    agentRuntime?: AgentRuntimeLaunchCoordinator,
    lifecycleHooksEnabled = true,
    spawnPty: typeof pty.spawn = pty.spawn,
    processTreePause = new ProcessTreePause()
  ) {
    this.emit = emit;
    this.providerClis = providerClis;
    this.agentBrowser = agentBrowser;
    this.agentRuntime = agentRuntime;
    this.spawnPty = spawnPty;
    this.processTreePause = processTreePause;
    this.lifecycleHooksEnabled = lifecycleHooksEnabled;
  }

  /** The operating-system isolation layer around delegated and non-manual agents (isolation/AgentIsolation.ts). */
  configureIsolation(isolation: Pick<AgentIsolation, "decide" | "wrap" | "containment"> | null): void {
    this.isolation = isolation;
  }

  /** The layer can contain an agent here now (what a "contained" auto needs). */
  containment(): boolean {
    try { return this.isolation?.containment() === true; } catch { return false; }
  }

  /** Whether the person acknowledged YOLO for a CLI; read at every YOLO launch that is not the person's own click. */
  configureYoloAcknowledgement(acknowledged: (provider: ProviderId) => boolean): void {
    this.yoloAcknowledged = (provider) => { try { return acknowledged(provider) === true; } catch { return false; } };
  }

  configureOrchestration(coordinator: OrchestrationLaunchCoordinator | null): void {
    this.agentOrchestration = coordinator;
  }

  setKeyboardShortcuts(shortcuts: ShortcutBindings): void {
    this.keyboardShortcuts = { ...shortcuts };
  }

  /** Plugin agent tools: a session any of them applies to gets the canvastty_agents bridge. */
  configureAgentTools(names: ((role: SessionRole, provider: ProviderId) => string[]) | null): void {
    this.pluginToolNames = names ?? (() => []);
  }

  /** Plugin launch contributors; without them a session with launch options is never launched. */
  configureLaunchPipeline(pipeline: (Pick<LaunchPipeline, "normalizeOptions" | "unavailable" | "prepare" | "forgetSession"> & Partial<Pick<LaunchPipeline, "hasPolicy">>) | null): void {
    this.launchPipeline = pipeline;
  }

  /** Plugin session environments; without them a placed session is never launched. */
  configureEnvironments(registry: EnvironmentService | null): void {
    this.environments = registry;
  }

  /** The app-wide redaction registry (vault keys, plugin secrets); cards add their launch secrets to it. */
  configureRedaction(registry: SecretRedactionRegistry): void {
    this.redaction = registry;
  }
  configureInputGate(gate: ((id:string)=>void) | null): void {this.inputGate=gate;}

  /** Host-only observer at the guarded PTY boundary; the returned callback runs only after a successful write. */
  observeInputWrites(id: string, observer: (data: string, submitted: boolean) => (() => void) | void): () => void {
    if (!this.sessions.has(id)) throw new Error("Terminal session does not exist.");
    let observers = this.inputWriteObservers.get(id);
    if (!observers) { observers = new Set(); this.inputWriteObservers.set(id, observers); }
    observers.add(observer);
    return () => {
      observers.delete(observer);
      if (observers.size === 0 && this.inputWriteObservers.get(id) === observers) this.inputWriteObservers.delete(id);
    };
  }

  /**
   * Host-only entry point for an automatic reviewer. Its launch authority is tied to an unforgeable temporary
   * workspace object and never becomes a field on the renderer/control request schema.
   */
  /**
   * Prepares the worker's model account (only the Accounts plugin's delegable options) for a diff-only reviewer, so
   * the reviewer runs on the same key and model when the agent has no sign-in of its own. The reviewer still gets no
   * agent or plugin tools; only the account's environment, arguments and run files reach its launch.
   */
  async prepareReviewerAccount(input: {
    taskRootSessionId: string;
    provider: ProviderId;
    workspace: DiffOnlyReviewWorkspace;
    launchOptions: NonNullable<CreateSessionRequest["launchOptions"]>;
  }): Promise<{ id: string; contribution: LaunchContribution }> {
    const pipeline = this.launchPipeline;
    if (!pipeline) throw new LaunchRefusal("The model account of the worker is not available for its reviewer.");
    const accountOnly = Object.fromEntries(Object.entries(input.launchOptions).filter(([pluginId]) => pluginId === ACCOUNTS_PLUGIN_ID));
    const options = pipeline.normalizeOptions(input.provider, accountOnly, { delegated: true });
    if (!options) throw new LaunchRefusal("The worker has no model account for its reviewer.");
    const id = randomUUID();
    try {
      const prepared = await pipeline.prepare({
        sessionId: id,
        provider: input.provider,
        profile: "plan",
        role: "subagent",
        cwd: realpathSync(input.workspace.directory),
        projectRoot: this.taskScopeFor(input.taskRootSessionId).cwd,
        parentSessionId: input.taskRootSessionId,
        restoring: false,
        resume: false,
        options: structuredClone(options) as Record<string, Record<string, boolean | string>>,
        environment: null
      });
      if (!prepared.ok) throw new LaunchRefusal(prepared.reason);
      // A reviewer id has one run and cannot be restarted. Its account contribution therefore owns both the run
      // and its parent even before a card adopts it; cancellation/failed creation use this same cleanup handle.
      const cleanup = prepared.cleanup;
      let released: Promise<void> | undefined;
      prepared.cleanup = () => released ??= (async () => {
        try { await cleanup(); }
        finally { await pipeline.forgetSession(id); }
      })();
      return { id, contribution: prepared };
    } catch (error) {
      await pipeline.forgetSession(id).catch(() => undefined);
      throw error;
    }
  }

  createReadOnlyReviewer(input: {
    taskRootSessionId: string;
    provider: ProviderId;
    /** The reviewer's model; omitted when the worker's model account (prepareReviewerAccount) decides it. */
    model?: string;
    account?: { id: string; contribution: LaunchContribution };
    title: string;
    workspace: DiffOnlyReviewWorkspace;
  }): SessionSnapshot {
    if (input.provider === "terminal" || (!input.model && !input.account) || !isHostOwnedDiffOnlyReviewWorkspace(input.workspace)) {
      throw new LaunchRefusal("The diff-only reviewer workspace is unavailable; the reviewer was not started.");
    }
    const parent = this.sessions.get(input.taskRootSessionId);
    if (!parent) throw new LaunchRefusal("The review task ended before its isolated reviewer could start.");
    const cwd = realpathSync(input.workspace.directory);
    if (cwd !== input.workspace.directory) throw new LaunchRefusal("The diff-only reviewer workspace changed before launch.");

    const denied = new Set<string>();
    const addDirectory = (candidate: string): void => {
      let real: string;
      try {
        real = realpathSync(candidate);
        if (!statSync(real).isDirectory()) throw new Error("not a directory");
      } catch {
        throw new LaunchRefusal("A project or session root could not be verified for diff-only review.");
      }
      if (isPathInside(cwd, real) || isPathInside(real, cwd)) {
        throw new LaunchRefusal("The diff-only reviewer workspace overlaps a project or session root.");
      }
      denied.add(real);
    };
    const taskRoot = this.taskScopeFor(input.taskRootSessionId);
    addDirectory(taskRoot.cwd);
    for (const session of this.sessions.values()) {
      addDirectory(session.metadata.cwd);
      addDirectory(session.metadata.taskScope?.cwd ?? this.taskScopeFor(session.metadata.id).cwd);
    }
    if (denied.size === 0) throw new LaunchRefusal("No project roots were available to isolate the diff-only reviewer.");

    const request: CreateSessionRequest = {
      provider: input.provider,
      cwd,
      profile: "plan",
      title: input.title.slice(0, 80),
      ...(input.model ? { model: input.model } : {}),
      position: parent.metadata.position,
      role: "subagent",
      parentSessionId: input.taskRootSessionId
    };
    this.readOnlyReviewerRequests.set(request, {
      taskRootSessionId: input.taskRootSessionId,
      workspace: input.workspace,
      deniedReadPaths: [...denied],
      ...(input.account ? { account: input.account } : {})
    });
    try {
      return this.create(request, { origin: "subagent", continueTaskFrom: input.taskRootSessionId });
    } catch (error) {
      this.readOnlyReviewerRequests.delete(request);
      throw error;
    }
  }

  /**
   * The model account this card was launched on (the Accounts plugin's selected account), or undefined when it runs on
   * its CLI's own sign-in. A subagent inherits it unless its spawn names an account (AgentControlService).
   */
  modelAccountOf(id: string): string | undefined {
    const options = this.sessions.get(id)?.extras.options;
    const account = selectedAccountId(options);
    return account === "default" ? undefined : account;
  }

  setTaskMetadata(id: string, patch: Pick<SessionMetadata,"reviewRequested">): void {
    const session=this.sessions.get(id);if (!session) return;
    if (patch.reviewRequested !== undefined) session.metadata.reviewRequested=patch.reviewRequested;
    this.schedulePersistence();
    this.emitSession(session.metadata);
  }
  setTaskBudget(id:string,value:SessionMetadata["taskBudget"]):void {
    const session=this.sessions.get(id);if(!session || JSON.stringify(session.metadata.taskBudget)===JSON.stringify(value))return;
    if(value)session.metadata.taskBudget={...value};else delete session.metadata.taskBudget;
    this.emitSession(session.metadata);
  }

  /** Restoration controls only this host's managed PTYs, not external editors or other OS processes. */
  isCheckpointRestoreActive(id:string):boolean {return this.checkpointRestore?.ids.has(id) ?? false;}

  canCaptureCheckpoint(id:string):boolean {
    const session=this.sessions.get(id);
    return Boolean(session && !this.isCheckpointRestoreActive(id) && this.checkpointUnavailableGenerations.get(id)!==(session.inputGeneration ?? 0));
  }

  private assertCheckpointLaunchAllowed(cwd:string,contributed=false):void {
    const lease=this.checkpointRestore;if(!lease)return;
    const folder=realpathSync(cwd);
    if(contributed || isPathInside(lease.cwd,folder) || isPathInside(folder,lease.cwd)) {
      throw new LaunchRefusal("Workspace checkpoint restoration is in progress. Try the launch again after it finishes.");
    }
  }

  /** Hold every overlapping owned process stopped across the complete Git restore transaction. */
  async withCheckpointRestore<T>(id:string,restore:(cwd:string)=>Promise<T>):Promise<T> {
    if(this.checkpointRestore)throw new Error("Another checkpoint restoration is already in progress.");
    const target=this.sessions.get(id);if(!target)throw new Error("Terminal session does not exist.");
    const cwd=realpathSync(this.launchContexts.get(id)?.cwd ?? target.metadata.cwd);
    const targetScopes=new Set([cwd]);let targetScopeAmbiguous=false;
    for(const path of [target.metadata.cwd,target.metadata.taskScope?.cwd ?? this.taskProjectRoot(target.metadata.cwd,target.metadata.parentSessionId)]) {
      try {targetScopes.add(realpathSync(path));}catch {targetScopeAmbiguous=true;}
    }
    const affected:ManagedSession[]=[];
    for(const session of this.sessions.values()) {
      // A pending plugin launch has not established its final cwd yet. Do not race its preparation/wrapping.
      if(session.launchTasks?.size)throw new Error("Wait for pending agent launches before restoring files.");
      const isolated=session.extras.isolatedEnvironmentScopes;
      if(isolated && (isolated.ambiguous || (isolated.roots.length>0 && (targetScopeAmbiguous || isolated.roots.some(root=>[...targetScopes].some(target=>isPathInside(root,target) || isPathInside(target,root))))))) {
        throw new Error("Checkpoint restoration is unavailable for a related isolated environment: pausing or exiting its local wrapper does not prove that the remote/container workload stopped. Stop and verify that workload independently; CanvasTTY has no environment suspension guarantee.");
      }
      let folder:string;
      try {folder=realpathSync(this.launchContexts.get(session.metadata.id)?.cwd ?? session.metadata.cwd);}
      catch(error) {if(session.metadata.exitCode!==null)continue;throw error;}
      if(!isPathInside(cwd,folder) && !isPathInside(folder,cwd))continue;
      if(session.metadata.exitCode===null) {
        const progress=this.turnProgress(session.metadata.id);
        if(!session.process || session.acceptedLifecycleState!=="idle" || (progress?.promptSent && !progress.turnStartedSincePrompt)) {
          throw new Error("Stop the active turn and wait for observed agent idle before restoring files.");
        }
        if(!this.processTreePause.supported)throw new Error("This platform cannot safely suspend live agents for checkpoint restoration. Close them first.");
      }
      affected.push(session);
    }
    let complete!:()=>void;
    const lease={cwd,ids:new Set(affected.map(session=>session.metadata.id)),processes:new Map<IPty,{session:ManagedSession;wasPaused:boolean}>(),deferredResume:new Set<IPty>(),closes:new Map<string,{keepEnvironmentData?:boolean}>(),done:new Promise<void>(resolve=>{complete=resolve;})};
    // Closing an ancestor closes its children and may release their environment; defer the whole close.
    for(const session of affected) {
      let parent=session.metadata.parentSessionId;
      while(parent && !lease.ids.has(parent)){lease.ids.add(parent);parent=this.sessions.get(parent)?.metadata.parentSessionId;}
    }
    this.checkpointRestore=lease;
    try {
      for(const session of affected) {
        // Existing pre-turn guards/cache entries must not describe the tree after a restoration.
        session.inputGeneration=(session.inputGeneration ?? 0)+1;
        // A delayed old hook must not label post-restore edits as a new before-turn snapshot.
        this.checkpointUnavailableGenerations.set(session.metadata.id,session.inputGeneration);
        const process=session.process;if(!process)continue;
        lease.processes.set(process,{session,wasPaused:this.processTreePause.isPaused(process)});
        const paused=this.processTreePause.pause(process);
        if(!paused.supported || paused.failed)throw new Error(`Could not safely suspend agents for restoration: ${paused.failed ?? "unsupported platform"}`);
      }
      return await restore(cwd);
    } finally {
      const failures:string[]=[];
      try {
        for(const [process,{session,wasPaused}] of lease.processes) {
          // An exited PTY no longer has another owner that can release its stopped descendants.
          if(session.process===process && ((wasPaused && !lease.deferredResume.has(process)) || this.isSessionBudgetPaused(session)))continue;
          const resumed=this.processTreePause.resume(process);
          if(resumed.failed) {
            // Never reopen input to a process that failed to resume.
            this.budgetPausedTaskRoots.add(this.taskScopeFor(session.metadata.id).id);
            failures.push(resumed.failed);
          }
        }
      } finally {
        this.checkpointRestore=null;
        complete();
        for(const [closed,options] of lease.closes)this.dispose(closed,options);
        for(const session of this.sessions.values()) {
          const root=this.taskScopeFor(session.metadata.id).id;
          if(!this.budgetPausedTaskRoots.has(root))this.launchDeferredBudgetSessions(root);
        }
      }
      if(failures.length)throw new Error(`An agent remains budget-paused after checkpoint restoration cleanup because resuming failed: ${failures.join(" ")}`);
    }
  }

  /** Host-only process suspension; Windows explicitly reports that an active process tree cannot be paused. */
  setBudgetPaused(taskRootId:string,paused:boolean):ProcessTreePauseResult {
    if(paused)this.budgetPausedTaskRoots.add(taskRootId);
    if(!paused && !this.processTreePause.supported) {
      this.budgetPausedTaskRoots.delete(taskRootId);
      this.wakeBudgetResumeWaiters(taskRootId);
      this.launchDeferredBudgetSessions(taskRootId);
      return {supported:true};
    }
    const failures:string[]=[];
    let supported=!paused || this.processTreePause.supported;
    const resumedGroups:IPty[]=[];
    for(const session of this.sessions.values()) {
      if(this.taskScopeFor(session.metadata.id).id!==taskRootId || !session.process)continue;
      if(!paused && this.checkpointRestore?.processes.has(session.process)){this.checkpointRestore.deferredResume.add(session.process);continue;}
      const wasPaused=this.processTreePause.isPaused(session.process);
      const result=paused ? this.processTreePause.pause(session.process) : this.processTreePause.resume(session.process);
      supported=supported && result.supported;
      if(result.failed)failures.push(result.failed);
      else if(!paused && wasPaused)resumedGroups.push(session.process);
    }
    if(paused) {
      if(!supported && !failures.length)failures.push("The platform cannot safely suspend an active PTY process tree.");
    } else if(failures.length) {
      // A failed SIGCONT must not make a stopped task appear runnable. Keep the host gate closed so input and
      // child/restart launches cannot run ahead of a process group that may still be stopped. Re-stop every
      // group already resumed in this batch, so one failed resume cannot leave the rest of the task running.
      for(const process of resumedGroups) {
        const rollback=this.processTreePause.pause(process);
        if(rollback.failed)failures.push(`Could not re-suspend a process group after another group failed to resume: ${rollback.failed}`);
      }
      this.budgetPausedTaskRoots.add(taskRootId);
    } else {
      this.budgetPausedTaskRoots.delete(taskRootId);
      this.wakeBudgetResumeWaiters(taskRootId);
      this.launchDeferredBudgetSessions(taskRootId);
    }
    return {supported,...(failures.length ? {failed:[...new Set(failures)].join(" ")} : {})};
  }

  /** False on Windows: a budget pause there blocks input and launches but cannot stop running processes. */
  processSuspensionSupported():boolean {return this.processTreePause.supported;}

  /** Startup orchestration replays persisted paused roots before restoring PTYs. */
  isBudgetPaused(taskRootId:string):boolean {return this.budgetPausedTaskRoots.has(taskRootId);}

  private wakeBudgetResumeWaiters(taskRootId:string):void {
    for(const wake of [...(this.budgetResumeWaiters.get(taskRootId) ?? [])])wake();
    this.budgetResumeWaiters.delete(taskRootId);
  }
  private launchDeferredBudgetSessions(taskRootId:string):void {
    for(const session of this.sessions.values()) {
      if(this.taskScopeFor(session.metadata.id).id===taskRootId && session.budgetDeferredLaunch) {
        if(this.checkpointRestore)continue;
        session.budgetDeferredLaunch=false;
        this.launchAwaitingSession(session.metadata.id,session);
      }
    }
  }

  taskScopeFor(sourceId:string):NonNullable<SessionMetadata["taskScope"]> {
    const source=this.sessions.get(sourceId);if(!source)throw new Error("Handoff card is unavailable.");
    let root=source;
    const seen=new Set([sourceId]);
    while(root.metadata.parentSessionId && !seen.has(root.metadata.parentSessionId)) {
      seen.add(root.metadata.parentSessionId);const parent=this.sessions.get(root.metadata.parentSessionId);if(!parent)break;root=parent;
    }
    const scope=root.metadata.taskScope ?? {id:root.metadata.id,cwd:root.metadata.cwd,startedAt:root.metadata.startedAt};
    return {...scope};
  }
  private isSessionBudgetPaused(session:ManagedSession):boolean {
    try {return this.budgetPausedTaskRoots.has(this.taskScopeFor(session.metadata.id).id);} catch {return false;}
  }
  private async awaitBudgetResume(session:ManagedSession):Promise<boolean> {
    while(this.isSessionBudgetPaused(session)) {
      if(this.sessions.get(session.metadata.id)!==session || session.metadata.exitCode!==null)return false;
      const taskRootId=this.taskScopeFor(session.metadata.id).id;
      await new Promise<void>(resolve=>{
        const waiters=this.budgetResumeWaiters.get(taskRootId) ?? new Set<() => void>();
        this.budgetResumeWaiters.set(taskRootId,waiters);
        const wake=()=>{
          waiters.delete(wake);
          session.launchWaiters.delete(wake);
          if(waiters.size===0)this.budgetResumeWaiters.delete(taskRootId);
          resolve();
        };
        waiters.add(wake);
        session.launchWaiters.add(wake);
        if(!this.budgetPausedTaskRoots.has(taskRootId))wake();
      });
    }
    return this.sessions.get(session.metadata.id)===session && session.metadata.exitCode===null;
  }
  /** Masks known secrets and key shapes in text another agent reads (observe, result, control screen, failures). */
  redactSecrets<T extends string | null>(text: T): T {
    return (text === null ? text : this.redaction.redact(text)) as T;
  }

  /** `redactSecrets(text)` cut to its last `maxChars` characters, masking only a window around that tail. */
  redactSecretsTail(text: string, maxChars: number): string {
    return this.redaction.redactTail(text, maxChars);
  }

  /** What decision hooks need to know about a running agent card; null for terminals and unknown ids. */
  decisionContext(id: string): DecisionSession | null {
    const session = this.sessions.get(id);
    if (!session || session.metadata.provider === "terminal") return null;
    const launched = this.launchContexts.get(id);
    return {
      provider: session.metadata.provider,
      role: session.metadata.role ?? "agent",
      cwd: launched?.cwd ?? session.metadata.cwd,
      configDirs: launched?.configDir ? [launched.configDir] : [],
      profile: session.metadata.profile
    };
  }

  /**
   * What plugins may know about a card (EP-4): its metadata, the folder it actually runs in (an environment may
   * move it) and its environment ref. No screen text.
   */
  pluginContext(id: string): {
    metadata: SessionMetadata; workingDirectory: string; environment: PersistedEnvironmentRef | null; restored: boolean; owner: string | null;
  } | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    return {
      metadata: publicSessionMetadata(session),
      workingDirectory: this.launchContexts.get(id)?.cwd ?? session.metadata.cwd,
      environment: session.extras.environment ? structuredClone(session.extras.environment) : null,
      restored: session.restored === true,
      owner: session.extras.ownerPluginId ?? null
    };
  }

  /** Host-only attribution from the accepted Accounts contribution; paths never enter plugin summaries. */
  /** Whether this card's latest launch resumed the provider conversation `threadId` (rather than starting it). */
  resumedConversation(id:string,threadId:string):boolean {
    return this.resumedThreads.get(id)===threadId;
  }

  usageAccount(id:string):{id:string;home?:string} {
    const session=this.sessions.get(id);
    return {id:session?.accountId ?? "default",...(session?.accountHome ? {home:session.accountHome} : {})};
  }

  /** Records the plugin that started a card (EP-4); saved with the card so control survives a restore. */
  setPluginOwner(id: string, pluginId: string): void {
    const session = this.sessions.get(id);
    if (!session || session.extras.ownerPluginId === pluginId) return;
    session.extras.ownerPluginId = pluginId;
    this.schedulePersistence();
  }

  /** Refuses a model its CLI does not list (the cached listing only; none cached allows it). */
  configureModelCheck(check: (provider: ProviderId, model: string) => string | null): void {
    this.modelCheck = check;
  }

  configureBaseProtection(enabled: () => boolean): void {
    this.baseProtectionOn = () => { try { return enabled() === true; } catch { return false; } };
  }

  configureSessionPersistence(store: TerminalSessionStore, mode: SessionRestoreMode): void {
    this.sessionStore = store;
    this.sessionRestoreMode = mode;
  }

  async restorePersistedSessions(): Promise<void> {
    const store = this.sessionStore;
    if (!store) return;
    const persisted = await store.load();
    if (this.sessionRestoreMode === "off") {
      if (persisted.length > 0) await store.clear();
      return;
    }

    await this.restoreSessionRecords(persisted, this.sessionRestoreMode);
  }

  private async restoreSessionRecords(persisted: PersistedTerminalSession[], mode: SessionRestoreMode): Promise<void> {
    // Environments resume first, only for cards that come back at all; a card whose environment stopped comes
    // back stopped with the plugin's reason and never runs locally instead. A card that does not come back (not
    // restored, or a subagent whose parent is gone) leaves the saved state now: its environment is released.
    const resumed = new Map<string, { ok: true } | { ok: false; reason: string }>();
    const environments = this.environments;
    if (environments) {
      const restorable = new Set(restorableRecords(persisted, mode, (id) => this.sessions.has(id)).map((record) => record.id));
      await Promise.all(persisted.map(async (record) => {
        if (!record.environment || !environments.available(record.environment)) return;
        if (!restorable.has(record.id)) {
          if (!this.sessions.has(record.id)) await environments.release(record.environment, record.id, { keepData: true, reason: "closed" });
          return;
        }
        if (record.lastState !== "running") return;
        resumed.set(record.id, await environments.resume(record.environment, record.id));
      }));
    }
    // Then parents come first; a subagent whose owning session is gone restores
    // as nothing, since its parent's runtime state no longer exists.
    const steps = planSessionRestore(persisted, mode, {
      isLiveSession: (id) => this.sessions.has(id),
      environmentAvailable: (environment, record) => resumed.get(record.id)?.ok ?? this.environmentUsable(environment),
      launchOptionsAvailable: (options) => this.unavailableLaunchPlugins(options).length === 0
    });
    for (const step of steps) this.restorePersistedSession(step, resumed.get(step.record.id));
    await this.persistSessions();
  }

  async setSessionRestoreMode(mode: SessionRestoreMode): Promise<void> {
    if (this.sessionRestoreMode === mode) return;
    this.sessionRestoreMode = mode;
    if (mode === "off") await this.sessionStore?.clear();
    else await this.persistSessions();
  }

  /** The per-card "Don't restore this card" choice. */
  setRestore(id: string, restore: boolean): SessionMetadata {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Terminal session does not exist.");
    if (typeof restore !== "boolean") throw new Error("Restore choice is invalid.");
    if (restore) delete session.metadata.skipRestore;
    else session.metadata.skipRestore = true;
    this.emitSession(session.metadata);
    this.schedulePersistence();
    return publicSessionMetadata(session);
  }

  async shutdown(): Promise<void> {
    if(this.checkpointRestore)await this.checkpointRestore.done;
    if (this.persistenceTimer !== null) {
      clearTimeout(this.persistenceTimer);
      this.persistenceTimer = null;
    }
    await this.persistSessions().catch((error) => {
      console.warn("CanvasTTY terminal window state could not be saved during shutdown.", error);
    });
    this.suppressPersistence = true;
    // Quitting keeps every environment for the next start; nothing is released as "closed".
    this.quitting = true;
    this.disposeAll();
    await Promise.allSettled(this.quitReleases.splice(0));
    if (this.sessionStore) await this.sessionStore.flush().catch(() => undefined);
  }

  async shutdownForUpdate(): Promise<() => Promise<void>> {
    const sessions = [...this.sessions.values()].map(session => persistedTerminalSession(session.metadata, session.threadId, session.extras));
    await this.shutdown();
    let restored = false;
    return async () => {
      if (restored) return;
      restored = true;
      this.suppressPersistence = false;
      this.quitting = false;
      // A cancelled update returns every open card, including cards excluded from restart persistence.
      await this.restoreSessionRecords(sessions.map(record => ({ ...record, restore: true })), "continue");
      for (const descriptor of sessions) {
        const session = this.sessions.get(descriptor.id);
        if (session && !descriptor.restore) {
          session.metadata.skipRestore = true;
          this.emitSession(session.metadata);
        }
      }
      await this.persistSessions();
    };
  }

  /**
   * Resolves once every PTY this manager started has exited, so the app never finishes quitting while a native
   * exit watcher is still pending. Called after `shutdown()` (which hung every card up): a process still running
   * after `exitWaitMs` is killed, and after `killWaitMs` more the wait gives up. Returns how many never exited.
   */
  async waitForProcessExits(exitWaitMs = PTY_EXIT_WAIT_MS, killWaitMs = PTY_KILL_WAIT_MS): Promise<number> {
    if (this.liveProcesses.size === 0) return 0;
    if (!await this.allProcessesExited(exitWaitMs)) {
      for (const process of this.liveProcesses.keys()) {
        try {
          // Windows PTYs take no signal.
          if (globalThis.process.platform === "win32") process.kill();
          else process.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
      await this.allProcessesExited(killWaitMs);
    }
    return this.liveProcesses.size;
  }

  /** Stops only this card's owned PTY and waits for its existing exit watcher before it can reuse a workspace. */
  async stopSubagentPtyForRetry(id: string): Promise<void> {
    if(this.isCheckpointRestoreActive(id))throw new Error("Workspace checkpoint restoration is in progress.");
    const session = this.sessions.get(id);
    if (!session || session.metadata.role !== "subagent" || session.metadata.provider === "terminal") {
      throw new Error("The retry source is no longer an available subagent.");
    }
    const process = session.process;
    if (!process) {
      if (session.metadata.exitCode !== null) return;
      throw new Error("The retry source has no observable PTY to stop safely.");
    }
    const exited = this.liveProcesses.get(process);
    if (!exited) throw new Error("The retry source PTY has no host exit watcher; its workspace was not reused.");

    const resumed = this.processTreePause.resume(process);
    if (resumed.failed) throw new Error(`The retry source PTY could not be resumed before stopping: ${resumed.failed}`);
    try { process.kill(); } catch { /* It may have exited as the quiet result was reported. */ }
    if (await this.waitForOwnedProcess(exited, PTY_EXIT_WAIT_MS)) return;

    try {
      // On Windows a PTY accepts no signal. On other hosts force only this exact owned PTY after the grace period.
      if (globalThis.process.platform === "win32") process.kill();
      else process.kill("SIGKILL");
    } catch { /* The captured exit promise below decides whether it stopped. */ }
    if (!await this.waitForOwnedProcess(exited, PTY_KILL_WAIT_MS)) {
      throw new Error("The retry source PTY did not exit; its workspace was not reused.");
    }
  }

  private async waitForOwnedProcess(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    try { return await Promise.race([exited.then(() => true as const), timedOut]); }
    finally { clearTimeout(timer); }
  }

  private allProcessesExited(timeoutMs: number): Promise<boolean> {
    return this.waitForOwnedProcess(Promise.all(this.liveProcesses.values()).then(() => undefined), timeoutMs);
  }

  /**
   * Every card's metadata, without its scrollback: at initial hydration every card subscribes and calls
   * readBuffer() for its own history anyway (attachTerminalOutput), so a full copy here would only be
   * serialized across IPC and thrown away unread. Use readBuffer(id) for a card's actual history.
   */
  list(): SessionSnapshot[] {
    return [...this.sessions.values()].map((session) => ({ ...structuredClone(session.metadata), buffer: "" }));
  }

  /**
   * Takes the failure origin of the session event being emitted right now, or
   * null for an ordinary snapshot. Only meaningful inside the emit callback:
   * the value is one-shot, so one failure can never be announced twice.
   */
  consumeFailureOrigin(): FailureOrigin | null {
    const origin = this.emittingFailureOrigin;
    this.emittingFailureOrigin = null;
    return origin;
  }

  listMetadata(): SessionMetadata[] {
    return [...this.sessions.values()].map(publicSessionMetadata);
  }

  /** One session's metadata by id, or null. Unlike list(), a lookup never copies any scrollback. */
  getMetadata(id: string): SessionMetadata | null {
    const session = this.sessions.get(id);
    return session ? publicSessionMetadata(session) : null;
  }

  geometry(id: string): { cols: number; rows: number } {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Terminal session does not exist.");
    return { cols: session.cols, rows: session.rows };
  }

  /**
   * Whether a submitted prompt was delivered to the session (through deliverInput) and whether a turn has started since
   * then; null when the session does not exist.
   */
  turnProgress(id: string): { promptSent: boolean; turnStartedSincePrompt: boolean } | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const mark = session.promptTurnMark;
    return { promptSent: mark !== undefined, turnStartedSincePrompt: mark !== undefined && (session.turnStarts ?? 0) > mark };
  }

  /** The session's output offset without copying its scrollback; null when it does not exist. */
  outputOffset(id: string): number | null {
    return this.sessions.get(id)?.outputOffset ?? null;
  }

  readBuffer(id: string): TerminalBufferSnapshot {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Terminal session does not exist.");
    return {
      buffer: session.bufferChunks.slice(session.bufferStart).join(""),
      outputOffset: session.outputOffset
    };
  }

  /**
   * Sessions launched with the orchestrator role while a connection is set get
   * it in their environment; ordinary sessions never do. Existing sessions are
   * not re-spawned, so their environment stays as it was at launch.
   */
  setControlConnection(connection: ControlConnection | null): void {
    this.controlConnection = connection ? { ...connection } : null;
  }

  create(
    request: CreateSessionRequest,
    control: { captureReviewDiff?: boolean; captureResult?: boolean; answerCaptureGrantExpiresAt?: number; origin?: LaunchOrigin; ownerPluginId?: string; continueTaskFrom?:string } = {}
  ): SessionSnapshot {
    const reviewerControl = this.readOnlyReviewerRequests.get(request);
    if (reviewerControl) this.readOnlyReviewerRequests.delete(request);
    assertCreateRequest(request, this.containment());
    this.assertCheckpointLaunchAllowed(request.cwd,Boolean(request.environment || request.launchOptions));
    const origin: LaunchOrigin = request.role === "subagent" ? "subagent" : control.origin ?? "person";
    if (request.profile === "yolo" && request.provider !== "terminal") {
      // YOLO is the person's decision, made in the launcher for that CLI; nothing else starts it on their behalf.
      if (origin === "subagent") throw new LaunchRefusal("YOLO (bypass) is never given to a subagent.");
      if (!this.yoloAcknowledged(request.provider)) {
        throw new LaunchRefusal(`YOLO for ${request.provider} was not acknowledged by the person. They choose it once in CanvasTTY's launcher; ${origin === "plugin" ? "a plugin" : origin === "control" ? "the control endpoint" : "a launch"} cannot start it before that.`);
      }
    }
    // A typed path (an orchestrator's spawn_agent, the control CLI) may spell the folder in another Unicode form
    // than the disk does; the CLI would then see its own project as a foreign folder.
    request = { ...request, cwd: onDiskPath(request.cwd) };
    const threadId = request.resumeThreadId === undefined ? undefined : normalizeThreadId(request.provider, request.resumeThreadId);
    if (request.resumeThreadId !== undefined && (!threadId || !canResumeThreadById(request.provider) || request.environment)) {
      throw new Error("Invalid local conversation resume request.");
    }
    const resume: ResumeRequest = threadId ? { threadId } : null;
    const modelChoice = launchModelChoice(request.provider, request.model, request.effort);
    // A model account passes its own --model; a second one from the request made OpenCode crash at start
    // ("U.split is not a function"). The account decides the model: say so instead of starting a broken CLI.
    if (modelChoice.model !== undefined && selectedAccountId(request.launchOptions) !== "default") {
      throw new LaunchRefusal(`Model account ${selectedAccountId(request.launchOptions).slice(0, 40)} sets the model of this launch; omit model, or choose an account for the model you want (list_routes / pick_account).`);
    }
    if (modelChoice.model !== undefined) {
      let unknown: string | null = null;
      try { unknown = this.modelCheck(request.provider, modelChoice.model); } catch { unknown = null; }
      if (unknown) throw new Error(unknown);
    }
    if (control.captureResult && !RESULT_CAPTURE_PROVIDERS.has(request.provider)) {
      throw new Error("Result capture requires a Codex or OpenCode session.");
    }
    assertDirectory(request.cwd);

    const role = request.role ?? "agent";
    if (request.parentSessionId !== undefined && !this.sessions.has(request.parentSessionId)) {
      throw new Error("Parent terminal session does not exist.");
    }

    const delegated = origin === "subagent" || control.ownerPluginId !== undefined;
    // The orchestrator's own account is the person's choice: its subagent may run on it even where the plugin did not
    // declare its options delegable. Any other account needs the plugin's delegable declaration.
    const parentAccount = origin === "subagent" && request.parentSessionId !== undefined ? this.modelAccountOf(request.parentSessionId) : undefined;
    const launchOptions = reviewerControl ? undefined : this.launchPipeline
      ? this.launchPipeline.normalizeOptions(request.provider, request.launchOptions, origin === "subagent"
        ? { delegated: true, ...(parentAccount ? { inherited: { [ACCOUNTS_PLUGIN_ID]: { account: parentAccount } } } : {}) } : undefined)
      : request.launchOptions === undefined ? undefined : failWith("Plugin launch options are not available.");
    // The isolation layer decides before anything starts: a subagent without it runs in normal, a launch that
    // needs it and cannot have it is refused.
    // Host consent supplies continuation identity before any process or capability is launched.
    const continuationScope=control.continueTaskFrom ? this.taskScopeFor(control.continueTaskFrom) : undefined;
    const inheritedTaskRootId=continuationScope?.id ?? (request.parentSessionId ? this.taskScopeFor(request.parentSessionId).id : undefined);
    if(inheritedTaskRootId && this.budgetPausedTaskRoots.has(inheritedTaskRootId)) {
      throw new LaunchRefusal("This task's usage budget is paused. Clear or raise the task budget before starting another agent.");
    }
    const taskProjectRoot = continuationScope?.cwd ?? this.taskProjectRoot(request.cwd, request.parentSessionId);
    const decision = this.decideIsolation(request.provider, request.profile, delegated, null, taskProjectRoot);
    if (decision.refuse) throw new LaunchRefusal(decision.refuse);
    if (reviewerControl && (!decision.apply || decision.profile !== "plan")) {
      throw new LaunchRefusal("A diff-only reviewer requires the operating-system isolation layer and a read-only Plan profile. The reviewer was not started.");
    }
    if (decision.profile !== request.profile) request = { ...request, profile: decision.profile };
    const environmentChoice = reviewerControl ? null : this.environments
      ? this.environments.normalizeChoice(request.provider, request.environment) ?? null
      : request.environment === undefined ? null : failWith("Plugin environments are not available.");

    const id = reviewerControl?.account?.id ?? randomUUID();
    const startedAt=Date.now();
    const captureResult = control.captureResult === true || Boolean(reviewerControl);
    const metadata: SessionMetadata = {
      id,
      revision: 0,
      provider: request.provider,
      profile: request.profile,
      title: request.title?.trim() || defaultTitle(request.provider, request.cwd),
      titleCustomized: Boolean(request.title?.trim()),
      cwd: request.cwd,
      position: request.position,
      size: DEFAULT_TERMINAL_SIZE,
      role,
      ...(request.parentSessionId !== undefined ? { parentSessionId: request.parentSessionId } : {}),
      status: initialSessionStatus(request.provider),
      startedAt,
      ...(continuationScope ? {taskScope:continuationScope} : environmentChoice && !request.parentSessionId ? {taskScope:{id,cwd:request.cwd,startedAt}} : {}),
      exitCode: null,
      failureDetails: null,
      ...modelChoice,
      ...(decision.isolation ? { isolation: decision.isolation } : {})
    };
    const awaitMeasuredGrid = !reviewerControl && request.provider === "grok"
      && this.providerClis.get(request.provider).state === "available";
    // With launch options, an environment or a launch policy the plugins answer first; the card waits and launches when they do.
    const contributed = !reviewerControl && (Boolean(launchOptions) || Boolean(environmentChoice) || this.policyApplies(request.provider)) && !awaitMeasuredGrid;
    this.startingModels.set(id, modelChoice);
    if (control.ownerPluginId !== undefined) this.startingOwners.set(id, control.ownerPluginId);
    let launched: ReturnType<TerminalManager["spawnProcess"]> | { process: null; agentBrowser: null; agentRuntime: null; agentOrchestration: null; failure: null };
    try {
      launched = awaitMeasuredGrid || contributed
        ? { process: null, agentBrowser: null, agentRuntime: null, agentOrchestration: null, failure: null }
        : this.spawnProcess(id, request.provider, request.profile, request.cwd,
          INITIAL_TERMINAL_COLS, INITIAL_TERMINAL_ROWS, resume, captureResult, role,
          control.answerCaptureGrantExpiresAt, reviewerControl?.account?.contribution ?? null, request.parentSessionId, taskProjectRoot, reviewerControl, control.captureReviewDiff === true);
    } finally {
      this.startingModels.delete(id);
      this.startingOwners.delete(id);
    }
    if (launched.failure) applyLaunchFailure(metadata, launched.failure);
    const configured = this.pendingConfiguredModes.get(id);
    this.pendingConfiguredModes.delete(id);
    if (configured) metadata.configuredMode = configured;

    const session: ManagedSession = {
      metadata,
      process: launched.process,
      cols: INITIAL_TERMINAL_COLS,
      rows: INITIAL_TERMINAL_ROWS,
      bufferChunks: [],
      bufferStart: 0,
      bufferLength: 0,
      outputOffset: 0,
      pendingOutput: [],
      pendingOutputChars: 0,
      agentBrowser: launched.agentBrowser,
      agentRuntime: launched.agentRuntime,
      agentOrchestration: launched.agentOrchestration,
      lifecycle: this.lifecycleHooksEnabled
        ? createProviderLifecycleParser(request.provider, request.cwd)
        : null,
      awaitingInitialResize: awaitMeasuredGrid,
      resumeOnLaunch: resume,
      ...(threadId ? { threadId } : {}),
      captureResult,
      captureReviewDiff: control.captureReviewDiff === true,
      ...(reviewerControl ? { reviewWorkspace: reviewerControl.workspace } : {}),
      extras: {
        ...(launchOptions ? { options: launchOptions } : {}),
        ...(environmentChoice ? { environmentChoice } : {}),
        ...(control.ownerPluginId !== undefined ? { ownerPluginId: control.ownerPluginId } : {})
      },
      launchToken: 0,
      launchCleanup: null,
      restoringLaunch: false,
      environmentReady: false,
      launchEpoch: 0,
      launchWaiters: new Set()
    };
    this.sessions.set(id, session);
    const reviewerAccount = reviewerControl?.account?.contribution;
    if (reviewerAccount) {
      this.addLaunchSecrets(session, reviewerAccount.secrets);
      session.accountId = reviewerAccount.accountId ?? reviewerControl!.account!.id;
      session.accountHome = reviewerAccount.accountHome;
      session.launchCleanup = reviewerAccount.cleanup;
    }
    this.adoptIsolationStart(id, session);
    if (launched.process) this.bindProcess(id, session, launched.process);
    if (contributed) this.launchContributed(id, session, resume, null, control.answerCaptureGrantExpiresAt);
    const runtimeStatus = this.agentRuntime?.currentStatus(id);
    if (runtimeStatus) session.metadata.status = runtimeStatus;

    this.emitSession(metadata);
    this.schedulePersistence();
    return snapshot(session);
  }

  /** History belongs to this computer; a plugin environment's same id is a different conversation. */
  findLocalConversation(provider: ProviderId, threadId: string): SessionSnapshot | null {
    const matches = [...this.sessions.values()].filter((candidate) => candidate.metadata.provider === provider
      && candidate.threadId === threadId && !candidate.extras.environment && !candidate.extras.environmentChoice);
    const session = matches.find((candidate) => candidate.metadata.exitCode === null) ?? matches[0];
    return session ? snapshot(session) : null;
  }

  private readonly retryingLaunches = new Set<string>();
  private readonly retryLaunchValidators = new Map<string, () => void>();

  /** Replace the process, retaining this card's task ownership, environment and diagnostic scrollback. */
  async retryAgentLaunch(id: string, prompt: string, validate: () => void, signal?: AbortSignal, beforeStop?: () => void): Promise<SessionMetadata> {
    const session = this.sessions.get(id);
    if (!session || session.metadata.role !== "subagent") throw new LaunchRefusal("Only an existing subagent can be retried.");
    if (this.retryingLaunches.has(id)) throw new LaunchRefusal("A retry of this agent is already in progress.");
    const ancestors: Array<{ session: ManagedSession; epoch: number }> = [];
    const seen = new Set<string>([id]);
    for (let parentId = session.metadata.parentSessionId; parentId;) {
      if (seen.has(parentId)) throw new LaunchRefusal("The subagent's parent lineage is invalid.");
      seen.add(parentId);
      const parent = this.sessions.get(parentId);
      if (!parent) throw new LaunchRefusal("The subagent's parent was closed.");
      ancestors.push({ session: parent, epoch: parent.launchEpoch });
      parentId = parent.metadata.parentSessionId;
    }
    let epoch = session.launchEpoch;
    const current = (): boolean => this.sessions.get(id) === session && session.launchEpoch === epoch;
    const check = (): void => {
      if (signal?.aborted) throw new DOMException("The retry was canceled.", "AbortError");
      if (!current() || ancestors.some(({ session: parent, epoch: parentEpoch }) =>
        this.sessions.get(parent.metadata.id) !== parent || parent.launchEpoch !== parentEpoch)) {
        throw new LaunchRefusal("The agent or its parent was closed or restarted during retry.");
      }
      validate();
      this.validateRestart(session);
      assertDirectory(session.metadata.cwd);
      if (session.metadata.provider === "terminal" || this.providerClis.get(session.metadata.provider).state !== "available") throw new LaunchRefusal("The agent CLI is unavailable.");
    };
    const previousFailure = session.metadata.failureDetails;
    let replacementStarted = false;
    this.retryingLaunches.add(id);
    try {
      check();
      beforeStop?.();
      // Never start a successor while the old PTY might still be alive. A timeout keeps its live slot occupied.
      await this.stopRetryProcess(session);
      check();
      // restartSession advances the epoch synchronously before starting either launch path. Set the expected
      // epoch first so synchronous spawn failures are ours to clean up, and contributed guards see it immediately.
      epoch += 1;
      replacementStarted = true;
      this.retryLaunchValidators.set(id, check);
      this.restartSession(id);
      const delivery = await this.deliverInput(id, `${prompt}\r`, undefined, signal);
      check();
      if (!delivery.delivered) throw new LaunchRefusal(`The retry prompt was not delivered: ${delivery.reason}`);
      return publicSessionMetadata(session);
    } catch (error) {
      if (replacementStarted && current()) {
        // Stop only our replacement. Closing/restarting elsewhere must never let this cleanup kill a later launch.
        try { await this.stopRetryProcess(session); }
        catch (stopError) {
          throw new LaunchRefusal(`Retry failed and its process could not be stopped: ${this.redactSecrets(String(stopError))}`);
        }
        if (current()) {
          session.metadata.status = "failed";
          session.metadata.exitCode = session.metadata.exitCode || 1;
          session.metadata.failureDetails = this.redactSecrets([
            previousFailure, "The previous process was stopped; it was not restored.",
            `Retry failed: ${error instanceof Error ? error.message : String(error)}`
          ].filter(Boolean).join("\n")).slice(0, 8_000);
          this.emitSession(session.metadata);
          this.schedulePersistence();
        }
      }
      throw error;
    } finally {
      this.retryingLaunches.delete(id);
      this.retryLaunchValidators.delete(id);
    }
  }

  private async stopRetryProcess(session: ManagedSession): Promise<void> {
    const process = session.process;
    if (process) {
      await this.stopSubagentPtyForRetry(session.metadata.id);
    } else if (session.metadata.exitCode === null) {
      // Fence asynchronous plugin preparation even when no PTY has been adopted yet.
      session.launchToken += 1;
      this.wakeLaunchWaiters(session);
      session.metadata.exitCode = 1;
      session.metadata.status = "failed";
      session.metadata.failureDetails = session.metadata.failureDetails ?? "The pending launch was stopped before retry completed.";
      void this.cleanupLaunchFiles(session).catch(() => undefined);
      this.emitSession(session.metadata);
      this.schedulePersistence();
    }
  }

  private validateRestart(session: ManagedSession): void {
    if (session.reviewWorkspace) throw new LaunchRefusal("A diff-only reviewer session cannot be restarted; request a new isolated review instead.");
    if (this.isSessionBudgetPaused(session)) throw new LaunchRefusal("This task's usage budget is paused. Clear or raise the task budget before restarting it.");
    if(this.isCheckpointRestoreActive(session.metadata.id))throw new LaunchRefusal("Workspace checkpoint restoration is in progress.");
    this.assertCheckpointLaunchAllowed(session.metadata.cwd,Boolean(session.extras.environment || session.extras.environmentChoice || session.extras.options));
    const environment = session.extras.environment;
    if (environment && !this.environmentUsable(environment)) {
      throw new Error(`This card runs in ${environment.label} from plugin ${environment.pluginId}, which is not available. It was not started locally.`);
    }
    const pendingChoice = environment ? undefined : session.extras.environmentChoice;
    if (pendingChoice && !this.environments?.available(pendingChoice)) throw new Error(`${this.pendingEnvironmentReason(pendingChoice)} It was not started locally.`);
    const missingPlugins = this.unavailableLaunchPlugins(session.extras.options);
    if (missingPlugins.length > 0) throw new Error(`Launch refused: ${missingLaunchPlugins(missingPlugins)}`);
  }

  restart(id: string, options: { resume?: boolean } = {}): SessionSnapshot {
    if (this.retryingLaunches.has(id)) throw new LaunchRefusal("A retry of this agent is already in progress.");
    return this.restartSession(id, options);
  }

  private restartSession(id: string, options: { resume?: boolean } = {}): SessionSnapshot {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Terminal session does not exist.");
    this.validateRestart(session);
    if (session.metadata.exitCode === null) throw new Error("Terminal session is still running.");
    delete session.extras.heldState;
    delete session.metadata.restoreNote;
    this.reviewDiffTracker.forget(id);
    this.checkpointUnavailableGenerations.delete(id);
    // Input queued for the launch that ended never reaches this one.
    session.launchEpoch += 1;
    this.wakeLaunchWaiters(session);
    // What the ended process's hooks and title said is not about the new one: its title counts until its own hooks report.
    resetLaunchSignals(session);
    let resume: ResumeRequest = null;
    if (options.resume === true && session.metadata.provider !== "terminal") {
      const peers = [...this.sessions.values()].filter((candidate) => (
        candidate.metadata.provider === session.metadata.provider && candidate.metadata.cwd === session.metadata.cwd
      )).length;
      const chosen = chooseResume(session.metadata.provider, session.threadId, peers);
      resume = chosen.resume;
      if (chosen.note) session.metadata.restoreNote = chosen.note;
    } else {
      // A plain restart is a new conversation, so the old id must not be resumed later.
      delete session.threadId;
    }

    if (session.metadata.provider === "grok") {
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
      session.resumeOnLaunch = resume;
      session.metadata.startedAt = Date.now();
      session.metadata.status = initialSessionStatus(session.metadata.provider);
      session.metadata.turnCompleted = false;
      session.metadata.exitCode = null;
      session.metadata.failureDetails = null;
      this.emitSession(session.metadata);
      this.schedulePersistence();
      return snapshot(session);
    }

    session.agentOrchestration?.cleanup();
    if (this.contributed(session)) {
      session.process = null;
      session.agentBrowser = null;
      session.agentRuntime = null;
      session.agentOrchestration = null;
      session.awaitingInitialResize = false;
      session.lifecycle = this.lifecycleHooksEnabled
        ? createProviderLifecycleParser(session.metadata.provider, session.metadata.cwd)
        : null;
      session.metadata.startedAt = Date.now();
      session.metadata.status = initialSessionStatus(session.metadata.provider);
      session.metadata.exitCode = null;
      session.metadata.failureDetails = null;
      this.emitSession(session.metadata);
      this.launchContributed(id, session, resume, "user");
      return snapshot(session);
    }
    const launched = this.spawnProcess(
      id,
      session.metadata.provider,
      session.metadata.profile,
      session.metadata.cwd,
      session.cols,
      session.rows,
      resume,
      session.captureResult,
      session.metadata.role,
      undefined,
      null,
      session.metadata.parentSessionId
    );
    session.process = launched.process;
    session.agentBrowser = launched.agentBrowser;
    session.agentRuntime = launched.agentRuntime;
    session.agentOrchestration = launched.agentOrchestration;
    session.awaitingInitialResize = false;
    session.lifecycle = this.lifecycleHooksEnabled
      ? createProviderLifecycleParser(session.metadata.provider, session.metadata.cwd)
      : null;
    session.metadata.startedAt = Date.now();
    // A restart is a launch the user asked for, so its failure is news even
    // though the card already showed "failed" before they clicked.
    let failureOrigin: FailureOrigin | null = null;
    if (launched.failure) {
      applyLaunchFailure(session.metadata, launched.failure);
      failureOrigin = "user";
    } else {
      session.metadata.status = initialSessionStatus(session.metadata.provider);
      session.metadata.turnCompleted = false;
      session.metadata.exitCode = null;
      session.metadata.failureDetails = null;
      if (launched.process) this.bindProcess(id, session, launched.process);
      const runtimeStatus = this.agentRuntime?.currentStatus(id);
      if (runtimeStatus) session.metadata.status = runtimeStatus;
    }
    this.emitSession(session.metadata, failureOrigin);
    this.schedulePersistence();
    return snapshot(session);
  }

  input(id: string, data: string): void {
    this.inputChecked(id, data);
  }

  /** The card's launch waits for its plugins (or its measured grid): nothing can be written to it yet. */
  launchPending(id: string): boolean {
    const session = this.sessions.get(id);
    return Boolean(session && session.metadata.exitCode === null && !session.process);
  }

  /** Host input readiness includes OpenCode's first prompt, before it creates a conversation. */
  inputReady(id: string): boolean {
    const session = this.sessions.get(id);
    return Boolean(session?.process && session.metadata.exitCode === null
      && (session.hookSignals || session.titleState || session.cliInputReady));
  }

  /**
   * Serialize controller prompts within one launch, waiting for the PTY and supported CLI readiness.
   * Confirm hooked CLI input through a new turn or an echoed unsubmitted prompt. Submitted text is
   * written once; only Enter may be retried after a complete echo. A failed acknowledgement is ambiguous
   * and asks the caller to inspect the card. Cancellation, restart and deadlines never replay queued text
   * into a later launch. Unhooked terminals retain ordinary PTY delivery.
   */
  deliverInput(id: string, data: string, waitMs = LAUNCH_INPUT_WAIT_MS, signal?: AbortSignal): Promise<InputDelivery> {
    const session = this.sessions.get(id);
    if (!session) return Promise.resolve({ delivered: false, reason: "The session does not exist." });
    const epoch = session.launchEpoch;
    const deadline = Date.now() + waitMs;
    const previous = session.inputQueue;
    const run = async (): Promise<InputDelivery> => {
      if (this.sessions.get(id) !== session || session.launchEpoch !== epoch) {
        return { delivered: false, reason: "The session was closed or restarted before delivery." };
      }
      return this.deliverQueuedInput(id, data, Math.max(0, deadline - Date.now()), signal);
    };
    const pending = previous ? previous.then(run, run) : run();
    session.inputQueue = pending;
    void pending.finally(() => { if (session.inputQueue === pending) delete session.inputQueue; }).catch(() => {});
    return pending;
  }

  private async deliverQueuedInput(id: string, data: string, waitMs: number, signal?: AbortSignal): Promise<InputDelivery> {
    const canceled: InputDelivery = { delivered: false, reason: "The delivery was cancelled." };
    if (signal?.aborted) return canceled;
    const session = this.sessions.get(id);
    if (!session) return { delivered: false, reason: "The session does not exist." };
    const epoch = session.launchEpoch;
    const deadline = Date.now() + waitMs;
    const waiting = (): boolean => this.sessions.get(id) === session && session.launchEpoch === epoch
      && session.metadata.exitCode === null && !session.process;
    while (waiting() && !signal?.aborted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { delivered: false, reason: `The session did not start within ${Math.round(waitMs / 1000)} s.` };
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(wake, remaining);
        function wake(): void {
          clearTimeout(timer);
          session!.launchWaiters.delete(wake);
          signal?.removeEventListener("abort", wake);
          resolve();
        }
        session.launchWaiters.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
    if (signal?.aborted) return canceled;
    if (this.sessions.get(id) !== session) return { delivered: false, reason: "The session was closed before it started." };
    if (session.launchEpoch !== epoch) return { delivered: false, reason: "The session was restarted before it started." };
    if (session.metadata.exitCode !== null) {
      return { delivered: false, reason: session.metadata.failureDetails
        ? `The session did not start: ${this.redactSecrets(session.metadata.failureDetails)}`
        : "The session has already exited." };
    }
    // Only these providers have a startup hook and a turn acknowledgement. Without an installed runtime
    // (e.g. hooks disabled or a remote environment) keep the ordinary PTY delivery contract.
    const confirm = (this.lifecycleHooksEnabled || session.captureResult) && session.agentRuntime !== null
      && ["opencode", "claude", "codex"].includes(session.metadata.provider);
    const valid = (): boolean => this.sessions.get(id) === session && session.launchEpoch === epoch
      && session.metadata.exitCode === null && !signal?.aborted;
    const poll = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        const wake = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", wake); resolve(); };
        const timer = setTimeout(wake, Math.max(0, Math.min(50, deadline - Date.now())));
        signal?.addEventListener("abort", wake, { once: true });
      });
    };
    if (confirm) {
      while (valid() && !this.inputReady(id) && Date.now() < deadline) await poll();
      if (signal?.aborted) return canceled;
      if (!valid()) return { delivered: false, reason: "The session closed, exited or restarted before CLI readiness." };
      if (!this.inputReady(id)) return { delivered: false, reason: "The CLI did not become ready before the delivery deadline; no text was sent." };
    }
    if (Date.now() >= deadline) return { delivered: false, reason: "The input delivery deadline expired; no text was sent." };
    // A submitted prompt: the agent's next turn is the one that answers it (turnProgress).
    const offset = session.outputOffset;
    const mark = session.turnStarts ?? 0;
    if (!this.inputChecked(id, data)) return { delivered: false, reason: "The terminal no longer accepts input." };
    if (!confirm) return { delivered: true };
    // Never replay the text on an ambiguous acknowledgement: that can run a task twice. Retry only Enter,
    // and only after observing the complete text echoed by an idle CLI (the text itself was accepted).
    const text = data.replace(/[\r\n]$/u, "").replace(/\s+/gu, "");
    let submits = 1;
    let retryAt = Date.now() + 1000;
    let observedOffset = offset;
    let echoed = false;
    while (valid() && Date.now() < deadline) {
      if ((session.turnStarts ?? 0) > mark) return { delivered: true };
      if (session.outputOffset !== observedOffset) {
        observedOffset = session.outputOffset;
        const fresh = scrollbackTail(session, observedOffset - offset);
        echoed = text.length > 0 && stripVTControlCharacters(fresh).replace(/\s+/gu, "").includes(text);
      }
      if (echoed && !/[\r\n]$/u.test(data)) return { delivered: true };
      if (echoed && (session.acceptedLifecycleState ?? session.metadata.status) === "idle" && Date.now() >= retryAt && submits < 3) {
        if (!this.inputChecked(id, "\r", { acknowledgementRetry: true })) break;
        submits++;
        retryAt = Date.now() + 1000;
      }
      await poll();
    }
    if (signal?.aborted) return canceled;
    return { delivered: false, reason: "The CLI did not confirm accepting the prompt before the delivery deadline. Inspect the card before sending again; the text was not replayed." };
  }

  private wakeLaunchWaiters(session: ManagedSession): void {
    for (const wake of [...session.launchWaiters]) wake();
  }

  inputChecked(id: string, data: string, internal: { acknowledgementRetry?: boolean } = {}): boolean {
    if(this.isCheckpointRestoreActive(id))return false;
    if (data !== "\x03") { try { this.inputGate?.(id); } catch { return false; } }
    if (typeof data !== "string" || data.length === 0) return false;
    const session = this.sessions.get(id);
    if (!session || session.metadata.exitCode !== null || !session.process) return false;
    if(data!=="\x03" && this.isSessionBudgetPaused(session))return false;
    const process = session.process;
    const mark = session.turnStarts ?? 0;
    const pasteStart = data.lastIndexOf("\x1b[200~"), pasteEnd = data.lastIndexOf("\x1b[201~");
    if (!internal.acknowledgementRetry && (pasteStart >= 0 || pasteEnd >= 0)) session.inputBracketedPaste = pasteStart > pasteEnd;
    const submitted = /[\r\n]$/u.test(data) && !session.inputBracketedPaste;
    // All routes, including renderer and companion input, notify only after every no-write guard passed.
    const afterWrite = internal.acknowledgementRetry ? []
      : [...(this.inputWriteObservers.get(id) ?? [])].map(observer => observer(data, submitted));
    if (!internal.acknowledgementRetry && submitted) {
      if ((session.acceptedLifecycleState ?? session.metadata.status) !== "needs_approval") session.inputGeneration = (session.inputGeneration ?? 0) + 1;
      session.promptTurnMark = mark;
      delete session.answer;
    }
    const written = tryPtyOperation(() => process.write(data));
    if (written && !internal.acknowledgementRetry) {
      for (const callback of afterWrite) callback?.();
    }
    if (written && ANSWERS_PROMPT.test(data)) this.settleAnsweredPrompt(id, session);
    return written;
  }

  /**
   * A hooked Claude card waits at its permission prompt (needs_approval) and the person answered it. When they declined
   * (Esc, or "No"), Claude interrupts the turn and runs no Stop hook, and its «✳» title defers to the hooks, so the card
   * would stay needs_approval while Claude waits at its prompt line. If, a moment later, no hook moved the card on (an
   * allowed tool reports PostToolUse, a new prompt PermissionRequest) and the title still shows no turn running, the
   * turn ended: idle.
   */
  private settleAnsweredPrompt(id: string, session: ManagedSession): void {
    if (session.metadata.status !== "needs_approval" || !titleDefersToHooks(session, "idle")) return;
    if (session.answeredPromptTimer) clearTimeout(session.answeredPromptTimer);
    const hooksBefore = session.hookSignals ?? 0;
    session.answeredPromptTimer = setTimeout(() => {
      session.answeredPromptTimer = undefined;
      if (this.sessions.get(id) !== session || session.metadata.exitCode !== null) return;
      if (session.metadata.status !== "needs_approval" || session.titleState === "working") return;
      if ((session.hookSignals ?? 0) !== hooksBefore) return;
      this.applyProviderSignal(id, { kind: "lifecycle", state: "idle" }, "title");
    }, ANSWERED_PROMPT_SETTLE_MS);
    session.answeredPromptTimer.unref?.();
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
    this.scheduleBoundsPersistence();
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
    return publicSessionMetadata(session);
  }

  /** A host-only freshness token for a bounded pre-ack hook barrier; no renderer authority is granted. */
  providerSignalGuard(id: string, signal: ProviderLifecycleSignal): () => boolean {
    const session = this.sessions.get(id), generation = session?.inputGeneration ?? 0;
    return () => Boolean(session && this.sessions.get(id) === session && (session.inputGeneration ?? 0) === generation
      && this.canApplyProviderSignal(id, signal));
  }

  /** Read-only host check before a lifecycle hook is acknowledged; applying the signal still happens once later. */
  canApplyProviderSignal(id: string, signal: ProviderLifecycleSignal): boolean {
    if(this.isCheckpointRestoreActive(id))return false;
    const session = this.sessions.get(id);
    if (!session || session.metadata.status === "done" || session.metadata.status === "failed") return false;
    if (session.metadata.provider !== "opencode" || !signal.requestId) return true;
    const known = session.providerTurnGenerations?.get(signal.requestId);
    return known === undefined
      ? signal.event === "session.status:busy" || signal.event === "session.status:retry"
      : known === (session.inputGeneration ?? 0) && session.providerTurnId === signal.requestId;
  }

  /** `source` "hook" is the agent's own lifecycle hook (through the runtime gateway); "title" is its terminal title. */
  applyProviderSignal(id: string, signal: ProviderLifecycleSignal, source: "hook" | "title" = "hook"): boolean {
    const session = this.sessions.get(id);
    if (!session || session.metadata.status === "done" || session.metadata.status === "failed") return false;
    if (source === "hook" && !this.canApplyProviderSignal(id, signal)) return false;
    let startsProviderTurn = false;
    if (source === "hook" && session.metadata.provider === "opencode" && signal.requestId) {
      const turns = session.providerTurnGenerations ??= new Map();
      const generation = session.inputGeneration ?? 0;
      const known = turns.get(signal.requestId);
      const starts = signal.event === "session.status:busy" || signal.event === "session.status:retry";
      if (known !== undefined && (known !== generation || session.providerTurnId !== signal.requestId)) return false;
      if (known === undefined) {
        if (!starts) return false;
        startsProviderTurn = true;
        turns.set(signal.requestId, generation);
        session.providerTurnId = signal.requestId;
        while (turns.size > 64) turns.delete(turns.keys().next().value!);
      }
    }
    if (source === "hook") session.hookSignals = (session.hookSignals ?? 0) + 1;

    const threadId = normalizeThreadId(session.metadata.provider, signal.threadId);
    const threadChanged = Boolean(threadId && threadId !== session.threadId);
    if (threadId && this.resumedThreads.get(id) === null) this.resumedThreads.set(id, threadId);
    if (threadChanged) {
      session.threadId = threadId;
      this.schedulePersistence();
    }

    const nextStatus = signal.state;
    // A turn starts when the agent moves to working; wait_for_agent compares it with the last delivered prompt.
    if (nextStatus === "working" && (startsProviderTurn || (session.acceptedLifecycleState ?? session.metadata.status) !== "working")) session.turnStarts = (session.turnStarts ?? 0) + 1;
    session.acceptedLifecycleState = nextStatus;
    // A new turn: the previous answer is no longer this turn's.
    if (nextStatus === "working") { session.answer = undefined; session.answerTurnGeneration = session.inputGeneration ?? 0; }
    // Result correlation remains active when the user disables lifecycle UI updates.
    if (!this.lifecycleHooksEnabled) return true;
    const completed = nextStatus === "idle" && ["Stop", "StopFailure", "StopCancelled"].includes(signal.event ?? "");
    const nextTurnCompleted = nextStatus === "working" ? false : completed || Boolean(session.metadata.turnCompleted);
    if (!threadChanged && session.metadata.status === nextStatus && Boolean(session.metadata.turnCompleted) === nextTurnCompleted) return true;
    session.metadata.status = nextStatus;
    session.metadata.turnCompleted = nextTurnCompleted;
    this.emitSession(session.metadata);
    return true;
  }

  /** Result transport completion is independent of the person's lifecycle UI preference. */
  resultLifecycleState(id: string): ProviderLifecycleSignal["state"] | null {
    const session = this.sessions.get(id);
    return session?.captureResult ? session.acceptedLifecycleState ?? null : null;
  }

  /** Capture before starting an asynchronous answer read when the source has no provider turn id. */
  answerCaptureGeneration(id: string): number | null {
    const session = this.sessions.get(id);
    return session ? session.inputGeneration ?? 0 : null;
  }

  /**
   * Keeps a final answer only for its current turn/input generation. A no-hook source must pass the token captured
   * before its asynchronous read; an uncorrelated answer cannot acknowledge a newly submitted prompt.
   * In memory only, read back masked by answer(), never saved.
   */
  recordAnswer(id: string, result: { text: string; truncated: boolean }, correlation?: { turnId?: string | null; generation?: number }): void {
    const session = this.sessions.get(id);
    if (!session?.captureResult || typeof result?.text !== "string") return;
    const generation = session.inputGeneration ?? 0;
    if (correlation?.generation !== undefined && correlation.generation !== generation) return;
    if (session.metadata.provider === "opencode" && correlation && "turnId" in correlation) {
      if (!correlation.turnId || correlation.turnId !== session.providerTurnId || session.providerTurnGenerations?.get(correlation.turnId) !== generation) return;
    } else if (session.promptTurnMark !== undefined && correlation?.generation === undefined && session.answerTurnGeneration !== generation) return;
    session.answer = { text: result.text, truncated: result.truncated === true, at: Date.now() };
  }

  /** The last final answer (masked), or null when none was reported since the current turn started. */
  answer(id: string): { text: string; truncated: boolean; at: number } | null {
    const answer = this.sessions.get(id)?.answer;
    if (!answer) return null;
    return { ...answer, text: this.redactSecretsTail(answer.text, answer.text.length + 1) };
  }

  setLifecycleHooksEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    if (this.lifecycleHooksEnabled === next) return;
    this.lifecycleHooksEnabled = next;
    if (next) return;
    for (const session of this.sessions.values()) {
      session.lifecycle = null;
      if (
        session.metadata.provider === "terminal"
        || session.metadata.status === "done"
        || session.metadata.status === "failed"
        || session.metadata.status === "unavailable"
      ) continue;
      session.metadata.status = "unavailable";
      this.emitSession(session.metadata);
    }
  }

  /**
   * Reports whether the session's card renders live output. A hidden session
   * keeps appending to its scrollback and advancing outputOffset, so history
   * stays canonical, and keeps emitting terminalData for the in-process
   * observers; only the renderer's delivery of that stream is gated.
   */
  setVisible(id: string, visible: boolean): void {
    if (typeof id !== "string" || typeof visible !== "boolean") return;
    const session = this.sessions.get(id);
    if (!session) return;
    const hiddenSince = this.hiddenSinceOffset.get(id);
    if (visible === (hiddenSince === undefined)) return;

    if (!visible) {
      // Visible -> hidden: flush the batch queued while the card was still
      // live instead of dropping it. It was produced while visible, so it goes
      // to every consumer; from here on flushOutput addresses the observers
      // only. Nothing is lost, and nothing is duplicated because the renderer
      // dedups by absolute offset.
      this.flushOutput(id, session);
      this.hiddenSinceOffset.set(id, session.outputOffset);
      return;
    }

    // Hidden -> visible: first hand the observers whatever is still batched
    // (still addressed to them alone, since the card has not seen it and the
    // replay below covers it), then replay the output produced since
    // hiddenSince, ending at the current outputOffset, to the renderer alone.
    // The card already wrote everything up to hiddenSince (the batch pending at
    // hide time was flushed to it), and it drops anything it already wrote (its
    // offset is absolute; features/terminal/terminalOutput.ts), so the missed
    // suffix arrives — once — without resending the history before it. The
    // observers get no replay: they already received every chunk.
    //
    // The stretch fits the ring: keepHiddenCardWhole hands a hidden card what
    // it missed before the ring could drop any of it, so this replay starts
    // exactly where the card stopped and its terminal state stays the
    // session's. Should a hole ever reach the renderer anyway, the consumer
    // derives it from the offsets and marks it instead of stitching it.
    this.flushOutput(id, session);
    this.hiddenSinceOffset.delete(id);
    if (hiddenSince === undefined || session.outputOffset === hiddenSince) return;
    const data = scrollbackTail(session, session.outputOffset - hiddenSince);
    if (data.length > 0) {
      this.emit(IPC.terminalData, { id, data, outputOffset: session.outputOffset, audience: "renderer" });
    }
  }

  /** Serializes this card's run cleanup across exit/restart; callbacks retain their specific launch ownership. */
  private cleanupLaunchFiles(session: ManagedSession): Promise<void> {
    const cleanup = session.launchCleanup;
    session.launchCleanup = null;
    const previous = session.launchCleanupPending;
    if (!cleanup) return previous ?? Promise.resolve();
    const pending = (async (): Promise<void> => {
      if (previous) await previous.catch(() => undefined);
      await cleanup();
    })();
    session.launchCleanupPending = pending;
    void pending.finally(() => {
      if (session.launchCleanupPending === pending) delete session.launchCleanupPending;
    }).catch(() => undefined);
    return pending;
  }

  /** Closing a card waits for producers of run files, not just the current process's adopted cleanup. */
  private async forgetLaunchFiles(session: ManagedSession): Promise<void> {
    while (session.launchTasks?.size) await Promise.allSettled([...session.launchTasks]);
    try { await this.cleanupLaunchFiles(session); }
    finally {
      const errors: unknown[] = [];
      // Different pipeline instances may share runsRoot; even their parent deletions must not overlap.
      for (const pipeline of session.launchFilePipelines ?? []) {
        try { await pipeline.forgetSession(session.metadata.id); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Launch file folders could not be removed.");
    }
  }

  /**
   * Closes a card. A card in a plugin environment releases it: `keepEnvironmentData` is the person's
   * answer to "Keep environment data?" (kept unless they said no). Quitting releases nothing.
   */
  dispose(id: string, options: { keepEnvironmentData?: boolean } = {}): void {
    if(this.isCheckpointRestoreActive(id)){this.checkpointRestore!.closes.set(id,options);return;}
    const session = this.sessions.get(id);
    if (!session) return;
    // A subagent belongs to its parent: closing the parent closes its subagents first (deepest first), so none keeps
    // running without an owner. Quitting disposes every card anyway.
    if (!this.quitting) {
      for (const child of [...this.sessions.values()]) {
        if (child.metadata.role === "subagent" && child.metadata.parentSessionId === id) this.dispose(child.metadata.id);
      }
    }

    this.flushOutput(id, session);
    this.sessions.delete(id);
    this.checkpointUnavailableGenerations.delete(id);
    this.inputWriteObservers.delete(id);
    this.reviewDiffTracker.forget(id);
    this.resumedThreads.delete(id);
    session.reviewWorkspace?.cleanup();
    delete session.reviewWorkspace;
    this.isolationStarts.delete(id);
    this.pendingIsolationReasons.delete(id);
    this.wakeLaunchWaiters(session);
    // Closed: an open report goes to the app; a pending audit runs and reports there.
    if (session.metadata.gitRisk) {
      const open = this.gitRisks.get(session.metadata.gitRisk.id);
      if (open) open.sessionId = null;
      this.emit(IPC.terminalGitRisk, { ...structuredClone(session.metadata.gitRisk), title: session.metadata.title });
    } else if (session.extras.gitAuditSince !== undefined && !this.quitting) {
      void this.auditGit(id, session);
    }
    this.hiddenSinceOffset.delete(id);
    this.launchContexts.delete(id);
    this.redaction.clear(`session:${id}`);
    this.releaseIsolation(id);
    session.launchToken += 1;
    // launchToken and launch waiters were invalidated above: pending preparation/wrapping can now unwind before
    // parent removal. Its original pipeline remains the owner even if the host configuration has since changed.
    void this.forgetLaunchFiles(session).catch(() => undefined);
    session.agentBrowser?.cleanup();
    session.agentRuntime?.cleanup();
    session.agentOrchestration?.cleanup();
    if (session.process) {
      const resumed=this.processTreePause.resume(session.process);
      if(resumed.failed)console.warn(`Budget-paused PTY ${id} could not be resumed before close.`,resumed.failed);
      try {
        session.process.kill();
      } catch (error) {
        console.warn(`PTY ${id} could not be killed cleanly.`, error);
      }
    }
    const environment = session.extras.environment;
    if (environment && this.environments) {
      if (!this.quitting) {
        void this.environments.release(environment, id, { keepData: options.keepEnvironmentData ?? environment.kind!=="worktree", reason: "closed" });
      } else if (this.sessionRestoreMode === "off") {
        // Nothing is saved, so the environment will not come back: stop its compute, keep its data.
        this.quitReleases.push(this.environments.release(environment, id, {
          keepData: true, reason: "quit", timeoutMs: QUIT_RELEASE_TIMEOUT_MS
        }));
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

  private restorePersistedSession(step: RestoreStep, resumed?: { ok: true } | { ok: false; reason: string }): void {
    let descriptor = step.record;
    if (this.sessions.has(descriptor.id)) return;
    // A saved subagent never comes back with more than its orchestrator may give (whatever its record says).
    if (descriptor.role === "subagent") {
      const parent = descriptor.parentSessionId ? this.sessions.get(descriptor.parentSessionId) : undefined;
      const ceiling = profileCeiling(parent?.metadata.profile ?? "auto");
      if (PROFILE_RANK[descriptor.profile] > PROFILE_RANK[ceiling]) descriptor = { ...descriptor, profile: ceiling };
    }
    const metadata: SessionMetadata = {
      id: descriptor.id,
      revision: 0,
      provider: descriptor.provider,
      profile: descriptor.profile,
      title: descriptor.title,
      titleCustomized: descriptor.titleCustomized,
      cwd: descriptor.cwd,
      position: descriptor.position,
      size: descriptor.size,
      role: descriptor.role,
      ...(descriptor.parentSessionId !== undefined ? { parentSessionId: descriptor.parentSessionId } : {}),
      ...(descriptor.taskScope ? {taskScope:{...descriptor.taskScope}} : {}),
      status: initialSessionStatus(descriptor.provider),
      startedAt: Date.now(),
      exitCode: null,
      failureDetails: null,
      ...(step.note ? { restoreNote: step.note } : {}),
      ...(descriptor.environment ? { environment: environmentBadge(descriptor.environment) } : {}),
      ...(descriptor.model !== undefined ? { model: descriptor.model } : {}),
      ...(descriptor.effort !== undefined ? { effort: descriptor.effort } : {}),
      ...(descriptor.reviewRequested !== undefined ? {reviewRequested:descriptor.reviewRequested} : {})
    };
    const extras: PersistedSessionExtras = {
      ...(descriptor.isolatedEnvironmentScopes ? {isolatedEnvironmentScopes:structuredClone(descriptor.isolatedEnvironmentScopes)} : {}),
      ...(descriptor.options ? { options: descriptor.options } : {}),
      ...(descriptor.environment ? { environment: descriptor.environment } : {}),
      ...(descriptor.environmentChoice && !descriptor.environment ? { environmentChoice: descriptor.environmentChoice } : {}),
      ...(descriptor.ownerPluginId ? { ownerPluginId: descriptor.ownerPluginId } : {}),
      ...(descriptor.gitAuditSince !== undefined ? { gitAuditSince: descriptor.gitAuditSince } : {})
    };

    let process: IPty | null = null;
    let agentBrowser: PreparedAgentBrowserPtyLaunch | null = null;
    let agentRuntime: PreparedAgentRuntimePtyLaunch | null = null;
    let agentOrchestration: PreparedOrchestrationPtyLaunch | null = null;
    let directoryReady = step.launch !== "stopped";
    if (step.launch === "stopped") {
      // A finished card comes back as it ended; a placed card whose environment
      // is unavailable is held with its reason and keeps its saved state.
      if (step.note === "environment-unavailable" && descriptor.environment) {
        extras.heldState = descriptor.lastState;
        metadata.status = "failed";
        metadata.exitCode = descriptor.exitCode ?? 1;
        metadata.failureDetails = resumed && !resumed.ok
          ? `Environment stopped: ${resumed.reason}`
          : this.environments?.unavailableReason(descriptor.environment)
            ?? `Needs plugin ${descriptor.environment.pluginId} (${descriptor.environment.label}). It was not started locally.`;
      } else if (step.note === "environment-pending" && extras.environmentChoice) {
        // The app quit while the plugin prepared it: whatever it prepared then is unknown, so nothing runs
        // until the person restarts it, which prepares again with the saved options.
        extras.heldState = descriptor.lastState;
        metadata.status = "failed";
        metadata.exitCode = descriptor.exitCode ?? 1;
        const choice = extras.environmentChoice;
        metadata.failureDetails = this.environments?.available(choice)
          ? `Its environment (${choice.kind} from plugin ${choice.pluginId}) was being prepared when CanvasTTY closed. It was not started locally; Restart prepares it again.`
          : `${this.pendingEnvironmentReason(choice)} It was not started locally.`;
      } else if (step.note === "plugin-unavailable" && descriptor.options) {
        extras.heldState = descriptor.lastState;
        metadata.status = "failed";
        metadata.exitCode = descriptor.exitCode ?? 1;
        metadata.failureDetails = `Launch refused: ${missingLaunchPlugins(this.unavailableLaunchPlugins(descriptor.options))}`;
      } else {
        metadata.exitCode = descriptor.exitCode ?? (descriptor.lastState === "exited" ? 0 : 1);
        metadata.status = metadata.exitCode === 0 ? "done" : "failed";
        if (extras.environmentChoice && metadata.status === "failed") {
          metadata.failureDetails = "Its environment was not prepared, so it was not started locally; Restart prepares it again.";
        }
      }
    }
    if (directoryReady) {
      try {
        assertDirectory(descriptor.cwd);
      } catch (error) {
        directoryReady = false;
        metadata.status = "failed";
        metadata.exitCode = 1;
        metadata.failureDetails = error instanceof Error ? error.message : String(error);
      }
    }
    const resume: ResumeRequest = step.launch === "stopped" ? null : step.launch;
    const restoreTaskRootId=descriptor.taskScope?.id
      ?? (descriptor.parentSessionId && this.sessions.has(descriptor.parentSessionId)
        ? this.taskScopeFor(descriptor.parentSessionId).id
        : descriptor.id);
    const deferForBudget=this.budgetPausedTaskRoots.has(restoreTaskRootId);
    const awaitMeasuredGrid = directoryReady
      && (deferForBudget || descriptor.provider === "grok" && this.providerClis.get(descriptor.provider).state === "available");

    const contributed = directoryReady && !awaitMeasuredGrid
      && (Boolean(extras.options) || Boolean(extras.environment) || this.policyApplies(descriptor.provider));
    if (directoryReady && !awaitMeasuredGrid && !contributed) {
      try {
        this.startingModels.set(descriptor.id, { ...(metadata.model !== undefined ? { model: metadata.model } : {}),
          ...(metadata.effort !== undefined ? { effort: metadata.effort } : {}) });
        let launched: ReturnType<TerminalManager["spawnProcess"]>;
        try {
          launched = this.spawnProcess(
          descriptor.id,
          descriptor.provider,
          descriptor.profile,
          descriptor.cwd,
          INITIAL_TERMINAL_COLS,
          INITIAL_TERMINAL_ROWS,
          resume,
          false,
          descriptor.role,
          undefined,
          null,
          descriptor.parentSessionId
          );
        } finally {
          this.startingModels.delete(descriptor.id);
        }
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

    // A card that started (or whose plugins are preparing its launch) comes back tied to
    // the conversation the plan chose (none for a fresh start); one that did not start
    // keeps its recorded id for Continue.
    const started = process !== null || awaitMeasuredGrid || contributed;
    const threadId = started ? step.threadId : descriptor.threadId;
    const session: ManagedSession = {
      metadata,
      process,
      cols: INITIAL_TERMINAL_COLS,
      rows: INITIAL_TERMINAL_ROWS,
      bufferChunks: [],
      bufferStart: 0,
      bufferLength: 0,
      outputOffset: 0,
      pendingOutput: [],
      pendingOutputChars: 0,
      agentBrowser,
      agentRuntime,
      agentOrchestration,
      lifecycle: this.lifecycleHooksEnabled
        ? createProviderLifecycleParser(descriptor.provider, descriptor.cwd)
        : null,
      awaitingInitialResize: awaitMeasuredGrid,
      resumeOnLaunch: awaitMeasuredGrid ? resume : null,
      ...(threadId ? { threadId } : {}),
      captureResult: false,
      extras,
      launchToken: 0,
      launchCleanup: null,
      restoringLaunch: awaitMeasuredGrid,
      environmentReady: resumed?.ok === true,
      restored: true,
      launchEpoch: 0,
      launchWaiters: new Set()
    };
    this.sessions.set(descriptor.id, session);
    this.adoptIsolationStart(descriptor.id, session);
    if (process) this.bindProcess(descriptor.id, session, process);
    if (contributed) this.launchContributed(descriptor.id, session, resume, "restore", undefined, true);
    const runtimeStatus = this.agentRuntime?.currentStatus(descriptor.id);
    if (runtimeStatus) session.metadata.status = runtimeStatus;
    // Restoring re-derives a persisted session's status, so a failure here is
    // state this launch found (a folder that vanished between runs), not
    // something that happened under the user — announcing it every launch
    // would notify about the same silent state again and again.
    this.emitSession(metadata, metadata.status === "failed" ? "restore" : null);
    if (extras.gitAuditSince !== undefined) void this.auditGit(descriptor.id, session);
  }

  /**
   * Audits the repositories under a session's folder for what its isolated agent left that runs outside the layer
   * (gitAudit.ts). Findings go on the card, or to the app when the card is gone; nothing is changed without the
   * person (resolveGitRisk). A clean audit ends the pending one.
   */
  private async auditGit(id: string, session: ManagedSession): Promise<void> {
    const since = session.extras.gitAuditSince;
    if (since === undefined) return;
    let repositories: GitRiskRepository[];
    try {
      repositories = await auditRepositories(session.metadata.cwd, since);
    } catch (error) {
      console.warn("CanvasTTY could not check the repositories an isolated agent worked in.", error);
      return;
    }
    const live = this.sessions.get(id) === session;
    const running = live && session.metadata.exitCode === null && this.isolationCleanups.has(id);
    if (repositories.length === 0) {
      // Still running isolated (a relaunch): its own audit follows when it ends.
      if (!running && session.metadata.gitRisk === undefined) delete session.extras.gitAuditSince;
      if (live) this.schedulePersistence();
      return;
    }
    const previous = session.metadata.gitRisk;
    if (previous) this.gitRisks.delete(previous.id);
    const report: GitRiskReport = {
      id: randomUUID(),
      cwd: session.metadata.cwd,
      repositories: repositories.map((repository) => ({
        path: repository.worktree,
        items: repository.items.map((item) => item.kind === "config"
          ? { ...item, value: this.redactSecrets(item.value).slice(0, 160) }
          : item)
      }))
    };
    this.gitRisks.set(report.id, { sessionId: live ? id : null, repositories });
    if (live) {
      session.metadata.gitRisk = report;
      this.emitSession(session.metadata);
      this.schedulePersistence();
    } else {
      this.emit(IPC.terminalGitRisk, { ...report, title: session.metadata.title });
    }
  }

  private adoptIsolationStart(id: string, session: ManagedSession): void {
    const started = this.isolationStarts.get(id);
    const reason = this.pendingIsolationReasons.get(id);
    if (started !== undefined) {
      this.isolationStarts.delete(id);
      session.extras.gitAuditSince ??= started;
    }
    if (reason !== undefined) {
      this.pendingIsolationReasons.delete(id);
      if (session.metadata.isolation) session.metadata.isolation = { ...session.metadata.isolation, reason };
    }
    if (started !== undefined || reason !== undefined) this.schedulePersistence();
  }

  /** The person's answer to a git risk report: neutralize removes what was found; keep leaves it. Both close it. */
  async resolveGitRisk(reportId: string, action: "neutralize" | "keep"): Promise<void> {
    const open = this.gitRisks.get(reportId);
    if (!open) throw new Error("This git warning is no longer open.");
    if (action === "neutralize") await neutralizeRepositories(open.repositories);
    this.gitRisks.delete(reportId);
    const session = open.sessionId ? this.sessions.get(open.sessionId) : undefined;
    if (!session || session.metadata.gitRisk?.id !== reportId) return;
    delete session.metadata.gitRisk;
    // A session still running isolated is audited from now on when it ends.
    if (this.isolationCleanups.has(session.metadata.id) && session.metadata.exitCode === null) session.extras.gitAuditSince = Date.now();
    else delete session.extras.gitAuditSince;
    this.emitSession(session.metadata);
    this.schedulePersistence();
  }

  private persistSessions(): Promise<void> {
    if (this.sessionRestoreMode === "off" || this.suppressPersistence || !this.sessionStore) {
      return Promise.resolve();
    }
    return this.sessionStore.replace(
      [...this.sessions.values()].filter((session) => !session.reviewWorkspace)
        .map((session) => persistedTerminalSession(session.metadata, session.threadId, session.extras))
    );
  }

  private schedulePersistence(): void {
    void this.persistSessions().catch((error) => {
      console.warn("CanvasTTY terminal window state could not be saved.", error);
    });
  }

  /**
   * Same as `schedulePersistence`, but coalesced: a drag fires `setBounds` many times a second, and each one
   * used to normalize, stringify and atomically rewrite the whole session store. Rapid geometry updates are
   * batched into a single write instead, `PERSISTENCE_DEBOUNCE_MS` after the last of them.
   */
  private scheduleBoundsPersistence(): void {
    if (this.persistenceTimer !== null) return;
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = null;
      void this.persistSessions().catch((error) => {
        console.warn("CanvasTTY terminal window state could not be saved.", error);
      });
    }, PERSISTENCE_DEBOUNCE_MS);
    // A background timer must never be the reason the process (or a test) stays alive.
    this.persistenceTimer.unref?.();
  }

  private emitSession(metadata: SessionMetadata, failureOrigin: FailureOrigin | null = null): void {
    metadata.revision += 1;
    this.emittingFailureOrigin = failureOrigin;
    const session = this.sessions.get(metadata.id);
    this.emit(IPC.terminalSession, { session: session ? publicSessionMetadata(session) : structuredClone(metadata) });
    // The emit callback is the only legitimate reader and has already run.
    this.emittingFailureOrigin = null;
  }

  private launchAwaitingSession(id: string, session: ManagedSession): void {
    if (!session.awaitingInitialResize) return;
    if(this.isSessionBudgetPaused(session)) {
      session.budgetDeferredLaunch=true;
      return;
    }
    session.awaitingInitialResize = false;
    session.budgetDeferredLaunch=false;
    const resume = session.resumeOnLaunch;
    session.resumeOnLaunch = null;
    if (this.contributed(session)) {
      this.launchContributed(id, session, resume, null, undefined, session.restoringLaunch);
      session.restoringLaunch = false;
      return;
    }
    try {
      const launched = this.spawnProcess(
        id,
        session.metadata.provider,
        session.metadata.profile,
        session.metadata.cwd,
        session.cols,
        session.rows,
        resume,
        session.captureResult,
        session.metadata.role,
        undefined,
        null,
        session.metadata.parentSessionId
      );
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
        if (launched.process) this.bindProcess(id, session, launched.process);
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
    this.emitSession(session.metadata);
    this.wakeLaunchWaiters(session);
  }

  private spawnProcess(
    id: string,
    provider: ProviderId,
    profile: CreateSessionRequest["profile"],
    cwd: string,
    cols = INITIAL_TERMINAL_COLS,
    rows = INITIAL_TERMINAL_ROWS,
    resume: ResumeRequest = null,
    captureResult = false,
    role: SessionRole = "agent",
    answerCaptureGrantExpiresAt?: number,
    contribution: LaunchContribution | null = null,
    parentSessionId?: string,
    taskProjectRoot?: string,
    reviewerControl?: ReadOnlyReviewerLaunch,
    captureReviewDiff = this.sessions.get(id)?.captureReviewDiff === true
  ): {
    process: IPty | null;
    agentBrowser: PreparedAgentBrowserPtyLaunch | null;
    agentRuntime: PreparedAgentRuntimePtyLaunch | null;
    agentOrchestration: PreparedOrchestrationPtyLaunch | null;
    failure: LaunchFailure | null;
  } {
    const none = { process: null, agentBrowser: null, agentRuntime: null, agentOrchestration: null };
    const projectRoot = taskProjectRoot ?? this.taskProjectRoot(cwd, parentSessionId);
    const decision = this.launchIsolation(id, provider, profile, role, null, projectRoot);
    if (decision.refuse) return { ...none, failure: { diagnostic: `Launch refused: ${decision.refuse}`, exitCode: 1 } };
    if (reviewerControl && (!decision.apply || decision.profile !== "plan")) {
      return { ...none, failure: { diagnostic: "A diff-only reviewer requires the operating-system isolation layer and a read-only Plan profile. The reviewer was not started.", exitCode: 1 } };
    }
    profile = decision.profile;
    const planned = this.planSpawn(id, provider, profile, cwd, resume, captureResult, role, answerCaptureGrantExpiresAt, contribution,
      reviewerControl ? undefined : this.personTrustedFolder(parentSessionId, cwd), false, decision.apply, Boolean(reviewerControl));
    if ("failure" in planned) {
      return { ...none, failure: planned.failure };
    }
    this.noteConfiguredMode(id, provider, profile, planned.env, planned.cwd);
    let spawn: { command: string; args: string[] | string; env: Record<string, string> } = planned;
    if (decision.apply) {
      try {
        spawn = this.wrapIsolated(id, provider, profile, planned, projectRoot, contribution?.accountHome, reviewerControl?.deniedReadPaths);
      } catch (error) {
        planned.cleanup();
        return { ...none, failure: { diagnostic: `Launch refused: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 } };
      }
    }
    try {
      this.assertCheckpointLaunchAllowed(planned.cwd);
      this.reviewDiffTracker.beforeSpawn(id, planned.cwd, captureReviewDiff, this.reviewParentDirectory(parentSessionId));
      const process = this.spawnPty(spawn.command, spawn.args, {
        name: "xterm-256color", cols, rows, cwd: planned.cwd, env: spawn.env
      });
      this.launchContexts.set(id, { cwd: planned.cwd, configDir: planned.env.CLAUDE_CONFIG_DIR ?? null });
      return {
        process,
        agentBrowser: planned.agentBrowser,
        agentRuntime: planned.agentRuntime,
        agentOrchestration: planned.agentOrchestration,
        failure: null
      };
    } catch (error) {
      this.reviewDiffTracker.forget(id);
      planned.cleanup();
      this.releaseIsolation(id);
      throw error;
    }
  }

  private reviewParentDirectory(parentSessionId?: string): string | undefined {
    if (!parentSessionId) return undefined;
    return this.launchContexts.get(parentSessionId)?.cwd ?? this.sessions.get(parentSessionId)?.metadata.cwd;
  }

  /** Only the launch-owned baseline can attribute a diff to this worker. */
  async readReviewDiff(id: string): Promise<string> {
    const baseline = this.reviewDiffTracker.baseline(id);
    const diff = await new GitCheckpoints(text => this.redactSecrets(text)).workingDiff(baseline.root, baseline.head);
    this.reviewDiffTracker.assertCurrent(id, baseline);
    return diff;
  }

  /** In the manual profile the CLI's own configuration decides: the card says when it skips approvals. */
  private noteConfiguredMode(id: string, provider: ProviderId, profile: LaunchProfile, env: Record<string, string>, cwd: string): void {
    const found = profile === "normal" && provider !== "terminal" ? configuredMode(provider, env, cwd) : null;
    const target = this.sessions.get(id)?.metadata;
    if (target) {
      if (found) target.configuredMode = found;
      else delete target.configuredMode;
    } else if (found) {
      this.pendingConfiguredModes.set(id, found);
    }
  }

  /** Delegated: a subagent, or a card a plugin started (not the person). */
  private isDelegated(id: string, role: SessionRole): boolean {
    return role === "subagent" || Boolean(this.sessions.get(id)?.extras.ownerPluginId ?? this.startingOwners.get(id));
  }

  /** Resolve the original task project for account and reviewer launches. */
  private taskProjectRoot(cwd: string, parentSessionId?: string): string {
    let current = parentSessionId ? this.sessions.get(parentSessionId) : undefined;
    let root: ManagedSession | undefined;
    const visited = new Set<string>();
    while (current && !visited.has(current.metadata.id)) {
      visited.add(current.metadata.id);
      root = current;
      current = current.metadata.parentSessionId ? this.sessions.get(current.metadata.parentSessionId) : undefined;
    }
    return root?.metadata.taskScope?.cwd ?? root?.metadata.cwd ?? cwd;
  }

  private decideIsolation(provider: ProviderId, profile: LaunchProfile, delegated: boolean, environment: { isolated: boolean; label: string } | null,
    cwd?: string): IsolationDecision {
    if (!this.isolation) return { apply: false, profile };
    const decision = this.isolation.decide({ provider, profile, delegated, environment, cwd });
    return decision;
  }

  /**
   * The isolation decision for one launch (the setting may have changed since the card was made); the card shows it,
   * and a subagent whose layer is gone runs in normal from now on.
   */
  private launchIsolation(id: string, provider: ProviderId, profile: LaunchProfile, role: SessionRole,
    environment: { isolated: boolean; label: string } | null, projectRoot?: string): IsolationDecision {
    const metadata = this.sessions.get(id)?.metadata;
    const taskProjectRoot = projectRoot ?? metadata?.taskScope?.cwd ?? this.taskProjectRoot(metadata?.cwd ?? "", metadata?.parentSessionId);
    const decision = this.decideIsolation(provider, profile, this.isDelegated(id, role), environment, taskProjectRoot);
    if (metadata && !decision.refuse) {
      if (decision.isolation) metadata.isolation = decision.isolation;
      else delete metadata.isolation;
      metadata.profile = decision.profile;
    }
    return decision;
  }

  /** Wraps a planned launch in the isolation layer (throws when the layer cannot start: the launch is refused). */
  private wrapIsolated(id: string, provider: ProviderId, profile: LaunchProfile,
    planned: { command: string; args: string[] | string; cwd: string; env: Record<string, string> }, taskProjectRoot: string,
    accountHome?: string, deniedReadPaths?: readonly string[]): { command: string; args: string[]; env: Record<string, string> } {
    if (!this.isolation) throw new LaunchRefusal("agent isolation is not configured; the agent was not started without it.");
    if (typeof planned.args === "string") throw new LaunchRefusal("a Windows batch launcher cannot run inside agent isolation.");
    const grant = controlGrantFolder(planned.env);
    const wrapped = this.isolation.wrap({
      sessionId: id,
      provider,
      cwd: planned.cwd,
      taskProjectRoot,
      command: planned.command,
      args: planned.args,
      env: planned.env,
      profile,
      ...(deniedReadPaths ? { deniedReadPaths } : {}),
      ...(deniedReadPaths ? { restrictHomeReads:true, runtimeReadable:[planned.command,
        ...(this.agentRuntime?.readableRuntimePaths?.() ?? [])] } : {}),
      ...(accountHome ? { accountHome } : {}),
      ...(grant ? { grantedPrivate: [grant] } : {})
    });
    this.releaseIsolation(id);
    this.isolationCleanups.set(id, wrapped.cleanup);
    if (wrapped.isolationReason) {
      const session = this.sessions.get(id);
      if (session) {
        if (session.metadata.isolation) session.metadata.isolation = { ...session.metadata.isolation, reason: wrapped.isolationReason };
        this.schedulePersistence();
        this.emitSession(session.metadata);
      } else {
        this.pendingIsolationReasons.set(id, wrapped.isolationReason);
      }
    }
    // Its repositories are audited once it ends (and on close or restore): from the earliest session not audited yet.
    // A first launch wraps before its card exists: adoptIsolationStart records it then.
    const session = this.sessions.get(id);
    if (session) {
      if (session.extras.gitAuditSince === undefined) {
        session.extras.gitAuditSince = Date.now();
        this.schedulePersistence();
      }
    } else if (!this.isolationStarts.has(id)) {
      this.isolationStarts.set(id, Date.now());
    }
    return { command: wrapped.command, args: wrapped.args, env: wrapped.env };
  }

  private releaseIsolation(id: string): void {
    const cleanup = this.isolationCleanups.get(id);
    if (!cleanup) return;
    this.isolationCleanups.delete(id);
    try { cleanup(); } catch { /* its folder is gone already */ }
  }

  /** Everything a launch needs short of the PTY, so an environment can wrap it first. */
  private planSpawn(
    id: string,
    provider: ProviderId,
    profile: CreateSessionRequest["profile"],
    cwd: string,
    resume: ResumeRequest,
    captureResult: boolean,
    role: SessionRole,
    answerCaptureGrantExpiresAt: number | undefined,
    contribution: LaunchContribution | null,
    trustedFolder?: string,
    environmentWrapped = false,
    isolated = false,
    reviewOnly = false
  ): PlannedSpawn | { failure: LaunchFailure } {
    const providerCli = provider === "terminal" ? undefined : this.providerClis.get(provider);
    if (providerCli?.state === "unavailable") return { failure: providerCli };
    if (resume === null || provider === "terminal") this.resumedThreads.delete(id);
    else this.resumedThreads.set(id, typeof resume === "object" ? resume.threadId : null);
    // What decides whether Claude's lifecycle hooks may go over HTTP (ClaudeHttpHooks.ts): where and how it runs.
    const claudeHttp = !reviewOnly && provider === "claude" && providerCli?.state === "available" ? {
      executable: providerCli.executable,
      profile,
      environmentWrapped,
      env: { ...terminalEnvironment(), ...providerCli.environment, ...(contribution?.env ?? {}) },
      args: contribution?.args ?? [],
      cwd,
    } : undefined;
    const agentRuntime = provider === "terminal"
      ? null
      : this.agentRuntime?.prepareLaunch({ terminalSessionId: id, provider, cwd,
        ...(captureResult || reviewOnly ? { captureResult: true } : {}),
        ...(reviewOnly ? { decisions: false } : {}),
        ...(claudeHttp ? { claudeHttp } : {}),
        ...(answerCaptureGrantExpiresAt === undefined ? {} : { answerCaptureGrantExpiresAt }) }) ?? null;
    let pluginTools: string[] = [];
    try {
      pluginTools = provider === "terminal" || reviewOnly ? [] : this.pluginToolNames(role, provider);
    } catch {
      // Plugins never block a launch; the session simply gets no plugin tools.
    }
    const bridged = role === "orchestrator" || pluginTools.length > 0;
    const agentOrchestration = !reviewOnly && bridged && this.agentOrchestration?.isEnabled
      ? this.agentOrchestration.prepareLaunch({ terminalSessionId: id })
      : null;
    let agentBrowser: PreparedAgentBrowserPtyLaunch | null = null;
    const cleanup = (): void => {
      agentBrowser?.cleanup();
      agentRuntime?.cleanup();
      agentOrchestration?.cleanup();
    };
    try {
      // omp and pi take no browser bridge, exactly like grok: the adapter chain below
      // ends in the Kimi MCP configuration, which would hand them foreign launch flags.
      // cursor stays out too until its CLI grows a measured browser adapter,
      // and minimax until its MCP configuration is wired (plain PTY for now).
      // devin is cloud-session oriented and takes no browser adapter yet,
      // and antigravity keeps plain PTY integration for the same reason.
      agentBrowser = reviewOnly || provider === "terminal" || provider === "grok" || provider === "omp" || provider === "pi" || provider === "cursor" || provider === "minimax" || provider === "devin" || provider === "antigravity"
        ? null
        : this.agentBrowser?.prepareLaunch({
          terminalSessionId: id,
          provider,
          cwd,
          ...(bridged ? {
            includeOrchestration: true,
            orchestrationTools: [...(role === "orchestrator" ? ORCHESTRATION_TOOL_NAMES : []), ...pluginTools]
          } : {})
        }) ?? null;
      const baseEnvironment = terminalEnvironment();
      const browserEnvironment = agentBrowser?.environment ?? {};
      const runtimeEnvironment = agentRuntime?.environment ?? {};
      const orchestrationEnvironment = agentOrchestration?.environment ?? {};
      const providerEnvironment: Record<string, string> = {
        ...(provider === "opencode"
          ? mergeOpenCodeLaunchEnvironment(browserEnvironment, runtimeEnvironment)
          : { ...browserEnvironment, ...runtimeEnvironment }),
        ...orchestrationEnvironment,
        // Orchestrators alone learn where the control descriptor and CLI are.
        ...(!reviewOnly ? controlEnvironment(role, this.controlConnection, id) : {})
      };
      // OpenCode: the project folder in its other Unicode spelling is still this folder, not an external one.
      if (provider === "opencode") Object.assign(providerEnvironment, openCodeProjectFolderEnvironment({ ...baseEnvironment, ...providerEnvironment }, cwd));
      const providerArgs = [...(agentRuntime?.args ?? []), ...(agentBrowser?.args ?? [])];
      // Stable terminal observations for the CLI controller; leave ordinary launches unchanged.
      if (captureResult && provider === "codex") providerArgs.push("-c", "tui.animations=false");
      // A Codex subagent in the person's folder is not asked to trust it again (this run only, never ~/.codex).
      if (provider === "codex" && trustedFolder) providerArgs.push(...codexTrustArguments([trustedFolder]));
      // Plugin arguments follow the core's own and precede the resume selection.
      if (contribution) providerArgs.push(...contribution.args);
      const launch = resolveTerminalLaunch(provider, profile, providerArgs, {
        shortcuts: this.keyboardShortcuts,
        environment: { ...baseEnvironment, ...providerEnvironment },
        ...(providerCli ? { providerCli } : {}),
        resumePrevious: resume !== null,
        ...(resume && typeof resume === "object" ? { resumeThreadId: resume.threadId } : {}),
        ...(contribution?.thirdPartyModel ? { thirdPartyModel: true } : {}),
        ...(agentRuntime?.decisions === true && this.baseProtectionOn() && !environmentWrapped ? { shellGuarded: true } : {}),
        ...(isolated ? { isolated: true } : {}),
        cwd,
        ...this.launchModelOf(id)
      });
      const session = this.sessions.get(id);
      if (session) setAutoDowngraded(session.metadata, profile === "auto" && contribution?.thirdPartyModel === true);
      // A plugin may add to the person's environment, never replace what the core sets for this launch.
      const contributedEnvironment = contribution?.env ?? {};
      const coreNames = new Set([...Object.keys(providerEnvironment), ...Object.keys(launch.environment ?? {})].map((key) => envKey(key)));
      const collision = Object.keys(contributedEnvironment).find((key) => coreNames.has(envKey(key)));
      if (collision) {
        throw new Error(`Launch refused: ${contribution!.envSources[collision]} sets ${collision}, which CanvasTTY sets for this launch.`);
      }
      const launchEnvironment = { ...contributedEnvironment, ...providerEnvironment, ...launch.environment };
      return {
        command: launch.command,
        args: launch.args,
        cwd,
        // The app's own PWD names another folder; a CLI that reads PWD must see where it runs.
        env: { ...baseEnvironment, ...launchEnvironment, PWD: cwd },
        launchEnvironment,
        agentBrowser,
        agentRuntime,
        agentOrchestration,
        cleanup
      };
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  /** The model and effort this card's launches ask the CLI for. */
  private launchModelOf(id: string): LaunchModelChoice {
    const starting = this.startingModels.get(id);
    if (starting) return starting;
    const metadata = this.sessions.get(id)?.metadata;
    return {
      ...(metadata?.model !== undefined ? { model: metadata.model } : {}),
      ...(metadata?.effort !== undefined ? { effort: metadata.effort } : {})
    };
  }

  /**
   * For a subagent: the folder the person chose for the top-level agent it descends from, when that agent runs on this
   * computer, and this subagent's folder is it or inside it. The subagent's own real folder then needs no trust answer
   * of the person again; unreadable counts as outside.
   */
  private personTrustedFolder(parentSessionId: string | undefined, cwd: string): string | undefined {
    let root: ManagedSession | undefined;
    for (let depth = 0, next = parentSessionId; next !== undefined && depth < 64; depth++) {
      root = this.sessions.get(next);
      if (!root) return undefined;
      next = root.metadata.parentSessionId;
    }
    if (!root || root.extras.environment) return undefined;
    try {
      const folder = realpathSync(cwd);
      return isPathInside(realpathSync(root.metadata.cwd), folder) ? folder : undefined;
    } catch {
      return undefined;
    }
  }

  private contributed(session: ManagedSession): boolean {
    return Boolean(session.extras.options) || Boolean(session.extras.environment) || Boolean(session.extras.environmentChoice)
      || this.policyApplies(session.metadata.provider);
  }

  /** A trusted plugin's launch policy applies to this agent: its launches wait for the policy's answer. */
  private policyApplies(provider: ProviderId): boolean {
    try { return this.launchPipeline?.hasPolicy?.(provider) === true; } catch { return false; }
  }

  private pendingEnvironmentReason(choice: SessionEnvironmentChoice): string {
    return `Needs plugin ${choice.pluginId} (${choice.kind}) to prepare its environment; it is disabled, removed, or its native code is not trusted.`;
  }

  private environmentUsable(environment: PersistedEnvironmentRef): boolean {
    return this.environments?.available(environment) ?? false;
  }

  private unavailableLaunchPlugins(options: Record<string, unknown> | undefined): string[] {
    if (!options) return [];
    return this.launchPipeline ? this.launchPipeline.unavailable(options) : Object.keys(options).sort();
  }

  /**
   * Launches through plugins: the environment is prepared (or resumed), the chosen launch services
   * contribute, and the environment wraps the command. The card waits until they answer; a refusal,
   * timeout, error or conflict leaves it failed with the reason, and nothing runs locally instead.
   */
  private launchContributed(
    id: string,
    session: ManagedSession,
    resume: ResumeRequest,
    failureOrigin: FailureOrigin | null,
    answerCaptureGrantExpiresAt?: number,
    restoring = false
  ): void {
    const token = ++session.launchToken;
    const { metadata } = session;
    const tasks = session.launchTasks ??= new Set();
    // Register before invoking plugin code, which may synchronously close or restart its card.
    const task = Promise.resolve().then(() => {
      this.assertCheckpointLaunchAllowed(metadata.cwd,true);
      return this.runContributedLaunch(id, session, token, resume, restoring, answerCaptureGrantExpiresAt);
    })
      .catch((error: unknown): LaunchOutcome => {
        metadata.failureDetails = this.redactSecrets(`Launch refused: ${error instanceof Error ? error.message : String(error)}`);
        return "failed";
      })
      .then((outcome) => {
        if (outcome === "superseded" || this.sessions.get(id) !== session || session.launchToken !== token) return;
        if (outcome === "failed" && metadata.status !== "failed") {
          metadata.status = "failed";
          metadata.exitCode = 1;
        }
        this.emitSession(metadata, outcome === "failed" ? failureOrigin : null);
        this.schedulePersistence();
      })
      .finally(() => { tasks.delete(task); this.wakeLaunchWaiters(session); });
    tasks.add(task);
    void task.catch(() => undefined);
  }

  private async runContributedLaunch(
    id: string,
    session: ManagedSession,
    token: number,
    resume: ResumeRequest,
    restoring: boolean,
    answerCaptureGrantExpiresAt: number | undefined
  ): Promise<LaunchOutcome> {
    const { metadata } = session;
    const live = (): boolean => this.sessions.get(id) === session && session.launchToken === token && !session.process;
    const waitIfBudgetPaused = async (): Promise<boolean> => {
      while(this.isSessionBudgetPaused(session)) {
        if(!await this.awaitBudgetResume(session))return false;
      }
      return live();
    };
    const refuse = (reason: string): LaunchOutcome => {
      // "Launch refused" leads, so the failure summary quotes the reason as the cause.
      metadata.failureDetails = this.redactSecrets(`Launch refused: ${reason}`);
      return "failed";
    };
    const environments = this.environments;
    const requestedCwd=metadata.cwd;

    if(this.isSessionBudgetPaused(session) && !await waitIfBudgetPaused())return "superseded";
    if(!live())return "superseded";

    // 1. Place a new session where the person chose. The choice stays saved with the card until the plugin has
    // prepared it, so a card whose preparation was cut short (quit, crash) or failed never restores locally.
    const choice = session.extras.environmentChoice;
    if (choice && !session.extras.environment) {
      if (!environments) return refuse("plugin environments are not available.");
      const placed = await environments.prepare({ sessionId: id, provider: metadata.provider, cwd: metadata.cwd, choice,
        projectRoot:metadata.taskScope?.cwd ?? this.taskProjectRoot(metadata.cwd,metadata.parentSessionId) });
      if (!live()) {
        // An answer for a launch that no longer exists (the card was closed or restarted, or the app is quitting)
        // is never adopted or saved: nobody used it, so it is released at once and nothing is kept.
        if (placed.ok) void environments.release(placed.environment, id, { keepData: false, reason: "closed" });
        return "superseded";
      }
      if(this.isSessionBudgetPaused(session) && !await waitIfBudgetPaused()) {
        if(placed.ok)void environments.release(placed.environment,id,{keepData:false,reason:"closed"});
        return "superseded";
      }
      if(!live()) {
        if(placed.ok)void environments.release(placed.environment,id,{keepData:false,reason:"closed"});
        return "superseded";
      }
      if (!placed.ok) return refuse(placed.reason);
      delete session.extras.environmentChoice;
      session.environmentReady = true;
      session.extras.environment = placed.environment;
      metadata.environment = environmentBadge(placed.environment);
      if (placed.cwd && placed.cwd !== metadata.cwd) {
        metadata.cwd = placed.cwd;
        session.lifecycle = this.lifecycleHooksEnabled
          ? createProviderLifecycleParser(metadata.provider, metadata.cwd)
          : null;
      }
      this.schedulePersistence();
    }

    // 2. A saved environment resumes before its first launch in this run.
    const environment = session.extras.environment;
    if (environment && !session.environmentReady) {
      if (!environments?.available(environment)) {
        return refuse(environments?.unavailableReason(environment) ?? `needs plugin ${environment.pluginId}; it was not started locally.`);
      }
      const resumed = await environments.resume(environment, id);
      if (!live()) return "superseded";
      if(this.isSessionBudgetPaused(session) && !await waitIfBudgetPaused())return "superseded";
      if(!live())return "superseded";
      if (!resumed.ok) return refuse(`environment stopped: ${resumed.reason}`);
      session.environmentReady = true;
    }

    // 3. Chosen launch contributors, and the launch policies that apply.
    let contribution: LaunchContribution | null = null;
    let adopted = false;
    let plannedCleanup: (() => void) | undefined;
    try {
      const trustedFolder = session.extras.environment ? undefined : this.personTrustedFolder(metadata.parentSessionId, metadata.cwd);
      if (session.extras.options || this.policyApplies(metadata.provider)) {
        const pipeline = this.launchPipeline;
        if (!pipeline) return refuse(missingLaunchPlugins(Object.keys(session.extras.options ?? {})));
        (session.launchFilePipelines ??= new Set()).add(pipeline);
        const placedIn = session.extras.environment;
        const prepared = await pipeline.prepare({
          sessionId: id,
          provider: metadata.provider,
          profile: metadata.profile,
          role: metadata.role,
          cwd: metadata.cwd,
          ...(metadata.parentSessionId !== undefined ? { parentSessionId: metadata.parentSessionId } : {}),
          restoring,
          resume: resume !== null,
          options: structuredClone(session.extras.options ?? {}) as Record<string, Record<string, boolean | string>>,
          environment: placedIn ? { pluginId: placedIn.pluginId, kind: placedIn.kind } : null,
          ...(trustedFolder ? { trustedFolder } : {})
        });
        if (prepared.ok) contribution = prepared;
        if (!live()) return "superseded";
        if (this.isSessionBudgetPaused(session) && !await waitIfBudgetPaused()) return "superseded";
        if (!live()) return "superseded";
        if (!prepared.ok) return refuse(prepared.reason);
        session.accountId=prepared.accountId ?? selectedAccountId(session.extras.options);
        session.accountHome=prepared.accountHome;
        this.addLaunchSecrets(session, prepared.secrets);
      }

      // 4. What the environment keeps of CanvasTTY's protection, and the isolation layer for this launch.
      const keeps = environment ? environments?.keeps?.(environment) ?? {} : {};
      const isolatedEnvironment=Boolean(environment && keeps.isolated===true);
      if (environment && keeps.launch !== true && metadata.profile !== "normal") {
        return refuse(`${environment.label} does not pass the launch on unchanged (the plugin does not declare it), so the ${metadata.profile} profile's settings and CanvasTTY's hooks would not reach the agent there. Launch it in normal, or use an environment that keeps them.`);
      }
      const taskProjectRoot = metadata.taskScope?.cwd ?? this.taskProjectRoot(metadata.cwd, metadata.parentSessionId);
      const decision = this.launchIsolation(id, metadata.provider, metadata.profile, metadata.role,
        environment ? { isolated: keeps.isolated === true, label: environment.label } : null, taskProjectRoot);
      if (decision.refuse) {
        return refuse(decision.refuse);
      }
      if (environment && keeps.launch !== true) {
        metadata.isolation = { ...(metadata.isolation ?? { state: "environment" }),
          reason: `${metadata.isolation?.reason ? `${metadata.isolation.reason} ` : ""}Base protection and CanvasTTY's hooks do not reach the agent in ${environment.label}.` };
      }

      // 5. The host spawns the PTY; an environment only rewrites what is spawned, and the isolation layer wraps that.
      let planned: PlannedSpawn | { failure: LaunchFailure };
      try {
        planned = this.planSpawn(id, metadata.provider, decision.profile, metadata.cwd, resume,
          session.captureResult, metadata.role, answerCaptureGrantExpiresAt, contribution, trustedFolder, Boolean(environment), decision.apply);
      } catch (error) {
        metadata.failureDetails = this.redactSecrets(error instanceof Error ? error.message : String(error));
        return "failed";
      }
      if ("failure" in planned) {
        applyLaunchFailure(metadata, planned.failure);
        return "failed";
      }
      plannedCleanup = planned.cleanup;
      this.noteConfiguredMode(id, metadata.provider, decision.profile, planned.env, planned.cwd);
      let spawn: { command: string; args: string[] | string; cwd: string; env: Record<string, string> } = planned;
      if (environment && environments) {
        if (typeof planned.args === "string") {
          return refuse("this provider's Windows batch launcher cannot run in a plugin environment.");
        }
        const secretValues = new Set(contribution?.secrets ?? []);
        const secretEnvNames = Object.keys(contribution?.env ?? {}).filter((key) => secretValues.has(contribution!.env[key]!));
        // The environment sees the launch's own variables, never CanvasTTY's reserved ones or secret values.
        const visible = Object.fromEntries(Object.entries(planned.launchEnvironment)
          .filter(([key]) => !RESERVED_ENV.test(key) && !secretEnvNames.includes(key)));
        const wrapped = await environments.wrap(environment, {
          sessionId: id,
          provider: metadata.provider,
          launch: { command: planned.command, args: planned.args, env: visible, cwd: planned.cwd },
          secretEnvNames,
          takenEnv: new Set(Object.keys(planned.launchEnvironment)),
          path: launchSearchPath(planned.env)
        });
        if (!live()) {
          return "superseded";
        }
        if(this.isSessionBudgetPaused(session) && !await waitIfBudgetPaused()) {
          return "superseded";
        }
        if(!live()) {
          return "superseded";
        }
        if (!wrapped.ok) {
          return refuse(wrapped.reason);
        }
        this.addLaunchSecrets(session, wrapped.secrets);
        spawn = { command: wrapped.command, args: wrapped.args, cwd: wrapped.cwd,
          env: { ...planned.env, ...(wrapped.cwd !== planned.cwd ? { PWD: wrapped.cwd } : {}), ...wrapped.env } };
      }
      if (decision.apply) {
        try {
          spawn = { ...this.wrapIsolated(id, metadata.provider, decision.profile, spawn, taskProjectRoot, contribution?.accountHome, undefined), cwd: spawn.cwd };
        } catch (error) {
          return refuse(error instanceof Error ? error.message : String(error));
        }
      }
      if(this.isSessionBudgetPaused(session) && !await waitIfBudgetPaused()) {
        return "superseded";
      }
      if(!live()) {
        return "superseded";
      }
      let process: IPty;
      try {
        this.assertCheckpointLaunchAllowed(spawn.cwd);
        this.retryLaunchValidators.get(id)?.();
        this.reviewDiffTracker.beforeSpawn(id, spawn.cwd, session.captureReviewDiff === true, this.reviewParentDirectory(metadata.parentSessionId));
        process = this.spawnPty(spawn.command, spawn.args, {
          name: "xterm-256color", cols: session.cols, rows: session.rows, cwd: spawn.cwd, env: spawn.env
        });
      } catch (error) {
        this.reviewDiffTracker.forget(id);
        this.releaseIsolation(id);
        metadata.failureDetails = this.redactSecrets(error instanceof Error ? error.message : String(error));
        return "failed";
      }
      session.process = process;
      if(environment)session.extras.isolatedEnvironmentScopes ??= {roots:[],ambiguous:false};
      if(isolatedEnvironment) {
        const evidence=session.extras.isolatedEnvironmentScopes!;
        // Keep the declaration used for this launch, never re-read a changed/removed plugin at restore time.
        for(const path of [requestedCwd,taskProjectRoot,metadata.cwd,spawn.cwd]) {
          try {
            const root=realpathSync(path);
            if(!evidence.roots.includes(root)) {
              if(evidence.roots.length<32)evidence.roots.push(root);else evidence.ambiguous=true;
            }
          } catch {evidence.ambiguous=true;}
        }
      }
      if (planned.launchEnvironment.CANVASTTY_CODEX_KEYBOARD) {
        metadata.nativeEditor = JSON.parse(planned.launchEnvironment.CANVASTTY_CODEX_KEYBOARD);
      } else {
        delete metadata.nativeEditor;
      }
      this.launchContexts.set(id, { cwd: spawn.cwd, configDir: spawn.env.CLAUDE_CONFIG_DIR ?? null });
      session.agentBrowser = planned.agentBrowser;
      session.agentRuntime = planned.agentRuntime;
      session.agentOrchestration = planned.agentOrchestration;
      session.launchCleanup = contribution?.cleanup ?? null;
      adopted = true;
      metadata.status = initialSessionStatus(metadata.provider);
      metadata.exitCode = null;
      metadata.failureDetails = null;
      this.bindProcess(id, session, process);
      const runtimeStatus = this.agentRuntime?.currentStatus(id);
      if (runtimeStatus) metadata.status = runtimeStatus;
      if (environment) this.describeEnvironment(id, session, environment);
      return "launched";
    } finally {
      // Unadopted resources remain owned by this tracked launch, including throws during plugin wrapping.
      if (!adopted) {
        try { plannedCleanup?.(); }
        finally { await contribution?.cleanup().catch(() => undefined); }
      }
    }
  }

  private addLaunchSecrets(session: ManagedSession, secrets: readonly string[]): void {
    this.redaction.add(`session:${session.metadata.id}`, secrets);
  }

  /** Refreshes the card badge from the plugin (for example the worktree's current branch). */
  private describeEnvironment(id: string, session: ManagedSession, environment: PersistedEnvironmentRef): void {
    void this.environments?.describe(environment, id).then((described) => {
      if (!described || this.sessions.get(id) !== session || session.extras.environment !== environment) return;
      environment.label = described.label;
      session.metadata.environment = { ...environmentBadge(environment), ...(described.detail ? { detail: described.detail } : {}) };
      this.emitSession(session.metadata);
      this.schedulePersistence();
    }).catch(() => undefined);
  }

  private bindProcess(id: string, session: ManagedSession, process: IPty): void {
    session.agentBrowser?.retainUntilExit?.();
    process.onData((data) => {
      const current = this.sessions.get(id);
      if (!current || current !== session || current.process !== process) return;

      // OpenCode creates its first conversation only after submission, so a fresh home screen has no
      // session.created hook yet. Its rendered prompt and command hints are the startup readiness signal.
      if (current.metadata.provider === "opencode" && !current.cliInputReady) {
        current.readinessOutput = ((current.readinessOutput ?? "") + data).slice(-16_000);
        const screen = stripVTControlCharacters(current.readinessOutput);
        if (/Ask anything[….]/u.test(screen) && /ctrl\+p\s*commands/u.test(screen)) {
          current.cliInputReady = true;
          delete current.readinessOutput;
        }
      }
      const lifecycleState = current.lifecycle?.push(data);
      if (lifecycleState) current.titleState = lifecycleState;
      if (lifecycleState && !titleDefersToHooks(current, lifecycleState)) {
        this.applyProviderSignal(id, { kind: "lifecycle", state: lifecycleState }, "title");
      }
      this.keepHiddenCardWhole(id, current, data);
      appendScrollback(current, data);
      this.keepHiddenCardWhole(id, current, null, data);
      this.queueOutput(id, current, data);
    });

    let exited!: () => void;
    this.liveProcesses.set(process, new Promise<void>((resolve) => { exited = resolve; }));
    process.onExit(({ exitCode, signal }) => {
      this.liveProcesses.delete(process);
      exited();
      const current = this.sessions.get(id);
      if (!current || current !== session || current.process !== process) return;
      // node-pty calls this from a native callback that aborts the whole app when JavaScript throws in it.
      try {
        const resumed=this.checkpointRestore?.processes.has(process) ? {supported:true} : this.processTreePause.resume(process);
        if(resumed.failed)console.warn(`Budget-paused PTY ${id} could not be resumed after exit.`,resumed.failed);
        this.recordExit(id, current, exitCode, signal);
      } catch (error) {
        console.warn(`PTY ${id} exit could not be recorded.`, error);
      }
    });
  }

  private recordExit(id: string, current: ManagedSession, reportedExitCode: number, signal?: number): void {
    this.reviewDiffTracker.stopped(id);
    current.process = null;
    this.flushOutput(id, current);
    this.releaseIsolation(id);
    current.reviewWorkspace?.cleanup();
    if (current.extras.gitAuditSince !== undefined) void this.auditGit(id, current);
    // node-pty reports a process killed by a signal as exitCode 0 plus the signal: that is a crash, not a clean finish
    // (an OpenCode killed with SIGKILL showed "done, exit 0" and could not be retried). Shells report it as 128+signal.
    const killedBy = typeof signal === "number" && signal > 0 ? signal : 0;
    const exitCode = killedBy ? 128 + killedBy : reportedExitCode;
    current.metadata.exitCode = exitCode;
    current.metadata.status = exitCode === 0 ? "done" : "failed";
    const details = exitCode === 0
      ? null
      : terminalFailureDetails(this.redactSecrets(current.bufferChunks.slice(current.bufferStart).join("")));
    current.metadata.failureDetails = killedBy
      ? `${signalExitText(killedBy)}${details ? `\n${details}` : ""}`.slice(0, 8_000)
      : details;
    current.agentBrowser?.cleanup();
    current.agentBrowser = null;
    current.agentRuntime?.cleanup();
    current.agentRuntime = null;
    current.agentOrchestration?.cleanup();
    current.agentOrchestration = null;
    void this.cleanupLaunchFiles(current).catch(() => undefined);
    this.emitSession(current.metadata);
    // Recorded at the moment of exit, so a finished agent is never relaunched.
    this.schedulePersistence();
  }

  /**
   * A hidden card is not streamed, but its terminal must still see every byte: a replay that starts after the ring
   * dropped part of the hidden stretch cannot restore what that part did to the terminal (an alternate screen entered,
   * modes set, an escape sequence cut in half), and the card's parser would continue from a state the session never
   * had. So just before the ring would drop output this card has not received, the card gets the stretch it missed
   * as one renderer-only event, and the stretch starts again. The card parses it without painting (it is hidden), so
   * a quiet hidden card still costs nothing and a flooding one costs its parsing in ring-sized pieces, never a gap.
   * Called before the chunk joins the ring (`before`) and after it (`after`: a single chunk longer than the ring).
   */
  private keepHiddenCardWhole(id: string, session: ManagedSession, before: string | null, after?: string): void {
    const since = this.hiddenSinceOffset.get(id);
    if (since === undefined) return;
    const missed = session.outputOffset - since;
    if (before !== null) {
      if (missed === 0 || missed + before.length <= MAX_SCROLLBACK_CHARS) return;
      this.emit(IPC.terminalData, { id, data: scrollbackTail(session, missed), outputOffset: session.outputOffset, audience: "renderer" });
      this.hiddenSinceOffset.set(id, session.outputOffset);
      return;
    }
    // The chunk alone outgrew the ring: it is the whole stretch (the part before it was handed over just now).
    if (after !== undefined && missed > MAX_SCROLLBACK_CHARS) {
      this.emit(IPC.terminalData, { id, data: after, outputOffset: session.outputOffset, audience: "renderer" });
      this.hiddenSinceOffset.set(id, session.outputOffset);
    }
  }

  private queueOutput(id: string, session: ManagedSession, data: string): void {
    session.pendingOutput.push(data);
    session.pendingOutputChars += data.length;
    // A flood (e.g. `cat` on a huge file) can push many chunks before the batch timer's callback gets a
    // turn; flush this session now instead of letting its buffer grow without bound.
    if (session.pendingOutputChars >= MAX_PENDING_OUTPUT_CHARS) {
      this.flushOutput(id, session);
      return;
    }
    this.queuedOutput.set(id, session);
    if (this.outputTimer !== null) return;
    // Keep a TUI's clear-and-redraw sequence in one renderer update whenever possible.
    this.outputTimer = setTimeout(() => this.flushQueuedOutput(), OUTPUT_BATCH_MS);
  }

  /** Flushes every session with queued output, in the order its output first arrived. */
  private flushQueuedOutput(): void {
    this.outputTimer = null;
    for (const [id, session] of [...this.queuedOutput]) this.flushOutput(id, session);
  }

  private flushOutput(id: string, session: ManagedSession): void {
    if (this.queuedOutput.get(id) === session) {
      this.queuedOutput.delete(id);
      if (this.queuedOutput.size === 0 && this.outputTimer !== null) {
        clearTimeout(this.outputTimer);
        this.outputTimer = null;
      }
    }
    if (session.pendingOutput.length === 0) return;

    const data = session.pendingOutput.join("");
    session.pendingOutput.length = 0;
    session.pendingOutputChars = 0;
    // While the card is hidden the batch is for the observers only: the
    // renderer catches up through the replay in setVisible.
    this.emit(IPC.terminalData, {
      id,
      data,
      outputOffset: session.outputOffset,
      ...(this.hiddenSinceOffset.has(id) ? { audience: "observers" as const } : {})
    });
  }
}

/** A manager event the main process forwards to its in-process observers. */
export function reachesObservers(payload: TerminalDataEvent | SessionEvent | SessionRemovedEvent | GitRiskReport): boolean {
  return !("audience" in payload) || payload.audience !== "renderer";
}

/** A manager event the main process forwards to the renderer. */
export function reachesRenderer(payload: TerminalDataEvent | SessionEvent | SessionRemovedEvent | GitRiskReport): boolean {
  return !("audience" in payload) || payload.audience !== "observers";
}

function environmentBadge(environment: PersistedEnvironmentRef): NonNullable<SessionMetadata["environment"]> {
  return { pluginId: environment.pluginId, kind: environment.kind, label: environment.label };
}

/**
 * Claude's title shows the same «✳» when its turn ended and while its permission prompt waits, and it can reach main
 * before or after the hook that tells them apart (Stop, PermissionRequest). Once Claude's hooks have reported for this
 * card they alone end a turn; the title only reports one starting. Without them (hooks off, or a remote run without a
 * bridge) the title's idle stands.
 */
function resetLaunchSignals(session: ManagedSession): void {
  // Nor is its conversation: its answer and turn counts would answer a wait for the new one.
  delete session.answer;
  delete session.turnStarts;
  delete session.promptTurnMark;
  session.inputGeneration = (session.inputGeneration ?? 0) + 1;
  delete session.acceptedLifecycleState;
  delete session.answerTurnGeneration;
  delete session.providerTurnId;
  delete session.providerTurnGenerations;
  delete session.inputBracketedPaste;
  delete session.hookSignals;
  delete session.cliInputReady;
  delete session.readinessOutput;
  delete session.titleState;
  if (session.answeredPromptTimer) clearTimeout(session.answeredPromptTimer);
  session.answeredPromptTimer = undefined;
}

function titleDefersToHooks(session: ManagedSession, state: "idle" | "working" | "needs_approval"): boolean {
  return state !== "working" && session.metadata.provider === "claude" && session.hookSignals !== undefined;
}

/** Keys that answer a prompt: Enter, a lone Esc, or a choice digit. */
const ANSWERS_PROMPT = /\r|^\u001b$|^[1-9]$/;
const ANSWERED_PROMPT_SETTLE_MS = 3_000;

/** "auto" ran as accept-edits because a launch contributor marked a third-party model; shown on the card. */
function setAutoDowngraded(metadata: SessionMetadata, downgraded: boolean): void {
  if (downgraded) metadata.autoDowngraded = true;
  else delete metadata.autoDowngraded;
}

function missingLaunchPlugins(pluginIds: readonly string[]): string {
  return `needs plugin ${pluginIds.join(", ")} for its launch options; it is disabled, removed, or its native code is not trusted.`;
}

function failWith(message: string): never {
  throw new Error(message);
}

function applyLaunchFailure(metadata: SessionMetadata, failure: LaunchFailure): void {
  metadata.status = "failed";
  metadata.exitCode = failure.exitCode ?? 127;
  metadata.failureDetails = failure.diagnostic;
}

/**
 * The launch's program search path. The environment is a plain copy of
 * process.env, which on Windows is case-insensitive but keeps the spelling it
 * was given ("Path"), so env.PATH alone finds nothing there.
 */
export function launchSearchPath(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform !== "win32") return environment.PATH;
  if (environment.PATH !== undefined) return environment.PATH;
  const key = Object.keys(environment).find((name) => name.toUpperCase() === "PATH");
  return key === undefined ? undefined : environment[key];
}

export function terminalEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const reserved = new Set<string>([
    ...Object.values(AGENT_BROWSER_ENV),
    ...Object.values(AGENT_RUNTIME_ENV),
    CAPTURE_RESULT_ENV,
    CAPTURE_ANSWER_ENV,
    CAPTURE_ANSWER_EXPIRES_AT_ENV,
    // An orchestrator that launches the app must not leak its own control grant.
    CONTROL_CONNECTION_ENV,
    CONTROL_CLI_ENV
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
const SESSION_ROLES = new Set<SessionRole>(["agent", "orchestrator", "subagent"]);

type LaunchModelChoice = { model?: string; effort?: ReasoningEffort };

/** The request's model and effort, checked for its CLI; a refusal names what that CLI takes. */
function launchModelChoice(provider: ProviderId, model: unknown, effort: unknown): LaunchModelChoice {
  if (model === undefined && effort === undefined) return {};
  if (provider === "terminal") throw new Error("A plain terminal has no model.");
  if (model !== undefined) {
    const problem = launchModelProblem(provider, model);
    if (problem) throw new Error(problem);
  }
  if (effort !== undefined) {
    const problem = launchEffortProblem(provider, effort);
    if (problem) throw new Error(problem);
  }
  return {
    ...(model !== undefined ? { model: model as string } : {}),
    ...(effort !== undefined ? { effort: effort as ReasoningEffort } : {})
  };
}

function assertCreateRequest(request: CreateSessionRequest, containment: boolean): void {
  if (!request || !SESSION_PROVIDERS.has(request.provider)) throw new Error("Unknown terminal provider.");
  if (!isLaunchProfile(request.profile)) throw new Error("Unknown launch profile.");
  if (!profileAvailable(request.provider, request.profile, containment) && !(request.provider === "terminal" && request.profile === "yolo")) {
    throw new LaunchRefusal(request.profile === "auto"
      ? `${request.provider} has no auto mode of its own, and CanvasTTY's agent isolation, which its auto needs, is not available here; use the normal profile.`
      : `${request.provider} has no ${request.profile} mode; use the normal profile.`);
  }
  if (request.role === "orchestrator" && request.provider === "terminal") throw new Error("A plain terminal cannot be an orchestrator.");
  if (typeof request.cwd !== "string" || request.cwd.length === 0) throw new Error("Project folder is required.");
  if (!isPoint(request.position)) throw new Error("Session position is invalid.");
  const role = request.role ?? "agent";
  if (!SESSION_ROLES.has(role)) throw new Error("Unknown session role.");
  if (role === "subagent" && typeof request.parentSessionId !== "string") {
    throw new Error("A subagent session requires a parent session.");
  }
  if (request.parentSessionId !== undefined && typeof request.parentSessionId !== "string") {
    throw new Error("Session parent id must be a string.");
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

function canonicalProjectPath(path: string): string {
  try { return realpathSync(path).normalize("NFC"); }
  catch { return onDiskPath(path).normalize("NFC"); }
}

function publicSessionMetadata(session: ManagedSession): SessionMetadata {
  const metadata = structuredClone(session.metadata);
  if (session.threadId) metadata.threadId = session.threadId;
  else delete metadata.threadId;
  return metadata;
}

function snapshot(session: ManagedSession): SessionSnapshot {
  return {
    ...publicSessionMetadata(session),
    buffer: session.bufferChunks.slice(session.bufferStart).join("")
  };
}

/** The last `chars` characters of the scrollback (all of it when it holds fewer), joined from the end. */
function scrollbackTail(session: ManagedSession, chars: number): string {
  if (chars >= session.bufferLength) return session.bufferChunks.slice(session.bufferStart).join("");
  const parts: string[] = [];
  let needed = chars;
  for (let index = session.bufferChunks.length - 1; index >= session.bufferStart && needed > 0; index--) {
    const chunk = session.bufferChunks[index]!;
    parts.push(chunk.length <= needed ? chunk : chunk.slice(chunk.length - needed));
    needed -= chunk.length;
  }
  return parts.reverse().join("");
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
      // Release the dropped chunk now: the slot stays until the array is compacted, the text must not.
      session.bufferChunks[session.bufferStart] = "";
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

/** "Killed by signal SIGKILL (9)." from node-pty's signal number. */
function signalExitText(signal: number): string {
  const name = Object.entries(osConstants.signals).find(([, value]) => value === signal)?.[0];
  return `The process was killed by signal ${name ? `${name} (${signal})` : signal}.`;
}
