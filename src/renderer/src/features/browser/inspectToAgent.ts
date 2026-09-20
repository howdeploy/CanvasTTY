import type {
  BrowserElementBounds,
  BrowserElementRef,
  BrowserObservedElement,
  SessionSnapshot
} from "../../../../shared/contracts";

/**
 * The only bound on observed elements: the panel requests this many and lists
 * every element it gets back, so nothing is fetched and then unreachable.
 */
export const INSPECT_ELEMENT_LIMIT = 20;

export interface InspectPayload {
  url: string;
  label: string;
  ref: BrowserElementRef;
  bounds: BrowserElementBounds | null;
}

export interface InspectLiveTarget {
  tabId: string;
  documentRevision: number;
}

export function inspectPayloadFor(element: BrowserObservedElement, url: string): InspectPayload {
  return {
    url,
    label: element.name || element.role || element.ref.ref,
    ref: element.ref,
    bounds: element.bounds
  };
}

/**
 * Newest session that can actually receive a typed line. Terminals have no
 * prompt to submit into, an exited session has nothing listening, and a session
 * asking the user for a decision is showing a prompt whose highlighted answer
 * the line's carriage return would activate on the user's behalf.
 */
export function inspectAgentSessionId(sessions: readonly SessionSnapshot[]): string | null {
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index];
    if (
      session.provider !== "terminal"
      && session.exitCode === null
      && session.status !== "needs_approval"
    ) return session.id;
  }
  return null;
}

/**
 * True when the only reason no session is eligible is that a running agent session
 * is waiting for a decision. The panel reports that distinctly from "no session at
 * all", because the user has to answer the prompt before a handoff is possible.
 */
export function inspectAgentAwaitsApproval(sessions: readonly SessionSnapshot[]): boolean {
  return inspectAgentSessionId(sessions) === null
    && sessions.some((session) => session.provider !== "terminal"
      && session.exitCode === null
      && session.status === "needs_approval");
}

/**
 * An element reference only stays valid while its tab keeps the observed document
 * revision; after an in-page mutation or navigation the node may belong to another element.
 */
export function inspectRefIsStale(payload: InspectPayload, live: InspectLiveTarget | null): boolean {
  if (live === null) return true;
  return payload.ref.tabId !== live.tabId || payload.ref.documentRevision !== live.documentRevision;
}

/**
 * The same policy the main process applies to agent-facing results
 * (safeAgentUrl in src/main/services/browser/BrowserCore.ts): credentials, query
 * and fragment never reach an agent, because provider-specific query names carry
 * signed URLs, SAML responses and tickets. Anything that is not http(s), or does
 * not parse, becomes "" instead of leaking.
 */
export function inspectSafeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

/**
 * One structured line for the agent session. The PTY only submits on a carriage
 * return. The line opens with CanvasTTY's own header and then names the
 * page-authored label: it is flattened and JSON-quoted, so page text cannot
 * close its field, append a forged tail that reads as this header, or start a
 * second line.
 */
export function inspectAgentLine(payload: InspectPayload): string {
  const bounds = payload.bounds
    ? `${Math.round(payload.bounds.x)},${Math.round(payload.bounds.y)} ${Math.round(payload.bounds.width)}x${Math.round(payload.bounds.height)}`
    : "unknown";
  const url = inspectSafeUrl(payload.url);
  const label = JSON.stringify(payload.label.replace(/[\r\n]+/g, " ").trim());
  const line = `[Browser inspect] ${url === "" ? "url=none" : url} untrustedWebContent=true label=${label} ref=${payload.ref.ref} bounds=${bounds} documentRevision=${payload.ref.documentRevision}`;
  return `${line.replace(/[\r\n]+/g, " ").trim()}\r`;
}
