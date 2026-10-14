import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { contributionTitle, launchFieldLabel, pluginName } from "../src/shared/pluginLocalizedText.ts";
import { pluginHomeWidgetOptions } from "../src/renderer/src/features/home/pluginHomeWidgets.ts";
import { findAll, importWithFakeReact, tick } from "./helpers/fake-react.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// A plugin's texts the person reads (its name, its surfaces' titles, its launch fields' labels) may come in
// the app's languages, like the manifest's description.ru/description.en; the app shows its language's.
function manifest(overrides = {}) {
  return {
    apiVersion: 2,
    id: "com.example.localized",
    name: "Assistant",
    "name.ru": "Ассистент",
    "name.en": "Assistant EN",
    version: "1.0.0",
    description: "Localized surfaces.",
    permissions: ["launch:contribute"],
    settingsContribution: "settings",
    contributions: [
      { id: "settings", kind: "canvas-app", title: "Settings", "title.ru": "Настройки", "title.en": "Settings EN",
        entry: "apps/settings.html", defaultSize: { width: 680, height: 440 } },
      { id: "status", kind: "home-widget", title: "Status", "title.ru": "Статус", entry: "widgets/status.html",
        defaultSize: { columns: 4, rows: 2 } },
      { id: "plain", kind: "window", title: "Plain", entry: "windows/plain.html", defaultSize: { width: 900, height: 620 } }
    ],
    services: [{
      id: "launcher", title: "Launcher", entry: "services/launcher.mjs",
      launch: {
        fields: [
          { key: "account", label: "Account", "label.ru": "Аккаунт", "label.en": "Account EN", kind: "select",
            options: [{ value: "a", label: "A" }] },
          { key: "on", label: "On", kind: "boolean" }
        ]
      }
    }],
    ...overrides
  };
}

test("the manifest validator keeps localized names, titles and labels and checks them like the texts they translate", () => {
  const valid = validatePluginManifest(manifest());
  assert.equal(valid["name.ru"], "Ассистент");
  assert.equal(valid["name.en"], "Assistant EN");
  assert.deepEqual(valid.contributions.map((item) => [item.title, item["title.ru"], item["title.en"]]), [
    ["Settings", "Настройки", "Settings EN"], ["Status", "Статус", undefined], ["Plain", undefined, undefined]
  ]);
  assert.ok(!("title.ru" in valid.contributions[2]), "absent translations stay absent");
  assert.deepEqual(valid.services[0].launch.fields[0], {
    key: "account", label: "Account", "label.ru": "Аккаунт", "label.en": "Account EN", kind: "select", options: [{ value: "a", label: "A" }]
  });
  assert.deepEqual(valid.services[0].launch.fields[1], { key: "on", label: "On", kind: "boolean" });

  const long = "ж".repeat(81);
  assert.throws(() => validatePluginManifest(manifest({ "name.ru": long })), /name\.ru/u, "80 characters, like name");
  assert.throws(() => validatePluginManifest(manifest({ "name.en": "" })), /name\.en/u);
  assert.throws(() => validatePluginManifest(manifest({ "name.de": "Assistent" })), /name\.de/u, "only the app's languages");
  const contribution = (extra) => manifest({ contributions: [{ ...manifest().contributions[0], ...extra }] });
  assert.throws(() => validatePluginManifest(contribution({ "title.ru": long })), /title\.ru/u);
  assert.throws(() => validatePluginManifest(contribution({ "title.en": 7 })), /title\.en/u);
  assert.throws(() => validatePluginManifest(contribution({ "title.de": "Einstellungen" })), /title\.de/u);
  const field = (extra) => manifest({ services: [{ ...manifest().services[0], launch: { fields: [{ key: "on", label: "On", kind: "boolean", ...extra }] } }] });
  assert.throws(() => validatePluginManifest(field({ "label.ru": long })), /label\.ru/u);
  assert.throws(() => validatePluginManifest(field({ "label.en": "" })), /label\.en/u);
  assert.throws(() => validatePluginManifest(field({ "label.de": "An" })), /label\.de/u);
});

test("the helpers pick the UI language's text and fall back to the plain one", () => {
  const valid = validatePluginManifest(manifest());
  const [settings, status] = valid.contributions;
  assert.equal(pluginName(valid, "ru"), "Ассистент");
  assert.equal(pluginName(valid, "en"), "Assistant EN");
  assert.equal(pluginName({ name: "Plain" }, "ru"), "Plain");
  assert.equal(contributionTitle(settings, "ru"), "Настройки");
  assert.equal(contributionTitle(status, "en"), "Status", "no title.en: title");
  assert.equal(launchFieldLabel(valid.services[0].launch.fields[0], "ru"), "Аккаунт");
  assert.equal(launchFieldLabel(valid.services[0].launch.fields[1], "ru"), "On");
});

