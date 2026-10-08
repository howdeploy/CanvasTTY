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

test("native file drops go through a preview before paste", async () => {
  const preload = await readFile(new URL("../src/preload/index.ts", import.meta.url), "utf8");
  const card = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  const preview = await readFile(new URL("../src/renderer/src/features/workspace/WorkspaceContextPreview.tsx", import.meta.url), "utf8");
  assert.match(preload, /webUtils\.getPathForFile\(file\)/);
  assert.match(card, /onDragOver=\{[\s\S]*?event\.preventDefault\(\)/);
  assert.match(card, /onDropContext\(session\.id/);
  assert.match(preview, /outsideProject/);
  assert.match(preview, /onConfirm\(text\)/);
});

test("drop handler previews supported payloads once, never pastes, and ignores closed cards", async () => {
  const card = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  const handler = card.match(/onDrop=\{([\s\S]*?)\n      \}\}/)?.[1];
  assert.ok(handler);
  const previews = [], pasted = [];
  const sessionExited = { current: false };
  let prevented = 0, stopped = 0;
  const file = { name: "video.mp4" };
  const onDrop = runInNewContext(`(${handler}\n})`, {
    terminalRef: { current: { paste: text => pasted.push(text) } },
    onDropContext: (id,payload,point) => previews.push({id,payload,point}),
    sessionExited, renaming:false, session:{id:"drop-target"}
  });
  const event = {
    dataTransfer:{types:["Files"],files:[file],getData:()=>""},clientX:1,clientY:2,
    preventDefault:()=>prevented++,stopPropagation:()=>stopped++
  };
  onDrop(event);
  assert.equal(previews.length,1);assert.equal(previews[0].id,"drop-target");
  assert.equal(previews[0].payload.files[0],file);assert.equal(pasted.length,0);
  sessionExited.current=true;onDrop(event);assert.equal(previews.length,1);
  onDrop({...event,dataTransfer:{types:["application/x-unsupported"],files:[],getData:()=>""}});
  assert.equal(prevented,2);assert.equal(stopped,2);
  sessionExited.current=false;
  onDrop({...event,dataTransfer:{types:["text/plain"],files:[],getData:type=>type==="text/plain" ? "context" : ""}});
  assert.equal(previews[1].payload.text,"context");assert.equal(pasted.length,0);
});
