import type { MaterialKind, Point, SessionBounds, Size } from "./contracts.ts";

export const MATERIAL_SCHEME = "canvastty-material";
export const MATERIAL_LIMIT = 256;
export const MATERIAL_VERSION_LIMIT = 20;
export const MATERIAL_STORAGE_LIMIT = 1024 * 1024 * 1024;
export const MATERIAL_VERSION_MAX_BYTES = 100 * 1024 * 1024;
export const REMARK_TEXT_LIMIT = 2_000;
export const MATERIAL_MIN_SIZE: Size = { width: 220, height: 150 };
export const MATERIAL_MAX_SIZE: Size = { width: 2_400, height: 1_800 };
export const MATERIAL_HEADER_HEIGHT = 54;

const IMAGE_BOX: Size = { width: 440, height: 440 };
const GRID_GAP = 24;
const GRID_COLUMNS = 4;

const DEFAULT_SIZES: Record<MaterialKind, Size> = {
  image: { width: 420, height: 320 },
  text: { width: 520, height: 400 },
  video: { width: 560, height: 380 },
  audio: { width: 420, height: 170 },
  pdf: { width: 360, height: 230 },
  file: { width: 360, height: 230 }
};

export interface MaterialType {
  kind: MaterialKind;
  mimeType: string;
}

const IMAGE_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

const VIDEO_TYPES: Record<string, string> = {
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".ogv": "video/ogg",
  ".webm": "video/webm"
};

const AUDIO_TYPES: Record<string, string> = {
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav"
};

const TEXT_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonc": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/plain",
  ".ini": "text/plain",
  ".xml": "text/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".scss": "text/x-scss",
  ".less": "text/x-less",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".jsx": "text/javascript",
  ".ts": "text/typescript",
  ".mts": "text/typescript",
  ".cts": "text/typescript",
  ".tsx": "text/typescript",
  ".vue": "text/plain",
  ".svelte": "text/plain",
  ".astro": "text/plain",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".kt": "text/x-kotlin",
  ".swift": "text/x-swift",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cc": "text/x-c++",
  ".cpp": "text/x-c++",
  ".hpp": "text/x-c++",
  ".cs": "text/x-csharp",
  ".php": "text/x-php",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
  ".fish": "text/plain",
  ".ps1": "text/plain",
  ".sql": "text/x-sql",
  ".lua": "text/plain",
  ".dart": "text/plain",
  ".r": "text/plain",
  ".diff": "text/x-diff",
  ".patch": "text/x-diff"
};

export function materialType(name: string): MaterialType {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const extension = dot > 0 ? lower.slice(dot) : "";
  if (IMAGE_TYPES[extension]) return { kind: "image", mimeType: IMAGE_TYPES[extension] };
  return { kind: "file", mimeType: "application/octet-stream" };
}

export function materialUrl(id: string, versionId: string | null, revision = 0): string {
  const base = `${MATERIAL_SCHEME}://${encodeURIComponent(id)}/`;
  return versionId === null ? `${base}live?r=${revision}` : `${base}v/${encodeURIComponent(versionId)}`;
}

export function materialCardSize(kind: MaterialKind, natural: Size | null): Size {
  if (kind !== "image" || !natural || !(natural.width > 0) || !(natural.height > 0)) {
    return { ...DEFAULT_SIZES[kind] };
  }
  const scale = Math.min(IMAGE_BOX.width / natural.width, IMAGE_BOX.height / natural.height, 1);
  return clampSize({
    width: Math.round(natural.width * scale),
    height: Math.round(natural.height * scale) + MATERIAL_HEADER_HEIGHT
  });
}

export function materialsAtPoint(sizes: readonly Size[], point: Point): SessionBounds[] {
  const rows: number[][] = [];
  for (let start = 0; start < sizes.length; start += GRID_COLUMNS) {
    rows.push(sizes.slice(start, start + GRID_COLUMNS).map((_, offset) => start + offset));
  }
  const rowHeights = rows.map((row) => Math.max(...row.map((index) => sizes[index].height)));
  const placed: SessionBounds[] = [];
  let y = point.y;
  rows.forEach((row, rowIndex) => {
    let x = point.x;
    for (const index of row) {
      placed.push({ position: { x, y }, size: { ...sizes[index] } });
      x += sizes[index].width + GRID_GAP;
    }
    y += rowHeights[rowIndex] + GRID_GAP;
  });
  return placed;
}

export function constrainMaterialResize(bounds: SessionBounds, direction: string): SessionBounds {
  const right = bounds.position.x + bounds.size.width;
  const bottom = bounds.position.y + bounds.size.height;
  const size = clampSize(bounds.size);
  return {
    position: {
      x: direction.includes("w") ? right - size.width : bounds.position.x,
      y: direction.includes("n") ? bottom - size.height : bounds.position.y
    },
    size
  };
}

export function clampSize(size: Size): Size {
  return {
    width: Math.min(MATERIAL_MAX_SIZE.width, Math.max(MATERIAL_MIN_SIZE.width, size.width)),
    height: Math.min(MATERIAL_MAX_SIZE.height, Math.max(MATERIAL_MIN_SIZE.height, size.height))
  };
}

export function isAreaAnchor(anchor: import("./contracts.ts").RemarkAnchor): anchor is Extract<import("./contracts.ts").RemarkAnchor, { kind: "region" | "point" }> {
  return anchor.kind === "region" || anchor.kind === "point";
}
