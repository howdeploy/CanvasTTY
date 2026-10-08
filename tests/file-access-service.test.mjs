import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { FileAccessService } from "../src/main/services/FileAccessService.ts";

async function makeTempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

function createService({ cwd, limits } = {}) {
  return new FileAccessService({
    resolveSessionCwd: (sessionId) => (sessionId === "session-1" ? cwd : undefined),
    limits
  });
}

test("registers a session root from the injected cwd lookup and hides the absolute path", async () => {
  const root = await makeTempDir("canvastty-files-session-");
  try {
    const service = createService({ cwd: root });
    const descriptor = service.registerSessionRoot("session-1");
    assert.ok(descriptor);
    assert.equal(descriptor.rootType, "session");
    assert.equal(descriptor.available, true);
    assert.equal(descriptor.label, basename(root));
    assert.equal("path" in descriptor, false);
    assert.equal(JSON.stringify(descriptor).includes(root), false);
    assert.deepEqual(service.listRoots(), [descriptor]);
    assert.equal(service.registerSessionRoot("missing-session"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registers a folder root and resolves it through registerRoot", async () => {
  const root = await makeTempDir("canvastty-files-folder-");
  try {
    const service = createService();
    const descriptor = service.registerFolderRoot(root);
    assert.equal(descriptor.rootType, "folder");
    assert.equal(descriptor.available, true);
    assert.equal(descriptor.label, basename(root));

    const viaReference = await service.registerRoot({ rootType: "folder" });
    assert.equal(viaReference, null);

    assert.throws(() => service.registerFolderRoot(join(root, "nope")), /unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exposes a canonical folder path only on folder root descriptors", async () => {
  const root = await makeTempDir("canvastty-files-descriptor-path-");
  try {
    const service = createService({ cwd: root });
    const session = service.registerSessionRoot("session-1");
    assert.equal("folderPath" in session, false);
    assert.equal(JSON.stringify(session).includes(root), false);

    const folder = service.registerFolderRoot(root);
    assert.equal(folder.folderPath, realpathSync(root));
    assert.equal(service.listRoots().find((entry) => entry.rootId === folder.rootId)?.folderPath, realpathSync(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restores a persisted folder root by path through registerRoot", async () => {
  const root = await makeTempDir("canvastty-files-restore-");
  try {
    const service = createService();
    const descriptor = await service.registerRoot({ rootType: "folder", folderPath: root });
    assert.ok(descriptor);
    assert.equal(descriptor.rootType, "folder");
    assert.equal(descriptor.available, true);
    assert.equal(descriptor.label, basename(root));

    const missing = await service.registerRoot({ rootType: "folder", folderPath: join(root, "nope") });
    assert.equal(missing, null);

    const pathless = await service.registerRoot({ rootType: "folder" });
    assert.equal(pathless, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects absolute paths and parent traversal on read", async () => {
  const root = await makeTempDir("canvastty-files-traversal-");
  try {
    const service = createService({ cwd: root });
    const { rootId } = service.registerSessionRoot("session-1");
    await writeFile(join(root, "inside.txt"), "inside");

    assert.deepEqual(await service.read(rootId, "/etc/passwd"), {
      kind: "unsupported",
      reason: "not-permitted"
    });
    assert.deepEqual(await service.read(rootId, "../escape.txt"), {
      kind: "unsupported",
      reason: "not-permitted"
    });
    assert.deepEqual(await service.read(rootId, "sub/../../escape.txt"), {
      kind: "unsupported",
      reason: "not-permitted"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symlinks whose real target escapes the root", async () => {
  const root = await makeTempDir("canvastty-files-symlink-root-");
  const outside = await makeTempDir("canvastty-files-symlink-outside-");
  try {
    const service = createService({ cwd: root });
    const { rootId } = service.registerSessionRoot("session-1");
    await writeFile(join(outside, "secret.txt"), "top secret");
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
    await symlink(outside, join(root, "escape-dir"));

    assert.deepEqual(await service.read(rootId, "escape.txt"), {
      kind: "unsupported",
      reason: "not-permitted"
    });
    assert.deepEqual(await service.read(rootId, "escape-dir/secret.txt"), {
      kind: "unsupported",
      reason: "not-permitted"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects non-regular files such as directories", async () => {
  const root = await makeTempDir("canvastty-files-nonregular-");
  try {
    const service = createService({ cwd: root });
    const { rootId } = service.registerSessionRoot("session-1");
    await mkdir(join(root, "subdir"));
    assert.deepEqual(await service.read(rootId, "subdir"), {
      kind: "unsupported",
      reason: "not-permitted"
    });
    assert.deepEqual(await service.read(rootId, ""), {
      kind: "unsupported",
      reason: "not-permitted"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lists immediate entries with directories before files and file sizes", async () => {
  const root = await makeTempDir("canvastty-files-list-");
  try {
    const service = createService({ cwd: root });
    const { rootId } = service.registerSessionRoot("session-1");
    await mkdir(join(root, "gamma"));
    await mkdir(join(root, "zeta"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "alpha.txt"), "hello");
    await writeFile(join(root, "beta.txt"), "hi");
    await writeFile(join(root, "nested", "child.txt"), "child");

    const entries = await service.list(rootId, "");
    assert.deepEqual(entries, [
      { name: "gamma", relativePath: "gamma", kind: "directory", size: null },
      { name: "nested", relativePath: "nested", kind: "directory", size: null },
      { name: "zeta", relativePath: "zeta", kind: "directory", size: null },
      { name: "alpha.txt", relativePath: "alpha.txt", kind: "file", size: 5 },
      { name: "beta.txt", relativePath: "beta.txt", kind: "file", size: 2 }
    ]);

    const nested = await service.list(rootId, "nested");
    assert.deepEqual(nested, [
      { name: "child.txt", relativePath: "nested/child.txt", kind: "file", size: 5 }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("caps directory listings at maxDirectoryEntries", async () => {
  const root = await makeTempDir("canvastty-files-list-cap-");
  try {
    const service = createService({ cwd: root, limits: { maxDirectoryEntries: 2 } });
    const { rootId } = service.registerSessionRoot("session-1");
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");
    await writeFile(join(root, "c.txt"), "c");
    assert.equal((await service.list(rootId, "")).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("throws when listing a missing directory or a bad path", async () => {
  const root = await makeTempDir("canvastty-files-list-bad-");
  try {
    const service = createService({ cwd: root });
    const { rootId } = service.registerSessionRoot("session-1");
    await assert.rejects(service.list(rootId, "missing"), /unavailable/);
    await assert.rejects(service.list(rootId, "../"), /outside|unavailable/);
    await assert.rejects(service.list(rootId, "/etc"), /outside|unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads a small UTF-8 text file", async () => {
  const root = await makeTempDir("canvastty-files-text-");
  try {
    const service = createService({ cwd: root });
    const { rootId } = service.registerSessionRoot("session-1");
    await writeFile(join(root, "notes.txt"), "hello world");
    assert.deepEqual(await service.read(rootId, "notes.txt"), {
      kind: "text",
      content: "hello world",
      truncated: false,
      size: 11
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads UTF-8 text whose final character is multi-byte", async () => {
  const root = await makeTempDir("canvastty-files-text-multibyte-");
  try {
    const service = createService({ cwd: root });
    const { rootId } = service.registerSessionRoot("session-1");
    await writeFile(join(root, "README.md"), "# Привет");
    const cyrillic = await service.read(rootId, "README.md");
    assert.equal(cyrillic.kind, "text");
    assert.equal(cyrillic.content, "# Привет");
    await writeFile(join(root, "emoji.md"), "done 😀");
    const emoji = await service.read(rootId, "emoji.md");
    assert.equal(emoji.kind, "text");
    assert.equal(emoji.content, "done 😀");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tolerates a bounded read that splits the final multi-byte code point", async () => {
  const root = await makeTempDir("canvastty-files-text-split-");
  try {
    const service = createService({ cwd: root, limits: { maxTextBytes: 3 } });
    const { rootId } = service.registerSessionRoot("session-1");
    await writeFile(join(root, "emoji.txt"), "😀");
    const result = await service.read(rootId, "emoji.txt");
    assert.equal(result.kind, "text");
    assert.equal(result.truncated, true);
    assert.equal(result.size, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("truncates oversized text and reports the observed total size", async () => {
  const root = await makeTempDir("canvastty-files-text-trunc-");
  try {
    const service = createService({ cwd: root, limits: { maxTextBytes: 4 } });
    const { rootId } = service.registerSessionRoot("session-1");
    await writeFile(join(root, "long.txt"), "abcdefghij");
    const result = await service.read(rootId, "long.txt");
    assert.equal(result.kind, "text");
    assert.equal(result.content, "abcd");
    assert.equal(result.truncated, true);
    assert.equal(result.size, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports binary content as unsupported without returning bytes", async () => {
  const root = await makeTempDir("canvastty-files-binary-");
  try {
    const service = createService({ cwd: root });
    const { rootId } = service.registerSessionRoot("session-1");
    await writeFile(join(root, "data.bin"), Buffer.from([0x68, 0x00, 0x69]));
    assert.deepEqual(await service.read(rootId, "data.bin"), {
      kind: "unsupported",
      reason: "binary"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports NUL-free binary content as unsupported", async () => {
  const root = await makeTempDir("canvastty-files-binary-nonul-");
  try {
    const service = createService({ cwd: root });
    const { rootId } = service.registerSessionRoot("session-1");
    await writeFile(join(root, "latin.bin"), Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb]));
    assert.deepEqual(await service.read(rootId, "latin.bin"), {
      kind: "unsupported",
      reason: "binary"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns an allow-listed image as a base64 data URL", async () => {
  const root = await makeTempDir("canvastty-files-image-");
  try {
    const service = createService({ cwd: root });
    const { rootId } = service.registerSessionRoot("session-1");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(join(root, "pic.png"), bytes);

    const result = await service.read(rootId, "pic.png");
    assert.equal(result.kind, "image");
    assert.equal(result.mediaType, "image/png");
    assert.equal(result.size, bytes.byteLength);
    assert.match(result.dataUrl, /^data:image\/png;base64,/);
    assert.deepEqual(
      Buffer.from(result.dataUrl.split(",")[1], "base64"),
      bytes
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports an oversized image as too large", async () => {
  const root = await makeTempDir("canvastty-files-image-large-");
  try {
    const service = createService({ cwd: root, limits: { maxImageBytes: 2 } });
    const { rootId } = service.registerSessionRoot("session-1");
    await writeFile(join(root, "big.png"), Buffer.from([1, 2, 3]));
    assert.deepEqual(await service.read(rootId, "big.png"), {
      kind: "too-large",
      reason: "too-large",
      size: 3
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a disallowed non-image binary type as unsupported binary", async () => {
  const root = await makeTempDir("canvastty-files-disallowed-");
  try {
    const service = createService({ cwd: root });
    const { rootId } = service.registerSessionRoot("session-1");
    await writeFile(join(root, "archive.zip"), Buffer.from([0x50, 0x4b, 0x00, 0x04]));
    assert.deepEqual(await service.read(rootId, "archive.zip"), {
      kind: "unsupported",
      reason: "binary"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searches file names case-insensitively and returns relative paths", async () => {
  const root = await makeTempDir("canvastty-files-search-");
  try {
    const service = createService({ cwd: root });
    const { rootId } = service.registerSessionRoot("session-1");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "README.md"), "readme");
    await writeFile(join(root, "src", "Widget.tsx"), "widget");
    await writeFile(join(root, "src", "other.ts"), "other");

    assert.deepEqual(await service.search(rootId, "widget"), {
      relativePaths: ["src/Widget.tsx"],
      truncated: false
    });
    assert.deepEqual(await service.search(rootId, "missing"), {
      relativePaths: [],
      truncated: false
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips heavy directories and symlinked directories during search", async () => {
  const root = await makeTempDir("canvastty-files-search-skip-");
  const outside = await makeTempDir("canvastty-files-search-skip-out-");
  try {
    const service = createService({ cwd: root });
    const { rootId } = service.registerSessionRoot("session-1");
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "node_modules", "find-me.txt"), "x");
    await writeFile(join(root, ".git", "find-me.txt"), "x");
    await writeFile(join(root, "dist", "find-me.txt"), "x");
    await writeFile(join(root, "src", "find-me.txt"), "x");
    await writeFile(join(outside, "find-me.txt"), "x");
    await symlink(outside, join(root, "linked"));

    assert.deepEqual(await service.search(rootId, "find-me"), {
      relativePaths: ["src/find-me.txt"],
      truncated: false
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("does not search beyond maxSearchDepth", async () => {
  const root = await makeTempDir("canvastty-files-search-depth-");
  try {
    const service = createService({ cwd: root, limits: { maxSearchDepth: 1 } });
    const { rootId } = service.registerSessionRoot("session-1");
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "match.txt"), "x");
    await writeFile(join(root, "a", "match.txt"), "x");
    await writeFile(join(root, "a", "b", "match.txt"), "x");

    assert.deepEqual(await service.search(rootId, "match"), {
      relativePaths: ["a/match.txt", "match.txt"],
      truncated: false
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("caps search results and marks the result truncated", async () => {
  const root = await makeTempDir("canvastty-files-search-cap-");
  try {
    const service = createService({ cwd: root, limits: { maxSearchResults: 1 } });
    const { rootId } = service.registerSessionRoot("session-1");
    await writeFile(join(root, "match-one.txt"), "1");
    await writeFile(join(root, "match-two.txt"), "2");
    const result = await service.search(rootId, "match");
    assert.equal(result.relativePaths.length, 1);
    assert.equal(result.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("releases a root and rejects later operations on it", async () => {
  const root = await makeTempDir("canvastty-files-release-");
  try {
    const service = createService({ cwd: root });
    const { rootId } = service.registerSessionRoot("session-1");
    await writeFile(join(root, "notes.txt"), "hello");

    service.releaseRoot(rootId);
    assert.deepEqual(service.listRoots(), []);
    assert.deepEqual(await service.read(rootId, "notes.txt"), {
      kind: "unsupported",
      reason: "not-permitted"
    });
    await assert.rejects(service.list(rootId, ""), /not registered/);
    await assert.rejects(service.search(rootId, "notes"), /not registered/);
    assert.equal(service.revalidateRoot(rootId), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a missing root as unavailable and fails re-validation", async () => {
  const root = await makeTempDir("canvastty-files-missing-");
  const service = createService();
  const descriptor = service.registerFolderRoot(root);
  await rm(root, { recursive: true, force: true });

  assert.deepEqual(await service.read(descriptor.rootId, "anything.txt"), {
    kind: "unsupported",
    reason: "unavailable"
  });
  assert.equal(service.revalidateRoot(descriptor.rootId), false);
  assert.equal(service.listRoots()[0].available, false);
});

test("rejects list and search on a root that failed re-validation", async () => {
  const root = await makeTempDir("canvastty-files-revalidate-");
  const service = createService();
  const descriptor = service.registerFolderRoot(root);
  await rm(root, { recursive: true, force: true });
  assert.equal(service.revalidateRoot(descriptor.rootId), false);

  await assert.rejects(service.list(descriptor.rootId, ""), /unavailable/);
  await assert.rejects(service.search(descriptor.rootId, "anything"), /unavailable/);
});
