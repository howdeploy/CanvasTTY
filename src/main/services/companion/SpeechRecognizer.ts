import { promisify } from "node:util";
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";

const PYTHON = process.platform === "darwin" ? "/usr/bin/python3" : "python3";

type Result = { accepted: boolean; transcript?: string; cancelled?: boolean };
export class SpeechRecognizer {
  available = false;
  binary = "";
  modelId = "";
  configure(binary: string, modelId: string) {
    this.binary = binary;
    this.modelId = modelId;
    this.model = this.bundled ? "Nemotron 3.5 · CanvasTTY" : "Handy";
    this.available =
      process.platform !== "win32" &&
      existsSync(binary) &&
      (this.bundled
        ? existsSync(modelId)
        : existsSync(this.worker) && !!modelId);
  }
  model = "Handy";
  private get bundled(): boolean {
    return basename(this.binary) === "canvastty-speech";
  }
  async inspect() {
    this.available = false;
    if (this.bundled) {
      if (!existsSync(this.binary) || !existsSync(this.modelId)) return;
      try {
        const { stdout } = await promisify(execFile)(
          this.binary,
          ["--version"],
          { timeout: 5000, maxBuffer: 16384 },
        );
        this.available = JSON.parse(stdout).engine === "transcribe.cpp";
        this.model = "Nemotron 3.5 · CanvasTTY";
      } catch {}
      return;
    }
    if (
      process.platform === "win32" ||
      !existsSync(this.binary) ||
      !existsSync(this.worker)
    )
      return;
    try {
      const { stdout } = await promisify(execFile)(
        this.binary,
        ["--list-models", "--json"],
        { timeout: 5000, maxBuffer: 262144 },
      );
      const rows = JSON.parse(stdout);
      const model = Array.isArray(rows)
        ? rows.find(
            (item) => item.id === this.modelId && item.is_downloaded === true,
          )
        : null;
      if (model) {
        this.model = String(model.name || "Handy").slice(0, 100);
        this.available = true;
      }
    } catch {}
  }
  private readonly worker: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private activeId: string | null = null;
  private cancelled = new Set<string>();
  private receipts = new Map<string, { hash: string; result: Result }>();
  constructor(worker: string) {
    this.worker = worker;
  }
  private stopChild(signal: NodeJS.Signals = "SIGTERM", child = this.child) {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
  cancel(id: string) {
    if (!/^[a-f0-9-]{16,80}$/.test(id)) return;
    if (this.cancelled.size >= 256)
      this.cancelled.delete(this.cancelled.values().next().value!);
    this.cancelled.add(id);
    if (this.activeId === id) this.stopChild();
  }
  cancelAll() {
    if (this.activeId) this.cancelled.add(this.activeId);
    this.stopChild();
  }
  async run(
    body: Record<string, unknown>,
    accept: (
      text: string,
      cancelled: () => boolean,
    ) => Promise<boolean> | boolean,
  ): Promise<Result> {
    const id = body.requestId,
      audio = body.audio;
    if (
      typeof id !== "string" ||
      !/^[a-f0-9-]{16,80}$/.test(id) ||
      typeof audio !== "string" ||
      audio.length > 1280000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)
    )
      throw new Error("Invalid audio request");
    const pcm = Buffer.from(audio, "base64");
    if (pcm.length < 6400 || pcm.length > 960000 || pcm.length % 2)
      throw new Error("Invalid audio length");
    const hash = createHash("sha256")
      .update(JSON.stringify([body.sessionId, body.purpose || "input"]))
      .update(pcm)
      .digest("hex");
    const old = this.receipts.get(id);
    if (old) {
      if (old.hash !== hash) throw new Error("Request ID conflict");
      return old.result;
    }
    if (this.cancelled.has(id)) return { accepted: false, cancelled: true };
    if (this.activeId) throw new Error("Speech recognizer is busy");
    if (!this.available) throw new Error("Local speech runtime unavailable");
    this.activeId = id;
    const usedModel = this.modelId;
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          this.bundled ? this.binary : PYTHON,
          this.bundled
            ? [this.modelId]
            : [this.worker, this.binary, this.modelId],
          {
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
              ...process.env,
              HF_HUB_OFFLINE: "1",
              HF_HUB_DISABLE_TELEMETRY: "1",
            },
          },
        );
        this.child = child;
        let output = "";
        const timer = setTimeout(() => {
          this.stopChild("SIGKILL", child);
          reject(new Error("Speech timeout"));
        }, 60000);
        child.on("error", () => {
          clearTimeout(timer);
          reject(new Error("Speech runtime failed"));
        });
        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
          if (output.length > 16000) this.stopChild("SIGKILL", child);
        });
        child.stderr.on("data", () => {});
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0)
            return reject(new Error("Speech recognition stopped"));
          try {
            const data = JSON.parse(output);
            if (
              data.model !== usedModel ||
              typeof data.text !== "string" ||
              data.text.length > 4000
            )
              throw new Error();
            resolve(data.text.trim());
          } catch {
            reject(new Error("Invalid speech result"));
          }
        });
        child.stdin.on("error", () => {});
        child.stdin.end(pcm);
      });
      let result: Result = this.cancelled.has(id)
        ? { accepted: false, cancelled: true }
        : text
          ? { accepted: true, transcript: text }
          : { accepted: false };
      // The delivery callback rechecks cancellation and access after its awaited read.
      if (result.accepted) {
        const delivered = await accept(text, () => this.cancelled.has(id));
        if (!delivered)
          result = { accepted: false, cancelled: this.cancelled.has(id) };
      }
      this.receipts.set(id, { hash, result });
      if (this.receipts.size > 128)
        this.receipts.delete(this.receipts.keys().next().value!);
      return result;
    } finally {
      pcm.fill(0);
      this.child = null;
      this.activeId = null;
    }
  }
}
