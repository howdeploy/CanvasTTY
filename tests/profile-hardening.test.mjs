import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCodeAutoEnvironment, openCodePersonRules } from "../src/main/services/openCodeConfig.ts";
import { permissionConfigProblem } from "../src/main/services/LaunchPipeline.ts";
import { coreOwnedLaunchArgument, resolveTerminalLaunch } from "../src/main/services/terminalLaunch.ts";
import { availableProfiles, BYPASS_CHANGES_NOTHING, profileAvailable, resolveDefaultLaunchProfile } from "../src/shared/autoMode.ts";
import { availableRegistry } from "./helpers/terminal.mjs";


// OpenCode 1.18.33's decision for the build agent (agent.ts, permission/index.ts, core/util/wildcard.ts): its
// defaults, the merged top-level permission, then the merged agent.build.permission; the last rule whose key and
// pattern both match wins. Config objects merge with remeda's mergeDeep (a key keeps its first place). OpenCode
// merges OPENCODE_PERMISSION after the file and inline top-level rules, before evaluating build-agent rules.
const OPENCODE_DEFAULTS = { "*": "allow", doom_loop: "ask", external_directory: { "*": "ask" }, question: "deny",
  read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" } };
const match = (input, pattern) => {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, "s").test(input);
};
const fromConfig = (block = {}) => Object.entries(typeof block === "string" ? { "*": block } : block).flatMap(([permission, rule]) =>
  typeof rule === "string" ? [{ permission, pattern: "*", action: rule }] : Object.entries(rule).map(([pattern, action]) => ({ permission, pattern, action })));
const mergeDeep = (target, source) => {
  const result = { ...target };
  for (const [key, value] of Object.entries(source ?? {})) {
    const current = result[key];
    const plain = (item) => item && typeof item === "object" && !Array.isArray(item);
    result[key] = plain(current) && plain(value) ? mergeDeep(current, value) : value;
  }
  return result;
};
/** OpenCode's decision from its files, inline config, and original environment, independently of the auto builder. */
function decide(files, inlineConfig, tool, input = "*", environment = {}) {
  const config = [...files, inlineConfig].reduce((merged, next) => mergeDeep(merged, next), {});
  let top = config.permission;
  if (environment.OPENCODE_PERMISSION) {
    try {
      top = mergeDeep(top ?? {}, JSON.parse(environment.OPENCODE_PERMISSION));
    } catch { /* OpenCode ignores malformed OPENCODE_PERMISSION JSON. */ }
  }
  const rules = [...fromConfig(OPENCODE_DEFAULTS), ...fromConfig(top), ...fromConfig(config.agent?.build?.permission)];
  return rules.findLast((rule) => match(tool, rule.permission) && match(input, rule.pattern))?.action ?? "ask";
}
const inlineOf = (env) => JSON.parse(env.OPENCODE_CONFIG_CONTENT);
const auto = (env, options = {}) => inlineOf(openCodeAutoEnvironment(env, { shellGuarded: true, readFile: () => null, ...options }));

test("OpenCode auto never overrides the person's wildcard deny or ask (the reviewer's case)", () => {
  for (const action of ["deny", "ask"]) {
    const person = { permission: { "*": action } };
    const result = auto({ OPENCODE_CONFIG_CONTENT: JSON.stringify(person) });
    for (const tool of ["read", "glob", "grep", "list", "edit", "bash"]) {
      assert.equal(decide([], result, tool, "src/a.ts"), action, `${tool} stays ${action}`);
      assert.equal(result.agent?.build?.permission?.[tool], undefined, `auto adds nothing for ${tool}`);
    }
  }
  // A single word for the whole permission means every tool, like "*".
  assert.equal(decide([], auto({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: "deny" }) }), "edit"), "deny");
  // A wildcard key reaches the tools it matches only.
  const partial = auto({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { "ed*": "deny", "b?sh": "ask" } }) });
  assert.equal(decide([], partial, "edit"), "deny");
  assert.equal(decide([], partial, "bash", "ls"), "ask");
  assert.equal(decide([], partial, "grep"), "allow", "the tools the person did not restrict still get auto");
  // The person's own later allow keeps working, and auto does not turn their catch-all ask into an allow elsewhere.
  const mixed = auto({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { "*": "ask", read: "allow" } }) });
  assert.equal(decide([], mixed, "read", "a.ts"), "allow");
  assert.equal(decide([], mixed, "edit", "a.ts"), "ask");
  // An agent-level wildcard in the inline config counts the same.
  const agentLevel = auto({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { build: { permission: { "*": "deny" } } } }) });
  assert.equal(decide([], agentLevel, "bash", "ls"), "deny");
  assert.equal(decide([], agentLevel, "edit"), "deny");
});

