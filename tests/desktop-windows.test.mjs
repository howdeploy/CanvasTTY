import assert from "node:assert/strict";
import test from "node:test";
import { validateDesktopViewport } from "../src/shared/desktopWindows.ts";
import { DesktopWindowService } from "../src/main/services/DesktopWindowService.ts";

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
