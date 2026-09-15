import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const RELAY_MAGIC = 0x4850_5443;
const RELAY_VERSION = 1;
const RELAY_HEADER_BYTES = 16;
const MAX_RELAY_PAYLOAD_BYTES = 512 * 1024 + 1;
const MAX_HOST_STDERR_BYTES = 8 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

export const WINDOWS_PIPE_HOST_FILENAME = "canvastty-windows-agent-pipe-host.exe";

const HOST_TO_PARENT = {
  ready: 1,
  connect: 2,
  data: 3,
  close: 4,
  fatal: 5
} as const;

const PARENT_TO_HOST = {
  write: 16,
  destroy: 17,
  shutdown: 18
} as const;

export interface AgentGatewaySocket {
  readonly destroyed: boolean;
  setNoDelay(noDelay?: boolean): this;
  write(data: Uint8Array): boolean;
  destroy(error?: Error): this;
  on(event: "data", listener: (data: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: () => void): this;
}

export interface WindowsPipeHostTransportOptions {
  hostPath: string;
  parentPid?: number;
  startupTimeoutMs?: number;
  platform?: NodeJS.Platform;
  spawnHost?: typeof spawn;
}

interface RelayFrame {
  type: number;
  connectionId: number;
  payload: Buffer;
}

/**
 * Relays secured Windows named-pipe clients through a tiny native process.
 *
 * Node's named-pipe server API cannot attach an explicit SECURITY_ATTRIBUTES
 * descriptor at CreateNamedPipeW time. The native host owns only the pipe
 * handles; all authentication and browser policy remain in AgentGateway.
 */
export class WindowsPipeHostTransport extends EventEmitter {
  private readonly options: Required<Pick<WindowsPipeHostTransportOptions, "parentPid" | "startupTimeoutMs" | "platform">>
    & Pick<WindowsPipeHostTransportOptions, "hostPath" | "spawnHost">;
  private readonly sockets = new Map<number, WindowsRelaySocket>();
  private decoder = new RelayFrameDecoder();
  private child: ChildProcessWithoutNullStreams | null = null;
  private endpoint: string | null = null;
  private started = false;
  private closing = false;
  private stderr = "";
  private accept: ((socket: AgentGatewaySocket) => void) | null = null;

  constructor(options: WindowsPipeHostTransportOptions) {
    super();
    this.options = {
      hostPath: options.hostPath,
      parentPid: options.parentPid ?? process.pid,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      platform: options.platform ?? process.platform,
      spawnHost: options.spawnHost
    };
  }

  get address(): string {
    if (!this.endpoint || !this.started) throw new Error("Windows agent pipe host has not started.");
    return this.endpoint;
  }

  get isRunning(): boolean {
    return this.started && Boolean(this.child) && !this.closing;
  }

