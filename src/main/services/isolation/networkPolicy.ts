import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP, type AddressInfo, createConnection, type Server as NetServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { domainToASCII } from "node:url";
import type { ProviderId } from "../../../shared/contracts.ts";

export type AgentNetworkMode = "open" | "allowed-domains" | "offline";

/** The editable part of a network policy. Project records replace the global record. */
export interface AgentNetworkPolicy {
  mode: AgentNetworkMode;
  providerApis: boolean;
  packageRegistries: boolean;
  domains: string[];
}

export interface AgentNetworkLaunch {
  mode: AgentNetworkMode;
  /** Domains actually allowed for this provider and project. */
  domains: readonly string[];
  /** Present for allowed-domains on macOS; the sandbox permits only this exact loopback TCP port. */
  macProxyPort?: number;
  /** Present for allowed-domains on Linux; bubblewrap bind-mounts this socket into the network namespace. */
  unixProxyPath?: string;
  /** One-launch credential required by the host proxy. */
  token?: string;
  /** Removes this launch's host-side proxy grant. */
  cleanup(): void;
}

export interface AgentNetworkSummary {
  mode: AgentNetworkMode;
  domains: string[];
}

export interface NetworkPolicyManagerOptions {
  userDataPath: string;
  platform?: NodeJS.Platform;
  tempRoot?: string;
  now?: () => number;
  /** Human-configured model gateways. Agent-writable project configuration is never a source. */
  providerDomains?: (provider:ProviderId)=>readonly string[];
  /** Test seams; production resolves once and dials the resulting IP literal directly. */
  resolveAddress?: (hostname: string) => Promise<string | null>;
  openConnection?: (address: string, port: number) => Socket;
}

export type AgentNetworkPolicyInput = Pick<AgentNetworkPolicy, "mode" | "domains"> & Partial<Pick<AgentNetworkPolicy, "providerApis" | "packageRegistries">>;

interface PolicyDocument {
  version: 1;
  global: AgentNetworkPolicy;
  projects: Record<string, AgentNetworkPolicy>;
}

interface ProxyGrant { domains: readonly string[]; tokenDigest: Buffer }

const DEFAULT_POLICY: AgentNetworkPolicy = Object.freeze({
  mode: "open", providerApis: true, packageRegistries: true, domains: []
});

const PROVIDER_DOMAINS: Partial<Record<ProviderId, readonly string[]>> = {
  codex: ["api.openai.com", "auth.openai.com", "chatgpt.com", "openai.com"],
  claude: ["api.anthropic.com", "claude.ai", "console.anthropic.com", "anthropic.com"],
  qwen: ["dashscope.aliyuncs.com", "aliyun.com", "qianwen.com"],
  kimi: ["api.moonshot.ai", "api.moonshot.cn", "kimi.com", "moonshot.cn"],
  opencode: ["opencode.ai", "models.dev"],
  hermes: ["integrate.api.nvidia.com", "api.nvidia.com", "nvidia.com"],
  grok: ["api.x.ai", "x.ai"],
  cursor: ["api2.cursor.sh", "api.cursor.sh", "cursor.com"],
  minimax: ["api.minimax.io", "api.minimax.chat", "minimax.io"],
  antigravity: ["googleapis.com", "google.com"],
  pi: [], omp: [], devin: []
};

const PACKAGE_REGISTRY_DOMAINS = [
  "registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org", "rubygems.org",
  "index.crates.io", "static.crates.io", "crates.io", "proxy.golang.org", "sum.golang.org",
  "repo.maven.apache.org", "plugins.gradle.org", "downloads.gradle.org"
];

const MAX_DOCUMENT_BYTES = 256 * 1024;
const PROXY_HEADERS_TIMEOUT_MS = 10_000;
const PROXY_REQUEST_TIMEOUT_MS = 30_000;
const PROXY_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Stores the user's global and per-project policy and owns the strict-mode egress proxy. Proxy listeners are prepared
 * asynchronously during startup; `prepareLaunch` is synchronous and fails closed until they are ready.
 */
