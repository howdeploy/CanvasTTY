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

test("a mascot starts one new Codex turn with one image without changing other providers", () => {
  const initial = { initialPrompt: "Read the pipeline.\nKeep the character identity.", initialImagePath: "/project with spaces/character.png" };
  const launch = resolveTerminalLaunch("codex", "yolo", [], {
    platform: "linux", environment: {}, providerCli: available("codex", "/official/codex"), ...initial
  });
  assert.deepEqual(launch.args.slice(-3), ["Read the pipeline. Keep the character identity.", "--image", initial.initialImagePath]);
  assert.equal(launch.args.filter((value) => value === "--image").length, 1);
  assert.ok(!launch.args.includes("resume"));
  const sibling = resolveTerminalLaunch("claude", "normal", [], {
    platform: "linux", environment: {}, providerCli: available("claude", "/official/claude"), ...initial
  });
  assert.ok(!sibling.args.includes("--image"));
});

test("Codex QA changes only the interactive launch and keeps the registry backend", () => {
  const environment = {
    CANVASTTY_CODEX_TUI_QA: "/qa/codex-tui",
    CANVASTTY_CODEX_TUI_LAUNCHER_QA: "/qa/launch.mjs"
  };
  const providerCli = available("codex", "/official/codex");
  const overrides = ["-c", "hooks.Stop=[]"];
  assert.deepEqual(resolveTerminalLaunch("codex", "auto", overrides, {
    platform: "darwin", environment, providerCli, fileExists: () => true, resumePrevious: true
  }), {
    command: process.execPath,
    args: ["/qa/launch.mjs", "--backend", "/official/codex", "--frontend", "/qa/codex-tui", "--",
      "--no-daemon", "--approve-for-me", ...overrides, "resume"],
    environment: { PATH: "/resolved/bin:/usr/bin", ELECTRON_RUN_AS_NODE: "1" }
  });
  assert.equal(providerCli.executable, "/official/codex");
  assert.equal(resolveTerminalLaunch("claude", "normal", [], {
    platform: "darwin", environment, providerCli: available("claude", "/official/claude")
  }).command, "/official/claude");
});

test("Codex QA refuses invalid paths rather than silently using another launch", () => {
  for (const environment of [
    { CANVASTTY_CODEX_TUI_QA: "relative" },
    { CANVASTTY_CODEX_TUI_QA: "/qa/codex-tui" },
    { CANVASTTY_CODEX_TUI_QA: "/qa/codex-tui", CANVASTTY_CODEX_TUI_LAUNCHER_QA: "relative" }
  ]) {
    assert.throws(() => resolveTerminalLaunch("codex", "normal", [], {
      platform: "darwin", environment, providerCli: available("codex", "/official/codex"), fileExists: () => true
    }), /existing absolute frontend and launcher paths/);
  }
});

test("packaged POSIX Codex uses its bundled TUI and preserves the official backend", () => {
  const resourcesPath = "/moved app/Contents/Resources";
  const frontend = `${resourcesPath}/codex-native-tui/canvastty-codex-tui`;
  const launcher = `${resourcesPath}/codex-native-tui/codex-tui-launch.mjs`;
  const options = { platform: "darwin", environment: {}, resourcesPath,
    providerCli: available("codex", "/official/codex"), fileExists: (path) => [frontend, launcher].includes(path) };
  assert.deepEqual(resolveTerminalLaunch("codex", "normal", [], options), {
    command: process.execPath,
    args: [launcher, "--backend", "/official/codex", "--frontend", frontend, "--"],
    environment: { PATH: "/resolved/bin:/usr/bin", ELECTRON_RUN_AS_NODE: "1" }
  });
  assert.deepEqual(resolveTerminalLaunch("codex", "normal", [], { ...options, platform: "linux" }),
    resolveTerminalLaunch("codex", "normal", [], options));
  assert.equal(resolveTerminalLaunch("codex", "normal", [], { ...options, platform: "win32" }).command, "/official/codex");
  assert.equal(resolveTerminalLaunch("codex", "normal", [], { ...options, fileExists: () => false }).command, "/official/codex");
  assert.equal(resolveTerminalLaunch("claude", "normal", [], { ...options,
    providerCli: available("claude", "/official/claude") }).command, "/official/claude");
});

test("a partial packaged TUI fails explicitly instead of reverting to the stock editor", () => {
  for (const asset of ["canvastty-codex-tui", "codex-tui-launch.mjs"]) {
    assert.throws(() => resolveTerminalLaunch("codex", "normal", [], {
      platform: "darwin", environment: {}, resourcesPath: "/app/Contents/Resources",
      providerCli: available("codex", "/official/codex"), fileExists: (path) => path.endsWith(`/${asset}`)
    }), /existing absolute frontend and launcher paths/);
  }
});

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

