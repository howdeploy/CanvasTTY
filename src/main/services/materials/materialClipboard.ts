import { isAbsolute, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { MaterialFailure, MaterialRejectionReason } from "../../../shared/contracts.ts";
import { MATERIAL_LIMIT } from "../../../shared/materials.ts";

export const CLIPBOARD_TEXT_PATH_LIMIT = 16;

export function plistPaths(xml: string): string[] {
  return listedPaths([...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => decodeXml(match[1])));
}

export function fileUrlPaths(text: string): string[] {
  return listedPaths(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("file://")).flatMap((line) => {
    try {
      return [fileURLToPath(line)];
    } catch {
      return [];
    }
  }));
}

export function windowsFileNames(buffer: Buffer): string[] {
  return listedPaths(buffer.toString("utf16le").split("\0"), win32.isAbsolute);
}

export function textPaths(text: string, platform: NodeJS.Platform): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > CLIPBOARD_TEXT_PATH_LIMIT) return [];
  const absolute = platform === "win32" ? win32.isAbsolute : posix.isAbsolute;
  return lines.every((line) => absolute(line) && !line.includes("\0") && !isRemote(line, platform)) ? lines : [];
}

function listedPaths(paths: readonly string[], absolute = isAbsolute): string[] {
  return paths.filter((path) => path.length > 0 && absolute(path) && !path.includes("\0")).slice(0, MATERIAL_LIMIT);
}

function isRemote(path: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return /^[\\/]{2}/.test(path);
  return platform === "darwin" && /^\/(?:net|Network)\//.test(path);
}

export function captureRejection(reason: MaterialFailure): MaterialRejectionReason {
  if (reason === "material-limit") return "limit";
  if (reason === "quota" || reason === "too-large") return reason;
  return "unreadable";
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
