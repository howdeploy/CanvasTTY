import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsStore, normalizeRemoteHosts } from "../src/main/services/SettingsStore.ts";
import { isValidRemoteHost, remoteHostInvalidReason, remotePathForHost } from "../src/shared/contracts.ts";

const validHost = {
  id: "gpu-box",
  label: "GPU box",
  sshHost: "gpu.internal.example"
};

const validMappings = [
  { localPath: "/Users/runner/canvastty", remotePath: "/srv/work/canvastty" },
  { localPath: "C:\\dev\\canvastty", remotePath: "/srv/work/canvastty-win" }
];

test("a host with two workspace mappings passes validation", () => {
  const host = { ...validHost, workspaces: validMappings };
  assert.equal(remoteHostInvalidReason(host), null);
  assert.equal(isValidRemoteHost(host), true);
});

test("hosts without workspaces remain valid", () => {
  assert.equal(remoteHostInvalidReason(validHost), null);
  assert.equal(isValidRemoteHost(validHost), true);
});

test("more than eight workspace mappings are invalid", () => {
  const workspaces = Array.from({ length: 9 }, (_value, index) => ({
    localPath: `/Users/runner/project-${index}`,
    remotePath: `/srv/work/project-${index}`
  }));
  const reason = remoteHostInvalidReason({ ...validHost, workspaces });
  assert.match(reason, /workspaces/);
  assert.match(reason, /8/);
  assert.equal(
    remoteHostInvalidReason({
      ...validHost,
      workspaces: workspaces.slice(0, 8)
    }),
    null
  );
});

test("a relative remotePath is invalid", () => {
  const reason = remoteHostInvalidReason({
    ...validHost,
    workspaces: [{ localPath: "/Users/runner/canvastty", remotePath: "srv/work/canvastty" }]
  });
  assert.match(reason, /remotePath/);
});

test("duplicate localPaths within one host are invalid, case-sensitively unique passes", () => {
  const reason = remoteHostInvalidReason({
    ...validHost,
    workspaces: [
      { localPath: "/Users/runner/canvastty", remotePath: "/srv/work/one" },
      { localPath: "/Users/runner/canvastty", remotePath: "/srv/work/two" }
    ]
  });
  assert.match(reason, /localPath/);
  assert.equal(
    remoteHostInvalidReason({
      ...validHost,
      workspaces: [
        { localPath: "/Users/runner/Canvastty", remotePath: "/srv/work/one" },
        { localPath: "/Users/runner/canvastty", remotePath: "/srv/work/two" }
      ]
    }),
    null
  );
});

test("workspaces must be an array", () => {
  assert.match(remoteHostInvalidReason({ ...validHost, workspaces: "nope" }), /workspaces/);
  assert.match(remoteHostInvalidReason({ ...validHost, workspaces: {} }), /workspaces/);
  assert.equal(remoteHostInvalidReason({ ...validHost, workspaces: [] }), null);
});

test("workspace mappings with extra or missing keys are invalid", () => {
  assert.match(
    remoteHostInvalidReason({
      ...validHost,
      workspaces: [{ ...validMappings[0], note: "extra" }]
    }),
    /exactly the localPath and remotePath keys/
  );
  assert.match(
    remoteHostInvalidReason({
      ...validHost,
      workspaces: [{ localPath: "/Users/runner/canvastty" }]
    }),
    /exactly the localPath and remotePath keys/
  );
  assert.match(
    remoteHostInvalidReason({ ...validHost, workspaces: ["nonsense"] }),
    /each workspace mapping must be an object/
  );
});

test("localPath must be a non-empty absolute POSIX or Windows path of bounded length", () => {
  for (const localPath of ["", "   ", "Users/alex/canvastty", "~alex/canvastty", "canvastty"]) {
    assert.match(
      remoteHostInvalidReason({ ...validHost, workspaces: [{ localPath, remotePath: "/srv/work" }] }),
      /localPath/
    );
  }
  assert.equal(
    remoteHostInvalidReason({
      ...validHost,
      workspaces: [{ localPath: `/Users/${"a".repeat(4089)}`, remotePath: "/srv/work" }]
    }),
    null,
    "a localPath of exactly 4096 characters is still valid"
  );
  assert.match(
    remoteHostInvalidReason({
      ...validHost,
      workspaces: [{ localPath: `/Users/${"a".repeat(4090)}`, remotePath: "/srv/work" }]
    }),
    /localPath/,
    "a localPath of 4097 characters is invalid"
  );
  assert.equal(
    remoteHostInvalidReason({
      ...validHost,
      workspaces: [
        { localPath: "C:/dev/canvastty", remotePath: "/srv/win-fwd" },
        { localPath: "\\\\fileserver\\share\\canvastty", remotePath: "/srv/win-unc" }
      ]
    }),
    null
  );
});

