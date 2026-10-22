/**
 * The person's opt-in: a comma- or space-separated list of variable names that agent cards keep from CanvasTTY's
 * own environment although this module would leave them out (e.g. `OPENAI_ADMIN_KEY`). Read from the app's
 * environment only, so an agent cannot widen it for itself.
 */
export const AGENT_PASS_ENV = "CANVASTTY_AGENT_PASS_ENV";

/**
 * Organization-level credentials (OPENAI_ADMIN_KEY, ANTHROPIC_ADMIN_KEY, XAI_ADMIN_API_KEY, GITLAB_ADMIN_TOKEN, …):
 * projects, members, usage, billing. No agent CLI signs in with them.
 */
const ADMIN_CREDENTIAL = /(?:^|_)ADMIN_[A-Z0-9_]*(?:KEY|TOKEN)$/u;

/**
 * CanvasTTY's own credentials in its environment (CANVASTTY_GITHUB_TOKEN, which the plugin catalog uses, and any
 * CANVASTTY_*TOKEN / *KEY / *SECRET / *PASSWORD): the app's, read by the main process, never needed by a card.
 * "KEY" counts only as a whole word part (CANVASTTY_CODEX_KEYBOARD is not one).
 */
const APP_CREDENTIAL = /^CANVASTTY_(?:[A-Z0-9]+_)*[A-Z0-9]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)(?:_|$)/u;

/**
 * What a delegated card inherits from the person's environment: what a process needs to run, find its tools, reach
 * the network and find its CLI's own state, and nothing that signs in anywhere. Proxy variables are kept on purpose
 * (without them nothing reaches the network behind a corporate proxy), although a proxy URL may carry its own
 * user:password. SSH_AUTH_SOCK, GH_TOKEN, AWS_*, cloud and provider credentials are left out; the person lists one in
 * AGENT_PASS_ENV, or a launch contribution passes it explicitly (secretEnv).
 */
const DELEGATED_NAMES = new Set<string>([
  // Process basics
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "SHLVL", "TZ", "LANG", "LANGUAGE",
  "TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORFGBG", "NO_COLOR", "FORCE_COLOR",
  "TMPDIR", "TEMP", "TMP", "EDITOR", "VISUAL", "PAGER", "__CF_USER_TEXT_ENCODING",
  // Linux desktop session (addresses only)
  "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS",
  // Windows
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "USERNAME",
  "HOMEDRIVE", "HOMEPATH", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)", "PUBLIC", "ALLUSERSPROFILE", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
  // Network: proxies and the person's own certificate authorities
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  // Where each CLI keeps its own state (a moved home is where the CLI's sign-in lives, not a credential)
  "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "KIMI_CODE_HOME", "KIMI_SHARE_DIR",
  "KIMI_HOME", "QWEN_HOME", "QWEN_RUNTIME_DIR", "HERMES_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR",
  "PI_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "MINIMAX_DATA_DIR", "MAVIS_DATA_DIR", "CURSOR_CONFIG_DIR"
]);
/**
 * Locale (LC_ALL, LC_CTYPE, …) and XDG folders. No CANVASTTY_* variable is inherited: what a card needs of CanvasTTY's
 * own (its runtime, browser and orchestration addresses and capabilities, the Codex keyboard) the launch sets itself,
 * and the rest (CANVASTTY_HELPERS, CANVASTTY_USER_DATA_DIR, CANVASTTY_GITHUB_TOKEN, …) is read by the main process.
 */
const DELEGATED_PREFIX = /^(?:LC_|XDG_)/u;

export interface AgentEnvironmentInput {
  /** Not started by the person: a subagent, or any card (agent or plain shell) a plugin started. */
  delegated: boolean;
}

/**
 * The environment a card inherits from CanvasTTY's own (terminalEnvironment), before what the core and launch
 * contributions set for the launch. A plain shell card the person starts goes through shellEnvironment instead.
 * Every launch builder (agent runtime, browser bridge, OpenCode inline config) reads this result, not process.env.
 * - The person's own top-level agent cards keep everything but admin and CanvasTTY credentials: a CLI signed in by
 *   API key keeps working, in any profile.
 * - A delegated card gets only DELEGATED_NAMES / DELEGATED_PREFIX (an allowlist, so no provider, cloud or git
 *   credential, whatever its name); what it needs beyond that it gets explicitly, through a launch contribution's
 *   secretEnv.
 * Names in AGENT_PASS_ENV are kept. Names compare case-insensitively (Windows).
 */
/** A plain shell card the person starts: their whole environment, without CanvasTTY's own credentials. */
export function shellEnvironment(source: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !APP_CREDENTIAL.test(key.toUpperCase())));
}

export function agentEnvironment(
  source: Readonly<Record<string, string>>,
  input: AgentEnvironmentInput
): Record<string, string> {
  const passKey = Object.keys(source).find((key) => key.toUpperCase() === AGENT_PASS_ENV);
  const pass = new Set((passKey ? source[passKey] : "").split(/[\s,]+/u).filter(Boolean).map((name) => name.toUpperCase()));
  return Object.fromEntries(Object.entries(source).filter(([key]) => {
    const name = key.toUpperCase();
    if (pass.has(name)) return true;
    if (ADMIN_CREDENTIAL.test(name) || APP_CREDENTIAL.test(name)) return false;
    return !input.delegated || DELEGATED_NAMES.has(name) || DELEGATED_PREFIX.test(name);
  }));
}
