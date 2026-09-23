import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  PluginManager,
  downloadGithubRepository,
  extractGithubTarball,
  injectPluginInputBridge,
  normalizeGithubUrl,
  validatePluginManifest
} from "../src/main/services/PluginManager.ts";

test("injects one trusted input bridge before plugin scripts", () => {
  const html = "<!doctype html><html><head><script src='plugin.js'></script></head><body></body></html>";
  const injected = injectPluginInputBridge(html);
  const bridge = "canvastty-plugin://host/input-bridge.js";
  assert.equal(injected.split(bridge).length - 1, 1);
  assert.ok(injected.indexOf(bridge) < injected.indexOf("plugin.js"));
  assert.equal(injectPluginInputBridge(injected), injected);
});

const manifest = {
  apiVersion: 1,
  id: "com.example.studio-clock",
  name: "Studio Clock",
  version: "1.2.0",
  description: "A small collection of CanvasTTY surfaces.",
  author: "Example",
  homepage: "https://example.com/plugin",
  permissions: [
    "storage",
    "secrets",
    "sessions:read",
    "limits:read",
    "launcher:open",
    "external:open",
    "media:library",
    "playlists:read",
    "playlists:write",
    "hermes:hud",
    "network"
  ],
  contributions: [
    {
      id: "clock",
      kind: "home-widget",
      title: "Clock",
      entry: "widgets/clock.html",
      defaultSize: { columns: 4, rows: 2 }
    },
    {
      id: "notes",
      kind: "canvas-app",
      title: "Notes",
      entry: "apps/notes.html",
      defaultSize: { width: 680, height: 440 },
      minSize: { width: 320, height: 180 }
    },
    {
      id: "focus",
      kind: "window",
      title: "Focus window",
      entry: "windows/focus.html",
      defaultSize: { width: 900, height: 620 }
    }
  ],
  settingsContribution: "notes"
};

const hookOnlyManifest = {
  apiVersion: 1,
  id: "com.example.lifecycle-audit",
  name: "Lifecycle Audit",
  version: "1.0.0",
  description: "Records selected agent lifecycle events.",
  permissions: [],
  contributions: [],
  hooks: [{
    id: "audit",
    title: "Lifecycle audit",
    description: "Receives prompt, tool, and session events.",
    entry: "hooks/audit.mjs",
    providers: ["codex", "claude"],
    events: ["session-start", "prompt-submit", "after-tool", "session-end"]
  }]
};

test("normalizes only GitHub repository root links", () => {
  assert.equal(
    normalizeGithubUrl("https://github.com/example/canvastty-clock"),
    "https://github.com/example/canvastty-clock.git"
  );
  assert.equal(
    normalizeGithubUrl("https://github.com/example/canvastty-clock.git/"),
    "https://github.com/example/canvastty-clock.git"
  );
  assert.throws(() => normalizeGithubUrl("git@github.com:example/plugin.git"));
  assert.throws(() => normalizeGithubUrl("https://gitlab.com/example/plugin"));
  assert.throws(() => normalizeGithubUrl("https://github.com/example/plugin/tree/main"));
  assert.throws(() => normalizeGithubUrl("https://user:token@github.com/example/plugin"));
});

test("validates all supported contribution shapes and permissions", () => {
  assert.deepEqual(validatePluginManifest(manifest), manifest);
});

test("validates hook-only plugins and rejects ambiguous executable hook declarations", () => {
  assert.deepEqual(validatePluginManifest(hookOnlyManifest), hookOnlyManifest);
  assert.throws(() => validatePluginManifest({
    ...hookOnlyManifest,
    hooks: [{ ...hookOnlyManifest.hooks[0], entry: "hooks/audit.MJS" }]
  }), /JavaScript file/);
  assert.throws(() => validatePluginManifest({
    ...hookOnlyManifest,
    hooks: [{
      ...hookOnlyManifest.hooks[0],
      providers: ["codex", "codex"]
    }]
  }), /duplicated provider/);
  assert.throws(() => validatePluginManifest({
    ...hookOnlyManifest,
    hooks: [{
      ...hookOnlyManifest.hooks[0],
      events: ["prompt-submit", "prompt-submit"]
    }]
  }), /duplicated event/);
});

test("runtime manifest validation rejects unknown fields at every schema boundary", () => {
  assert.throws(
    () => validatePluginManifest({ ...manifest, surprise: true }),
    /unknown field: surprise/
  );
  assert.throws(
    () => validatePluginManifest({
      ...manifest,
      contributions: [{ ...manifest.contributions[0], surprise: true }]
    }),
    /unknown field: surprise/
  );
  assert.throws(
    () => validatePluginManifest({
      ...manifest,
      contributions: [{
        ...manifest.contributions[0],
        defaultSize: { ...manifest.contributions[0].defaultSize, depth: 2 }
      }]
    }),
    /unknown field: depth/
  );
});

test("recognizes browser:open as a distinct plugin permission", () => {
  const browserManifest = { ...manifest, permissions: ["browser:open"] };
  assert.deepEqual(validatePluginManifest(browserManifest), browserManifest);
  assert.deepEqual(validatePluginManifest({ ...manifest, permissions: ["external:open"] }).permissions, ["external:open"]);
});

test("recognizes the narrow Hermes HUD control permission", () => {
  const hudManifest = { ...manifest, permissions: ["hermes:hud"] };
  assert.deepEqual(validatePluginManifest(hudManifest), hudManifest);
});

test("rejects executable escapes, unknown permissions, and unsupported API versions", () => {
  assert.throws(() => validatePluginManifest({ ...manifest, apiVersion: 2 }));
  assert.throws(() => validatePluginManifest({ ...manifest, permissions: ["filesystem"] }));
  assert.throws(() => validatePluginManifest({
    ...manifest,
    contributions: [{
      ...manifest.contributions[0],
      entry: "../outside.html"
    }]
  }));
});

test("requires unique contribution ids and bounded default sizes", () => {
  assert.throws(() => validatePluginManifest({
    ...manifest,
    contributions: [manifest.contributions[0], manifest.contributions[0]]
  }));
  assert.throws(() => validatePluginManifest({
    ...manifest,
    contributions: [{
      ...manifest.contributions[0],
      defaultSize: { columns: 49, rows: 1 }
    }]
  }));
  assert.throws(() => validatePluginManifest({
    ...manifest,
    settingsContribution: "focus"
  }), /canvas-app/);
  assert.throws(() => validatePluginManifest({
    ...manifest,
    contributions: manifest.contributions.map((contribution) => contribution.id === "notes"
      ? { ...contribution, minSize: { width: 700, height: 180 } }
      : contribution)
  }), /must not exceed/);
});