export class NetworkPolicyManager {
  private readonly options: NetworkPolicyManagerOptions;
  private readonly platform: NodeJS.Platform;
  private readonly policyPath: string;
  private readonly socketPath: string | null;
  private readonly grants = new Set<ProxyGrant>();
  private httpServer: ReturnType<typeof createHttpServer> | null = null;
  private socketServer: NetServer | null = null;
  private tcpPort: number | null = null;
  private proxyReady = false;
  private startPromise: Promise<void> | null = null;
  private startFailure: string | null = null;
  private cachedDocument: PolicyDocument | null = null;

  constructor(options: NetworkPolicyManagerOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
    this.policyPath = join(options.userDataPath, "agent-network-policy.json");
    // Keep the socket path short enough for Linux's sockaddr_un limit and unpredictable for same-UID local clients.
    this.socketPath = this.platform === "linux"
      ? join(options.tempRoot ?? tmpdir(), `ctty-net-${randomBytes(12).toString("hex")}.sock`)
      : null;
  }

  /** Starts the host-only proxy; call once while the main process is booting. */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startProxy().catch((error: unknown) => {
      this.startFailure = error instanceof Error ? error.message : String(error);
      throw error;
    });
    return this.startPromise;
  }

  /** Whether strict allowed-domains launches can be prepared on this host. */
  availability(): { available: true } | { available: false; reason: string } {
    if (this.platform === "win32") return { available: false, reason: "Network restrictions for isolated agents are not available on Windows yet." };
    if (this.platform !== "darwin" && this.platform !== "linux") {
      return { available: false, reason: `Network restrictions for isolated agents are not available on ${this.platform}.` };
    }
    if (!this.proxyReady) {
      return { available: false, reason: this.startFailure ?? "The restricted-network proxy has not started." };
    }
    if (this.platform === "linux" && !this.socketPath) return { available: false, reason: "The Linux proxy socket is unavailable." };
    return { available: true };
  }

  getGlobalPolicy(): AgentNetworkPolicy { return clonePolicy(this.readDocument().global); }

  getProjectPolicy(projectPath: string): AgentNetworkPolicy {
    const document = this.readDocument();
    return clonePolicy(document.projects[projectKey(projectPath)] ?? document.global);
  }

  /** Alias used by launchers and settings IPC. */
  getPolicy(projectPath?: string): AgentNetworkPolicy {
    return projectPath ? this.getProjectPolicy(projectPath) : this.getGlobalPolicy();
  }

  getEffectivePolicy(projectPath: string | undefined, provider: ProviderId, accountApiDomains: readonly string[] = []): AgentNetworkSummary {
    const policy = this.getPolicy(projectPath);
    if (policy.mode !== "allowed-domains") return { mode: policy.mode, domains: [] };
    const domains = [...new Set([
      ...(policy.providerApis ? (PROVIDER_DOMAINS[provider] ?? []) : []),
      ...(policy.providerApis && provider==="opencode" ? Object.values(PROVIDER_DOMAINS).flat() : []),
      ...(policy.providerApis ? this.options.providerDomains?.(provider) ?? [] : []),
      ...(policy.providerApis ? accountApiDomains : []),
      ...(policy.packageRegistries ? PACKAGE_REGISTRY_DOMAINS : []), ...policy.domains
    ].map(canonicalDomain))].sort();
    return { mode: policy.mode, domains };
  }

  setGlobalPolicy(policy: AgentNetworkPolicyInput): AgentNetworkPolicy {
    const current = this.readDocument();
    const document: PolicyDocument = { ...current, projects: { ...current.projects } };
    document.global = validatePolicy(policy);
    this.writeDocument(document);
    return clonePolicy(document.global);
  }

  /** `null` removes a project override and inherits the global policy. */
  setProjectPolicy(projectPath: string, policy: AgentNetworkPolicyInput | null): AgentNetworkPolicy {
    const current = this.readDocument();
    const document: PolicyDocument = { ...current, projects: { ...current.projects } };
    const key = projectKey(projectPath);
    if (policy === null) delete document.projects[key];
    else document.projects[key] = validatePolicy(policy);
    this.writeDocument(document);
    return clonePolicy(document.projects[key] ?? document.global);
  }

  setPolicy(policy: AgentNetworkPolicyInput, projectPath?: string): AgentNetworkPolicy {
    return projectPath ? this.setProjectPolicy(projectPath, policy) : this.setGlobalPolicy(policy);
  }

  /** Resolves provider, registry and user-chosen domains and grants a single launch access to that exact set. */
  prepareLaunch(projectPath: string, provider: ProviderId, accountApiDomains: readonly string[] = []): AgentNetworkLaunch {
    const policy = this.getProjectPolicy(projectPath);
    if (policy.mode !== "allowed-domains") return { mode: policy.mode, domains: [], cleanup() {} };
    const available = this.availability();
    if (!available.available) throw new Error(`Allowed-domains network mode is unavailable: ${available.reason}`);
    const domains=this.getEffectivePolicy(projectPath,provider,accountApiDomains).domains;
    const token = randomBytes(32).toString("hex");
    const grant: ProxyGrant = { domains, tokenDigest: createHash("sha256").update(token, "utf8").digest() };
    this.grants.add(grant);
    let cleaned = false;
    return {
      mode: "allowed-domains", domains, token,
      ...(this.platform === "darwin" && this.tcpPort ? { macProxyPort: this.tcpPort } : {}),
      ...(this.platform === "linux" && this.socketPath ? { unixProxyPath: this.socketPath } : {}),
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        this.grants.delete(grant);
      }
    };
  }

  /** Removes listeners and all launch grants during app shutdown. */
  async close(): Promise<void> {
    this.grants.clear();
    const closeServer = (server: { close(callback?: (error?: Error) => void): unknown } | null): Promise<void> => new Promise((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    await Promise.all([closeServer(this.httpServer), closeServer(this.socketServer)]);
    this.httpServer = null;
    this.socketServer = null;
    this.proxyReady = false;
    if (this.socketPath) rmSync(this.socketPath, { force: true });
  }

  private async startProxy(): Promise<void> {
    if (this.platform !== "darwin" && this.platform !== "linux") throw new Error(`Network proxy is unavailable on ${this.platform}.`);
    const server = createHttpServer({
      maxHeaderSize: 16 * 1024,
      headersTimeout: PROXY_HEADERS_TIMEOUT_MS,
      requestTimeout: PROXY_REQUEST_TIMEOUT_MS,
      keepAliveTimeout: 5_000
    }, (request, response) => {
      void this.forwardHttp(request, response).catch(() => sendResponse(response, 502, "Proxy request failed"));
    });
    server.on("connect", (request, socket, head) => {
      void this.forwardConnect(request, socket, head).catch(() => refuseSocket(socket, 502, "Proxy request failed"));
    });
    server.on("clientError", (_error, socket) => { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });
    server.maxHeadersCount = 64;
    this.httpServer = server;
    if (this.platform === "darwin") {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
          server.off("error", reject);
          const address = server.address() as AddressInfo | null;
          if (!address || address.port < 1) return reject(new Error("The restricted-network proxy did not receive a TCP port."));
          this.tcpPort = address.port;
          this.proxyReady = true;
          resolve();
        });
      });
      return;
    }
    const socketPath = this.socketPath!;
    mkdirSync(this.options.tempRoot ?? tmpdir(), { recursive: true, mode: 0o700 });
    if (existsSync(socketPath)) rmSync(socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        chmodSync(socketPath, 0o600);
        this.proxyReady = true;
        resolve();
      });
    });
  }

  private authorize(request: IncomingMessage): ProxyGrant | null {
    const header = request.headers["proxy-authorization"];
    if (typeof header !== "string") return null;
    const match = /^Basic ([A-Za-z0-9+/=]+)$/u.exec(header);
    if (!match) return null;
    let credential = "";
    try { credential = Buffer.from(match[1]!, "base64").toString("utf8"); } catch { return null; }
    const colon = credential.indexOf(":");
    if (colon < 0 || credential.slice(0, colon) !== "canvastty") return null;
    const token = credential.slice(colon + 1);
    const presentedDigest = createHash("sha256").update(token, "utf8").digest();
    let matched: ProxyGrant | null = null;
    // Compare fixed-size digests for every live launch. Do not use a string Map lookup or stop at the first match.
    for (const grant of this.grants) {
      if (timingSafeEqual(presentedDigest, grant.tokenDigest)) matched = grant;
    }
    return matched;
  }

  private async forwardConnect(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    const grant = this.authorize(request);
    if (!grant) return refuseSocket(client, 407, "Proxy authentication required");
    const target = parseAuthority(request.url ?? "", 443);
    if (!target || !domainAllowed(target.hostname, grant.domains) || ![80, 443].includes(target.port)) {
      return refuseSocket(client, 403, "Destination is not allowed");
    }
    const address = await this.resolveAddress(target.hostname);
    if (!address) return refuseSocket(client, 403, "Destination DNS is not public");
    if (client.destroyed) return;
    const upstream = this.openConnection(address, target.port);
    let connected = false;
    let finished = false;
    const timer = setTimeout(() => fail(), PROXY_CONNECT_TIMEOUT_MS);
    const clearDeadline = (): void => {
      clearTimeout(timer); upstream.off("connect", onConnect); client.off("end", onClientEnd);
    };
    const onClientClose = (): void => {
      finished = true; clearDeadline();
      client.off("close", onClientClose); client.off("error", onClientClose);
      // Keep the upstream error sink until close: destroying a pending dial can queue an error.
      upstream.destroy(); client.destroy();
    };
    const onClientEnd = (): void => { if (!connected) onClientClose(); };
    const fail = (): void => {
      if (finished) return;
      finished = true; clearDeadline(); upstream.destroy();
      if (connected) client.destroy(); else refuseSocket(client, 502, "Proxy connection failed");
    };
    const onError = (): void => fail();
    const onClose = (): void => {
      if (!connected && !finished) fail();
      else if (connected && !upstream.readableEnded) client.destroy();
      clearDeadline(); upstream.off("error", onError); upstream.off("close", onClose);
      // A normal connected EOF is flushed by pipe/end; only an abrupt close tears down its client.
    };
    const onConnect = (): void => {
      if (finished || client.destroyed) { onClientClose(); return; }
      connected = true; clearDeadline();
      client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: CanvasTTY\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    };
    upstream.once("error", onError); upstream.once("close", onClose); upstream.once("connect", onConnect);
    client.once("close", onClientClose); client.once("error", onClientClose); client.once("end", onClientEnd);
  }

  private async forwardHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const grant = this.authorize(request);
    if (!grant) return sendResponse(response, 407, "Proxy authentication required");
    let target: URL;
    try { target = new URL(request.url ?? ""); } catch { return sendResponse(response, 400, "Absolute proxy URL required"); }
    const port = target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
    let hostname: string;
    try { hostname = canonicalDomain(target.hostname); }
    catch { return sendResponse(response, 403, "Destination is not allowed"); }
    if (!new Set(["http:", "https:"]).has(target.protocol) || !domainAllowed(hostname, grant.domains) || ![80, 443].includes(port)) {
      return sendResponse(response, 403, "Destination is not allowed");
    }
    if (target.protocol !== "http:") return sendResponse(response, 400, "HTTPS proxy requests must use CONNECT");
    const address = await this.resolveAddress(hostname);
    if (!address) return sendResponse(response, 403, "Destination DNS is not public");
    if (response.destroyed || request.aborted) return;
    const headers = { ...request.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    headers.host = target.host;
    headers.connection = "close";
    let connected = false;
    let finished = false;
    let socket: Socket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearDeadline = (): void => { if (timer !== undefined) clearTimeout(timer); socket?.off("connect", onConnect); };
    const onConnect = (): void => { connected = true; clearDeadline(); };
    const onSocket = (value: Socket): void => {
      socket = value;
      if (finished) { value.destroy(); return; }
      if (value.connecting) value.once("connect", onConnect); else onConnect();
    };
    const cleanup = (): void => {
      clearDeadline(); upstream.off("socket", onSocket); upstream.off("error", onError); upstream.off("close", onClose);
      request.off("aborted", onClientClose); response.off("close", onClientClose);
    };
    const onClientClose = (): void => {
      finished = true; clearDeadline();
      request.off("aborted", onClientClose); response.off("close", onClientClose);
      // ClientRequest can emit a queued ECONNRESET after destruction; close owns final listener cleanup.
      upstream.destroy();
    };
    const fail = (): void => {
      if (finished) return;
      finished = true; clearDeadline(); upstream.destroy();
      sendResponse(response, 502, "Proxy connection failed");
    };
    const onError = (): void => fail();
    const onClose = (): void => { if (!connected && !finished) fail(); cleanup(); };
    const upstream = httpRequest({
      protocol: "http:", hostname, port, path: `${target.pathname}${target.search}`,
      method: request.method, headers,
      // A custom connection bypasses pooling and dials only the already validated public IP.
      createConnection: () => this.openConnection(address, port)
    }, (upstreamResponse) => {
      if (finished || response.destroyed) { upstreamResponse.destroy(); return; }
      onConnect();
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    timer = setTimeout(() => fail(), PROXY_CONNECT_TIMEOUT_MS);
    upstream.once("socket", onSocket); upstream.once("error", onError); upstream.once("close", onClose);
    request.once("aborted", onClientClose); response.once("close", onClientClose);
    request.pipe(upstream);
  }

  private readDocument(): PolicyDocument {
    if (this.cachedDocument) return this.cachedDocument;
    if (!existsSync(this.policyPath)) {
      this.cachedDocument = { version: 1, global: clonePolicy(DEFAULT_POLICY), projects: {} };
      return this.cachedDocument;
    }
    let text: string;
    try { text = readFileSync(this.policyPath, "utf8"); } catch { throw new Error("Could not read the saved agent network policy."); }
    if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) throw new Error("The saved agent network policy is too large.");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("The saved agent network policy is invalid JSON; strict network settings were not changed."); }
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.projects)) throw new Error("The saved agent network policy has an unsupported format.");
    const global = validatePolicy(parsed.global);
    const projects: Record<string, AgentNetworkPolicy> = {};
    for (const [key, value] of Object.entries(parsed.projects)) {
      if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error("The saved agent network policy contains an invalid project key.");
      projects[key] = validatePolicy(value);
    }
    this.cachedDocument = { version: 1, global, projects };
    return this.cachedDocument;
  }

  private writeDocument(document: PolicyDocument): void {
    mkdirSync(this.options.userDataPath, { recursive: true, mode: 0o700 });
    const temp = `${this.policyPath}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, this.policyPath);
    this.cachedDocument = null;
  }

  private async resolveAddress(hostname: string): Promise<string | null> {
    const address = await (this.options.resolveAddress ?? pinnedPublicAddress)(hostname);
    return address && isPublicAddress(address) ? address : null;
  }

  private openConnection(address: string, port: number): Socket {
    return (this.options.openConnection ?? ((ip, destinationPort) => createConnection({ host: ip, port: destinationPort })))(address, port);
  }
}

export function validatePolicy(input: unknown): AgentNetworkPolicy {
  if (!isRecord(input) || !["open", "allowed-domains", "offline"].includes(String(input.mode))) throw new Error("Choose open, allowed-domains or offline network mode.");
  if ((input.providerApis !== undefined && typeof input.providerApis !== "boolean")
      || (input.packageRegistries !== undefined && typeof input.packageRegistries !== "boolean")
      || !Array.isArray(input.domains)) throw new Error("Agent network policy requires boolean provider/package choices and a domains list.");
  if (input.domains.length > 500) throw new Error("At most 500 agent network domains can be saved.");
  const domains = [...new Set(input.domains.map((domain) => {
    if (typeof domain !== "string") throw new Error("Network domains must be strings.");
    return canonicalDomain(domain);
  }))].sort();
  return {
    mode: input.mode as AgentNetworkMode,
    providerApis: input.providerApis === undefined ? true : input.providerApis as boolean,
    packageRegistries: input.packageRegistries === undefined ? true : input.packageRegistries as boolean,
    domains
  };
}

/** Domains include their subdomains; `*.example.com` patterns exclude the root; URLs, ports and IP literals are refused. */
export function canonicalDomain(input: string): string {
  const value = input.trim().toLowerCase().replace(/\.$/u, "");
  const wildcard = value.startsWith("*.");
  const raw = wildcard ? value.slice(2) : value;
  const ascii = domainToASCII(raw);
  if (wildcard && ascii && ascii.split(".").length < 2) throw new Error(`Wildcard network domain is too broad: ${input}`);
  if (!ascii || ascii.length > 253 || ascii.includes("/") || ascii.includes(":") || isIP(ascii)
      || !ascii.includes(".") || ascii.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    throw new Error(`Invalid network domain: ${input}`);
  }
  return `${wildcard ? "*." : ""}${ascii}`;
}

function domainAllowed(hostname: string, rules: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return rules.some((rule) => rule.startsWith("*.")
    ? host !== rule.slice(2) && host.endsWith(`.${rule.slice(2)}`)
    : host === rule || host.endsWith(`.${rule}`));
}

function parseAuthority(authority: string, defaultPort: number): { hostname: string; port: number } | null {
  try {
    const url = new URL(`http://${authority}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    const hostname = canonicalDomain(url.hostname);
    const port = url.port ? Number(url.port) : defaultPort;
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? { hostname, port } : null;
  } catch { return null; }
}

