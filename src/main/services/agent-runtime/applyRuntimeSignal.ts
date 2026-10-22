import type { RuntimeLifecycleSignal } from "./RuntimeGateway.ts";
import type { TerminalManager } from "../TerminalManager.ts";

/**
 * What main does with one runtime gateway signal: the card's status first, then the final answer it carries (Codex
 * Stop hook, OpenCode plugin) for get_agent_result and wait_for_agent, kept only when the signal belongs to the
 * current turn and the last submitted input.
 */
export function applyRuntimeSignal(
  terminals: Pick<TerminalManager, "applyProviderSignal" | "recordAnswer">,
  terminalSessionId: string,
  signal: RuntimeLifecycleSignal
): void {
  const current = terminals.applyProviderSignal(terminalSessionId, {
    kind: "lifecycle",
    state: signal.state,
    event: signal.event,
    ...(signal.turnId ? { requestId: signal.turnId } : {}),
    ...(signal.threadId ? { threadId: signal.threadId } : {})
  });
  if (current && signal.result) terminals.recordAnswer(terminalSessionId, signal.result, { turnId: signal.turnId });
}