test("previews, installs, serves, stores, disables, and uninstalls a static package", async () => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-manager-"));
  const fixture = new URL("../examples/plugins/studio-kit/", import.meta.url);
  const manager = new PluginManager(userData, async (_url, destination) => {
    await cp(fixture, destination, { recursive: true });
  });

  try {
    await manager.load();
    const preview = await manager.previewInstall("https://github.com/example/studio-kit");
    assert.equal(preview.manifest.id, "com.example.studio-kit");
    assert.deepEqual(manager.list(), []);

    const installed = await manager.install(preview.token);
    assert.equal(installed.enabled, true);
    assert.equal(manager.list().length, 1);

    const inputBridge = await manager.protocolResponse("canvastty-plugin://host/input-bridge.js");
    assert.equal(inputBridge.status, 200);
    const inputBridgeSource = await inputBridge.text();
    assert.match(inputBridgeSource, /addEventListener\("wheel"/);
    assert.match(inputBridgeSource, /addEventListener\("pointerdown"/);
    assert.match(inputBridgeSource, /type: "canvas-focus"/);
    assert.match(inputBridgeSource, /type: "canvas-hover", active: true/);
    assert.match(inputBridgeSource, /type: "canvas-hover", active: false/);
    const pointerStart = inputBridgeSource.indexOf('addEventListener("pointerdown"');
    assert.doesNotMatch(inputBridgeSource.slice(pointerStart), /event\.preventDefault\(\)/);

    await manager.storageSet(installed.manifest.id, "draft", { text: "real storage" });
    assert.deepEqual(await manager.storageGet(installed.manifest.id, "draft"), { text: "real storage" });

    const asset = await manager.protocolResponse(
      "canvastty-plugin://com.example.studio-kit/widgets/status.html"
    );
    assert.equal(asset.status, 200);
    const assetHtml = await asset.text();
    assert.match(assetHtml, /Session status/);
    assert.match(assetHtml, /canvastty-plugin:\/\/host\/input-bridge\.js/);
    assert.match(asset.headers.get("content-security-policy"), /connect-src 'none'/);

    const sdk = await manager.protocolResponse("canvastty-plugin://host/sdk.js");
    const sdkSource = await sdk.text();
    assert.match(sdkSource, /secrets: Object\.freeze/);
    assert.match(sdkSource, /canvas: Object\.freeze/);
    assert.match(sdkSource, /hermesHud: Object\.freeze/);
    assert.match(sdkSource, /onStorageChange/);

    await manager.setEnabled(installed.manifest.id, false);
    assert.equal((await manager.protocolResponse(
      "canvastty-plugin://com.example.studio-kit/widgets/status.html"
    )).status, 404);

    await manager.setEnabled(installed.manifest.id, true);
    await manager.uninstall(installed.manifest.id);
    assert.deepEqual(manager.list(), []);
  } finally {
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
  }
});

test("plugin lifecycle hooks require opt-in and revoke trust fail-closed", async () => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-hooks-"));
  const manager = new PluginManager(userData, async (_url, destination) => {
    await mkdir(join(destination, "hooks"), { recursive: true });
    await Promise.all([
      writeFile(join(destination, "canvastty.plugin.json"), JSON.stringify(hookOnlyManifest)),
      writeFile(join(destination, "hooks", "audit.mjs"), "process.stdin.resume();\n")
    ]);
  });
  let reloaded;
  let failClosed;

  try {
    await manager.load();
    const preview = await manager.previewInstall("https://github.com/example/lifecycle-audit");
    const installed = await manager.install(preview.token);
    assert.deepEqual(installed.enabledHooks, []);
    assert.deepEqual(manager.runtimeHooksForProvider("codex"), []);

    const enabled = await manager.setHookEnabled(installed.manifest.id, "audit", true);
    assert.deepEqual(enabled.enabledHooks, ["audit"]);
    assert.deepEqual(manager.runtimeHooksForProvider("codex"), [{
      key: "com.example.lifecycle-audit:audit",
      events: ["session-start", "prompt-submit", "after-tool", "session-end"]
    }]);
    assert.deepEqual(manager.runtimeHooksForProvider("qwen"), []);

    const runtimeRegistryPath = manager.runtimeHookRegistryPath;
    const runtimeRegistry = JSON.parse(await readFile(runtimeRegistryPath, "utf8"));
    assert.equal(runtimeRegistry.version, 1);
    assert.equal(
      runtimeRegistry.hooks["com.example.lifecycle-audit:audit"].entry,
      "hooks/audit.mjs"
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(runtimeRegistryPath)).mode & 0o777, 0o600);
    }

    await manager.dispose();
    reloaded = new PluginManager(userData);
    await reloaded.load();
    assert.deepEqual(reloaded.list()[0].enabledHooks, ["audit"]);

    await reloaded.setHookEnabled(installed.manifest.id, "audit", false);
    assert.deepEqual(reloaded.runtimeHooksForProvider("codex"), []);
    assert.deepEqual(
      Object.keys(JSON.parse(await readFile(runtimeRegistryPath, "utf8")).hooks),
      []
    );

    await reloaded.setHookEnabled(installed.manifest.id, "audit", true);
    const disabled = await reloaded.setEnabled(installed.manifest.id, false);
    assert.deepEqual(disabled.enabledHooks, []);
    const restored = await reloaded.setEnabled(installed.manifest.id, true);
    assert.deepEqual(restored.enabledHooks, []);

    await reloaded.setHookEnabled(installed.manifest.id, "audit", true);
    await reloaded.dispose();
    await rm(runtimeRegistryPath);
    failClosed = new PluginManager(userData);
    await failClosed.load();
    assert.deepEqual(failClosed.list()[0].enabledHooks, []);
    assert.deepEqual(failClosed.runtimeHooksForProvider("codex"), []);

    await failClosed.setHookEnabled(installed.manifest.id, "audit", true);
    await failClosed.uninstall(installed.manifest.id);
    assert.deepEqual(failClosed.list(), []);
    assert.deepEqual(
      Object.keys(JSON.parse(await readFile(runtimeRegistryPath, "utf8")).hooks),
      []
    );
    await assert.rejects(stat(join(userData, "plugins", installed.manifest.id)), /ENOENT/u);
  } finally {
    await manager.dispose();
    await reloaded?.dispose();
    await failClosed?.dispose();
    await rm(userData, { recursive: true, force: true });
  }
});

test("a partial registry write cannot leave a rejected plugin hook enablement executable", async () => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-hook-transaction-"));
  const manager = new PluginManager(userData, async (_url, destination) => {
    await mkdir(join(destination, "hooks"), { recursive: true });
    await Promise.all([
      writeFile(join(destination, "canvastty.plugin.json"), JSON.stringify(hookOnlyManifest)),
      writeFile(join(destination, "hooks", "audit.mjs"), "process.stdin.resume();\n")
    ]);
  });

  try {
    await manager.load();
    const preview = await manager.previewInstall("https://github.com/example/lifecycle-audit");
    const installed = await manager.install(preview.token);
    const registryPath = join(userData, "plugins.json");
    await rm(registryPath);
    await mkdir(registryPath);

    await assert.rejects(manager.setHookEnabled(installed.manifest.id, "audit", true));
    assert.deepEqual(manager.list()[0].enabledHooks, []);
    assert.deepEqual(
      Object.keys(JSON.parse(await readFile(manager.runtimeHookRegistryPath, "utf8")).hooks),
      []
    );
  } finally {
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
  }
});

