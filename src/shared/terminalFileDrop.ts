export function terminalFileDropText(paths: readonly string[], platform: string): string {
  if (paths.length === 0) throw new Error("No local files were dropped.");
  return paths.map((path) => {
    if (typeof path !== "string" || !path || /[\x00-\x1f\x7f]/u.test(path)) {
      throw new Error("Dropped file path is unavailable or contains control characters.");
    }
    // ponytail: host-default quoting; nested shells and cmd.exe need manual quoting.
    const escaped = platform === "win32"
      ? path.replaceAll("'", "''")
      : path.replaceAll("'", `'"'"'`);
    return `'${escaped}'`;
  }).join(" ") + " ";
}
