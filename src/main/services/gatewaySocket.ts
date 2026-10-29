import { createHash, timingSafeEqual } from "node:crypto";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rmdir, unlink } from "node:fs/promises";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What the four local gateways (agent browser, orchestration, agent runtime,
// agent control) share: how a capability token is checked, and how a Unix
// socket endpoint is created, published and removed. The protocols differ;
// these checks must not.

/** Unix domain socket paths cap at 104 bytes on macOS; endpoints stay under this. */
export const MAX_UNIX_SOCKET_PATH_BYTES = 100;

/** SHA-256 of a capability token: gateways keep only this, never the token. */
export function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Whether a presented token hashes to `expected`, compared in constant time.
 * A missing digest never matches; the presented digest is wiped afterwards.
 */
export function tokenMatches(token: string, expected: Buffer | null | undefined): boolean {
  const presented = tokenDigest(token);
  const valid = Boolean(expected) && presented.length === expected!.length && timingSafeEqual(presented, expected!);
  presented.fill(0);
  return valid;
}

/** Creates the directory for 0700 and forces the mode: mkdir's mode is masked and skips an existing directory. */
export async function makePrivateDirectory(directory: string, options: { recursive?: boolean } = {}): Promise<void> {
  await mkdir(directory, { recursive: options.recursive ?? false, mode: 0o700 });
  await chmod(directory, 0o700);
}

/** Keeps socket paths short even when the profile or the system temporary directory has a long path. */
export async function createUnixEndpoint(
  filename: string,
  directoryPrefix: string,
  requestedRuntimeDirectory?: string
): Promise<{ endpoint: string; ownedRuntimeDirectory: string | null }> {
  if (requestedRuntimeDirectory) {
    const endpoint = join(requestedRuntimeDirectory, filename);
    if (Buffer.byteLength(endpoint, "utf8") <= MAX_UNIX_SOCKET_PATH_BYTES) {
      await makePrivateDirectory(requestedRuntimeDirectory, { recursive: true });
      return { endpoint, ownedRuntimeDirectory: null };
    }
  }
  let prefix = join(tmpdir(), directoryPrefix);
  // mkdtemp appends six characters. Check before creating any directory.
  if (Buffer.byteLength(join(`${prefix}XXXXXX`, filename), "utf8") > MAX_UNIX_SOCKET_PATH_BYTES) {
    prefix = join("/tmp", directoryPrefix);
  }
  assert(Buffer.byteLength(join(`${prefix}XXXXXX`, filename), "utf8") <= MAX_UNIX_SOCKET_PATH_BYTES,
    "Unix socket endpoint name is too long.");
  const directory = await mkdtemp(prefix);
  try {
    await chmod(directory, 0o700);
    return { endpoint: join(directory, filename), ownedRuntimeDirectory: directory };
  } catch (error) {
    await rmdir(directory).catch(() => undefined);
    throw error;
  }
}

/** Listens on a Unix socket (or named pipe) endpoint and, off Windows, restricts the socket file to its owner. */
export async function listenOnEndpoint(server: Server, endpoint: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (platform === "win32") server.listen({ path: endpoint, readableAll: false, writableAll: false });
    else server.listen(endpoint);
  });
  if (platform !== "win32") await chmod(endpoint, 0o600);
}

/** Closes a server; resolves at once when it is not listening. */
export function closeServer(server: Pick<Server, "listening" | "close">): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

/**
 * Removes the socket file (`socketFile`; a Windows named pipe has none) and the
 * directory the gateway created for it. A missing file is fine; other errors
 * throw unless `ignoreErrors`.
 */
export async function removeEndpoint(
  endpoint: string,
  ownedDirectory: string | null,
  options: { socketFile: boolean; ignoreErrors?: boolean }
): Promise<void> {
  const tolerate = (error: unknown): void => {
    if (options.ignoreErrors || (error && typeof error === "object" && "code" in error && error.code === "ENOENT")) return;
    throw error;
  };
  if (options.socketFile) await unlink(endpoint).catch(tolerate);
  if (ownedDirectory) await rmdir(ownedDirectory).catch(tolerate);
}
