import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LimitsService } from "../src/main/services/LimitsService.ts";

test("disposing limits while the Kimi usage server is starting leaves no `kimi web` process", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-kimi-dispose-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "kimi-web-started");
  const kimi = join(root, "kimi");
  // Records that it ran and exits at once, so a leaked start leaves only the marker behind.
  await writeFile(kimi, `#!/bin/sh\necho "$@" > ${JSON.stringify(marker)}\n`, { mode: 0o700 });
  const service = new LimitsService({
    get(provider) {
      if (provider === "kimi") {
        return { state: "available", provider, executable: kimi, launcher: "native", environment: {}, checked: [] };
      }
      return { state: "unavailable", provider, reason: "cli-not-found", checked: [], diagnostic: "" };
    }
  }, "test");
  const reading = service.get();
  // The Kimi client is waiting for a free loopback port: nothing is spawned yet.
  service.dispose();
  const snapshot = await reading;
  assert.equal(snapshot.providers.find((provider) => provider.provider === "kimi").state, "unavailable");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(stat(marker), { code: "ENOENT" }, "kimi web must not start after dispose");
});

test("`codex app-server` stops after the idle time without a limits read", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-codex-idle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pidFile = join(root, "pid");
  const codex = join(root, "codex");
  // Answers initialize and one rate limit read, and records its pid.
  await writeFile(codex, `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "account/rateLimits/read"
    ? { rateLimits: { limitId: "codex", primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1786160179 } } }
    : message.method === "account/read" ? { account: { type: "chatgpt" }, requiresOpenaiAuth: true } : {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`, { mode: 0o700 });
  const service = new LimitsService({
    get(provider) {
      if (provider === "codex") {
        return { state: "available", provider, executable: codex, launcher: "native", environment: {}, checked: [] };
      }
      return { state: "unavailable", provider, reason: "cli-not-found", checked: [], diagnostic: "" };
    }
  }, "test", { codexIdleMs: 300 });
  t.after(() => service.dispose());
  const snapshot = await service.get();
  assert.equal(snapshot.providers.find((provider) => provider.provider === "codex").state, "available");
  const pid = Number(await readFile(pidFile, "utf8"));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(), true, "the app-server serves reads while they keep coming");
  const deadline = Date.now() + 5_000;
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(), false, "the app-server is stopped once no read came for the idle time");
});

test("peek returns the last snapshot without starting a read", async () => {
  const service = new LimitsService({
    get: (provider) => ({ state: "unavailable", provider, reason: "cli-not-found", checked: [], diagnostic: "" })
  }, "test");
  try {
    assert.equal(service.peek(), null);
    assert.equal(service.peek(), null);
    const snapshot = await service.get();
    const peeked = service.peek();
    assert.deepEqual(peeked, snapshot);
    peeked.providers.length = 0;
    assert.notEqual(service.peek().providers.length, 0);
  } finally {
    service.dispose();
  }
});
