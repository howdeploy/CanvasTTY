// This process outlives Electron during Sparkle installation. It serves only the
// selected local appcast and archive, on an ephemeral loopback port.
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";

const [helper, app, appcast, archive, version, mode] = process.argv.slice(2);
if (!helper || !app || !appcast || !archive || !/^\d+\.\d+\.\d+$/.test(version ?? "") ||
    (mode !== undefined && mode !== "probe")) process.exit(2);
const token = randomUUID();
const appcastSize = (await stat(appcast)).size;
const archiveSize = mode === "probe" ? 0 : (await stat(archive)).size;
const server = createServer((request, response) => {
  const resource = request.url === `/${token}/appcast.xml` ? [appcast, appcastSize, "application/rss+xml"]
    : mode !== "probe" && request.url === `/${token}/update.zip` ? [archive, archiveSize, "application/zip"] : null;
  if (request.method !== "GET" || !resource) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "Content-Type": resource[2], "Content-Length": resource[1], "Cache-Control": "no-store" });
  createReadStream(resource[0]).pipe(response);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
if (!address || typeof address === "string") process.exit(3);
const origin = `http://127.0.0.1:${address.port}/${token}`;
const native = spawn(helper, [app, `${origin}/appcast.xml`, `${origin}/update.zip`, version,
  ...(mode === "probe" ? ["--probe"] : [])], { stdio: ["ignore", "pipe", "pipe"] });
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
native.stdout.pipe(process.stdout);
native.stderr.pipe(process.stderr);
const cacheDirectory = dirname(archive);
const ownsCache = mode !== "probe" && dirname(appcast) === cacheDirectory && basename(cacheDirectory).startsWith("mac-");
let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  server.close(async () => {
    if (ownsCache) await rm(cacheDirectory, { recursive: true, force: true }).catch(console.error);
    process.exitCode = code;
  });
}
const watchdog = setTimeout(() => { native.kill(); finish(6); }, 15 * 60_000);
native.once("error", error => { console.error(error); finish(4); });
native.once("exit", code => finish(code ?? 5));
