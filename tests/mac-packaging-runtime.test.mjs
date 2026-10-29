import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createYargs, configureBuildCommand, normalizeOptions } = require("electron-builder/out/builder.js");
const { getConfig } = require("app-builder-lib/out/util/config/config.js");
const { getElectronVersion } = require("app-builder-lib/out/electron/electronVersion.js");
const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

function packagingOptions(script) {
  const [command, ...args] = script.split("&&").at(-1).trim().split(/\s+/);
  assert.equal(command, "electron-builder");
  // Use the installed CLI parser and config merge without invoking a build, download or rebuild.
  return normalizeOptions(configureBuildCommand(createYargs()).exitProcess(false).parseSync(args));
}

test("macOS packaging selects the Electron runtime patched for GHSA-jr5w-w6x2-84p9", async () => {
  // Electron 43.8.1 is the first patched 43.x release:
  // https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9
  const options = packagingOptions(manifest.scripts["package:mac"]);
  const config = await getConfig(root, null, options.config);
  assert.deepEqual([...options.targets.keys()].map(platform => platform.name), ["mac"]);
  assert.equal(await getElectronVersion(root, config), "43.8.1");
});

test("the macOS runtime override does not change Windows or Linux packaging", async () => {
  for (const platform of ["win", "linux"]) {
    const options = packagingOptions(manifest.scripts[`package:${platform}`]);
    const config = await getConfig(root, null, options.config);
    assert.equal(options.config?.electronVersion, undefined, `${platform} must not inherit the macOS override`);
    assert.equal(await getElectronVersion(root, config), manifest.devDependencies.electron);
  }
});