test("the schema and the plugin API types document the localized keys and the UI scale", async () => {
  const schema = JSON.parse(await read("docs/canvastty-plugin.schema.json"));
  for (const key of ["name.ru", "name.en"]) assert.equal(schema.properties[key].maxLength, 80, key);
  for (const key of ["title.ru", "title.en"]) assert.equal(schema.$defs.baseContribution.properties[key].maxLength, 80, key);
  for (const key of ["label.ru", "label.en"]) assert.equal(schema.$defs.launchField.properties[key].maxLength, 80, key);
  const api = await read("docs/plugin-api.d.ts");
  assert.match(api, /appearance: \{[^}]*uiScale: number;/su);
  assert.match(api, /"label\.ru"\?: string;/u);
  for (const doc of ["docs/plugins.md", "docs/plugins.ru.md", "docs/plugins.zh-CN.md"]) {
    const text = await read(doc);
    assert.match(text, /appearance\.uiScale/u, doc);
    for (const key of ["name.ru", "title.ru", "label.ru"]) assert.ok(text.includes(`"${key}"`), `${doc}: ${key}`);
  }
});

test("HOME composition lists plugin widgets by their localized title and plugin name", () => {
  const plugin = { manifest: validatePluginManifest(manifest()), enabled: true };
  const [widget] = pluginHomeWidgetOptions([plugin], "ru");
  assert.equal(widget.label, "Статус");
  assert.equal(widget.description, "Ассистент");
  assert.equal(pluginHomeWidgetOptions([plugin], "en")[0].label, "Status");
});

test("the launcher shows the plugin name and its field labels in the UI language", async (t) => {
  const { LaunchOptionsSection, __render, __flush, __reset } = await importWithFakeReact(
    "src/renderer/src/features/launcher/LaunchOptionsSection.tsx", "LaunchOptionsSection");
  const plugin = {
    manifest: validatePluginManifest(manifest()), sourceUrl: "", enabled: true, installedAt: 0, selectedModules: [],
    enabledHooks: [], nativeCodeTrusted: true, decisionsMayAllow: false
  };
  globalThis.window = { canvasTTY: { plugins: { list: async () => [plugin], launchFieldOptions: async () => ({}) } } };
  t.after(() => { delete globalThis.window; });
  __reset();
  const props = { provider: "claude", locale: "ru", onChange() {}, onEnvironmentChange() {} };
  let tree = __render(LaunchOptionsSection, props);
  const settle = () => { for (let round = 0; round < 5; round++) { __flush(); tree = __render(LaunchOptionsSection, props); } };
  await tick();
  settle();
  const text = (node) => typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("")
    : node && typeof node === "object" ? text(node.props?.children) : node == null || node === false ? "" : String(node);
  const fieldset = findAll(tree, (node) => node.type === "fieldset" && node.key === plugin.manifest.id)[0];
  assert.match(text(fieldset), /Ассистент/u, "Use <plugin name> in the UI language");
  findAll(fieldset, (node) => node.type === "input" && node.props.type === "checkbox")[0].props.onChange({ target: { checked: true } });
  settle();
  // The field inputs are a plain function component without hooks: render it as React would.
  const inputs = findAll(tree, (node) => typeof node.type === "function" && Array.isArray(node.props?.fields))[0];
  assert.equal(inputs.props.locale, "ru");
  const labels = findAll(inputs.type(inputs.props), (node) => node.type === "label")
    .map((label) => text(findAll(label, (node) => node.type === "span")[0]));
  assert.deepEqual(labels, ["Аккаунт", "On"]);
});

