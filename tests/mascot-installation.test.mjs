import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import { transformSync } from "esbuild";

test("retries corrected and explicit mascot handoffs without restart, retains diagnostics and registered state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mascot-retry-"));
  const id = "11111111-1111-4111-8111-111111111111";
  const project = path.join(root, "mascots", id);
  const plugin = path.join(project, "plugin");
  let attempts = 0;
  let reject = true;
  let cardFailure = false;
  let duringVerification;
  const execFile = () => {};
  execFile[promisify.custom] = async (_command, args) => {
    if (args.includes("-c")) return { stdout: path.join(root, "python.exe") };
    attempts++;
    if (duringVerification) await duringVerification();
    if (reject) throw Object.assign(new Error("Command failed: " + "long/path/".repeat(200)), {
      stderr: "Traceback\nValueError: current build lacks visual evidence\n", stdout: "validation output"
    });
    return { stdout: "verified" };
  };
  const code = transformSync(await readFile(new URL("../src/main/services/MascotManager.ts", import.meta.url), "utf8"), {
    loader: "ts", format: "cjs", target: "es2022"
  }).code;
  const exports = {};
  const module = { exports };
  vm.runInNewContext(code, { exports, module, process, Buffer, console, setInterval, clearInterval, setTimeout, clearTimeout,
    require: (name) => {
      if (name === "node:fs/promises") return fs;
      if (name === "node:path") return path;
      if (name === "node:util") return { promisify };
      if (name === "node:os") return { homedir: () => root };
      if (name === "node:crypto") return {};
      if (name === "node:child_process") return { execFile };
      if (name === "electron") return {};
      if (name.endsWith("path-inside.mjs")) return { isPathInside: (parent, child) => !path.relative(parent, child).startsWith("..") };
      throw new Error(`Unexpected import: ${name}`);
    }
  });
  const registry = [];
  const manager = new module.exports.MascotManager(root, root, {
    list: () => registry,
    installLocalMascot: async () => {
      const installed = { sourceUrl: `mascot:${id}`, manifest: { id: "fixture", contributions: [{ id: "character" }] } };
      registry.splice(0, registry.length, installed);
      return installed;
    }
  }, () => {}, () => { if (cardFailure) throw new Error("Card unavailable"); });
  try {
    await mkdir(plugin, { recursive: true });
    manager.records.set(id, { id, name: "Fixture", createdAt: 1, status: "creating" });
    await writeFile(path.join(project, "character.json"), JSON.stringify({ id: "fixture", name: "Fixture", plugin_dir: "plugin", deck: ["wave"] }));
    await writeFile(path.join(project, "review.json"), JSON.stringify({ limitations: [] }));
    const result = { schemaVersion: 1, status: "ready_for_host", installationApproved: true, buildId: "first",
      id: "fixture", name: "Fixture", pluginDirectory: plugin, actions: ["wave"], presentation: { transparentCard: true, resizable: true } };
    const save = async () => {
      await writeFile(path.join(project, "mascot-result.json"), JSON.stringify(result));
      await writeFile(path.join(project, "build-report.json"), JSON.stringify({ build_id: result.buildId }));
    };
    await save();
    await manager.checkResults();
    assert.equal(manager.list()[0].status, "failed");
    assert.match(manager.list()[0].error, /current build lacks visual evidence/);
    assert.match(await readFile(manager.list()[0].errorLogPath, "utf8"), /long\/path\/.*validation output/s);
    await manager.checkResults();
    assert.equal(attempts, 1, "unchanged rejection must not be retried automatically");
    result.buildId = "corrected";
    reject = false;
    await save();
    await manager.checkResults();
    assert.equal(manager.list()[0].installedBuildId, "corrected");
    assert.equal(manager.list()[0].registered, true);
    result.buildId = "update";
    reject = true;
    await save();
    await manager.checkResults();
    assert.equal(manager.list()[0].status, "ready", "failed update preserves registered version");
    assert.equal(manager.list()[0].installedBuildId, "corrected");
    reject = false;
    cardFailure = true;
    await manager.retry(id);
    assert.equal(manager.list()[0].installedBuildId, "update");
    assert.equal(manager.list()[0].errorStage, "card load");
    cardFailure = false;
    await manager.retry(id);
    assert.equal(manager.list()[0].error, undefined);
    result.buildId = "queued";
    reject = true;
    duringVerification = () => manager.retry(id);
    await save();
    await manager.checkResults();
    duringVerification = undefined;
    reject = false;
    await manager.checkResults();
    assert.equal(manager.list()[0].installedBuildId, "queued", "retry during a check remains queued for the next poll");
  } finally {
    manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
