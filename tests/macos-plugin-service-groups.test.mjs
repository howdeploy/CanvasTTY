import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Owned service fixture did not reach its expected state.");
}

for (const mode of ["polite", "stubborn", "crash"]) {
  test(`Mac service ${mode} exit cleans its ordinary child process`, { skip: process.platform !== "darwin" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "canvastty-service-group-"));
    const pidFile = join(root, "helper.pid");
    let helperPid;
    const supervisor = new PluginServiceSupervisor({
      command: process.execPath, hostVersion: "9.9.9", locale: () => "en",
      stopGraceMs: 100, maxRestarts: 0,
      host: { storageGet: async () => null, storageSet: async () => {}, emit: () => {} }
    });
    const helper = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
    const source = `import { spawn } from 'node:child_process';
      import { existsSync } from 'node:fs';
      spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: 'ignore' });
      process.stdin.resume();
      ${mode === "polite" ? "process.stdin.on('end', () => process.exit(0));" : "process.stdin.on('end', () => {}); process.on('SIGTERM', () => {});"}
      ${mode === "crash" ? `setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) process.exit(3); }, 20);` : ""}
      setInterval(() => {}, 1000);`;
    const entryPath = join(root, "service.mjs");
    try {
      await writeFile(entryPath, source);
      await supervisor.sync([{ pluginId: "com.example.group", serviceId: "main", root, entryPath,
        sha256: createHash("sha256").update(source).digest("hex"), dataDir: join(root, "data"), permissions: [] }]);
      await waitFor(async () => { try { helperPid = Number(await readFile(pidFile, "utf8")); return helperPid > 0; } catch { return false; } });
      if (mode !== "crash") {
        assert.equal(alive(helperPid), true);
        await supervisor.sync([]);
        assert.equal(supervisor.report("com.example.group").services.length, 0);
      }
      await waitFor(() => !alive(helperPid));
      assert.equal(alive(helperPid), false);
    } finally {
      await supervisor.dispose();
      if (helperPid && alive(helperPid)) process.kill(helperPid, "SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });
}
