import type { DataHandlingAssessment, LocaleId } from "../../../../shared/contracts";
import { t, type TranslationKey } from "../../lib/i18n";

type ProfileKey = keyof Pick<DataHandlingAssessment["profile"], "training" | "retention" | "thirdPartyProcessing" | "contractualMode">;
const fields: [ProfileKey, TranslationKey, [string, TranslationKey][]][] = [
  ["training", "assessmentTraining", [["unknown", "assessmentUnknown"], ["none", "assessmentNone"], ["opt-in", "assessmentOptIn"], ["opt-out", "assessmentOptOut"], ["may-train", "assessmentMayTrain"]]],
  ["retention", "assessmentRetention", [["unknown", "assessmentUnknown"], ["zero", "assessmentZero"], ["bounded", "assessmentBounded"], ["persistent", "assessmentPersistent"]]],
  ["thirdPartyProcessing", "assessmentThirdParty", [["unknown", "assessmentUnknown"], ["no", "assessmentNo"], ["yes", "assessmentYes"]]],
  ["contractualMode", "assessmentContract", [["consumer", "assessmentConsumer"], ["api", "assessmentApi"], ["business", "assessmentBusiness"], ["enterprise", "assessmentEnterprise"], ["self-hosted", "assessmentSelfHosted"]]]
];
export function DataHandlingAssessmentEditor({ locale, value, disabled, onChange, onSave }: {
  locale: LocaleId; value: DataHandlingAssessment; disabled: boolean; onChange(value: DataHandlingAssessment): void; onSave(): void;
}): React.JSX.Element {
  const evidence = value.evidence;
  const updateEvidence = (patch: Partial<typeof evidence>): void => onChange({ ...value, evidence: { ...evidence, ...patch } });
  return <details className="connection-assessment">
    <summary>{t(locale, "assessmentTitle")}</summary>
    <p className="agent-settings-hint">{t(locale, "assessmentExplanation")}</p>
    <div className="agent-settings-grid">
      {fields.map(([key, label, options]) => <label key={key} className="agent-settings-field"><span>{t(locale, label)}</span><select disabled={disabled} value={value.profile[key]} onChange={event => onChange({ ...value, profile: { ...value.profile, [key]: event.target.value } })}>{options.map(([id, title]) => <option key={id} value={id}>{t(locale, title)}</option>)}</select></label>)}
      <label className="agent-settings-field"><span>{t(locale, "assessmentKind")}</span><select disabled={disabled} value={evidence.kind} onChange={event => updateEvidence({ kind: event.target.value as typeof evidence.kind })}>{([['user-attested', 'assessmentAttested'], ['provider-documentation', 'assessmentDocumentation'], ['organization-contract', 'assessmentOrganization']] as const).map(([id, label]) => <option key={id} value={id}>{t(locale, label)}</option>)}</select></label>
      <label className="agent-settings-field"><span>{t(locale, "assessmentDate")}</span><input type="date" disabled={disabled} value={evidence.reviewedAt} onChange={event => updateEvidence({ reviewedAt: event.target.value })} /></label>
      <label className="agent-settings-field agent-settings-field--wide"><span>{t(locale, "assessmentSources")}</span><textarea disabled={disabled} rows={3} value={evidence.sources.join("\n")} onChange={event => updateEvidence({ sources: event.target.value.split("\n") })} /></label>
      <label className="agent-settings-field agent-settings-field--wide"><span>{t(locale, "assessmentNote")}</span><textarea disabled={disabled} rows={3} maxLength={4000} value={evidence.note ?? ""} onChange={event => updateEvidence({ note: event.target.value })} /></label>
      <label className="agent-settings-field"><span>{t(locale, "assessmentCoverage")}</span><select disabled={disabled} value={evidence.models === "*" ? "all" : "list"} onChange={event => updateEvidence({ models: event.target.value === "all" ? "*" : [] })}><option value="all">{t(locale, "assessmentCoverageAll")}</option><option value="list">{t(locale, "assessmentCoverageList")}</option></select></label>
      {evidence.models !== "*" && <label className="agent-settings-field agent-settings-field--wide"><span>{t(locale, "accountModelsList")}</span><textarea disabled={disabled} rows={3} value={evidence.models.join("\n")} onChange={event => updateEvidence({ models: event.target.value.split("\n") })} /></label>}
    </div>
    <label className="agent-settings-check"><input type="checkbox" disabled={disabled} checked={value.trustedSelfHosted === true} onChange={event => onChange({ ...value, trustedSelfHosted: event.target.checked })} /><span>{t(locale, "assessmentTrusted")}</span></label>
    <p className="agent-settings-hint">{t(locale, "assessmentTrustedNote")}</p>
    <button type="button" className="agent-settings-button" disabled={disabled} onClick={onSave}>{t(locale, "assessmentSave")}</button>
  </details>;
}
