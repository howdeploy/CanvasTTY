import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import type { CanvasContextMenuKind, CanvasSubmenuSide } from "./canvasContextRouting";
import { canvasMenuPlacementClearOfPanels, chooseCanvasSubmenuPlacement, chooseCanvasSubmenuSide } from "./canvasMenuPlacement";
import type { CanvasAutoSortHost } from "./canvasAutoSortScope";
import { CANVAS_REGION_COLORS } from "./canvasRegions";

type ToolsMenu = typeof import("./CanvasAutoSortMenu").CanvasAutoSortMenu;
/** The Tools submenu body: loaded when a canvas or region menu opens (or by Tools) and kept for later menus. */
let loadedToolsMenu: ToolsMenu | null = null;
let toolsMenuLoad: Promise<ToolsMenu> | null = null;
function loadToolsMenu(): Promise<ToolsMenu> {
  toolsMenuLoad ??= import("./CanvasAutoSortMenu").then((module) => (loadedToolsMenu = module.CanvasAutoSortMenu), (error: unknown) => {
    toolsMenuLoad = null;
    throw error;
  });
  return toolsMenuLoad;
}

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
  onSendMaterial: (() => void) | null;
  onRevealMaterial(): void;
  onCopyMaterialPath(): void;
  onBringMaterialToFront(): void;
  onRemoveMaterial(): void;
  onSendRemarks: (() => void) | null;
  autoSort: CanvasAutoSortHost;
  onClose(): void;
}

