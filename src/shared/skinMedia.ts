export type SkinMediaFormat = "png" | "webp" | "gif" | "mp4" | "webm";
export interface SkinMediaInfo { format: SkinMediaFormat; animated: boolean; width?: number; height?: number }
export const SKIN_MEDIA_MIME: Record<SkinMediaFormat, string> = {
  gif: "image/gif", png: "image/png", webp: "image/webp", mp4: "video/mp4", webm: "video/webm"
};
const text = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length));

/** Inspect local media only; decoding is still performed by Chromium. Never trust an extension. */
export function inspectSkinMedia(bytes: Uint8Array): SkinMediaInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 14 && ["GIF87a", "GIF89a"].includes(text(bytes, 0, 6))) {
    const width = view.getUint16(6, true), height = view.getUint16(8, true);
    if (!width || !height) throw new Error("GIF dimensions are invalid.");
    let offset = 13 + ((bytes[10] & 128) ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0), frames = 0;
    const blocks = (): void => {
      while (offset < bytes.length) {
        const size = bytes[offset++];
        if (!size) return;
        offset += size;
        if (offset > bytes.length) break;
      }
      throw new Error("GIF blocks are incomplete.");
    };
    while (offset < bytes.length) {
      const marker = bytes[offset++];
      if (marker === 0x3b) {
        if (!frames || offset !== bytes.length) throw new Error("GIF image is invalid.");
        return { format: "gif", animated: frames > 1, width, height };
      }
      if (marker === 0x21) { if (offset >= bytes.length) break; offset++; blocks(); }
      else if (marker === 0x2c) {
        if (offset + 9 > bytes.length) break;
        const packed = bytes[offset + 8];
        const x = view.getUint16(offset, true), y = view.getUint16(offset + 2, true);
        const w = view.getUint16(offset + 4, true), h = view.getUint16(offset + 6, true);
        if (!w || !h || x + w > width || y + h > height) throw new Error("GIF frame bounds are invalid.");
        offset += 9 + ((packed & 128) ? 3 * (1 << ((packed & 7) + 1)) : 0);
        if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) break;
        offset++; blocks(); frames++;
      } else throw new Error("GIF block is invalid.");
    }
    throw new Error("GIF image is incomplete.");
  }
  if (bytes.length >= 33 && bytes[0] === 137 && text(bytes, 1, 7) === "PNG\r\n\x1a\n") {
    let animated = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      if (offset + length + 12 > bytes.length) throw new Error("PNG chunks are malformed.");
      if (text(bytes, offset + 4, 4) === "acTL") animated = true;
      offset += length + 12;
    }
    return { format: "png", animated, width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 20 && text(bytes, 0, 4) === "RIFF" && text(bytes, 8, 4) === "WEBP") {
    if (view.getUint32(4, true) + 8 !== bytes.length) throw new Error("WebP size is invalid.");
    let width = 0, height = 0, animated = false, image = false;
    let offset = 12;
    for (; offset + 8 <= bytes.length;) {
      const kind = text(bytes, offset, 4);
      const length = view.getUint32(offset + 4, true);
      const data = offset + 8;
      if (data + length + (length % 2) > bytes.length) throw new Error("WebP chunks are malformed.");
      if (kind === "VP8X" && length === 10) {
        animated = Boolean(bytes[data] & 2);
        width = 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16);
        height = 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16);
      } else if (kind === "VP8 " && length >= 10) {
        if (text(bytes, data + 3, 3) !== "\x9d\x01\x2a") throw new Error("WebP frame is invalid.");
        if (!width) { width = view.getUint16(data + 6, true) & 0x3fff; height = view.getUint16(data + 8, true) & 0x3fff; }
        image = true;
      } else if (kind === "VP8L" && length >= 5 && bytes[data] === 47) {
        const bits = view.getUint32(data + 1, true);
        if (!width) { width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff); }
        image = true;
      } else if (kind === "ANMF" && length > 16) image = true;
      offset = data + length + (length % 2);
    }
    if (offset !== bytes.length || !image || !width || !height) throw new Error("WebP image is incomplete.");
    return { format: "webp", animated, width, height };
  }
  if (bytes.length >= 24 && text(bytes, 4, 4) === "ftyp") {
    const kinds = new Set<string>();
    let offset = 0;
    while (offset + 8 <= bytes.length) {
      let size = view.getUint32(offset);
      if (size === 1) {
        if (offset + 16 > bytes.length) throw new Error("MP4 box is incomplete.");
        const large = view.getBigUint64(offset + 8);
        if (large > BigInt(bytes.length)) throw new Error("MP4 box is too large.");
        size = Number(large);
        if (size < 16) throw new Error("MP4 box is invalid.");
      } else if (size === 0) size = bytes.length - offset;
      if (size < 8 || offset + size > bytes.length) throw new Error("MP4 box is invalid.");
      kinds.add(text(bytes, offset + 4, 4));
      offset += size;
    }
    if (offset !== bytes.length || !kinds.has("moov") || !kinds.has("mdat")) throw new Error("MP4 video is incomplete.");
    return { format: "mp4", animated: true };
  }
  if (bytes.length >= 32 && view.getUint32(0) === 0x1a45dfa3) {
    const sizeAt = (offset: number): { length: number; value: number | null } => {
      if (offset >= bytes.length) throw new Error("WebM element is incomplete.");
      let length = 1, mask = 0x80;
      while (length <= 8 && !(bytes[offset] & mask)) { mask >>= 1; length += 1; }
      if (length > 8 || offset + length > bytes.length) throw new Error("WebM element size is invalid.");
      let value = BigInt(bytes[offset] & (mask - 1));
      for (let i = 1; i < length; i++) value = (value << 8n) | BigInt(bytes[offset + i]);
      if (value === (1n << BigInt(7 * length)) - 1n) return { length, value: null };
      if (value > BigInt(bytes.length)) throw new Error("WebM element exceeds the file size.");
      return { length, value: Number(value) };
    };
    const header = sizeAt(4);
    if (header.value === null || header.value > 4096) throw new Error("WebM header size is invalid.");
    const headerEnd = 4 + header.length + header.value;
    if (headerEnd + 5 > bytes.length || !text(bytes, 4 + header.length, header.value).includes("webm")
      || view.getUint32(headerEnd) !== 0x18538067) throw new Error("WebM segment is missing.");
    const segment = sizeAt(headerEnd + 4);
    let offset = headerEnd + 4 + segment.length;
    const end = segment.value === null ? bytes.length : offset + segment.value;
    if (end > bytes.length) throw new Error("WebM segment is incomplete.");
    let tracks = false, cluster = false;
    while (offset < end) {
      let idLength = 1, mask = 0x80;
      while (idLength <= 4 && !(bytes[offset] & mask)) { mask >>= 1; idLength += 1; }
      if (idLength > 4 || offset + idLength >= end) throw new Error("WebM element ID is invalid.");
      const id = text(bytes, offset, idLength);
      const size = sizeAt(offset + idLength);
      offset += idLength + size.length;
      if (id === "\x16\x54\xae\x6b") tracks = true;
      if (id === "\x1f\x43\xb6\x75") cluster = offset < end;
      if (size.value === null) { if (!cluster) throw new Error("WebM element size is unknown."); offset = end; }
      else offset += size.value;
      if (offset > end) throw new Error("WebM element is incomplete.");
    }
    if (!tracks || !cluster) throw new Error("WebM tracks or video data are missing.");
    return { format: "webm", animated: true };
  }
  throw new Error("Choose PNG/APNG, GIF, WebP, or MP4/WebM.");
}
