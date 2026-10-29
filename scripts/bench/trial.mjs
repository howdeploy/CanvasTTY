import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, parse, resolve } from "node:path";

/** Completion is not success: keep failed trials intact, but out of successful aggregates. */
export function validateTrial(report, { exitError = null, requiredNumbers = [] } = {}) {
  const trial = report && typeof report === "object" && !Array.isArray(report)
    ? report : { errors: [], rendererErrors: [] };
  const failures = [];
  if (trial.valid === false) failures.push("the harness marked the trial invalid");
  if (trial.done !== true) failures.push("the harness did not finish");
  if (exitError) {
    trial.exitAfterReport = String(exitError.message ?? exitError);
    failures.push(`process failed: ${trial.exitAfterReport}`);
  }
  for (const field of ["errors", "rendererErrors"]) {
    if (!Array.isArray(trial[field])) failures.push(`missing ${field} list`);
    else for (const error of trial[field]) failures.push(`${field}: ${error}`);
  }
  for (const field of ["window", "windowEnd"]) {
    if (trial[field]?.visible !== false || trial[field]?.focused !== false) {
      failures.push(`${field} was not confirmed hidden and unfocused`);
    }
  }
  for (const path of requiredNumbers) {
    const value = path.split(".").reduce((value, key) => value?.[key], trial);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      failures.push(`missing or invalid measurement: ${path}`);
    }
  }
  trial.validationErrors = failures;
  trial.valid = failures.length === 0;
  return trial;
}

export function readTrial(path, options) {
  try {
    return validateTrial(JSON.parse(readFileSync(path, "utf8")), options);
  } catch (error) {
    const trial = validateTrial(null, options);
    trial.reportReadError = error.message;
    trial.validationErrors.push(`report could not be read: ${error.message}`);
    return trial;
  }
}

export const successfulTrials = (reports) => reports.filter((report) => report.valid === true);

export function invalidateTrial(trial, message) {
  trial.valid = false;
  (trial.validationErrors ??= []).push(message);
}

/** Match a unique trial directory as a path, never shared benchmark script names. */
export function ownedPids(snapshot, directories) {
  const roots = directories.map((directory) => {
    if (!isAbsolute(directory)) throw new Error("Benchmark cleanup needs an absolute trial directory.");
    const root = resolve(directory);
    if (root === parse(root).root) throw new Error("Benchmark cleanup cannot target a filesystem root.");
    return root;
  });
  const rows = snapshot.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : [];
  });
  const owned = new Set();
  for (const row of rows) {
    if (roots.some((root) => {
      const escaped = root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return new RegExp(`(?:^|[=\\s"'])${escaped}(?:[/\\s"']|$)`, "u").test(row.command);
    })) owned.add(row.pid);
  }
  let changed;
  do {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
    }
  } while (changed);
  return [...owned].filter((pid) => pid > 1 && pid !== process.pid);
}

export function reapTrial(directories) {
  const snapshot = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  for (const pid of ownedPids(snapshot, directories).reverse()) {
    try { process.kill(pid, "SIGKILL"); } catch { /* The owned process may already have exited. */ }
  }
}
