import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

/** Conservative package preflight, not a replacement for Even Hub review. */
export function checkBundleNetwork(root, manifest) {
  const entries = manifest.permissions?.find(p => p.name === "network")?.whitelist;
  if (!Array.isArray(entries) || !entries.length)
    throw new Error("network.whitelist must contain explicit origins");
  const allowed = new Set(entries.map(value => {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.origin !== value ||
      /[*$]/.test(value) || url.username || url.password)
      throw new Error(`Invalid network.whitelist origin: ${value}`);
    return url.origin;
  }));
  const found = new Set(), violations = [];
  let scannedFiles = 0;
  function walk(directory) {
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, file.name);
      if (file.isDirectory()) { walk(path); continue; }
      if (!file.isFile() || ![".js", ".mjs", ".html", ".css"].includes(extname(path))) continue;
      scannedFiles++;
      const content = readFileSync(path, "utf8");
      // Scan the emitted text, including template URLs, as the review sees it.
      for (const [value] of content.matchAll(/https?:\/\/[^\s"'`<>\\)]*/g)) {
        found.add(value);
        let covered = false;
        try {
          const url = new URL(value);
          covered = !value.includes("${") && !url.username && !url.password && allowed.has(url.origin);
        } catch {}
        if (!covered) violations.push(`${relative(root, path)}: ${value}`);
      }
    }
  }
  walk(root);
  if (!scannedFiles) throw new Error("No web bundle files to check");
  if (violations.length)
    throw new Error(`Bundle URLs not covered by network.whitelist:\n${violations.join("\n")}`);
  return { scannedFiles, whitelist: [...allowed], urls: [...found].sort() };
}