test("remotePath must be absolute POSIX of bounded length", () => {
  assert.match(
    remoteHostInvalidReason({
      ...validHost,
      workspaces: [{ localPath: "/Users/runner/canvastty", remotePath: "" }]
    }),
    /remotePath/
  );
  assert.match(
    remoteHostInvalidReason({
      ...validHost,
      workspaces: [{ localPath: "/Users/runner/canvastty", remotePath: `/${"a".repeat(4100)}` }]
    }),
    /remotePath/
  );
});

test("normalizeRemoteHosts preserves mappings on valid hosts and drops invalid ones whole", () => {
  const normalized = normalizeRemoteHosts(
    [
      { ...validHost, workspaces: validMappings },
      {
        ...validHost,
        id: "bad-mapping",
        workspaces: [{ localPath: "/Users/runner/canvastty", remotePath: "relative/path" }]
      },
      { ...validHost, id: "plain-host", label: "Plain host" }
    ],
    []
  );
  assert.deepEqual(normalized, [
    { ...validHost, workspaces: validMappings },
    { ...validHost, id: "plain-host", label: "Plain host" }
  ]);
  assert.equal("workspaces" in normalized[1], false);
});

test("an empty workspaces array falls away like any absent optional field", () => {
  const normalized = normalizeRemoteHosts([{ ...validHost, workspaces: [] }], []);
  assert.deepEqual(normalized, [validHost]);
  assert.equal("workspaces" in normalized[0], false);
});

test("workspace mappings persist through the settings store and settingsVersion reaches 24", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-settings-remoteworkspaces-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory, "en");
  await store.load();

  const hosts = [{ ...validHost, workspaces: validMappings }];
  await store.update({ remoteHosts: hosts });
  const reloaded = await new SettingsStore(directory, "en").load();
  assert.deepEqual(reloaded.remoteHosts, hosts);

  const persisted = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
  assert.equal(persisted.settingsVersion, 24);
  assert.deepEqual(persisted.remoteHosts, hosts);
});

test("a persisted host with an invalid mapping is dropped, not repaired", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-settings-remoteworkspaces-drop-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "settings.json"), JSON.stringify({
    settingsVersion: 21,
    remoteHosts: [
      { ...validHost, workspaces: [{ localPath: "/Users/runner/canvastty", remotePath: "srv/work" }] },
      { ...validHost, id: "build-farm", label: "Build farm" }
    ]
  }));
  const loaded = await new SettingsStore(directory, "en").load();
  assert.deepEqual(loaded.remoteHosts, [{ ...validHost, id: "build-farm", label: "Build farm" }]);
});

test("remotePathForHost resolves an exact localPath match", () => {
  const host = { ...validHost, workspaces: validMappings };
  assert.equal(remotePathForHost(host, "/Users/runner/canvastty"), "/srv/work/canvastty");
  assert.equal(remotePathForHost(host, "C:\\dev\\canvastty"), "/srv/work/canvastty-win");
});

test("remotePathForHost resolves trailing-slash differences in both directions", () => {
  const host = {
    ...validHost,
    workspaces: [{ localPath: "/Users/runner/canvastty/", remotePath: "/srv/work/canvastty" }]
  };
  assert.equal(remotePathForHost(host, "/Users/runner/canvastty"), "/srv/work/canvastty");
  assert.equal(remotePathForHost(host, "/Users/runner/canvastty/"), "/srv/work/canvastty");

  const trailingFreeHost = {
    ...validHost,
    workspaces: [{ localPath: "/Users/runner/canvastty", remotePath: "/srv/work/canvastty" }]
  };
  assert.equal(remotePathForHost(trailingFreeHost, "/Users/runner/canvastty/"), "/srv/work/canvastty");
  assert.equal(
    remotePathForHost({
      ...validHost,
      workspaces: [{ localPath: "C:\\dev\\canvastty\\", remotePath: "/srv/win" }]
    }, "C:\\dev\\canvastty"),
    "/srv/win"
  );
});

test("remotePathForHost returns null on a miss, an empty query, or a host without workspaces", () => {
  assert.equal(remotePathForHost({ ...validHost, workspaces: validMappings }, "/Users/runner/other"), null);
  assert.equal(remotePathForHost({ ...validHost, workspaces: validMappings }, ""), null);
  assert.equal(remotePathForHost({ ...validHost, workspaces: [] }, "/Users/runner/canvastty"), null);
  assert.equal(remotePathForHost(validHost, "/Users/runner/canvastty"), null);
});
