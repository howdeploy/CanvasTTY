import { createHash } from "node:crypto";
import { mkdir, open, stat, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { SpeechSetupState } from "../../../shared/evenG2.ts";

export const NEMOTRON_MODEL = {
  name: "Nemotron Streaming 3.5",
  bytes: 751094240,
  sha256: "b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c",
  url: "https://huggingface.co/handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf/resolve/0221a878b3f4c3efd14e976702058fe998d41573/nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf",
};
interface Options {
  userDataPath: string;
  binary: string;
  model?: typeof NEMOTRON_MODEL;
  fetcher?: typeof fetch;
}
export class SpeechSetup {
  readonly binary: string;
  readonly modelPath: string;
  private readonly asset: typeof NEMOTRON_MODEL;
  private readonly fetcher: typeof fetch;
  private progress: SpeechSetupState;
  private abort: AbortController | null = null;
  private job: Promise<void> | null = null;
  constructor(options: Options) {
    this.binary = options.binary;
    this.modelPath = join(
      options.userDataPath,
      "companion-models",
      "nemotron-3.5-q8.gguf",
    );
    this.asset = options.model || NEMOTRON_MODEL;
    this.fetcher = options.fetcher || fetch;
    this.progress = {
      supported: !!this.binary && existsSync(this.binary),
      phase: "missing",
      received: 0,
      total: this.asset.bytes,
      model: this.asset.name,
      error: "",
    };
  }
  state(): SpeechSetupState {
    return { ...this.progress };
  }
  async inspect(): Promise<void> {
    if (this.job) return;
    const file = await stat(this.modelPath).catch(() => null);
    this.progress.phase =
      this.progress.supported && file?.size === this.asset.bytes
        ? "ready"
        : "missing";
    this.progress.received =
      this.progress.phase === "ready" ? this.asset.bytes : 0;
  }
  cancel(): void {
    this.abort?.abort();
  }
  prepare(): Promise<void> {
    if (this.job) return this.job;
    if (this.progress.phase === "ready") return Promise.resolve();
    if (!this.progress.supported)
      return Promise.reject(new Error("bundled-speech-unavailable"));
    this.abort = new AbortController();
    const abort = this.abort;
    this.progress = {
      ...this.progress,
      phase: "downloading",
      received: 0,
      error: "",
    };
    this.job = this.download(
      AbortSignal.any([abort.signal, AbortSignal.timeout(15 * 60_000)]),
    )
      .catch((error) => {
        this.progress.phase = abort.signal.aborted ? "missing" : "error";
        this.progress.error = abort.signal.aborted
          ? ""
          : "model-download-failed";
        throw error;
      })
      .finally(() => {
        this.job = null;
        this.abort = null;
      });
    return this.job;
  }
  private async download(signal: AbortSignal): Promise<void> {
    const directory = dirname(this.modelPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = this.modelPath + ".download";
    let file;
    try {
      const response = await this.fetcher(this.asset.url, {
        signal,
        redirect: "follow",
      });
      if (!response.ok || !response.body) throw new Error("download-failed");
      file = await open(temporary, "w", 0o600);
      const hash = createHash("sha256");
      const reader = response.body.getReader();
      try {
        while (true) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          this.progress.received += value.length;
          if (this.progress.received > this.asset.bytes)
            throw new Error("model-too-large");
          hash.update(value);
          // FileHandle.write may be partial; writeFile consumes the complete chunk.
          await file.writeFile(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      this.progress.phase = "verifying";
      if (
        this.progress.received !== this.asset.bytes ||
        hash.digest("hex") !== this.asset.sha256
      )
        throw new Error("model-checksum-mismatch");
      signal.throwIfAborted();
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporary, this.modelPath);
      this.progress.phase = "ready";
    } finally {
      await file?.close();
      await rm(temporary, { force: true });
    }
  }
}
