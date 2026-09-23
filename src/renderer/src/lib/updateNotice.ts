import type { UpdateStatus } from "../../../shared/contracts";

export type UpdateNotice = Extract<UpdateStatus, { type: "available" | "downloading" | "ready" }>;

export type UpdateNoticeAction = "download" | "install" | "manual";

export function updateNoticeAction(status: UpdateNotice): UpdateNoticeAction | null {
  if (status.type === "available") return status.manualUrl ? "manual" : "download";
  return status.type === "ready" ? "install" : null;
}

export function updateNoticeKey(status: Extract<UpdateNotice, { type: "available" | "ready" }>): string {
  return `${status.type}:${status.version}`;
}

export function updateNoticeForStatus(status: UpdateStatus, dismissedKey: string | null): UpdateNotice | null {
  if (status.type === "downloading") return status;
  if (status.type !== "available" && status.type !== "ready") return null;
  return updateNoticeKey(status) === dismissedKey ? null : status;
}
