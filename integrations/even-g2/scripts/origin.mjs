import { isIP } from "node:net";

export function buildOrigin(value, { localDevelopment = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Set CANVASTTY_BRIDGE_ORIGIN to an absolute HTTPS origin.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.hostname.includes("*")
  ) {
    throw new Error(
      "The bridge must be an exact origin without credentials, path, query, fragment, or wildcard.",
    );
  }
  const octets =
    isIP(url.hostname) === 4 ? url.hostname.split(".").map(Number) : null;
  const local =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    url.hostname.endsWith(".local") ||
    (octets &&
      (octets[0] === 127 ||
        octets[0] === 10 ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)));
  if (
    url.protocol !== "https:" &&
    !(localDevelopment && local && url.protocol === "http:")
  ) {
    throw new Error(
      "HTTPS is required. --local-development permits HTTP only for a local test origin.",
    );
  }
  return url.origin;
}
