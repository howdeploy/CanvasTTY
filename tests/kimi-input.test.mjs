import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/headless";
import { kimiComposerReady } from "../src/main/services/kimiInput.ts";

async function ready(text, cursor="\x1b[3;5H") {
  const terminal = new xterm.Terminal({ cols: 80, rows: 12, allowProposedApi: true });
  await new Promise(resolve => terminal.write(text+cursor,resolve));
  try { return kimiComposerReady(terminal); } finally { terminal.dispose(); }
}
const EMPTY="Kimi Code 2.4.0\r\n╭────────────────────────────╮\r\n│ >                          │\r\n╰────────────────────────────╯\r\n";

test("only the active empty native Kimi box permits delivery",async()=>{
  assert.equal(await ready(EMPTY),true);
  assert.equal(await ready("Kimi Code 2.4.0 starting..."),false);
  assert.equal(await ready(EMPTY, "\x1b[7;1H"), false, "historical quoted boxes do not own the cursor");
  assert.equal(await ready(EMPTY.replace("│ >                          │","│ > human draft              │")),false);
  assert.equal(await ready(EMPTY.replace("│ >","│ !")),false,"shell mode is not an agent prompt");
});

test("a blank first row cannot hide a multiline draft or incomplete box",async()=>{
  const multiline=EMPTY.replace("╰────────────────────────────╯","│ human continuation         │\r\n╰────────────────────────────╯");
  assert.equal(await ready(multiline),false);
  assert.equal(await ready(EMPTY.replace("╰────────────────────────────╯","│                            │\r\n╰────────────────────────────╯")),true);
  assert.equal(await ready(EMPTY.replace("╰────────────────────────────╯","")),false);
  assert.equal(await ready(EMPTY+EMPTY.replace("│ >                          │","│ > later human draft        │")),false,"the last prompt wins");
});
