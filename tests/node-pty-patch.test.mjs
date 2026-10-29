import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { parse } from "yaml";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const dependencyRoot = dirname(require.resolve("node-pty/package.json"));

function spawnFunction(source) {
  const start = source.lastIndexOf("static void\npty_posix_spawn(");
  const end = source.indexOf("\n}\n#endif", start);
  assert.ok(start >= 0 && end > start, "the pinned dependency's macOS function must be present");
  return source.slice(start, end + 2);
}

test("native macOS ownership handles closed stdio and every injected syscall failure without opening PTYs", {
  skip: process.platform === "win32" ? "The macOS syscall harness uses POSIX headers; Windows runtime is unchanged." : false
}, async () => {
  const source = await readFile(join(dependencyRoot, "src", "unix", "pty.cc"), "utf8");
  const directory = await mkdtemp(join(tmpdir(), "canvastty-pty-faults-"));
  try {
    // Compile the ACTUAL patched dependency function, not a reimplementation of
    // its cleanup logic. The fixture redirects every allocating syscall to a
    // bookkeeping double, so this test is safe on an exhausted desktop.
    await writeFile(join(directory, "pty-spawn-under-test.inc"), spawnFunction(source));
    const binary = join(directory, "fd-harness");
    const compiler = spawnSync(process.env.CXX || "c++", ["-std=c++17", "-Wall", "-Wextra", "-I", directory,
      join(root, "tests", "node-pty-fd-harness.cpp"), "-o", binary], { encoding: "utf8", timeout: 60_000 });
    assert.equal(compiler.status, 0, `${compiler.error?.message || ""}\n${compiler.stdout}\n${compiler.stderr}`);
    const result = spawnSync(binary, [], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, `${result.error?.message || ""}\n${result.stdout}\n${result.stderr}`);
    const cases = result.stdout.match(/NATIVE_FD_OWNERSHIP_CASES (\d+)/u);
    assert.ok(cases, "the harness must execute its cases and report the measured count");
    assert.ok(Number(cases[1]) > 4000);
    console.log(result.stdout.trim());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the macOS exit callback releases its private kqueue before reporting exit", async () => {
  const source = await readFile(join(dependencyRoot, "src", "unix", "pty.cc"), "utf8");
  const start = source.indexOf("int kq = HANDLE_EINTR(kqueue());");
  const end = source.indexOf("#else", start);
  assert.ok(start >= 0 && end > start);
  assert.match(source.slice(start, end), /if \(kq >= 0\)\s*close\(kq\);/u);
});

test("dependency patching precedes forced source rebuilds and packaging cannot use an old prebuild", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const builder = parse(await readFile(join(root, "electron-builder.yml"), "utf8"));
  assert.equal(manifest.dependencies["node-pty"], "1.1.0");
  assert.equal(manifest.devDependencies["patch-package"], "8.0.1");
  assert.ok(manifest.scripts.postinstall.indexOf("patch-package --error-on-fail") >= 0);
  assert.ok(manifest.scripts.postinstall.indexOf("patch-package --error-on-fail") < manifest.scripts.postinstall.indexOf("electron-rebuild"));
  assert.match(manifest.scripts.postinstall, /electron-rebuild.*--build-from-source/u);
  assert.equal(builder.npmRebuild, true);
  assert.equal(builder.buildDependenciesFromSource, true);
  assert.ok(builder.asarUnpack.includes("node_modules/node-pty/**/*"));
  assert.ok(builder.files.includes("!**/node_modules/node-pty/prebuilds/darwin-*/**"));
});

test("CI preserves hidden synthetic reports but cannot upload a build after a failed safety gate", async () => {
  const workflow = parse(await readFile(join(root, ".github", "workflows", "pty-resources.yml"), "utf8"));
  const steps = workflow.jobs["native-and-packaged"].steps;
  const uploads = steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
  const reports = uploads.find((step) => step.with.name === "macos-pty-resources");
  const build = uploads.find((step) => step.with.name === "macos-pty-test-build");
  assert.equal(reports.if, "always()");
  assert.equal(reports.with["include-hidden-files"], true);
  assert.equal(reports.with.path.trim(), ".pty-results/*.json");
  assert.equal(build.if, "success()");
  assert.deepEqual(build.with.path.trim().split("\n"), ["release/*.zip", "release/*.dmg"]);
  const safetyGate = steps.findIndex((step) => step.run?.startsWith("node scripts/audit-pty-test-bundle.mjs"));
  assert.notEqual(safetyGate, -1, "the bundle safety gate must exist");
  assert.ok(safetyGate < steps.indexOf(build));
  const packageStep = steps.find((step) => step.run === "npm run package:mac");
  const builder = parse(await readFile(join(root, "electron-builder.yml"), "utf8"));
  assert.equal(packageStep.env.CSC_FOR_PULL_REQUEST, "true", "PR runs must create the ad-hoc signature instead of retaining Electron's obsolete seal");
  assert.equal(builder.mac.identity, "-", "the PR signing exception must never require a certificate");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(packageStep.env).sort(), ["CSC_FOR_PULL_REQUEST", "SPARKLE_PUBLIC_ED_KEY"], "no signing credentials are passed to an untrusted PR build");
});

test("packaged smoke uses the actual ASAR import route without doubling the native helper's unpacked path", async () => {
  // Evaluate only the real smoke's path declaration and the pinned dependency's
  // helper-path calculation; no addon, application, subprocess or PTY is loaded.
  const smoke = await readFile(join(root, "scripts", "smoke-pty-resources.mjs"), "utf8");
  const declaration = smoke.match(/const moduleRoot =[\s\S]*?;/u)?.[0];
  assert.ok(declaration, "the smoke's actual import-root declaration must be present");
  const app = resolve(tmpdir(), "isolated-ci", "CanvasTTY test.app");
  const moduleRoot = runInNewContext(`${declaration}\nmoduleRoot;`, { config: { app }, join, dirname }, { timeout: 1000 });
  const source = await readFile(join(dependencyRoot, "lib", "unixTerminal.js"), "utf8");
  const start = source.indexOf("var helperPath = native.dir");
  const end = source.indexOf("var DEFAULT_FILE", start);
  assert.ok(start >= 0 && end > start, "the pinned dependency's helper calculation must be present");
  const helper = runInNewContext(`${source.slice(start, end)}\nhelperPath;`, {
    native: { dir: "../build/Release/" }, path: { resolve }, __dirname: join(moduleRoot, "lib")
  }, { timeout: 1000 });
  assert.equal(helper, join(app, "Contents", "Resources", "app.asar.unpacked", "node_modules", "node-pty", "build", "Release", "spawn-helper"));
});