test("Codex uses embedded mode only for scoped config and keeps native resume arguments", () => {
  const providerCli = available("codex", "/resolved/codex");
  const scopedConfig = ["-c", "hooks.Stop=[]"];
  const threadId = "12345678-1234-4234-8234-123456789abc";
  assert.deepEqual(resolveTerminalLaunch("codex", "normal", [], { providerCli }).args, []);
  assert.deepEqual(
    resolveTerminalLaunch("codex", "normal", scopedConfig, { providerCli, resumePrevious: true }).args,
    ["--no-daemon", ...scopedConfig, "resume"]
  );
  assert.deepEqual(
    resolveTerminalLaunch("codex", "normal", scopedConfig, {
      providerCli, resumePrevious: true, resumeThreadId: threadId
    }).args,
    ["--no-daemon", ...scopedConfig, "resume", threadId]
  );
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

  for (const provider of ["claude", "qwen", "kimi", "opencode", "grok", "omp", "pi", "cursor", "minimax", "devin"]) {
    const launch = resolveTerminalLaunch(provider, "normal", ["--bridge"], {
      providerCli: available(provider, `/resolved/${provider}`),
      resumePrevious: true
    });
    assert.deepEqual(launch.args, ["--bridge", "--continue"]);
  }
  const hermes = resolveTerminalLaunch("hermes", "normal", ["--bridge"], {
    providerCli: available("hermes", "/resolved/hermes"),
    resumePrevious: true
  });
  assert.deepEqual(hermes.args, ["--bridge", "sessions", "browse"]);
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

test("Claude, OpenCode, Hermes and Qwen resume their own session by id", () => {
  const uuid = "12345678-1234-4234-8234-123456789abc";
  const claude = resolveTerminalLaunch("claude", "normal", ["--bridge"], {
    providerCli: available("claude", "/resolved/claude"),
    resumePrevious: true,
    resumeThreadId: uuid.toUpperCase()
  });
  assert.deepEqual(claude.args, ["--bridge", "--resume", uuid]);

  const opencode = resolveTerminalLaunch("opencode", "normal", [], {
    providerCli: available("opencode", "/resolved/opencode"),
    resumePrevious: true,
    resumeThreadId: "ses_7a1b2c3d4ffeAbCdEfGhIjKlMn"
  });
  assert.deepEqual(opencode.args, ["--session", "ses_7a1b2c3d4ffeAbCdEfGhIjKlMn"]);

  const hermes = resolveTerminalLaunch("hermes", "normal", [], {
    providerCli: available("hermes", "/resolved/hermes"),
    resumePrevious: true,
    resumeThreadId: "20261001_031347_02c965"
  });
  assert.deepEqual(hermes.args, ["--resume", "20261001_031347_02c965"]);

  for (const [provider, malformed] of [
    ["claude", "--config=evil"], ["claude", "not-a-uuid"],
    ["opencode", uuid], ["opencode", "ses_../x"],
    ["hermes", "--resume-evil"], ["hermes", "not-a-session"]
  ]) {
    assert.throws(() => resolveTerminalLaunch(provider, "normal", [], {
      providerCli: available(provider, `/resolved/${provider}`),
      resumePrevious: true,
      resumeThreadId: malformed
    }), /session ID format/u);
  }

  const qwen = resolveTerminalLaunch("qwen", "yolo", [], {
    providerCli: available("qwen", "/resolved/qwen"),
    resumePrevious: true,
    resumeThreadId: uuid
  });
  assert.deepEqual(qwen.args, ["--yolo", "--resume", uuid]);
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

test("Cursor YOLO uses cursor-agent's own bypass, -f/--force (it rejects Claude Code's flag)", () => {
  const cursor = resolveTerminalLaunch("cursor", "yolo", [], { providerCli: available("cursor", "/resolved/agent") });
  assert.deepEqual(cursor.args, ["--force"]);
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

test("the Windows terminal falls back to the system cmd.exe, never one found on PATH, like provider launches", () => {
  const system = "C:\\Windows\\System32\\cmd.exe";
  const planted = "C:\\Users\\Kisa\\project\\cmd.exe";
  const launch = resolveTerminalLaunch("terminal", "normal", [], {
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows", Path: "C:\\Users\\Kisa\\project;C:\\Windows\\System32" },
    fileExists: (path) => path === planted || path === system
  });
  assert.deepEqual(launch, { command: system, args: ["/d"] });

  const configured = resolveTerminalLaunch("terminal", "normal", [], {
    platform: "win32",
    environment: { ComSpec: "D:\\Windows\\System32\\cmd.exe", Path: "C:\\Users\\Kisa\\project" },
    fileExists: (path) => path === planted || path === "D:\\Windows\\System32\\cmd.exe"
  });
  assert.equal(configured.command, "D:\\Windows\\System32\\cmd.exe");
  assert.throws(() => resolveTerminalLaunch("terminal", "normal", [], {
    platform: "win32",
    environment: { Path: "C:\\Users\\Kisa\\project" },
    fileExists: (path) => path === planted
  }), /No supported Windows shell/);
});