test("OpenCode auto respects OPENCODE_PERMISSION wildcard deny or ask for every tool", () => {
  for (const action of ["deny", "ask"]) {
    const env = { OPENCODE_PERMISSION: ` { "*": "${action}" } ` };
    const original = { ...env };
    const delta = openCodeAutoEnvironment(env, { shellGuarded: true, readFile: () => null });
    const result = inlineOf(delta);
    for (const tool of ["read", "glob", "grep", "list", "edit", "bash"]) {
      const input = tool === "bash" ? "ls -la" : "src/a.ts";
      assert.equal(decide([], result, tool, input, env), action, `${tool} stays ${action}`);
      assert.equal(result.agent.build.permission[tool], undefined, `auto adds nothing for ${tool}`);
    }
    assert.deepEqual(env, original, "the person's environment is unchanged");
    assert.equal({ ...env, ...delta }.OPENCODE_PERMISSION, original.OPENCODE_PERMISSION, "the original environment value reaches OpenCode verbatim");
    assert.equal(Object.hasOwn(delta, "OPENCODE_PERMISSION"), false, "auto does not overwrite the environment permission");
  }
  const env = { OPENCODE_PERMISSION: JSON.stringify({ "ed*": "deny", "b?sh": "ask" }) };
  const result = auto(env);
  assert.equal(decide([], result, "edit", "src/a.ts", env), "deny");
  assert.equal(decide([], result, "bash", "ls", env), "ask");
  assert.equal(result.agent.build.permission.edit, undefined);
  assert.equal(result.agent.build.permission.bash, undefined);
  assert.equal(decide([], result, "grep", "a", env), "allow", "unrestricted tools still get auto");
});

test("OpenCode auto keeps whole-tool and command-pattern environment restrictions after its grants", () => {
  const env = { OPENCODE_PERMISSION: JSON.stringify({ edit: "deny", bash: "ask" }) };
  const result = auto(env);
  assert.equal(decide([], result, "edit", "src/a.ts", env), "deny");
  assert.equal(decide([], result, "bash", "ls", env), "ask");
  assert.equal(result.agent.build.permission.edit, "deny");
  assert.equal(result.agent.build.permission.bash, "ask");
  assert.equal(decide([], result, "read", "src/a.ts", env), "allow");

  const commands = { OPENCODE_PERMISSION: JSON.stringify({ bash: { "git push *": "ask" } }) };
  const guarded = auto(commands);
  assert.equal(decide([], guarded, "bash", "git push origin main", commands), "ask");
  assert.equal(decide([], guarded, "bash", "git push", commands), "ask");
  assert.equal(decide([], guarded, "bash", "ls -la", commands), "allow", "the guarded shell is still opened for other commands");
});

