import type { LocaleId, UpdaterState } from "../../../../shared/contracts";
import { t } from "../../lib/i18n.ts";

export type UpdaterTone = "neutral" | "busy" | "ready" | "muted";

export interface UpdaterPresentation {
  /** One-line status ("Update available · v1.2.3"). */
  title: string;
  /** Supporting line: what the user can do next or why nothing can happen. */
  detail: string;
  tone: UpdaterTone;
  /** Percent for a determinate bar; null whenever progress is not actually known. */
  progress: number | null;
  /** Actions that are meaningful right now; anything not listed is not rendered. */
  actions: {
    check: "enabled" | "disabled" | "hidden";
    download: boolean;
    install: boolean;
  };
}

/**
 * Pure mapping from the updater state to what the Updates section shows. It
 * never invents progress: a download without a reported percent gets text, not
 * a bar, and "Install and restart" only exists once the download finished.
 */
export function updaterPresentation(
  state: UpdaterState,
  locale: LocaleId,
  currentVersion: string
): UpdaterPresentation {
  const version = `${t(locale, "updateCurrentVersion")}: v${currentVersion}`;
  switch (state.status) {
    case "checking":
      return {
        title: t(locale, "updateStatusChecking"),
        detail: version,
        tone: "busy",
        progress: null,
        actions: { check: "disabled", download: false, install: false }
      };
    case "available":
      return {
        title: `${t(locale, "updateAvailable")} · v${state.version}`,
        detail: t(locale, "updateAvailableHint"),
        tone: "ready",
        progress: null,
        // The main process treats a second "check" while an update is known as a download
        // request, so a Check button here would lie about what it does.
        actions: { check: "hidden", download: true, install: false }
      };
    case "downloading":
      return {
        title: state.percent === null
          ? t(locale, "updateStatusDownloadingProgressUnknown")
          : `${t(locale, "updateDownloading")} · ${state.percent}%`,
        detail: `v${state.version}`,
        tone: "busy",
        progress: state.percent,
        actions: { check: "disabled", download: false, install: false }
      };
    case "downloaded":
      return {
        title: `${t(locale, "updateDownloaded")} · v${state.version}`,
        detail: t(locale, "updateStatusDownloadedHint"),
        tone: "ready",
        progress: null,
        actions: { check: "hidden", download: false, install: true }
      };
    case "unavailable":
      return {
        title: t(locale, "updateUnavailable"),
        detail: state.reason === "dev"
          ? t(locale, "updateUnavailableDev")
          : state.reason === "offline"
            ? t(locale, "updateUnavailableOffline")
            : t(locale, "updateUnavailableError"),
        tone: "muted",
        progress: null,
        actions: { check: state.reason === "dev" ? "disabled" : "enabled", download: false, install: false }
      };
    default:
      return {
        title: t(locale, "updateStatusIdle"),
        detail: version,
        tone: "neutral",
        progress: null,
        actions: { check: "enabled", download: false, install: false }
      };
  }
}
