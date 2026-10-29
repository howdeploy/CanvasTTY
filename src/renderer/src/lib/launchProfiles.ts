import type { LaunchProfileId, ProviderId } from "../../../shared/contracts";
import { autoKind, BYPASS_CHANGES_NOTHING } from "../../../shared/autoMode";
import type { TranslationKey } from "./i18n";

export const PROFILE_LABELS: Record<LaunchProfileId, TranslationKey> = {
  auto: "autoProfile", normal: "manualProfile", acceptEdits: "acceptEditsProfile", plan: "planProfile", yolo: "bypassProfile",
  ask: "askProfile", askCached: "askCachedProfile", dontAsk: "dontAskProfile", readOnly: "readOnlyProfile", autonomous: "autonomousProfile"
};

const PROFILE_NOTES: Partial<Record<LaunchProfileId, TranslationKey>> = {
  normal: "manualNote", acceptEdits: "acceptEditsNote", ask: "askNote", askCached: "askCachedNote",
  dontAsk: "dontAskNote", readOnly: "readOnlyNote", autonomous: "autonomousNote"
};

/** The same native-mode explanation in the launcher and on the running card. */
export function profileNoteKey(provider: ProviderId, profile: LaunchProfileId): TranslationKey | null {
  if (profile === "auto") {
    const kind = autoKind(provider);
    if (provider === "kimi") return "autoNoteKimi";
    if (provider === "antigravity") return "autoNoteAntigravity";
    if (provider === "grok") return "autoNoteGrok";
    return kind === "native" ? "autoNoteNative" : kind === "config" ? "autoNoteOpenCode" : kind === "contained" ? "autoNoteContained" : null;
  }
  if (profile === "plan") return provider === "codex" ? "planNoteCodex" : "planNote";
  if (profile === "yolo" && BYPASS_CHANGES_NOTHING.has(provider)) return "bypassChangesNothing";
  if (profile === "yolo" && provider === "kimi") return "bypassNoteKimi";
  return PROFILE_NOTES[profile] ?? null;
}
