import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { LOCAL_DISCOVERY_ORIGINS } from "../../../src/shared/localDiscovery.ts";
import { buildOrigin } from "./origin.mjs";
import { checkBundleNetwork } from "./network-policy.mjs";

const require = createRequire(import.meta.url);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixed = process.argv.includes("--fixed-origin");
const origin = fixed
  ? buildOrigin(process.env.CANVASTTY_BRIDGE_ORIGIN, {
      localDevelopment: process.argv.includes("--local-development"),
    })
  : "";
const manifest = JSON.parse(readFileSync(join(root, "app.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
manifest.version = pkg.version;
manifest.permissions = manifest.permissions.map((permission) =>
  permission.name === "network"
    ? { ...permission, whitelist: fixed ? [origin] : LOCAL_DISCOVERY_ORIGINS }
    : permission,
);
const temporary = mkdtempSync(join(tmpdir(), "canvastty-even-manifest-"));
const output = join(root, "release", `canvastty-even-g2-${pkg.version}.ehpk`);
function run(script, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Build step failed (${result.status}).`);
}
try {
  const path = join(temporary, "app.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  const webOutput = join(temporary, "web");
  run(
    join(dirname(require.resolve("vite/package.json")), "bin/vite.js"),
    ["build", "--outDir", webOutput],
    {
      VITE_CANVASTTY_BRIDGE_ORIGIN: origin,
      VITE_CANVASTTY_LOCAL_ONLY: fixed ? "false" : "true",
    },
  );
  const networkCheck = checkBundleNetwork(webOutput, manifest);
  mkdirSync(join(root, "release"), { recursive: true });
  run(require.resolve("@evenrealities/evenhub-cli/main.js"), [
    "pack",
    path,
    webOutput,
    "--sdk-ver",
    "0.0.14",
    "-o",
    output,
  ]);
  writeFileSync(output + ".network-check.json", JSON.stringify(networkCheck, null, 2) + "\n");
  console.log(
    `Built ${output} for ${origin || "local computers paired with six digits"}`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
