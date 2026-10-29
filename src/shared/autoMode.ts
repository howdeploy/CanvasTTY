/**
 * Launch profiles (permission modes). "auto" is the default way of working: the agent's own auto mode where its CLI
 * has one, inside CanvasTTY's outer layers (agent isolation, base protection, delegation rules), which add no prompts
 * of their own and only stop what is dangerous. The other modes are offered only where the CLI supports them:
 *
 * - normal ("Manual"): the CLI asks as its own configuration says.
 * - acceptEdits: edits inside the project run, anything else asks.
 * - plan/readOnly: native planning or read-only operation, according to the CLI.
 * - ask/askCached: explicit native approvals, optionally with OMP's remembered grants.
 * - dontAsk: refuse actions needing approval instead of prompting; not an approval bypass.
 * - autonomous: Devin's native sandboxed execution mode.
 * - auto: see AUTO_KIND.
 * - yolo ("Bypass"): every approval skipped; still inside the outer layers, never for a subagent, and only after the
 *   person acknowledged it for that CLI.
 *
 * Every entry is a per-run flag or inline setting; no CLI configuration file is written. Verified against the installed
 * CLIs' `--help` under a fake HOME and upstream command references; see docs/agent-launch-modes.md.
 */
import type { ProviderId } from "./providerCatalog.ts";
import type { AppSettings } from "./contracts.ts";

export type LaunchProfile = "normal" | "yolo" | "auto" | "acceptEdits" | "plan" | "ask" | "askCached" | "dontAsk" | "readOnly" | "autonomous";
export type DefaultLaunchProfile = Exclude<LaunchProfile, "yolo">;
/** The order the launcher offers them in. */
export const LAUNCH_PROFILES: readonly LaunchProfile[] = ["auto", "normal", "ask", "askCached", "acceptEdits", "dontAsk", "autonomous", "plan", "readOnly", "yolo"];
export const isLaunchProfile = (value: unknown): value is LaunchProfile => typeof value === "string" && (LAUNCH_PROFILES as readonly string[]).includes(value);
export const isDefaultLaunchProfile = (value: unknown): value is DefaultLaunchProfile => isLaunchProfile(value) && value !== "yolo";

/**
 * How much a profile lets an agent do without the person: a subagent never gets more than its orchestrator.
 * Read-only/planning < manual approvals < automatic edits < supervised automation < bypass.
 */
export const PROFILE_RANK: Readonly<Record<LaunchProfile, number>> = Object.freeze({
  plan: 0, readOnly: 0, normal: 1, ask: 1, askCached: 1, acceptEdits: 2, dontAsk: 2, auto: 3, autonomous: 3, yolo: 4
});

export interface AutoModeFlags {
  /** Native supervised automation; containment and approval semantics depend on the CLI. */
  readonly auto?: readonly string[];
  /** Project edits proceed automatically, other actions require approval. */
  readonly acceptEdits?: readonly string[];
  /** Native planning or a read-only sandbox, according to the CLI. */
  readonly plan?: readonly string[];
  readonly ask?: readonly string[];
  readonly askCached?: readonly string[];
  readonly dontAsk?: readonly string[];
  readonly readOnly?: readonly string[];
  readonly autonomous?: readonly string[];
}

