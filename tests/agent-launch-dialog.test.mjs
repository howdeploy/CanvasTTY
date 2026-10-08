import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dialogPath = new URL("../src/renderer/src/features/launcher/AgentLaunchDialog.tsx", import.meta.url);

test("agent launcher can import its project path from the clipboard", async () => {
  const source = await readFile(dialogPath, "utf8");

  assert.match(source, /window\.canvasTTY\.clipboard\.readText\(\)/);
  assert.match(source, /directoryPathFromClipboard/);
  assert.match(source, /folder-field__paste/);
  assert.match(source, /aria-label=\{t\(locale, "pasteProjectPath"\)\}/);
});


import { importWithFakeReact, findAll, change, tick } from "./helpers/fake-react.mjs";
const dialog = await importWithFakeReact("src/renderer/src/features/launcher/AgentLaunchDialog.tsx", "AgentLaunchDialog");

test("workflow launcher requires a task and redacts the literal task substitution before launch", async t => {
  const previousWindow = globalThis.window;
  const launches = [], redactions = [], instructions = [];
  const flow = { id: "review", name: "Review", expectedSubagents: 2, trusted: true };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, canvasTTY: {
    window: { platform: "darwin" }, backlog: {
      flows: async () => ({ templates: [flow], errors: [] }),
      flowInstructions: async (...args) => { instructions.push(args); return "Review the project.\nUser task:\n{{TASK}}"; },
      redactText: async text => { redactions.push(text); return text.replace("private-value", "[redacted]"); }
    }
  } };
  t.after(() => { dialog.__unmount(); globalThis.window = previousWindow; });
  dialog.__reset();
  const props = { provider: "codex", settings: {
    locale: "en", lastDirectory: "/fixture/project", defaultLaunchProfile: "normal", agentIsolation: "off",
    acknowledgedDangerousProfiles: [], agentControlEnabled: true
  }, onClose() {}, onAcknowledge: async () => {}, onEnableAgentControl: async () => {},
  onLaunch: async (...args) => { launches.push(args); } };
  const render = () => { dialog.__flush(); return dialog.__render(dialog.AgentLaunchDialog, props); };
  let tree = render(); await tick(); tree = render();
  const field = id => findAll(tree, node => node.props?.id === id)[0];
  const submit = () => findAll(tree, node => node.props?.className === "launch-submit")[0];
  assert.equal(field("launch-flow-task"), undefined);
  change(field("launch-flow-select"), "review"); tree = render();
  assert.equal(field("launch-flow-task").props.required, true);
  assert.equal(submit().props.disabled, true);
  // The submit handler also rejects a blank task, independently of the disabled button.
  submit().props.onClick(); await tick(); tree = render();
  assert.equal(launches.length, 0); assert.equal(instructions.length, 0);
  change(field("launch-flow-task"), " \n\t"); tree = render();
  assert.equal(submit().props.disabled, true);
  const task = "Check $& and $` and $' with private-value\nthen preserve {{TASK}} literally.";
  change(field("launch-flow-task"), task); tree = render();
  assert.equal(submit().props.disabled, false);
  props.settings.agentControlEnabled = false; tree = render();
  assert.equal(submit().props.disabled, true, "a valid task still requires the orchestration endpoint");
  submit().props.onClick(); await tick(); tree = render();
  assert.equal(launches.length, 0); assert.equal(instructions.length, 0);
  props.settings.agentControlEnabled = true; tree = render();
  submit().props.onClick(); await tick(); tree = render();
  assert.deepEqual(instructions, [["/fixture/project", "review"]]);
  assert.deepEqual(redactions, ["Review the project.\nUser task:\n" + task]);
  assert.equal(launches[0][3], "orchestrator");
  assert.equal(launches[0][6], redactions[0].replace("private-value", "[redacted]"));
  change(field("launch-flow-select"), ""); tree = render();
  assert.equal(field("launch-flow-task"), undefined);
  submit().props.onClick(); await tick();
  assert.equal(launches.length, 2); assert.equal(launches[1][6], undefined);
  assert.equal(instructions.length, 1, "ordinary launches do not request a workflow prompt");
});
