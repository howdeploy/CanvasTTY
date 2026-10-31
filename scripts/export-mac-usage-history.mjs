// Read-only source; export to a new private v2 file for an older CanvasTTY build.
import { open, readFile, unlink } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

export async function exportMacUsageHistory(input, output) {
  let body = await readFile(input, "utf8");
  let value = JSON.parse(body);
  if (value.format === "canvastty-usage-history" && value.version === 3 && value.encoding === "gzip-base64" && typeof value.data === "string") {
    body = gunzipSync(Buffer.from(value.data, "base64")).toString("utf8");
    value = JSON.parse(body);
  }
  if (value.format !== "canvastty-usage-history" || value.version !== 2 || value.collector?.version !== 2 || value.history?.version !== 1) {
    throw new Error("Unsupported usage history format; no export was written");
  }
  const handle = await open(output, "wx", 0o600);
  try { await handle.writeFile(body, "utf8"); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(output); throw error; }
  await handle.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output, extra] = process.argv.slice(2);
  if (!input || !output || extra) {
    console.error("Usage: node scripts/export-mac-usage-history.mjs INPUT NEW_OUTPUT");
    process.exitCode = 1;
  } else {
    await exportMacUsageHistory(input, output);
    console.log("Exported v2 history; source unchanged.");
  }
}
