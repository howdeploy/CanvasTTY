import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFileTree,
  flattenFileTree,
  matchQuickOpen,
  orderFileEntries,
  toggleExpandedFolder
} from "../src/renderer/src/features/files/fileTree.ts";
import {
  classifyFileRead,
  formatFileSize,
  resolveActiveFileRead
} from "../src/renderer/src/features/files/fileViewer.ts";

const dir = (name, relativePath = name) => ({ name, relativePath, kind: "directory", size: null });
const file = (name, relativePath = name, size = 10) => ({ name, relativePath, kind: "file", size });

test("orders directories before files and names case-insensitively", () => {
  assert.deepEqual(
    orderFileEntries([
      file("b.txt"),
      dir("Zeta"),
      file("a.txt"),
      dir("alpha")
    ]).map((entry) => `${entry.kind}:${entry.name}`),
    ["directory:alpha", "directory:Zeta", "file:a.txt", "file:b.txt"]
  );
});

test("orders the same name by exact case as a stable tiebreak", () => {
  assert.deepEqual(
    orderFileEntries([file("Beta"), file("alpha"), file("Alpha")]).map((entry) => entry.name),
    ["Alpha", "alpha", "Beta"]
  );
});

test("merges loaded directory children without mutating unloaded directories", () => {
  const tree = buildFileTree(
    [file("readme.md"), dir("src"), dir(".git")],
    {
      src: [file("main.ts", "src/main.ts"), dir("components", "src/components")],
      "src/components": [file("Button.tsx", "src/components/Button.tsx")]
    }
  );

  assert.deepEqual(tree, [
    { entry: dir(".git"), children: null },
    {
      entry: dir("src"),
      children: [
        {
          entry: dir("components", "src/components"),
          children: [
            { entry: file("Button.tsx", "src/components/Button.tsx"), children: null }
          ]
        },
        { entry: file("main.ts", "src/main.ts"), children: null }
      ]
    },
    { entry: file("readme.md"), children: null }
  ]);
});

test("a loaded but empty directory keeps an empty children array", () => {
  assert.deepEqual(buildFileTree([dir("empty")], { empty: [] }), [
    { entry: dir("empty"), children: [] }
  ]);
});

test("toggling an expanded folder adds, removes, and never mutates the input", () => {
  const original = ["src", "docs"];
  assert.deepEqual(toggleExpandedFolder(original, "src/components"), ["src", "docs", "src/components"]);
  assert.deepEqual(toggleExpandedFolder(original, "src"), ["docs"]);
  assert.deepEqual(original, ["src", "docs"]);
});

test("flattens only expanded, loaded directories with correct depth", () => {
  const tree = buildFileTree(
    [file("readme.md"), dir("src"), dir(".git")],
    {
      src: [file("main.ts", "src/main.ts"), dir("components", "src/components")],
      "src/components": [file("Button.tsx", "src/components/Button.tsx")]
    }
  );

  assert.deepEqual(
    flattenFileTree(tree, ["src"]).map((row) => `${row.depth}:${row.entry.name}`),
    ["0:.git", "0:src", "1:components", "1:main.ts", "0:readme.md"]
  );

  assert.deepEqual(
    flattenFileTree(tree, ["src", "src/components"]).map((row) => `${row.depth}:${row.entry.name}`),
    ["0:.git", "0:src", "1:components", "2:Button.tsx", "1:main.ts", "0:readme.md"]
  );
});

test("expanded directories without loaded children show no child rows", () => {
  const tree = buildFileTree([dir(".git")], {});
  const rows = flattenFileTree(tree, [".git"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isExpanded, true);
  assert.equal(rows[0].hasLoadedChildren, false);
  assert.equal(rows[0].depth, 0);
});

test("quick open ranks exact, prefix, substring, and path-only matches", () => {
  assert.deepEqual(
    matchQuickOpen(["main", "main.ts", "src/main"], "main"),
    ["main", "src/main", "main.ts"]
  );
  assert.deepEqual(
    matchQuickOpen(["src/util/main-helper.ts", "src/main.ts"], "util"),
    ["src/util/main-helper.ts"]
  );
});

test("quick open is case-insensitive and rejects empty or unmatched queries", () => {
  assert.deepEqual(matchQuickOpen(["src/components/Button.tsx"], "BUTTON"), ["src/components/Button.tsx"]);
  assert.deepEqual(matchQuickOpen(["a.txt"], "   "), []);
  assert.deepEqual(matchQuickOpen(["a.txt"], "zzz"), []);
});

test("formats byte sizes with powers of 1024", () => {
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(-5), "0 B");
  assert.equal(formatFileSize(900), "900 B");
  assert.equal(formatFileSize(1024), "1 KB");
  assert.equal(formatFileSize(1536), "1.5 KB");
  assert.equal(formatFileSize(1048576), "1 MB");
  assert.equal(formatFileSize(10485760), "10 MB");
});

