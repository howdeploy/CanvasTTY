import type { ContextMenuParams, MenuItemConstructorOptions, WebContents } from "electron";
import type { LocaleId } from "../shared/contracts.ts";

type EditParams = Pick<ContextMenuParams, "isEditable" | "selectionText" | "editFlags">;

/**
 * The right-click menu for text: Cut/Copy/Paste/Select All in an editable field (an app field or a field in a plugin
 * page), Copy for selected page text, nothing elsewhere. A page that handles its own right click (the canvas, a
 * terminal) cancels the DOM event, and Electron then never asks for this menu.
 */
export function editContextMenuTemplate(params: EditParams, locale: LocaleId): MenuItemConstructorOptions[] {
  const ru = locale === "ru";
  const label = { cut: ru ? "Вырезать" : "Cut", copy: ru ? "Скопировать" : "Copy", paste: ru ? "Вставить" : "Paste", selectAll: ru ? "Выбрать все" : "Select All" };
  if (params.isEditable) {
    return [
      { role: "cut", label: label.cut, enabled: params.editFlags.canCut },
      { role: "copy", label: label.copy, enabled: params.editFlags.canCopy },
      { role: "paste", label: label.paste, enabled: params.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", label: label.selectAll, enabled: params.editFlags.canSelectAll }
    ];
  }
  if (params.selectionText.length > 0) return [{ role: "copy", label: label.copy, enabled: params.editFlags.canCopy }];
  return [];
}

export function attachEditContextMenu(
  contents: WebContents,
  locale: () => LocaleId,
  popup: (template: MenuItemConstructorOptions[], contents: WebContents) => void
): void {
  contents.on("context-menu", (_event, params) => {
    const template = editContextMenuTemplate(params, locale());
    if (template.length) popup(template, contents);
  });
}