/** The visible canvas corner panels (minimap, shortcut hints, Home/zoom controls), wherever Settings put them. */
function cornerPanelRects(workspace: HTMLElement): DOMRect[] {
  return [...workspace.querySelectorAll<HTMLElement>(".canvas-overlays .canvas-overlay-slot > *")]
    .map((panel) => panel.getBoundingClientRect())
    .filter((panel) => panel.width > 0 && panel.height > 0);
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
  onSendMaterial,
  onRevealMaterial,
  onCopyMaterialPath,
  onBringMaterialToFront,
  onRemoveMaterial,
  onSendRemarks,
  autoSort,
  onClose
}: CanvasContextMenuProps): React.JSX.Element {
  const menu = useRef<HTMLDivElement>(null);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [ToolsMenu, setToolsMenu] = useState<ToolsMenu | null>(() => loadedToolsMenu);
  // Tools sits low in the menu: near the bottom of the canvas its submenu opens upward.
  const [toolsUp, setToolsUp] = useState(false);
  const [submenuSide, setSubmenuSide] = useState<CanvasSubmenuSide>("right");

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>(".canvas-menu__row")?.focus({ preventScroll: true });
  }, [kind]);

  // Tools is opened from this menu: its body loads while the menu is open, so the submenu shows at once.
  useEffect(() => {
    if (kind !== "empty" && kind !== "region") return;
    // Loaded since this menu's first render (by an earlier menu): copy it in, nothing else will.
    if (loadedToolsMenu) {
      setToolsMenu(() => loadedToolsMenu);
      return;
    }
    let live = true;
    loadToolsMenu().then((loaded) => { if (live) setToolsMenu(() => loaded); }, () => undefined);
    return () => { live = false; };
  }, [kind]);
  // Before the first paint: keep the menu off the corner panels (up, or else sideways), and point the submenu chevrons
  // where they open.
  const [place, setPlace] = useState({ left: position.x, top: position.y });
  useLayoutEffect(() => {
    const root = menu.current;
    const workspace = root?.closest<HTMLElement>(".workspace");
    if (!root || !workspace) {
      setPlace({ left: position.x, top: position.y });
      return;
    }
    const area = workspace.getBoundingClientRect();
    const rect = root.getBoundingClientRect();
    const placed = { left: area.left + position.x, right: area.left + position.x + rect.width, top: area.top + position.y,
      bottom: area.top + position.y + rect.height };
    const panels = cornerPanelRects(workspace);
    const fontSize = Number.parseFloat(window.getComputedStyle(root).fontSize) || 13;
    const clear = canvasMenuPlacementClearOfPanels(placed, panels,
      { minTop: area.top + .9 * fontSize, minLeft: area.left + .9 * fontSize, maxRight: area.right - .9 * fontSize }, .6 * fontSize);
    setPlace({ left: clear.left - area.left, top: clear.top - area.top });
  }, [kind, position.x, position.y]);
  // After the menu has its place: the submenus open toward the side with room.
  useLayoutEffect(() => {
    chooseSubmenuSide();
  }, [kind, place.left, place.top]);
  // An open submenu, once measured, goes where it covers no corner panel: the other direction or side when needed.
  useLayoutEffect(() => {
    const submenu = menu.current?.querySelector<HTMLElement>(".canvas-menu__submenu");
    const anchor = submenu?.closest<HTMLElement>(".canvas-menu__submenu-anchor");
    const workspace = menu.current?.closest<HTMLElement>(".workspace");
    if (!submenu || !anchor || !workspace) return;
    const fontSize = Number.parseFloat(window.getComputedStyle(menu.current!).fontSize) || 13;
    const { width, height } = submenu.getBoundingClientRect();
    const placement = chooseCanvasSubmenuPlacement(anchor.getBoundingClientRect(), { width, height },
      workspace.getBoundingClientRect(), cornerPanelRects(workspace),
      { gap: .55 * fontSize, offset: .45 * fontSize, clearance: .6 * fontSize }, toolsOpen);
    setSubmenuSide(placement.side);
    if (toolsOpen) setToolsUp(placement.up);
  }, [launcherOpen, toolsOpen, ToolsMenu, place.left, place.top]);

  const chooseSubmenuSide = (): void => {
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
  };

  const toggleLauncher = (): void => {
    if (launcherOpen) {
      setLauncherOpen(false);
      return;
    }
    setToolsOpen(false);
    setLauncherOpen(true);
  };

  // Where an open submenu goes (side, up or down) is chosen once it is measured, in the layout effect above.
  const toggleTools = (): void => {
    if (toolsOpen) {
      setToolsOpen(false);
      return;
    }
    setLauncherOpen(false);
    setToolsOpen(true);
    if (loadedToolsMenu) {
      setToolsMenu(() => loadedToolsMenu);
    } else {
      loadToolsMenu().then((loaded) => {
        setToolsMenu(() => loaded);
      }).catch((error: unknown) => {
        console.error("Auto-sort failed to load", error);
        autoSort.onError(t(locale, "canvasAutoSortFailed"));
        setToolsOpen(false);
      });
    }
  };

  const tools = (
    <div className="canvas-menu__submenu-anchor">
      <CanvasMenuRow
        icon="wrench"
        right={<CanvasMenuChevron side={submenuSide} />}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={toolsOpen}
        onClick={toggleTools}
      >{t(locale, "canvasMenuTools")}</CanvasMenuRow>
      {toolsOpen && ToolsMenu && (
        <ToolsMenu
          host={autoSort}
          locale={locale}
          className={`canvas-menu canvas-menu__submenu canvas-menu__submenu--${submenuSide} ${toolsUp ? "canvas-menu__submenu--up" : ""}`}
          onDone={onClose}
        />
      )}
    </div>
  );

  return (
    <div
      ref={menu}
      className="canvas-menu"
      data-interactive="true"
      role="menu"
      aria-label={t(locale, "canvasContextMenu")}
      style={{ left: place.left, top: place.top }}
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
          {onSendRemarks && (
            <CanvasMenuRow icon="send" role="menuitem" onClick={onSendRemarks}>
              {t(locale, "handoffSendToAgent")}
            </CanvasMenuRow>
          )}
          <CanvasMenuDivider />
          <div className="canvas-menu__submenu-anchor">
            <CanvasMenuRow
              icon="terminal"
              right={<CanvasMenuChevron side={submenuSide} />}
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
          {tools}
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
          {tools}
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
          {onSendMaterial && (
            <CanvasMenuRow icon="send" role="menuitem" onClick={onSendMaterial}>
              {t(locale, "handoffSendToAgent")}
            </CanvasMenuRow>
          )}
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