test("OpenCode environment permission follows file and inline top-level rules while the person's build rules still win", () => {
  const file = { permission: { edit: "allow", bash: { "git push *": "deny" } } };
  const inline = { permission: { edit: "allow", bash: { "git push *": "allow", "npm publish *": "ask" } } };
  const env = {
    OPENCODE_CONFIG: join(tmpdir(), "person", "opencode.json"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(inline),
    OPENCODE_PERMISSION: JSON.stringify({ edit: "deny", bash: { "git push *": "ask" } })
  };
  const readFile = (path) => path === env.OPENCODE_CONFIG ? JSON.stringify(file) : null;
  assert.deepEqual(openCodePersonRules(env, undefined, readFile).top, {
    edit: "deny", bash: { "git push *": "ask", "npm publish *": "ask" }
  });
  const result = auto(env, { readFile });
  assert.equal(decide([file], result, "edit", "src/a.ts", env), "deny", "environment deny overrides inline allow before auto evaluates it");
  assert.equal(decide([file], result, "bash", "git push origin main", env), "ask");
  assert.equal(decide([file], result, "bash", "npm publish package", env), "ask", "other inline patterns survive the environment merge");
  assert.equal(decide([file], result, "bash", "ls", env), "allow");

  const fileAgent = { agent: { build: { permission: { edit: "deny", bash: { "git push *": "deny" } } } } };
  const agentInline = { agent: { build: { permission: { read: "ask", bash: { "git status *": "ask" } } } } };
  const agentsEnv = {
    OPENCODE_CONFIG: join(tmpdir(), "person", "agent.json"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(agentInline),
    OPENCODE_PERMISSION: JSON.stringify({ edit: "ask", read: "deny", bash: "allow" })
  };
  const agentsRead = (path) => path === agentsEnv.OPENCODE_CONFIG ? JSON.stringify(fileAgent) : null;
  const agentsResult = auto(agentsEnv, { readFile: agentsRead });
  assert.equal(agentsResult.agent.build.permission.edit, undefined, "auto leaves file build permissions alone");
  assert.deepEqual(agentsResult.agent.build.permission.bash, agentInline.agent.build.permission.bash, "the inline build rules are preserved");
  assert.equal(decide([fileAgent], agentsResult, "edit", "src/a.ts", agentsEnv), "deny", "file build deny follows environment ask");
  assert.equal(decide([fileAgent], agentsResult, "bash", "git push origin main", agentsEnv), "deny");
  assert.equal(decide([fileAgent], agentsResult, "bash", "git status --short", agentsEnv), "ask");
  assert.equal(decide([fileAgent], agentsResult, "read", "src/a.ts", agentsEnv), "ask", "inline build ask follows environment deny");
});

test("OpenCode auto ignores malformed environment JSON and preserves its original bytes", () => {
  const inline = { agent: { build: { permission: { task: "deny" } } } };
  for (const raw of ["", " ", "{", '{ "edit": "deny", }']) {
    const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(inline), OPENCODE_PERMISSION: raw };
    assert.equal(openCodePersonRules(env, undefined, () => null).unknown, false);
    for (const shellGuarded of [true, false]) {
      const delta = openCodeAutoEnvironment(env, { shellGuarded, readFile: () => null });
      const result = inlineOf(delta);
      assert.equal(decide([], result, "edit", "src/a.ts", env), "allow");
      assert.equal(decide([], result, "bash", "ls", env), shellGuarded ? "allow" : "ask");
      assert.equal(result.agent.build.permission.task, "deny");
      assert.equal({ ...env, ...delta }.OPENCODE_PERMISSION, raw, "malformed values are preserved for OpenCode to handle");
      assert.equal(Object.hasOwn(delta, "OPENCODE_PERMISSION"), false);
    }
  }
});

test("OpenCode auto refuses valid JSON with an unsupported environment permission shape", () => {
  const inline = { agent: { build: { permission: { task: "deny" } } } };
  for (const value of ["allow", "ask", "deny", null, [], false, true, 1, { edit: "invalid" },
    { bash: { "potential-secret-command": "invalid" } }]) {
    const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(inline), OPENCODE_PERMISSION: JSON.stringify(value) };
    const original = { ...env };
    const rules = openCodePersonRules(env, undefined, () => null);
    assert.equal(rules.unknown, true);
    assert.deepEqual(rules.top, {}, "unsupported environment values are not normalized into wildcard rules");
    for (const options of [{ shellGuarded: true }, { shellGuarded: false }, { shellGuarded: true, thirdPartyModel: true }]) {
      assert.throws(() => openCodeAutoEnvironment(env, { ...options, readFile: () => null }), (error) => {
        assert.match(error.message, /OPENCODE_PERMISSION must contain a permission object/u);
        assert.equal(error.message.includes("potential-secret-command"), false, "the error does not echo environment content");
        return true;
      });
    }
    assert.deepEqual(env, original, "a refused launch leaves the original environment untouched");
  }
});

test("OpenCode auto and accept-edits reject scalar deny or ask instead of leaving unguarded bash allowed", () => {
  const providerCli = availableRegistry().get("opencode");
  for (const action of ["deny", "ask"]) {
    const env = { OPENCODE_PERMISSION: JSON.stringify(action) };
    // OpenCode merges raw environment JSON rather than applying its config schema. A string becomes numeric
    // character keys, not a wildcard. Previously treating it as a wildcard omitted auto's protective bash ask.
    assert.equal(decide([], { agent: { build: { permission: {} } } }, "bash", "ls", env), "allow");
    for (const profile of ["auto", "acceptEdits"]) {
      assert.throws(() => resolveTerminalLaunch("opencode", profile, [], {
        providerCli, environment: env, shellGuarded: false
      }), /OPENCODE_PERMISSION must contain a permission object/u);
    }
  }
});

