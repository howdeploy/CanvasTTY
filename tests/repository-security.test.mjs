import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SECRET_PATTERNS, collectArtifactIssues, collectRepositoryIssues } from "../scripts/audit-secrets.mjs";

test("publishable repository files contain no high-confidence secrets or personal paths", async () => {
  assert.deepEqual(await collectRepositoryIssues(), []);
});

test("secret audit ignores the Git metadata file used by linked worktrees", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-secret-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const privateGitDir = `/${["home", "local-user", "repo", ".git", "worktrees", "workspace"].join("/")}`;
  await writeFile(join(root, ".git"), `gitdir: ${privateGitDir}\n`, "utf8");
  await writeFile(join(root, "README.md"), "publishable content\n", "utf8");

  assert.deepEqual(await collectRepositoryIssues(root), []);
});

test("secret audit still reports personal paths in publishable files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-secret-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const privatePath = `/${["home", "local-user", "project"].join("/")}/`;
  await writeFile(join(root, "notes.md"), `Local path: ${privatePath}\n`, "utf8");

  assert.deepEqual(await collectRepositoryIssues(root), [
    { path: "notes.md", rule: "personal home path" }
  ]);
});

test("secret audit ignores key prefixes embedded in identifiers", () => {
  const patterns = new Map(SECRET_PATTERNS);
  const matches = (rule, sample) => [...sample.matchAll(patterns.get(rule))].map((match) => match[0]);
  const longTail = "x".repeat(28);

  for (const [rule, [standalonePrefix, ...identifierPrefixes]] of Object.entries({
    "Anthropic token": ["sk-ant-", "disk-ant-", "task-ant-"],
    "OpenAI-style token": ["sk-", "disk-", "task-"]
  })) {
    const token = `${standalonePrefix}${longTail}`;
    assert.deepEqual(matches(rule, `${token}\n`), [token], `${rule} must report a standalone token`);

    for (const prefix of identifierPrefixes) {
      for (const identifier of ["abc", "def", longTail, `${longTail}-suffix`]) {
        const sample = `${prefix}${identifier}`;
        assert.deepEqual(matches(rule, `${sample}\n`), [], `${rule} must ignore ${sample}`);
      }
    }
  }
});

test("secret audit scans the built bundle in addition to the source tree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-secret-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const builtDirectory = join(root, "out", "main");
  await mkdir(builtDirectory, { recursive: true });
  const injectedToken = `sk-ant-${"a".repeat(24)}`;
  await writeFile(join(builtDirectory, "index.js"), `const injected = "${injectedToken}";\n`, "utf8");

  assert.deepEqual(await collectRepositoryIssues(root), []);
  assert.deepEqual(await collectArtifactIssues(root), [
    { path: "out/main/index.js", rule: "Anthropic token" },
    { path: "out/main/index.js", rule: "OpenAI-style token" }
  ]);
});

test("secret audit reports a missing built bundle instead of implying coverage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-secret-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(root, "README.md"), "publishable content\n", "utf8");

  assert.equal(await collectArtifactIssues(root), null);
});

test("secret audit catches Windows personal paths but not system, generic, or relative paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-secret-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notes = join(root, "notes.md");

  const personalPath = ["C:", "Users", "operator", "project", ""].join("\\");
  await writeFile(notes, `Local path: ${personalPath}\n`, "utf8");
  assert.deepEqual(await collectRepositoryIssues(root), [
    { path: "notes.md", rule: "personal home path" }
  ]);

  const nonPersonalPaths = [
    ["C:", "Windows", "System32", "cmd.exe"].join("\\"),
    ["C:", "Program Files", "CanvasTTY", "app.asar"].join("\\"),
    ["C:", "Users", "runner", "work", ""].join("\\"),
    "%USERPROFILE%\\project",
    ["src", "main", "index.ts"].join("\\")
  ];
  await writeFile(notes, `Samples:\n${nonPersonalPaths.join("\n")}\n`, "utf8");
  assert.deepEqual(await collectRepositoryIssues(root), []);
});

test("gitignore excludes local credentials, logs, builds, and agent context", async () => {
  const gitignore = normalizeLineEndings(
    await readFile(new URL("../.gitignore", import.meta.url), "utf8")
  );
  const requiredEntries = [
    ".env",
    ".env.*",
    "*.log",
    "credentials.json",
    "auth.json",
    "release/",
    ".agents/",
    ".codex/",
    ".planning/",
    "AGENTS.md",
    "IDEA-DRAFT.md"
  ];

  for (const entry of requiredEntries) {
    assert.match(gitignore, new RegExp(`^${escapeRegExp(entry)}$`, "m"), `missing ${entry}`);
  }
});

