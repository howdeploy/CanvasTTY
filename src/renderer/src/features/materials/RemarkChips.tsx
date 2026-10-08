import type { LocaleId, MaterialRemark } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";
import { remarkStatusClass, remarkStatusKey } from "./materialRemarksModel";

export function RemarkChips({
  locale,
  label,
  remarks,
  onSelect
}: {
  locale: LocaleId;
  label: string;
  remarks: readonly MaterialRemark[];
  onSelect(remarkId: string): void;
}): React.JSX.Element {
  return (
    <div className="material-card__remarks">
      <span>{label}</span>
      {remarks.map((remark) => <RemarkChip key={remark.id} locale={locale} remark={remark} onSelect={onSelect} />)}
    </div>
  );
}

export function RemarkChip({
  locale,
  remark,
  onSelect
}: {
  locale: LocaleId;
  remark: MaterialRemark;
  onSelect(remarkId: string): void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`material-card__chip ${remarkStatusClass(remark.status)}`}
      title={t(locale, remarkStatusKey(remark.status))}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(remark.id);
      }}
    >
      #{remark.number}
    </button>
  );
}
