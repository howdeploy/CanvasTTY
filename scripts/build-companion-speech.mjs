import { mkdir, readFile, writeFile, readdir, copyFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") { console.log("Bundled G2 speech is built on macOS only."); process.exit(0); }
const arch = process.env.CANVASTTY_SPEECH_ARCH || process.arch;
const artifacts = {
  arm64: ["macos-arm64-metal", "1cc5e89d442f55c165a3f90e49090cec75cec349071d834c0aa656161afa9543"],
  x64: ["macos-x86_64-cpu", "39bb982430f25dcff93e1a1b81555a6cfbd7342f780d2fd13d2e91a78afdda8a"],
};
if (!artifacts[arch]) throw new Error("Unsupported speech architecture");
const [lane, digest] = artifacts[arch], version = "0.2.3";
const output = resolve("artifacts/companion-speech", arch);
const cache = resolve("node_modules/.cache/canvastty-speech");
await mkdir(output, { recursive: true }); await mkdir(cache, { recursive: true });
const archive = join(cache, `transcribe-${version}-${lane}.tar.gz`);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
let bytes = await readFile(archive).catch(() => null);
if (!bytes || sha(bytes) !== digest) {
  const response = await fetch(`https://github.com/handy-computer/transcribe.cpp/releases/download/v${version}/transcribe-native-${version}-${lane}.tar.gz`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error("Speech runtime download failed");
  bytes = Buffer.from(await response.arrayBuffer());
  if (sha(bytes) !== digest) throw new Error("Speech runtime checksum mismatch");
  await writeFile(archive, bytes);
}
const header = await readFile("src/native/speech/vendor/transcribe.h");
if (sha(header) !== "07fff3489a3c282ab7ee8835b010f1f9f9abd5b61426f8c0e80424dabaaf9a6b") throw new Error("Pinned speech ABI header changed");
const temporary = await mkdtemp(join(tmpdir(), "canvas-speech-"));
const run = (command, args) => { const r = spawnSync(command, args, { stdio: "inherit" }); if (r.error) throw r.error; if (r.status) throw new Error(`${command} failed`); };
try {
  run("tar", ["-xzf", archive, "-C", temporary]);
  const source = join(temporary, "transcribe-native-" + lane);
  for (const file of await readdir(source)) if (file.endsWith(".dylib")) await copyFile(join(source, file), join(output, file));
  run("ditto", [join(source, "licenses"), join(output, "licenses")]);
  run("clang++", ["-std=c++17", "-O2", "-arch", arch === "x64" ? "x86_64" : "arm64", "src/native/speech/main.cpp", "-L" + output, "-ltranscribe", "-Wl,-rpath,@executable_path", "-o", join(output, "canvastty-speech")]);
  for (const file of await readdir(output)) if (file.endsWith(".dylib") || file === "canvastty-speech") run("codesign", ["--force", "--sign", "-", join(output, file)]);
  run(join(output, "canvastty-speech"), ["--version"]);
  console.log("Built bundled G2 speech for " + arch);
} finally { await rm(temporary, { recursive: true, force: true }); }
