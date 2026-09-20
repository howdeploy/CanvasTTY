import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { isIP } from "node:net";
import type { EvenG2Address } from "../../../shared/evenG2.ts";

export function isPrivateIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}
export function isPrivateIpv6(address: string): boolean {
  return isIP(address) === 6 && /^f[cd]/i.test(address);
}
export function addressOrigin(address: string, port: number): string {
  return `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
}

/** Offer explicit private interfaces; never listen on all interfaces or a public IP. */
export function lanAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): EvenG2Address[] {
  return Object.entries(interfaces)
    .flatMap(([name, entries]) =>
      (entries || [])
        .filter(
          (entry) =>
            !entry.internal &&
            (isPrivateIpv4(entry.address) || isPrivateIpv6(entry.address)),
        )
        .map((entry) => ({
          id: name + ":" + entry.address,
          name,
          address: entry.address,
        })),
    )
    .sort(
      (a, b) =>
        Number(/^(utun|tun|tap|bridge|docker|veth|vmnet)/.test(a.name)) -
          Number(/^(utun|tun|tap|bridge|docker|veth|vmnet)/.test(b.name)) ||
        a.name.localeCompare(b.name) ||
        Number(b.address.includes(":")) - Number(a.address.includes(":")),
    );
}

/** Public connection endpoints must use a valid, exact HTTPS origin. */
export function httpsOrigin(value: string): string {
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid-public-origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.hostname.includes("*")
  )
    throw new Error("invalid-public-origin");
  return url.origin;
}
