import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderCliRegistry,
  providerCliAvailability,
  providerChildProcessLaunch
} from "../src/main/services/providerCliRegistry.ts";

function inspection(results) {
  return (path) => results.has(path) ? results.get(path) : "missing";
}

test("Finder-like macOS PATH resolves Codex from the Homebrew platform default", () => {
  const codex = "/opt/homebrew/bin/codex";
  const registry = createProviderCliRegistry({
    platform: "darwin",
    environment: { PATH: "/usr/bin:/bin" },
    homeDirectory: "/test-home",
    inspectCandidate: inspection(new Map([[codex, null]])),
    directoryExists: (path) => ["/usr/bin", "/bin", "/opt/homebrew/bin"].includes(path)
  });

  const resolution = registry.get("codex");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, codex);
  assert.equal(resolution.launcher, "native");
  assert.equal(resolution.environment.PATH, "/usr/bin:/bin:/opt/homebrew/bin");
});

test("Finder-like macOS PATH resolves OpenCode from its official per-user directory", () => {
  const opencode = "/test-home/.opencode/bin/opencode";
  const registry = createProviderCliRegistry({
    platform: "darwin",
    environment: { PATH: "/usr/bin:/bin" },
    homeDirectory: "/test-home",
    inspectCandidate: inspection(new Map([[opencode, null]])),
    directoryExists: (path) => ["/usr/bin", "/bin", "/test-home/.opencode/bin"].includes(path)
  });

  const resolution = registry.get("opencode");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, opencode);
  assert.equal(resolution.environment.PATH, "/usr/bin:/bin:/test-home/.opencode/bin");
});

test("override wins over PATH and fallback candidates", () => {
  const override = "/fixtures/codex";
  const fromPath = "/tools/codex";
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: { PATH: "/tools" },
    overrides: { codex: override },
    inspectCandidate: inspection(new Map([[override, null], [fromPath, null]])),
    directoryExists: () => true
  });

  const resolution = registry.get("codex");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, override);
  assert.deepEqual(resolution.checked, [{ path: override, result: "selected" }]);
});

test("relative PATH entries are frozen as absolute startup paths", () => {
  const codex = "/workspace/tools/codex";
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: { PATH: "tools:/usr/bin" },
    startupDirectory: "/workspace",
    inspectCandidate: inspection(new Map([[codex, null]])),
    directoryExists: () => true
  });

  const resolution = registry.get("codex");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, codex);
  assert.match(resolution.environment.PATH, /^\/workspace\/tools:/u);
});

test("unavailable diagnostics preserve missing and rejected candidate evidence", () => {
  const notFile = "/tools/codex";
  const notExecutable = "/opt/homebrew/bin/codex";
  const registry = createProviderCliRegistry({
    platform: "darwin",
    environment: { PATH: "/tools" },
    homeDirectory: "/test-home",
    inspectCandidate: inspection(new Map([
      [notFile, "not-file"],
      [notExecutable, "not-executable"]
    ])),
    directoryExists: () => true
  });

  const resolution = registry.get("codex");
  assert.equal(resolution.state, "unavailable");
  assert.match(resolution.diagnostic, /\/tools\/codex: not-file/u);
  assert.match(resolution.diagnostic, /\/opt\/homebrew\/bin\/codex: not-executable/u);
  assert.match(resolution.diagnostic, /Check again in Agents settings/u);
});

test("Windows native launch preserves the resolved executable and child PATH", () => {
  const codex = "D:\\Tools\\codex.exe";
  const registry = createProviderCliRegistry({
    platform: "win32",
    environment: { Path: "D:\\Tools;C:\\Windows\\System32" },
    homeDirectory: "C:\\Users\\Kisa",
    inspectCandidate: inspection(new Map([[codex, null]])),
    directoryExists: () => true
  });

  const resolution = registry.get("codex");
  assert.equal(resolution.state, "available");
  const launch = providerChildProcessLaunch(resolution, ["app-server"]);
  assert.deepEqual(launch, {
    command: codex,
    args: ["app-server"],
    environment: { Path: resolution.environment.Path }
  });
});

test("Windows batch launch uses the startup-resolved command prompt", () => {
  const claude = "C:\\Users\\Kisa\\AppData\\Roaming\\npm\\claude.cmd";
  const commandPrompt = "C:\\Windows\\System32\\cmd.exe";
  const registry = createProviderCliRegistry({
    platform: "win32",
    environment: { APPDATA: "C:\\Users\\Kisa\\AppData\\Roaming", ComSpec: commandPrompt },
    homeDirectory: "C:\\Users\\Kisa",
    inspectCandidate: inspection(new Map([[claude, null], [commandPrompt, null]])),
    directoryExists: () => true
  });

  const resolution = registry.get("claude");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.launcher, "batch");
  const launch = providerChildProcessLaunch(resolution, ["--bridge"]);
  assert.equal(launch.command, commandPrompt);
  assert.deepEqual(launch.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(launch.args[3], /claude\.cmd/u);
  assert.equal(launch.windowsVerbatimArguments, true);
});

test("registry snapshot and provider resolutions are immutable", () => {
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: {},
    inspectCandidate: () => "missing",
    directoryExists: () => false
  });

  assert.equal(Object.isFrozen(registry.snapshot()), true);
  assert.equal(Object.isFrozen(registry.get("codex")), true);
});

test("refresh detects installed and removed CLIs without changing an earlier snapshot", () => {
  const executable = "/tools/codex";
  const present = new Set();
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: { PATH: "/tools" },
    homeDirectory: "/test-home",
    inspectCandidate: (path) => present.has(path) ? null : "missing",
    directoryExists: () => true
  });
  const first = registry.snapshot();
  assert.equal(providerCliAvailability(registry).codex, false);

  present.add(executable);
  registry.refresh();
  assert.equal(registry.get("codex").state, "available");
  assert.equal(providerCliAvailability(registry).codex, true);
  assert.equal(first.codex.state, "unavailable");

  present.delete(executable);
  registry.refresh();
  assert.equal(registry.get("codex").state, "unavailable");
});
