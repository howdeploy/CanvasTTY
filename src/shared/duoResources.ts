import { IPC } from './contracts.ts';
/** Explicit capabilities. Window/camera, arbitrary IPC, credentials and destructive app settings are absent. */
export const DUO_FILE_READ_CHANNELS = new Set<string>([IPC.filesList, IPC.filesRead, IPC.filesSearch]);
export const DUO_READ_CHANNELS = new Set<string>([
  ...DUO_FILE_READ_CHANNELS,
  IPC.materialsSnapshot,IPC.browserGetState,IPC.pluginsList,
  IPC.authorThemesList,IPC.authorThemesPreview,IPC.wallpapersList,IPC.wallpapersRead,IPC.pixelSkinsList,IPC.pixelSkinsReadAsset,
  IPC.terminalBorderSkinsList,IPC.terminalBorderSkinsGet,IPC.mediaRead,IPC.pluginsStorageGet,
  IPC.pluginsMediaListLibraries,IPC.pluginsPlaylistsList,IPC.pluginsPlaylistsRead
]);
export const DUO_WRITE_CHANNELS = new Set<string>([
  IPC.filesLocations,IPC.filesListRoots,IPC.filesRegisterRoot,IPC.filesResolvePath,IPC.filesCloseRoot,
  IPC.materialsAddPaths,IPC.materialsSetBounds,IPC.materialsSetBoundsBatch,IPC.materialsRemove,IPC.materialsPinVersion,
  IPC.materialsAddRemark,IPC.materialsUpdateRemark,IPC.materialsDeleteRemark,
  IPC.browserOpen,IPC.browserClose,IPC.browserNewTab,IPC.browserSelectTab,IPC.browserCloseTab,IPC.browserCloseAllTabs,
  IPC.browserNavigate,IPC.browserBack,IPC.browserForward,IPC.browserReload,
  IPC.pluginsStorageSet,IPC.pluginsFilesRequest,IPC.pluginsServiceRequest,IPC.pluginsOpenBrowser,
  IPC.pluginsMediaScanLibrary,IPC.pluginsPlaylistsWrite,IPC.pluginsFileDropText
]);
export const DUO_LOCAL_BROWSER_SENDS = new Set<string>([IPC.browserSetViewport,IPC.browserFocus,IPC.browserSetInputFocused]);

/** Maximum concurrent chunked results retained for a connected guest. */
export const DUO_RESOURCE_TRANSFER_LIMIT = 8;
