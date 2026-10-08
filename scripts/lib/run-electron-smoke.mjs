import assert from "node:assert/strict";
import { spawn } from "node:child_process";

export async function runElectronSmoke(executable, script, environment, marker) {
  const child = spawn(executable, [script, "--disable-gpu"], {
    env: environment, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "", errorOutput = "";
  child.stdout.on("data", chunk => { output += chunk; process.stdout.write(chunk); });
  child.stderr.on("data", chunk => { errorOutput += chunk; process.stderr.write(chunk); });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      // Wait for the pipes to drain, including a marker written just before exit.
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.signal, null, `${marker}: timed out or crashed\n${errorOutput}`);
    assert.equal(result.code, 0, `${marker}: failed\n${errorOutput}`);
    assert.ok(output.includes(marker), `${marker}: did not finish`);
    return { output, errorOutput };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
