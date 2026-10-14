import { useEffect, useState } from "react";
import type {
  InstalledPlugin,
  LocaleId,
  PluginEnvironmentKind,
  PluginLaunchField,
  PluginLaunchFieldOptions,
  PluginLaunchValues,
  ProviderId,
  SessionEnvironmentChoice
} from "../../../../shared/contracts";
import { t } from "../../lib/i18n";
import { withServiceOptions } from "./launchFieldOptions";
import { launchFieldLabel, pluginName } from "../../../../shared/pluginLocalizedText.ts";

/** The plugin's name, with its `name.ru`/`name.en` for the UI language. */
type PluginNames = Pick<InstalledPlugin["manifest"], "name" | "name.ru" | "name.en">;

function names(plugin: InstalledPlugin): PluginNames {
  const { name, "name.ru": ru, "name.en": en } = plugin.manifest;
  return { name, ...(ru ? { "name.ru": ru } : {}), ...(en ? { "name.en": en } : {}) };
}

interface LaunchOptionPlugin extends PluginNames {
  pluginId: string;
  fields: PluginLaunchField[];
}

interface EnvironmentOption extends PluginNames {
  pluginId: string;
  kind: PluginEnvironmentKind;
}

/** Plugins whose trusted launch service offers options for this agent. A plain terminal takes none. */
function launchOptionPlugins(plugins: readonly InstalledPlugin[], provider: ProviderId): LaunchOptionPlugin[] {
  if (provider === "terminal") return [];
  return plugins.flatMap((plugin) => {
    const launch = plugin.manifest.services?.find((service) => service.launch)?.launch;
    if (!plugin.enabled || !plugin.nativeCodeTrusted || !launch) return [];
    if (!plugin.manifest.permissions.includes("launch:contribute")) return [];
    if (launch.appliesTo && !launch.appliesTo.includes(provider)) return [];
    // A policy-only contributor has nothing to choose: it is asked on every launch anyway.
    if (launch.policy && launch.fields.length === 0) return [];
    return [{ pluginId: plugin.manifest.id, ...names(plugin), fields: launch.fields }];
  }).sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

/** Environment kinds of trusted plugin services that apply to this provider ("Where"). */
export function environmentOptions(plugins: readonly InstalledPlugin[], provider: ProviderId): EnvironmentOption[] {
  return plugins.flatMap((plugin) => {
    const kinds = plugin.manifest.services?.flatMap((service) => service.environments ?? []) ?? [];
    if (!plugin.enabled || !plugin.nativeCodeTrusted || kinds.length === 0) return [];
    if (!plugin.manifest.permissions.includes("environment:provide")) return [];
    return kinds
      .filter((kind) => !kind.appliesTo || kind.appliesTo.includes(provider))
      .map((kind) => ({ pluginId: plugin.manifest.id, ...names(plugin), kind }));
  }).sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

function defaults(fields: readonly PluginLaunchField[]): PluginLaunchValues {
  return Object.fromEntries(fields.map((field) => [field.key, field.default
    ?? (field.kind === "boolean" ? false : field.kind === "select" ? field.options?.[0]?.value ?? "" : "")]));
}

function FieldInputs({ fields, values, locale, onChange }: {
  fields: readonly PluginLaunchField[];
  locale: LocaleId;
  values: PluginLaunchValues;
  onChange(values: PluginLaunchValues): void;
}): React.JSX.Element {
  return (
    <>
      {fields.map((field) => (
        <label key={field.key} className={`launch-advanced__field launch-advanced__field--${field.kind}`}>
          {field.kind === "boolean" && (
            <input type="checkbox" checked={values[field.key] === true}
              onChange={(event) => onChange({ ...values, [field.key]: event.target.checked })} />
          )}
          <span>{launchFieldLabel(field, locale)}</span>
          {field.kind === "select" && (
            <select value={String(values[field.key])}
              onChange={(event) => onChange({ ...values, [field.key]: event.target.value })}>
              {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          )}
          {field.kind === "text" && (
            <input type="text" value={String(values[field.key])} maxLength={field.maxLength ?? 200}
              onChange={(event) => onChange({ ...values, [field.key]: event.target.value })} />
          )}
        </label>
      ))}
    </>
  );
}

/**
 * The launcher's "Advanced" section: where the session runs (this computer unless the person picks a
 * plugin environment), then one block per launch plugin, off until the person chooses it. Only chosen
 * plugins' values are returned, and only those plugins prepare the launch.
 */
export function LaunchOptionsSection({ provider, locale, onChange, onEnvironmentChange }: {
  provider: ProviderId;
  locale: LocaleId;
  onChange(options: Record<string, PluginLaunchValues>): void;
  onEnvironmentChange(environment: SessionEnvironmentChoice | null): void;
}): React.JSX.Element | null {
  // Lists are tagged with the agent they were loaded for. After the agent changes, the previous lists
  // stay in state until the new answer arrives, and offering them would let the person tick a plugin
  // for an agent it does not apply to; so a list is shown only while its agent is still chosen.
  const [loaded, setLoaded] = useState<{
    provider: ProviderId;
    plugins: LaunchOptionPlugin[];
    environments: EnvironmentOption[];
  } | null>(null);
  const [offered, setOffered] = useState<Record<string, PluginLaunchFieldOptions>>({});
  const [chosen, setChosen] = useState<Record<string, PluginLaunchValues>>({});
  const [where, setWhere] = useState<SessionEnvironmentChoice | null>(null);

  useEffect(() => {
    let active = true;
    setChosen({});
    setWhere(null);
    setOffered({});
    void window.canvasTTY.plugins.list().then((installed) => {
      if (!active) return;
      const available = launchOptionPlugins(installed, provider);
      setLoaded({ provider, plugins: available, environments: environmentOptions(installed, provider) });
      // Selects filled by the plugin's service (its accounts, say): asked once per launcher, never blocking it.
      for (const plugin of available.filter((entry) => entry.fields.some((field) => field.optionsFrom === "service"))) {
        void window.canvasTTY.plugins.launchFieldOptions(plugin.pluginId, provider).then((options) => {
          if (active) setOffered((current) => ({ ...current, [plugin.pluginId]: options }));
        }).catch(() => undefined);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [provider]);

  useEffect(() => onChange(chosen), [chosen, onChange]);
  useEffect(() => onEnvironmentChange(where), [where, onEnvironmentChange]);

  const current = loaded?.provider === provider ? loaded : null;
  const plugins = current?.plugins ?? [];
  const environments = current?.environments ?? [];
  if (plugins.length === 0 && environments.length === 0) return null;
  const update = (pluginId: string, values: PluginLaunchValues | null): void => {
    setChosen((current) => {
      const next = { ...current };
      if (values) next[pluginId] = values;
      else delete next[pluginId];
      return next;
    });
  };
  const selectedIndex = where
    ? environments.findIndex((option) => option.pluginId === where.pluginId && option.kind.kind === where.kind)
    : -1;
  const selected = selectedIndex >= 0 ? environments[selectedIndex] : undefined;

  return (
    <details className="launch-advanced" open={environments.length > 0 && provider === "terminal"}>
      <summary>{t(locale, "launchAdvanced")}</summary>
      {environments.length > 0 && (
        <fieldset className="launch-advanced__plugin">
          <label className="launch-advanced__where">
            <span>{t(locale, "launchWhere")}</span>
            <select value={String(selectedIndex)} onChange={(event) => {
              const option = environments[Number(event.target.value)];
              setWhere(option ? {
                pluginId: option.pluginId,
                kind: option.kind.kind,
                ...(option.kind.fields?.length ? { options: defaults(option.kind.fields) } : {})
              } : null);
            }}>
              <option value="-1">{t(locale, "launchWhereLocal")}</option>
              {environments.map((option, index) => (
                <option key={`${option.pluginId}/${option.kind.kind}`} value={String(index)} title={option.kind.description}>
                  {option.kind.label} · {pluginName(option, locale)}
                </option>
              ))}
            </select>
          </label>
          {selected && where?.options && (
            <FieldInputs fields={selected.kind.fields ?? []} values={where.options} locale={locale}
              onChange={(options) => setWhere({ ...where, options })} />
          )}
        </fieldset>
      )}
      {plugins.map((plugin) => {
        const values = chosen[plugin.pluginId];
        const fields = withServiceOptions(plugin.fields, offered[plugin.pluginId]);
        return (
          <fieldset key={plugin.pluginId} className="launch-advanced__plugin">
            <label className="launch-advanced__use">
              <input type="checkbox" checked={Boolean(values)}
                onChange={(event) => update(plugin.pluginId, event.target.checked ? defaults(fields) : null)} />
              <span>{t(locale, "launchUsePlugin")} {pluginName(plugin, locale)}</span>
            </label>
            {values && <FieldInputs fields={fields} values={values} locale={locale} onChange={(next) => update(plugin.pluginId, next)} />}
          </fieldset>
        );
      })}
    </details>
  );
}