test("classifies a truncated text read with a size label", () => {
  assert.deepEqual(
    classifyFileRead({ kind: "text", content: "hello", truncated: true, size: 2048 }),
    {
      kind: "text",
      renderKind: "plain",
      content: "hello",
      truncated: true,
      size: 2048,
      sizeLabel: "2 KB",
      language: null,
      highlightable: true,
      richDisabled: false
    }
  );
});

test("classifies an image read with its data URL and media type", () => {
  assert.deepEqual(
    classifyFileRead({
      kind: "image",
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,AAAA",
      size: 3072
    }),
    {
      kind: "image",
      renderKind: "image",
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,AAAA",
      size: 3072,
      sizeLabel: "3 KB"
    }
  );
});

test("classifies unsupported reads with a reason label and carries no bytes", () => {
  assert.deepEqual(
    classifyFileRead({ kind: "unsupported", reason: "binary" }),
    { kind: "unsupported", renderKind: "unsupported", reason: "binary", reasonLabel: "Binary file" }
  );
  assert.deepEqual(
    classifyFileRead({ kind: "unsupported", reason: "not-permitted" }),
    {
      kind: "unsupported",
      renderKind: "unsupported",
      reason: "not-permitted",
      reasonLabel: "File type not permitted"
    }
  );
  assert.deepEqual(
    classifyFileRead({ kind: "unsupported", reason: "unavailable" }),
    {
      kind: "unsupported",
      renderKind: "unsupported",
      reason: "unavailable",
      reasonLabel: "File unavailable"
    }
  );
});

test("classifies a too-large read with its size label", () => {
  assert.deepEqual(
    classifyFileRead({ kind: "too-large", reason: "too-large", size: 10485760 }),
    {
      kind: "too-large",
      renderKind: "too-large",
      reason: "too-large",
      size: 10485760,
      sizeLabel: "10 MB"
    }
  );
});

test("classifies a small recognized-language file as highlightable code", () => {
  assert.deepEqual(
    classifyFileRead({ kind: "text", content: "const x = 1;", truncated: false, size: 12 }, "src/a.ts"),
    {
      kind: "text",
      renderKind: "code",
      content: "const x = 1;",
      truncated: false,
      size: 12,
      sizeLabel: "12 B",
      language: "typescript",
      highlightable: true,
      richDisabled: false
    }
  );
});

test("classifies a markdown file as markdown when under the size threshold", () => {
  const model = classifyFileRead(
    { kind: "text", content: "# Hi", truncated: false, size: 4 },
    "docs/readme.md"
  );
  assert.equal(model.renderKind, "markdown");
  assert.equal(model.language, null);
  assert.equal(model.highlightable, true);
  assert.equal(model.richDisabled, false);
});

test("classifies unknown and extensionless text as plain without a note", () => {
  for (const path of ["notes.txt", "LICENSE", ""]) {
    const model = classifyFileRead(
      { kind: "text", content: "hello", truncated: false, size: 5 },
      path
    );
    assert.equal(model.renderKind, "plain");
    assert.equal(model.language, null);
    assert.equal(model.highlightable, true);
    assert.equal(model.richDisabled, false);
  }
});

test("disables rich rendering for a recognized language above the size threshold", () => {
  const size = 300 * 1024;
  const model = classifyFileRead(
    { kind: "text", content: "const x = 1;", truncated: false, size },
    "src/big.ts"
  );
  assert.equal(model.renderKind, "plain");
  assert.equal(model.language, "typescript");
  assert.equal(model.highlightable, false);
  assert.equal(model.richDisabled, true);
});

test("disables rich rendering for markdown above the size threshold", () => {
  const size = 300 * 1024;
  const model = classifyFileRead(
    { kind: "text", content: "# Big", truncated: false, size },
    "docs/big.md"
  );
  assert.equal(model.renderKind, "plain");
  assert.equal(model.language, null);
  assert.equal(model.highlightable, false);
  assert.equal(model.richDisabled, true);
});

test("resolves a read only for the exact path it was bound to", () => {
  const binding = {
    relativePath: "src/main.ts",
    result: { kind: "text", content: "x", truncated: false, size: 1 }
  };
  assert.deepEqual(resolveActiveFileRead("src/main.ts", binding), {
    kind: "text",
    renderKind: "code",
    content: "x",
    truncated: false,
    size: 1,
    sizeLabel: "1 B",
    language: "typescript",
    highlightable: true,
    richDisabled: false
  });
});

test("a stale or missing read binding resolves to null so no old content can render", () => {
  const binding = {
    relativePath: "old.txt",
    result: { kind: "text", content: "old", truncated: false, size: 3 }
  };
  assert.equal(resolveActiveFileRead("new.txt", binding), null);
  assert.equal(resolveActiveFileRead(null, binding), null);
  assert.equal(resolveActiveFileRead("old.txt", null), null);
});
