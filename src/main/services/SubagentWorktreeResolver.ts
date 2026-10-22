import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { AgentControlOptions } from "./AgentControlService.ts";
import type { EnvironmentProvider } from "./EnvironmentRegistry.ts";

const exec = promisify(execFile);

/**
 * A subagent of a Git project gets a worktree from the first trusted environments plugin that offers the `worktree`
 * kind for its CLI, keeping the launch and running on this computer; the plugin creates it, CanvasTTY only chooses it. Without such a plugin, or outside the top of a
 * Git project, the subagent runs in its folder (and an explicit `isolate: "worktree"` is refused by the caller).
 */
export function subagentWorktreeResolver(dependencies: {
  isGitProject(projectRoot: string): Promise<boolean>;
  providers(): EnvironmentProvider[];
}): NonNullable<AgentControlOptions["resolveSubagentEnvironment"]> {
  return async (request) => {
    // Only a local worktree that passes the launch on unchanged: without `keeps.launch` every subagent above normal would
    // be refused, and an `isolated` one would run outside this computer's isolation layer and its worktree checks.
    const provider = dependencies.providers().find((row) => row.kinds.some((kind) => kind.kind === "worktree"
      && kind.keeps?.launch === true && kind.keeps.isolated !== true
      && (!kind.appliesTo || kind.appliesTo.includes(request.provider))));
    // Without such a plugin no Git process runs for the spawn.
    if (!provider || !await dependencies.isGitProject(request.projectRoot)) return null;
    return { pluginId: provider.pluginId, kind: "worktree" };
  };
}

/** The folder is the top of a Git working tree (not a folder inside one). No hooks or repository filters run. */
export async function isGitProjectRoot(folder: string): Promise<boolean> {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  try {
    const { stdout } = await exec("git", ["--no-replace-objects", "-C", folder, "rev-parse", "--show-toplevel"], { env, timeout: 5_000 });
    return await realpath(stdout.trim()) === await realpath(folder);
  } catch {
    return false;
  }
}
