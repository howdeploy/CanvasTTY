import arrowIcon from "../assets/icons/lucide/arrow-right.svg";
import appWindowIcon from "../assets/icons/lucide/app-window.svg";
import attentionIcon from "../assets/icons/lucide/circle-help.svg";
import blocksIcon from "../assets/icons/lucide/blocks.svg";
import checkIcon from "../assets/icons/lucide/check.svg";
import chevronIcon from "../assets/icons/lucide/chevron-down.svg";
import closeIcon from "../assets/icons/lucide/x.svg";
import copyIcon from "../assets/icons/lucide/copy.svg";
import crosshairIcon from "../assets/icons/lucide/crosshair.svg";
import downloadIcon from "../assets/icons/lucide/download.svg";
import errorIcon from "../assets/icons/lucide/circle-alert.svg";
import folderIcon from "../assets/icons/lucide/folder.svg";
import folderOpenIcon from "../assets/icons/lucide/folder-open.svg";
import clipboardPasteIcon from "../assets/icons/lucide/clipboard-paste.svg";
import ellipsisIcon from "../assets/icons/lucide/ellipsis.svg";
import fileIcon from "../assets/icons/lucide/file.svg";
import fileSearchIcon from "../assets/icons/lucide/file-search.svg";
import fileTextIcon from "../assets/icons/lucide/file-text.svg";
import filmIcon from "../assets/icons/lucide/film.svg";
import imageIcon from "../assets/icons/lucide/image.svg";
import messageSquarePlusIcon from "../assets/icons/lucide/message-square-plus.svg";
import musicIcon from "../assets/icons/lucide/music.svg";
import browserIcon from "../assets/icons/lucide/globe.svg";
import bringToFrontIcon from "../assets/icons/lucide/bring-to-front.svg";
import homeIcon from "../assets/icons/lucide/house.svg";
import imagePlusIcon from "../assets/icons/lucide/image-plus.svg";
import infoIcon from "../assets/icons/lucide/info.svg";
import maximizeIcon from "../assets/icons/lucide/square.svg";
import minusIcon from "../assets/icons/lucide/minus.svg";
import pinIcon from "../assets/icons/lucide/pin.svg";
import plusIcon from "../assets/icons/lucide/plus.svg";
import paletteIcon from "../assets/icons/lucide/palette.svg";
import pencilIcon from "../assets/icons/lucide/pencil.svg";
import searchIcon from "../assets/icons/lucide/search.svg";
import settingsIcon from "../assets/icons/lucide/settings.svg";
import slidersHorizontalIcon from "../assets/icons/lucide/sliders-horizontal.svg";
import stickyNoteIcon from "../assets/icons/lucide/sticky-note.svg";
import terminalIcon from "../assets/icons/lucide/square-terminal.svg";
import trashIcon from "../assets/icons/lucide/trash-2.svg";
import workingIcon from "../assets/icons/lucide/loader-circle.svg";
import zoomInIcon from "../assets/icons/lucide/zoom-in.svg";
import zoomOutIcon from "../assets/icons/lucide/zoom-out.svg";

export type UiIconName =
  | "app-window"
  | "settings"
  | "sliders-horizontal"
  | "blocks"
  | "info"
  | "home"
  | "zoom-in"
  | "zoom-out"
  | "close"
  | "minus"
  | "minimize"
  | "maximize"
  | "restore"
  | "copy"
  | "folder"
  | "browser"
  | "bring-to-front"
  | "terminal"
  | "reload"
  | "arrow"
  | "chevron"
  | "download"
  | "plus"
  | "palette"
  | "pencil"
  | "search"
  | "sticky-note"
  | "image-plus"
  | "image"
  | "file"
  | "file-text"
  | "file-search"
  | "film"
  | "music"
  | "pin"
  | "crosshair"
  | "remark-add"
  | "folder-open"
  | "clipboard-paste"
  | "ellipsis"
  | "trash"
  | "working"
  | "attention"
  | "error"
  | "done";

interface UiIconProps {
  name: UiIconName;
  size?: number | string;
}

const ICONS: Record<UiIconName, string> = {
  "app-window": appWindowIcon,
  settings: settingsIcon,
  "sliders-horizontal": slidersHorizontalIcon,
  blocks: blocksIcon,
  info: infoIcon,
  home: homeIcon,
  "zoom-in": zoomInIcon,
  "zoom-out": zoomOutIcon,
  close: closeIcon,
  minus: minusIcon,
  minimize: minusIcon,
  maximize: maximizeIcon,
  restore: copyIcon,
  copy: copyIcon,
  folder: folderIcon,
  browser: browserIcon,
  "bring-to-front": bringToFrontIcon,
  terminal: terminalIcon,
  reload: workingIcon,
  arrow: arrowIcon,
  chevron: chevronIcon,
  download: downloadIcon,
  plus: plusIcon,
  palette: paletteIcon,
  pencil: pencilIcon,
  search: searchIcon,
  "sticky-note": stickyNoteIcon,
  "image-plus": imagePlusIcon,
  image: imageIcon,
  file: fileIcon,
  "file-text": fileTextIcon,
  "file-search": fileSearchIcon,
  film: filmIcon,
  music: musicIcon,
  pin: pinIcon,
  crosshair: crosshairIcon,
  "remark-add": messageSquarePlusIcon,
  "folder-open": folderOpenIcon,
  "clipboard-paste": clipboardPasteIcon,
  ellipsis: ellipsisIcon,
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