/** The native flag table. Claude's sandbox is not a flag but an inline settings block (CLAUDE_SANDBOX_SETTINGS). */
export const AUTO_MODE: Readonly<Partial<Record<ProviderId, AutoModeFlags>>> = Object.freeze({
  // claude --help: `--permission-mode <mode>` (choices: "acceptEdits", "auto", "bypassPermissions", "manual",
  // "dontAsk", "plan").
  claude: {
    ask: ["--permission-mode", "manual"],
    dontAsk: ["--permission-mode", "dontAsk"],
    auto: ["--permission-mode", "auto"],
    acceptEdits: ["--permission-mode", "acceptEdits"],
    plan: ["--permission-mode", "plan"]
  },
  // codex --help (and `codex resume --help`): `--approve-for-me  Route approval requests through automatic review using
  // the workspace-write sandbox`; `-s, --sandbox <read-only|workspace-write|danger-full-access>`;
  // `-a, --ask-for-approval <on-request|never>`. Accept-edits: workspace-write, the model asks for anything beyond it.
  // Codex has no plan permission mode; its read-only sandbox (every change asks) is the honest equivalent.
  codex: {
    dontAsk: ["--sandbox", "workspace-write", "--ask-for-approval", "never"],
    auto: ["--approve-for-me"],
    acceptEdits: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
    plan: ["--sandbox", "read-only", "--ask-for-approval", "on-request"]
  },
  // grok --help: `--permission-mode <MODE>` [default, acceptEdits, auto, dontAsk, bypassPermissions, plan]. Its
  // `--sandbox <PROFILE>` does not list its profiles, so no Grok sandbox is relied on: its auto is its classifier only,
  // and CanvasTTY's isolation layer is what contains it.
  grok: {
    ask: ["--permission-mode", "default"],
    dontAsk: ["--permission-mode", "dontAsk"],
    auto: ["--permission-mode", "auto"],
    acceptEdits: ["--permission-mode", "acceptEdits"],
    plan: ["--permission-mode", "plan"]
  },
  // Qwen's five approval modes are independent of CanvasTTY's optional isolation.
  qwen: {
    ask: ["--approval-mode", "default"],
    auto: ["--approval-mode", "auto"],
    acceptEdits: ["--approval-mode", "auto-edit"],
    plan: ["--approval-mode", "plan"]
  },
  // Kimi 2.4: --yolo is Ask When Needed, whereas --auto is Never Ask (our Bypass).
  // Kimi has no edit-only mode; its built-in Ask When Needed rules also apply on third-party models.
  kimi: {
    auto: ["--yolo"],
    plan: ["--plan"]
  },
  // Devin's native classifier is "smart". Plan is documented as a slash command, not a startup flag.
  devin: {
    ask: ["--permission-mode", "normal"],
    autonomous: ["--sandbox", "--permission-mode", "autonomous"],
    auto: ["--permission-mode", "smart"],
    acceptEdits: ["--permission-mode", "accept-edits"]
  },
  // OMP --plan selects a model, not the read-only plan mode. "write" is its edit-only approval tier.
  omp: {
    ask: ["--approval-mode", "always-ask"],
    askCached: ["--approval-mode", "always-ask-cached"],
    acceptEdits: ["--approval-mode", "write"]
  },
  // Auto requires Antigravity's own terminal sandbox (Linux/macOS >=1.3.5, Windows >=1.4.4).
  antigravity: {
    ask: ["--mode", "default"],
    auto: ["--mode", "auto"],
    acceptEdits: ["--mode", "accept-edits"],
    plan: ["--mode", "plan"]
  },
  cursor: {
    plan: ["--mode", "plan"],
    readOnly: ["--mode", "ask"]
  }
});

/**
 * Claude Code's sandbox, merged into the one inline `--settings` CanvasTTY passes, where CanvasTTY's own isolation
 * layer does not run (macOS does not let a sandbox start inside another one). `autoAllowBashIfSandboxed` defaults to
 * true, which would run every sandboxed command without its classifier or a prompt, so it is off; so is
 * `allowUnsandboxedCommands`, which would let a command leave the sandbox.
 */
export const CLAUDE_SANDBOX_SETTINGS = Object.freeze({ enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false });

/**
 * Agents whose supervised modes use per-run permission configuration: OpenCode's --auto skips approvals, so our
 * auto and accept-edits are an inline OPENCODE_CONFIG_CONTENT (openCodeAutoEnvironment in openCodeConfig.ts); its plan
 * is its built-in `plan` agent (`--agent plan`).
 */
export const CONFIG_AUTO_MODE: ReadonlySet<ProviderId> = new Set<ProviderId>(["opencode"]);
const OPENCODE_PLAN = ["--agent", "plan"];

/**
 * What "auto" is for each agent:
 * - "native": the CLI's own auto mode (its reviewer or classifier), inside the isolation layer where it runs.
 * - "config": CanvasTTY's per-run permission rules for the CLI (OpenCode), inside the isolation layer.
 * - "contained": the CLI has no auto mode of its own, so auto is its approval bypass, and it exists only inside
 *   CanvasTTY's isolation layer (plus base protection where the CLI has hooks). Without the layer it is not offered.
 */
export type AutoKind = "native" | "config" | "contained";

export function autoKind(provider: ProviderId): AutoKind | null {
  if (provider === "terminal") return null;
  if (AUTO_MODE[provider]?.auto) return "native";
  if (CONFIG_AUTO_MODE.has(provider)) return "config";
  return "contained";
}

/** The CLI has an auto mode of its own (or CanvasTTY's per-run rules for it) that works without the isolation layer. */
export function hasAutoMode(provider: ProviderId): boolean {
  const kind = autoKind(provider);
  return kind === "native" || kind === "config";
}

