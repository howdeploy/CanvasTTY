import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { PixelSkinPackRegistry, PIXEL_SKIN_SLOTS } from "../src/main/services/PixelSkinPackRegistry.ts";

const require = createRequire(import.meta.url);
const unzipper = require("unzipper");

async function main() {
  const archivePath = process.argv[2];
  if (!archivePath || process.argv.length !== 3) {
    throw new Error("Usage: node scripts/validate-pixel-skin-zip.mjs /absolute/path/theme-install.zip");
  }
  const archive = await readFile(archivePath);
  const directory = await unzipper.Open.buffer(archive);
  const actual = directory.files.filter((entry) => entry.type === "File")
    .map((entry) => basename(entry.path.replace(/\\/g, "/"))).sort();
  // layout.json is optional metadata; the registry validates its schema and uniqueness.
  const roles = actual.filter(filename => filename !== "layout.json").map(filename => {
    const match = /^(.*)\.(png|apng|gif|webp|mp4|webm)$/i.exec(filename);
    if (!match || (match[1].toLowerCase() !== "background" && /^(mp4|webm)$/i.test(match[2]))) return null;
    return match[1].toLowerCase();
  });
  const expected = [...PIXEL_SKIN_SLOTS].sort();
  if (roles.length !== expected.length || roles.some(role => role === null)
    || roles.sort().some((role, index) => role !== expected[index])) {
    throw new Error(`Install ZIP must contain exactly one file per role: ${expected.join(", ")}. Frames: PNG/APNG/GIF/WebP; background: also MP4/WebM.`);
  }

  const profile = await mkdtemp(join(tmpdir(), "canvastty-skin-validate-"));
  try {
    const registry = new PixelSkinPackRegistry(profile);
    await registry.initialize();
    const pack = await registry.installZip(archive, "ZIP validation");
    const manifest = JSON.parse(await readFile(join(profile, "pixel-skins", pack.id.slice("pixel:".length), "manifest.json"), "utf8"));
    if (manifest.width !== 1536 || manifest.height !== 1024) {
      throw new Error(`New theme frames must be 1536x1024; found ${manifest.width}x${manifest.height}.`);
    }
    process.stdout.write("Valid CanvasTTY install ZIP: nine PNG/APNG/GIF/WebP frames and one background, 1536x1024 frames, importer accepted.\n");
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`Invalid CanvasTTY install ZIP: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
