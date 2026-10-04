import assert from "node:assert/strict";
import test from "node:test";
import {
  isEmbeddedImageSource,
  isOpenableLink
} from "../src/renderer/src/features/files/fileLinks.ts";

test("isOpenableLink accepts absolute http and https URLs", () => {
  assert.equal(isOpenableLink("https://example.com"), true);
  assert.equal(isOpenableLink("http://example.com/path?q=1#frag"), true);
});

test("isOpenableLink rejects non-http(s) and non-absolute links", () => {
  assert.equal(isOpenableLink("javascript:alert(1)"), false);
  assert.equal(isOpenableLink("mailto:user@example.com"), false);
  assert.equal(isOpenableLink("#anchor"), false);
  assert.equal(isOpenableLink("a/b"), false);
  assert.equal(isOpenableLink("data:text/html,hi"), false);
  assert.equal(isOpenableLink("ftp://example.com"), false);
  assert.equal(isOpenableLink(null), false);
  assert.equal(isOpenableLink(undefined), false);
  assert.equal(isOpenableLink("http://"), false);
});

test("isEmbeddedImageSource accepts only data:image sources", () => {
  assert.equal(isEmbeddedImageSource("data:image/png;base64,AAAA"), true);
  assert.equal(isEmbeddedImageSource("https://example.com/x.png"), false);
  assert.equal(isEmbeddedImageSource("relative/x.png"), false);
  assert.equal(isEmbeddedImageSource(""), false);
  assert.equal(isEmbeddedImageSource(null), false);
});