  async start(accept: (socket: AgentGatewaySocket) => void): Promise<string> {
    if (this.isRunning) return this.address;
    if (this.child) throw new Error("Windows agent pipe host is already starting.");
    if (this.options.platform !== "win32") {
      throw new Error("The Windows agent pipe host can only run on Windows.");
    }
    if (!isAbsolute(this.options.hostPath)) {
      throw new Error("Windows agent pipe host path must be absolute.");
    }
    const metadata = await stat(this.options.hostPath);
    if (!metadata.isFile()) throw new Error("Windows agent pipe host path is not a file.");

    this.accept = accept;
    this.closing = false;
    this.stderr = "";
    // A failed session can leave a partial frame in the decoder buffer; a restarted
    // host feeds an unrelated stream.
    this.decoder = new RelayFrameDecoder();
    const spawnHost = this.options.spawnHost ?? spawn;
    const child = spawnHost(
      this.options.hostPath,
      ["--parent-pid", String(this.options.parentPid)],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        env: windowsHostEnvironment(process.env)
      }
    ) as ChildProcessWithoutNullStreams;
    this.child = child;

    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const settleError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        settleError(new Error("Windows agent pipe host did not become ready before the startup deadline."));
        void this.close();
      }, this.options.startupTimeoutMs);
      timeout.unref();

      child.stdout.on("data", (chunk: Buffer) => {
        try {
          for (const frame of this.decoder.push(chunk)) {
            if (frame.type === HOST_TO_PARENT.ready && !settled) {
              const endpoint = parseReadyEndpoint(frame);
              this.endpoint = endpoint;
              this.started = true;
              settled = true;
              clearTimeout(timeout);
              resolve(endpoint);
              continue;
            }
            this.handleFrame(frame);
          }
        } catch (error) {
          const failure = error instanceof Error ? error : new Error("Windows pipe relay protocol failed.");
          settleError(failure);
          this.fail(failure);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (this.stderr.length >= MAX_HOST_STDERR_BYTES) return;
        this.stderr = (this.stderr + chunk.toString("utf8")).slice(0, MAX_HOST_STDERR_BYTES);
      });
      child.once("error", (error) => {
        settleError(new Error(`Windows agent pipe host could not start: ${error.message}`));
        this.fail(error);
      });
      child.once("exit", (code, signal) => {
        const details = this.stderr.trim();
        const suffix = details ? ` ${details}` : "";
        const failure = new Error(
          `Windows agent pipe host exited (${signal ?? code ?? "unknown"}).${suffix}`
        );
        settleError(failure);
        if (!this.closing) this.fail(failure);
        this.child = null;
        this.started = false;
        this.endpoint = null;
      });
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const child = this.child;
    if (!child) {
      this.finishClose();
      return;
    }

    try {
      this.send(PARENT_TO_HOST.shutdown, 0, Buffer.alloc(0));
    } catch {
      // Closing stdin below remains a reliable shutdown signal.
    }
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            child.kill();
            resolve();
          }, 2_000);
          timeout.unref();
        })
      ]);
    }
    this.finishClose();
  }

  write(connectionId: number, data: Uint8Array): boolean {
    if (data.byteLength > MAX_RELAY_PAYLOAD_BYTES) {
      throw new Error("Windows pipe relay write exceeds the bounded frame size.");
    }
    return this.send(PARENT_TO_HOST.write, connectionId, Buffer.from(data));
  }

  destroy(connectionId: number): void {
    if (!this.child || this.closing) return;
    try {
      this.send(PARENT_TO_HOST.destroy, connectionId, Buffer.alloc(0));
    } catch {
      // The transport failure path closes the virtual socket as well.
    }
  }

  private handleFrame(frame: RelayFrame): void {
    if (!this.started) {
      if (frame.type === HOST_TO_PARENT.fatal) {
        throw new Error(safeHostMessage(frame.payload));
      }
      throw new Error("Windows pipe host sent a connection frame before READY.");
    }
    if (frame.type === HOST_TO_PARENT.connect) {
      if (frame.connectionId === 0 || frame.payload.length !== 0 || this.sockets.has(frame.connectionId)) {
        throw new Error("Windows pipe host sent an invalid CONNECT frame.");
      }
      const socket = new WindowsRelaySocket(frame.connectionId, this);
      this.sockets.set(frame.connectionId, socket);
      try {
        this.accept?.(socket);
      } catch (error) {
        socket.destroy(error instanceof Error ? error : undefined);
      }
      return;
    }
    if (frame.type === HOST_TO_PARENT.data) {
      if (frame.payload.length === 0) return;
      this.sockets.get(frame.connectionId)?.receive(frame.payload);
      return;
    }
    if (frame.type === HOST_TO_PARENT.close) {
      if (frame.payload.length !== 0 && frame.payload.length !== 4) {
        throw new Error("Windows pipe host sent an invalid CLOSE frame.");
      }
      const socket = this.sockets.get(frame.connectionId);
      this.sockets.delete(frame.connectionId);
      socket?.remoteClose();
      return;
    }
    if (frame.type === HOST_TO_PARENT.fatal) {
      this.fail(new Error(safeHostMessage(frame.payload)));
      return;
    }
    throw new Error("Windows pipe host sent an unknown relay frame.");
  }

  private send(type: number, connectionId: number, payload: Buffer): boolean {
    const child = this.child;
    if (!child || child.stdin.destroyed || this.closing && type !== PARENT_TO_HOST.shutdown) {
      throw new Error("Windows agent pipe host is unavailable.");
    }
    return child.stdin.write(encodeRelayFrame(type, connectionId, payload));
  }

  private fail(error: Error): void {
    if (this.closing) return;
    this.started = false;
    this.endpoint = null;
    for (const socket of this.sockets.values()) socket.transportFailure(error);
    this.sockets.clear();
    this.emit("fatal", error);
    this.closing = true;
    this.child?.stdin.destroy();
    this.child?.kill();
    // A raised `closing` flag used to leave the transport half-closed: close() became a
    // no-op and the stale child blocked the next start(). Finish the close here instead.
    this.finishClose();
  }

  private finishClose(): void {
    for (const socket of this.sockets.values()) socket.remoteClose();
    this.sockets.clear();
    this.child = null;
    this.endpoint = null;
    this.started = false;
    this.accept = null;
  }
}

