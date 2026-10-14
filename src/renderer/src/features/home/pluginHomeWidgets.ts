import type { InstalledPlugin, LocaleId, PluginGridSize } from "../../../../shared/contracts";
import { contributionTitle, pluginName } from "../../../../shared/pluginLocalizedText.ts";
import { pluginWidgetId } from "./homeLayout.ts";

export interface PluginHomeWidgetOption {
  widgetId: string;
  label: string;
  description: string;
  size: PluginGridSize;
  pluginEnabled: boolean;
  required?: false;
}

export function pluginHomeWidgetOptions(plugins: readonly InstalledPlugin[], locale: LocaleId): PluginHomeWidgetOption[] {
  return plugins.flatMap((plugin) => plugin.manifest.contributions
    .filter((contribution) => contribution.kind === "home-widget")
    .map((contribution) => ({
      widgetId: pluginWidgetId(plugin.manifest.id, contribution.id),
      label: contributionTitle(contribution, locale),
      description: contribution.description
        ? `${pluginName(plugin.manifest, locale)} · ${contribution.description}`
        : pluginName(plugin.manifest, locale),
      size: contribution.defaultSize,
      pluginEnabled: plugin.enabled
    })));
}
