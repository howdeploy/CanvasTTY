import test from "node:test";
import assert from "node:assert/strict";
import { TerminalPresentation } from "../src/main/services/companion/TerminalPresentation.ts";
import {
  latestCodexReply,
  cleanTerminalText,
  cleanCodexChrome,
  codexMenu,
} from "../src/main/services/companion/presentation.ts";
const before = `• Старый ответ.\n\n› Пинг\n\n• Понг. Связь работает.\n\n› Сколько будет 120 умножить на 365?\n\n• 120 × 365 = 43 800.\n\n────────────────────────\n\n› Ask Codex to do anything\n\n  gpt-6-astra xhigh · ~/project`;

test("G2 answer cache expires with its capture grant and clears on revocation", async () => {
  const now = Date.now;
  let clock = 10_000;
  Date.now = () => clock;
  try {
    const session = { id: "codex-one", provider: "codex", status: "idle" };
    const presentation = new TerminalPresentation({
      listMetadata: () => [session],
      geometry: () => ({ cols: 80, rows: 24 }),
      readBuffer: () => ({ buffer: "› Ask Codex to do anything", outputOffset: 0 })
    });
    presentation.answer(session.id, "private captured answer", "turn-one", 10_100);
    assert.match((await presentation.read(session.id)).body, /private captured answer/u);
    clock = 10_100;
    assert.doesNotMatch((await presentation.read(session.id)).body, /private captured answer/u);
    presentation.answer(session.id, "revoked answer", "turn-two", 20_000);
    presentation.clearAnswer(session.id);
    assert.doesNotMatch((await presentation.read(session.id)).body, /revoked answer/u);
  } finally {
    Date.now = now;
  }
});

test("latest answer excludes all old questions, old answers, separators and model footer", () => {
  assert.equal(latestCodexReply(before), "120 × 365 = 43 800.");
});
test("animation frames are not answers", () => {
  assert.equal(
    latestCodexReply(
      "› Пинг\n◦ Working (0s • esc to interrupt)\n› Ask Codex to do anything",
    ),
    "",
  );
  assert.equal(
    cleanTerminalText(
      "one\n─────────\n\n\n◦ Working (1s • esc to interrupt)\n\ntwo",
    ),
    "one\n\ntwo",
  );
});
test("multiline final text is retained and list bullets stay readable", () => {
  assert.equal(
    latestCodexReply(
      "• Сделано:\n  - первый пункт\n  - второй пункт\n\n› Ask Codex to do anything",
    ),
    "Сделано:\n  - первый пункт\n  - второй пункт",
  );
});
test("resume notices cannot become part of the restored answer", () => {
  assert.equal(
    latestCodexReply(
      "• 120 × 365 = 43 800.\n\n• You have 2 usage limit resets available. Run /usage to use one.\n\n⚠ Heads up, you have less than 25% of your weekly limit left.\n› Ask Codex to do anything",
    ),
    "120 × 365 = 43 800.",
  );
});
test("new Codex banner, tip and startup chrome do not become four pages", () => {
  const start =
    "╭────────────────────╮\n│ >_ OpenAI Codex (v0.153.4) │\n│ model: gpt-6-astra xhigh │\n│ directory: ~/project │\n│ permissions: YOLO mode │\n╰────────────────────╯\n\n  Tip: Welcome to the new model.\n    More welcome text on another line.\n\n• You have 2 usage limit resets available. Run /usage to use one.\n\n› Ask Codex to do anything\n\n gpt-6-astra xhigh · ~/project";
  assert.equal(cleanCodexChrome(start), "");
  assert.equal(
    latestCodexReply(
      "• Starting MCP servers (0/3)\n› Ask Codex to do anything",
    ),
    "",
  );
  assert.equal(
    latestCodexReply(
      "• Понг.\n\n• Starting MCP servers (2/4): codex_apps, docs (0s)\n› Ask Codex to do anything",
    ),
    "Понг.",
  );
  assert.equal(
    cleanCodexChrome("│ model: loading │\n╰────────────────────╯\n› "),
    "",
  );
  assert.match(
    cleanCodexChrome("Error: authentication failed. Please sign in."),
    /authentication failed/,
  );
});
test("numbered live menus retain question, selection and the explicit custom option", () => {
  const menu = codexMenu(
    "Which storage?\n\n› 1. SQLite\n  2. Postgres\n  3. Type something else\n\nPress enter to confirm or esc to go back",
  );
  assert.equal(menu.selected, 0);
  assert.equal(menu.customIndex, 2);
  assert.equal(menu.options.length, 3);
  assert.equal(menu.title, "Which storage?");
  const approval = codexMenu(
    "Would you like to run this command?\n$ npm test\n\n› 1. Yes, proceed (y)\n  2. No (esc)\n\nPress enter to confirm or esc to cancel",
  );
  assert.equal(approval.customIndex, null);
  assert.match(approval.title, /npm test/);
});
test("prose and a stale menu in scrollback are never treated as choices", () => {
  assert.equal(
    codexMenu("1. Do this\n2. Do that\n› Ask Codex to do anything"),
    null,
  );
  assert.equal(codexMenu("› 1. Example\n  2. Example two"), null);
  assert.equal(
    codexMenu("› 1. Yes\n  2. No\nPress enter to confirm\n› new prompt"),
    null,
  );
});
test("old status warnings are not prepended to an active Codex menu title", () => {
  const menu = codexMenu(
    "⚠ Heads up, you have less than 5% left.\n  breakdown.\n\n  Select Model and Effort\n  Access legacy models with codex -m.\n\n› 1. Current\n  2. Another\n\nPress enter to confirm or esc to go back",
  );
  assert.match(menu.title, /^Select Model/);
  assert.doesNotMatch(menu.title, /Heads up/);
});
