import type { ReactNode } from "react";

export function SettingGroup({
  label,
  description,
  layout = "field",
  children
}: {
  label: string;
  description?: string;
  layout?: "field" | "stacked";
  children: ReactNode;
}): React.JSX.Element {
  return (
    <section data-setting-label={label} tabIndex={-1} className={`setting-group setting-group--field${layout === "stacked" ? " setting-group--stacked" : ""}`}>
      <div className="setting-group__copy">
        <h3>{label}</h3>
        {description && <p className="setting-group__description">{description}</p>}
      </div>
      <div className="setting-group__control">{children}</div>
    </section>
  );
}

export function Segmented({
  value,
  options,
  wrap = false,
  disabled = false,
  onChange
}: {
  value: string;
  options: [string, string][];
  wrap?: boolean;
  disabled?: boolean;
  onChange(value: string): void;
}): React.JSX.Element {
  return (
    <div className={`segmented ${wrap ? "segmented--wrap" : ""}`}>
      {options.map(([optionValue, label]) => (
        <button
          className={value === optionValue ? "segmented__button segmented__button--active" : "segmented__button"}
          type="button"
          key={optionValue}
          aria-pressed={value === optionValue}
          disabled={disabled}
          onClick={() => onChange(optionValue)}
        >{label}</button>
      ))}
    </div>
  );
}
