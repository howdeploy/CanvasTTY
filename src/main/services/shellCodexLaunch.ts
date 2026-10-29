import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { basename, dirname, join, delimiter, win32 } from "node:path";
import type { HelperLaunch } from "./agentHelpers.ts";
import type { AvailableProviderCli } from "./providerCliRegistry.ts";
import type { TerminalLaunch } from "./terminalLaunch.ts";
import type { NestedCodexSession } from "./TerminalSessionStore.ts";
import { windowsBatchShellCommand } from "../../agent-runtime/windows-batch.mjs";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const batchLiteral = (value: string): string => `"${value.replaceAll("%", "%%")}"`;

export function createShellCodexWrapper(options: {
  directory: string;
  helper: HelperLaunch;
  cli: AvailableProviderCli;
  hooks: string[];
  environment: Record<string, string>;
  platform?: NodeJS.Platform;
}): { wrapper: string; directory: string; cleanup(): void } {
  const platform = options.platform ?? process.platform;
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(options.directory, "shell-codex-"));
  const wrapper = join(directory, platform === "win32" ? "codex.cmd" : "codex");
  const recipe = join(directory, "launch.json");
  try {
    const { executable, launcher, commandPrompt, environment } = options.cli;
    writeFileSync(recipe, JSON.stringify({ directory, cli: { executable, launcher, commandPrompt, environment }, hooks: options.hooks, environment: options.environment }), { mode: 0o600 });
    const command = [options.helper.command, ...options.helper.args, recipe];
    writeFileSync(wrapper, platform === "win32"
      ? `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n${command.map(batchLiteral).join(" ")} %*\r\n`
      : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${command.map(quote).join(" ")} "$@"\n`, { mode: 0o700 });
    return { wrapper, directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function shellCodexEnvironment(environment: Record<string, string>, directory: string, platform = process.platform): Record<string, string> {
  const key = Object.keys(environment).find((name) => name.toLowerCase() === "path") ?? "PATH";
  return { [key]: `${directory}${platform === "win32" ? ";" : delimiter}${environment[key] ?? ""}` };
}

/** Startup files may replace PATH (NVM, /etc/profile); install the private prefix after them. */
export function instrumentShellCodex(shell: TerminalLaunch, wrapper: string, environment: Record<string, string>, platform = process.platform): TerminalLaunch {
  if (platform === "win32") return shell;
  const directory = dirname(wrapper);
  const name = basename(shell.command);
  // shortcut: Bash reads login startup files with login_shell off; use a login-shell bootstrap if shell config requires that flag.
  if (name === "bash") {
    const init = join(directory, "bashrc");
    writeFileSync(init, `if [ -r /etc/profile ]; then . /etc/profile; fi\nif [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"; elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"; elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"; fi\nexport PATH=${quote(directory)}:"$PATH"\nhash -r\n`, { mode: 0o600 });
    return { ...shell, args: ["--noprofile", "--rcfile", init, "-i"] };
  }
  if (name === "fish" && Array.isArray(shell.args)) return { ...shell,
    args: [...shell.args, "--init-command", `set -gx PATH ${quote(directory)} $PATH`] };
  if (name === "zsh") {
    const original = environment.ZDOTDIR ?? environment.HOME;
    if (!original) return shell;
    for (const file of [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"]) {
      writeFileSync(join(directory, file), `ZDOTDIR="$CANVASTTY_SHELL_CODEX_ZDOTDIR"\nif [[ -r "$ZDOTDIR/${file}" ]]; then source "$ZDOTDIR/${file}"; fi\nexport CANVASTTY_SHELL_CODEX_ZDOTDIR="\${ZDOTDIR:-$HOME}"\nexport ZDOTDIR=${quote(directory)}\n${file === ".zlogin" ? `export PATH=${quote(directory)}:"$PATH"\nrehash\n` : ""}`, { mode: 0o600 });
    }
    return { ...shell, environment: { ...shell.environment, ZDOTDIR: directory, CANVASTTY_SHELL_CODEX_ZDOTDIR: original } };
  }
  return shell;
}

/** Resume inside the original shell and leave that shell interactive after Codex exits. */
export function resumeShellCodex(shell: TerminalLaunch, wrapper: string, nested: NestedCodexSession, platform = process.platform): TerminalLaunch {
  if (typeof shell.args === "string") throw new Error("A shell resume needs structured shell arguments.");
  if (platform !== "win32") {
    const command = `${quote(wrapper)} resume ${quote(nested.threadId)}`;
    const directory = dirname(wrapper);
    const name = basename(shell.command);
    const bashrc = shell.args[shell.args.indexOf("--rcfile") + 1];
    const once = `\nif [ -z "\${CANVASTTY_SHELL_CODEX_RESUMED:-}" ]; then\nexport CANVASTTY_SHELL_CODEX_RESUMED=1\n${command}\nfi\n`;
    if (name === "bash" && shell.args.includes("--rcfile") && bashrc === join(directory, "bashrc")) {
      appendFileSync(bashrc, once, { mode: 0o600 });
      return shell;
    }
    if (name === "zsh" && shell.environment?.ZDOTDIR === directory && shell.args.includes("-l")) {
      appendFileSync(join(directory, ".zlogin"), once, { mode: 0o600 });
      return shell;
    }
    if (name === "fish" && shell.args.includes("--init-command")) {
      return { ...shell, args: [...shell.args, "--init-command", command] };
    }
    throw new Error(`The saved Codex cannot resume in ${name}: no private interactive shell startup is available.`);
  }
  if (win32.basename(shell.command).toLowerCase() === "cmd.exe") return { ...shell,
    args: ["/d", "/s", "/k", windowsBatchShellCommand(wrapper, ["resume", nested.threadId])] };
  const ps = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  return { ...shell, args: [...shell.args, "-NoExit", "-Command", `& ${ps(wrapper)} resume ${ps(nested.threadId)}`] };
}
