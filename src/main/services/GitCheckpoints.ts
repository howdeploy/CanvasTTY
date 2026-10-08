import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, lstat, open, mkdir, mkdtemp, readdir, readFile, writeFile, rename, rm, type FileHandle } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { resolve, relative, isAbsolute, sep, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
const exec = promisify(execFile);

/** Bounded, redacted working diff supplied to an automatic reviewer. */
export class GitCheckpoints {
  private readonly redact:(text:string)=>string;
  constructor(redact: (text:string)=>string) {this.redact=redact;}
  private async git(cwd: string, args: string[]): Promise<string> {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
    const safe = ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "diff.external="];
    // Snapshotting runs outside the agent process; never execute repository-provided clean filters.
    const configured = await exec("git", [...safe, "-C", cwd, "config", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], {env, timeout: 5000}).catch((error: unknown) => {
      if ((error as {code?: unknown}).code === 1) return {stdout: ""}; throw error;
    });
    for (const line of configured.stdout.split("\n")) {
      const key = line.split(/\s/, 1)[0];
      if (/^filter\..*\.(clean|smudge|process|required)$/.test(key)) safe.push("-c", `${key}=${key.endsWith(".required") ? "false" : ""}`);
    }
    return (await exec("git", [...safe, "-C", cwd, ...args], {env, timeout: 15_000, maxBuffer: 2 * 1024 * 1024})).stdout.trimEnd();
  }
  async available(cwd: string): Promise<boolean> {
    try { return await realpath(await this.git(cwd, ["rev-parse", "--show-toplevel"])) === await realpath(cwd); }
    catch { return false; }
  }
  async workingDiff(cwd:string, baselineHead?:string):Promise<string> {
    if (baselineHead !== undefined && !/^[a-f0-9]{40,64}$/u.test(baselineHead)) throw new Error("Invalid review baseline commit.");
    const parts = [await this.git(cwd,["diff","--no-ext-diff","--no-textconv","--unified=3",baselineHead ?? "HEAD","--"])];
    const root = await realpath(cwd);
    const paths = (await this.git(cwd,["ls-files","--others","--exclude-standard","-z"])).split("\0").filter(Boolean);
    let bytes = Buffer.byteLength(parts[0]), omitted = 0;
    for (const path of paths) {
      if (bytes >= 512 * 1024 || /[\u0000-\u001F\u007F]/u.test(path)) { omitted++; continue; }
      let file;
      try {
        const full = resolve(root,path), target = await realpath(full), within = relative(root,target);
        const metadata = await lstat(full);
        if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`) || !metadata.isFile() || metadata.size > 32 * 1024) { omitted++; continue; }
        file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = await file.stat();
        if (!opened.isFile() || opened.ino !== metadata.ino || opened.dev !== metadata.dev || opened.size > 32 * 1024) { omitted++; continue; }
        const raw = await readBoundedUntrackedFile(file);
        const after = await file.stat();
        if (raw.includes(0) || raw.length > 32 * 1024 || after.size !== opened.size
          || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) { omitted++; continue; }
        const text = new TextDecoder("utf8", {fatal:true}).decode(raw), lines = text.endsWith("\n") ? text.slice(0,-1).split("\n") : text.split("\n");
        if (!text) lines.length = 0;
        const quoted = JSON.stringify(path);
        const hunk = `diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}\nnew file mode ${opened.mode & 0o111 ? "100755" : "100644"}\n--- /dev/null\n+++ ${quoted}\n@@ -0,0 +${lines.length ? 1 : 0},${lines.length} @@\n${lines.map(line=>`+${line}`).join("\n")}\n${text && !text.endsWith("\n") ? "\\ No newline at end of file\n" : ""}`;
        parts.push(hunk); bytes += Buffer.byteLength(hunk);
      } catch { omitted++; }
      finally { await file?.close(); }
    }
    if (omitted) parts.push(`[${omitted} untracked file(s) omitted: binary, oversized, unsafe, or unavailable.]`);
    // Mask the complete collected text before taking the bounded tail consumed by the reviewer.
    return this.redact(parts.join("\n")).slice(-512 * 1024);
  }
}
/** A file can grow after stat; stop reading at the cap before allocating an oversized review input. */
async function readBoundedUntrackedFile(file: FileHandle): Promise<Buffer> {
  const buffer = Buffer.alloc(32 * 1024 + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}