/**
 * Whether the provider can run this profile. `containment`: CanvasTTY's isolation layer can run here (a "contained"
 * auto needs it). A plain terminal has only normal.
 */
export function profileAvailable(provider: ProviderId, profile: LaunchProfile, containment: boolean): boolean {
  if (provider === "terminal") return profile === "normal";
  switch (profile) {
    case "normal": return true;
    case "yolo": return true;
    case "auto": return hasAutoMode(provider) || containment;
    case "acceptEdits": return Boolean(AUTO_MODE[provider]?.acceptEdits) || CONFIG_AUTO_MODE.has(provider);
    case "plan": return Boolean(AUTO_MODE[provider]?.plan) || CONFIG_AUTO_MODE.has(provider);
    default: return Boolean(AUTO_MODE[provider]?.[profile]);
  }
}

/** The profiles the launcher offers for this provider, in order. */
export function availableProfiles(provider: ProviderId, containment: boolean): LaunchProfile[] {
  return LAUNCH_PROFILES.filter((profile) => profileAvailable(provider, profile, containment));
}

/** Agent isolation can contain an agent on systems with a supported OS layer. */
export function isolationAvailable(settings: Pick<AppSettings, "agentIsolation">, platform: string): boolean {
  return settings.agentIsolation === "on" && (platform === "darwin" || platform === "linux");
}

/** Keep a supported personal default; otherwise prefer a supported mode no higher than it. */
export function resolveDefaultLaunchProfile(
  provider: ProviderId,
  settings: Pick<AppSettings, "defaultLaunchProfile" | "defaultLaunchProfiles">,
  containment: boolean
): DefaultLaunchProfile {
  if (provider === "terminal") return "normal";

  const personal = settings.defaultLaunchProfiles?.[provider];
  const wanted = isDefaultLaunchProfile(personal)
    ? personal
    : isDefaultLaunchProfile(settings.defaultLaunchProfile)
      ? settings.defaultLaunchProfile
      : "auto";
  const order: DefaultLaunchProfile[] = [wanted, "auto", "acceptEdits", "normal", "plan", "readOnly"];
  return order.find((profile) => PROFILE_RANK[profile] <= PROFILE_RANK[wanted] && profileAvailable(provider, profile, containment)) ?? "normal";
}

/**
 * No launch-time approval mapping: pi 0.85 has no permission system, and MiniMax's approval modes are settings/TUI
 * state only. Their existing YOLO choice retains the stock CLI's permission behavior.
 */
export const BYPASS_CHANGES_NOTHING: ReadonlySet<ProviderId> = new Set<ProviderId>(["pi", "minimax"]);

/**
 * The flags a profile adds (YOLO and a contained auto use the bypass table in terminalLaunch.ts). `thirdPartyModel`
 * (a launch contributor ran the CLI on another model, e.g. an API or Ollama account) turns auto into accept-edits:
 * the native auto reviewer would then be that same model, and a weak model's own classifier is not a safety boundary.
 * This fallback applies where the CLI has an edit-only mode; Kimi keeps its own Ask When Needed rules.
 */
export function profileArguments(provider: ProviderId, profile: LaunchProfile, thirdPartyModel: boolean): string[] {
  if (profile === "normal" || profile === "yolo") return [];
  if (CONFIG_AUTO_MODE.has(provider)) {
    if (profile === "plan") return [...OPENCODE_PLAN];
    if (profile === "auto" || profile === "acceptEdits") return [];
    throw new Error(`${provider} has no ${profile} mode.`);
  }
  const flags = AUTO_MODE[provider];
  const args = flags?.[profile];
  if (!args) {
    if (profile === "auto") return [];
    throw new Error(`${provider} has no ${profile} mode.`);
  }
  if (profile === "auto" && thirdPartyModel && flags?.acceptEdits) return [...flags.acceptEdits];
  return [...args];
}

/** Kept for callers of the auto flags alone. */
export function autoModeArguments(provider: ProviderId, thirdPartyModel: boolean): string[] {
  if (CONFIG_AUTO_MODE.has(provider)) return [];
  if (!AUTO_MODE[provider]?.auto) throw new Error(`${provider} has no auto mode; use the normal profile.`);
  return profileArguments(provider, "auto", thirdPartyModel);
}

/** The most a subagent of an orchestrator in `parent` may run in: never YOLO, never more than its orchestrator. */
export function profileCeiling(parent: LaunchProfile): LaunchProfile {
  return parent === "yolo" ? "auto" : parent;
}
