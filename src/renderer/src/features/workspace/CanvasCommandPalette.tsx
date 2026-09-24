import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CanvasLauncherItemId,
  LocaleId,
  ProviderId,
  SessionSnapshot
} from "../../../../shared/contracts";
import { ProviderIcon } from "../../components/ProviderIcon";
import { UiIcon, type UiIconName } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { PROVIDERS } from "../../lib/providers";
import {
  CanvasMenuDivider,
  CanvasMenuKbd,
  CanvasMenuLabel,
  CanvasMenuRow,
  CanvasMenuSub
} from "../../components/CanvasMenuPrimitives";

interface CanvasCommandPaletteProps {
  locale: LocaleId;
  sessions: readonly SessionSnapshot[];
  launcherItems: readonly CanvasLauncherItemId[];
  onFocusSession(session: SessionSnapshot): void;
  onLaunch(provider: ProviderId): void;
  onCreateRegion(): void;
  onCreateNote(): void;
  onFitCanvas(): void;
  onOpenBrowser(): void;
  onOpenSettings(): void;
  onClose(): void;
}

type CommandItem = {
  id: string;
  group: "sessions" | "actions";
  kind: "session" | "provider" | "action";
  label: string;
  searchDetail: string;
  icon?: UiIconName;
  provider?: ProviderId;
  shortcut?: string;
  run(): void;
};