test("OpenCode auto preserves permission patterns named __proto__ through file, inline, and environment merges", () => {
  const permission = JSON.parse('{"edit":{"__proto__":"deny"},"bash":{"__proto__":"ask"}}');
  const configurations = [
    { environment: { OPENCODE_CONFIG: join(tmpdir(), "person", "opencode.json") }, files: [{ permission }] },
    { environment: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission }) }, files: [] },
    { environment: { OPENCODE_PERMISSION: JSON.stringify(permission) }, files: [] }
  ];
  for (const { environment, files } of configurations) {
    const result = auto(environment, {
      readFile: (path) => path === environment.OPENCODE_CONFIG ? JSON.stringify(files[0]) : null
    });
    assert.equal(decide(files, result, "edit", "__proto__", environment), "deny");
    assert.equal(decide(files, result, "bash", "__proto__", environment), "ask");
    assert.equal(decide(files, result, "edit", "src/normal.ts", environment), "allow");
    assert.equal(decide(files, result, "bash", "ls", environment), "allow");
    assert.equal(Object.hasOwn(result.agent.build.permission.edit, "__proto__"), true);
  }
});

test("OpenCode auto preserves numeric pattern decisions that cannot follow its wildcard in object order", () => {
  for (const pattern of ["0", "123", "4294967294"]) {
    for (const action of ["deny", "ask", "allow"]) {
      for (const tool of ["edit", "bash"]) {
        const permission = { [tool]: { [pattern]: action } };
        const configurations = [
          { environment: { OPENCODE_CONFIG: join(tmpdir(), "person", "opencode.json") }, files: [{ permission }], inline: {} },
          { environment: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission }) }, files: [], inline: { permission } },
          { environment: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { build: { permission } } }) },
            files: [], inline: { agent: { build: { permission } } } },
          { environment: { OPENCODE_PERMISSION: JSON.stringify(permission) }, files: [], inline: {} }
        ];
        for (const { environment, files, inline } of configurations) {
          for (const shellGuarded of [true, false]) {
            const options = {
              shellGuarded,
              readFile: (path) => path === environment.OPENCODE_CONFIG ? JSON.stringify(files[0]) : null
            };
            if (tool === "bash" && !shellGuarded) {
              assert.throws(() => auto(environment, options), /numeric bash permission patterns require guarded Auto/u);
              continue;
            }
            const result = auto(environment, options);
            assert.equal(decide(files, result, tool, pattern, environment), action,
              `${tool} ${pattern} keeps ${action}, guarded=${shellGuarded}`);
            assert.deepEqual(result.agent.build.permission[tool], inline.agent?.build?.permission?.[tool],
              "the affected tool's original build rules keep their ordering");
            assert.equal(result.agent.build.permission.grep, "allow", "other tools still receive Auto rules");
          }
        }
      }
    }
  }
  // Similar-looking keys outside the array-index range retain insertion order and permit an overlay.
  for (const pattern of ["01", "-0", "4294967295"]) {
    const environment = { OPENCODE_PERMISSION: JSON.stringify({ edit: { [pattern]: "deny" } }) };
    const result = auto(environment);
    assert.equal(result.agent.build.permission.edit["*"], "allow");
    assert.equal(decide([], result, "edit", pattern, environment), "deny");
  }
});

test("numeric bash patterns cannot silently remove unguarded shell prompts", () => {
  const providerCli = availableRegistry().get("opencode");
  const environment = { OPENCODE_PERMISSION: JSON.stringify({ bash: { "123": "deny" } }) };
  // Omitting the entire tool overlay preserves 123 but would let unrelated ls inherit OpenCode's allow default.
  assert.equal(decide([], { agent: { build: { permission: {} } } }, "bash", "ls", environment), "allow");
  for (const profile of ["auto", "acceptEdits"]) {
    assert.throws(() => resolveTerminalLaunch("opencode", profile, [], {
      providerCli, environment, shellGuarded: false
    }), /numeric bash permission patterns require guarded Auto/u);
  }
  assert.throws(() => auto(environment, { shellGuarded: true, thirdPartyModel: true }),
    /numeric bash permission patterns require guarded Auto/u);
  const guarded = auto(environment);
  assert.equal(decide([], guarded, "bash", "123", environment), "deny");
  assert.equal(decide([], guarded, "bash", "ls", environment), "allow", "only the guarded Auto profile can leave baseline shell decisions intact");
});

