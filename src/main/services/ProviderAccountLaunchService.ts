import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentProviderId, AppSettings, ExecutionWorkspaceSummary, SessionMetadata } from "../../shared/contracts.ts";
import { accountApiProfile, accountLaunchModel, accountRouteBinding, accountRouteMaxDataClass, accountSupportsRuntime, assertAccountAliases, canonicalApiUrl, validAccountBinding } from "../../shared/providerAccountPolicy.ts";
import { dataClassSatisfies } from "../../shared/contracts.ts";
import type { ProviderSecretsService } from "./ProviderSecretsService.ts";
import type { RemoteProviderDiscovery } from "./RemoteProviderDiscovery.ts";
import { providerModelArguments } from "./terminalLaunch.ts";

type LaunchSettings = Pick<AppSettings, "providerAccounts" | "apiProfiles" | "remoteHosts">;
export interface PreparedProviderAccountLaunch {
  execution?: ExecutionWorkspaceSummary;
  /** Main-owned container process bypasses host CLI/bridge resolution. Environment is complete. */
  process?: { command: string; args: string[]; cwd: string; environment: Record<string, string> };
  containerRecipe?: { runtime: "opencode" | "minimax" | "omp"; provider: string; model: string; baseUrl: string; api: string };
  integrationNote?: string;
  beforeSpawn?(): Promise<void>;
  processStarted?(): void;
  processExited?(): Promise<void>;
  args: string[];
  environment: Record<string, string>;
  unsetEnvironment: readonly string[];
  model?: string;
  remoteExecutable?: string;
  remoteAccountHome?: string;
  skipBridges: boolean;
  /** Nonsecret digest stored for safe resume; no account contents or keys. */
  bindingDigest: string;
  assertCurrent(metadata: SessionMetadata): void;
  cleanup(): Promise<void>;
}
export interface ProviderAccountLaunchCoordinator {
  readonly handlesTerminals?: boolean;
  prepare(metadata: SessionMetadata, resumePrevious: boolean, control?: { isCurrent(): boolean; target?: "container" }): Promise<PreparedProviderAccountLaunch>;
}
const KEY_ENV = "CANVASTTY_PROFILE_API_KEY";
// Selected account homes must not inherit another account's API billing route.
export const PROVIDER_ACCOUNT_ENVIRONMENT = Object.freeze([
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_ORG_ID", "OPENAI_ORGANIZATION", "OPENAI_PROJECT_ID",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_UNIX_SOCKET", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_HOST_CREDS_FILE", "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_GATEWAY", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "XAI_API_KEY", "XAI_BASE_URL", "GROK_API_KEY", "GROK_BASE_URL", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_GEMINI_BASE_URL",
  "ZAI_API_KEY", "MINIMAX_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "DEVIN_API_KEY", "CURSOR_API_KEY",
  "KIMI_API_KEY", "KIMI_BASE_URL", "KIMI_MODEL_NAME", "MOONSHOT_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY",
  "KIMI_SHARE_DIR", "KIMI_CODE_CUSTOM_HEADERS", "KIMI_CODE_BASE_URL", "KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST", "KIMI_MODEL_API_KEY", "KIMI_MODEL_BASE_URL",
  "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "HERMES_HOME", "KIMI_CODE_HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE",
  "MINIMAX_DATA_DIR", "MAVIS_DATA_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", KEY_ENV
]);
const HOME_ENV: Partial<Record<AgentProviderId, string>> = {
  codex: "CODEX_HOME", claude: "CLAUDE_CONFIG_DIR", grok: "GROK_HOME", hermes: "HERMES_HOME", kimi: "KIMI_CODE_HOME",
  pi: "PI_CODING_AGENT_DIR", omp: "PI_CODING_AGENT_DIR", minimax: "MINIMAX_DATA_DIR", devin: "XDG_DATA_HOME"
};

