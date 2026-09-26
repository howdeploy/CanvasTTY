import type { LocaleId, WindowState } from "../../../shared/contracts";
import appManifest from "../../../../package.json";
import { ProviderIcon } from "./ProviderIcon";
import { UiIcon } from "./UiIcon";
import { t } from "../lib/i18n";

const BUILD_CHANNEL = import.meta.env.DEV || import.meta.env.VITE_BUILD_CHANNEL === "DEV" ? "DEV" : "RELEASE";
const BUILD_LABEL = `${BUILD_CHANNEL} v${appManifest.version}`;

interface TitleBarProps {
  locale: LocaleId;
  windowState: WindowState;
  onWindowStateChange(state: WindowState): void;
}

export function TitleBar({ locale, windowState, onWindowStateChange }: TitleBarProps): React.JSX.Element | null {
  const toggleMaximize = async (): Promise<void> => {
    const state = await window.canvasTTY.window.toggleMaximize();
    onWindowStateChange(state);
  };

  if (windowState.isMacOS && windowState.fullscreen) return null;

  const controls = (
    <div className="titlebar__controls">
      <button type="button" onClick={() => window.canvasTTY.window.minimize()} aria-label="Minimize"><UiIcon name="minimize" size={17} /></button>
      <button type="button" onClick={() => void toggleMaximize()} aria-label="Maximize">
        <UiIcon name={windowState.maximized ? "restore" : "maximize"} size={16} />
      </button>
      <button className="titlebar__close" type="button" onClick={() => window.canvasTTY.window.close()} aria-label="Close"><UiIcon name="close" size={18} /></button>
    </div>
  );

  if (windowState.isMacOS) {
    return (
      <header className="titlebar titlebar--macos">
        <div className="titlebar__macos-controls-space" aria-hidden="true" />
        <div className="titlebar__brand">
          <span className="titlebar__logo"><ProviderIcon provider="terminal" size="small" /></span>
          <strong>CanvasTTY</strong>
          <span className={`titlebar__build titlebar__build--${BUILD_CHANNEL.toLowerCase()}`}>{BUILD_LABEL}</span>
          <span className="titlebar__subtitle">{t(locale, "appSubtitle")}</span>
        </div>
        <div className="titlebar__drag" />
      </header>
    );
  }

  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <span className="titlebar__logo"><ProviderIcon provider="terminal" size="small" /></span>
        <strong>CanvasTTY</strong>
        <span className={`titlebar__build titlebar__build--${BUILD_CHANNEL.toLowerCase()}`}>{BUILD_LABEL}</span>
        <span className="titlebar__subtitle">{t(locale, "appSubtitle")}</span>
      </div>
      <div className="titlebar__drag" />
      {controls}
    </header>
  );
}