test("OpenCode auto without environment restrictions still opens edit and asks for unguarded bash", () => {
  const result = auto({}, { shellGuarded: false });
  for (const tool of ["read", "glob", "grep", "list", "edit"]) {
    assert.equal(decide([], result, tool, "src/a.ts"), "allow", tool);
  }
  assert.equal(decide([], result, "read", ".env"), "ask");
  assert.equal(decide([], result, "bash", "ls"), "ask");
});

test("OpenCode auto keeps the person's specific rules for a tool after its own, from files and the inline config", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ctty-opencode-rules-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, "work", "p");
  await mkdir(join(home, ".config", "opencode"), { recursive: true });
  await mkdir(project, { recursive: true });
  // JSONC, as OpenCode allows: comments and a trailing comma.
  const globalText = `{
    // mine
    "permission": { "read": { "*.pem": "deny", "*.md": "allow" }, "bash": { "git push *": "ask" }, },
  }`;
  await writeFile(join(home, ".config", "opencode", "opencode.jsonc"), globalText);
  // A project config one folder up from where the agent starts.
  const parentConfig = { permission: { edit: { "secrets/**": "deny" } } };
  await writeFile(join(home, "work", "opencode.json"), JSON.stringify(parentConfig));
  const inline = { permission: { grep: "ask" } };
  const env = { HOME: home, OPENCODE_CONFIG_CONTENT: JSON.stringify(inline) };
  const person = openCodePersonRules(env, project);
  assert.equal(person.unknown, false);
  assert.deepEqual(person.top, { read: { "*.pem": "deny", "*.md": "allow" }, bash: { "git push *": "ask" }, edit: { "secrets/**": "deny" }, grep: "ask" });
  const result = inlineOf(openCodeAutoEnvironment(env, { shellGuarded: true, cwd: project }));
  const files = [{ permission: { read: { "*.pem": "deny", "*.md": "allow" }, bash: { "git push *": "ask" } } }, parentConfig];
  assert.equal(decide(files, result, "bash", "ls -la"), "allow", "auto opens the shell (guarded)");
  assert.equal(decide(files, result, "bash", "git push origin main"), "ask", "the person's ask still wins");
  assert.equal(decide(files, result, "edit", "secrets/key.txt"), "deny");
  assert.equal(decide(files, result, "edit", "src/a.ts"), "allow");
  assert.equal(decide(files, result, "read", "id.pem"), "deny");
  assert.equal(decide(files, result, "read", ".env"), "ask");
  assert.equal(decide(files, result, "grep"), "ask", "a whole-tool ask replaces auto's allow");
  assert.equal(result.agent.build.permission.grep, "ask");
  assert.equal(decide(files, result, "glob"), "allow");
});

test("OpenCode auto follows OpenCode's child-to-parent .opencode merge order and project-config disable flag", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ctty-opencode-path-order-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const parent = join(home, "work");
  const child = join(parent, "project");
  await mkdir(join(parent, ".opencode"), { recursive: true });
  await mkdir(join(child, ".opencode"), { recursive: true });
  await writeFile(join(parent, ".opencode", "opencode.json"), JSON.stringify({ permission: { bash: "deny" } }));
  await writeFile(join(child, ".opencode", "opencode.json"), JSON.stringify({ permission: { bash: "allow" } }));
  const env = { HOME: home };
  const person = openCodePersonRules(env, child);
  assert.equal(person.top.bash, "deny", "the parent directory config is merged after its child");
  const normal = inlineOf(openCodeAutoEnvironment(env, { shellGuarded: true, cwd: child }));
  assert.equal(normal.agent.build.permission.bash, "deny");
  const disabled = openCodePersonRules({ ...env, OPENCODE_DISABLE_PROJECT_CONFIG: "true" }, child);
  assert.equal(disabled.top.bash, undefined, "the upstream truthy flag disables project JSON and .opencode directories");
});

