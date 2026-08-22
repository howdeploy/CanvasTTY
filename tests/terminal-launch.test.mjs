import assert from "node:assert/strict";
import test from "node:test";
import { resolveTerminalLaunch } from "../src/main/services/terminalLaunch.ts";

function available(provider, executable, options = {}) {
  return {
    state: "available",
    provider,
    executable,
    launcher: options.launcher ?? "native",
    ...(options.commandPrompt ? { commandPrompt: options.commandPrompt } : {}),
    environment: options.environment ?? { PATH: "/resolved/bin:/usr/bin" },
    checked: [{ path: executable, result: "selected" }]
  };
}

test("Windows terminal selects built-in PowerShell", () => {
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const launch = resolveTerminalLaunch("terminal", "normal", [], {
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows" },
    fileExists: (path) => path === powershell
  });
  assert.deepEqual(launch, { command: powershell, args: ["-NoLogo", "-NoProfile"] });
});

test("Unix terminal keeps the configured login shell", () => {
  assert.deepEqual(
    resolveTerminalLaunch("terminal", "normal", [], {
      platform: "linux",
      environment: { SHELL: "/usr/bin/zsh" }
    }),
    { command: "/usr/bin/zsh", args: ["-l"] }
  );
});

test("provider launch uses the registry executable and scoped YOLO arguments", () => {
  const providerCli = available("codex", "/opt/homebrew/bin/codex");
  const launch = resolveTerminalLaunch("codex", "yolo", ["--bridge"], {
    platform: "darwin",
    environment: { PATH: "/usr/bin:/bin" },
    providerCli
  });
  assert.deepEqual(launch, {
    command: "/opt/homebrew/bin/codex",
    args: ["--dangerously-bypass-approvals-and-sandbox", "--bridge"],
    environment: { PATH: "/resolved/bin:/usr/bin" }
  });
});

test("OpenCode merges YOLO config with the registry child environment", () => {
  const providerCli = available("opencode", "/test-home/.local/bin/opencode");
  const launch = resolveTerminalLaunch("opencode", "yolo", [], {
    platform: "darwin",
    environment: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "system" }) },
    providerCli
  });
  assert.equal(launch.command, providerCli.executable);
  assert.equal(JSON.parse(launch.environment.OPENCODE_CONFIG_CONTENT).permission, "allow");
  assert.equal(launch.environment.PATH, providerCli.environment.PATH);
});

test("Windows batch provider is routed through the registry command prompt", () => {
  const commandPrompt = "C:\\Windows\\System32\\cmd.exe";
  const providerCli = available(
    "claude",
    "C:\\Users\\Kisa\\AppData\\Roaming\\npm\\claude.cmd",
    { launcher: "batch", commandPrompt, environment: { Path: "C:\\resolved" } }
  );
  const launch = resolveTerminalLaunch("claude", "normal", ["--bridge"], {
    platform: "win32",
    providerCli
  });
  assert.equal(launch.command, commandPrompt);
  assert.match(launch.args, /^\/d \/s \/c /u);
  assert.match(launch.args, /claude\.cmd/u);
});

test("unavailable provider reports the structured diagnostic before PTY launch", () => {
  const providerCli = {
    state: "unavailable",
    provider: "kimi",
    reason: "cli-not-found",
    checked: [{ path: "/opt/homebrew/bin/kimi", result: "missing" }],
    diagnostic: "Kimi CLI was not found.\nChecked paths:\n  - /opt/homebrew/bin/kimi: missing"
  };
  assert.throws(
    () => resolveTerminalLaunch("kimi", "normal", [], { providerCli }),
    /\/opt\/homebrew\/bin\/kimi: missing/u
  );
});
