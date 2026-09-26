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

test("Qwen uses its native YOLO flag and keeps per-launch browser arguments", () => {
  const providerCli = available("qwen", "/resolved/qwen");
  const launch = resolveTerminalLaunch("qwen", "yolo", ["--mcp-config", "{}"], { providerCli });
  assert.deepEqual(launch.args, ["--yolo", "--mcp-config", "{}"]);
});

test("Claude keeps launch-scoped adapter arguments in their supplied order", () => {
  const providerCli = available("claude", "/resolved/claude");
  const launch = resolveTerminalLaunch("claude", "normal", ["--mcp-config", "{}"], { providerCli });
  assert.deepEqual(launch.args, ["--mcp-config", "{}"]);
});

test("restored agent windows use each provider's native continue mode", () => {
  const codex = resolveTerminalLaunch("codex", "yolo", ["--bridge"], {
    providerCli: available("codex", "/resolved/codex"),
    resumePrevious: true
  });
  assert.deepEqual(codex.args, [
    "--dangerously-bypass-approvals-and-sandbox",
    "--bridge",
    "resume"
  ]);

  for (const provider of ["claude", "qwen", "kimi", "opencode", "hermes", "grok", "omp", "pi", "cursor", "minimax", "devin"]) {
    const launch = resolveTerminalLaunch(provider, "normal", ["--bridge"], {
      providerCli: available(provider, `/resolved/${provider}`),
      resumePrevious: true
    });
    assert.deepEqual(launch.args, ["--bridge", "--continue"]);
  }
  // antigravity deliberately restores fresh: no latest-session launch flag.
  const restored = resolveTerminalLaunch("antigravity", "normal", ["--bridge"], {
    providerCli: available("antigravity", "/resolved/agy"),
    resumePrevious: true
  });
  assert.deepEqual(restored.args, ["--bridge"]);
});

test("Codex restore with resumeThreadId launches codex resume <UUID>", () => {
  const uuid1 = "12345678-1234-4234-8234-123456789abc";
  const uuid2 = "abcdef01-abcd-4def-9abc-def012345678";

  const launch1 = resolveTerminalLaunch("codex", "normal", ["--bridge"], {
    providerCli: available("codex", "/resolved/codex"),
    resumePrevious: true,
    resumeThreadId: uuid1
  });
  assert.deepEqual(launch1.args, ["--bridge", "resume", uuid1]);

  const launch2 = resolveTerminalLaunch("codex", "yolo", [], {
    providerCli: available("codex", "/resolved/codex"),
    resumePrevious: true,
    resumeThreadId: uuid2.toUpperCase()
  });
  assert.deepEqual(launch2.args, [
    "--dangerously-bypass-approvals-and-sandbox",
    "resume",
    uuid2.toLowerCase()
  ]);
});

test("Codex restore without resumeThreadId launches interactive resume chooser", () => {
  const launch = resolveTerminalLaunch("codex", "normal", [], {
    providerCli: available("codex", "/resolved/codex"),
    resumePrevious: true
  });
  assert.deepEqual(launch.args, ["resume"]);
});

test("Codex restore throws on malformed resumeThreadId", () => {
  for (const malformed of ["not-a-uuid", "12345678-1234-1234-1234", "12345678-1234-1234-1234-123456789abc-extra", "../escape"]) {
    assert.throws(
      () =>
        resolveTerminalLaunch("codex", "normal", [], {
          providerCli: available("codex", "/resolved/codex"),
          resumePrevious: true,
          resumeThreadId: malformed
        }),
      /Invalid Codex thread ID format/u
    );
  }
});

test("Other providers ignore resumeThreadId and retain standard continue flags", () => {
  const uuid = "12345678-1234-4234-8234-123456789abc";
  const claude = resolveTerminalLaunch("claude", "normal", ["--bridge"], {
    providerCli: available("claude", "/resolved/claude"),
    resumePrevious: true,
    resumeThreadId: uuid
  });
  assert.deepEqual(claude.args, ["--bridge", "--continue"]);

  const qwen = resolveTerminalLaunch("qwen", "yolo", [], {
    providerCli: available("qwen", "/resolved/qwen"),
    resumePrevious: true,
    resumeThreadId: uuid
  });
  assert.deepEqual(qwen.args, ["--yolo", "--continue"]);
});

test("Windows batch quoting with Codex resume thread UUID", () => {
  const commandPrompt = "C:\\Windows\\System32\\cmd.exe";
  const uuid = "12345678-1234-4234-8234-123456789abc";
  const providerCli = available(
    "codex",
    "C:\\Users\\Kisa\\AppData\\Roaming\\npm\\codex.cmd",
    { launcher: "batch", commandPrompt, environment: { Path: "C:\\resolved" } }
  );
  const launch = resolveTerminalLaunch("codex", "normal", ["--bridge"], {
    platform: "win32",
    providerCli,
    resumePrevious: true,
    resumeThreadId: uuid
  });
  assert.equal(launch.command, commandPrompt);
  assert.match(launch.args, /codex\.cmd/u);
  assert.match(launch.args, new RegExp(uuid, "u"));
});

test("OMP and Pi use their documented dangerous flags instead of the legacy default", () => {
  const omp = resolveTerminalLaunch("omp", "yolo", [], { providerCli: available("omp", "/resolved/omp") });
  assert.deepEqual(omp.args, ["--auto-approve"]);

  const pi = resolveTerminalLaunch("pi", "yolo", [], { providerCli: available("pi", "/resolved/pi") });
  assert.deepEqual(pi.args, ["--approve"]);
});

test("Cursor YOLO uses its Claude-Code-style permission bypass", () => {
  const cursor = resolveTerminalLaunch("cursor", "yolo", [], { providerCli: available("cursor", "/resolved/agent") });
  assert.deepEqual(cursor.args, ["--dangerously-skip-permissions"]);
});

test("MiniMax YOLO launches the stock CLI because mcode has no bypass flag", () => {
  const minimax = resolveTerminalLaunch("minimax", "yolo", [], { providerCli: available("minimax", "/resolved/mcode") });
  assert.deepEqual(minimax.args, []);
});

test("Devin YOLO selects the documented dangerous permission mode", () => {
  const devin = resolveTerminalLaunch("devin", "yolo", [], { providerCli: available("devin", "/resolved/devin") });
  assert.deepEqual(devin.args, ["--permission-mode", "dangerous"]);
});

test("Antigravity YOLO uses its documented bypass flag", () => {
  const yolo = resolveTerminalLaunch("antigravity", "yolo", [], { providerCli: available("antigravity", "/resolved/agy") });
  assert.deepEqual(yolo.args, ["--dangerously-skip-permissions"]);
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
