import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { checkBundleNetwork } from "../scripts/network-policy.mjs";
import { LOCAL_DISCOVERY_ORIGINS, LOCAL_DISCOVERY_HOSTS } from "../../../src/shared/localDiscovery.ts";

const manifest = { permissions: [{ name: "network", whitelist: LOCAL_DISCOVERY_ORIGINS }] };
async function fixture(t, content) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-network-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "assets", "app.js"), content);
  return root;
}

test("rejects the exact minified template URL cited in the Even Hub rejection", async t => {
  const root = await fixture(t, 'const origins = hosts.map(e => `http://${e}:3481`);');
  assert.throws(() => checkBundleNetwork(root, manifest), /not covered[\s\S]*http:\/\/\$\{e\}:3481/);
});

test("only complete whitelisted origins are accepted, including their API paths", async t => {
  const root = await fixture(t, 'fetch("http://canvastty.local:3481/g2/discover");');
  assert.equal(checkBundleNetwork(root, manifest).urls.length, 1);
  for (const value of ["http://canvastty.local.evil.test:3481", "https://example.test", "http://user@canvastty.local:3481", "http://"]) {
    await writeFile(join(root, "assets", "app.js"), JSON.stringify(value));
    assert.throws(() => checkBundleNetwork(root, manifest), /not covered/);
  }
});

test("an absent, wildcard or non-origin manifest cannot pass the package gate", async t => {
  const root = await fixture(t, "export const value = 1;");
  for (const whitelist of [[], ["http://*"], ["http://canvastty.local:3481/path"]])
    assert.throws(() => checkBundleNetwork(root, { permissions: [{ name: "network", whitelist }] }));
});

test("source manifest, discovery names and the minified production bundle agree", async t => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const source = JSON.parse(await readFile(join(root, "app.json"), "utf8"));
  assert.deepEqual(source.permissions.find(p => p.name === "network").whitelist, LOCAL_DISCOVERY_ORIGINS);
  assert.deepEqual(LOCAL_DISCOVERY_HOSTS, LOCAL_DISCOVERY_ORIGINS.map(origin => new URL(origin).hostname));
  assert.equal(LOCAL_DISCOVERY_ORIGINS.length, 8);
  const output = await mkdtemp(join(tmpdir(), "canvastty-production-network-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  await build({
    root, logLevel: "silent",
    define: {
      "import.meta.env.VITE_CANVASTTY_LOCAL_ONLY": JSON.stringify("true"),
      "import.meta.env.VITE_CANVASTTY_BRIDGE_ORIGIN": JSON.stringify(""),
    },
    build: { outDir: output, emptyOutDir: true },
  });
  const result = checkBundleNetwork(output, source);
  assert.deepEqual(result.urls, [...LOCAL_DISCOVERY_ORIGINS].sort());
});
