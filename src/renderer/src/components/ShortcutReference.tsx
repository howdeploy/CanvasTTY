import { useEffect, useRef } from "react";
import type { AppSettings } from "../../../shared/contracts";
import { displayCanvasNavigationBinding } from "../lib/shortcuts";
import { UiIcon } from "./UiIcon";
import { t, type TranslationKey } from "../lib/i18n";

export function ShortcutReference({ settings, onClose }: {
  settings: AppSettings;
  onClose(): void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const { locale, shortcuts: bindings } = settings;
  const mac = window.canvasTTY.window.isMacOS;
  const display = (binding: string) => binding.replace("Meta", mac ? "Command" : "Super")
    .replace("Comma", ",").replace(/ArrowUp/g, "↑").replace(/ArrowDown/g, "↓")
    .replace(/ArrowLeft/g, "←").replace(/ArrowRight/g, "→") || t(locale, "disabled");
  const groups: { title: TranslationKey; shortcuts: [string[], TranslationKey][] }[] = [
    { title: "keyboardCanvas", shortcuts: [
      [[bindings.home], "homeShortcut"],
      [[bindings.renameWindow], "renameWindow"],
      [[bindings.toggleFullscreen], "toggleFullscreen"],
      [[bindings.commandPalette], "commandPalette"],
      [[bindings.openSettings], "settings"],
      [[bindings.toggleDetail], "keyboardToggleDetail"],
      [[bindings.momEntered], "keyboardHideBackgrounds"],
      [[bindings.disableDesign], "keyboardDisableDesign"],
      [["Shift + drag"], "marqueeSelectionHint"]
    ] },
    { title: "keyboardNavigation", shortcuts: [
      [[bindings.focusUp], "keyboardFocusUp"],
      [[bindings.focusDown], "keyboardFocusDown"],
      [[bindings.focusLeft], "keyboardFocusLeft"],
      [[bindings.focusRight], "keyboardFocusRight"],
      [[settings.canvasWheelCaptureMode === "key" && settings.canvasWheelOverride !== null
        ? displayCanvasNavigationBinding(settings.canvasWheelOverride, mac) : ""], "canvasWheelOverrideHint"],
      [[settings.canvasNavigationOverride === null ? ""
        : displayCanvasNavigationBinding(settings.canvasNavigationOverride, mac)], "canvasNavigationOverrideHint"],
      [["↑ ↓ ← →"], "shortcutMinimapNavigation"]
    ] },
    { title: "keyboardTerminal", shortcuts: [
      [[bindings.terminalCopy], "shortcutCopySelection"],
      [[bindings.terminalPaste], "shortcutPaste"],
      [[bindings.terminalSearch], "terminalSearch"],
      [[bindings.terminalRestart], "shortcutRestartExited"],
      [[bindings.terminalPageUp, bindings.terminalPageDown], "shortcutScrollPages"],
      [["Enter", "Shift+Enter"], "shortcutSearchMatches"]
    ] },
    { title: "keyboardCodex", shortcuts: [
      [[bindings.codexSubmit], "keyboardSubmit"],
      [[bindings.codexSubmitAlternate], "keyboardSubmitAlternate"],
      [[bindings.codexSubmitSuper], "keyboardSubmitSuper"],
      [[bindings.codexNewline], "shortcutLineBreak"],
      [[bindings.codexSelectAll], "keyboardSelectAll"]
    ] }
  ];
  const contexts: [string[], TranslationKey][] = [
    [["↑ ↓", "Enter"], "shortcutPaletteNavigation"],
    [["↑ ↓ ← →", "Enter", "Space"], "shortcutRadialNavigation"],
    [["Enter", "Escape"], "shortcutRenameConfirm"],
    [["Escape"], "shortcutDismiss"]
  ];
  const rows = (shortcuts: [string[], TranslationKey][]): React.JSX.Element => (
    <dl className="shortcut-reference">
      {shortcuts.map(([keys, label]) => (
        <div key={label}>
          <dt>{t(locale, label)}</dt>
          <dd>{keys.map((key, index) => <kbd key={index} data-disabled={!key}>{display(key)}</kbd>)}</dd>
        </div>
      ))}
    </dl>
  );
  const preset = settings.keyboardPreset === "custom" ? t(locale, "keyboardCustom")
    : ({ macos: "macOS", windows: "Windows", linux: "Linux" })[settings.keyboardPreset];

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return (
    <dialog ref={dialog} className="shortcut-reference-dialog" aria-labelledby="shortcut-reference-title"
      data-interactive="true" data-canvas-wheel-priority="local"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="shortcut-reference-dialog__panel">
        <header className="shortcut-reference-dialog__header">
          <div>
            <h2 id="shortcut-reference-title">{t(locale, "keyboardShortcuts")}</h2>
            <p>{t(locale, "keyboardPreset")}: <strong>{preset}</strong></p>
          </div>
          <button type="button" autoFocus onClick={onClose} aria-label={t(locale, "close")}>
            <UiIcon name="close" size={18} />
          </button>
        </header>
        <div className="shortcut-reference-dialog__columns">
          {groups.map((group) => (
            <section key={group.title}>
              <h3>{t(locale, group.title)}</h3>
              {rows(group.shortcuts)}
              {group.title === "keyboardCodex" && <p className="shortcut-reference-dialog__note">
                {t(locale, "keyboardCodexDescription")}
              </p>}
            </section>
          ))}
        </div>
        <section className="shortcut-reference-dialog__contexts">
          <h3>{t(locale, "keyboardContexts")}</h3>
          {rows(contexts)}
        </section>
      </div>
    </dialog>
  );
}