test("OpenCode Auto preserves later directory JSON over earlier build-agent front matter", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ctty-opencode-agent-order-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const parent = join(home, "work");
  const child = join(parent, "project");
  await mkdir(join(child, ".opencode", "agent"), { recursive: true });
  await mkdir(join(parent, ".opencode"), { recursive: true });
  await writeFile(join(child, ".opencode", "agent", "build.md"), "---\npermission:\n  '*': allow\n---\nBuild things.\n");
  await writeFile(join(parent, ".opencode", "opencode.json"), JSON.stringify({
    agent: { build: { permission: { "*": "deny" } } }
  }));
  const env = { HOME: home };
  const person = openCodePersonRules(env, child);
  assert.equal(person.fileAgent["*"], "deny", "each directory's agent files merge before the next parent directory");
  const result = inlineOf(openCodeAutoEnvironment(env, { shellGuarded: true, cwd: child }));
  assert.equal(result.agent.build.permission.read, undefined);
  assert.equal(result.agent.build.permission.bash, undefined, "Auto adds no grants over the person's wildcard deny");
});

test("OpenCode Auto treats ambiguous or throwing injected config reads as unknown", () => {
  const env = { OPENCODE_CONFIG: join(tmpdir(), "person", "config.json") };
  const thrown = openCodePersonRules(env, undefined, () => { throw new Error("read failed"); });
  assert.equal(thrown.unknown, true);
  const result = inlineOf(openCodeAutoEnvironment(env, { shellGuarded: true, readFile: () => { throw new Error("read failed"); } }));
  assert.deepEqual(result.agent.build.permission, {});
});

test("ambiguous build-agent front matter variants leave OpenCode Auto disabled", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ctty-opencode-agent-ambiguous-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, ".opencode");
  await mkdir(join(directory, "agent"), { recursive: true });
  await mkdir(join(directory, "agents"), { recursive: true });
  await writeFile(join(directory, "agent", "build.md"), "---\npermission:\n  read: allow\n---\nBuild.\n");
  await writeFile(join(directory, "agents", "build.md"), "---\npermission:\n  read: deny\n---\nBuild.\n");
  const env = { HOME: home };
  const person = openCodePersonRules(env, home);
  assert.equal(person.unknown, true);
  assert.deepEqual(inlineOf(openCodeAutoEnvironment(env, { shellGuarded: true, cwd: home })).agent.build.permission, {});
});

test("OpenCode auto leaves a tool alone when the person's files name it for the build agent, or cannot be read", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ctty-opencode-agent-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, "p");
  await mkdir(join(project, ".opencode", "agent"), { recursive: true });
  await mkdir(join(home, ".config", "opencode"), { recursive: true });
  // A file-level agent.build rule would keep its place when OpenCode merges the inline config in: auto stays out.
  const fileAgent = { agent: { build: { permission: { bash: { "rm *": "deny" } } } } };
  await writeFile(join(project, "opencode.json"), JSON.stringify(fileAgent));
  // An agent file's front matter counts as the build agent's permission too.
  await writeFile(join(project, ".opencode", "agent", "build.md"), "---\npermission:\n  edit: ask\n---\nBuild things.\n");
  const env = { HOME: home };
  const result = inlineOf(openCodeAutoEnvironment(env, { shellGuarded: true, cwd: project }));
  assert.equal(result.agent.build.permission.bash, undefined);
  assert.equal(result.agent.build.permission.edit, undefined);
  assert.equal(result.agent.build.permission.grep, "allow");
  const files = [fileAgent, { agent: { build: { permission: { edit: "ask" } } } }];
  assert.equal(decide(files, result, "bash", "rm -rf x"), "deny");
  assert.equal(decide(files, result, "edit"), "ask");

  // A configuration that exists but cannot be parsed: auto assumes nothing and opens nothing.
  await writeFile(join(home, ".config", "opencode", "opencode.json"), "{ \"permission\": { \"*\": \"deny\" ");
  const broken = inlineOf(openCodeAutoEnvironment(env, { shellGuarded: true, cwd: project }));
  assert.equal(openCodePersonRules(env, project).unknown, true);
  assert.deepEqual(broken.agent.build.permission, {});
});

