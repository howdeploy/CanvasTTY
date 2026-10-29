import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { reportLifecycle } from "./runtime-client.mjs";
import { windowsBatchShellCommand } from "./windows-batch.mjs";

// The recipe is private to one shell card; it never contains commands from shell history.
const [recipePath, ...userArgs] = process.argv.slice(2);
const recipe = JSON.parse(readFileSync(recipePath, "utf8"));
const invocationId = randomUUID();
Object.assign(process.env, recipe.environment, { CANVASTTY_SHELL_CODEX_INVOCATION: invocationId });
await reportLifecycle({ state: "idle", event: "ShellCodexStart", cwd: process.cwd() });
const environment = { ...process.env, ...recipe.cli.environment };
delete environment.ELECTRON_RUN_AS_NODE;
if (environment.CANVASTTY_SHELL_CODEX_ZDOTDIR) environment.ZDOTDIR = environment.CANVASTTY_SHELL_CODEX_ZDOTDIR;
delete environment.CANVASTTY_SHELL_CODEX_ZDOTDIR;
delete environment.CANVASTTY_SHELL_CODEX_RESUMED;
// Agent tools must resolve the real CLI rather than recursively enter this card's wrapper.
const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
environment[pathKey] = (environment[pathKey] ?? "").split(delimiter).filter((part) => part !== recipe.directory).join(delimiter);
const args = ["--no-daemon", ...recipe.hooks, ...userArgs];
const batch = recipe.cli.launcher === "batch";
const child = spawn(batch ? recipe.cli.commandPrompt : recipe.cli.executable,
  batch ? ["/d", "/s", "/c", windowsBatchShellCommand(recipe.cli.executable, args)] : args,
  { stdio: "inherit", env: environment, ...(batch ? { windowsVerbatimArguments: true } : {}) });
// The CLI owns terminal Ctrl+C; do not terminate its observing wrapper before its exit hook.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => child.kill("SIGTERM"));
const code = await new Promise((resolve) => {
  child.once("error", (error) => { console.error(`Codex could not start: ${error.message}`); resolve(1); });
  child.once("exit", (status, signal) => resolve(status ?? (signal === "SIGINT" ? 130 : 1)));
});
await reportLifecycle({ state: "idle", event: "ShellCodexEnd", cwd: process.cwd() });
process.exitCode = code;
