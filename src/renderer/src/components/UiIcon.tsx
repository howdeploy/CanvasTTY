import arrowIcon from "../assets/icons/lucide/arrow-right.svg";
import attentionIcon from "../assets/icons/lucide/circle-help.svg";
import checkIcon from "../assets/icons/lucide/check.svg";
import chevronIcon from "../assets/icons/lucide/chevron-down.svg";
import closeIcon from "../assets/icons/lucide/x.svg";
import copyIcon from "../assets/icons/lucide/copy.svg";
import errorIcon from "../assets/icons/lucide/circle-alert.svg";
import folderIcon from "../assets/icons/lucide/folder.svg";
import browserIcon from "../assets/icons/lucide/globe.svg";
import homeIcon from "../assets/icons/lucide/house.svg";
import imagePlusIcon from "../assets/icons/lucide/image-plus.svg";
import maximizeIcon from "../assets/icons/lucide/square.svg";
import minimizeIcon from "../assets/icons/lucide/minus.svg";
import plusIcon from "../assets/icons/lucide/plus.svg";
import settingsIcon from "../assets/icons/lucide/settings.svg";
import terminalIcon from "../assets/icons/lucide/square-terminal.svg";
import trashIcon from "../assets/icons/lucide/trash-2.svg";
import workingIcon from "../assets/icons/lucide/loader-circle.svg";
import zoomInIcon from "../assets/icons/lucide/zoom-in.svg";
import zoomOutIcon from "../assets/icons/lucide/zoom-out.svg";

export type UiIconName =
  | "settings"
  | "home"
  | "zoom-in"
  | "zoom-out"
  | "close"
  | "minimize"
  | "maximize"
  | "restore"
  | "copy"
  | "folder"
  | "browser"
  | "terminal"
  | "reload"
  | "arrow"
  | "chevron"
  | "download"
  | "plus"
  | "image-plus"
  | "trash"
  | "working"
  | "attention"
  | "error"
  | "done";

interface UiIconProps {
  name: UiIconName;
  size?: number;
}

const ICONS: Record<UiIconName, string> = {
  settings: settingsIcon,
  home: homeIcon,
  "zoom-in": zoomInIcon,
  "zoom-out": zoomOutIcon,
  close: closeIcon,
  minimize: minimizeIcon,
  maximize: maximizeIcon,
  restore: copyIcon,
  copy: copyIcon,
  folder: folderIcon,
  browser: browserIcon,
  terminal: terminalIcon,
  reload: workingIcon,
  arrow: arrowIcon,
  chevron: chevronIcon,
  download: chevronIcon,
  plus: plusIcon,
  "image-plus": imagePlusIcon,
  trash: trashIcon,
  working: workingIcon,
  attention: attentionIcon,
  error: errorIcon,
  done: checkIcon
};

export function UiIcon({ name, size = 24 }: UiIconProps): React.JSX.Element {
  const style = {
    width: size,
    height: size,
    "--ui-icon-source": `url("${ICONS[name]}")`
  } as React.CSSProperties;

  return <span className={`ui-icon ui-icon--${name}`} style={style} aria-hidden="true" />;
}
