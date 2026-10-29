import { opendirSync } from "node:fs";

// stat/access may still succeed from the kernel cache after a FUSE mount disconnects.
const inspectDirectory = (directory) => opendirSync(directory).closeSync();

/** A stale FUSE mount aborts execvp's PATH search instead of letting it reach the next directory. */
export function connectedLaunchEnvironment(environment, platform = process.platform, inspect = inspectDirectory) {
  const key = platform === "win32"
    ? Object.keys(environment).find((name) => name.toUpperCase() === "PATH")
    : "PATH";
  const value = key && environment[key];
  if (typeof value !== "string") return environment;
  const separator = platform === "win32" ? ";" : ":";
  const entries = value.split(separator).filter((entry) => {
    try {
      inspect((platform === "win32" ? entry.replace(/^"|"$/g, "") : entry) || ".");
    } catch (error) {
      // Missing/permission-restricted and relative paths retain their normal search semantics.
      return !["ENOTCONN", "ESTALE", "ENODEV", "EIO"].includes(error?.code);
    }
    return true;
  });
  const connected = entries.join(separator);
  return connected === value ? environment : { ...environment, [key]: connected };
}
