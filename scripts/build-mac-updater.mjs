import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const version = "2.10.0";
const digest = "c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c";
const destination = resolve("artifacts/sparkle");
const archive = join(destination, `Sparkle-${version}.tar.xz`);
const distribution = join(destination, "distribution");
await mkdir(destination, { recursive: true });
if (process.env.CANVASTTY_SPARKLE_ARCHIVE) {
  await copyFile(process.env.CANVASTTY_SPARKLE_ARCHIVE, archive);
} else {
  execFileSync("curl", ["-L", "--fail", "--silent", "--show-error", "--max-time", "180", "-o", archive,
    `https://github.com/sparkle-project/Sparkle/releases/download/${version}/Sparkle-${version}.tar.xz`], { stdio: "inherit" });
}
const actual = createHash("sha256").update(await readFile(archive)).digest("hex");
if (actual !== digest) throw new Error("Sparkle distribution checksum mismatch");
await mkdir(distribution, { recursive: true });
execFileSync("tar", ["-xf", archive, "-C", distribution, "./Sparkle.framework", "./bin/generate_appcast", "./bin/generate_keys"], { stdio: "inherit" });
await rm(join(destination, "Sparkle.framework"), { recursive: true, force: true });
execFileSync("ditto", [join(distribution, "Sparkle.framework"), join(destination, "Sparkle.framework")], { stdio: "inherit" });
execFileSync("clang", ["-fobjc-arc", "-fblocks", "-mmacosx-version-min=12.0", "-F", distribution,
  "-framework", "Cocoa", "-framework", "Sparkle", "-Wl,-rpath,@executable_path/../Frameworks",
  "-o", join(destination, "canvastty-update-helper"), "src/native/updates/mac-sparkle-helper.m"], { stdio: "inherit" });
