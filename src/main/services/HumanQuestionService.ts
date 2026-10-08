import { randomBytes } from "node:crypto";
import { DEFAULT_AGENT_WAIT_SECONDS, MAX_AGENT_WAIT_SECONDS } from "../../agent-browser/orchestration-catalog.mjs";
import type { CompanionQuestion } from "../../shared/companion.ts";

export interface HumanQuestionSnapshot extends CompanionQuestion {
  sessionId: string;
}

export interface HumanQuestionRequest {
  question: string;
  /** Empty or omitted options means a freeform reply; a nonempty list accepts only a selected index. */
  options?: readonly string[];
  timeoutSeconds?: number;
}

export interface HumanQuestionSession {
  provider: string;
  startedAt: number;
  exitCode: number | null;
  turnEpoch: number | null;
}

export interface HumanQuestionServiceOptions {
  getSession(sessionId: string): HumanQuestionSession | null;
  redact(text: string): string;
  onRequest?(question: HumanQuestionSnapshot): void;
}

export interface HumanQuestionAnswer {
  answer: string;
  selectedIndex?: number;
}

export type HumanQuestionErrorCode = "INVALID_REQUEST" | "TIMEOUT" | "CANCELED" | "SESSION_EXPIRED";

export class HumanQuestionError extends Error {
  readonly code: HumanQuestionErrorCode;

  constructor(code: HumanQuestionErrorCode, message: string) {
    super(message);
    this.name = "HumanQuestionError";
    this.code = code;
  }
}

interface SessionBinding {
  provider: string;
  startedAt: number;
  turnEpoch: number;
}

interface PendingQuestion {
  snapshot: HumanQuestionSnapshot;
  binding: SessionBinding;
  resolve(answer: HumanQuestionAnswer): void;
  reject(error: HumanQuestionError): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const MAX_PENDING_QUESTIONS = 64;
const MAX_QUESTION_LENGTH = 1_000;
const MAX_OPTIONS = 8;
const MAX_OPTION_LENGTH = 160;
const MAX_ANSWER_LENGTH = 2_000;

/** A small, memory-only rendezvous between agent tools and the host's human-response UI. */
export class HumanQuestionService {
  private readonly options: HumanQuestionServiceOptions;
  private readonly pendingBySession = new Map<string, PendingQuestion>();
  private closed = false;

  constructor(options: HumanQuestionServiceOptions) {
    this.options = options;
  }

  request(sessionId: string, args: HumanQuestionRequest, signal?: AbortSignal): Promise<HumanQuestionAnswer> {
    if (this.closed) throw questionError("SESSION_EXPIRED", "Human questions are no longer available.");
    if (signal?.aborted) throw questionError("CANCELED", "The human question was canceled.");
    if (this.pending(sessionId)) throw questionError("INVALID_REQUEST", "This session already has a question awaiting a reply.");
    if (this.pendingBySession.size >= MAX_PENDING_QUESTIONS) throw questionError("INVALID_REQUEST", "Too many human questions are already pending.");

    const session = this.options.getSession(sessionId);
    const binding = sessionBinding(session);
    const question = boundedRedaction(args?.question, MAX_QUESTION_LENGTH, "question", this.options.redact);
    const rawOptions = args?.options ?? [];
    if (!Array.isArray(rawOptions) || rawOptions.length > MAX_OPTIONS) {
      throw questionError("INVALID_REQUEST", `options must contain at most ${MAX_OPTIONS} choices.`);
    }
    const options = rawOptions.map((option, index) => boundedRedaction(option, MAX_OPTION_LENGTH, `options[${index}]`, this.options.redact));
    const timeoutSeconds = args?.timeoutSeconds ?? DEFAULT_AGENT_WAIT_SECONDS;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_AGENT_WAIT_SECONDS) {
      throw questionError("INVALID_REQUEST", `timeoutSeconds must be between 1 and ${MAX_AGENT_WAIT_SECONDS}.`);
    }

    const expiresAt = Date.now() + timeoutSeconds * 1_000;
    const snapshot: HumanQuestionSnapshot = Object.freeze({
      id: randomBytes(16).toString("hex"),
      sessionId,
      question,
      options: Object.freeze(options),
      expiresAt
    });
    return new Promise<HumanQuestionAnswer>((resolve, reject) => {
      const pending: PendingQuestion = {
        snapshot,
        binding,
        resolve,
        reject,
        timer: setTimeout(() => this.finish(pending, questionError("TIMEOUT", "The human question timed out.")), timeoutSeconds * 1_000),
        ...(signal ? { signal } : {})
      };
      pending.timer.unref?.();
      this.pendingBySession.set(sessionId, pending);
      if (signal) {
        pending.onAbort = () => this.finish(pending, questionError("CANCELED", "The human question was canceled."));
        signal.addEventListener("abort", pending.onAbort, { once: true });
        if (signal.aborted) pending.onAbort();
      }
      if (this.pendingBySession.get(sessionId) === pending) {
        try { this.options.onRequest?.(snapshot); } catch { /* Notification failure cannot lose the waiting request. */ }
      }
    });
  }

