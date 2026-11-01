export type ResolveSystemProxy = (url: string) => Promise<string>;

/** Bridge Chromium's proxy decision to the limits-only CLI, without overriding CLI proxy settings. */
export async function codexSystemProxyEnvironment(
  url: string,
  resolveProxy: ResolveSystemProxy,
  environment: Readonly<NodeJS.ProcessEnv>
): Promise<Record<string, string>> {
  if (Object.entries(environment).some(([key, value]) => (
    /^(?:https?|all)_proxy$/i.test(key) && Boolean(value)
  ))) return {};

  // Respect the first route, including DIRECT. Choosing a later proxy would override
  // PAC/bypass decisions. Never put proxy credentials or arbitrary resolver text in env.
  const first = (await resolveProxy(url)).split(";")[0].trim();
  const match = /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5) ([^\s/]+)$/.exec(first);
  if (!match) return {};
  const schemes: Record<string, string> = {
    PROXY: "http", HTTPS: "https", SOCKS: "socks4a", SOCKS4: "socks4a", SOCKS5: "socks5h"
  };
  const proxy = `${schemes[match[1]]}://${match[2]}`;
  try {
    const parsed = new URL(proxy);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.pathname !== "" && parsed.pathname !== "/")) return {};
    const protocol = new URL(url).protocol;
    if (protocol !== "https:" && protocol !== "http:") return {};
    return { [protocol === "https:" ? "HTTPS_PROXY" : "HTTP_PROXY"]: proxy };
  } catch {
    return {};
  }
}

/** Only retry an actual transport failure from the rate-limits RPC, never auth/decode/RPC errors. */
export function codexRateLimitsNetworkUrl(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code !== -32603 || typeof message !== "string" || message.length > 4096) return null;
  const match = /^failed to fetch codex rate limits: error sending request for url \((https?:\/\/[^)]+)\)$/.exec(message);
  if (!match) return null;
  try {
    const parsed = new URL(match[1]);
    return parsed.username || parsed.password || parsed.hash ? null : parsed.href;
  } catch {
    return null;
  }
}
