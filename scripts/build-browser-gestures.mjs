import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin") {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const require = createRequire(import.meta.url);
  const targetArch = process.argv.find((arg) => arg.startsWith("--arch="))?.slice(7) ?? process.arch;
  if (!["arm64", "x64"].includes(targetArch)) throw new Error(`Unsupported macOS architecture: ${targetArch}`);
  const nativeRoot = join(root, "native/mac-browser-gestures");
  const result = spawnSync(process.execPath, [require.resolve("node-gyp/bin/node-gyp.js"), "rebuild",
    "--directory", nativeRoot, `--target=${manifest.devDependencies.electron}`, `--arch=${targetArch}`,
    "--dist-url=https://electronjs.org/headers"], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const destination = join(root, "build/browser-gestures", `darwin-${targetArch}`);
  await mkdir(destination, { recursive: true });
  const staging = join(destination, `browser-gestures-${process.pid}.node`);
  try {
    await copyFile(join(nativeRoot, "build/Release/browser-gestures.node"), staging);
    await rename(staging, join(destination, "browser-gestures.node"));
  } finally {
    await rm(staging, { force: true });
  }
}
