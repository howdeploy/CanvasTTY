import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";

export async function streamFile(
  request: Request,
  path: string,
  mimeType: string,
  extraHeaders: Readonly<Record<string, string>> = {}
): Promise<Response> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let streaming = false;
  try {
    return await respond(request, handle, mimeType, extraHeaders, () => {
      streaming = true;
    });
  } finally {
    if (!streaming) await handle.close().catch(() => undefined);
  }
}

async function respond(
  request: Request,
  handle: FileHandle,
  mimeType: string,
  extraHeaders: Readonly<Record<string, string>>,
  streaming: () => void
): Promise<Response> {
  const metadata = await handle.stat();
  if (!metadata.isFile()) throw new Error("Not a regular file.");
  if (metadata.size === 0) {
    return new Response(null, {
      status: 200,
      headers: {
        ...extraHeaders,
        "accept-ranges": "bytes",
        "cache-control": "no-store",
        "content-length": "0",
        "content-type": mimeType
      }
    });
  }
  const range = parseRange(request.headers.get("range"), metadata.size);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${metadata.size}` } });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? metadata.size - 1;
  const headers = new Headers({
    ...extraHeaders,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-length": String(Math.max(0, end - start + 1)),
    "content-type": mimeType
  });
  if (range) headers.set("content-range", `bytes ${start}-${end}/${metadata.size}`);
  if (request.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
  const stream = Readable.toWeb(handle.createReadStream({ start, end, autoClose: true })) as ReadableStream<Uint8Array>;
  streaming();
  return new Response(stream, { status: range ? 206 : 200, headers });
}

export function textResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
  });
}

function parseRange(value: string | null, size: number): { start: number; end: number } | "invalid" | null {
  if (!value) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === "" && match[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}
