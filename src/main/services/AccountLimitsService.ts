import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import {
  AGENT_PROVIDERS,
  type AgentProviderId,
  type LimitProviderId,
  type LimitSource,
  type LimitUnavailableReason,
  type LimitsSnapshot,
  type ProviderLimitsSnapshot
} from "../../shared/contracts.ts";
import { LimitsService, type ClaudeUsageReadOptions } from "./LimitsService.ts";
import type {
  AvailableProviderCli,
  ProviderCliRegistry,
  ProviderCliResolution
} from "./providerCliRegistry.ts";

const MAX_ACCOUNT_CLIENTS = 8;
const CODEX_IDLE_MS = 60_000;

export interface AccountLimitsRequest {
  provider: LimitProviderId;
  accountId: string;
  /** Trusted account-home path supplied by the host's accepted launch record. */
  home?: string;
}

export type AccountLimitsClient = Pick<LimitsService, "get" | "dispose">
  & Partial<Pick<LimitsService, "providerClisRefreshed">>;

export interface AccountLimitsServiceOptions {
  clientVersion?: string;
  maxClients?: number;
  now?: () => number;
  createLimitsService?: (
    registry: ProviderCliRegistry,
    clientVersion: string,
    options: { codexIdleMs: number; claudeUsageOptions: ClaudeUsageReadOptions }
  ) => AccountLimitsClient;
  /** Test seam; production uses the real Claude OAuth usage reader. */
  claudeUsageOptions?: Omit<ClaudeUsageReadOptions, "configRoot" | "environment">;
}

interface CachedClient {
  key: string;
  touched: number;
  service: AccountLimitsClient;
}

/**
 * Reads usage for one accepted Accounts profile at a time. The scoped registry
 * hides every other provider, and the selected provider receives only this
 * account's private home. A default-profile read is intentionally not offered:
 * callers without an accepted account home receive an unavailable snapshot.
 */
export class AccountLimitsService {
  private readonly providerClis: ProviderCliRegistry;
  private readonly clientVersion: string;
  private readonly maxClients: number;
  private readonly now: () => number;
  private readonly createLimitsService: NonNullable<AccountLimitsServiceOptions["createLimitsService"]>;
  private readonly claudeUsageOptions: AccountLimitsServiceOptions["claudeUsageOptions"];
  private readonly clients = new Map<string, CachedClient>();
  private sequence = 0;
  private disposed = false;

  constructor(providerClis: ProviderCliRegistry, options: AccountLimitsServiceOptions = {}) {
    this.providerClis = providerClis;
    this.clientVersion = options.clientVersion ?? "unknown";
    this.maxClients = boundedClientCount(options.maxClients);
    this.now = options.now ?? Date.now;
    this.createLimitsService = options.createLimitsService
      ?? ((registry, clientVersion, limitsOptions) => new LimitsService(registry, clientVersion, limitsOptions));
    this.claudeUsageOptions = options.claudeUsageOptions;
  }

  async read(request: AccountLimitsRequest): Promise<ProviderLimitsSnapshot> {
    const checkedAt = this.now();
    const source = sourceForProvider(request.provider);
    if (request.provider !== "codex" && request.provider !== "claude") {
      return unavailable(request.provider, source, "unsupported-protocol", checkedAt);
    }
    if (this.disposed) return unavailable(request.provider, source, "protocol-error", checkedAt);
    if (!isAccountId(request.accountId) || request.accountId === "default" || !request.home) {
      return unavailable(request.provider, source, "not-authenticated", checkedAt);
    }

    const canonicalHome = await accountHome(request.provider, request.accountId, request.home);
    if (!canonicalHome) return unavailable(request.provider, source, "not-authenticated", checkedAt);

    const key = JSON.stringify([request.provider, request.accountId, canonicalHome]);
    let cached = this.clients.get(key);
    if (!cached) {
      if (this.clients.size >= this.maxClients) this.evictLeastRecentlyUsed();
      const registry = scopedRegistry(this.providerClis, request.provider, canonicalHome);
      const claudeUsageOptions: ClaudeUsageReadOptions = {
        ...this.claudeUsageOptions,
        configRoot: canonicalHome,
        // Supplying both values keeps the Claude reader inside the accepted
        // profile. In particular, an empty ambient secure-storage variable
        // must never make it fall back to the runtime user's default Keychain.
        environment: {
          CLAUDE_CONFIG_DIR: canonicalHome,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: canonicalHome
        }
      };
      const service = this.createLimitsService(registry, this.clientVersion, {
        codexIdleMs: CODEX_IDLE_MS,
        claudeUsageOptions
      });
      cached = { key, touched: ++this.sequence, service };
      this.clients.set(key, cached);
    } else {
      cached.touched = ++this.sequence;
    }

    try {
      const snapshot: LimitsSnapshot = await cached.service.get();
      const selected = snapshot.providers.find((provider) => provider.provider === request.provider);
      return selected ? structuredClone(selected) : unavailable(request.provider, source, "protocol-error", this.now());
    } catch {
      return unavailable(request.provider, source, "protocol-error", this.now());
    }
  }