  pending(sessionId: string): HumanQuestionSnapshot | null {
    const pending = this.pendingBySession.get(sessionId);
    if (!pending) return null;
    if (Date.now() >= pending.snapshot.expiresAt) {
      this.finish(pending, questionError("TIMEOUT", "The human question timed out."));
      return null;
    }
    if (!this.matchesCurrentSession(sessionId, pending.binding)) {
      this.finish(pending, questionError("SESSION_EXPIRED", "The session or turn changed before the human replied."));
      return null;
    }
    return pending.snapshot;
  }

  reply(sessionId: string, requestId: string, answer: string | number): void {
    const pending = this.pendingBySession.get(sessionId);
    if (!pending || pending.snapshot.id !== requestId) {
      throw questionError("SESSION_EXPIRED", "This human question is no longer pending.");
    }
    if (Date.now() >= pending.snapshot.expiresAt) {
      this.finish(pending, questionError("TIMEOUT", "The human question timed out."));
      throw questionError("TIMEOUT", "The human question timed out.");
    }
    if (!this.matchesCurrentSession(sessionId, pending.binding)) {
      const error = questionError("SESSION_EXPIRED", "The session or turn changed before the human replied.");
      this.finish(pending, error);
      throw error;
    }

    if (pending.snapshot.options.length > 0) {
      if (typeof answer !== "number" || !Number.isInteger(answer) || answer < 0 || answer >= pending.snapshot.options.length) {
        throw questionError("INVALID_REQUEST", "Choose one of the offered options by index.");
      }
      this.finish(pending, undefined, {
        answer: pending.snapshot.options[answer]!,
        selectedIndex: answer
      });
      return;
    }
    if (typeof answer !== "string" || answer.length > MAX_ANSWER_LENGTH) {
      throw questionError("INVALID_REQUEST", `A freeform answer must be text of at most ${MAX_ANSWER_LENGTH} characters.`);
    }
    const redacted = boundedRedaction(answer, MAX_ANSWER_LENGTH, "answer", this.options.redact, true);
    this.finish(pending, undefined, { answer: redacted });
  }

  forgetSession(sessionId: string): void {
    const pending = this.pendingBySession.get(sessionId);
    if (pending) this.finish(pending, questionError("SESSION_EXPIRED", "The session closed before the human replied."));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pendingBySession.values()) {
      this.finish(pending, questionError("SESSION_EXPIRED", "Human questions were closed."));
    }
  }

  private matchesCurrentSession(sessionId: string, binding: SessionBinding): boolean {
    const current = this.options.getSession(sessionId);
    return current !== null
      && current.provider === binding.provider
      && current.startedAt === binding.startedAt
      && current.turnEpoch === binding.turnEpoch
      && current.exitCode === null;
  }

  private finish(pending: PendingQuestion, error?: HumanQuestionError, answer?: HumanQuestionAnswer): void {
    if (this.pendingBySession.get(pending.snapshot.sessionId) !== pending) return;
    this.pendingBySession.delete(pending.snapshot.sessionId);
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    if (error) pending.reject(error);
    else pending.resolve(answer!);
  }
}

function sessionBinding(session: HumanQuestionSession | null): SessionBinding {
  if (!session || session.provider === "terminal" || session.exitCode !== null) {
    throw questionError("SESSION_EXPIRED", "Human questions are available only for a running agent session.");
  }
  if (!Number.isFinite(session.startedAt) || !Number.isSafeInteger(session.turnEpoch) || session.turnEpoch === null || session.turnEpoch <= 0) {
    throw questionError("SESSION_EXPIRED", "A current host turn is required to ask a human question.");
  }
  return { provider: session.provider, startedAt: session.startedAt, turnEpoch: session.turnEpoch };
}

function boundedRedaction(value: unknown, maximum: number, label: string, redact: (text: string) => string, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length === 0)) {
    throw questionError("INVALID_REQUEST", `${label} must be ${allowEmpty ? "text" : "nonempty text"} of at most ${maximum} characters.`);
  }
  const result = redact(value);
  if (typeof result !== "string" || result.length > maximum || (!allowEmpty && result.length === 0)) {
    throw questionError("INVALID_REQUEST", `${label} is not valid after redaction.`);
  }
  return result;
}

function questionError(code: HumanQuestionErrorCode, message: string): HumanQuestionError {
  return new HumanQuestionError(code, message);
}
