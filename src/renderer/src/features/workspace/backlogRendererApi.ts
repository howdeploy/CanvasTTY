import type { BacklogApi } from "../../../../shared/backlog";
export type BacklogTask = Awaited<ReturnType<BacklogApi["tasks"]>>["tasks"][number];
export function backlogApi(): BacklogApi { return window.canvasTTY.backlog; }
