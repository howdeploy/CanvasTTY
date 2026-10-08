import type {
  CanvasMaterial,
  LocaleId,
  MaterialFailure,
  MaterialKind,
  MaterialRejectionReason,
  MaterialsAddResult
} from "../../../../shared/contracts.ts";
import { t } from "../../lib/i18n.ts";

export type MaterialIconName = "image" | "file-text" | "film" | "music" | "file";

export type MaterialCommand = "pin" | "reveal" | "copy-path" | "relink" | "accept-move";

const KIND_ICONS: Record<MaterialKind, MaterialIconName> = {
  image: "image",
  text: "file-text",
  video: "film",
  audio: "music",
  pdf: "file-text",
  file: "file"
};

export function materialIcon(kind: MaterialKind): MaterialIconName {
  return KIND_ICONS[kind];
}

export function materialSubtitle(material: CanvasMaterial, locale: LocaleId): string {
  const origin = material.origin;
  if (!origin) return materialFolder(material.location) ?? "";
  switch (origin.kind) {
    case "clipboard": return t(locale, "materialFromClipboard");
    case "browser": return origin.url;
    default: return materialFolder(material.location) ?? "";
  }
}

export function materialFolder(location: string | null): string | null {
  if (!location) return null;
  const separator = Math.max(location.lastIndexOf("/"), location.lastIndexOf("\\"));
  return separator > 0 ? location.slice(0, separator) : location;
}

export function formatBytes(bytes: number | null, locale: LocaleId): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "";
  const units = locale === "ru" ? ["Б", "КБ", "МБ", "ГБ"] : ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits).replace(".", locale === "ru" ? "," : ".")} ${units[unit]}`;
}

export function latestVersionNumber(material: CanvasMaterial): number | null {
  return material.versions.at(-1)?.number ?? null;
}

export type MaterialFailureKey =
  | "materialFailureUnavailable"
  | "materialFailureTooLarge"
  | "materialFailureQuota"
  | "materialFailureUnreadable"
  | "materialFailureNotAFile"
  | "materialFailureKindMismatch"
  | "materialFailureAlreadyOnCanvas"
  | "materialFailureVersionLimit"
  | "materialFailureMaterialLimit"
  | "materialFailureRemarkLimit";

export function materialFailureKey(reason: MaterialFailure): MaterialFailureKey | null {
  switch (reason) {
    case "unavailable": return "materialFailureUnavailable";
    case "too-large": return "materialFailureTooLarge";
    case "quota": return "materialFailureQuota";
    case "unreadable": return "materialFailureUnreadable";
    case "not-a-file": return "materialFailureNotAFile";
    case "kind-mismatch": return "materialFailureKindMismatch";
    case "already-on-canvas": return "materialFailureAlreadyOnCanvas";
    case "version-limit": return "materialFailureVersionLimit";
    case "material-limit": return "materialFailureMaterialLimit";
    case "remark-limit": return "materialFailureRemarkLimit";
    default: return null;
  }
}

export type MaterialRejectionKey = "materialsNotAFile" | "materialsUnreadable" | "materialsLimit" | "materialsQuota" | "materialsTooLarge" | "materialsEmptyClipboard";

export function materialRejectionKey(reason: MaterialRejectionReason): MaterialRejectionKey {
  switch (reason) {
    case "not-a-file": return "materialsNotAFile";
    case "limit": return "materialsLimit";
    case "quota": return "materialsQuota";
    case "too-large": return "materialsTooLarge";
    case "empty-clipboard": return "materialsEmptyClipboard";
    default: return "materialsUnreadable";
  }
}

export function remarkDrawable(material: CanvasMaterial): boolean {
  return material.state === "ready" && (material.kind === "image" || material.kind === "file");
}

export function remarkPickable(material: CanvasMaterial): boolean {
  return remarkDrawable(material);
}

export function materialWidgetAttributes(): Record<string, string | undefined> {
  return {};
}

export function materialRemovalLosesData(material: CanvasMaterial): boolean {
  return material.location === null || material.versions.length > 0;
}

export function addResultNeedsNotice(result: MaterialsAddResult): boolean {
  return result.rejected.length > 0 || (result.added.length === 0 && result.existing.length > 0);
}
