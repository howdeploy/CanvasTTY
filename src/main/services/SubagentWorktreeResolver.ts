import type { AgentControlOptions } from "./AgentControlService.ts";
import type { EnvironmentProvider } from "./EnvironmentRegistry.ts";

/** Selection uses the trusted project root; worktree creation remains in the existing plugin. */
export function subagentWorktreeResolver(dependencies: {
  isGitProject(projectRoot: string): Promise<boolean>;
  providers(): EnvironmentProvider[];
}): NonNullable<AgentControlOptions["resolveSubagentEnvironment"]> {
  return async request => {
    if (!await dependencies.isGitProject(request.projectRoot)) return null;
    const provider = dependencies.providers().find(row => row.kinds.some(kind => kind.kind === "worktree"
      && (!kind.appliesTo || kind.appliesTo.includes(request.provider))));
    return provider ? { pluginId: provider.pluginId, kind: "worktree" } : null;
  };
}
