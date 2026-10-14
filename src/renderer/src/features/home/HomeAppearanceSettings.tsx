import type { AppSettings, InstalledPlugin, PluginGridSize } from "../../../../shared/contracts";
import { t, type TranslationKey } from "../../lib/i18n";
import { pluginHomeWidgetOptions } from "./pluginHomeWidgets";

interface HomeAppearanceSettingsProps {
  settings: AppSettings;
  plugins: InstalledPlugin[];
  onToggleHomeWidget(widgetId: string, size: PluginGridSize): Promise<void>;
  onEditHome(): void;
}

const CORE_WIDGETS: Array<{
  widgetId: string;
  label: TranslationKey;
  description?: TranslationKey;
  size: PluginGridSize;
  required?: boolean;
}> = [
  { widgetId: "core.limits", label: "modelLimits", size: { columns: 7, rows: 3 } },
  { widgetId: "core.sessions", label: "activeSessions", size: { columns: 5, rows: 3 } },
  { widgetId: "core.clock", label: "clock", size: { columns: 9, rows: 3 } },
  {
    widgetId: "core.media",
    label: "personalMedia",
    description: "personalMediaDescription",
    size: { columns: 3, rows: 3 }
  },
  { widgetId: "core.launcher", label: "launcher", size: { columns: 10, rows: 2 } },
  { widgetId: "core.settings", label: "settings", size: { columns: 2, rows: 2 }, required: true }
];

export function HomeAppearanceSettings({
  settings,
  plugins,
  onToggleHomeWidget,
  onEditHome
}: HomeAppearanceSettingsProps): React.JSX.Element {
  const locale = settings.locale;
  const widgets = [
    ...CORE_WIDGETS.map((widget) => ({
      ...widget,
      label: t(locale, widget.label),
      description: widget.description ? t(locale, widget.description) : undefined,
      pluginEnabled: true
    })),
    ...pluginHomeWidgetOptions(plugins, locale)
  ];

  return (
    <section className="setting-group home-appearance-settings">
      <div className="setting-group__heading-row">
        <h3>{t(locale, "homeComposition")}</h3>
        <button className="setting-inline-action" type="button" onClick={onEditHome}>
          {t(locale, "editHome")}
        </button>
      </div>
      <p className="setting-group__description">{t(locale, "homeCompositionDescription")}</p>
      <div className="home-grid-size" aria-label={t(locale, "homeBoundary")}>
        <span>{t(locale, "homeBoundary")}</span>
        <strong>{settings.homeGridSize.columns} × {settings.homeGridSize.rows}</strong>
      </div>
      <div className="home-widget-list">
        {widgets.map((widget) => {
          const present = settings.homeLayout.some((placement) => placement.widgetId === widget.widgetId);
          return (
            <div className="home-widget-list__row" key={widget.widgetId}>
              <span>
                <strong>{widget.label}</strong>
                {widget.description && <small>{widget.description}</small>}
              </span>
              <button
                type="button"
                disabled={widget.required || (!widget.pluginEnabled && !present)}
                onClick={() => void onToggleHomeWidget(widget.widgetId, widget.size)}
              >{present ? t(locale, "removeFromHome") : t(locale, "addToHome")}</button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
