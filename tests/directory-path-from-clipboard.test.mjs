import assert from "node:assert/strict";
import test from "node:test";
import { directoryPathFromClipboard } from "../src/renderer/src/lib/directoryPathFromClipboard.ts";

test("skips GNOME clipboard markers and copy/cut verbs", () => {
  for (const verb of ["copy", "cut"]) {
    for (const newline of ["\n", "\r\n", "\r"]) {
      assert.equal(directoryPathFromClipboard([
        "x-special/nautilus-clipboard", verb, "file:///home/runner/project"
      ].join(newline)), "/home/runner/project");
    }
  }
});

test("selects the first path from URI lists and ignores comments and metadata", () => {
  assert.equal(directoryPathFromClipboard("# folders\n\ncopy\nfile:///first\nfile:///second"), "/first");
  assert.equal(directoryPathFromClipboard("metadata\n/home/runner/project\n/second"), "/home/runner/project");
  assert.equal(directoryPathFromClipboard("copy\n\"/home/runner/my project\""), "/home/runner/my project");
});

test("strips paired quotes and preserves spaces in paths", () => {
  for (const quote of ['"', "'"]) {
    assert.equal(directoryPathFromClipboard(`  ${quote}/my project${quote}  `), "/my project");
  }
  assert.equal(directoryPathFromClipboard("/my project"), "/my project");
});

test("accepts Windows drive paths and UNC paths", () => {
  assert.equal(directoryPathFromClipboard("C:\\Users\\me\\project"), "C:\\Users\\me\\project");
  assert.equal(directoryPathFromClipboard("copy\nD:/project"), "D:/project");
  assert.equal(directoryPathFromClipboard("\\\\server\\share\\project"), "\\\\server\\share\\project");
});

test("decodes file URLs including Windows drives and network shares", () => {
  assert.equal(directoryPathFromClipboard('"file:///home/my%20project"'), "/home/my project");
  assert.equal(directoryPathFromClipboard("FILE:///C:/my%20project"), "C:/my project");
  assert.equal(directoryPathFromClipboard("file://server/share/my%20project"), "//server/share/my project");
});

test("rejects empty, metadata-only, non-path, and malformed URL payloads", () => {
  for (const text of ["", "  ", "''", "x-special/nautilus-clipboard\ncopy", "# /comment", "hello", "https://example.com", "file:///bad%zz", "file://["]) {
    assert.equal(directoryPathFromClipboard(text), null, text);
  }
});