test("a plugin cannot hand OpenCode or Kimi a configuration that decides approvals", () => {
  const files = [{ relPath: "opencode.json", content: JSON.stringify({ provider: { x: { options: { baseURL: "http://127.0.0.1:1/v1" } } }, model: "x/m" }) }];
  assert.equal(permissionConfigProblem("opencode", { env: { OPENCODE_CONFIG: "{launchFiles}/opencode.json" }, args: [], files }), null, "a provider file is fine");
  const widening = [{ relPath: "opencode.json", content: JSON.stringify({ permission: "allow" }) }];
  assert.match(permissionConfigProblem("opencode", { env: { OPENCODE_CONFIG: "{launchFiles}/opencode.json" }, args: [], files: widening }),
    /sets permission in its OpenCode configuration/u);
  const agentRule = [{ relPath: "o.json", content: JSON.stringify({ agent: { build: { permission: { bash: "allow" } } } }) }];
  assert.match(permissionConfigProblem("opencode", { env: { OPENCODE_CONFIG: "{launchFiles}/o.json" }, args: [], files: agentRule }), /permission/u);
  assert.match(permissionConfigProblem("opencode", { env: { OPENCODE_CONFIG: join(tmpdir(), "nonexistent", "o.json") }, args: [], files: [] }), /cannot check/u);
  assert.match(permissionConfigProblem("opencode", { env: { OPENCODE_PERMISSION: "{\"*\":\"allow\"}" }, args: [], files: [] }), /OPENCODE_PERMISSION/u);
  assert.equal(permissionConfigProblem("kimi", { env: {}, args: ["--config", JSON.stringify({ models: { m: { provider: "p", max_context_size: 1 } } })], files: [] }), null);
  assert.match(permissionConfigProblem("kimi", { env: {}, args: ["--config", JSON.stringify({ default_yolo: true })], files: [] }), /default_yolo/u);
  assert.match(permissionConfigProblem("kimi", { env: {}, args: ["--config-file", "{launchFiles}/k.json"],
    files: [{ relPath: "k.json", content: JSON.stringify({ approval: { auto: true } }) }] }), /approval/u);
});

test("permission inspection parses JSONC without changing quoted comments or ignoring an invalid comment", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ctty-jsonc-inspect-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, "project");
  await mkdir(project, { recursive: true });
  const config = join(project, "opencode.jsonc");
  await writeFile(config, '{"description":"keep /* permission */ and // text", "permission":{"bash":"deny"},}');
  const person = openCodePersonRules({ HOME: home }, project);
  assert.equal(person.unknown, false);
  assert.deepEqual(person.top, { bash: "deny" });
  const relativePerson = openCodePersonRules({ OPENCODE_CONFIG: "opencode.jsonc" }, project);
  assert.equal(relativePerson.unknown, false);
  assert.deepEqual(relativePerson.top, { bash: "deny" }, "relative explicit config paths resolve from launch cwd");
  assert.match(permissionConfigProblem("opencode", { env: { OPENCODE_CONFIG: "opencode.jsonc" }, args: [], files: [] }, project), /sets permission/u,
    "LaunchPipeline resolves relative explicit config paths from launch cwd");
  assert.match(permissionConfigProblem("opencode", {
    env: { OPENCODE_CONFIG: "{launchFiles}/config.jsonc" }, args: [],
    files: [{ relPath: "config.jsonc", content: '{"description":"/* keep */", "permission":"allow",}' }]
  }, project), /sets permission/u);
  assert.match(permissionConfigProblem("opencode", {
    env: { OPENCODE_CONFIG: "{launchFiles}/bad.jsonc" }, args: [],
    files: [{ relPath: "bad.jsonc", content: '{"x": 1 /* never closes' }]
  }, project), /not a JSON object/u, "an unclosed comment must be rejected");
});

test("OpenCode config directory inspection skips only absent candidates and resolves relative paths from launch cwd", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ctty-config-dir-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cwd = join(home, "launch");
  const configDir = join(cwd, "conf");
  await mkdir(configDir, { recursive: true });
  const contribution = (folder) => ({ env: { OPENCODE_CONFIG_DIR: folder }, args: [], files: [] });
  assert.equal(permissionConfigProblem("opencode", contribution("conf"), cwd), null, "all absent candidates are okay");
  assert.equal(permissionConfigProblem("opencode", contribution("{launchFiles}"), cwd), null,
    "absent optional config candidates from the launch-files directory are okay");
  await writeFile(join(configDir, "opencode.jsonc"), "{");
  assert.match(permissionConfigProblem("opencode", contribution("conf"), cwd), /cannot check|not a JSON object/u,
    "an existing malformed candidate must stop launch");
  await rm(join(configDir, "opencode.jsonc"));
  const nonregular = join(configDir, "opencode.json");
  await mkdir(nonregular);
  assert.match(permissionConfigProblem("opencode", contribution("conf"), cwd), /cannot check/u,
    "an existing nonregular candidate must stop launch");
});