test("installs only selected integrity-checked modules and can change the selection", async () => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-modules-user-"));
  const fixture = await mkdtemp(join(tmpdir(), "canvastty-plugin-modules-source-"));
  const core = Buffer.from("<h1>Core</h1>");
  const extra = Buffer.from("export const extra = true;");
  const manifest = {
    apiVersion: 1,
    id: "com.example.modular",
    name: "Modular",
    version: "1.0.0",
    description: "A modular fixture.",
    permissions: ["storage"],
    coreFiles: [{ path: "index.html", bytes: core.length, sha256: sha256(core) }],
    modules: [{
      id: "extra",
      title: "Extra",
      defaultSelected: false,
      permissions: ["network"],
      files: [{ path: "extra.js", bytes: extra.length, sha256: sha256(extra) }]
    }],
    contributions: [{
      id: "core",
      kind: "canvas-app",
      title: "Core",
      entry: "index.html",
      defaultSize: { width: 480, height: 300 }
    }]
  };
  await writeFile(join(fixture, "canvastty.plugin.json"), JSON.stringify(manifest));
  await writeFile(join(fixture, "index.html"), core);
  await writeFile(join(fixture, "extra.js"), extra);
  const copyFiles = async (_url, destination, files) => {
    for (const file of files) {
      await mkdir(join(destination, file.path.split("/").slice(0, -1).join("/")), { recursive: true });
      await cp(join(fixture, file.path), join(destination, file.path));
    }
  };
  const manager = new PluginManager(
    userData,
    async (_url, destination) => cp(fixture, destination, { recursive: true }),
    copyFiles
  );
  try {
    await manager.load();
    const preview = await manager.previewInstall("https://github.com/example/modular");
    const installed = await manager.install(preview.token, []);
    assert.deepEqual(installed.selectedModules, []);
    assert.deepEqual(installed.manifest.permissions, ["storage"]);
    assert.equal((await manager.protocolResponse("canvastty-plugin://com.example.modular/extra.js")).status, 404);

    const updated = await manager.setModules(installed.manifest.id, ["extra"]);
    assert.deepEqual(updated.selectedModules, ["extra"]);
    assert.deepEqual(updated.manifest.permissions, ["storage", "network"]);
    const moduleAsset = await manager.protocolResponse("canvastty-plugin://com.example.modular/extra.js");
    assert.equal(moduleAsset.status, 200);
    assert.match(moduleAsset.headers.get("content-security-policy"), /connect-src https:/);
  } finally {
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});

