import assert from "node:assert/strict";
import test from "node:test";
import { searchSettings, SETTINGS_SEARCH_ENTRIES } from "../src/renderer/src/features/settings/settingsSearch.ts";

test("settings search finds limit controls in either language and ignores whitespace/case", () => {
  for (const locale of ["ru", "en"]) {
    for (const query of ["  LIMIT   DISPLAY ", "отображение лимитов"]) {
      assert.ok(searchSettings(query, locale).some((result) => result.section === "agents" && result.label === "homeLimitProviders"));
    }
  }
});

test("empty and unmatched searches produce no results; destinations are unique", () => {
  assert.deepEqual(searchSettings(" \n ", "en"), []);
  assert.deepEqual(searchSettings("no-such-setting-92745", "ru"), []);
  assert.equal(new Set(SETTINGS_SEARCH_ENTRIES.map((entry) => entry.section + entry.label)).size, SETTINGS_SEARCH_ENTRIES.length);
  for (const section of ["general", "keyboardShortcuts", "appearance", "agents", "controls", "externalIntegrations", "canvasLink", "browser", "plugins", "mascots", "updates", "about"]) {
    assert.ok(SETTINGS_SEARCH_ENTRIES.some((entry) => entry.section === section));
  }
});
