import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import headless from "@xterm/headless";
import { parseTerminalFileLink, findTerminalFileLinks } from "../src/shared/terminalFileLink.ts";
import { terminalFileLinkProvider } from "../src/renderer/src/features/terminal/terminalFileLinks.ts";
import { terminalFileEditorArguments, vscodeLaunchCandidates } from "../src/main/services/terminalFileEditor.ts";

test("file paths preserve line and column across plain and explicit links", () => {
  for (const value of [
    "/Users/runner/project/main.go:42:7",
    "file:///Users/runner/project/main.go:42:7",
    "file:///Users/runner/project/main.go#L42C7",
    "vscode://file/Users/runner/project/main.go:42:7"
  ]) {
    assert.deepEqual(parseTerminalFileLink(value), { path: "/Users/runner/project/main.go", line: 42, column: 7 });
  }
  assert.deepEqual(parseTerminalFileLink("src/main.go:42"), { path: "src/main.go", line: 42, column: 1 });
  assert.deepEqual(parseTerminalFileLink("main.go:42"), { path: "main.go", line: 42, column: 1 });
  assert.deepEqual(parseTerminalFileLink("~/project/main.go"), { path: "~/project/main.go", line: 1, column: 1 });
  assert.deepEqual(parseTerminalFileLink("file:///Users/runner/My%20Project/main.go:4"), {
    path: "/Users/runner/My Project/main.go", line: 4, column: 1
  });
});

test("web URLs, commands, remote file hosts and malformed locations are rejected", () => {
  for (const value of [
    "https://example.com/path:4", "http://localhost:8080", "javascript:alert(1)",
    "vscode://command/workbench.action.openSettings", "file://remote/path/main.go:2",
    "file:///tmp/main.go?command=anything", "file:///tmp/a%00.go", "/tmp/a.go:0",
    "/tmp/a.go:1:0", "/tmp/a.go:99999999999999", "/tmp/a.go:2#bad", "plainword",
    "//remote/file.go", "/tmp/a\u0000.go", null, {}, "/".repeat(4_097)
  ]) assert.equal(parseTerminalFileLink(value), null, String(value));
});

test("plain output and Markdown retain precise link boundaries", () => {
  const text = 'See [source](/Users/runner/main.go:4), src/helper.go:8:2 and "My Project/main.go":12.';
  const links = findTerminalFileLinks(text);
  assert.deepEqual(links.map((link) => link.text), [
    "/Users/runner/main.go:4", "src/helper.go:8:2", "My Project/main.go:12"
  ]);
  assert.equal(text.slice(links[0].start, links[0].end), "/Users/runner/main.go:4");
  assert.equal(text.slice(links[2].start, links[2].end), '"My Project/main.go":12');
  assert.deepEqual(findTerminalFileLinks("https://example.com/src/main.go:8"), []);
});

test("xterm links span wrapped rows and account for wide Unicode characters", async (t) => {
  const terminal = new headless.Terminal({ cols: 32, rows: 5, allowProposedApi: true });
  t.after(() => terminal.dispose());
  const reference = "/Users/runner/project/src/example.go:42:7";
  await new Promise((done) => terminal.write("Код 界 " + reference, done));
  const opened = [];
  const provider = terminalFileLinkProvider(terminal, (_event, value) => opened.push(value));
  const first = await new Promise((done) => provider.provideLinks(1, done));
  const second = await new Promise((done) => provider.provideLinks(2, done));
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0].text, reference);
  assert.deepEqual(first[0].range.start, { x: 8, y: 1 });
  assert.deepEqual(second[0].range, first[0].range);
  first[0].activate({});
  assert.deepEqual(opened, [reference]);
});

test("opening a real file always reuses the VS Code window and passes the position as one argument", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "canvastty-file-links-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const name = "source with spaces $(echo nope).go";
  await writeFile(join(folder, name), "package main\n");
  assert.deepEqual(await terminalFileEditorArguments(name + ":12:3", folder), [
    "--reuse-window", "--goto", join(await realpath(folder), name) + ":12:3"
  ]);
  await assert.rejects(terminalFileEditorArguments("missing.go:4", folder), /ENOENT/);
  await assert.rejects(terminalFileEditorArguments(folder, folder), /existing file/);
  await assert.rejects(terminalFileEditorArguments("https://example.com/a.go:2", folder), /Invalid file link/);
});