test("extracts a bounded GitHub tar root and rejects traversal or links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-plugin-tar-"));
  try {
    await extractGithubTarball(tarArchive([
      { name: "repository-hash/", type: "5", content: "" },
      { name: "repository-hash/plugin/index.html", type: "0", content: "safe" }
    ]), directory);
    assert.equal(await readFile(join(directory, "plugin/index.html"), "utf8"), "safe");

    await assert.rejects(() => extractGithubTarball(tarArchive([
      { name: "repository-hash/../escape.txt", type: "0", content: "escape" }
    ]), join(directory, "traversal")));
    await assert.rejects(() => extractGithubTarball(tarArchive([
      { name: "repository-hash/link", type: "2", content: "" }
    ]), join(directory, "link")));
    await assert.rejects(() => extractGithubTarball(tarArchive(
      Array.from({ length: 501 }, (_value, index) => ({
        name: `repository-hash/directory-${index}/`,
        type: "5",
        content: ""
      }))
    ), join(directory, "too-many-directories")), /500 entry/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plugin download retries transient failures but not permanent ones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-plugin-download-"));
  const tarball = gzipSync(tarArchive([
    { name: "repository-hash/", type: "5", content: "" },
    { name: "repository-hash/index.html", type: "0", content: "ok" }
  ]));
  const originalFetch = globalThis.fetch;
  let calls = 0;

  try {
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response(tarball, { status: 200 });
    };
    await downloadGithubRepository("https://github.com/example/repository.git", directory);
    assert.equal(calls, 2);
    assert.equal(await readFile(join(directory, "index.html"), "utf8"), "ok");

    calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("nope", { status: 404 });
    };
    await assert.rejects(
      () => downloadGithubRepository("https://github.com/example/missing.git", join(directory, "missing")),
      /not found or is not public/
    );
    assert.equal(calls, 1);

    globalThis.fetch = async () => {
      const response = new Response(tarball, { status: 200 });
      Object.defineProperty(response, "url", { value: "https://example.com/archive.tar.gz" });
      return response;
    };
    await assert.rejects(
      () => downloadGithubRepository("https://github.com/example/redirected.git", join(directory, "redirected")),
      /outside GitHub's download hosts/
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("manifest-only preview retries GitHub API and raw downloads and rejects foreign redirects", async () => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-manifest-retry-"));
  const core = Buffer.from("<h1>Core</h1>");
  const extra = Buffer.from("export const extra = true;");
  const manifest = {
    apiVersion: 1,
    id: "com.example.remote-modular",
    name: "Remote modular",
    version: "1.0.0",
    description: "A manifest-only retry fixture.",
    permissions: [],
    coreFiles: [{ path: "index.html", bytes: core.length, sha256: sha256(core) }],
    modules: [{
      id: "extra",
      title: "Extra",
      defaultSelected: false,
      permissions: [],
      files: [{ path: "extra.js", bytes: extra.length, sha256: sha256(extra) }]
    }],
    contributions: [{
      id: "core",
      kind: "canvas-app",
      title: "Core",
      entry: "index.html",
      defaultSize: { width: 480, height: 300 }
    }]
  };
  const originalFetch = globalThis.fetch;
  let metadataCalls = 0;
  let rawCalls = 0;
  const manager = new PluginManager(userData);

  try {
    globalThis.fetch = async (url) => {
      if (String(url).startsWith("https://api.github.com/")) {
        metadataCalls += 1;
        if (metadataCalls === 1) throw new TypeError("fetch failed");
        return Response.json({ default_branch: "main" });
      }
      rawCalls += 1;
      if (rawCalls === 1) {
        let sent = false;
        return new Response(new ReadableStream({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(Buffer.from("partial"));
              return;
            }
            controller.error(new TypeError("stream interrupted"));
          }
        }), { status: 200 });
      }
      return Response.json(manifest);
    };

    await manager.load();
    const preview = await manager.previewInstall("https://github.com/example/remote-modular");
    assert.equal(preview.manifest.id, manifest.id);
    assert.equal(metadataCalls, 2);
    assert.equal(rawCalls, 2);

    const foreignUserData = await mkdtemp(join(tmpdir(), "canvastty-plugin-foreign-redirect-"));
    const foreignManager = new PluginManager(foreignUserData);
    try {
      globalThis.fetch = async (url) => {
        if (String(url).startsWith("https://api.github.com/")) {
          return Response.json({ default_branch: "main" });
        }
        const response = Response.json(manifest);
        Object.defineProperty(response, "url", { value: "https://example.com/canvastty.plugin.json" });
        return response;
      };
      await foreignManager.load();
      await assert.rejects(
        () => foreignManager.previewInstall("https://github.com/example/remote-modular"),
        /outside raw\.githubusercontent\.com/
      );
    } finally {
      await foreignManager.dispose();
      await rm(foreignUserData, { recursive: true, force: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
  }
});

test("rejects install when a downloaded module file fails integrity verification", async () => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-integrity-"));
  const core = Buffer.from("<h1>Core</h1>");
  const extra = Buffer.from("export const extra = true;");
  const tampered = Buffer.from("export const extra = true?");
  const modularManifest = (id, extraFile) => ({
    apiVersion: 1,
    id,
    name: "Modular",
    version: "1.0.0",
    description: "A modular integrity fixture.",
    permissions: [],
    coreFiles: [{ path: "index.html", bytes: core.length, sha256: sha256(core) }],
    modules: [{
      id: "extra",
      title: "Extra",
      defaultSelected: true,
      permissions: [],
      files: [extraFile]
    }],
    contributions: [{
      id: "core",
      kind: "canvas-app",
      title: "Core",
      entry: "index.html",
      defaultSize: { width: 480, height: 300 }
    }]
  });
  const originalFetch = globalThis.fetch;
  const served = new Map([["index.html", core]]);
  let servedManifest = null;
  const manager = new PluginManager(userData);

  try {
    globalThis.fetch = async (url) => {
      const text = String(url);
      if (text.startsWith("https://api.github.com/")) return Response.json({ default_branch: "main" });
      const path = text.slice(text.indexOf("/main/") + "/main/".length);
      if (path === "canvastty.plugin.json") {
        return new Response(JSON.stringify(servedManifest), { status: 200 });
      }
      const content = served.get(path);
      return content ? new Response(content, { status: 200 }) : new Response("missing", { status: 404 });
    };
    await manager.load();

    // Wrong SHA-256: same byte count, different content.
    servedManifest = modularManifest("com.example.hash-mismatch", {
      path: "extra.js",
      bytes: tampered.length,
      sha256: sha256(extra)
    });
    served.set("extra.js", tampered);
    const hashPreview = await manager.previewInstall("https://github.com/example/modular");
    await assert.rejects(
      () => manager.install(hashPreview.token, ["extra"]),
      /failed integrity verification: extra\.js/
    );
    assert.deepEqual(manager.list(), []);
    assert.equal(
      (await manager.protocolResponse("canvastty-plugin://com.example.hash-mismatch/extra.js")).status,
      404
    );
    await assert.rejects(() => stat(join(userData, "plugins", "com.example.hash-mismatch")));

    // Wrong byte count: fewer bytes delivered than the manifest declares.
    servedManifest = modularManifest("com.example.size-mismatch", {
      path: "extra.js",
      bytes: extra.length + 4,
      sha256: sha256(extra)
    });
    served.set("extra.js", extra);
    const sizePreview = await manager.previewInstall("https://github.com/example/modular");
    await assert.rejects(
      () => manager.install(sizePreview.token, ["extra"]),
      /failed integrity verification: extra\.js/
    );
    assert.deepEqual(manager.list(), []);

    const registry = JSON.parse(await readFile(join(userData, "plugins.json"), "utf8"));
    assert.equal(registry["com.example.hash-mismatch"], undefined);
    assert.equal(registry["com.example.size-mismatch"], undefined);
  } finally {
    globalThis.fetch = originalFetch;
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
  }
});

test("setModules keeps the previous module set when activation fails", async () => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-rollback-"));
  const core = Buffer.from("<h1>Core</h1>");
  const one = Buffer.from("<h1>Module one</h1>");
  const two = Buffer.from("<h1>Module two</h1>");
  const tamperedTwo = Buffer.from("<h1>Module TWO</h1>");
  const manifest = {
    apiVersion: 1,
    id: "com.example.rollback",
    name: "Rollback",
    version: "1.0.0",
    description: "A modular rollback fixture.",
    permissions: [],
    coreFiles: [{ path: "index.html", bytes: core.length, sha256: sha256(core) }],
    modules: [
      {
        id: "one",
        title: "One",
        defaultSelected: false,
        permissions: ["network"],
        files: [{ path: "one.html", bytes: one.length, sha256: sha256(one) }]
      },
      {
        id: "two",
        title: "Two",
        defaultSelected: false,
        permissions: [],
        files: [{ path: "two.html", bytes: two.length, sha256: sha256(two) }]
      }
    ],
    contributions: [
      {
        id: "core",
        kind: "canvas-app",
        title: "Core",
        entry: "index.html",
        defaultSize: { width: 480, height: 300 }
      },
      {
        id: "one-app",
        kind: "canvas-app",
        title: "One",
        entry: "one.html",
        module: "one",
        defaultSize: { width: 480, height: 300 }
      },
      {
        id: "two-app",
        kind: "canvas-app",
        title: "Two",
        entry: "two.html",
        module: "two",
        defaultSize: { width: 480, height: 300 }
      }
    ]
  };
  const originalFetch = globalThis.fetch;
  const served = new Map([["index.html", core], ["one.html", one], ["two.html", two]]);
  const failedPaths = new Set();
  const manager = new PluginManager(userData);

  try {
    globalThis.fetch = async (url) => {
      const text = String(url);
      if (text.startsWith("https://api.github.com/")) return Response.json({ default_branch: "main" });
      const path = text.slice(text.indexOf("/main/") + "/main/".length);
      if (path === "canvastty.plugin.json") return new Response(JSON.stringify(manifest), { status: 200 });
      if (failedPaths.has(path)) return new Response("boom", { status: 400 });
      const content = served.get(path);
      return content ? new Response(content, { status: 200 }) : new Response("missing", { status: 404 });
    };
    await manager.load();
    const preview = await manager.previewInstall("https://github.com/example/rollback");
    const installed = await manager.install(preview.token, ["one"]);
    assert.deepEqual(installed.selectedModules, ["one"]);
    const oneAsset = await manager.protocolResponse("canvastty-plugin://com.example.rollback/one.html");
    assert.equal(oneAsset.status, 200);
    assert.match(await oneAsset.text(), /<h1>Module one<\/h1>/);

    // Integrity failure while activating a new selection: the old set survives.
    served.set("two.html", tamperedTwo);
    await assert.rejects(
      () => manager.setModules(installed.manifest.id, ["two"]),
      /failed integrity verification: two\.html/
    );
    assert.deepEqual(manager.list()[0].selectedModules, ["one"]);
    const intactAsset = await manager.protocolResponse("canvastty-plugin://com.example.rollback/one.html");
    assert.equal(intactAsset.status, 200);
    assert.match(await intactAsset.text(), /<h1>Module one<\/h1>/);
    assert.equal(
      (await manager.protocolResponse("canvastty-plugin://com.example.rollback/two.html")).status,
      404
    );

    // Download failure while extending the selection: still the old set.
    served.set("two.html", two);
    failedPaths.add("two.html");
    await assert.rejects(
      () => manager.setModules(installed.manifest.id, ["one", "two"]),
      /HTTP 400/
    );
    assert.deepEqual(manager.list()[0].selectedModules, ["one"]);
    assert.equal(
      (await manager.protocolResponse("canvastty-plugin://com.example.rollback/one.html")).status,
      200
    );

    // The persisted registry still holds the previous selection after a reload.
    const reloaded = new PluginManager(userData);
    try {
      await reloaded.load();
      assert.deepEqual(reloaded.list()[0].selectedModules, ["one"]);
      const reloadedAsset = await reloaded.protocolResponse(
        "canvastty-plugin://com.example.rollback/one.html"
      );
      assert.equal(reloadedAsset.status, 200);
      assert.match(await reloadedAsset.text(), /<h1>Module one<\/h1>/);
    } finally {
      await reloaded.dispose();
    }

    // Sanity check: a working reconfiguration still succeeds after the failures.
    failedPaths.clear();
    const updated = await manager.setModules(installed.manifest.id, ["two"]);
    assert.deepEqual(updated.selectedModules, ["two"]);
    assert.equal(
      (await manager.protocolResponse("canvastty-plugin://com.example.rollback/two.html")).status,
      200
    );
  } finally {
    globalThis.fetch = originalFetch;
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
  }
});