export function CanvasCommandPalette({
  locale,
  sessions,
  launcherItems,
  onFocusSession,
  onLaunch,
  onCreateRegion,
  onCreateNote,
  onFitCanvas,
  onOpenBrowser,
  onOpenSettings,
  onClose
}: CanvasCommandPaletteProps): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const commands = useMemo<CommandItem[]>(() => [
    ...sessions.map((session) => ({
      id: `session:${session.id}`,
      group: "sessions" as const,
      kind: "session" as const,
      label: session.title,
      searchDetail: `${PROVIDERS[session.provider].label} ${session.cwd}`,
      provider: session.provider,
      run: () => onFocusSession(session)
    })),
    {
      id: "create:region",
      group: "actions",
      kind: "action",
      label: t(locale, "canvasMenuCreateRegion"),
      searchDetail: t(locale, "canvasMenuActions"),
      icon: "maximize",
      run: onCreateRegion
    },
    {
      id: "view:fit",
      group: "actions",
      kind: "action",
      label: t(locale, "fitCanvas"),
      searchDetail: t(locale, "canvasMenuActions"),
      icon: "maximize",
      run: onFitCanvas
    },
    {
      id: "create:note",
      group: "actions",
      kind: "action",
      label: t(locale, "newStickyNote"),
      searchDetail: t(locale, "canvasMenuActions"),
      icon: "sticky-note",
      run: onCreateNote
    },
    ...launcherItems.map((provider) => ({
      id: `launch:${provider}`,
      group: "actions" as const,
      kind: "provider" as const,
      label: provider === "terminal"
        ? PROVIDERS[provider].label
        : `${t(locale, "canvasMenuLaunchAgent")} · ${PROVIDERS[provider].label}`,
      searchDetail: `${t(locale, "canvasMenuLaunchAgent")} ${PROVIDERS[provider].label}`,
      provider,
      run: () => onLaunch(provider)
    })),
    {
      id: "open:browser",
      group: "actions",
      kind: "action",
      label: t(locale, "canvasMenuOpenBrowser"),
      searchDetail: t(locale, "canvasMenuActions"),
      icon: "browser",
      run: onOpenBrowser
    },
    {
      id: "open:settings",
      group: "actions",
      kind: "action",
      label: t(locale, "settings"),
      searchDetail: t(locale, "canvasMenuActions"),
      icon: "settings",
      shortcut: window.canvasTTY.window.isMacOS ? "⌘," : "Ctrl+,",
      run: onOpenSettings
    }
  ], [launcherItems, locale, onCreateNote, onCreateRegion, onFitCanvas, onFocusSession, onLaunch, onOpenBrowser, onOpenSettings, sessions]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale);
    if (!normalized) return commands;
    return commands.filter((command) => (
      `${command.label} ${command.searchDetail}`.toLocaleLowerCase(locale).includes(normalized)
    ));
  }, [commands, locale, query]);
  const selectedIndex = Math.min(selected, Math.max(0, filtered.length - 1));
  const sessionCommands = filtered.filter((command) => command.group === "sessions");
  const actionCommands = filtered.filter((command) => command.group === "actions");

  useEffect(() => input.current?.focus({ preventScroll: true }), []);
  useEffect(() => setSelected(0), [query]);

  const run = (command: CommandItem | undefined): void => {
    if (!command) return;
    command.run();
    onClose();
  };

  const renderCommand = (command: CommandItem): React.JSX.Element => {
    const index = filtered.indexOf(command);
    const selectedRow = index === selectedIndex;
    const sharedProps = {
      role: "option" as const,
      "aria-selected": selectedRow,
      selected: selectedRow,
      onPointerMove: () => setSelected(index),
      onClick: () => run(command)
    };

    if (command.kind === "session" && command.provider) {
      return (
        <CanvasMenuRow
          {...sharedProps}
          indent
          right={<CanvasMenuSub>{t(locale, "canvasMenuFocus")}</CanvasMenuSub>}
          key={command.id}
        >
          <span className="canvas-menu__provider">
            <ProviderIcon provider={command.provider} size="small" />
            {PROVIDERS[command.provider].label.toLocaleLowerCase(locale)} · {command.label}
          </span>
        </CanvasMenuRow>
      );
    }

    if (command.kind === "provider" && command.provider) {
      return (
        <CanvasMenuRow
          {...sharedProps}
          indent
          muted={command.provider === "terminal"}
          right={command.provider === "terminal"
            ? undefined
            : <CanvasMenuSub>{t(locale, "normal").toLocaleLowerCase(locale)}</CanvasMenuSub>}
          key={command.id}
        >
          <span className="canvas-menu__provider">
            <ProviderIcon provider={command.provider} size="small" />
            {command.label}
          </span>
        </CanvasMenuRow>
      );
    }

    return (
      <CanvasMenuRow
        {...sharedProps}
        icon={command.icon}
        muted
        right={command.shortcut ? <CanvasMenuKbd>{command.shortcut}</CanvasMenuKbd> : undefined}
        key={command.id}
      >{command.label}</CanvasMenuRow>
    );
  };

  return (
    <div
      className="canvas-command-palette__backdrop"
      data-interactive="true"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="canvas-menu canvas-command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t(locale, "commandPalette")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setSelected((current) => filtered.length === 0 ? 0 : (current + 1) % filtered.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setSelected((current) => filtered.length === 0 ? 0 : (current - 1 + filtered.length) % filtered.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            run(filtered[selectedIndex]);
          }
        }}
      >
        <label className="canvas-command-palette__search">
          <UiIcon name="search" size="1em" />
          <input
            ref={input}
            value={query}
            placeholder={t(locale, "commandPalettePlaceholder")}
            aria-label={t(locale, "commandPalettePlaceholder")}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <CanvasMenuKbd>Esc</CanvasMenuKbd>
        </label>
        <div className="canvas-command-palette__results" role="listbox">
          {filtered.length === 0 && (
            <p className="canvas-command-palette__empty">{t(locale, "commandPaletteEmpty")}</p>
          )}
          {sessionCommands.length > 0 && (
            <>
              <CanvasMenuLabel>{t(locale, "canvasMenuSessions")}</CanvasMenuLabel>
              {sessionCommands.map(renderCommand)}
            </>
          )}
          {sessionCommands.length > 0 && actionCommands.length > 0 && <CanvasMenuDivider />}
          {actionCommands.length > 0 && (
            <>
              <CanvasMenuLabel>{t(locale, "canvasMenuActions")}</CanvasMenuLabel>
              {actionCommands.map(renderCommand)}
            </>
          )}
        </div>
        <footer className="canvas-command-palette__footer">
          <span>{t(locale, "canvasMenuChoose")}</span>
          <span>{t(locale, "canvasMenuExecute")}</span>
          <span>{t(locale, "canvasMenuSharedModel")}</span>
        </footer>
      </section>
    </div>
  );
}
