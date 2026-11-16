import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir, copyFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";
import manifest from "../package.json" with { type: "json" };

test("release gate requires the matching stable, hotfix or beta tag and complete update files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-release-gate-"));
  // A local alpha is intentionally not a public release channel. Exercise the
  // release gate in a disposable repository with a publishable beta version.
  const version = manifest.version.includes('-alpha.') ? '2.0.0-beta.1' : manifest.version;
  const files = [
    `CanvasTTY-${version}-mac-arm64.zip`, `CanvasTTY-${version}-mac-arm64.dmg`,
    `CanvasTTY-${version}-linux-x86_64.AppImage`, `CanvasTTY-${version}-linux-amd64.deb`,
    `CanvasTTY-${version}-windows-x64-setup.exe`, `CanvasTTY-${version}-windows-x64-portable.exe`
  ];
  try {
    const fixture = join(directory, 'repo');
    await mkdir(join(fixture, 'scripts'), { recursive: true });
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ type: 'module', version }));
    await copyFile(new URL('../scripts/verify-release-artifacts.mjs', import.meta.url), join(fixture, 'scripts/verify-release-artifacts.mjs'));
    await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(fixture, 'node_modules'), 'dir');
    for (const file of files) await writeFile(join(directory, file), "artifact");
    const sha512 = createHash("sha512").update("artifact").digest("base64");
    await writeFile(join(directory, "appcast.xml"), `<sparkle:version>${version}</sparkle:version><enclosure url="CanvasTTY-${version}-mac-arm64.zip" sparkle:edSignature="signed"/><!-- sparkle-signatures: signed -->`);
    await writeFile(join(directory, "latest.yml"), `version: ${version}\nfiles:\n  - url: ${files[4]}\n    sha512: ${sha512}\n    size: 8\n`);
    await writeFile(join(directory, "latest-linux.yml"), `version: ${version}\nfiles:\n  - url: ${files[2]}\n    sha512: ${sha512}\n    size: 8\n  - url: ${files[3]}\n    sha512: ${sha512}\n    size: 8\n`);
    const run = tag => spawnSync(process.execPath, ["scripts/verify-release-artifacts.mjs", tag, directory], {
      cwd: fixture, encoding: "utf8"
    });
    assert.equal(run(`v${version}`).status, 0);
    assert.notEqual(run(`v${version}-beta.1`).status, 0);
    assert.notEqual(run("v9.9.9").status, 0);
    assert.notEqual(run("v1.8.3.1").status, 0);
    await writeFile(join(directory, files[4]), "changed after metadata generation");
    assert.notEqual(run(`v${version}`).status, 0);
    await writeFile(join(directory, files[4]), "artifact");
    await rm(join(directory, files[3]));
    assert.notEqual(run(`v${version}`).status, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the local alpha cannot pass the public release gate', () => {
  if (!manifest.version.includes('-alpha.')) return;
  const result = spawnSync(process.execPath, ['scripts/verify-release-artifacts.mjs', `v${manifest.version}`], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Release tag must equal package version .* and be stable, hotfix or beta/);
});

test("beta releases stay prereleases while stable and hotfix releases become latest", async () => {
  const workflow = YAML.parse(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
  const publish = workflow.jobs.release.steps.find(step => step.name === "Create GitHub release").run;
  for (const [tag, prerelease] of [["v1.8.6-beta2", true], ["v1.8.6", false], ["v1.8.6-hotfix.1", false]]) {
    const result = spawnSync("bash", ["-c", `gh() { printf '%s\\n' "$@"; };\n${publish}`], {
      encoding: "utf8", env: { ...process.env, GITHUB_REF_NAME: tag, GITHUB_REPOSITORY: "howdeploy/CanvasTTY" }
    });
    assert.equal(result.status, 0, result.stderr);
    const args = result.stdout.trim().split("\n");
    assert.equal(args.includes("--prerelease"), prerelease, tag);
    assert.equal(args.includes("--latest=false"), prerelease, tag);
    assert.equal(args.includes("--latest"), !prerelease, tag);
  }
});

test("macOS CI can package pull requests without the release owner's key", async () => {
  const workflow = YAML.parse(await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const step = workflow.jobs["macos-cli-resolution"].steps.find(candidate => candidate.run === "npm run package:mac");
  const key = step?.env?.SPARKLE_PUBLIC_ED_KEY;
  assert.match(key ?? "", /vars\.SPARKLE_PUBLIC_ED_KEY\s*\|\|\s*'([A-Za-z0-9+/]+=*)'/);
  const fallback = key.match(/\|\|\s*'([A-Za-z0-9+/]+=*)'/)[1];
  assert.equal(Buffer.from(fallback, "base64").length, 32);
});