test("searches GitHub for canvastty-plugin repositories", async () => {
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    globalThis.fetch = async (url) => {
      const text = String(url);
      if (!text.startsWith("https://api.github.com/search/repositories")) {
        return new Response("not found", { status: 404 });
      }
      return Response.json({
        items: [
          {
            full_name: "example/canvastty-clock",
            description: "A clock widget",
            stargazers_count: 12,
            updated_at: "2026-08-01T00:00:00Z"
          },
          {
            full_name: "example/canvastty-plugin-clock",
            description: "A clock widget",
            stargazers_count: 12,
            updated_at: "2026-08-01T00:00:00Z"
          },
          {
            full_name: "example/canvastty-ticker",
            description: null,
            stargazers_count: 0,
            updated_at: "2026-07-01T00:00:00Z"
          },
          { full_name: "not-a-plugin", description: "x", stargazers_count: 0, updated_at: "" }
        ]
      });
    };
    const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-search-"));
    const manager = new PluginManager(userData);
    try {
      await manager.load();
      assert.deepEqual(await manager.searchGithubPlugins("clock"), [
        {
          fullName: "example/canvastty-plugin-clock",
          url: "https://github.com/example/canvastty-plugin-clock",
          description: "A clock widget",
          stars: 12,
          updatedAt: "2026-08-01T00:00:00Z"
        }
      ]);
      assert.deepEqual(await manager.searchGithubPlugins("   "), []);
    } finally {
      await manager.dispose();
      await rm(userData, { recursive: true, force: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

test("showcase lists only repositories with the canvastty-plugin- prefix", async () => {
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    let calls = 0;
    globalThis.fetch = async (url) => {
      const text = String(url);
      calls += 1;
      if (!text.startsWith("https://api.github.com/search/repositories")) {
        return new Response("not found", { status: 404 });
      }
      if (calls === 1) {
        return Response.json({
          items: [
            { full_name: "a/canvastty-plugin-one", description: "One", stargazers_count: 1, updated_at: "2026-08-01T00:00:00Z" },
            { full_name: "a/canvastty-plugin-two", description: "Two", stargazers_count: 2, updated_at: "2026-08-02T00:00:00Z" },
            { full_name: "a/not-a-plugin", description: "x", stargazers_count: 0, updated_at: "" }
          ]
        });
      }
      return Response.json({ items: [] });
    };
    const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-showcase-"));
    const manager = new PluginManager(userData);
    try {
      await manager.load();
      const showcase = await manager.listShowcasePlugins();
      assert.deepEqual(showcase.map((item) => item.fullName), [
        "a/canvastty-plugin-one",
        "a/canvastty-plugin-two"
      ]);
      assert.ok(calls >= 1);
    } finally {
      await manager.dispose();
      await rm(userData, { recursive: true, force: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

test("showcase keeps more than ten real GitHub results for UI pagination", async () => {
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-showcase-pages-"));
  const repositories = Array.from({ length: 11 }, (_value, index) => ({
    full_name: `example/canvastty-plugin-${index + 1}`,
    description: `Plugin ${index + 1}`,
    stargazers_count: index,
    updated_at: "2026-08-01T00:00:00Z"
  }));
  try {
    globalThis.fetch = async (url) => {
      const text = String(url);
      if (text.startsWith("https://api.github.com/search/repositories")) {
        return Response.json({ items: repositories });
      }
      if (text.startsWith("https://api.github.com/repos/")) {
        return Response.json({ default_branch: "main" });
      }
      return new Response("missing", { status: 404 });
    };
    const manager = new PluginManager(userData);
    try {
      await manager.load();
      const showcase = await manager.listShowcasePlugins();
      assert.equal(showcase.length, 11);
      assert.equal(showcase[10].fullName, "example/canvastty-plugin-11");
    } finally {
      await manager.dispose();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    await rm(userData, { recursive: true, force: true });
  }
});

test("showcase excludes repositories that are already installed", async () => {
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-showcase-excl-"));
  const fixture = await mkdtemp(join(tmpdir(), "canvastty-plugin-showcase-excl-fixture-"));
  try {
    await writeFile(join(fixture, "clock.html"), "<h1>Clock</h1>", "utf8");
    await writeFile(join(fixture, "canvastty.plugin.json"), JSON.stringify({
      apiVersion: 1,
      id: "com.example.one",
      name: "One",
      version: "1.0.0",
      description: "One fixture.",
      permissions: [],
      contributions: [{
        id: "clock",
        kind: "home-widget",
        title: "Clock",
        entry: "clock.html",
        defaultSize: { columns: 2, rows: 2 }
      }]
    }), "utf8");

    globalThis.fetch = async (url) => {
      const text = String(url);
      if (text.startsWith("https://api.github.com/search/repositories")) {
        return Response.json({
          items: [
            { full_name: "a/canvastty-plugin-one", description: "One", stargazers_count: 1, updated_at: "2026-08-01T00:00:00Z" },
            { full_name: "a/canvastty-plugin-two", description: "Two", stargazers_count: 2, updated_at: "2026-08-02T00:00:00Z" }
          ]
        });
      }
      if (text.startsWith("https://api.github.com/")) return Response.json({ default_branch: "main" });
      return new Response("missing", { status: 404 });
    };

    const manager = new PluginManager(userData, async (_url, destination) => {
      await cp(fixture, destination, { recursive: true });
    });
    try {
      await manager.load();
      // Nothing installed yet: both repositories are listed.
      const before = await manager.listShowcasePlugins();
      assert.deepEqual(before.map((item) => item.fullName), [
        "a/canvastty-plugin-one",
        "a/canvastty-plugin-two"
      ]);

      // Install the first repository, then it must disappear from the showcase.
      await manager.install((await manager.previewInstall("https://github.com/a/canvastty-plugin-one")).token);
      const after = await manager.listShowcasePlugins();
      assert.deepEqual(after.map((item) => item.fullName), ["a/canvastty-plugin-two"]);

      // After uninstall it shows up again.
      await manager.uninstall("com.example.one");
      const afterUninstall = await manager.listShowcasePlugins();
      assert.deepEqual(afterUninstall.map((item) => item.fullName), [
        "a/canvastty-plugin-one",
        "a/canvastty-plugin-two"
      ]);
    } finally {
      await manager.dispose();
      await rm(userData, { recursive: true, force: true });
      await rm(fixture, { recursive: true, force: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

test("showcase uses GraphQL search when a token is present", async () => {
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  let graphqlCalls = 0;
  let restSearchCalls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      const text = String(url);
      if (text === "https://api.github.com/graphql") {
        graphqlCalls += 1;
        const body = JSON.parse(String((options && typeof options === "object" && "body" in options ? options.body : null) ?? "{}"));
        const q = String(body.variables?.q ?? "");
        const allNodes = [
          { nameWithOwner: "a/canvastty-plugin-one", description: "One", stargazerCount: 1, updatedAt: "2026-08-01T00:00:00Z" },
          { nameWithOwner: "a/canvastty-plugin-two", description: "Two", stargazerCount: 2, updatedAt: "2026-08-02T00:00:00Z" }
        ];
        const match = q.match(/canvastty-plugin-([a-z0-9-]+)/);
        const nodes = match ? allNodes.filter((node) => node.nameWithOwner.includes(`canvastty-plugin-${match[1]}`)) : allNodes;
        return Response.json({
          data: {
            search: {
              repositoryCount: nodes.length,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes
            }
          }
        });
      }
      if (text.startsWith("https://api.github.com/search/")) {
        restSearchCalls += 1;
        return Response.json({ items: [] });
      }
      return new Response("missing", { status: 404 });
    };
    const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-graphql-"));
    const manager = new PluginManager(userData);
    try {
      await manager.load();
      const showcase = await manager.listShowcasePlugins();
      assert.deepEqual(showcase.map((item) => item.fullName), [
        "a/canvastty-plugin-one",
        "a/canvastty-plugin-two"
      ]);
      assert.ok(graphqlCalls >= 1, `expected at least 1 GraphQL call, got ${graphqlCalls}`);
      assert.equal(restSearchCalls, 0, "REST search must not be used when a token is present");
      const found = await manager.searchGithubPlugins("one");
      assert.deepEqual(found.map((item) => item.fullName), ["a/canvastty-plugin-one"]);
    } finally {
      await manager.dispose();
      await rm(userData, { recursive: true, force: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

test("rejects empty search queries and surfaces GitHub rate limits", async () => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-searchrate-"));
  const manager = new PluginManager(userData);
  try {
    await manager.load();
    assert.deepEqual(await manager.searchGithubPlugins(""), []);
  } finally {
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
  }

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("rate limited", { status: 429 });
    const userData2 = await mkdtemp(join(tmpdir(), "canvastty-plugin-searchrate2-"));
    const manager2 = new PluginManager(userData2);
    try {
      await manager2.load();
      await assert.rejects(() => manager2.searchGithubPlugins("clock"), /rate limit/);
    } finally {
      await manager2.dispose();
      await rm(userData2, { recursive: true, force: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("checkForUpdates compares installed and remote versions", async () => {
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-updates-"));
  const fixture = await mkdtemp(join(tmpdir(), "canvastty-plugin-updates-fixture-"));
  const writeFixture = async (version) => {
    await rm(fixture, { recursive: true, force: true });
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, "clock.html"), "<h1>Clock</h1>", "utf8");
    await writeFile(join(fixture, "canvastty.plugin.json"), JSON.stringify({
      apiVersion: 1,
      id: "com.example.updates",
      name: "Updates",
      version,
      description: "Update fixture.",
      permissions: [],
      contributions: [{
        id: "clock",
        kind: "home-widget",
        title: "Clock",
        entry: "clock.html",
        defaultSize: { columns: 2, rows: 2 }
      }]
    }), "utf8");
  };
  await writeFixture("1.0.0");
  // The manager copies the fixture for previews/installs, but update checks
  // resolve the remote manifest via raw.githubusercontent.com.
  let remoteVersion = "1.0.0";
  const manager = new PluginManager(userData, async (_url, destination) => {
    await cp(fixture, destination, { recursive: true });
  });
  try {
    globalThis.fetch = async (url) => {
      const text = String(url);
      if (text.startsWith("https://api.github.com/")) return Response.json({ default_branch: "main" });
      const path = text.slice(text.indexOf("/main/") + "/main/".length);
      if (path === "canvastty.plugin.json") {
        return new Response(JSON.stringify({
          apiVersion: 1,
          id: "com.example.updates",
          name: "Updates",
          version: remoteVersion,
          description: "Update fixture.",
          permissions: [],
          contributions: [{
            id: "clock",
            kind: "home-widget",
            title: "Clock",
            entry: "clock.html",
            defaultSize: { columns: 2, rows: 2 }
          }]
        }), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    };
    await manager.load();
    await manager.install((await manager.previewInstall("https://github.com/example/updates")).token);

    // Same version: no update.
    assert.deepEqual(await manager.checkForUpdates(), []);

    // Remote bumps: update reported.
    remoteVersion = "1.1.0";
    const updates = await manager.checkForUpdates();
    assert.deepEqual(updates, [{
      pluginId: "com.example.updates",
      installedVersion: "1.0.0",
      latestVersion: "1.1.0"
    }]);

    // Version manifest is persisted.
    const versionsRaw = await readFile(join(userData, "plugin-versions.json"), "utf8");
    const versions = JSON.parse(versionsRaw);
    assert.equal(versions["com.example.updates"].installedVersion, "1.0.0");
    assert.equal(versions["com.example.updates"].latestVersion, "1.1.0");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});

test("updatePlugin replaces files and keeps enabled and modules", async () => {
  const originalFetch = globalThis.fetch;
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-updateflow-"));
  const fixture = await mkdtemp(join(tmpdir(), "canvastty-plugin-updateflow-fixture-"));
  let version = "1.0.0";
  const writeFixture = async () => {
    await rm(fixture, { recursive: true, force: true });
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, "app.html"), version === "1.0.0" ? "<h1>v1</h1>" : "<h1>v2</h1>", "utf8");
    await writeFile(join(fixture, "canvastty.plugin.json"), JSON.stringify({
      apiVersion: 1,
      id: "com.example.updateflow",
      name: "Update Flow",
      version,
      description: "Update flow fixture.",
      permissions: [],
      contributions: [{
        id: "app",
        kind: "canvas-app",
        title: "App",
        entry: "app.html",
        defaultSize: { width: 480, height: 300 }
      }]
    }), "utf8");
  };
  await writeFixture();
  const manager = new PluginManager(userData, async (_url, destination) => {
    await cp(fixture, destination, { recursive: true });
  });
  try {
    globalThis.fetch = async (url) => {
      const text = String(url);
      if (text.startsWith("https://api.github.com/")) return Response.json({ default_branch: "main" });
      return new Response("missing", { status: 404 });
    };
    await manager.load();
    await manager.install((await manager.previewInstall("https://github.com/example/updateflow")).token);

    version = "1.2.0";
    await writeFixture();
    const updated = await manager.updatePlugin("com.example.updateflow");
    assert.equal(updated.manifest.version, "1.2.0");
    assert.equal(updated.enabled, true);
    const asset = await manager.protocolResponse("canvastty-plugin://com.example.updateflow/app.html");
    assert.equal(asset.status, 200);
    assert.equal(
      await asset.text(),
      '<script src="canvastty-plugin://host/input-bridge.js"></script><h1>v2</h1>'
    );
  } finally {
    globalThis.fetch = originalFetch;
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});

test("updatePlugin restores the previous package when metadata persistence fails", async () => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-update-rollback-"));
  const fixture = await mkdtemp(join(tmpdir(), "canvastty-plugin-update-rollback-fixture-"));
  let version = "1.0.0";
  const writeFixture = async () => {
    await rm(fixture, { recursive: true, force: true });
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, "app.html"), `<h1>${version}</h1>`, "utf8");
    await writeFile(join(fixture, "canvastty.plugin.json"), JSON.stringify({
      apiVersion: 1,
      id: "com.example.rollback",
      name: "Rollback",
      version,
      description: "Atomic update rollback fixture.",
      permissions: [],
      contributions: [{
        id: "app",
        kind: "canvas-app",
        title: "App",
        entry: "app.html",
        defaultSize: { width: 480, height: 300 }
      }]
    }), "utf8");
  };
  await writeFixture();
  const manager = new PluginManager(userData, async (_url, destination) => {
    await cp(fixture, destination, { recursive: true });
  });
  try {
    await manager.load();
    await manager.install((await manager.previewInstall("https://github.com/example/rollback")).token);
    version = "2.0.0";
    await writeFixture();
    await mkdir(join(userData, "plugin-versions.json.tmp"));

    await assert.rejects(() => manager.updatePlugin("com.example.rollback"));
    assert.equal(manager.list()[0].manifest.version, "1.0.0");
    const asset = await manager.protocolResponse("canvastty-plugin://com.example.rollback/app.html");
    assert.equal(
      await asset.text(),
      '<script src="canvastty-plugin://host/input-bridge.js"></script><h1>1.0.0</h1>'
    );
  } finally {
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});

test("concurrent updatePlugin calls for one plugin share one in-flight update", async () => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-update-singleflight-"));
  const fixture = await mkdtemp(join(tmpdir(), "canvastty-plugin-update-singleflight-fixture-"));
  let version = "1.0.0";
  let updateDownloads = 0;
  const writeFixture = async () => {
    await rm(fixture, { recursive: true, force: true });
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, "app.html"), `<h1>${version}</h1>`, "utf8");
    await writeFile(join(fixture, "canvastty.plugin.json"), JSON.stringify({
      apiVersion: 1,
      id: "com.example.update-singleflight",
      name: "Update Singleflight",
      version,
      description: "Concurrent update fixture.",
      permissions: [],
      contributions: [{
        id: "app",
        kind: "canvas-app",
        title: "App",
        entry: "app.html",
        defaultSize: { width: 480, height: 300 }
      }]
    }), "utf8");
  };
  await writeFixture();
  let trackUpdateDownloads = false;
  const manager = new PluginManager(userData, async (_url, destination) => {
    if (trackUpdateDownloads) updateDownloads += 1;
    await cp(fixture, destination, { recursive: true });
  });
  try {
    await manager.load();
    await manager.install((await manager.previewInstall("https://github.com/example/update-singleflight")).token);
    version = "2.0.0";
    await writeFixture();
    trackUpdateDownloads = true;

    const results = await Promise.allSettled([
      manager.updatePlugin("com.example.update-singleflight"),
      manager.updatePlugin("com.example.update-singleflight")
    ]);

    assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
    const [first, second] = results.map((result) => result.value);
    assert.equal(updateDownloads, 1);
    assert.equal(first.manifest.version, "2.0.0");
    assert.equal(second.manifest.version, "2.0.0");
    assert.equal(manager.list()[0].manifest.version, "2.0.0");
    const versions = JSON.parse(await readFile(join(userData, "plugin-versions.json"), "utf8"));
    assert.equal(versions["com.example.update-singleflight"].installedVersion, "2.0.0");
  } finally {
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});

test("checkForUpdates keeps installed version current when an update finishes during its fetch", async () => {
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  const previousCanvasToken = process.env.CANVASTTY_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.CANVASTTY_GITHUB_TOKEN;
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-update-check-race-"));
  const fixture = await mkdtemp(join(tmpdir(), "canvastty-plugin-update-check-race-fixture-"));
  let version = "1.0.0";
  let remoteVersion = "1.0.0";
  let pauseRemoteFetch = false;
  let signalRemoteStarted;
  const remoteStarted = new Promise((resolve) => { signalRemoteStarted = resolve; });
  let releaseRemoteFetch;
  const remoteGate = new Promise((resolve) => { releaseRemoteFetch = resolve; });
  const manifestFor = (manifestVersion) => ({
    apiVersion: 1,
    id: "com.example.update-check-race",
    name: "Update Check Race",
    version: manifestVersion,
    description: "Version state race fixture.",
    permissions: [],
    contributions: [{
      id: "app",
      kind: "canvas-app",
      title: "App",
      entry: "app.html",
      defaultSize: { width: 480, height: 300 }
    }]
  });
  const writeFixture = async () => {
    await rm(fixture, { recursive: true, force: true });
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, "app.html"), `<h1>${version}</h1>`, "utf8");
    await writeFile(join(fixture, "canvastty.plugin.json"), JSON.stringify(manifestFor(version)), "utf8");
  };
  await writeFixture();
  const manager = new PluginManager(userData, async (_url, destination) => {
    await cp(fixture, destination, { recursive: true });
  });
  try {
    globalThis.fetch = async (url) => {
      const text = String(url);
      if (text === "https://api.github.com/repos/example/update-check-race") {
        return Response.json({ default_branch: "main" });
      }
      if (text === "https://raw.githubusercontent.com/example/update-check-race/main/canvastty.plugin.json") {
        if (pauseRemoteFetch) {
          signalRemoteStarted();
          await remoteGate;
        }
        return Response.json(manifestFor(remoteVersion));
      }
      return new Response("missing", { status: 404 });
    };
    await manager.load();
    await manager.install((await manager.previewInstall("https://github.com/example/update-check-race")).token);

    version = "2.0.0";
    remoteVersion = "2.0.0";
    await writeFixture();
    pauseRemoteFetch = true;
    const checking = manager.checkForUpdates();
    await remoteStarted;
    await manager.updatePlugin("com.example.update-check-race");
    releaseRemoteFetch();

    assert.deepEqual(await checking, []);
    const versions = JSON.parse(await readFile(join(userData, "plugin-versions.json"), "utf8"));
    assert.equal(versions["com.example.update-check-race"].installedVersion, "2.0.0");
    assert.equal(versions["com.example.update-check-race"].latestVersion, "2.0.0");
  } finally {
    releaseRemoteFetch();
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    if (previousCanvasToken === undefined) delete process.env.CANVASTTY_GITHUB_TOKEN;
    else process.env.CANVASTTY_GITHUB_TOKEN = previousCanvasToken;
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});

test("validatePluginManifest accepts icon and localized descriptions", () => {
  const valid = validatePluginManifest({
    apiVersion: 1,
    id: "com.example.localized",
    name: "Localized",
    version: "1.0.0",
    description: "Default description.",
    "description.ru": "Русское описание.",
    "description.en": "English description.",
    icon: "icon.png",
    permissions: [],
    contributions: [{
      id: "w",
      kind: "home-widget",
      title: "W",
      entry: "w.html",
      defaultSize: { columns: 2, rows: 2 }
    }]
  });
  assert.equal(valid["description.ru"], "Русское описание.");
  assert.equal(valid["description.en"], "English description.");
  assert.equal(valid.icon, "icon.png");
  assert.equal(valid.description, "Default description.");
});

test("fetchPluginIcons returns data URLs or null for plugins without icons", async () => {
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-icon-"));
  const manager = new PluginManager(userData);
  try {
    const served = new Map([
      ["plugin-a/icon.png", Buffer.from("PNGDATA")],
      ["plugin-a/icon.svg", Buffer.from("<svg/>")]
    ]);
    globalThis.fetch = async (url) => {
      const text = String(url);
      if (text.startsWith("https://api.github.com/")) return Response.json({ default_branch: "main" });
      const mark = "/main/";
      const start = text.indexOf(mark);
      const parts = text.slice(start + mark.length).split("/");
      const repoStart = text.indexOf("raw.githubusercontent.com/") + "raw.githubusercontent.com/".length;
      const repo = text.slice(repoStart, start).split("/")[1];
      const path = parts.join("/");
      const content = served.get(`${repo}/${path}`);
      return content ? new Response(content, { status: 200 }) : new Response("missing", { status: 404 });
    };
    await manager.load();

    const withPng = await manager.fetchPluginIcons(["https://github.com/example/plugin-a"]);
    const png = withPng.get("https://github.com/example/plugin-a");
    assert.ok(png?.startsWith("data:image/png;base64,"));
    assert.ok(png?.endsWith(Buffer.from("PNGDATA").toString("base64")));

    // Batch across two plugins while icons still exist: present resolves,
    // missing path resolves null.
    const mixed = await manager.fetchPluginIcons([
      "https://github.com/example/plugin-a",
      "https://github.com/example/plugin-b"
    ]);
    assert.equal(mixed.get("https://github.com/example/plugin-a")?.startsWith("data:image/png;base64,"), true);
    assert.equal(mixed.get("https://github.com/example/plugin-b"), null);

    served.delete("plugin-a/icon.png");
    served.delete("plugin-a/icon.svg");
    const withoutIcon = await manager.fetchPluginIcons(["https://github.com/example/plugin-b"]);
    assert.equal(withoutIcon.get("https://github.com/example/plugin-b"), null);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
  }
});

test("GraphQL file metadata requests are chunked to eight repositories", async () => {
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "batch-test-token";
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-graphql-batch-"));
  const aliasesPerRequest = [];
  try {
    globalThis.fetch = async (url, options) => {
      if (String(url) !== "https://api.github.com/graphql") {
        return new Response("missing", { status: 404 });
      }
      const body = JSON.parse(String(options?.body ?? "{}"));
      aliasesPerRequest.push((String(body.query).match(/a\d+:/g) ?? []).length);
      return Response.json({ data: {} });
    };
    const manager = new PluginManager(userData);
    try {
      await manager.load();
      const urls = Array.from({ length: 17 }, (_value, index) => (
        `https://github.com/example/canvastty-plugin-batch-${index + 1}`
      ));
      const manifests = await manager.previewManifests(urls);
      assert.equal(manifests.size, 0);
      assert.deepEqual(aliasesPerRequest, [8, 8, 1, 8, 8, 1]);
    } finally {
      await manager.dispose();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    await rm(userData, { recursive: true, force: true });
  }
});

test("platforms: validation accepts canvastty and multi-platform declarations", () => {
  const base = { ...manifest, id: "com.example.platform-ok" };
  const single = validatePluginManifest({ ...base, platforms: ["canvastty"] });
  assert.deepEqual(single.platforms, ["canvastty"]);
  const multi = validatePluginManifest({ ...base, platforms: ["canvastty", "canvastty-superkruto"] });
  assert.deepEqual(multi.platforms, ["canvastty", "canvastty-superkruto"]);
  const legacy = validatePluginManifest({ ...base });
  assert.equal(legacy.platforms, undefined);
});

test("platforms: validation rejects empty or malformed declarations", () => {
  const base = { ...manifest, id: "com.example.platform-bad" };
  assert.throws(() => validatePluginManifest({ ...base, platforms: [] }), /non-empty array/);
  assert.throws(() => validatePluginManifest({ ...base, platforms: ["UPPER"] }), /lowercase/);
  assert.throws(() => validatePluginManifest({ ...base, platforms: [42] }), /lowercase/);
  assert.throws(() => validatePluginManifest({ ...base, platforms: ["canvastty ", "canvastty"] }), /lowercase/);
  assert.throws(() => validatePluginManifest({ ...base, platforms: ["canvastty", "canvastty"] }), /duplicated/);
});

test("direct install and update enforce platform, while minHostVersion stays informational", async () => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-platform-policy-"));
  const fixture = await mkdtemp(join(tmpdir(), "canvastty-plugin-platform-policy-fixture-"));
  let platforms = ["canvastty"];
  const writeFixture = async (version, minHostVersion = "99.0.0") => {
    await rm(fixture, { recursive: true, force: true });
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, "app.html"), `<h1>${version}</h1>`);
    await writeFile(join(fixture, "canvastty.plugin.json"), JSON.stringify({
      apiVersion: 1,
      id: "com.example.platform-policy",
      name: "Platform policy",
      version,
      description: "Platform policy fixture.",
      platforms,
      minHostVersion,
      permissions: [],
      contributions: [{
        id: "app",
        kind: "canvas-app",
        title: "App",
        entry: "app.html",
        defaultSize: { width: 480, height: 300 }
      }]
    }));
  };
  await writeFixture("1.0.0");
  const manager = new PluginManager(userData, async (_url, destination) => {
    await cp(fixture, destination, { recursive: true });
  });
  try {
    await manager.load();
    const preview = await manager.previewInstall("https://github.com/example/platform-policy");
    assert.equal(preview.manifest.minHostVersion, "99.0.0");
    await manager.install(preview.token);

    platforms = ["another-host"];
    await writeFixture("2.0.0");
    await assert.rejects(
      () => manager.updatePlugin("com.example.platform-policy"),
      /does not support the canvastty platform/
    );
    assert.equal(manager.list()[0].manifest.version, "1.0.0");

    await manager.uninstall("com.example.platform-policy");
    await assert.rejects(
      () => manager.previewInstall("https://github.com/example/platform-policy"),
      /does not support the canvastty platform/
    );
  } finally {
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});

test("minHostVersion: validation accepts semver and rejects malformed", () => {
  const base = { ...manifest, id: "com.example.host-version" };
  const ok = validatePluginManifest({ ...base, minHostVersion: "1.2.0" });
  assert.equal(ok.minHostVersion, "1.2.0");
  assert.throws(() => validatePluginManifest({ ...base, minHostVersion: "abc" }), /semantic version/);
  assert.throws(() => validatePluginManifest({ ...base, minHostVersion: "1.2" }), /semantic version/);
  const legacy = validatePluginManifest({ ...base });
  assert.equal(legacy.minHostVersion, undefined);
});

test("reads a metadata/ manifest when present in the package", async () => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-metadata-read-"));
  const fixture = await mkdtemp(join(tmpdir(), "canvastty-plugin-metadata-fixture-"));
  const metadataManifest = {
    ...manifest,
    id: "com.example.metadata-first",
    name: "Metadata first",
    version: "2.1.0",
    platforms: ["canvastty"]
  };
  await mkdir(join(fixture, "metadata"), { recursive: true });
  await mkdir(join(fixture, "apps"), { recursive: true });
  await mkdir(join(fixture, "widgets"), { recursive: true });
  await mkdir(join(fixture, "windows"), { recursive: true });
  await writeFile(join(fixture, "metadata", "canvastty.plugin.json"), JSON.stringify(metadataManifest));
  await writeFile(join(fixture, "apps", "notes.html"), "<h1>Metadata</h1>");
  await writeFile(join(fixture, "widgets", "clock.html"), "<h1>Clock</h1>");
  await writeFile(join(fixture, "windows", "focus.html"), "<h1>Focus</h1>");

  const manager = new PluginManager(userData, async (_url, destination) => {
    await cp(fixture, destination, { recursive: true });
  });
  try {
    await manager.load();
    const preview = await manager.previewInstall("https://github.com/example/metadata-first");
    assert.equal(preview.manifest.id, "com.example.metadata-first");
    assert.equal(preview.manifest.version, "2.1.0");
    assert.deepEqual(preview.manifest.platforms, ["canvastty"]);
    const installed = await manager.install(preview.token);
    // The installed plugin manifest lives in metadata/ inside the package.
    const onDisk = JSON.parse(await readFile(
      join(userData, "plugins", "com.example.metadata-first", "metadata", "canvastty.plugin.json"),
      "utf8"
    ));
    assert.equal(onDisk.id, "com.example.metadata-first");
    assert.deepEqual(installed.manifest.platforms, ["canvastty"]);
  } finally {
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});

test("filters showcase results by declared platform", async () => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-platform-filter-"));
  const manager = new PluginManager(userData);
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    await manager.load();
    // Two repos: one supports canvastty, the other only canvastty-superkruto.
    const canvasttyManifest = { ...manifest, id: "com.example.plat-ok", version: "1.0.0", platforms: ["canvastty"] };
    const foreignManifest = { ...manifest, id: "com.example.plat-foreign", version: "1.0.0", platforms: ["canvastty-superkruto"] };
    const repos = {
      "canvastty-plugin-ok": canvasttyManifest,
      "canvastty-plugin-foreign": foreignManifest
    };
    let metadataCalls = 0;
    globalThis.fetch = async (url) => {
      const text = String(url);
      if (text.startsWith("https://api.github.com/")) {
        metadataCalls += 1;
        // First call is the showcase search; the rest are branch/metadata.
        if (metadataCalls === 1) {
          return Response.json({ total_count: 2, items: [
            { full_name: "example/canvastty-plugin-ok", description: "ok" },
            { full_name: "example/canvastty-plugin-foreign", description: "foreign" }
          ] });
        }
        return Response.json({ default_branch: "main" });
      }
      // raw.githubusercontent.com: return the manifest from repo metadata.
      const match = text.match(/example\/(canvastty-plugin-[^/]+)\//);
      const repo = match?.[1];
      const repoManifest = repo ? repos[repo] : undefined;
      if (!repoManifest) return new Response("not found", { status: 404 });
      return Response.json(repoManifest);
    };

    const results = await manager.listShowcasePlugins();
    assert.equal(results.length, 1);
    assert.equal(results[0].fullName, "example/canvastty-plugin-ok");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
  }
});

function tarArchive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, content.length);
    writeOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = entry.type.charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0;
    header[155] = 32;
    blocks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1_024));
  return Buffer.concat(blocks);
}

function writeOctal(header, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  header.write(text, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
