import type { Size } from "../../../shared/contracts.ts";

export const IMAGE_HEADER_BYTES = 512 * 1024;

export function imageDimensions(bytes: Uint8Array): Size | null {
  if (bytes.length < 12) return null;
  if (matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return bytes.length >= 24 ? positive(readUint32BE(bytes, 16), readUint32BE(bytes, 20)) : null;
  }
  if (ascii(bytes, 0, 4) === "GIF8") return positive(readUint16LE(bytes, 6), readUint16LE(bytes, 8));
  if (ascii(bytes, 0, 2) === "BM") return bmpDimensions(bytes);
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webpDimensions(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegDimensions(bytes);
  return null;
}

function bmpDimensions(bytes: Uint8Array): Size | null {
  if (bytes.length < 26) return null;
  const headerSize = readUint32LE(bytes, 14);
  if (headerSize === 12) return positive(readUint16LE(bytes, 18), readUint16LE(bytes, 20));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return positive(Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true)));
}

function webpDimensions(bytes: Uint8Array): Size | null {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 " && bytes.length >= 30) {
    return positive(readUint16LE(bytes, 26) & 0x3fff, readUint16LE(bytes, 28) & 0x3fff);
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = readUint32LE(bytes, 21);
    return positive((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X" && bytes.length >= 30) {
    return positive(readUint24LE(bytes, 24) + 1, readUint24LE(bytes, 27) + 1);
  }
  return null;
}

function jpegDimensions(bytes: Uint8Array): Size | null {
  let offset = 2;
  let orientation = 1;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = readUint16BE(bytes, offset + 2);
    if (length < 2) return null;
    if (marker === 0xe1) orientation = exifOrientation(bytes, offset + 4, length - 2) ?? orientation;
    if (isStartOfFrame(marker) && offset + 9 <= bytes.length) {
      const height = readUint16BE(bytes, offset + 5);
      const width = readUint16BE(bytes, offset + 7);
      return orientation >= 5 && orientation <= 8 ? positive(height, width) : positive(width, height);
    }
    offset += 2 + length;
  }
  return null;
}

function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function exifOrientation(bytes: Uint8Array, start: number, length: number): number | null {
  const end = Math.min(bytes.length, start + length);
  if (end - start < 14 || ascii(bytes, start, 4) !== "Exif") return null;
  const tiff = start + 6;
  const order = ascii(bytes, tiff, 2);
  if (order !== "II" && order !== "MM") return null;
  const little = order === "II";
  const read16 = (at: number): number => (little ? readUint16LE(bytes, at) : readUint16BE(bytes, at));
  const read32 = (at: number): number => (little ? readUint32LE(bytes, at) : readUint32BE(bytes, at));
  const directory = tiff + read32(tiff + 4);
  if (directory + 2 > end) return null;
  const entries = read16(directory);
  for (let index = 0; index < entries; index += 1) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > end) return null;
    if (read16(entry) === 0x0112) {
      const value = read16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

function positive(width: number, height: number): Size | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return readUint16LE(bytes, offset) | ((bytes[offset + 2] ?? 0) << 16);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (readUint16LE(bytes, offset) | (readUint16LE(bytes, offset + 2) << 16)) >>> 0;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((readUint16BE(bytes, offset) << 16) | readUint16BE(bytes, offset + 2)) >>> 0;
}
