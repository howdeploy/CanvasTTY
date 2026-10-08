import assert from "node:assert/strict";
import test from "node:test";
import { imageDimensions } from "../src/main/services/materials/imageDimensions.ts";

function png(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function gif(width, height) {
  const bytes = Buffer.alloc(16);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function bmp(width, height) {
  const bytes = Buffer.alloc(54);
  bytes.write("BM", 0, "ascii");
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  return bytes;
}

function webp(chunk, body) {
  const bytes = Buffer.alloc(40);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WEBP", 8, "ascii");
  bytes.write(chunk, 12, "ascii");
  body(bytes);
  return bytes;
}

function jpeg(width, height, orientation = null) {
  const segments = [Buffer.from([0xff, 0xd8])];
  if (orientation !== null) {
    const tiff = Buffer.alloc(26);
    tiff.write("II", 0, "ascii");
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x0112, 10);
    tiff.writeUInt16LE(3, 12);
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(orientation, 18);
    const payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
    const header = Buffer.alloc(4);
    header.writeUInt16BE(0xffe1, 0);
    header.writeUInt16BE(payload.length + 2, 2);
    segments.push(header, payload);
  }
  const frame = Buffer.alloc(19);
  frame.writeUInt16BE(0xffc0, 0);
  frame.writeUInt16BE(17, 2);
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  segments.push(frame);
  return Buffer.concat(segments);
}

test("reads PNG, GIF and BMP headers", () => {
  assert.deepEqual(imageDimensions(png(1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(imageDimensions(gif(64, 32)), { width: 64, height: 32 });
  assert.deepEqual(imageDimensions(bmp(300, -200)), { width: 300, height: 200 });
});

test("reads the three WebP encodings", () => {
  const lossy = webp("VP8 ", (bytes) => {
    bytes.writeUInt16LE(640, 26);
    bytes.writeUInt16LE(480, 28);
  });
  const lossless = webp("VP8L", (bytes) => {
    bytes.writeUInt32LE((800 - 1) | ((600 - 1) << 14), 21);
  });
  const extended = webp("VP8X", (bytes) => {
    bytes.writeUIntLE(1920 - 1, 24, 3);
    bytes.writeUIntLE(1080 - 1, 27, 3);
  });
  assert.deepEqual(imageDimensions(lossy), { width: 640, height: 480 });
  assert.deepEqual(imageDimensions(lossless), { width: 800, height: 600 });
  assert.deepEqual(imageDimensions(extended), { width: 1920, height: 1080 });
});

test("JPEG dimensions follow the EXIF orientation the viewer applies", () => {
  assert.deepEqual(imageDimensions(jpeg(4032, 3024)), { width: 4032, height: 3024 });
  assert.deepEqual(imageDimensions(jpeg(4032, 3024, 1)), { width: 4032, height: 3024 });
  assert.deepEqual(imageDimensions(jpeg(4032, 3024, 6)), { width: 3024, height: 4032 });
});

test("unknown, truncated and zero-sized headers give no size", () => {
  assert.equal(imageDimensions(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  assert.equal(imageDimensions(png(1280, 720).subarray(0, 20)), null);
  assert.equal(imageDimensions(png(0, 720)), null);
  assert.equal(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0])), null);
});
