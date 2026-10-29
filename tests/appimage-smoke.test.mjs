import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import { smokeAppImage } from "../scripts/smoke-appimage.mjs";

test("AppImage smoke succeeds only after READY and a clean exit", async () => {
  for (const { code, signal, immediate, ready = true } of [
    { code: 0, signal: null, immediate: false },
    { code: 1, signal: null, immediate: false },
    { code: null, signal: "SIGTERM", immediate: false },
    { code: 1, signal: null, immediate: true },
    { code: 0, signal: null, immediate: false, ready: false }
  ]) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => assert.fail("an exited child must not be killed during cleanup");
    let userData;
    const pending = smokeAppImage("/synthetic/CanvasTTY.AppImage", {
      spawn(command, args, options) {
        assert.equal(command, "/synthetic/CanvasTTY.AppImage");
        assert.equal(options.env.CANVASTTY_SMOKE_TEST, "1");
        userData = args.find((arg) => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
        queueMicrotask(() => {
          child.stdout.write(ready ? "CANVASTTY_SMOKE_" : "booting\n");
          if (ready) child.stderr.write("READY\n");
          const exit = () => {
            child.exitCode = code;
            child.signalCode = signal;
            child.emit("exit", code, signal);
            child.stdout.end();
            child.stderr.end();
          };
          if (immediate) exit();
          else setImmediate(exit);
        });
        return child;
      }
    });
    if (ready && code === 0 && signal === null) {
      const result = await pending;
      assert.match(result.output, /CANVASTTY_SMOKE_READY/);
      assert.ok(result.elapsedMs >= 0);
    } else {
      await assert.rejects(pending, (error) => {
        assert.match(error.message, ready ? /AppImage exited unsuccessfully/ : /AppImage exited before rendering/);
        assert.ok(error.message.includes(`code=${code}, signal=${signal}`));
        return true;
      });
    }
    await assert.rejects(access(userData), { code: "ENOENT" });
  }
});
