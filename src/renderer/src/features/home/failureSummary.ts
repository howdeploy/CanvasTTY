import type { LocaleId, SessionStatus } from "../../../../shared/contracts";
import { t } from "../../lib/i18n.ts";

/** Exit status the shell and the launcher both use for "command not found / not runnable". */
export const LAUNCH_FAILURE_EXIT_CODE = 127;
const MAX_CAUSE_LINE_CHARS = 160;

/**
 * Lines that look like a failure report. Kept deliberately narrow: a line is only
 * promoted to "possible cause" when it names an error, never because it is the
 * last thing the terminal printed.
 */
const CAUSE_LINE_PATTERN = /\b(error|fatal|exception|traceback|panic|failed|failure|cannot|can't|unable to|not found|denied|refused|timed out|timeout)\b/i;

/**
 * Update banners the agent CLIs print at startup ("A new version of Codex is
 * available…"). They are informational chrome, so they must never be presented
 * as the reason a session failed even when they contain words like "update".
 */
const UPDATE_BANNER_PATTERN = /\b(update available|new version|newer version|latest version|upgrade (?:to|now|available)|to update|npm (?:i|install) -g|brew upgrade|is out of date|outdated)\b/i;

export interface FailureSummaryInput {
  status: SessionStatus;
  exitCode: number | null;
  failureDetails: string | null;
}

export interface FailureSummary {
  /** Short, understandable first line: what happened. */
  headline: string;
  /** One-line detail under the headline (origin or "cause unknown" explanation). */
  detail: string;
  /** Best-effort line quoted from the diagnostics, or null when none qualifies. */
  possibleCause: string | null;
  /** True when at least the exit status or a cause line is known. */
  causeKnown: boolean;
  /** Raw terminal diagnostics for the collapsed section, or null when nothing was captured. */
  diagnostics: string | null;
}

/** True for lines that are an update banner rather than a failure report. */
export function isUpdateBannerLine(line: string): boolean {
  return UPDATE_BANNER_PATTERN.test(line);
}

/**
 * The first line of the diagnostics that reads like an error, skipping update
 * banners. Null when nothing qualifies: an honest "cause unknown" beats a
 * guess quoted from unrelated output.
 */
export function possibleCauseLine(diagnostics: string | null): string | null {
  if (!diagnostics) return null;
  const lines = diagnostics.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const candidate = lines.find((line) => CAUSE_LINE_PATTERN.test(line) && !isUpdateBannerLine(line));
  if (!candidate) return null;
  return candidate.length > MAX_CAUSE_LINE_CHARS ? `${candidate.slice(0, MAX_CAUSE_LINE_CHARS - 1)}…` : candidate;
}

/**
 * Summary for a failed session, derived only from what is actually known: the
 * exit code, the launch origin (exit 127) and an error-looking line from the
 * captured output. Null for every status other than `failed`.
 */
export function failureSummary(input: FailureSummaryInput, locale: LocaleId): FailureSummary | null {
  if (input.status !== "failed") return null;

  const diagnostics = input.failureDetails && input.failureDetails.trim().length > 0 ? input.failureDetails : null;
  const possibleCause = possibleCauseLine(diagnostics);

  if (input.exitCode === LAUNCH_FAILURE_EXIT_CODE) {
    return {
      headline: t(locale, "failureSummaryLaunch"),
      detail: t(locale, "failureSummaryLaunchDetail"),
      possibleCause,
      causeKnown: true,
      diagnostics
    };
  }

  if (input.exitCode !== null) {
    return {
      headline: `${t(locale, "failureSummaryExitCode")}${input.exitCode}`,
      detail: possibleCause === null ? t(locale, "failureCauseUnknown") : t(locale, "failurePossibleCause"),
      possibleCause,
      causeKnown: true,
      diagnostics
    };
  }

  return {
    headline: possibleCause === null ? t(locale, "failureCauseUnknown") : t(locale, "statusFailed"),
    detail: possibleCause === null ? t(locale, "failureCauseUnknownDetail") : t(locale, "failurePossibleCause"),
    possibleCause,
    causeKnown: possibleCause !== null,
    diagnostics
  };
}

/** Plain text for the clipboard: summary first, raw diagnostics after. */
export function failureClipboardText(summary: FailureSummary): string {
  const lines = [summary.headline, summary.detail];
  if (summary.possibleCause) lines.push(summary.possibleCause);
  if (summary.diagnostics) lines.push("", summary.diagnostics);
  return lines.join("\n");
}
