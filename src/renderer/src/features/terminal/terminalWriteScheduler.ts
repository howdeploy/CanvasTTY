const WRITE_CHUNK_CHARS = 8_192;

interface PendingWrite {
  data: string;
  offset: number;
  parsed?: () => void;
}

interface Writer {
  write(data: string, parsed: () => void): void;
  onError(error: unknown): void;
  queue: PendingWrite[];
  parsing: boolean;
  disposed: boolean;
}

/** Dispatch bounded slices in separate tasks; each card waits only for its own parser. */
export class TerminalWriteScheduler {
  private readonly ready = new Set<Writer>();
  private scheduled = false;
  private readonly schedule: (task: () => void) => void;

  constructor(schedule: (task: () => void) => void) {
    this.schedule = schedule;
  }

  create(write: Writer["write"], onError: Writer["onError"]): { write(data: string, parsed?: () => void): void; dispose(): void } {
    const writer: Writer = { write, onError, queue: [], parsing: false, disposed: false };
    return {
      write: (data, parsed) => {
        if (writer.disposed) return;
        writer.queue.push({ data, offset: 0, parsed });
        if (!writer.parsing) this.ready.add(writer);
        this.request();
      },
      dispose: () => this.dispose(writer)
    };
  }

  private dispose(writer: Writer): void {
    writer.disposed = true;
    writer.queue.length = 0;
    this.ready.delete(writer);
    this.request();
  }

  private request(): void {
    if (this.scheduled || this.ready.size === 0) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    const writer = this.ready.values().next().value;
    if (!writer) return;
    this.ready.delete(writer);
    const parts: string[] = [];
    const callbacks: Array<() => void> = [];
    let size = 0;
    while (writer.queue.length && size < WRITE_CHUNK_CHARS) {
      const next = writer.queue[0];
      let end = Math.min(next.data.length, next.offset + WRITE_CHUNK_CHARS - size);
      // xterm retains escape/parser state between writes; keep UTF-16 pairs together as well.
      if (end < next.data.length && /[\uD800-\uDBFF]/u.test(next.data[end - 1]) && /[\uDC00-\uDFFF]/u.test(next.data[end])) end--;
      if (end === next.offset && end < next.data.length) break;
      parts.push(next.data.slice(next.offset, end));
      size += end - next.offset;
      next.offset = end;
      if (end === next.data.length) {
        writer.queue.shift();
        if (next.parsed) callbacks.push(next.parsed);
      }
    }
    writer.parsing = true;
    let completed = false;
    try {
      writer.write(parts.join(""), () => {
        if (completed || writer.disposed) return;
        completed = true;
        try {
          for (const parsed of callbacks) {
            if (writer.disposed) break;
            parsed();
          }
        } finally {
          writer.parsing = false;
          if (!writer.disposed && writer.queue.length) this.ready.add(writer);
          this.request();
        }
      });
    } catch (error) {
      this.dispose(writer);
      writer.onError(error);
    } finally {
      // A pending or slow parser must not stop other cards from receiving their next slice.
      this.request();
    }
  }
}

let shared: TerminalWriteScheduler | undefined;

export function terminalWriteScheduler(): TerminalWriteScheduler {
  if (!shared) {
    // Message tasks yield to browser rendering without background-tab timer/rAF throttling stopping scrollback.
    const channel = new MessageChannel();
    let pending: (() => void) | undefined;
    channel.port1.onmessage = () => {
      const task = pending;
      pending = undefined;
      task?.();
    };
    shared = new TerminalWriteScheduler((task) => {
      pending = task;
      channel.port2.postMessage(null);
    });
  }
  return shared;
}
