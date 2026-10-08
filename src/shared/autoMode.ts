/**
 * Launch profiles (permission modes). "auto" is the default way of working: the agent's own auto mode where its CLI
 * has one, inside CanvasTTY's outer layers (agent isolation, base protection, delegation rules), which add no prompts
 * of their own and only stop what is dangerous. The other modes are offered only where the CLI supports them:
 *
 * - normal ("Manual"): the CLI asks as its own configuration says.
 * - acceptEdits: edits inside the project run, anything else asks.
 * - plan: the CLI plans or reads without changing files.
 * - auto: see AUTO_KIND.
 * - yolo ("Bypass"): every approval skipped; still inside the outer layers, never for a subagent, and only after the
 *   person acknowledged it for that CLI.
 *
 * Every entry is a per-run flag or inline setting; no CLI configuration file is written. Verified against the installed
 * CLIs' `--help` under a fake HOME (Claude Code 2.1.281, codex-cli 0.156.1, grok 1.0.41, opencode 1.18.33).
 */
import type { ProviderId } from "./providerCatalog.ts";
import type { AppSettings } from "./contracts.ts";

export type LaunchProfile = "normal" | "yolo" | "auto" | "acceptEdits" | "plan";
export type DefaultLaunchProfile = Exclude<LaunchProfile, "yolo">;
/** The order the launcher offers them in. */
export const LAUNCH_PROFILES: readonly LaunchProfile[] = ["auto", "normal", "acceptEdits", "plan", "yolo"];
export const isLaunchProfile = (value: unknown): value is LaunchProfile => typeof value === "string" && (LAUNCH_PROFILES as readonly string[]).includes(value);
export const isDefaultLaunchProfile = (value: unknown): value is DefaultLaunchProfile => isLaunchProfile(value) && value !== "yolo";

/**
 * How much a profile lets an agent do without the person: a subagent never gets more than its orchestrator.
 * plan < normal < acceptEdits < auto < yolo.
 */
export const PROFILE_RANK: Readonly<Record<LaunchProfile, number>> = Object.freeze({ plan: 0, normal: 1, acceptEdits: 2, auto: 3, yolo: 4 });

export interface AutoModeFlags {
  /** Native full auto, inside the CLI's own sandbox. */
  readonly auto: readonly string[];
  /** Accept-edits inside the same sandbox: edits in the project run, anything else asks or stays in the sandbox. */
  readonly acceptEdits: readonly string[];
  /** Planning / read-only. */
  readonly plan: readonly string[];
}

