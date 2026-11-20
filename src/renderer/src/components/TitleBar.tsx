import type { LocaleId, WindowState } from "../../../shared/contracts";
import appManifest from "../../../../package.json";
import appLogo from "../../../../docs/assets/canvastty-logo-dark.svg?url";
import { UiIcon } from "./UiIcon";
import { t } from "../lib/i18n";

const IS_LOCAL_LAB = import.meta.env.VITE_BUILD_CHANNEL === "LOCAL";
const APP_NAME = IS_LOCAL_LAB ? import.meta.env.VITE_APP_NAME || "CanvasTTY Live Home" : "CanvasTTY";
const BUILD_CHANNEL = IS_LOCAL_LAB ? "LOCAL" : import.meta.env.DEV || import.meta.env.VITE_BUILD_CHANNEL === "DEV" ? "DEV" : "RELEASE";
const BUILD_LABEL = `${BUILD_CHANNEL} v${import.meta.env.VITE_BUILD_VERSION || appManifest.version}`;

interface TitleBarProps {
  locale: LocaleId;
  actionsRef?: React.Ref<HTMLDivElement>;
  windowState: WindowState;
  onWindowStateChange(state: WindowState): void;
}

export function TitleBar({ actionsRef, locale, windowState, onWindowStateChange }: TitleBarProps): React.JSX.Element | null {
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

  return (
    <header className={windowState.isMacOS ? "titlebar titlebar--macos" : "titlebar"}>
      {windowState.isMacOS && <div className="titlebar__macos-controls-space" aria-hidden="true" />}
      <div className="titlebar__brand">
        <img className="titlebar__logo" src={appLogo} alt="" aria-hidden="true" />
        <strong>{APP_NAME}</strong>
        <span className={`titlebar__build titlebar__build--${BUILD_CHANNEL.toLowerCase()}`}>{BUILD_LABEL}</span>
        <span className="titlebar__subtitle">{t(locale, "appSubtitle")}</span>
      </div>
      <div className="titlebar__drag" />
      <div ref={actionsRef} className="titlebar__actions" />
      {!windowState.isMacOS && controls}
    </header>
  );
}
