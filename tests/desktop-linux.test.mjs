import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Linux desktop lifecycle preserves client visibility and removes closed viewports", {
  skip: process.platform !== "linux", timeout: 10_000,
}, () => {
  const result = spawnSync("python3", ["-B", fileURLToPath(new URL("./fixtures/desktop-linux-lifecycle.py", import.meta.url))], {
    encoding: "utf8", timeout: 8_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
