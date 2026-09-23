import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AccountHomeInspection } from "../../shared/contracts.ts";
import { validAccountBinding } from "../../shared/providerAccountPolicy.ts";

/** Inspect exactly the directory chosen by the operator. Never read or enumerate
 * authentication files; this is a path check, not an authentication check. */
export async function inspectAccountHome(directory: unknown, io = { realpath, stat }): Promise<AccountHomeInspection> {
  if (typeof directory !== "string" || !isAbsolute(directory) || !validAccountBinding({ kind: "cli-home", directory })) throw new Error("Choose an absolute local account directory.");
  try {
    const canonicalPath = await io.realpath(directory);
    if (!(await io.stat(canonicalPath)).isDirectory()) throw new Error("Not a directory");
    return { canonicalPath };
  } catch { throw new Error("The selected local directory is unavailable or is not a directory."); }
}