/** No authentication reads or global config writes. All I/O is on-demand at launch. */
export class ProviderAccountLaunchService implements ProviderAccountLaunchCoordinator {
  private readonly settings: () => LaunchSettings;
  private readonly secrets: Pick<ProviderSecretsService, "get" | "generation">;
  private readonly options: { temporaryRoot?: string; discovery?: Pick<RemoteProviderDiscovery, "discover"> };
  constructor(settings: () => LaunchSettings, secrets: Pick<ProviderSecretsService, "get" | "generation">,
    options: { temporaryRoot?: string; discovery?: Pick<RemoteProviderDiscovery, "discover"> } = {}) { this.settings = settings; this.secrets = secrets; this.options = options; }

  async prepare(metadata: SessionMetadata, resumePrevious: boolean, control?: { target?: "container" }): Promise<PreparedProviderAccountLaunch> {
    if (metadata.provider === "terminal") throw new Error("A shell does not use a provider account adapter.");
    const targetContainer = control?.target === "container";
    const settings = this.settings();
    const frozen = this.fingerprint(metadata, settings);
    const account = metadata.accountId === undefined ? undefined : settings.providerAccounts.find((a) => a.id === metadata.accountId);
    if (metadata.accountId !== undefined && !account) throw new Error("Selected provider account is missing.");
    if (account) assertAccountAliases(settings.providerAccounts, settings.apiProfiles, new Set([account.id]));
    if (account && (!validAccountBinding(account.binding) || account.bindingRequired)) throw new Error("Selected account needs an explicit supported authentication binding; ambient credentials are disabled.");
    if (account && (!accountSupportsRuntime(account, metadata.provider, settings.apiProfiles) || (account.hostId ?? "local") !== (metadata.hostId ?? "local"))) throw new Error("Selected account is incompatible with this runtime or host.");
    if (account && metadata.dataClass && !dataClassSatisfies(metadata.dataClass, accountRouteMaxDataClass(account, settings.apiProfiles, metadata.model))) throw new Error("Selected account data policy does not permit this task.");
    const profile = account && accountApiProfile(account, settings.apiProfiles);
    if (targetContainer && !profile) throw new Error("Container agents require a supported API account; native OAuth home recipes are not supported.");
    const model = account ? accountLaunchModel(account, metadata.model, settings.apiProfiles) : metadata.model;
    if (account?.models !== undefined && (!model || account.models.length === 0)) throw new Error("An account with a model allowlist requires an explicit covered model.");
    const bindingDigest = digest(JSON.stringify({ route: account ? accountRouteBinding(account, settings.apiProfiles) : { provider: metadata.provider, host: metadata.hostId ?? "local" }, model: model ?? null }));
    if (resumePrevious && (account || metadata.launchBinding !== undefined) && metadata.launchBinding !== bindingDigest) throw new Error("Cannot resume: the saved account, backend or model binding is absent or has changed.");
    if (resumePrevious && profile) throw new Error("API launch credentials use an ephemeral configuration; resume is unavailable. Start a fresh session.");
    let directory: string | undefined;
    let secretGeneration: number | undefined;
    let cleaned = false;
    let cleanupTask: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
      cleaned = true;
      return cleanupTask ??= (directory ? rm(directory, { recursive: true, force: true }) : Promise.resolve()).catch((error) => {
        cleanupTask = undefined;
        throw error;
      });
    };
    try {
      let environment: Record<string, string> = {};
      let args: string[] = [];
      let launchModel = model;
      let containerRecipe: PreparedProviderAccountLaunch["containerRecipe"];
      if (account?.binding?.kind === "cli-home") {
        const variable = HOME_ENV[metadata.provider];
        if (!variable) throw new Error(`${metadata.provider} has no verified account-home adapter. Configure a supported API runtime instead.`);
        let home = account.binding.directory;
        if (metadata.hostId === undefined) {
          if (!isAbsolute(home)) throw new Error("Account directory must be an absolute host-local path.");
          const canonical = await realpath(home);
          if (canonical !== home) throw new Error("Account home must be its canonical real path; save the resolved directory before assessing this account.");
          home = canonical;
          if (!(await stat(home)).isDirectory()) throw new Error("Account directory does not exist.");
          // A symlink alias must not create a second account/capacity identity.
          for (const other of settings.providerAccounts) {
            if (other.id === account.id || other.provider !== account.provider || (other.hostId ?? "local") !== "local" || other.binding?.kind !== "cli-home") continue;
            let otherHome: string | undefined;
            try { otherHome = await realpath(other.binding.directory); } catch { /* Unavailable other homes cannot authenticate this launch. */ }
            if (otherHome === home) throw new Error("Two account identities resolve to the same account directory.");
          }
        } else if (!home.startsWith("/")) throw new Error("Remote account directory must be an absolute POSIX path.");
        environment = { [variable]: home };
        // The Python and TypeScript Kimi CLIs share a command name but use different home selectors.
        if (metadata.provider === "kimi") environment.KIMI_SHARE_DIR = home;
        if (metadata.provider === "codex") args = ["-c", 'cli_auth_credentials_store="file"'];
        if (metadata.provider === "pi" || metadata.provider === "omp") Object.assign(environment, { OMP_PROFILE: "", PI_PROFILE: "" });
        if (metadata.provider === "minimax") environment.MAVIS_DATA_DIR = home;
      }
      if (profile) {
        if (metadata.hostId !== undefined) throw new Error("Remote API profiles require an independently provisioned host-local credential adapter; local vault keys are never forwarded over SSH.");
        if (!model || !model.trim() || model.length > 200 || /[\u0000-\u001f\u007f]/u.test(model)) throw new Error("API profile needs an explicit selected or default model.");
        const baseUrl = canonicalApiUrl(profile.baseUrl);
        if ((profile.protocol === "google" && metadata.provider !== "opencode") || (metadata.provider === "omp" && profile.protocol !== "openai-compatible")) throw new Error("This API protocol/authentication path is not supported by the selected runtime.");
        secretGeneration = this.secrets.generation;
        const key = await this.secrets.get(profile.secretRef, { profileId: profile.id, hostId: "local" }).catch(() => { throw new Error("API profile credential could not be read from secure storage for this owner."); });
        if (!key || !key.trim()) throw new Error("API profile key is not configured in secure storage.");
        if (this.secrets.generation !== secretGeneration) throw new Error("Provider credentials changed while preparing the launch; retry.");
        const provider = `canvastty_${randomUUID().replaceAll("-", "")}`;
        const api = profile.protocol === "openai-compatible" ? "openai-completions" : "anthropic-messages";
        environment[KEY_ENV] = key;
        const keyReference = `{env:${KEY_ENV}}`;
        if (metadata.provider === "opencode") {
          const npm = profile.protocol === "google" ? "@ai-sdk/google" : profile.protocol === "openai-compatible" ? "@ai-sdk/openai-compatible" : "@ai-sdk/anthropic";
          // OpenCode 1.14.29's Anthropic SDK appends /messages, unlike MiniMax's /v1/messages.
          const requestBase = profile.protocol === "anthropic-compatible" && baseUrl === "https://api.anthropic.com" ? `${baseUrl}/v1` : baseUrl;
          environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { [provider]: { npm, name: "CanvasTTY", options: { baseURL: requestBase, apiKey: keyReference }, models: { [model]: { name: model } } } }, model: `${provider}/${model}` });
          launchModel = `${provider}/${model}`;
        } else if (targetContainer && (metadata.provider === "minimax" || metadata.provider === "omp")) {
          containerRecipe = { runtime: metadata.provider, provider, model, baseUrl, api };
          launchModel = metadata.provider === "omp" ? `${provider}/${model}` : undefined;
        } else {
          const root = this.options.temporaryRoot ?? tmpdir();
          await mkdir(root, { recursive: true, mode: 0o700 });
          directory = await mkdtemp(join(root, "canvastty-api-"));
          await chmod(directory, 0o700);
          if (metadata.provider === "minimax") {
            // JSON is valid YAML, avoiding interpolation and YAML scalar surprises.
            await writeFile(join(directory, "config.yaml"), JSON.stringify({ defaultModel: `custom_provider:${provider}/${model}`, custom_provider: { [provider]: { name: "CanvasTTY", api, options: { baseURL: baseUrl, apiKey: key }, models: { [model]: {} } } } }), { mode: 0o600, flag: "wx" });
            environment.MINIMAX_DATA_DIR = directory; environment.MAVIS_DATA_DIR = directory;
            delete environment[KEY_ENV];
            launchModel = undefined;
          } else if (metadata.provider === "omp") {
            await writeFile(join(directory, "models.yml"), JSON.stringify({ providers: { [provider]: { baseUrl, apiKey: KEY_ENV, api, models: [{ id: model }] } } }), { mode: 0o600, flag: "wx" });
            Object.assign(environment, { PI_CODING_AGENT_DIR: directory, OMP_PROFILE: "", PI_PROFILE: "" });
            launchModel = `${provider}/${model}`;
          } else throw new Error("Selected runtime has no verified API profile adapter.");
        }
      }
      // Validate measured flag contracts even for remote paths before SSH starts.
      providerModelArguments(metadata.provider, launchModel);
      let remoteExecutable: string | undefined;
      if (metadata.hostId !== undefined && !targetContainer) {
        const host = settings.remoteHosts.find((h) => h.id === metadata.hostId);
        if (!host || !this.options.discovery) throw new Error("Remote provider discovery is unavailable.");
        const discovery = await this.options.discovery.discover(host, undefined, [metadata.provider]);
        const found = discovery.providers.find((p) => p.provider === metadata.provider && p.installed);
        if (!discovery.reachable || !found?.path?.startsWith("/") || /[\u0000-\u001f\u007f]/u.test(found.path)) throw new Error("Remote provider did not resolve to a verified absolute executable path.");
        remoteExecutable = found.path;
      }
      const prepared: PreparedProviderAccountLaunch = { containerRecipe, args, environment, unsetEnvironment: account ? PROVIDER_ACCOUNT_ENVIRONMENT : [], model: launchModel, remoteExecutable,
        ...(metadata.hostId !== undefined && account?.binding?.kind === "cli-home" ? { remoteAccountHome: account.binding.directory } : {}),
        // Legacy adapters mutate the default home. A custom home deliberately keeps PTY/process integration only.
        skipBridges: targetContainer || account?.binding?.kind === "cli-home" && ["kimi", "hermes", "grok"].includes(metadata.provider), bindingDigest,
        assertCurrent: (current) => {
          if (cleaned || this.fingerprint(current, this.settings()) !== frozen || (secretGeneration !== undefined && this.secrets.generation !== secretGeneration)) throw new Error("Provider launch binding changed during preparation; start again with the current settings.");
        }, cleanup };
      prepared.assertCurrent(metadata);
      return prepared;
    } catch (error) {
      await cleanup();
      // Generated keys/configs never enter diagnostics; filesystem errors can include only our own path.
      throw error;
    }
  }
  private fingerprint(metadata: SessionMetadata, settings: LaunchSettings): string {
    const account = settings.providerAccounts.find((a) => a.id === metadata.accountId);
    const apiProfile = account?.binding?.kind === "api-profile" ? settings.apiProfiles.find((p) => p.id === (account.binding as { profileId: string }).profileId) : undefined;
    return digest(JSON.stringify({ provider: metadata.provider, model: metadata.model ?? null, accountId: metadata.accountId ?? null, hostId: metadata.hostId ?? null,
      profile: metadata.profile, cwd: metadata.cwd, account: account ?? null, apiProfile: apiProfile ?? null, host: settings.remoteHosts.find((h) => h.id === metadata.hostId) ?? null }));
  }
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