test("packaged app uses an explicit production allowlist", async () => {
  const config = normalizeLineEndings(
    await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8")
  );

  assert.match(config, /^files:\n(?:[\s\S]*?)^  - out\/\*\*\/\*$/m);
  assert.match(config, /^  - package\.json$/m);
  assert.match(config, /^  - LICENSE$/m);
  assert.doesNotMatch(config, /^  - \*\*\/\*$/m);
  for (const privatePath of [".agents", ".codex", ".planning", "AGENTS.md", "IDEA-DRAFT.md"]) {
    assert.doesNotMatch(config, new RegExp(`^  - .*${escapeRegExp(privatePath)}`, "m"));
  }
});

test("package manifest and lockfile publish the same version", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lockfile = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));

  assert.equal(lockfile.version, manifest.version);
  assert.equal(lockfile.packages[""].version, manifest.version);
  assert.equal(manifest.license, "MIT");
  assert.equal(lockfile.packages[""].license, manifest.license);
});

test("TypeScript and JavaScript modules have unique case-insensitive stems", async () => {
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const modulePaths = (await Promise.all(
    ["src", "tests", "scripts"].map((directory) => collectModulePaths(repositoryRoot, directory))
  )).flat();
  const pathsByStem = new Map();

  for (const path of modulePaths) {
    const stem = path.replace(/\.(?:[cm]?[jt]sx?)$/i, "").toLowerCase();
    pathsByStem.set(stem, [...(pathsByStem.get(stem) ?? []), path]);
  }

  const collisions = [...pathsByStem.values()]
    .filter((paths) => paths.length > 1)
    .map((paths) => paths.sort())
    .sort((left, right) => left[0].localeCompare(right[0]));
  assert.deepEqual(collisions, []);
});

test("release workflow uploads installers only and keeps Windows targets distinct", async () => {
  const config = normalizeLineEndings(
    await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8")
  );
  const workflow = normalizeLineEndings(
    await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  );

  assert.match(config, /^  artifactName: .*windows-\$\{arch\}-setup\.\$\{ext\}$/m);
  assert.match(config, /^  artifactName: .*windows-\$\{arch\}-portable\.\$\{ext\}$/m);
  assert.doesNotMatch(workflow, /^\s+release\/\*$/m);
  for (const extension of ["AppImage", "deb", "exe", "dmg", "zip"]) {
    assert.match(workflow, new RegExp(`^\\s+release/\\*\\.${extension}$`, "m"));
  }
});

test("macOS release artifacts are ad-hoc signed and verified before upload", async () => {
  const config = normalizeLineEndings(
    await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8")
  );
  const workflow = normalizeLineEndings(
    await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  );

  assert.match(config, /^mac:\n(?:[\s\S]*?)^  identity: "-"$/m);
  assert.match(config, /^  hardenedRuntime: false$/m);
  assert.match(config, /^  notarize: false$/m);
  assert.doesNotMatch(workflow, /^\s+CSC_IDENTITY_AUTO_DISCOVERY:/m);
  assert.match(workflow, /Verify macOS app signature/);
  assert.match(workflow, /codesign --verify --deep --strict --verbose=4/);
  assert.ok(workflow.indexOf("Verify macOS app signature") < workflow.indexOf("Upload installers"));
});

test("AppImage avoids maximum XZ compression and is smoke-tested before upload", async () => {
  const config = normalizeLineEndings(
    await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8")
  );
  const workflow = normalizeLineEndings(
    await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  );
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(config, /^compression: normal$/m);
  assert.match(config, /^appImage:\n  compression: gzip$/m);
  assert.doesNotMatch(config, /^compression: maximum$/m);
  assert.equal(manifest.scripts["smoke:appimage"], "node scripts/smoke-appimage.mjs");
  assert.match(workflow, /sudo apt-get install --no-install-recommends -y libfuse2t64/);
  assert.match(workflow, /xvfb-run -a npm run smoke:appimage/);
  assert.ok(workflow.indexOf("Install AppImage runtime dependency") < workflow.indexOf("Smoke-test packaged AppImage"));
  assert.ok(workflow.indexOf("Smoke-test packaged AppImage") < workflow.indexOf("Upload installers"));
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeLineEndings(value) {
  return value.replaceAll("\r\n", "\n");
}

async function collectModulePaths(repositoryRoot, directory) {
  const absoluteDirectory = join(repositoryRoot, directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const paths = [];

  for (const entry of entries) {
    const relativePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...await collectModulePaths(repositoryRoot, relativePath));
    } else if (/\.(?:[cm]?[jt]sx?)$/i.test(entry.name)) {
      paths.push(relative(repositoryRoot, join(repositoryRoot, relativePath)).replaceAll("\\", "/"));
    }
  }

  return paths;
}
