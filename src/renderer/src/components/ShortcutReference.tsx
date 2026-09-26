import type { LocaleId } from "../../../shared/contracts";
import { t, type TranslationKey } from "../lib/i18n";

export function ShortcutReference({ locale }: { locale: LocaleId }): React.JSX.Element {
  const mac = window.canvasTTY.window.isMacOS;
  const command = mac ? "Command" : "Ctrl";
  const shortcuts: [string, TranslationKey][] = [
    [`${command}+K`, "commandPalette"],
    [`${command}+,`, "settings"],
    [`${mac ? "Option" : "Alt"}+↑↓←→`, "focusWindowHint"],
    ["Shift + drag", "marqueeSelectionHint"],
    ["Ctrl+Shift+F", "terminalSearch"],
    [mac ? "Command+C / Ctrl+C / Ctrl+Shift+C" : "Ctrl+C / Ctrl+Shift+C", "shortcutCopySelection"],
    [mac ? "Command+V / Ctrl+Shift+V / Shift+Insert" : "Ctrl+Shift+V / Shift+Insert", "shortcutPaste"],
    ["Shift+Enter", "shortcutLineBreak"],
    ["PageUp / PageDown", "shortcutScrollPages"],
    ["Ctrl+D", "shortcutRestartExited"],
    ["Enter / Shift+Enter", "shortcutSearchMatches"],
    ["↑↓ / Enter", "shortcutPaletteNavigation"],
    ["↑↓←→ / Enter / Space", "shortcutRadialNavigation"],
    ["↑↓←→", "shortcutMinimapNavigation"],
    ["Enter / Escape", "shortcutRenameConfirm"],
    ["Escape", "shortcutDismiss"]
  ];
  return (
    <dl className="shortcut-reference">
      {shortcuts.map(([keys, label]) => (
        <div key={label}><dt><kbd>{keys}</kbd></dt><dd>{t(locale, label)}</dd></div>
      ))}
    </dl>
  );
}
