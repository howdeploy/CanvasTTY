import { execFile } from "node:child_process";
import { readlink, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** OS state only: terminal titles, OSC sequences and PWD are not filesystem authority. */
export async function processWorkingDirectory(pid: number, platform: NodeJS.Platform): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (platform === "linux") {
      const reference = `/proc/${pid}/cwd`;
      const cwd = await readlink(reference);
      if (!isAbsolute(cwd)) return undefined;
      // A deleted cwd has a decorated pathname that may name an unrelated existing directory.
      const [processDirectory, namedDirectory] = await Promise.all([stat(reference), stat(cwd)]);
      return processDirectory.isDirectory() && namedDirectory.isDirectory()
        && processDirectory.dev === namedDirectory.dev && processDirectory.ino === namedDirectory.ino
        ? cwd : undefined;
    }
    if (platform !== "darwin") return undefined;
    const { stdout } = await run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-F0n"], {
      timeout: 1_500, maxBuffer: 64 * 1024,
      env: { ...process.env, LC_ALL: "en_US.UTF-8" }
    });
    return cwdFromLsof(stdout, pid);
  } catch {
    return undefined;
  }
}

/** NUL fields preserve whitespace; verify both the process and the cwd descriptor. */
export function cwdFromLsof(output: string, pid: number): string | undefined {
  let selectedProcess = false;
  let selectedCwd = false;
  const names: string[] = [];
  for (const raw of output.split("\0")) {
    const field = raw.startsWith("\n") ? raw.slice(1) : raw;
    if (field.startsWith("p")) {
      selectedProcess = field === `p${pid}`;
      selectedCwd = false;
    } else if (field.startsWith("f")) selectedCwd = selectedProcess && field === "fcwd";
    else if (selectedCwd && field.startsWith("n")) names.push(field.slice(1));
  }
  if (names.length !== 1) return undefined;
  const path = decodeLsofName(names[0]!);
  return path && isAbsolute(path) ? path : undefined;
}

function decodeLsofName(value: string): string | undefined {
  // lsof's caret notation is ambiguous with literal filenames; never guess a different root.
  if (/\^[\x40-\x5f?]/u.test(value)) return undefined;
  const escapes: Record<string, number> = { "\\": 92, b: 8, f: 12, n: 10, r: 13, t: 9 };
  const chunks = value.split(/(\\(?:x[0-9a-fA-F]{2}|[\\bfnrt]))/u);
  const bytes: Buffer[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]!;
    if (index % 2 === 0) {
      if (chunk.includes("\\")) return undefined;
      bytes.push(Buffer.from(chunk));
    } else {
      const byte = chunk.startsWith("\\x") ? Number.parseInt(chunk.slice(2), 16) : escapes[chunk[1]!]!;
      bytes.push(Buffer.from([byte]));
    }
  }
  try {
    const path = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(bytes));
    return path.includes("\0") ? undefined : path;
  } catch {
    return undefined;
  }
}
