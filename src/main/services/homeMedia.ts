import { dirname, extname, isAbsolute } from "node:path";
import { isPathInside } from "../../agent-runtime/path-inside.mjs";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";

const MAX_HOME_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_HOME_MEDIA_PATH_LENGTH = 4_096;
const HOME_MEDIA_MIME: Record<string, string> = {
  ".png": "image/png",
  ".apng": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

/** A saved Home media path: absolute, bounded, and one of the image types Home can show. */
export function isHomeMediaPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_HOME_MEDIA_PATH_LENGTH
    && !value.includes("\0")
    && isAbsolute(value)
    && Object.hasOwn(HOME_MEDIA_MIME, extname(value).toLowerCase());
}

/**
 * Reads the Home image as a data URL. A symbolic link is followed only while
 * its target stays inside the folder the file was chosen from, and the target must
 * itself be a supported image no larger than 25 MB.
 */
export async function readHomeMedia(path: string): Promise<string> {
  if (!isHomeMediaPath(path)) throw new Error("Unsupported media type.");
  const [target, folder] = await Promise.all([realpath(path), realpath(dirname(path))]);
  if (!isPathInside(folder, target, { allowRoot: false })) {
    throw new Error("Media link points outside the chosen folder.");
  }
  const mime = HOME_MEDIA_MIME[extname(target).toLowerCase()];
  if (!mime) throw new Error("Unsupported media type.");

  // Read what was checked: the resolved file, opened without following a link
  // swapped in after the check, and sized from the open handle.
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_HOME_MEDIA_BYTES) {
      throw new Error("Media must be a file smaller than 25 MB.");
    }
    const content = await handle.readFile();
    return `data:${mime};base64,${content.toString("base64")}`;
  } finally {
    await handle.close();
  }
}
