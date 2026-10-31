import { promisify } from "node:util";
import { gzip, gunzip, constants } from "node:zlib";

const compress = promisify(gzip);
const expand = promisify(gunzip);

/**
 * Large Mac histories remain one atomic snapshot, including collector cursors.
 * Compression runs off the main JS thread and does not defer any collection's save.
 * Small histories retain the v2 envelope without compression overhead.
 */
export async function encodeMacHistorySnapshot(text: string): Promise<{ encoding: "gzip-base64"; data: string } | null> {
  if (Buffer.byteLength(text) < 1024 * 1024) return null;
  const body = await compress(text, { level: constants.Z_BEST_SPEED });
  return { encoding: "gzip-base64", data: body.toString("base64") };
}

export async function decodeMacHistorySnapshot(value: Record<string, unknown>): Promise<string> {
  if (value.encoding !== "gzip-base64" || typeof value.data !== "string") throw new Error("Invalid compressed history envelope");
  return (await expand(Buffer.from(value.data, "base64"))).toString("utf8");
}
