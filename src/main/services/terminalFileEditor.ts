import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseTerminalFileLink } from "../../shared/terminalFileLink.ts";

export async function canOpenTerminalFile(reference: unknown, cwd: string): Promise<boolean> {
  try {
    await resolveTerminalFilePath(reference, cwd);
    return true;
  } catch {
    return false;
  }
}

export async function resolveTerminalFilePath(reference: unknown, cwd: string): Promise<string> {
  const location = parseTerminalFileLink(reference);
  if (!location) throw new Error("Invalid file link.");
  const expanded = location.path.startsWith("~/") ? resolve(homedir(), location.path.slice(2)) : location.path;
  const path = await realpath(resolve(cwd, expanded));
  if (!(await stat(path)).isFile()) throw new Error("The link must point to an existing file.");
  return path;
}