class WindowsRelaySocket extends EventEmitter implements AgentGatewaySocket {
  destroyed = false;
  private readonly connectionId: number;
  private readonly transport: WindowsPipeHostTransport;

  constructor(
    connectionId: number,
    transport: WindowsPipeHostTransport
  ) {
    super();
    this.connectionId = connectionId;
    this.transport = transport;
  }

  setNoDelay(): this {
    return this;
  }

  write(data: Uint8Array): boolean {
    if (this.destroyed) return false;
    return this.transport.write(this.connectionId, data);
  }

  destroy(error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.transport.destroy(this.connectionId);
    if (error && this.listenerCount("error") > 0) this.emit("error", error);
    this.emit("close");
    return this;
  }

  receive(data: Buffer): void {
    if (!this.destroyed) this.emit("data", data);
  }

  remoteClose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }

  transportFailure(error: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.listenerCount("error") > 0) this.emit("error", error);
    this.emit("close");
  }
}

class RelayFrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): RelayFrame[] {
    if (chunk.length === 0) return [];
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const frames: RelayFrame[] = [];
    while (this.buffer.length >= RELAY_HEADER_BYTES) {
      if (this.buffer.readUInt32LE(0) !== RELAY_MAGIC || this.buffer.readUInt8(4) !== RELAY_VERSION) {
        throw new Error("Windows pipe relay header is invalid.");
      }
      if (this.buffer.readUInt16LE(6) !== 0) throw new Error("Windows pipe relay flags are invalid.");
      const payloadLength = this.buffer.readUInt32LE(12);
      if (payloadLength > MAX_RELAY_PAYLOAD_BYTES) {
        throw new Error("Windows pipe relay frame exceeds the bounded payload size.");
      }
      const frameLength = RELAY_HEADER_BYTES + payloadLength;
      if (this.buffer.length < frameLength) break;
      frames.push({
        type: this.buffer.readUInt8(5),
        connectionId: this.buffer.readUInt32LE(8),
        payload: Buffer.from(this.buffer.subarray(RELAY_HEADER_BYTES, frameLength))
      });
      this.buffer = this.buffer.subarray(frameLength);
    }
    return frames;
  }
}

function encodeRelayFrame(type: number, connectionId: number, payload: Buffer): Buffer {
  if (!Number.isInteger(connectionId) || connectionId < 0 || connectionId > 0xffff_ffff) {
    throw new Error("Windows pipe relay connection id is invalid.");
  }
  if (payload.length > MAX_RELAY_PAYLOAD_BYTES) {
    throw new Error("Windows pipe relay frame exceeds the bounded payload size.");
  }
  const frame = Buffer.allocUnsafe(RELAY_HEADER_BYTES + payload.length);
  frame.writeUInt32LE(RELAY_MAGIC, 0);
  frame.writeUInt8(RELAY_VERSION, 4);
  frame.writeUInt8(type, 5);
  frame.writeUInt16LE(0, 6);
  frame.writeUInt32LE(connectionId, 8);
  frame.writeUInt32LE(payload.length, 12);
  payload.copy(frame, RELAY_HEADER_BYTES);
  return frame;
}

function parseReadyEndpoint(frame: RelayFrame): string {
  if (frame.connectionId !== 0) throw new Error("Windows pipe host READY frame has a connection id.");
  const endpoint = frame.payload.toString("utf8");
  if (
    !endpoint.startsWith("\\\\.\\pipe\\canvastty-agent-")
    || endpoint.length > 240
    || endpoint.includes("\0")
  ) {
    throw new Error("Windows pipe host returned an invalid local endpoint.");
  }
  return endpoint;
}

function safeHostMessage(payload: Buffer): string {
  return payload.toString("utf8").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1_024)
    || "Windows agent pipe host reported a fatal error.";
}

function windowsHostEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR"]) {
    if (environment[name]) result[name] = environment[name];
  }
  return result;
}

export const WINDOWS_PIPE_RELAY_PROTOCOL = Object.freeze({
  magic: RELAY_MAGIC,
  version: RELAY_VERSION,
  headerBytes: RELAY_HEADER_BYTES,
  maxPayloadBytes: MAX_RELAY_PAYLOAD_BYTES,
  hostToParent: HOST_TO_PARENT,
  parentToHost: PARENT_TO_HOST
});
