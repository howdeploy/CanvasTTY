import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { attachEditContextMenu, editContextMenuTemplate } from "../src/main/editContextMenu.ts";

const flags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canUndo: false, canRedo: false, canDelete: true, canEditRichly: false };

test("an editable field (app or plugin page) gets native Cut, Copy, Paste and Select All", () => {
  const template = editContextMenuTemplate({ isEditable: true, selectionText: "", editFlags: flags }, "ru");
  assert.deepEqual(template.filter(item => item.role).map(item => [item.role, item.label]),
    [["cut", "Вырезать"], ["copy", "Скопировать"], ["paste", "Вставить"], ["selectAll", "Выбрать все"]]);
  const empty = editContextMenuTemplate({ isEditable: true, selectionText: "", editFlags: { ...flags, canCut: false, canCopy: false } }, "en");
  assert.deepEqual(empty.filter(item => item.role).map(item => [item.role, item.enabled]),
    [["cut", false], ["copy", false], ["paste", true], ["selectAll", true]]);
});

test("selected page text gets Copy only; anything else gets no menu", () => {
  assert.deepEqual(editContextMenuTemplate({ isEditable: false, selectionText: "abc", editFlags: flags }, "en").map(item => item.role), ["copy"]);
  for (const selectionText of ["  ", "\t", "\n", " \t\n"]) {
    assert.deepEqual(editContextMenuTemplate({ isEditable: false, selectionText, editFlags: flags }, "en"),
      [{ role: "copy", label: "Copy", enabled: true }]);
  }
  assert.deepEqual(editContextMenuTemplate({ isEditable: false, selectionText: "", editFlags: flags }, "en"), []);
});

test("the context-menu event pops the menu only when there is something to show", () => {
  const contents = new EventEmitter();
  const shown = [];
  attachEditContextMenu(contents, () => "en", (template) => shown.push(template.map(item => item.role ?? item.type)));
  contents.emit("context-menu", {}, { isEditable: true, selectionText: "", editFlags: flags });
  contents.emit("context-menu", {}, { isEditable: false, selectionText: "", editFlags: flags });
  assert.deepEqual(shown, [["cut", "copy", "paste", "separator", "selectAll"]]);
});


test("a standalone plugin window gets its native edit menu before loading and uses the current locale", async () => {
  const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function openPluginWindow(");
  const end = source.indexOf("function closePluginWindows(", start);
  assert.ok(start >= 0 && end > start);
  const windows = [];
  const shown = [];
  let locale = "en";
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      windows.push(this);
    }
    static fromWebContents(contents) {
      return windows.find(window => window.webContents === contents);
    }
    async loadURL(url) {
      assert.equal(url, "canvastty-plugin://test/window.html");
      this.webContents.emit("context-menu", {}, { isEditable: true, selectionText: "", editFlags: flags });
      assert.equal(shown.length, 1, "the page can request an edit menu as soon as loading starts");
    }
  }
  const openPluginWindow = runInNewContext(`${stripTypeScriptTypes(source.slice(start, end))}; openPluginWindow`, {
    BrowserWindow,
    appIcon: undefined,
    join,
    __dirname: "/test/main",
    pluginWindows: new Map(),
    pluginManager: {
      contribution: () => ({ kind: "window", title: "Test", defaultSize: { width: 400, height: 300 } }),
      entryUrl: () => "canvastty-plugin://test/window.html"
    },
    attachEditContextMenu,
    editMenuLocale: () => locale,
    Menu: { buildFromTemplate: template => ({ popup: options => shown.push({ template, window: options.window }) }) }
  });
  await openPluginWindow("test", "window");
  assert.equal(shown[0].window, windows[0]);
  assert.deepEqual(shown[0].template.filter(item => item.role).map(item => item.role), ["cut", "copy", "paste", "selectAll"]);
  locale = "ru";
  windows[0].webContents.emit("context-menu", {}, { isEditable: false, selectionText: " \t", editFlags: flags });
  assert.equal(shown[1].window, windows[0]);
  assert.deepEqual(shown[1].template, [{ role: "copy", label: "Скопировать", enabled: true }]);
});
