import assert from "node:assert/strict";
import test from "node:test";
import { macApplicationMenuTemplate } from "../src/main/macApplicationMenu.ts";

test("macOS app menu keeps native roles and dispatches the update command", () => {
  let checks = 0;
  const template = macApplicationMenuTemplate("CanvasTTY", "ru", () => { checks += 1; });
  const appItems = template[0].submenu;

  assert.equal(template[0].label, "CanvasTTY");
  assert.equal(appItems[0].role, "about");
  assert.equal(appItems[1].label, "Проверить обновления…");
  appItems[1].click();
  assert.equal(checks, 1);
  assert.deepEqual(appItems.filter(item => item.role).map(item => item.role),
    ["about", "services", "hide", "hideOthers", "unhide", "quit"]);
  assert.deepEqual(template.slice(1).map(item => item.role),
    ["fileMenu", "editMenu", "viewMenu", "windowMenu", "help"]);
});

test("macOS update menu label follows the selected language", () => {
  const template = macApplicationMenuTemplate("CanvasTTY", "en", () => {});
  assert.equal(template[0].submenu[1].label, "Check for Updates…");
});
