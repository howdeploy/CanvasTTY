import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ownedPids, readTrial, successfulTrials, validateTrial } from "./trial.mjs";

const report = () => ({
  done: true, errors: [], rendererErrors: [],
  window: { visible: false, focused: false }, windowEnd: { visible: false, focused: false },
  main: { ready: 12 }, scenarios: { pan: { moves: 300 } }
});
const requiredNumbers = ["main.ready", "scenarios.pan.moves"];

test("a done benchmark trial still fails on errors, abnormal exit or missing measurements", () => {
  assert.equal(validateTrial(report(), { requiredNumbers }).valid, true);
  for (const change of [
    (r) => { r.done = false; },
    (r) => { r.valid = false; },
    (r) => { r.errors.push("scenario failed"); },
    (r) => { r.rendererErrors.push("renderer failed"); },
    (r) => { r.windowEnd.focused = true; },
    (r) => { delete r.windowEnd; },
    (r) => { delete r.errors; },
    (r) => { delete r.scenarios.pan; },
    (r) => { r.main.ready = NaN; }
  ]) {
    const r = report();
    change(r);
    assert.equal(validateTrial(r, { requiredNumbers }).valid, false);
    assert.ok(r.validationErrors.length > 0);
  }
  const crashed = validateTrial(report(), { exitError: new Error("exit signal SIGTERM"), requiredNumbers });
  assert.equal(crashed.valid, false);
  assert.match(crashed.exitAfterReport, /SIGTERM/);
});

test("successful trial selection excludes failed samples without dropping their diagnostics", () => {
  const good = validateTrial(report(), { requiredNumbers });
  const bad = report();
  bad.main.ready = 0;
  bad.errors.push("workload never ran");
  const runs = [good, validateTrial(bad, { requiredNumbers })];
  assert.deepEqual(successfulTrials(runs), [good]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1].errors, ["workload never ran"]);
  assert.equal(runs[1].main.ready, 0, "raw failed measurements are retained");
  assert.deepEqual(successfulTrials([runs[1]]), []);
});

test("missing and malformed benchmark reports survive as invalid diagnostic trials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-trial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "report.json");
  const missing = readTrial(file, { requiredNumbers });
  assert.equal(missing.valid, false);
  assert.match(missing.reportReadError, /ENOENT/);
  await writeFile(file, "{broken");
  const broken = readTrial(file, { requiredNumbers });
  assert.equal(broken.valid, false);
  assert.ok(broken.reportReadError);
  await writeFile(file, JSON.stringify(report()));
  assert.equal(readTrial(file, { requiredNumbers }).valid, true);
});

test("benchmark cleanup selects only the unique trial path and its current descendants", () => {
  const pid = (index) => process.pid + 10_000 + index;
  const snapshot = [
    `${pid(1)} 1 /Electron /tmp/trial-a/app`,
    `${pid(2)} ${pid(1)} /bin/zsh`,
    `${pid(3)} ${pid(2)} /node /repo/scripts/bench-runtime/flood.mjs`,
    `${pid(4)} 1 /Electron /tmp/trial-a-neighbour/app`,
    `${pid(5)} ${pid(4)} /node /repo/scripts/bench/fake-agent.mjs`,
    `${pid(6)} 1 /node /repo/scripts/bench-runtime/flood.mjs`,
    `${pid(7)} 1 /Electron --user-data-dir="/tmp/trial-a/u"`,
    `${pid(8)} 1 /Electron /tmp/trial-a-sibling`,
    `${process.pid} 1 /node /tmp/trial-a/current-process`
  ].join("\n");
  assert.deepEqual(ownedPids(snapshot, ["/tmp/trial-a"]).sort((a, b) => a - b), [pid(1), pid(2), pid(3), pid(7)]);
  assert.deepEqual(ownedPids(snapshot, ["/tmp/absent"]), []);
  for (const directory of ["", "/", "//", "/tmp/..", "relative/trial"]) {
    assert.throws(() => ownedPids(snapshot, [directory]), /Benchmark cleanup/);
  }
});
