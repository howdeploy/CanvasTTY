import { useEffect, useRef, useState } from "react";
import type {
  CanvasLauncherItemId,
  LocaleId,
  Point,
  ProviderId
} from "../../../../shared/contracts";
import { ProviderIcon } from "../../components/ProviderIcon";
import { t } from "../../lib/i18n";
import { PROVIDERS } from "../../lib/providers";
import {
  CanvasMenuChevron,
  CanvasMenuDivider,
  CanvasMenuIcon,
  CanvasMenuKbd,
  CanvasMenuLabel,
  CanvasMenuRow,
  CanvasMenuSub
} from "../../components/CanvasMenuPrimitives";
import {
  chooseCanvasSubmenuSide,
  type CanvasContextMenuKind,
  type CanvasSubmenuSide
} from "./canvasContextRouting";
import { CANVAS_REGION_COLORS } from "./canvasRegions";

interface CanvasContextMenuProps {
  kind: CanvasContextMenuKind;
  position: Point;
  locale: LocaleId;
  launcherItems: readonly CanvasLauncherItemId[];
  currentRegionColor: string | null;
  onCreateRegion(): void;
  onCreateNote(): void;
  onLaunch(provider: ProviderId): void;
  onOpenBrowser(): void;
  onOpenFiles(): void;
  onOpenSettings(): void;
  onRenameRegion(): void;
  onChangeRegionColor(color: string): void;
  onDeleteRegion(): void;
  onEditNote(): void;
  onBringNoteToFront(): void;
  onDeleteNote(): void;
  materialHasLocation: boolean;
  onAddFiles(): void;
  onPasteFiles(): void;
  onPinMaterial(): void;
  onRevealMaterial(): void;
  onCopyMaterialPath(): void;
  onBringMaterialToFront(): void;
  onRemoveMaterial(): void;
  onClose(): void;
}

