import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { terminalFileDropText } from "../src/shared/terminalFileDrop.ts";

test("file drops preserve spaces, Unicode and shell syntax as literal POSIX arguments", () => {
  const paths = ["/videos/моё видео.mp4", "/videos/it's $HOME; $(printf injected) `pwd`.mp4"];
  for (const platform of ["linux", "darwin"]) {
    const text = terminalFileDropText(paths, platform);
    assert.equal(text.endsWith(" "), true);
    assert.doesNotMatch(text, /[\r\n]/);
    if (process.platform !== "win32") {
      const result = spawnSync("/bin/sh", ["-c", `printf '%s\\0' ${text}`], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.split("\0").slice(0, -1), paths);
    }
  }
});

test("Windows paths use literal PowerShell quoting including apostrophes", () => {
  assert.equal(
    terminalFileDropText(["C:\\Videos\\it's $name.mp4", "\\\\server\\share\\video 2.mp4"], "win32"),
    "'C:\\Videos\\it''s $name.mp4' '\\\\server\\share\\video 2.mp4' "
  );
});

test("unavailable paths and control characters reject the complete drop", () => {
  for (const paths of [[], [""], ["/valid.mp4", ""], ["/line\nbreak"], ["/tab\tname"], ["/escape\x1b[201~"], [null]]) {
    assert.throws(() => terminalFileDropText(paths, "linux"));
  }
});

test("native file drops use the preload bridge and xterm paste without submitting", async () => {
  const preload = await readFile(new URL("../src/preload/index.ts", import.meta.url), "utf8");
  const card = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  assert.match(preload, /webUtils\.getPathForFile\(file\)/);
  assert.match(card, /onDragOver=\{[\s\S]*?event\.preventDefault\(\)/);
  assert.match(card, /onDrop=\{[\s\S]*?sessionExited\.current \|\| renaming[\s\S]*?fileDropText\(Array\.from\(event\.dataTransfer\.files\)\)[\s\S]*?terminal\.paste\(text\)/);
});

test("drop handler consumes native file drops once and leaves other drag payloads alone", async () => {
  const card = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  const handler = card.match(/onDrop=\{([\s\S]*?)\n      \}\}/)?.[1];
  assert.ok(handler);
  const pasted = [];
  const errors = [];
  const selected = [];
  const sessionExited = { current: false };
  let prevented = 0;
  let stopped = 0;
  let focused = 0;
  const file = { name: "video.mp4" };
  const onDrop = runInNewContext(`(${handler}\n})`, {
    window: { canvasTTY: { terminal: { fileDropText: (files) => {
      assert.equal(files[0], file);
      return terminalFileDropText(["/videos/my video.mp4"], "linux");
    } } } },
    terminalRef: { current: {
      focus: () => focused++,
      paste: (text) => pasted.push(text),
      write: (text) => errors.push(text)
    } },
    sessionExited,
    renaming: false,
    session: { id: "drop-target" },
    onSelect: (id) => selected.push(id),
    locale: "en",
    t: () => "Drop failed"
  });
  const event = {
    dataTransfer: { types: ["Files"], files: [file] },
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++
  };
  onDrop(event);
  assert.deepEqual(pasted, ["'/videos/my video.mp4' "]);
  assert.deepEqual(selected, ["drop-target"]);
  assert.equal(focused, 1);
  assert.deepEqual(errors, []);
  sessionExited.current = true;
  onDrop(event);
  assert.equal(pasted.length, 1);
  assert.equal(prevented, 2);
  assert.equal(stopped, 2);
  onDrop({ ...event, dataTransfer: { types: ["text/plain"], files: [] } });
  assert.equal(prevented, 2);
  assert.equal(stopped, 2);
});
