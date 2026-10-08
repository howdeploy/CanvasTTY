import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMON_LANGUAGES,
  MARKDOWN_EXTENSIONS,
  detectFileLanguage,
  isMarkdownPath
} from "../src/renderer/src/features/files/fileLanguage.ts";

test("detects known extensions case-insensitively", () => {
  assert.equal(detectFileLanguage("component.tsx"), "typescript");
  assert.equal(detectFileLanguage("script.py"), "python");
  assert.equal(detectFileLanguage("data.json"), "json");
  assert.equal(detectFileLanguage("styles.css"), "css");
  assert.equal(detectFileLanguage("page.html"), "xml");
  assert.equal(detectFileLanguage("config.yaml"), "yaml");
  assert.equal(detectFileLanguage("run.sh"), "bash");
});

test("strips directories before reading the extension", () => {
  assert.equal(detectFileLanguage("src/components/Button.tsx"), "typescript");
  assert.equal(detectFileLanguage("a.dir/notes.md"), null);
});

test("recognizes markdown extensions and excludes them from language detection", () => {
  assert.equal(isMarkdownPath("notes.md"), true);
  assert.equal(isMarkdownPath("README.markdown"), true);
  assert.equal(isMarkdownPath("docs/guide.mdown"), true);
  assert.equal(isMarkdownPath("docs/guide.mkd"), true);
  assert.equal(detectFileLanguage("notes.md"), null);
  assert.equal(detectFileLanguage("README.markdown"), null);
});

test("detection is case-insensitive on the extension", () => {
  assert.equal(detectFileLanguage("MAIN.TS"), "typescript");
  assert.equal(isMarkdownPath("readme.MD"), true);
  assert.equal(detectFileLanguage("readme.MD"), null);
  assert.equal(detectFileLanguage("Data.JSON"), "json");
});

test("unknown or missing extensions return null", () => {
  assert.equal(detectFileLanguage("archive.xyz"), null);
  assert.equal(detectFileLanguage("Makefile"), null);
  assert.equal(detectFileLanguage("LICENSE"), null);
  assert.equal(detectFileLanguage("trailingdot."), null);
  assert.equal(isMarkdownPath("archive.xyz"), false);
  assert.equal(isMarkdownPath("Makefile"), false);
});

test("COMMON_LANGUAGES is sorted, de-duplicated, and covers every mapped language", () => {
  const produced = new Set();
  const samples = [
    "a.ts",
    "a.tsx",
    "a.js",
    "a.jsx",
    "a.mjs",
    "a.cjs",
    "a.py",
    "a.json",
    "a.jsonc",
    "a.css",
    "a.scss",
    "a.html",
    "a.htm",
    "a.xml",
    "a.svg",
    "a.yaml",
    "a.yml",
    "a.sh",
    "a.bash",
    "a.zsh",
    "a.go",
    "a.rs",
    "a.java",
    "a.c",
    "a.h",
    "a.cpp",
    "a.cc",
    "a.cxx",
    "a.hpp",
    "a.cs",
    "a.rb",
    "a.php",
    "a.sql",
    "a.toml",
    "a.kt",
    "a.swift",
    "a.lua",
    "a.r",
    "a.pl",
    "a.diff",
    "a.patch",
    "a.makefile"
  ];
  for (const sample of samples) {
    const id = detectFileLanguage(sample);
    assert.ok(id !== null, `expected a language id for ${sample}`);
    produced.add(id);
  }
  for (const id of produced) {
    assert.ok(COMMON_LANGUAGES.includes(id), `COMMON_LANGUAGES missing ${id}`);
  }
  assert.equal(COMMON_LANGUAGES.includes("markdown"), false);
  assert.equal(new Set(COMMON_LANGUAGES).size, COMMON_LANGUAGES.length);
  assert.deepEqual(COMMON_LANGUAGES, [...COMMON_LANGUAGES].sort());
  assert.equal(MARKDOWN_EXTENSIONS.length, 4);
});
