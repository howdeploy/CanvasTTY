import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import test from "node:test";
import { validateDesktopViewport } from "../src/shared/desktopWindows.ts";
import { DesktopWindowService } from "../src/main/services/DesktopWindowService.ts";

async function transportFixture(t) {
  const children = [];
  const require = createRequire(import.meta.url);
  const module = { exports: {} };
  const source = await readFile(new URL("../src/main/services/DesktopWindowService.ts", import.meta.url), "utf8");
  const { code } = transformSync(source, { loader: "ts", format: "cjs", target: "es2022" });
  runInNewContext(code, {
    module, exports: module.exports,
    process: { platform: "win32", env: {}, pid: process.pid },
    setTimeout, clearTimeout, setInterval, clearInterval,
    require(name) {
      if (name !== "node:child_process") return require(name);
      return { spawn() {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), requests: []
        });
        child.stdin.on("data", (data) => child.requests.push(JSON.parse(data.toString())));
        children.push(child);
        return child;
      } };
    }
  });
  t.after(() => {
    for (const child of children) {
      child.emit("exit", 0);
      child.emit("close", 0);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }
  });
  return { service: new module.exports.DesktopWindowService("fixture.ps1", () => "1234"), children };
}

test("an old helper's late exit does not reject requests belonging to its replacement", { timeout: 1_000 }, async (t) => {
  const { service, children } = await transportFixture(t);
  const first = service.list("plugin/card");
  const rejected = assert.rejects(first, /EPIPE/);
  const old = children[0];
  old.stdin.emit("error", new Error("EPIPE"));
  await rejected;

  const next = service.list("plugin/card");
  const healthy = assert.doesNotReject(async () => {
    const candidates = await next;
    assert.ok(Array.isArray(candidates));
    assert.equal(candidates.length, 0);
  });
  const replacement = children[1];
  old.emit("exit", 1);
  replacement.stdout.write(JSON.stringify({ id: replacement.requests[0].id, ok: true, result: [] }) + "\n");
  await healthy;
});

test("disposing while helper spawn fails finishes on close without an exit event", { timeout: 1_000 }, async (t) => {
  const { service, children } = await transportFixture(t);
  const request = service.list("plugin/card");
  const rejected = assert.rejects(request, /ENOENT/);
  const disposal = service.dispose();
  children[0].emit("error", new Error("spawn ENOENT"));
  children[0].emit("close", -2);
  await rejected;
  await disposal;
});

test("desktop viewport refuses non-finite, oversized and malformed geometry", () => {
  const valid = { x: 10, y: 20, width: 800, height: 600, visible: true };
  assert.deepEqual(validateDesktopViewport(valid), valid);
  for (const value of [
    null,
    [],
    { ...valid, x: NaN },
    { ...valid, width: -1 },
    { ...valid, y: Infinity },
    { ...valid, height: 40000 },
    { ...valid, visible: 1 },
  ]) {
    assert.throws(
      () => validateDesktopViewport(value),
      /Invalid desktop viewport/,
    );
  }
});

function fixture() {
  const service = new DesktopWindowService("unused", () => "1234");
  const commands = [];
  service.command = async (action, params) => {
    commands.push({ action, params });
    if (action === "list")
      return [{ Handle: "987654", Pid: 42, Title: "Codex", Process: "Codex" }];
    return null;
  };
  return { service, commands };
}

test("window grants conceal HWND/PID, bind to one card and are consumed once", async () => {
  const { service, commands } = fixture();
  const [window] = await service.list("plugin/card-a");
  assert.deepEqual(Object.keys(window).sort(), ["id", "process", "title"]);
  assert.equal(window.title, "Codex");
  await assert.rejects(service.attach("plugin/card-b", window.id), /expired/);
  await service.attach("plugin/card-a", window.id);
  assert.deepEqual(commands.at(-1), {
    action: "attach",
    params: {
      token: "plugin/card-a",
      handle: "987654",
      pid: 42,
      parent: "1234",
    },
  });
  await assert.rejects(service.attach("plugin/card-a", window.id), /already/);
  await service.detach("plugin/card-a");
  await assert.rejects(service.attach("plugin/card-a", window.id), /expired/);
});

test("refresh invalidates older selections and expired grants cannot attach", async () => {
  const { service } = fixture();
  const [old] = await service.list("a");
  const [fresh] = await service.list("a");
  await assert.rejects(service.attach("a", old.id), /expired/);
  service.grants.get(fresh.id).expires = 0;
  await assert.rejects(service.attach("a", fresh.id), /expired/);
});

test("detach during attachment is forwarded after attach and leaves no owned window", async () => {
  const { service, commands } = fixture();
  const [window] = await service.list("a");
  let finish;
  const original = service.command;
  service.command = (action, params) =>
    action === "attach"
      ? new Promise((resolve) => {
          finish = resolve;
          commands.push({ action, params });
        })
      : original(action, params);
  const attaching = service.attach("a", window.id);
  const detaching = service.detach("a");
  finish();
  await Promise.all([attaching, detaching]);
  assert.equal(commands.at(-1).action, "detach");
  await assert.rejects(
    service.update("a", { x: 0, y: 0, width: 1, height: 1, visible: false }),
    /no longer attached/,
  );
});

test("a card cannot update or detach another card's native window", async () => {
  const { service, commands } = fixture();
  const [window] = await service.list("a");
  await service.attach("a", window.id);
  await service.detach("b");
  await assert.rejects(
    service.update("b", { x: 0, y: 0, width: 1, height: 1, visible: false }),
    /no longer attached/,
  );
  assert.equal(commands.at(-1).action, "attach");
  await service.detach("a");
});
