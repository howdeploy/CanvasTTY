import type { BacklogApi } from "../../../../shared/backlog";
import type { BacklogTerminalApi } from "./backlogRendererApi";

export const MAX_CONTEXT_PREVIEW_CHARS = 16_000;
const TRUNCATION_MARKER = "\n\n[CanvasTTY: preview truncated; edit or shorten before sending.]";

export interface WorkspaceDropPayload {
  files: File[];
  text: string;
  url: string;
}

export interface WorkspaceContextPreview {
  sessionId: string;
  text: string;
  paths: string[];
  outsideProject: string[];
  truncated: boolean;
}

export async function prepareWorkspaceContextPreview(
  sessionId: string,
  payload: WorkspaceDropPayload,
  api: BacklogApi,
  terminal: BacklogTerminalApi
): Promise<WorkspaceContextPreview> {
  let text: string;
  let paths: string[] = [];
  let outsideProject: string[] = [];
  if (payload.files.length > 0) {
    const described = await terminal.describeFileDrop(payload.files, sessionId);
    text = described.text;
    paths = described.paths;
    outsideProject = described.outsideProject;
  } else if (payload.url.trim()) {
    text = payload.url.trim();
  } else {
    text = payload.text;
  }
  const masked = await api.redactText(text);
  const result = truncateContextPreview(masked);
  return { sessionId, text: result.text, paths, outsideProject, truncated: result.truncated };
}

export function truncateContextPreview(text: string, limit = MAX_CONTEXT_PREVIEW_CHARS): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const headLength = Math.max(0, limit - TRUNCATION_MARKER.length);
  return { text: `${text.slice(0, headLength)}${TRUNCATION_MARKER}`, truncated: true };
}
