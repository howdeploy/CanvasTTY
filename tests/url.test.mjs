import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUrl } from "../src/renderer/src/lib/url.ts";

test("bare domains get https", () => {
  assert.equal(normalizeUrl("google.com"), "https://google.com/");
  assert.equal(normalizeUrl("  news.ycombinator.com "), "https://news.ycombinator.com/");
});

test("explicit schemes survive", () => {
  assert.equal(normalizeUrl("http://example.com/x"), "http://example.com/x");
  assert.equal(normalizeUrl("https://example.com/a b".replace(" ", "%20")), "https://example.com/a%20b");
});

test("paths and queries are preserved", () => {
  assert.equal(normalizeUrl("example.com/docs?page=2"), "https://example.com/docs?page=2");
});

test("loopback hosts default to http", () => {
  assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000/");
  assert.equal(normalizeUrl("127.0.0.1:8080/dev"), "http://127.0.0.1:8080/dev");
});

test("explicit http on loopback stays http", () => {
  assert.equal(normalizeUrl("http://localhost:5173"), "http://localhost:5173/");
});

test("non-web schemes are rejected", () => {
  assert.equal(normalizeUrl("ftp://example.com"), null);
  assert.equal(normalizeUrl("file:///etc/passwd"), null);
});

test("empty and broken input is rejected", () => {
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl("   "), null);
  assert.equal(normalizeUrl("http://"), null);
});
