import { spawn, execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import electron from "electron";

if (process.env.CANVASTTY_GEOMETRY_DISPOSABLE_DESKTOP !== "1") throw new Error("This test moves the OS pointer. Run only on an explicitly disposable desktop.");
const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifacts = resolve(process.env.CANVASTTY_GEOMETRY_ARTIFACTS || "geometry-artifacts");
await mkdir(artifacts, { recursive: true });
const local = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "ctg-"));
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><title>Native geometry fixture</title><style>
  html { overflow: scroll; } body { margin:0; width:2400px; height:2400px; background:repeating-conic-gradient(#263849 0% 25%,#385167 0% 50%) 0/80px 80px; }
  ::-webkit-scrollbar {width:16px;height:16px} ::-webkit-scrollbar-track {background:#00ffff} ::-webkit-scrollbar-thumb {background:#ff00ff}
  #marker {position:fixed;left:25px;top:25px;background:#00ffff;border:18px solid #ff00ff;padding:12px;color:black;font:18px sans-serif}
  </style><div id="marker">REAL NATIVE PAGE<br><output></output></div><script>
  const update=()=>document.querySelector('output').textContent=innerWidth+' × '+innerHeight+' / '+scrollX+','+scrollY;
  addEventListener('resize',update);addEventListener('scroll',update);update();
  </script>`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let failed = false;
try {
  if (process.platform === "darwin") {
    process.env.CANVASTTY_GEOMETRY_MAC_INPUT = join(local, "native-input");
    await promisify(execFile)("xcrun", ["swiftc", join(project, "scripts/browser-geometry-input.swift"), "-o", process.env.CANVASTTY_GEOMETRY_MAC_INPUT]);
  }
  const selectedCase = process.env.CANVASTTY_GEOMETRY_CASE?.split(",").map(Number);
  if (selectedCase && (selectedCase.length !== 2 || ![1, 2].includes(selectedCase[0]) || ![1, 1.25].includes(selectedCase[1]))) throw new Error("Invalid geometry case");
  const cases = process.env.CANVASTTY_GEOMETRY_BASELINE === "1" ? [[1, 1]]
    : selectedCase ? [selectedCase] : [[1, 1], [2, 1], [1, 1.25], [2, 1.25]];
  for (const [cards, uiScale] of cases) {
    const name = `cards-${cards}-ui-${uiScale}`;
    const userData = join(local, name), out = join(artifacts, name);
    await mkdir(userData, { recursive: true }); await mkdir(out, { recursive: true });
    await writeFile(join(userData, "settings.json"), JSON.stringify({ uiScale, locale: "en", snapToGrid: false, browserShowAgentPresence: false, browserAgentAccess: false, agentLifecycleHooksEnabled: false }));
    const args = [project, `--user-data-dir=${userData}`];
    if (process.platform === "linux") args.push("--no-sandbox", `--ozone-platform=${process.env.CANVASTTY_GEOMETRY_BACKEND === "wayland" ? "wayland" : "x11"}`);
    const env = { ...process.env, CANVASTTY_BROWSER_GEOMETRY_URL: origin,
      CANVASTTY_GEOMETRY_NODE: process.execPath,
      CANVASTTY_GEOMETRY_USER_DATA: userData,
      CANVASTTY_GEOMETRY_CARDS: String(cards), CANVASTTY_GEOMETRY_UI_SCALE: String(uiScale),
      CANVASTTY_GEOMETRY_ARTIFACTS: out, CANVASTTY_GEOMETRY_INPUT: join(project, "scripts/browser-geometry-input.mjs") };
    delete env.ELECTRON_RUN_AS_NODE;
    console.log(`Starting ${name}`);
    const child = spawn(electron, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const stream = createWriteStream(join(out, "electron.log"));
    const consume = (chunk) => { log += chunk; stream.write(chunk); };
    child.stdout.on("data", consume); child.stderr.on("data", consume);
    let forceTimer;
    const timer = setTimeout(() => {
      consume("\nGEOMETRY TIMEOUT\n"); child.kill();
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
    }, 600000);
    const code = await new Promise((done, reject) => { child.once("exit", done); child.once("error", reject); });
    clearTimeout(timer); clearTimeout(forceTimer); await new Promise((done) => stream.end(done));
    let ok = code === 0 && log.includes("CANVASTTY_BROWSER_GEOMETRY_READY");
    const rows = log.split("\n").filter((line) => line.startsWith("BROWSER_GEOMETRY_CHECK "))
      .map((line) => JSON.parse(line.slice("BROWSER_GEOMETRY_CHECK ".length)));
    console.log(JSON.stringify({ case: name, code, timedOut: log.includes("GEOMETRY TIMEOUT"),
      passed: rows.filter((row) => row.status === "pass").length,
      failed: rows.filter((row) => row.status === "fail").slice(0, 8) }));
    if (process.env.CANVASTTY_GEOMETRY_BASELINE === "1") {
      const report = await readFile(join(out, "report.json"), "utf8").then(JSON.parse).catch(() => null);
      ok = !!report && !log.includes("GEOMETRY TIMEOUT")
        && report.rows.some((row) => row.status === "fail" && /\/card-0\/(s|e|w)$/.test(row.name) && row.message.includes('delivered'))
        && report.failures.some((failure) => failure.includes("capture with unsynchronized native geometry"));
      console.log(`Accepted-main negative control: ${ok ? "expected native overlap and capture-order regressions reproduced" : "incomplete reproduction"}`);
    }
    failed ||= !ok;
    console.log(`${name}: ${ok ? "PASS" : "FAIL"}; artifacts ${out}`);
  }
} finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
// Retain reports and isolated profiles for diagnosis; never touch user profiles.
process.exitCode = failed ? 1 : 0;
