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

test("Cursor permits an explicitly configured generic agent executable", () => {
  const agent = "/test-home/.local/bin/agent";
  const registry = createProviderCliRegistry({
    platform: "darwin",
    overrides: { cursor: agent },
    environment: { PATH: "/usr/bin:/bin" },
    homeDirectory: "/test-home",
    inspectCandidate: inspection(new Map([
      [agent, null],
      ["/usr/bin/cursor", null]
    ])),
    directoryExists: (path) => ["/usr/bin", "/bin", "/test-home/.local/bin"].includes(path)
  });

  const resolution = registry.get("cursor");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.provider, "cursor");
  assert.equal(resolution.executable, agent);
  assert.equal(resolution.environment.PATH, "/usr/bin:/bin:/test-home/.local/bin");
  // A literal `cursor` executable must never be selected for the cursor provider.
  assert.equal(resolution.checked.some((candidate) => candidate.path.endsWith("/cursor")), false);
});

test("Cursor falls back to the cursor-agent spelling when agent is absent", () => {
  const legacy = "/usr/local/bin/cursor-agent";
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: { PATH: "/usr/bin:/usr/local/bin" },
    inspectCandidate: inspection(new Map([[legacy, null]])),
    directoryExists: () => true
  });

  const resolution = registry.get("cursor");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, legacy);
});

test("MiniMax Code resolves through its mcode command instead of the provider id", () => {
  const mcode = "/test-home/.npm-global/bin/mcode";
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: { PATH: "/usr/bin" },
    homeDirectory: "/test-home",
    inspectCandidate: inspection(new Map([
      [mcode, null],
      ["/usr/bin/minimax", null]
    ])),
    directoryExists: (path) => ["/usr/bin", "/test-home/.npm-global/bin"].includes(path)
  });

  const resolution = registry.get("minimax");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, mcode);
  assert.equal(resolution.checked.some((candidate) => candidate.path.endsWith("/minimax")), false);
});

test("Devin resolves through its devin command", () => {
  const devin = "/opt/homebrew/bin/devin";
  const registry = createProviderCliRegistry({
    platform: "darwin",
    environment: { PATH: "/usr/bin:/bin" },
    inspectCandidate: inspection(new Map([[devin, null]])),
    directoryExists: (path) => ["/usr/bin", "/bin", "/opt/homebrew/bin"].includes(path)
  });

  const resolution = registry.get("devin");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, devin);
});

test("Antigravity resolves through its agy command instead of the provider id", () => {
  const agy = "/test-home/.local/bin/agy";
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: { PATH: "/usr/bin" },
    homeDirectory: "/test-home",
    inspectCandidate: inspection(new Map([
      [agy, null],
      ["/usr/bin/antigravity", null]
    ])),
    directoryExists: (path) => ["/usr/bin", "/test-home/.local/bin"].includes(path)
  });

  const resolution = registry.get("antigravity");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, agy);
  assert.equal(resolution.checked.some((candidate) => candidate.path.endsWith("/antigravity")), false);
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

test("custom definitions resolve executables that do not match the provider id", () => {
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: { PATH: "/usr/bin" },
    definitions: [{ id: "example", commands: ["exa"] }],
    inspectCandidate: inspection(new Map([["/usr/bin/exa", null]])),
    directoryExists: () => true
  });

  const resolution = registry.get("example");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.provider, "example");
  assert.equal(resolution.executable, "/usr/bin/exa");
  assert.deepEqual(Object.keys(registry.snapshot()), ["example"]);
});

test("definitions fall back to later commands when the primary command is missing", () => {
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: { PATH: "/usr/bin" },
    definitions: [{ id: "example", commands: ["exa", "example-agent"] }],
    inspectCandidate: inspection(new Map([["/usr/bin/example-agent", null]])),
    directoryExists: () => true
  });

  const resolution = registry.get("example");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, "/usr/bin/example-agent");
  assert.deepEqual(
    resolution.checked.map((candidate) => candidate.path),
    ["/usr/bin/exa", "/usr/bin/example-agent"]
  );
});

test("definition known directories participate in resolution and child PATH", () => {
  const registry = createProviderCliRegistry({
    platform: "darwin",
    environment: { PATH: "/usr/bin:/bin" },
    homeDirectory: "/test-home",
    definitions: [{
      id: "example",
      commands: ["exa"],
      knownDirectories: [{ root: "home", segments: [".example", "bin"] }]
    }],
    inspectCandidate: inspection(new Map([["/test-home/.example/bin/exa", null]])),
    directoryExists: (path) => ["/usr/bin", "/bin", "/test-home/.example/bin"].includes(path)
  });

  const resolution = registry.get("example");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, "/test-home/.example/bin/exa");
  assert.equal(resolution.environment.PATH, "/usr/bin:/bin:/test-home/.example/bin");
});

test("windows-local-appdata known directories are ignored outside Windows", () => {
  const registry = createProviderCliRegistry({
    platform: "darwin",
    environment: { PATH: "/usr/bin" },
    homeDirectory: "/test-home",
    definitions: [{
      id: "example",
      commands: ["exa"],
      knownDirectories: [{ root: "windows-local-appdata", segments: ["Programs", "Example", "bin"] }]
    }],
    inspectCandidate: () => "missing",
    directoryExists: () => true
  });

  const resolution = registry.get("example");
  assert.equal(resolution.state, "unavailable");
  assert.equal(
    resolution.checked.some((candidate) => candidate.path.includes("AppData")),
    false
  );
});

test("definitions without commands or with duplicate ids are rejected", () => {
  const base = {
    platform: "linux",
    environment: {},
    inspectCandidate: () => "missing",
    directoryExists: () => false
  };
  assert.throws(
    () => createProviderCliRegistry({ ...base, definitions: [{ id: "example", commands: [] }] }),
    /at least one CLI command/u
  );
  assert.throws(
    () => createProviderCliRegistry({
      ...base,
      definitions: [
        { id: "example", commands: ["exa"] },
        { id: "example", commands: ["exa2"] }
      ]
    }),
    /declared more than once/u
  );
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