test("Windows paths preserve their drive, separators and position", () => {
  const path = String.raw`C:\Users\runner\project\main.go`;
  assert.deepEqual(parseTerminalFileLink(path + ":42:7"), { path, line: 42, column: 7 });
  assert.deepEqual(parseTerminalFileLink(String.raw`src\main.go:5`), {
    path: String.raw`src\main.go`, line: 5, column: 1
  });
  for (const value of ["file:///C:/Users/runner/main.go:4", "vscode://file/C:/Users/runner/main.go:4"]) {
    assert.deepEqual(parseTerminalFileLink(value), { path: "C:/Users/runner/main.go", line: 4, column: 1 });
  }
  for (const value of [String.raw`\\server\share\main.go`, String.raw`\rooted\main.go`, "C:main.go:4"]) {
    assert.equal(parseTerminalFileLink(value), null, value);
  }
});

test("quoted filename punctuation is preserved and prose punctuation is excluded", () => {
  assert.deepEqual(findTerminalFileLinks('"/tmp/question?" "/tmp/period." /tmp/main.go:2.').map((link) => link.text), [
    "/tmp/question?", "/tmp/period.", "/tmp/main.go:2"
  ]);
});

test("a wide character wrapped at the right edge does not insert a space into a file path", async (t) => {
  const terminal = new headless.Terminal({ cols: 10, rows: 5, allowProposedApi: true });
  t.after(() => terminal.dispose());
  const reference = "/tmp/1234界.go:9";
  await new Promise((done) => terminal.write(reference, done));
  const provider = terminalFileLinkProvider(terminal, () => {});
  const links = await new Promise((done) => provider.provideLinks(2, done));
  assert.equal(links.length, 1);
  assert.equal(links[0].text, reference);
  assert.deepEqual(links[0].range, { start: { x: 1, y: 1 }, end: { x: 7, y: 2 } });
});

test("a file link ending in a wide character covers both terminal cells", async (t) => {
  const terminal = new headless.Terminal({ cols: 20, rows: 5, allowProposedApi: true });
  t.after(() => terminal.dispose());
  await new Promise((done) => terminal.write("/tmp/界", done));
  const provider = terminalFileLinkProvider(terminal, () => {});
  const links = await new Promise((done) => provider.provideLinks(1, done));
  assert.deepEqual(links[0].range, { start: { x: 1, y: 1 }, end: { x: 7, y: 1 } });
});

test("an overlong wrapped logical line never produces a truncated file link", async (t) => {
  const terminal = new headless.Terminal({ cols: 10, rows: 5, scrollback: 200, allowProposedApi: true });
  t.after(() => terminal.dispose());
  await new Promise((done) => terminal.write("/tmp/" + "a".repeat(1_020), done));
  const provider = terminalFileLinkProvider(terminal, () => {});
  assert.equal(await new Promise((done) => provider.provideLinks(1, done)), undefined);
  assert.equal(await new Promise((done) => provider.provideLinks(102, done)), undefined);
});

test("macOS and Linux launchers use installed code commands without relying on the current directory", () => {
  const mac = vscodeLaunchCandidates("darwin", { PATH: "/opt/bin:.:/usr/bin" }, "/Users/runner");
  assert.equal(mac[0].command, "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code");
  assert.ok(mac.some((entry) => entry.command === "/Users/runner/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"));
  assert.deepEqual(vscodeLaunchCandidates("linux", { PATH: "/opt/bin:.:/usr/bin:/opt/bin" }, "/home/runner"), [
    { command: "/opt/bin/code", prefix: [], runAsNode: false },
    { command: "/usr/bin/code", prefix: [], runAsNode: false }
  ]);
});

test("Windows launchers run Code.exe with its CLI script instead of interpolating filenames into cmd.exe", () => {
  const candidates = vscodeLaunchCandidates("win32", {
    LocalAppData: String.raw`C:\Users\runner\AppData\Local`,
    ProgramFiles: String.raw`C:\Program Files`,
    Path: String.raw`D:\VS Code\bin;.`
  }, String.raw`C:\Users\runner`);
  const first = candidates[0];
  assert.deepEqual(first, {
    command: String.raw`C:\Users\runner\AppData\Local\Programs\Microsoft VS Code\Code.exe`,
    prefix: [String.raw`C:\Users\runner\AppData\Local\Programs\Microsoft VS Code\resources\app\out\cli.js`],
    runAsNode: true
  });
  assert.ok(candidates.some((entry) => entry.command === String.raw`D:\VS Code\Code.exe`));
  assert.ok(candidates.every((entry) => entry.runAsNode && entry.command.endsWith("\\Code.exe")));
});
