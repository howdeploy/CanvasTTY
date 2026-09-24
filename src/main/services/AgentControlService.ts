import type {
  AgentProviderId,
  LaunchProfileId,
  SessionSnapshot
} from "../../shared/contracts.ts";
import { PROVIDER_CAPABILITIES } from "../../shared/contracts.ts";
import type { TerminalManager } from "./TerminalManager.ts";

// Roadmap F1 preview: a programmatic parent must not be able to fan out
// without bound. The real budgets setting arrives with resource management;
// until then this hard cap is the only backstop.
const MAX_CHILDREN_PER_PARENT = 16;
const MAX_OBSERVE_CHARS = 8_192;
const CHILD_POSITION_STEP = { x: 60, y: 60 };

export interface SpawnAgentRequest {
  parentSessionId: string;
  provider: AgentProviderId;
  cwd: string;
  profile?: LaunchProfileId;
  title?: string;
  /** Prompt written into the new agent's PTY immediately after launch. */
  initialPrompt?: string;
}

export interface AgentObservation {
  sessionId: string;
  status: SessionSnapshot["status"];
  /** Raw terminal tail, capped; capabilities with result \"none\" see nothing. */
  output: string;
}

export interface AgentResult {
  sessionId: string;
  state: "running" | "done" | "failed";
  exitCode: number | null;
  output: string;
}

export class AgentControlService {
  private readonly terminals: TerminalManager;

  constructor(terminals: TerminalManager) {
    this.terminals = terminals;
  }

  spawn(request: SpawnAgentRequest): SessionSnapshot {
    if (!request || typeof request.parentSessionId !== "string") {
      throw new Error("A parent session id is required.");
    }
    const parent = this.requireSession(request.parentSessionId);
    const capabilities = PROVIDER_CAPABILITIES[request.provider];
    if (!capabilities) throw new Error("Unknown agent provider.");
    if (!capabilities.send) throw new Error(`${request.provider} cannot receive prompts.`);

    const children = this.children(parent.id);
    if (children.length >= MAX_CHILDREN_PER_PARENT) {
      throw new Error(`Session ${parent.id} already has ${MAX_CHILDREN_PER_PARENT} subagents.`);
    }

    const cascade = children.length;
    const created = this.terminals.create({
      provider: request.provider,
      cwd: request.cwd,
      profile: request.profile ?? "normal",
      position: {
        x: parent.position.x + CHILD_POSITION_STEP.x * (cascade + 1),
        y: parent.position.y + CHILD_POSITION_STEP.y * (cascade + 1)
      },
      ...(request.title !== undefined ? { title: request.title } : {}),
      role: "subagent",
      parentSessionId: parent.id
    });
    if (request.initialPrompt !== undefined && request.initialPrompt.length > 0) {
      this.send(created.id, request.initialPrompt);
    }
    return created;
  }

  send(sessionId: string, text: string, submit = true): void {
    const session = this.requireSession(sessionId);
    if (session.provider === "terminal") throw new Error("Plain terminals are not agents.");
    const capabilities = PROVIDER_CAPABILITIES[session.provider as AgentProviderId];
    if (!capabilities.send) throw new Error(`${session.provider} cannot receive prompts.`);
    if (typeof text !== "string" || text.length === 0) throw new Error("Prompt text is required.");
    if (session.exitCode !== null) throw new Error("Agent session has already exited.");
    this.terminals.input(sessionId, submit ? `${text}\r` : text);
  }

  status(sessionId: string): SessionSnapshot {
    return this.requireSession(sessionId);
  }

  children(parentSessionId: string): SessionSnapshot[] {
    this.requireSession(parentSessionId);
    return this.terminals.list()
      .filter((session) => session.parentSessionId === parentSessionId)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** True when sessionId is parentSessionId itself or any of its descendants. */
  isInSubtree(parentSessionId: string, sessionId: string): boolean {
    if (typeof parentSessionId !== "string" || typeof sessionId !== "string") return false;
    const snapshots = new Map(this.terminals.list().map((session) => [session.id, session]));
    let current: string | undefined = sessionId;
    const seen = new Set<string>();
    while (current !== undefined) {
      if (current === parentSessionId) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      current = snapshots.get(current)?.parentSessionId;
    }
    return false;
  }

  observe(sessionId: string, maxChars = MAX_OBSERVE_CHARS): AgentObservation {
    const session = this.requireSession(sessionId);
    if (session.provider === "terminal") throw new Error("Plain terminals are not agents.");
    const capabilities = PROVIDER_CAPABILITIES[session.provider as AgentProviderId];
    if (!capabilities.observe) throw new Error(`${session.provider} cannot be observed.`);
    return {
      sessionId: session.id,
      status: session.status,
      output: tail(this.terminals.readBuffer(sessionId).buffer, maxChars)
    };
  }

  result(sessionId: string): AgentResult {
    const session = this.requireSession(sessionId);
    if (session.provider === "terminal") throw new Error("Plain terminals are not agents.");
    const capabilities = PROVIDER_CAPABILITIES[session.provider as AgentProviderId];
    if (capabilities.result === "none") {
      return { sessionId: session.id, state: "running", exitCode: session.exitCode, output: "" };
    }
    const buffer = capabilities.result === "terminal"
      ? this.terminals.readBuffer(sessionId).buffer
      : "";
    return {
      sessionId: session.id,
      state: session.exitCode === null
        ? "running"
        : session.exitCode === 0 ? "done" : "failed",
      exitCode: session.exitCode,
      output: tail(buffer, MAX_OBSERVE_CHARS)
    };
  }

  cancel(sessionId: string): void {
    this.requireSession(sessionId);
    this.terminals.dispose(sessionId);
  }

  private requireSession(sessionId: string): SessionSnapshot {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("A session id is required.");
    }
    const session = this.terminals.list().find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error("Terminal session does not exist.");
    return session;
  }
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}
