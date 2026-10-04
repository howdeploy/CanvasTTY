import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createMarkdownElement } from "../src/renderer/src/features/files/markdownPipeline.ts";

test("strips a script element from rendered markdown", () => {
  const html = renderToStaticMarkup(createMarkdownElement("before\n\n<script>alert(1)</script>\n\nafter"));
  assert.ok(!html.includes("<script"), `expected no <script in: ${html}`);
});

test("strips an onerror attribute from raw HTML", () => {
  const html = renderToStaticMarkup(createMarkdownElement('<img src=x onerror="alert(1)">'));
  assert.ok(!/onerror/i.test(html), `expected no onerror in: ${html}`);
});

test("renders a javascript: link without a javascript: href", () => {
  const html = renderToStaticMarkup(createMarkdownElement("[link](javascript:alert(1))"));
  assert.ok(!/javascript:/i.test(html), `expected no javascript: in: ${html}`);
});

test("renders a normal https link with its href", () => {
  const html = renderToStaticMarkup(createMarkdownElement("[site](https://example.com)"));
  assert.match(html, /https:\/\/example\.com/);
});

test("keeps a data: image and drops a remote image", () => {
  const remote = renderToStaticMarkup(createMarkdownElement("![remote](https://evil.example/x.png)"));
  assert.ok(!remote.includes("evil.example"), `remote host leaked: ${remote}`);
  assert.ok(!remote.includes('src="https://'), `remote src leaked: ${remote}`);

  const embedded = renderToStaticMarkup(
    createMarkdownElement("![d](data:image/png;base64,AAAA)")
  );
  assert.match(embedded, /data:image\/png/);
});
