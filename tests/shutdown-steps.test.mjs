import assert from "node:assert/strict";
import test from "node:test";
import { runShutdownSteps } from "../src/main/services/shutdownSteps.ts";

test("report and timeline flush failures do not skip budget flush or service disposal", async () => {
  const calls = [], warnings = [];
  const failure = new Error("fixture disk write failed");
  await assert.doesNotReject(runShutdownSteps([
    { name: "reports", run: async () => { calls.push("reports"); throw failure; } },
    { name: "timeline", run: () => { calls.push("timeline"); throw failure; } },
    ...["budgets", "browser", "plugin services", "plugins"].map(name => ({ name, run: async () => { calls.push(name); } }))
  ], (message, error) => warnings.push({ message, error })));
  assert.deepEqual(calls, ["reports", "timeline", "budgets", "browser", "plugin services", "plugins"]);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0].error, failure);
  assert.match(warnings[0].message, /reports failed/u);
});
