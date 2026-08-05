/**
 * Normalizes a browser card address into a loadable http(s) URL.
 * Bare hosts get https:// by default; loopback hosts get http://.
 * Returns null for empty input and non-web schemes.
 */
export function normalizeUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) url.protocol = "http:";
    return url.href;
  } catch {
    return null;
  }
}
