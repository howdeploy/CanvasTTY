import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isValidRemoteHost, type AgentProviderId, type AppSettings, type SessionSnapshot } from "../../shared/contracts.ts";
import { ACCOUNT_LOGIN_PROVIDERS } from "../../shared/providerAccountPolicy.ts";
import type { RemoteHostRunner } from "./RemoteHostsService.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface AccountLoginRequest { accountId: string; provider: AgentProviderId; hostId: string; directory: string }
export interface AccountLoginResult { directory: string; sessionId: string }

interface Terminals {
  create(request: { provider: "terminal"; cwd: string; profile: "normal"; position: { x: number; y: number }; title?: string; hostId?: string }): SessionSnapshot;
  input(id: string, data: string): void;
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** The login command runs on the account's own computer, inside that account's directory. */
export function accountLoginCommand(provider: AgentProviderId, directory: string): string {
  if (provider === "codex") return `CODEX_HOME=${quote(directory)} codex login --device-auth -c 'cli_auth_credentials_store="file"'`;
  if (provider === "claude") return `CLAUDE_CONFIG_DIR=${quote(directory)} claude auth login`;
  throw new Error("Login through the app is available for Codex and Claude accounts.");
}

/** Opens a terminal on the account's computer with its login command. Credentials are created there by
 * the vendor CLI and never pass through CanvasTTY. A missing directory becomes a private managed one. */
export class AccountLoginService {
  private readonly settings: () => Pick<AppSettings, "remoteHosts" | "locale">;
  private readonly terminals: Terminals;
  private readonly run: RemoteHostRunner;
  private readonly localRoot: string;

  constructor(options: { settings: () => Pick<AppSettings, "remoteHosts" | "locale">; terminals: Terminals; run: RemoteHostRunner; userDataPath: string }) {
    this.settings = options.settings;
    this.terminals = options.terminals;
    this.run = options.run;
    this.localRoot = join(options.userDataPath, "account-homes");
  }

  async start(input: unknown): Promise<AccountLoginResult> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid account login request.");
    const { accountId, provider, hostId, directory = "" } = input as Partial<AccountLoginRequest>;
    if (typeof accountId !== "string" || !ID.test(accountId)) throw new Error("Invalid account id.");
    if (!ACCOUNT_LOGIN_PROVIDERS.includes(provider as AgentProviderId)) throw new Error("Login through the app is available for Codex and Claude accounts.");
    if (typeof directory !== "string" || directory.length > 4096 || /[\u0000-\u001f\u007f]/u.test(directory) || directory && !directory.startsWith("/")) throw new Error("Account directory must be an absolute path.");
    const host = hostId === "local" ? undefined : this.settings().remoteHosts.find(item => item.id === hostId);
    if (hostId !== "local" && (!host || !isValidRemoteHost(host))) throw new Error("Choose a saved server for this account.");
    let home = directory;
    if (!home) {
      if (!host) {
        const path = join(this.localRoot, accountId);
        await mkdir(path, { recursive: true, mode: 0o700 });
        home = await realpath(path);
      } else {
        const result = await this.run(host, [`sh -c 'umask 077; d="$HOME/.canvastty/accounts/${accountId}"; mkdir -p "$d" && cd "$d" && pwd -P'`], 20_000);
        home = result.stdout.trim().split(/\r?\n/u).at(-1) ?? "";
        if (result.code !== 0 || !home.startsWith("/") || /[\u0000-\u001f\u007f]/u.test(home)) throw new Error("Could not create the account directory on the server.");
      }
    }
    const ru = this.settings().locale === "ru";
    const session = this.terminals.create({
      provider: "terminal", cwd: homedir(), profile: "normal", position: { x: 80, y: 80 },
      title: `${ru ? "Вход" : "Login"}: ${provider === "codex" ? "Codex" : "Claude"}${host ? ` · ${host.label}` : ""}`,
      ...(host ? { hostId: host.id } : {})
    });
    this.terminals.input(session.id, `${accountLoginCommand(provider as AgentProviderId, home)}\r`);
    return { directory: home, sessionId: session.id };
  }
}