  /** Invalidate scoped clients after the host re-resolves executable paths. */
  async providerClisRefreshed(): Promise<void> {
    if (this.disposed) return;
    await Promise.all([...this.clients.values()].map(async (cached) => {
      if (cached.service.providerClisRefreshed) {
        // LimitsService drains its own in-flight read before rebuilding its
        // provider clients from this scoped, now-refreshed registry.
        await cached.service.providerClisRefreshed();
        return;
      }
      cached.service.dispose();
      if (this.clients.get(cached.key) === cached) this.clients.delete(cached.key);
    }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cached of this.clients.values()) cached.service.dispose();
    this.clients.clear();
  }

  private evictLeastRecentlyUsed(): void {
    let oldest: CachedClient | null = null;
    for (const cached of this.clients.values()) {
      if (!oldest || cached.touched < oldest.touched) oldest = cached;
    }
    if (!oldest) return;
    this.clients.delete(oldest.key);
    oldest.service.dispose();
  }
}

function scopedRegistry(
  original: ProviderCliRegistry,
  provider: LimitProviderId,
  home: string
): ProviderCliRegistry {
  const get = (requested: AgentProviderId): ProviderCliResolution => {
    if (requested !== provider) return unavailableCli(requested);
    const selected = original.get(provider);
    if (selected.state === "unavailable") return selected;
    const accountEnvironment: Record<string, string> = provider === "codex"
      ? { CODEX_HOME: home }
      : { CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: home };
    return {
      ...selected,
      environment: { ...selected.environment, ...accountEnvironment }
    } satisfies AvailableProviderCli;
  };
  const snapshot = () => Object.fromEntries(AGENT_PROVIDERS.map((id) => [id, get(id)])) as Record<AgentProviderId, ProviderCliResolution>;
  return Object.freeze({
    get,
    snapshot,
    refresh() {
      original.refresh();
      return snapshot();
    }
  });
}

function unavailableCli(provider: AgentProviderId): ProviderCliResolution {
  return {
    state: "unavailable",
    provider,
    reason: "cli-not-found",
    checked: [],
    diagnostic: `${provider} is outside the selected account scope.`
  };
}

async function accountHome(provider: LimitProviderId, accountId: string, home: string): Promise<string | null> {
  if (!isAbsolute(home) || resolve(home) !== home || basename(home) !== `${provider}-${accountId}`) return null;
  try {
    const [canonical, info] = await Promise.all([realpath(home), stat(home)]);
    return info.isDirectory() && canonical === home ? canonical : null;
  } catch {
    return null;
  }
}

function isAccountId(value: string): boolean {
  return /^[\w-]{1,80}$/.test(value);
}

function boundedClientCount(value: number | undefined): number {
  if (!Number.isInteger(value)) return MAX_ACCOUNT_CLIENTS;
  return Math.max(1, Math.min(32, value!));
}

function sourceForProvider(provider: LimitProviderId): LimitSource {
  switch (provider) {
    case "codex": return "codex-app-server";
    case "claude": return "claude-usage-api";
    case "qwen": return "qwen-cli";
    case "kimi": return "kimi-usage-api";
    case "opencode": return "opencode-go-usage-api";
    case "grok": return "grok-billing-api";
  }
}

function unavailable(
  provider: LimitProviderId,
  source: LimitSource,
  reason: LimitUnavailableReason,
  checkedAt: number
): ProviderLimitsSnapshot {
  return { provider, state: "unavailable", source, reason, checkedAt };
}
