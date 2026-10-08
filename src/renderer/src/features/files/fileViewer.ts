import type { FileReadResult, FileReadUnsupportedReason } from "../../../../shared/contracts";
import { detectFileLanguage, isMarkdownPath } from "./fileLanguage.ts";

/**
 * Pure classification of a `FileReadResult` into a render model. This module
 * carries no React and performs no I/O; the card decides how to paint the
 * returned model.
 */

/** Content above this byte size falls back to plain text without rich rendering. */
export const MAX_HIGHLIGHT_BYTES = 250 * 1024;

export type FileRenderKind =
  | "markdown"
  | "code"
  | "plain"
  | "image"
  | "unsupported"
  | "too-large";

export interface FileTextViewerModel {
  kind: "text";
  renderKind: FileRenderKind;
  content: string;
  truncated: boolean;
  size: number;
  sizeLabel: string;
  language: string | null;
  highlightable: boolean;
  richDisabled: boolean;
}

export interface FileImageViewerModel {
  kind: "image";
  renderKind: FileRenderKind;
  mediaType: string;
  dataUrl: string;
  size: number;
  sizeLabel: string;
}

export interface FileUnsupportedViewerModel {
  kind: "unsupported";
  renderKind: FileRenderKind;
  reason: FileReadUnsupportedReason;
  reasonLabel: string;
}

export interface FileTooLargeViewerModel {
  kind: "too-large";
  renderKind: FileRenderKind;
  reason: "too-large";
  size: number;
  sizeLabel: string;
}

export type FileViewerModel =
  | FileTextViewerModel
  | FileImageViewerModel
  | FileUnsupportedViewerModel
  | FileTooLargeViewerModel;

/** A read result bound to the relative path it was read for. */
export interface FileReadBinding {
  relativePath: string;
  result: FileReadResult;
}

const UNSUPPORTED_REASON_LABELS: Record<FileReadUnsupportedReason, string> = {
  binary: "Binary file",
  "not-permitted": "File type not permitted",
  unavailable: "File unavailable"
};

/** Human-readable byte size; powers of 1024 with one decimal above 1 KB. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

/**
 * Resolves the render model for the active file. A read belongs only to the
 * path it was made for, so a mismatched binding returns null and the card shows
 * loading instead of the previous file's content.
 */
export function resolveActiveFileRead(
  activeFile: string | null,
  readResult: FileReadBinding | null
): FileViewerModel | null {
  if (activeFile === null || readResult === null) return null;
  if (readResult.relativePath !== activeFile) return null;
  return classifyFileRead(readResult.result, readResult.relativePath);
}

export function classifyFileRead(result: FileReadResult, relativePath = ""): FileViewerModel {
  switch (result.kind) {
    case "text": {
      const sizeLabel = formatFileSize(result.size);
      const base = {
        kind: "text" as const,
        content: result.content,
        truncated: result.truncated,
        size: result.size,
        sizeLabel
      };
      if (isMarkdownPath(relativePath)) {
        const richDisabled = result.size > MAX_HIGHLIGHT_BYTES;
        return {
          ...base,
          renderKind: richDisabled ? "plain" : "markdown",
          language: null,
          highlightable: result.size <= MAX_HIGHLIGHT_BYTES,
          richDisabled
        };
      }
      const language = detectFileLanguage(relativePath);
      if (language !== null) {
        const highlightable = result.size <= MAX_HIGHLIGHT_BYTES;
        return {
          ...base,
          renderKind: highlightable ? "code" : "plain",
          language,
          highlightable,
          richDisabled: result.size > MAX_HIGHLIGHT_BYTES
        };
      }
      return {
        ...base,
        renderKind: "plain",
        language: null,
        highlightable: true,
        richDisabled: false
      };
    }
    case "image":
      return {
        kind: "image",
        renderKind: "image",
        mediaType: result.mediaType,
        dataUrl: result.dataUrl,
        size: result.size,
        sizeLabel: formatFileSize(result.size)
      };
    case "unsupported":
      return {
        kind: "unsupported",
        renderKind: "unsupported",
        reason: result.reason,
        reasonLabel: UNSUPPORTED_REASON_LABELS[result.reason]
      };
    case "too-large":
      return {
        kind: "too-large",
        renderKind: "too-large",
        reason: "too-large",
        size: result.size,
        sizeLabel: formatFileSize(result.size)
      };
  }
}