// The plugin page receives the root UI scale with the locale and palette, and again whenever it changes.
test("plugin pages and canvas apps receive the root UI scale live, and the card shows localized titles", async (t) => {
  const { PluginCanvasCard, __render, __unmount, __reset } = await importWithFakeReact(
    "src/renderer/src/features/plugins/PluginCanvasCard.tsx", "PluginCanvasCard");
  globalThis.window = {
    innerWidth: 1600, innerHeight: 1000, setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, removeEventListener() {},
    canvasTTY: { plugins: { onStorageChanged: () => () => undefined, onServiceEvent: () => () => undefined } }
  };
  globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  t.after(() => { __unmount(); delete globalThis.window; delete globalThis.document; });

  const valid = validatePluginManifest(manifest({ services: undefined, permissions: [] }));
  const contribution = valid.contributions[0];
  const plugin = { manifest: valid, sourceUrl: "https://github.com/example/assistant", selectedModules: [], enabled: true, installedAt: 0 };
  const camera = { get: () => ({ x: 0, y: 0, zoom: 1 }), set() {}, subscribe: () => () => undefined };
  const cardProps = {
    instance: { id: "p1", pluginId: valid.id, contributionId: contribution.id, title: contribution.title, position: { x: 0, y: 0 }, size: { width: 680, height: 440 } },
    plugin, contribution, locale: "ru", palette: "sage", uiScale: 1.25, camera, stackIndex: 1, snapEnabled: false,
    sessions: [], limits: null, getSnapTargets: () => [], captureCanvasWheelOverWidgets: false,
    onActivate() {}, onBoundsChange() {}, onDispose() {}, onOpenLauncher() {}, onError() {},
    onWidgetFocus() {}, onWidgetHoverChange() {}, onCanvasWheel() {}
  };
  __reset();
  const card = __render(PluginCanvasCard, cardProps);
  const frameElement = findAll(card, (node) => typeof node.type === "function" && node.props && "canvasInstanceId" in node.props)[0];
  const PluginFrame = frameElement?.type;
  assert.ok(frameElement, "the card renders a PluginFrame");
  assert.equal(frameElement.props.uiScale, 1.25, "the card passes the root UI scale on");
  const header = findAll(card, (node) => node.type === "header")[0];
  assert.deepEqual(findAll(header, (node) => node.type === "strong" || node.type === "small").map((node) => node.props.children),
    ["Настройки", "Ассистент"]);
  __unmount();

  // The frame itself: what the page is told on load and when the person changes the scale.
  __reset();
  const posted = [];
  const frameProps = { ...frameElement.props };
  const iframe = __render(PluginFrame, frameProps);
  assert.equal(iframe.props.title, "Ассистент: Настройки");
  iframe.props.ref.current = { contentWindow: { postMessage: (message) => posted.push(message) } };
  iframe.props.onLoad();
  const contexts = () => posted.filter((message) => message.type === "context").map((message) => message.value.appearance);
  assert.deepEqual(contexts().at(-1), { locale: "ru", palette: "sage", uiScale: 1.25 });

  const before = posted.length;
  __render(PluginFrame, { ...frameProps, uiScale: 1.1 });
  assert.ok(posted.length > before, "a changed scale is sent at once");
  assert.deepEqual(contexts().at(-1), { locale: "ru", palette: "sage", uiScale: 1.1 });
});

test("HOME widgets and separate plugin windows get the same UI scale", async () => {
  const home = await read("src/renderer/src/features/home/HomeZone.tsx");
  assert.match(home, /<PluginFrame[^>]*uiScale=\{settings\.uiScale\}/su);
  const canvas = await read("src/renderer/src/features/workspace/WorkspaceCanvas.tsx");
  assert.match(canvas, /<PluginCanvasCard[^>]*uiScale=\{settings\.uiScale\}/su);
  const ipc = await read("src/main/ipc/registerIpc.ts");
  assert.match(ipc, /appearance: \{ locale: settings\.get\(\)\.locale, palette: settings\.get\(\)\.palette, uiScale: settings\.get\(\)\.uiScale \}/u);
});

// Settings → Agents, Extension native code: the "May allow agent actions" help line is help text, not the
// monospace metadata line (`.agent-hooks__copy small` is the mono plugin-name style).
test("the decisions 'may allow' help line uses the normal help text style", async () => {
  const source = await read("src/renderer/src/features/settings/PluginServicesSettings.tsx");
  assert.match(source, /<span>\{t\(locale, "pluginDecisionsMayAllowDescription"\)\}<\/span>/u);
  assert.doesNotMatch(source, /<small>\{t\(locale, "pluginDecisionsMayAllowDescription"\)\}/u);
  const css = await read("src/renderer/src/styles/app.css");
  assert.match(css, /\.agent-hooks__copy small \{ font: [^}]*var\(--font-mono\)/u, "small is the monospace line");
  assert.doesNotMatch(css, /\.agent-hooks__copy > span \{[^}]*--font-mono/u, "the span is the normal help text");
});