/** DNS is resolved once, all answers must be public, and the upstream socket connects to a pinned IP literal. */
export async function pinnedPublicAddress(hostname: string): Promise<string | null> {
  if (isIP(hostname)) return null;
  let records: Array<{ address: string; family: number }>;
  try { records = await lookup(hostname, { all: true, verbatim: true }); } catch { return null; }
  if (records.length === 0 || records.some(({ address }) => !isPublicAddress(address))) return null;
  return records[0]!.address;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const [a, b, c] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b! >= 64 && b! <= 127
      || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31
      || a === 192 && (b === 168 || b === 0 || b === 88 && c! === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c! === 100)
      || a === 203 && b === 0 && c! === 113);
  }
  if (family === 6) {
    const value = address.toLowerCase();
    // Public global-unicast is 2000::/3. Also reject documentation, discard-only, and IPv4-mapped values.
    return /^2[0-9a-f]{3}:/u.test(value) && !value.startsWith("2001:db8:") && !value.startsWith("2001:10:");
  }
  return false;
}

function refuseSocket(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function sendResponse(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(message), connection: "close" });
  response.end(message);
}

function projectKey(projectPath: string): string {
  let canonical = resolve(projectPath);
  try { canonical = realpathSync.native(canonical); } catch { /* a new project path is still a stable key */ }
  return createHash("sha256").update(canonical.normalize("NFC")).digest("hex");
}

function clonePolicy(policy: AgentNetworkPolicy): AgentNetworkPolicy {
  return { mode: policy.mode, providerApis: policy.providerApis, packageRegistries: policy.packageRegistries, domains: [...policy.domains] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
