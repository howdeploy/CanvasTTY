import type { MenuItemConstructorOptions } from "electron";
import type { LocaleId } from "../shared/contracts.ts";

export function macApplicationMenuTemplate(appName: string, locale: LocaleId,
  onCheckUpdates: () => void): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: "about" },
        { label: locale === "ru" ? "Проверить обновления…" : "Check for Updates…", click: onCheckUpdates },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    { role: "help", submenu: [] }
  ];
}