export function CanvasContextMenu({
  kind,
  position,
  locale,
  launcherItems,
  currentRegionColor,
  onCreateRegion,
  onCreateNote,
  onLaunch,
  onOpenBrowser,
  onOpenFiles,
  onOpenSettings,
  onRenameRegion,
  onChangeRegionColor,
  onDeleteRegion,
  onEditNote,
  onBringNoteToFront,
  onDeleteNote,
  materialHasLocation,
  onAddFiles,
  onPasteFiles,
  onPinMaterial,
  onRevealMaterial,
  onCopyMaterialPath,
  onBringMaterialToFront,
  onRemoveMaterial,
  onClose
}: CanvasContextMenuProps): React.JSX.Element {
  const menu = useRef<HTMLDivElement>(null);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [submenuSide, setSubmenuSide] = useState<CanvasSubmenuSide>("right");

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>(".canvas-menu__row")?.focus({ preventScroll: true });
  }, [kind]);

  const toggleLauncher = (): void => {
    if (launcherOpen) {
      setLauncherOpen(false);
      return;
    }
    const root = menu.current;
    const workspace = root?.closest<HTMLElement>(".workspace");
    if (root && workspace) {
      const fontSize = Number.parseFloat(window.getComputedStyle(root).fontSize) || 13;
      setSubmenuSide(chooseCanvasSubmenuSide(
        root.getBoundingClientRect(),
        workspace.getBoundingClientRect(),
        19 * fontSize,
        .55 * fontSize
      ));
    }
    setLauncherOpen(true);
  };

  return (
    <div
      ref={menu}
      className="canvas-menu"
      data-interactive="true"
      role="menu"
      aria-label={t(locale, "canvasContextMenu")}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        moveMenuFocus(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
      }}
    >
      {kind === "empty" && (
        <>
          <CanvasMenuRow
            icon="maximize"
            right={<CanvasMenuSub>{t(locale, "canvasMenuHere")}</CanvasMenuSub>}
            role="menuitem"
            onClick={onCreateRegion}
          >{t(locale, "canvasMenuCreateRegion")}</CanvasMenuRow>
          <CanvasMenuRow
            icon="sticky-note"
            right={<CanvasMenuSub>{t(locale, "canvasMenuHere")}</CanvasMenuSub>}
            role="menuitem"
            onClick={onCreateNote}
          >{t(locale, "newStickyNote")}</CanvasMenuRow>
          <CanvasMenuRow icon="image-plus" role="menuitem" onClick={onAddFiles}>
            {t(locale, "materialsAddFiles")}
          </CanvasMenuRow>
          <CanvasMenuRow
            icon="clipboard-paste"
            right={<CanvasMenuKbd>{window.canvasTTY.window.isMacOS ? "⌘V" : "Ctrl+V"}</CanvasMenuKbd>}
            role="menuitem"
            onClick={onPasteFiles}
          >{t(locale, "materialsPaste")}</CanvasMenuRow>
          <CanvasMenuDivider />
          <div className="canvas-menu__submenu-anchor">
            <CanvasMenuRow
              icon="terminal"
              right={<CanvasMenuChevron />}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={launcherOpen}
              onClick={toggleLauncher}
            >{t(locale, "canvasMenuLaunchAgent")}</CanvasMenuRow>
            {launcherOpen && (
              <div className={`canvas-menu canvas-menu__submenu canvas-menu__submenu--${submenuSide}`} role="menu">
                {launcherItems.map((provider) => (
                  provider === "terminal" ? (
                    <CanvasMenuRow
                      icon="terminal"
                      muted
                      indent
                      role="menuitem"
                      key={provider}
                      onClick={() => onLaunch(provider)}
                    >{PROVIDERS[provider].label}</CanvasMenuRow>
                  ) : (
                    <CanvasMenuRow
                      indent
                      right={<CanvasMenuSub>{t(locale, "normal").toLocaleLowerCase(locale)}</CanvasMenuSub>}
                      role="menuitem"
                      key={provider}
                      onClick={() => onLaunch(provider)}
                    >
                      <span className="canvas-menu__provider">
                        <ProviderIcon provider={provider} size="small" />
                        {PROVIDERS[provider].label}
                      </span>
                    </CanvasMenuRow>
                  )
                ))}
              </div>
            )}
          </div>
          <CanvasMenuRow icon="browser" role="menuitem" onClick={onOpenBrowser}>
            {t(locale, "canvasMenuOpenBrowser")}
          </CanvasMenuRow>
          <CanvasMenuRow icon="folder" role="menuitem" onClick={onOpenFiles}>
            {t(locale, "files")}
          </CanvasMenuRow>
          <CanvasMenuDivider />
          <CanvasMenuRow
            icon="settings"
            muted
            right={<CanvasMenuKbd>{window.canvasTTY.window.isMacOS ? "⌘," : "Ctrl+,"}</CanvasMenuKbd>}
            role="menuitem"
            onClick={onOpenSettings}
          >{t(locale, "settings")}</CanvasMenuRow>
        </>
      )}

      {kind === "region" && (
        <>
          <CanvasMenuRow
            icon="pencil"
            right={<CanvasMenuKbd>R</CanvasMenuKbd>}
            role="menuitem"
            onClick={onRenameRegion}
          >{t(locale, "canvasMenuRenameRegion")}</CanvasMenuRow>
          <div className="canvas-menu__row canvas-menu__palette-row" role="group" aria-label={t(locale, "canvasRegionColor")}>
            <CanvasMenuIcon icon="palette" />
            <div className="canvas-menu__swatches">
              {CANVAS_REGION_COLORS.map((color) => (
                <button
                  className={`canvas-menu__swatch ${color === currentRegionColor ? "canvas-menu__swatch--selected" : ""}`}
                  type="button"
                  role="menuitemradio"
                  key={color}
                  style={{ background: color }}
                  aria-label={`${t(locale, "canvasRegionColor")} ${color}`}
                  aria-checked={color === currentRegionColor}
                  onClick={() => onChangeRegionColor(color)}
                />
              ))}
            </div>
          </div>
          <CanvasMenuRow icon="sticky-note" role="menuitem" onClick={onCreateNote}>
            {t(locale, "canvasMenuNoteInRegion")}
          </CanvasMenuRow>
          <CanvasMenuRow icon="image-plus" role="menuitem" onClick={onAddFiles}>
            {t(locale, "materialsAddFiles")}
          </CanvasMenuRow>
          <CanvasMenuDivider />
          <CanvasMenuRow icon="trash" danger role="menuitem" onClick={onDeleteRegion}>
            {t(locale, "canvasMenuDeleteRegion")}
          </CanvasMenuRow>
          <CanvasMenuLabel>{t(locale, "canvasMenuRegionContentsStay")}</CanvasMenuLabel>
        </>
      )}

      {kind === "note" && (
        <>
          <CanvasMenuRow
            icon="pencil"
            right={<CanvasMenuKbd>↵</CanvasMenuKbd>}
            role="menuitem"
            onClick={onEditNote}
          >{t(locale, "editStickyNote")}</CanvasMenuRow>
          <CanvasMenuRow icon="bring-to-front" role="menuitem" onClick={onBringNoteToFront}>
            {t(locale, "canvasMenuBringToFront")}
          </CanvasMenuRow>
          <CanvasMenuDivider />
          <CanvasMenuRow icon="trash" danger role="menuitem" onClick={onDeleteNote}>
            {t(locale, "deleteStickyNote")}
          </CanvasMenuRow>
        </>
      )}

      {kind === "material" && (
        <>
          <CanvasMenuRow icon="pin" role="menuitem" onClick={onPinMaterial}>
            {t(locale, "materialPinVersion")}
          </CanvasMenuRow>
          <CanvasMenuRow icon="folder-open" role="menuitem" disabled={!materialHasLocation} onClick={onRevealMaterial}>
            {t(locale, "materialShowInFolder")}
          </CanvasMenuRow>
          <CanvasMenuRow icon="copy" role="menuitem" disabled={!materialHasLocation} onClick={onCopyMaterialPath}>
            {t(locale, "materialCopyPath")}
          </CanvasMenuRow>
          <CanvasMenuRow icon="bring-to-front" role="menuitem" onClick={onBringMaterialToFront}>
            {t(locale, "canvasMenuBringToFront")}
          </CanvasMenuRow>
          <CanvasMenuDivider />
          <CanvasMenuRow icon="trash" danger role="menuitem" onClick={onRemoveMaterial}>
            {t(locale, "materialRemove")}
          </CanvasMenuRow>
        </>
      )}
    </div>
  );
}

function moveMenuFocus(menu: HTMLElement, direction: 1 | -1): void {
  const rows = [...menu.querySelectorAll<HTMLButtonElement>(".canvas-menu__row:not(:disabled)")];
  if (rows.length === 0) return;
  const current = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next = current < 0 ? 0 : (current + direction + rows.length) % rows.length;
  rows[next]?.focus({ preventScroll: true });
}