/** The native flag table. Claude's sandbox is not a flag but an inline settings block (CLAUDE_SANDBOX_SETTINGS). */
export const AUTO_MODE: Readonly<Partial<Record<ProviderId, AutoModeFlags>>> = Object.freeze({
  // claude --help: `--permission-mode <mode>` (choices: "acceptEdits", "auto", "bypassPermissions", "manual",
  // "dontAsk", "plan").
  claude: {
    auto: ["--permission-mode", "auto"],
    acceptEdits: ["--permission-mode", "acceptEdits"],
    plan: ["--permission-mode", "plan"]
  },
  // codex --help (and `codex resume --help`): `--approve-for-me  Route approval requests through automatic review using
  // the workspace-write sandbox`; `-s, --sandbox <read-only|workspace-write|danger-full-access>`;
  // `-a, --ask-for-approval <on-request|never>`. Accept-edits: workspace-write, the model asks for anything beyond it.
  // Codex has no plan permission mode; its read-only sandbox (every change asks) is the honest equivalent.
  codex: {
    auto: ["--approve-for-me"],
    acceptEdits: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
    plan: ["--sandbox", "read-only", "--ask-for-approval", "on-request"]
  },
  // grok --help: `--permission-mode <MODE>` [default, acceptEdits, auto, dontAsk, bypassPermissions, plan]. Its
  // `--sandbox <PROFILE>` does not list its profiles, so no Grok sandbox is relied on: its auto is its classifier only,
  // and CanvasTTY's isolation layer is what contains it.
  grok: {
    auto: ["--permission-mode", "auto"],
    acceptEdits: ["--permission-mode", "acceptEdits"],
    plan: ["--permission-mode", "plan"]
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
 * Agents whose modes are a per-run permission configuration instead of a flag: OpenCode (1.18) has no auto flag, so its
 * auto and accept-edits are an inline OPENCODE_CONFIG_CONTENT (openCodeAutoEnvironment in openCodeConfig.ts); its plan
 * is its built-in `plan` agent (`--agent plan`).
 */
export const CONFIG_AUTO_MODE: ReadonlySet<ProviderId> = new Set<ProviderId>(["opencode"]);
const OPENCODE_PLAN = ["--agent", "plan"];
/** A plan mode without an auto mode: cursor-agent --help `--mode <mode>` (plan: read-only/planning, no edits). */
const PLAN_ONLY: Readonly<Partial<Record<ProviderId, readonly string[]>>> = Object.freeze({ cursor: ["--mode", "plan"] });

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
  if (AUTO_MODE[provider]) return "native";
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
    case "acceptEdits": return Boolean(AUTO_MODE[provider]) || CONFIG_AUTO_MODE.has(provider);
    case "plan": return Boolean(AUTO_MODE[provider]) || CONFIG_AUTO_MODE.has(provider) || Boolean(PLAN_ONLY[provider]);
    default: return false;
  }
}

/** The profiles the launcher offers for this provider, in order. */
export function availableProfiles(provider: ProviderId, containment: boolean): LaunchProfile[] {
  return LAUNCH_PROFILES.filter((profile) => profileAvailable(provider, profile, containment));
}

/** Agent isolation can contain an agent on systems with a supported OS layer. */
export function isolationAvailable(settings: Pick<AppSettings, "agentIsolation">, platform: string): boolean {
  return settings.agentIsolation !== "off" && (platform === "darwin" || platform === "linux");
}

/** Resolve the first available launch mode at or after the requested default. */
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
  const order: DefaultLaunchProfile[] = ["auto", "acceptEdits", "normal", "plan"];
  return order.slice(order.indexOf(wanted)).find((profile) => profileAvailable(provider, profile, containment)) ?? "normal";
}

/**
 * Bypass that changes nothing: the CLI has no approvals to skip (pi 0.85 has no permission system, MiniMax's modes
 * are settings/TUI state only), so its YOLO launches the stock CLI.
 */
export const BYPASS_CHANGES_NOTHING: ReadonlySet<ProviderId> = new Set<ProviderId>(["pi", "minimax"]);

/**
 * The flags a profile adds (YOLO and a contained auto use the bypass table in terminalLaunch.ts). `thirdPartyModel`
 * (a launch contributor ran the CLI on another model, e.g. an API or Ollama account) turns auto into accept-edits:
 * the native auto reviewer would then be that same model, and a weak model's own classifier is not a safety boundary.
 */
export function profileArguments(provider: ProviderId, profile: LaunchProfile, thirdPartyModel: boolean): string[] {
  if (profile === "normal" || profile === "yolo") return [];
  if (CONFIG_AUTO_MODE.has(provider)) return profile === "plan" ? [...OPENCODE_PLAN] : [];
  const flags = AUTO_MODE[provider];
  if (!flags) {
    if (profile === "auto") return [];
    if (profile === "plan" && PLAN_ONLY[provider]) return [...PLAN_ONLY[provider]!];
    throw new Error(`${provider} has no ${profile} mode.`);
  }
  if (profile === "auto") return [...(thirdPartyModel ? flags.acceptEdits : flags.auto)];
  return [...flags[profile]];
}

/** Kept for callers of the auto flags alone. */
export function autoModeArguments(provider: ProviderId, thirdPartyModel: boolean): string[] {
  if (CONFIG_AUTO_MODE.has(provider)) return [];
  const flags = AUTO_MODE[provider];
  if (!flags) throw new Error(`${provider} has no auto mode; use the normal profile.`);
  return [...(thirdPartyModel ? flags.acceptEdits : flags.auto)];
}

/** The most a subagent of an orchestrator in `parent` may run in: never YOLO, never more than its orchestrator. */
export function profileCeiling(parent: LaunchProfile): LaunchProfile {
  return parent === "yolo" ? "auto" : parent;
}
