import { execFile } from "node:child_process";
import {readFile,stat} from "node:fs/promises";
import {join} from "node:path";
import type { AgentProviderId } from "../../shared/contracts.ts";
import { providerChildProcessLaunch, type ProviderChildProcessLaunch, type ProviderCliRegistry } from "./providerCliRegistry.ts";

/**
 * The models a provider's CLI lists by itself, for list_providers. Only CLIs with a local listing command that
 * needs no sign-in and calls no paid API are asked: OpenCode (`opencode models`). A read never waits for the CLI:
 * it answers what the last listing found (or nothing) and starts a new listing in the background when that one is
 * missing or old. A listing that fails, times out or prints nothing usable leaves "unknown".
 */

const LISTING_COMMANDS: Partial<Record<AgentProviderId, string[]>> = { opencode: ["models"] };
const LISTING_TIMEOUT_MS = 5_000;
const LISTING_TTL_MS = 10 * 60_000;
const MAX_LISTING_BYTES = 512 * 1024;
const MAX_MODELS = 400;
/** `opencode models` prints one provider/model per line. */
const OPENCODE_MODEL = /^[A-Za-z0-9][\w.@-]*\/[\w.:@/+-]{1,160}$/u;

export interface ProviderModelListing {
  models: string[];
  checkedAt: number;
}

export type ModelListingRunner = (launch: ProviderChildProcessLaunch, timeoutMs: number) => Promise<string>;

export class ProviderModelCatalog {
  private readonly registry: Pick<ProviderCliRegistry, "get">;
  private readonly run: ModelListingRunner;
  private readonly now: () => number;
  private readonly listings = new Map<AgentProviderId, ProviderModelListing>();
  private readonly running = new Map<AgentProviderId, Promise<void>>();
  private readonly codexHome:string|undefined;

  constructor(registry: Pick<ProviderCliRegistry, "get">, options: { run?: ModelListingRunner; now?: () => number;codexHome?:string } = {}) {
    this.registry = registry;
    this.run = options.run ?? runListing;
    this.now = options.now ?? Date.now;
    this.codexHome=options.codexHome;
  }

  /** Whether this provider's models can be listed at all. */
  lists(provider: AgentProviderId): boolean {
    return LISTING_COMMANDS[provider] !== undefined || provider==="codex" && this.codexHome!==undefined;
  }

  /** The last listing, however old; refreshes it in the background when it is missing or old. */
  peek(provider: AgentProviderId): ProviderModelListing | null {
    const listing = this.listings.get(provider) ?? null;
    if (this.lists(provider) && (!listing || this.now() - listing.checkedAt >= LISTING_TTL_MS)) void this.refresh(provider);
    return listing ? { models: [...listing.models], checkedAt: listing.checkedAt } : null;
  }

  /**
   * Why this model would not start: its CLI lists models and this one is not among them (OpenCode then only prints
   * "Unexpected server error"). Null when it is listed, or when there is no listing to judge by (unknown is allowed).
   * `fresh` waits for a listing (at most the listing timeout) when none is cached yet.
   */
  async unknownModel(provider: AgentProviderId, model: string, options: { fresh?: boolean } = {}): Promise<string | null> {
    if (provider!=="opencode") return null;
    if (options.fresh && !this.listings.has(provider)) await this.refresh(provider);
    return this.unknownModelCached(provider, model);
  }

  /** unknownModel from the cached listing only (never waits; a missing listing allows the model). */
  unknownModelCached(provider: AgentProviderId, model: string): string | null {
    if(provider!=="opencode")return null;
    const listing = this.peek(provider);
    if (!listing || listing.models.includes(model)) return null;
    const closest = closestModels(model, listing.models);
    return `${provider} does not list the model ${JSON.stringify(model)} (its CLI's own model list, \`${provider} models\`), and would fail to start with it.`
      + (closest.length > 0 ? ` Closest: ${closest.join(", ")}.` : "")
      + " Call list_providers for the models it lists.";
  }

  /** Lists once at a time per provider; resolves when the listing ended (tests and a warm-up may await it). */
  refresh(provider: AgentProviderId): Promise<void> {
    if(provider==="codex" && this.codexHome){
      const pending=this.running.get(provider);if(pending)return pending;
      const operation=(async()=>{
        try{
          const file=join(this.codexHome!,"models_cache.json");if((await stat(file)).size>MAX_LISTING_BYTES)return;
          const value=JSON.parse(await readFile(file,"utf8"));
          if(!Array.isArray(value.models))return;
          const models=[...new Set<string>(value.models.filter((row:unknown)=>row && typeof row==="object" && "slug" in row && typeof row.slug==="string" && /^[\w.-]{1,160}$/.test(row.slug) && (!("visibility" in row) || row.visibility!=="hide")).map((row:{slug:string})=>row.slug))].slice(0,MAX_MODELS);
          if(models.length)this.listings.set(provider,{models,checkedAt:this.now()});
        }catch{ /* Missing CLI cache is unknown, not a guessed model list. */ }
      })().finally(()=>this.running.delete(provider));this.running.set(provider,operation);return operation;
    }
    const args = LISTING_COMMANDS[provider];
    if (!args) return Promise.resolve();
    const current = this.running.get(provider);
    if (current) return current;
    const listing = (async () => {
      let resolution;
      try { resolution = this.registry.get(provider); } catch { return; }
      if (resolution.state !== "available") return;
      let output: string;
      try { output = await this.run(providerChildProcessLaunch(resolution, args), LISTING_TIMEOUT_MS); } catch { return; }
      const models = [...new Set(output.split(/\r?\n/u).map((line) => line.trim()).filter((line) => OPENCODE_MODEL.test(line)))]
        .slice(0, MAX_MODELS);
      if (models.length > 0) this.listings.set(provider, { models, checkedAt: this.now() });
    })().finally(() => this.running.delete(provider));
    this.running.set(provider, listing);
    return listing;
  }
}

function runListing(launch: ProviderChildProcessLaunch, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(launch.command, launch.args, {
      env: { ...process.env, ...launch.environment },
      timeout: timeoutMs,
      maxBuffer: MAX_LISTING_BYTES,
      windowsHide: true,
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
    }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });
}

/** Up to five listed ids nearest to the asked one: the same provider prefix first, then shared words, then edit distance. */
export function closestModels(model: string, models: readonly string[], limit = 5): string[] {
  const wanted = model.toLowerCase();
  const slash = wanted.indexOf("/");
  const prefix = slash > 0 ? wanted.slice(0, slash + 1) : "";
  const name = slash > 0 ? wanted.slice(slash + 1) : wanted;
  const words = name.split(/[^a-z0-9]+/u).filter((word) => word.length > 1);
  const scored = models.map((candidate) => {
    const lower = candidate.toLowerCase();
    const candidateName = lower.includes("/") ? lower.slice(lower.indexOf("/") + 1) : lower;
    const samePrefix = prefix !== "" && lower.startsWith(prefix);
    const shared = words.filter((word) => candidateName.includes(word)).length;
    const contains = candidateName.includes(name) || name.includes(candidateName);
    return { candidate, samePrefix, shared, contains, distance: editDistance(name, candidateName) };
  });
  return scored
    .filter((entry) => entry.samePrefix || entry.shared > 0 || entry.contains)
    .sort((a, b) => Number(b.samePrefix) - Number(a.samePrefix) || Number(b.contains) - Number(a.contains)
      || b.shared - a.shared || a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_value, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}
