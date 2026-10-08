import type { AgentProviderId } from "../../shared/contracts.ts";
import type { PluginAgentTools } from "./PluginAgentTools.ts";

/** Use Accounts' readiness checks, not the launcher's list of saved configurations. */
export async function readyAccountCandidates(tools: Pick<PluginAgentTools, "call">, sessionId: string, provider: AgentProviderId): Promise<Array<{ id: string; label: string }>> {
  try {
    const answer = await tools.call(sessionId, "orchestrator", "canvastty-accounts__list_routes", { provider });
    if (answer.isError) return [];
    const parsed: unknown = JSON.parse(answer.content);
    if (!parsed || typeof parsed !== "object" || !("routes" in parsed) || !Array.isArray(parsed.routes)) return [];
    return parsed.routes.filter((row): row is { accountId: string; account: string; model: string } =>
      !!row && typeof row === "object" && row.provider === provider && row.state === "ready"
      && typeof row.accountId === "string" && typeof row.account === "string" && typeof row.model === "string")
      .map(row => ({ id: row.accountId, label: `${row.account} · ${row.model}` }));
  } catch { return []; } // Failure keeps the inherited account; it never guesses another one.
}
