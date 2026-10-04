import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  highlightCode,
  isRegisteredLanguage
} from "../src/renderer/src/features/files/codeHighlight.ts";
import { COMMON_LANGUAGES } from "../src/renderer/src/features/files/fileLanguage.ts";

test("every language id produced by detection is registered with lowlight", () => {
  for (const id of COMMON_LANGUAGES) {
    assert.equal(isRegisteredLanguage(id), true, `expected ${id} to be registered`);
  }
});

test("highlights recognized languages and returns null for unknown ones", () => {
  const typescript = highlightCode("const x: number = 1", "typescript");
  assert.notEqual(typescript, null);
  assert.match(renderToStaticMarkup(typescript), /hljs-keyword/);

  assert.notEqual(highlightCode("{}", "json"), null);

  assert.equal(highlightCode("const x = 1", "not-a-real-language"), null);
  assert.equal(highlightCode("x", null), null);
});

test("unknown and empty languages are reported as unregistered", () => {
  assert.equal(isRegisteredLanguage("definitely-not-a-language"), false);
  assert.equal(isRegisteredLanguage(null), false);
  assert.equal(isRegisteredLanguage(undefined), false);
  assert.equal(isRegisteredLanguage(""), false);
});
