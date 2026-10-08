import type { CanvasTTYApi } from "../../../../shared/contracts";
import type { BacklogApi } from "../../../../shared/backlog";

export type BacklogTerminalApi = Pick<CanvasTTYApi["terminal"], "describeFileDrop" | "paste" | "input" | "searchOutput" | "readOutputContext" | "setBounds">;
export type BacklogTask = Awaited<ReturnType<BacklogApi["tasks"]>>["tasks"][number];

export function backlogApi(): BacklogApi {
  return window.canvasTTY.backlog;
}

export function backlogTerminalApi(): BacklogTerminalApi {
  return window.canvasTTY.terminal;
}
