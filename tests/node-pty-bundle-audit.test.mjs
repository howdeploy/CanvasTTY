import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import asar from "@electron/asar";
import { auditPtyTestBundle, textIssues } from "../scripts/audit-pty-test-bundle.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-payload-audit-"));
  try {
    const input = join(root, "input");
    const app = join(root, "Test.app");
    const resources = join(app, "Contents", "Resources");
    await mkdir(join(input, "out"), { recursive: true });
    await mkdir(resources, { recursive: true });
    await writeFile(join(input, "out", "index.js"), "export const fixture = true;\n");
    await writeFile(join(input, "package.json"), '{"name":"synthetic-audit-fixture"}\n');
    await asar.createPackage(input, join(resources, "app.asar"));
    await run({ root, input, app, resources });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("payload audit scans a real synthetic ASAR and unpacked/extra resources without launching an application", async () => {
  await fixture(async ({ app, resources }) => {
    await mkdir(join(resources, "app.asar.unpacked", "node_modules", "node-pty", "build", "Release"), { recursive: true });
    await writeFile(join(resources, "app.asar.unpacked", "node_modules", "node-pty", "build", "Release", "pty.node"), "synthetic binary bytes");
    await writeFile(join(resources, "safe-helper.mjs"), "export const helper = true;");
    const result = await auditPtyTestBundle(app);
    assert.equal(result.issues.length, 0);
    assert.ok(result.filesScanned >= 4);
  });
});

test("payload audit detects credential-like bytes in extraResources without reporting their value", async () => {
  await fixture(async ({ app, resources }) => {
    // A synthetic pattern, not a real token or a user credential.
    const token = "gh" + "p_" + "A".repeat(32);
    await writeFile(join(resources, "unsafe-helper.mjs"), `export const injected = "${token}";`);
    const result = await auditPtyTestBundle(app);
    assert.ok(result.issues.some((item) => item.rule === "GitHub token"));
    assert.ok(!JSON.stringify(result).includes(token));
  });
});

test("payload audit rejects private state and pristine Darwin fallback modules", async () => {
  await fixture(async ({ app, resources }) => {
    await writeFile(join(resources, "auth.json"), "{}");
    const directory = join(resources, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "darwin-arm64");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "pty.node"), "pristine fixture");
    const result = await auditPtyTestBundle(app);
    assert.ok(result.issues.some((item) => item.rule === "sensitive filename"));
    assert.ok(result.issues.some((item) => item.rule === "unpatched Darwin prebuild"));
  });
});

test("payload audit cannot claim success when the package is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-missing-payload-"));
  try { await assert.rejects(auditPtyTestBundle(directory)); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test("a reviewed vendor filename still rejects an unknown home path in its real payload", async () => {
  await fixture(async ({ app, resources }) => {
    const directory = join(resources, "companion", "speech");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "libggml-base.dylib"), "\0/" + "Users/synthetic-owner/private/session.txt\0");
    const result = await auditPtyTestBundle(app);
    assert.ok(result.issues.some((item) => item.rule === "personal home path"));
  });
});

test("payload audit recognizes only exact proven-public NUL-terminated vendor source strings", () => {
  const publicSource = "/" + "Users/synthetic-ci/actions-runner/_work/transcribe.cpp/transcribe.cpp/ggml/src/ggml.c";
  const known = new Set([createHash("sha256").update(publicSource).digest("hex")]);
  assert.deepEqual(textIssues(`\0${publicSource}\0`, known), []);
  assert.ok(textIssues(`\0${publicSource}\0`).includes("personal home path"), "other files do not inherit the vendor exemption");
  assert.ok(textIssues(`\0${publicSource}-changed\0`, known).includes("personal home path"));
  assert.ok(textIssues(publicSource, known).includes("personal home path"), "a nonterminated text value is not native build metadata");
});

test("public vendor metadata never exempts another home path or a credential in the same file", () => {
  const publicSource = "/" + "Users/synthetic-ci/actions-runner/_work/transcribe.cpp/transcribe.cpp/ggml/src/ggml.c";
  const privateSource = "/" + "Users/synthetic-owner/private/session.txt";
  const known = new Set([createHash("sha256").update(publicSource).digest("hex")]);
  const content = `\0${publicSource}\0${privateSource}\0${"gh" + "p_" + "A".repeat(32)}\0`;
  const issues = textIssues(content, known);
  assert.ok(issues.includes("personal home path"));
  assert.ok(issues.includes("GitHub token"));
});

test("Duo Darwin prebuild paths are narrowly allowed and their contents are still audited", async () => {
  await fixture(async ({ app, resources }) => {
    const addPrebuild = async (module, arch, name, content) => {
      const directory = join(resources, "app.asar.unpacked", "node_modules", module, "prebuilds", arch);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, name), content);
    };
    await addPrebuild("sodium-native", "darwin-arm64", "sodium-native.node", "synthetic native bytes");
    await addPrebuild("udx-native", "darwin-x64", "udx-native.node", "gh" + "p_" + "A".repeat(32));
    await addPrebuild("udx-native", "darwin-x64", "extra.node", "unknown native module");
    const { issues } = await auditPtyTestBundle(app);
    assert.equal(issues.length, 2);
    assert.ok(issues.some(({ rule, path }) => rule === "GitHub token" && path.endsWith("/udx-native.node")));
    assert.ok(issues.some(({ rule, path }) => rule === "unpatched Darwin prebuild" && path.endsWith("/extra.node")));
  });
});