test("core-owned flags: cursor's --force/-f/--yolo/--approve-mcps and mode switches are CanvasTTY's alone", () => {
  for (const flag of ["--force", "-f", "--yolo", "--approve-mcps", "--mode", "--plan"]) assert.equal(coreOwnedLaunchArgument("cursor", flag), true, flag);
  for (const flag of ["--auto", "--agent"]) assert.equal(coreOwnedLaunchArgument("opencode", flag), true, flag);
  assert.equal(coreOwnedLaunchArgument("grok", "--always-approve"), true);
  assert.equal(coreOwnedLaunchArgument("cursor", "--model"), false);
});

test("the profiles each CLI offers; YOLO that changes nothing is known", () => {
  for (const provider of ["claude", "grok"]) assert.deepEqual(availableProfiles(provider, false), ["auto", "normal", "ask", "acceptEdits", "dontAsk", "plan", "yolo"]);
  assert.deepEqual(availableProfiles("codex", false), ["auto", "normal", "acceptEdits", "dontAsk", "plan", "yolo"]);
  assert.deepEqual(availableProfiles("opencode", false), ["auto", "normal", "acceptEdits", "plan", "yolo"]);
  for (const provider of ["qwen", "antigravity"]) {
    assert.deepEqual(availableProfiles(provider, false), ["auto", "normal", "ask", "acceptEdits", "plan", "yolo"]);
    assert.deepEqual(availableProfiles(provider, true), availableProfiles(provider, false));
  }
  assert.deepEqual(availableProfiles("kimi", false), ["auto", "normal", "plan", "yolo"]);
  assert.deepEqual(availableProfiles("devin", false), ["auto", "normal", "ask", "acceptEdits", "autonomous", "yolo"]);
  assert.deepEqual(availableProfiles("omp", false), ["normal", "ask", "askCached", "acceptEdits", "yolo"]);
  assert.deepEqual(availableProfiles("omp", true), ["auto", "normal", "ask", "askCached", "acceptEdits", "yolo"]);
  assert.deepEqual(availableProfiles("hermes", false), ["normal", "yolo"]);
  assert.deepEqual(availableProfiles("hermes", true), ["auto", "normal", "yolo"]);
  for (const provider of ["pi", "minimax"]) assert.deepEqual(availableProfiles(provider, false), ["normal", "yolo"]);
  assert.deepEqual(availableProfiles("cursor", false), ["normal", "plan", "readOnly", "yolo"]);
  assert.deepEqual(availableProfiles("cursor", true), ["auto", "normal", "plan", "readOnly", "yolo"]);
  assert.deepEqual(availableProfiles("terminal", true), ["normal"]);
  assert.equal(profileAvailable("kimi", "acceptEdits", true), false);
  assert.deepEqual([...BYPASS_CHANGES_NOTHING].sort(), ["minimax", "pi"]);
  assert.equal(resolveDefaultLaunchProfile("omp", { defaultLaunchProfile: "auto", defaultLaunchProfiles: { omp: "askCached" } }, false), "askCached");
  assert.equal(resolveDefaultLaunchProfile("cursor", { defaultLaunchProfile: "readOnly", defaultLaunchProfiles: {} }, false), "readOnly");
  assert.equal(resolveDefaultLaunchProfile("claude", { defaultLaunchProfile: "readOnly", defaultLaunchProfiles: {} }, false), "plan");
});

test("a contributor's configuration path that is a FIFO or oversized is refused at once, never read blocking the app", { skip: process.platform === "win32" }, async (t) => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = await mkdtemp(join(tmpdir(), "canvastty-config-fifo-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const fifo = join(folder, "opencode.json");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  const huge = join(folder, "huge.json");
  await writeFile(huge, `{"x":"${"a".repeat(2 * 1024 * 1024)}"}`);
  // In a child: the old synchronous read of a FIFO with no writer never returns.
  const script = `
    const { permissionConfigProblem } = await import(${JSON.stringify(new URL("../src/main/services/LaunchPipeline.ts", import.meta.url).href)});
    for (const path of process.argv.slice(1)) console.log(JSON.stringify(permissionConfigProblem("opencode", { env: { OPENCODE_CONFIG: path }, args: [], files: [] })));
  `;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script, fifo, huge], { encoding: "utf8", timeout: 20_000 });
  assert.equal(child.signal, null, "it did not hang");
  assert.equal(child.status, 0, child.stderr);
  const answers = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(answers.length, 2);
  for (const answer of answers) assert.match(answer, /cannot check/u);
});
