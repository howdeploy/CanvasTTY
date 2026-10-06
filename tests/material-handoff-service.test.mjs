import assert from "node:assert/strict";
import { access, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { IPC } from "../src/shared/contracts.ts";
import { terminalFileQuotePath } from "../src/shared/terminalFileDrop.ts";
import { HandoffService } from "../src/main/services/materials/HandoffService.ts";
import { pngBytes, withMaterials } from "./material-fixtures.mjs";

const START = "\x1b[200~";
const END = "\x1b[201~";
const CLAUDE_IDLE = "────\r\n❯ \r\n────\r\n";
const IMAGE_LINE = /^(?:\/|[A-Za-z]:[\\/]|\\\\).*\.(png|jpe?g|gif|webp)$/i;

class FakeTerminal {
  constructor() {
    this.sessions = [];
    this.buffers = new Map();
    this.writes = [];
    this.pending = new Set();
    this.environments = new Map();
    this.service = null;
    this.tui = null;
  }

  add(session) {
    this.sessions.push({
      title: session.provider,
      titleCustomized: false,
      profile: "normal",
      role: "agent",
      position: { x: 0, y: 0 },
      size: { width: 700, height: 430 },
      startedAt: 1,
      exitCode: null,
      failureDetails: null,
      revision: 1,
      status: "idle",
      ...session
    });
    if (session.provider === "claude") this.buffers.set(session.id, { buffer: CLAUDE_IDLE, outputOffset: CLAUDE_IDLE.length });
  }

  listMetadata() {
    return this.sessions.map((session) => structuredClone(session));
  }

  launchPending(id) {
    return this.pending.has(id);
  }

  pluginContext(id) {
    const session = this.sessions.find((candidate) => candidate.id === id);
    return session ? { workingDirectory: session.cwd, environment: this.environments.get(id) ?? null } : null;
  }

  geometry() {
    return { cols: 120, rows: 30 };
  }

  readBuffer(id) {
    return { ...(this.buffers.get(id) ?? { buffer: "", outputOffset: 0 }) };
  }

  emit(id, data) {
    const current = this.buffers.get(id) ?? { buffer: "", outputOffset: 0 };
    current.buffer += data;
    current.outputOffset += data.length;
    this.buffers.set(id, current);
    this.service?.observe(IPC.terminalData, { id, data, outputOffset: current.outputOffset });
  }

  setStatus(id, status) {
    const session = this.sessions.find((candidate) => candidate.id === id);
    session.status = status;
    this.service?.observe(IPC.terminalSession, { session: structuredClone(session) });
  }

  async deliverInput(id, data) {
    this.writes.push(data);
    this.tui?.(id, data);
    return { delivered: true };
  }
}

function claudeTui(terminal) {
  let images = 0;
  let pastes = 0;
  return (id, data) => {
    if (data === "\r") {
      terminal.setStatus(id, "working");
      return;
    }
    if (!data.startsWith(START)) return;
    const lines = data.slice(START.length, -END.length).split("\n");
    const markers = lines.filter((line) => IMAGE_LINE.test(line)).map(() => `[Image #${++images}] `).join("");
    pastes += 1;
    setTimeout(() => terminal.emit(id, `\r\n❯ ${markers}[Pasted text #${pastes} +${lines.length} lines]`), 15);
  };
}

function codexToken(pasted, platform = process.platform) {
  const quoted = (platform === "win32" ? /^'((?:[^']|'')*)'$/ : /^'((?:[^']|'"'"'|'\\'')*)'$/).exec(pasted);
  if (quoted) return platform === "win32" ? quoted[1].replaceAll("''", "'") : quoted[1].replace(/'"'"'|'\\''/g, "'");
  return /\s/.test(pasted) ? null : pasted;
}

test("image paths preserve native quoting", () => {
  for (const [platform, path, quoted] of [
    ["linux", "/tmp/with spaces/hero.png", "'/tmp/with spaces/hero.png'"],
    ["linux", "/tmp/it's/hero.png", "'/tmp/it'\"'\"'s/hero.png'"],
    ["win32", "C:\\fixtures with spaces\\hero.png", "'C:\\fixtures with spaces\\hero.png'"],
    ["win32", "C:\\it's\\hero.png", "'C:\\it''s\\hero.png'"],
    ["win32", "\\\\server\\share\\hero.png", "'\\\\server\\share\\hero.png'"]
  ]) {
    assert.equal(terminalFileQuotePath(path, platform), quoted);
    assert.equal(codexToken(quoted, platform), path);
    assert.equal(IMAGE_LINE.test(path), true);
  }
  for (const path of ["hero.png", "C:hero.png", "https://example.com/hero.png"]) assert.equal(IMAGE_LINE.test(path), false);
  assert.equal(codexToken("'/tmp/a.png' '/tmp/b.png'", "linux"), null);
  assert.equal(codexToken("'C:\\a.png' 'C:\\b.png'", "win32"), null);
});

function codexTui(terminal) {
  let images = 0;
  return (id, data) => {
    if (data === "\r") {
      terminal.setStatus(id, "working");
      return;
    }
    if (!data.startsWith(START)) return;
    const inner = data.slice(START.length, -END.length);
    const image = IMAGE_LINE.test(codexToken(inner) ?? "");
    setTimeout(() => terminal.emit(id, image ? `[Image #${++images}] ` : `[Pasted Content ${inner.length} chars]`), 15);
  };
}

async function withHandoffs(run, options = {}) {
  await withMaterials(async ({ root, work, service: materials }) => {
    await writeFile(join(work, "hero.png"), pngBytes(1200, 700, 3));
    await materials.addPaths([join(work, "hero.png")], { x: 0, y: 0 });
    const hero = materials.snapshot().materials[0];
    const remark = (await materials.addRemark({
      materialId: hero.id,
      anchor: { kind: "region", x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
      reference: null,
      text: "Keep the text, copy the spacing."
    })).remark;
    const terminal = new FakeTerminal();
    const sent = [];
    const handoffs = new HandoffService({
      materials,
      terminals: terminal,
      images: {
        canDraw: () => true,
        marked: async () => Buffer.from("marked"),
        crop: async () => Buffer.from("crop")
      },
      root: materials.handoffsPath,
      locale: () => "en",
      timing: { attachMs: 400, pasteMs: 400, pollMs: 10 },
      onSent: (handoff) => sent.push(handoff.id),
      ...options
    });
    terminal.service = handoffs;
    const draft = (sessionId, overrides = {}) => ({
      id: randomUUID(),
      sessionId,
      remarkIds: [remark.id],
      editableMaterialIds: [],
      note: "",
      resultsFolder: null,
      ...overrides
    });
    try {
      await run({ materials, handoffs, terminal, hero, remark, work, draft, sent, packages: materials.handoffsPath });
    } finally {
      handoffs.dispose();
    }
  }, options);
}

test("Claude Code gets one paste with its images as bare lines, and Enter only after they show up", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, remark, draft, sent }) => {
    terminal.add({ id: "s1", provider: "claude", cwd: "/work" });
    terminal.tui = claudeTui(terminal);
    const result = await handoffs.send(draft("s1"));
    assert.equal(result.ok, true);
    const { handoff } = result;
    assert.equal(terminal.writes.length, 2);
    assert.equal(terminal.writes[1], "\r");
    const pasted = terminal.writes[0].slice(START.length, -END.length).split("\n");
    assert.deepEqual(pasted.filter((line) => IMAGE_LINE.test(line)).map((line) => basename(line)),
      ["1-hero-v1-marked.png", "1-hero-v1-crop.png"]);
    assert.deepEqual({ state: handoff.delivery.state, expected: handoff.delivery.imagesExpected, attached: handoff.delivery.imagesAttached },
      { state: "submitted", expected: 2, attached: 2 });
    assert.equal(handoff.delivery.turnStartedAt !== null, true, "the turn that began on Enter is recorded");
    assert.deepEqual((await readdir(handoff.folder)).sort(),
      ["1-hero-v1-crop.png", "1-hero-v1-marked.png", "1-hero-v1.png", "handoff.md"]);
    assert.match(await readFile(join(handoff.folder, "handoff.md"), "utf8"), /^CanvasTTY · handoff #1 · remarks: 1/);
    assert.equal(materials.remark(remark.id).status, "sent");
    assert.deepEqual(materials.remark(remark.id).handoffIds, [handoff.id]);
    assert.deepEqual(sent, [handoff.id]);
    terminal.setStatus("s1", "idle");
    assert.notEqual(materials.handoff(handoff.id).delivery.turnEndedAt, null);
  });
});

test("when the paste never shows up in Claude's prompt nothing is submitted", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, remark, draft }) => {
    terminal.add({ id: "s1", provider: "claude", cwd: "/work" });
    const result = await handoffs.send(draft("s1"));
    assert.equal(result.ok, true);
    assert.equal(terminal.writes.length, 1);
    assert.deepEqual({ state: result.handoff.delivery.state, note: result.handoff.delivery.note }, { state: "pasted", note: "not-seen" });
    assert.equal(materials.remark(remark.id).status, "open", "a remark that was never submitted is still open");
  });
});

test("Codex needs an empty prompt; then each image goes in its own paste before the text", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, draft }) => {
    terminal.add({ id: "c1", provider: "codex", cwd: "/work" });
    terminal.tui = codexTui(terminal);
    terminal.emit("c1", "\r\n› Update now\r\n");
    const blocked = await handoffs.send(draft("c1"));
    assert.deepEqual(blocked, { ok: false, reason: "composer-not-ready" });
    assert.equal(terminal.writes.length, 0);
    assert.equal(materials.snapshot().handoffs.length, 0);

    terminal.emit("c1", "\x1b[2J\x1b[H› Ask Codex to do anything\r\n");
    const result = await handoffs.send(draft("c1"));
    assert.equal(result.ok, true);
    assert.deepEqual(terminal.writes.map((write) => write === "\r" ? "enter" : IMAGE_LINE.test(codexToken(write.slice(START.length, -END.length)) ?? "") ? "image" : "text"),
      ["image", "image", "text", "enter"]);
    assert.equal(result.handoff.delivery.imagesAttached, 2);
    assert.match(terminal.writes[2], /Attached images, in order: 1\) `1-hero-v1-marked\.png` 2\) `1-hero-v1-crop\.png`/);
  });
});

test("dots Codex animates around its prompt do not hide whether it is empty", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft }) => {
    terminal.add({ id: "c1", provider: "codex", cwd: "/work" });
    terminal.tui = codexTui(terminal);
    terminal.emit("c1", "\x1b[2J\x1b[H›⠁half-typed words   ⠈\r\n");
    assert.deepEqual(await handoffs.send(draft("c1")), { ok: false, reason: "composer-not-ready" });
    terminal.emit("c1", "\x1b[2J\x1b[H   ⠁  ⠐\r\n›⠁Ask Codex to do anything   ⠈    ⠄\r\n");
    assert.equal((await handoffs.send(draft("c1"))).ok, true);
  });
});

test("a Codex prompt drawn before the kept output was trimmed still counts as empty", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft }) => {
    terminal.add({ id: "c1", provider: "codex", cwd: "/work" });
    terminal.tui = codexTui(terminal);
    terminal.setStatus("c1", "unavailable");
    terminal.emit("c1", "\x1b[2J\x1b[H› Ask Codex to do anything\r\n");
    const drawn = terminal.readBuffer("c1").outputOffset;
    for (let frame = 0; frame < 400; frame += 1) terminal.emit("c1", `\x1b[${3 + (frame % 5)};${10 + (frame % 60)}H${frame % 2 ? "⠁" : " "}`);
    const kept = terminal.readBuffer("c1");
    terminal.buffers.set("c1", { buffer: kept.buffer.slice(drawn), outputOffset: kept.outputOffset });
    assert.equal((await handoffs.send(draft("c1"))).ok, true);
  });
});

test("unobserved paste stays pending", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, remark, draft }) => {
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    const result = await handoffs.send(draft("q1"));
    assert.equal(result.ok, true);
    assert.equal(terminal.writes.length, 1);
    assert.ok(terminal.writes[0].endsWith(END));
    assert.ok(terminal.writes[0].includes("Images (open them):\n- `" + join(result.handoff.folder, "1-hero-v1-marked.png") + "`"));
    assert.deepEqual({ state: result.handoff.delivery.state, note: result.handoff.delivery.note, attached: result.handoff.delivery.imagesAttached },
      { state: "pasted", note: "not-observed", attached: 0 });
    assert.equal(materials.remark(remark.id).status, "open");
    terminal.setStatus("q1", "working");
    const confirmed = materials.handoff(result.handoff.id).delivery;
    assert.deepEqual({ state: confirmed.state, started: confirmed.turnStartedAt !== null }, { state: "pasted", started: false });
    assert.deepEqual({ status: materials.remark(remark.id).status, handoffs: materials.remark(remark.id).handoffIds }, { status: "open", handoffs: [] });
  });
});

test("sessions that cannot take a handoff right now are refused before anything is written", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, draft }) => {
    terminal.add({ id: "t", provider: "terminal", cwd: "/work" });
    terminal.add({ id: "busy", provider: "claude", cwd: "/work", status: "working" });
    terminal.add({ id: "ask", provider: "claude", cwd: "/work", status: "needs_approval" });
    terminal.add({ id: "gone", provider: "claude", cwd: "/work", status: "done", exitCode: 0 });
    terminal.add({ id: "boot", provider: "claude", cwd: "/work" });
    terminal.add({ id: "far", provider: "claude", cwd: "/work" });
    terminal.pending.add("boot");
    terminal.environments.set("far", { pluginId: "env", kind: "ssh" });
    const reasons = [];
    for (const id of ["missing", "t", "busy", "ask", "gone", "boot", "far"]) reasons.push((await handoffs.send(draft(id))).reason);
    assert.deepEqual(reasons, ["no-session", "not-an-agent", "busy", "needs-approval", "exited", "starting", "remote-environment"]);
    assert.equal(terminal.writes.length, 0);
    assert.equal(materials.snapshot().handoffs.length, 0);
    assert.deepEqual(await handoffs.send(draft("t", { remarkIds: [] })), { ok: false, reason: "no-remarks" });
  });
});

test("a second send to the same session while one is in flight is refused, not duplicated", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, draft }) => {
    terminal.add({ id: "s1", provider: "claude", cwd: "/work" });
    terminal.tui = claudeTui(terminal);
    const first = handoffs.send(draft("s1"));
    const second = await handoffs.send(draft("s1"));
    assert.deepEqual(second, { ok: false, reason: "busy" });
    assert.equal((await first).ok, true);
    assert.equal(materials.snapshot().handoffs.length, 1);
  });
});

test("the preview shows the exact text and files without writing anything", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft, work, hero }) => {
    terminal.add({ id: "s1", provider: "claude", cwd: work, status: "unavailable" });
    handoffs.grantResultsFolder("/elsewhere/results");
    const result = await handoffs.preview(draft("s1", { editableMaterialIds: [hero.id], resultsFolder: "/elsewhere/results" }));
    assert.equal(result.ok, true);
    const { preview } = result;
    assert.deepEqual(preview.files, ["1-hero-v1.png", "1-hero-v1-marked.png", "1-hero-v1-crop.png"]);
    assert.deepEqual({ imageMode: preview.imageMode, images: preview.images }, { imageMode: "attach", images: 2 });
    assert.deepEqual(preview.warnings.sort(), ["results-outside-workdir", "status-unknown"]);
    assert.match(preview.text, /You may change these working files:\n- `.*hero\.png`/);
    const folder = preview.text.split("\n")[3].slice(1, -1);
    await assert.rejects(access(folder));
    assert.equal(terminal.writes.length, 0);
  });
});

test("a results folder is watched only after the person picked it", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft, work }) => {
    terminal.add({ id: "s1", provider: "claude", cwd: work, status: "idle" });
    assert.deepEqual(await handoffs.preview(draft("s1", { resultsFolder: join(work, "results") })), { ok: false, reason: "unavailable" });
    assert.deepEqual(await handoffs.send(draft("s1", { resultsFolder: join(work, "results") })), { ok: false, reason: "unavailable" });
    handoffs.grantResultsFolder(join(work, "results"));
    assert.equal((await handoffs.preview(draft("s1", { resultsFolder: join(work, "results") }))).ok, true);
    assert.equal(terminal.writes.length, 0);
  });
});

test("what the preview shows is exactly what the agent receives, and the same handoff is never sent twice", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, draft }) => {
    terminal.add({ id: "s1", provider: "claude", cwd: "/work" });
    terminal.tui = claudeTui(terminal);
    const request = draft("s1", { note: "Проверь на localhost:5173" });
    const preview = await handoffs.preview(request);
    const sent = await handoffs.send(request);
    assert.equal(sent.ok, true);
    assert.equal(terminal.writes[0], `${START}${preview.preview.text}${END}`);
    assert.deepEqual(await handoffs.send(request), { ok: false, reason: "already-sent" });
    assert.equal(materials.snapshot().handoffs.length, 1);
    assert.equal(terminal.writes.length, 2);
  });
});

test("the handoff file always holds every remark, even when the paste only points to it", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, hero, remark, draft }) => {
    const long = [remark.id];
    for (let index = 0; index < 9; index += 1) {
      long.push((await materials.addRemark({ materialId: hero.id, anchor: { kind: "whole" }, reference: null, text: `${index} ${"x".repeat(1_900)}` })).remark.id);
    }
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    const result = await handoffs.send(draft("q1", { remarkIds: long }));
    assert.equal(result.ok, true);
    assert.match(terminal.writes[0], /the full remarks are in/);
    const file = await readFile(join(result.handoff.folder, "handoff.md"), "utf8");
    for (let index = 0; index < 9; index += 1) assert.ok(file.includes(`${index} ${"x".repeat(1_900)}`));
  });
});

test("control characters in names, remarks and notes never reach the terminal", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, draft }) => {
    const captured = await materials.addCapture({
      name: "evil\x1b[201~\x1b[Z\rrun.txt", bytes: Buffer.from("text\n"), mimeType: "text/plain",
      origin: { kind: "clipboard" }, point: { x: 0, y: 0 }
    });
    assert.equal(captured.ok, true);
    const evil = materials.material(captured.materialId);
    const remark = (await materials.addRemark({ materialId: evil.id, anchor: { kind: "whole" }, reference: null, text: "fix\x07 it\x1b[201~" })).remark;
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    const result = await handoffs.send(draft("q1", { remarkIds: [remark.id], note: "note\r\x1b[Z" }));
    assert.equal(result.ok, true);
    const inner = terminal.writes[0].slice(START.length, -END.length);
    assert.doesNotMatch(inner, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    assert.match(inner, /evil\[201~\[Z run\.txt/);
    assert.doesNotMatch(await readFile(join(result.handoff.folder, "handoff.md"), "utf8"), /\x1b/);
  });
});

test("a version shared by several remarks is copied once, and oversized packages are refused", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, hero, remark, draft }) => {
    const second = (await materials.addRemark({ materialId: hero.id, anchor: { kind: "whole" }, reference: null, text: "Also here" })).remark;
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    const result = await handoffs.send(draft("q1", { remarkIds: [remark.id, second.id] }));
    assert.deepEqual((await readdir(result.handoff.folder)).filter((name) => /-v1\.png$/.test(name)), ["1-hero-v1.png"]);
    assert.match(terminal.writes[0], /#2 · hero\.png, version 1 · the whole file\nSource file: .*\nVersion snapshot: `1-hero-v1\.png`/);
  });
  await withHandoffs(async ({ handoffs, terminal, draft }) => {
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    assert.deepEqual(await handoffs.send(draft("q1")), { ok: false, reason: "too-long" });
    assert.equal(terminal.writes.length, 0);
  }, { packageLimit: 10 });
});

test("old handoff packages are pruned by count and by their total size, newest first", async () => {
  await withHandoffs(async ({ handoffs, packages }) => {
    for (const [index, name] of ["old", "middle", "new"].entries()) {
      await mkdir(join(packages, name), { recursive: true });
      await writeFile(join(packages, name, "copy.png"), Buffer.alloc(60));
      const time = new Date(Date.now() - (3 - index) * 60_000);
      await utimes(join(packages, name), time, time);
    }
    await handoffs.prune();
    assert.deepEqual(await readdir(packages), ["new"]);
  }, { foldersBytesLimit: 100 });
});

test("sending packages survive pruning", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft, packages }) => {
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    terminal.deliverInput = async () => { started.resolve(); await release.promise; return { delivered: true }; };
    const request = draft("q1");
    const pending = handoffs.send(request);
    try {
      await started.promise;
      await mkdir(join(packages, "later"));
      await writeFile(join(packages, "later", "copy"), Buffer.alloc(4_000));
      const time = new Date(Date.now() + 60_000);
      await utimes(join(packages, "later"), time, time);
      await handoffs.prune();
      await access(join(packages, request.id, "handoff.md"));
      assert.deepEqual(await readdir(packages), [request.id]);
    } finally {
      release.resolve();
      await pending;
    }
  }, { foldersBytesLimit: 4_000 });
});

test("pending paste survives pruning", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft, packages }) => {
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    const result = await handoffs.send(draft("q1"));
    await mkdir(join(packages, "later"));
    await writeFile(join(packages, "later", "copy"), Buffer.alloc(4_000));
    const time = new Date(Date.now() + 60_000);
    await utimes(join(packages, "later"), time, time);
    await handoffs.prune();
    await access(join(result.handoff.folder, "handoff.md"));
    terminal.sessions[0].startedAt = 2;
    await mkdir(join(packages, "later"));
    await writeFile(join(packages, "later", "copy"), Buffer.alloc(4_000));
    await utimes(join(packages, "later"), time, time);
    await handoffs.prune();
    assert.deepEqual(await readdir(packages), ["later"]);
  }, { foldersBytesLimit: 4_000 });
});

test("working turn retains its package", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft, packages }) => {
    terminal.add({ id: "s1", provider: "claude", cwd: "/work" });
    terminal.tui = claudeTui(terminal);
    const result = await handoffs.send(draft("s1"));
    assert.equal(result.handoff.delivery.state, "submitted");
    assert.notEqual(result.handoff.delivery.turnStartedAt, null);
    await mkdir(join(packages, "later"));
    await writeFile(join(packages, "later", "copy"), Buffer.alloc(4_000));
    const time = new Date(Date.now() + 60_000);
    await utimes(join(packages, "later"), time, time);
    await handoffs.prune();
    await access(join(result.handoff.folder, "handoff.md"));
    terminal.setStatus("s1", "idle");
    await mkdir(join(packages, "later"));
    await writeFile(join(packages, "later", "copy"), Buffer.alloc(4_000));
    await utimes(join(packages, "later"), time, time);
    await handoffs.prune();
    assert.deepEqual(await readdir(packages), ["later"]);
  }, { foldersBytesLimit: 4_000 });
});

test("protected bytes block delivery", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft, packages }) => {
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    terminal.add({ id: "q2", provider: "qwen", cwd: "/work" });
    const first = await handoffs.send(draft("q1"));
    assert.equal(first.ok, true);
    const request = draft("q2");
    assert.deepEqual(await handoffs.send(request), { ok: false, reason: "quota" });
    assert.equal(terminal.writes.length, 1);
    await access(join(first.handoff.folder, "handoff.md"));
    assert.deepEqual(await readdir(packages), [first.handoff.id]);
  }, { foldersBytesLimit: 5_000, images: { canDraw: () => true, marked: async () => Buffer.alloc(3_000), crop: async () => null } });
});

test("drawn bytes obey shared quota", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, draft, packages }) => {
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    terminal.add({ id: "q2", provider: "qwen", cwd: "/work" });
    const first = await handoffs.send(draft("q1"));
    assert.equal(first.ok, true);
    const request = draft("q2");
    assert.equal((await handoffs.preview(request)).ok, true);
    assert.deepEqual(await handoffs.send(request), { ok: false, reason: "quota" });
    assert.equal(materials.handoff(request.id).delivery.state, "failed");
    assert.equal(terminal.writes.length, 1);
    await access(join(first.handoff.folder, "handoff.md"));
    assert.deepEqual(await readdir(packages), [first.handoff.id]);
  }, { foldersBytesLimit: 64 * 1024, images: { canDraw: () => true, marked: async () => Buffer.alloc(48 * 1024), crop: async () => null } });
});

test("pending history survives failed attempts", async () => {
  let broken = false;
  await withHandoffs(async ({ materials, handoffs, terminal, draft }) => {
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    terminal.add({ id: "q2", provider: "qwen", cwd: "/work" });
    const first = await handoffs.send(draft("q1"));
    broken = true;
    for (let index = 0; index < 205; index += 1) assert.deepEqual(await handoffs.send(draft("q2")), { ok: false, reason: "unreadable" });
    assert.equal(materials.snapshot().handoffs.length, 200);
    assert.equal(materials.handoff(first.handoff.id)?.delivery.state, "pasted");
    await access(join(first.handoff.folder, "handoff.md"));
    assert.equal(terminal.writes.length, 1);
  }, { images: { canDraw: () => true, marked: async () => { if (broken) throw new Error("unreadable"); return Buffer.from("marked"); }, crop: async () => null } });
});

test("failed history does not hide submitted turns", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, draft }) => {
    terminal.add({ id: "s1", provider: "claude", cwd: "/work", status: "unavailable" });
    const render = claudeTui(terminal);
    terminal.tui = (id, data) => { if (data !== "\r") render(id, data); };
    const first = await handoffs.send(draft("s1"));
    assert.equal(first.handoff.delivery.state, "submitted");
    assert.equal(first.handoff.delivery.turnStartedAt, null);
    materials.recordHandoff({ ...first.handoff, id: randomUUID(), number: 2, delivery: { ...first.handoff.delivery, state: "failed" } });
    terminal.setStatus("s1", "working");
    assert.notEqual(materials.handoff(first.handoff.id).delivery.turnStartedAt, null);
    terminal.setStatus("s1", "idle");
    assert.notEqual(materials.handoff(first.handoff.id).delivery.turnEndedAt, null);
  });
});

test("protected folders block delivery", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, draft, packages }) => {
    await mkdir(packages, { recursive: true });
    for (let number = 1; number <= 50; number += 1) {
      const id = randomUUID();
      const sessionId = `q${number}`;
      terminal.add({ id: sessionId, provider: "qwen", cwd: "/work" });
      const folder = join(packages, id);
      await mkdir(folder);
      await writeFile(join(folder, "handoff.md"), "pending");
      materials.recordHandoff({
        id, number, createdAt: 1, sessionId, sessionTitle: sessionId, provider: "qwen", remarkIds: [], items: [], note: "", folder,
        resultsFolder: null, sessionStartedAt: 1,
        delivery: { state: "pasted", imagesExpected: 0, imagesAttached: 0, sentAt: 1, turnStartedAt: null, turnEndedAt: null, note: "not-observed", error: null, stateSaved: true }
      });
    }
    terminal.add({ id: "new", provider: "qwen", cwd: "/work" });
    assert.deepEqual(await handoffs.send(draft("new")), { ok: false, reason: "quota" });
    assert.equal(terminal.writes.length, 0);
    assert.equal((await readdir(packages)).length, 50);
  });
});

test("unreadable state prevents package pruning", async () => {
  await withMaterials(async ({ service, create, userData }) => {
    await service.dispose();
    const statePath = join(userData, "materials", "state.json");
    await writeFile(statePath, "{broken");
    for (const name of ["older", "newer"]) {
      await mkdir(join(service.handoffsPath, name), { recursive: true });
      await writeFile(join(service.handoffsPath, name, "handoff.md"), Buffer.alloc(60, 7));
    }
    const materials = await create();
    assert.equal(materials.snapshot().loadError, "unreadable");
    const handoffs = new HandoffService({
      materials,
      terminals: new FakeTerminal(),
      images: { canDraw: () => false, marked: async () => null, crop: async () => null },
      root: materials.handoffsPath,
      locale: () => "en",
      foldersBytesLimit: 100
    });
    try {
      await handoffs.prune();
      assert.deepEqual((await readdir(materials.handoffsPath)).sort(), ["newer", "older"]);
      for (const name of ["older", "newer"]) {
        assert.deepEqual(await readFile(join(materials.handoffsPath, name, "handoff.md")), Buffer.alloc(60, 7));
      }
      assert.equal(await readFile(statePath, "utf8"), "{broken");
    } finally {
      handoffs.dispose();
    }
  });
});

test("a previous paste still waiting in Claude's prompt blocks the next one", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft }) => {
    terminal.add({ id: "s1", provider: "claude", cwd: "/work" });
    terminal.tui = claudeTui(terminal);
    terminal.emit("s1", "\r\n❯ [Pasted text #1 +20 lines]");
    assert.deepEqual(await handoffs.send(draft("s1")), { ok: false, reason: "composer-not-ready" });
    terminal.emit("s1", "\x1b[2J\x1b[H❯ \r\n");
    assert.equal((await handoffs.send(draft("s1"))).ok, true);
  });
});

test("Claude's dimmed prompt hint is not input, but text the user typed there is", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft }) => {
    terminal.add({ id: "s1", provider: "claude", cwd: "/work" });
    terminal.tui = claudeTui(terminal);
    terminal.emit("s1", "\x1b[2J\x1b[H────\r\n❯ half a thought\x1b[7m \x1b[27m\r\n────\r\n");
    assert.deepEqual(await handoffs.send(draft("s1")), { ok: false, reason: "composer-not-ready" });
    terminal.emit("s1", "\x1b[2J\x1b[H────\r\n❯ \x1b[2mTry\x1b[7G\"create\x1b[15Ga\x1b[17Gutil\"\x1b[22m\r\n────\r\n");
    assert.equal((await handoffs.send(draft("s1"))).ok, true);
  });
});

test("Claude's completed prompt stays outside the composer", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft }) => {
    terminal.add({ id: "s1", provider: "claude", cwd: "/work" });
    terminal.tui = claudeTui(terminal);
    terminal.emit("s1", "\x1b[2J\x1b[H❯ previous request\r\nFinished.\r\n────\r\n❯ \r\n────\r\n");
    const result = await handoffs.send(draft("s1"));
    assert.equal(result.ok, true);
    assert.equal(result.handoff.delivery.state, "submitted");
    assert.equal(terminal.writes.at(-1), "\r");
  });
});

test("Claude's multiline draft still blocks delivery", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft }) => {
    terminal.add({ id: "s1", provider: "claude", cwd: "/work" });
    terminal.emit("s1", "\x1b[2J\x1b[H────\r\n❯ real draft\r\n  ❯ \r\n────\r\n");
    assert.deepEqual(await handoffs.send(draft("s1")), { ok: false, reason: "composer-not-ready" });
    assert.equal(terminal.writes.length, 0);
  });
});

test("a status change during packaging blocks the paste", async () => {
  for (const status of ["working", "needs_approval"]) {
    let preparing;
    await withHandoffs(async ({ materials, handoffs, terminal, remark, draft }) => {
      terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
      preparing = () => terminal.setStatus("q1", status);
      const result = await handoffs.send(draft("q1"));
      assert.equal(terminal.writes.length, 0);
      assert.equal(result.handoff.delivery.state, "failed");
      assert.equal(materials.remark(remark.id).status, "open");
    }, {
      images: {
        canDraw: () => true,
        marked: async () => { preparing(); return Buffer.from("marked"); },
        crop: async () => Buffer.from("crop")
      }
    });
  }
});

test("a status change after pasting blocks Enter", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, remark, draft }) => {
    terminal.add({ id: "s1", provider: "claude", cwd: "/work" });
    const render = claudeTui(terminal);
    terminal.tui = (id, data) => {
      render(id, data);
      if (data.startsWith(START)) terminal.setStatus(id, "needs_approval");
    };
    const result = await handoffs.send(draft("s1"));
    assert.equal(terminal.writes.includes("\r"), false);
    assert.equal(result.handoff.delivery.state, "pasted");
    assert.equal(result.handoff.delivery.note, "enter-failed");
    assert.equal(materials.remark(remark.id).status, "open");
  });
});

test("a status change between Codex images stops delivery", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft }) => {
    terminal.add({ id: "c1", provider: "codex", cwd: "/work" });
    terminal.emit("c1", "\x1b[2J\x1b[H› Ask Codex to do anything\r\n");
    const render = codexTui(terminal);
    terminal.tui = (id, data) => {
      render(id, data);
      terminal.setStatus(id, "needs_approval");
    };
    const result = await handoffs.send(draft("c1"));
    assert.equal(terminal.writes.length, 1);
    assert.equal(result.handoff.delivery.state, "failed");
  });
});

test("a session restarted in the middle of a delivery gets nothing more, and the handoff says why", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft }) => {
    terminal.add({ id: "c1", provider: "codex", cwd: "/work", startedAt: 100 });
    let images = 0;
    terminal.tui = (id, data) => {
      const inner = data.startsWith(START) ? data.slice(START.length, -END.length) : "";
      if (!IMAGE_LINE.test(codexToken(inner) ?? "")) return;
      setTimeout(() => terminal.emit(id, `[Image #${++images}] `), 5);
      if (images === 0) terminal.sessions[0].startedAt = 200;
    };
    terminal.emit("c1", "\x1b[2J\x1b[H› Ask Codex to do anything\r\n");
    const result = await handoffs.send(draft("c1"));
    assert.deepEqual({ state: result.handoff.delivery.state, error: result.handoff.delivery.error },
      { state: "failed", error: "The session restarted or exited during delivery." });
    assert.equal(terminal.writes.length, 1);
  });
});

test("Codex text counts as shown only when more of it appears than before the paste", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft }) => {
    terminal.add({ id: "c1", provider: "codex", cwd: "/work" });
    const request = draft("c1");
    const preview = (await handoffs.preview(request)).preview.text;
    let images = 0;
    terminal.tui = (id, data) => {
      const inner = data.startsWith(START) ? data.slice(START.length, -END.length) : "";
      if (IMAGE_LINE.test(codexToken(inner) ?? "")) setTimeout(() => terminal.emit(id, `[Image #${++images}] `), 5);
    };
    terminal.emit("c1", `\x1b[2J\x1b[H${preview.split("\n").at(-1)}\r\n› Ask Codex to do anything\r\n`);
    const result = await handoffs.send(request);
    assert.deepEqual({ state: result.handoff.delivery.state, note: result.handoff.delivery.note }, { state: "pasted", note: "not-seen" });
    assert.equal(terminal.writes.includes("\r"), false);
  });
});

test("Claude counts as ready only when its prompt is on screen and empty", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft }) => {
    terminal.add({ id: "s1", provider: "claude", cwd: "/work" });
    terminal.tui = claudeTui(terminal);
    terminal.emit("s1", "\x1b[2J\x1b[H────\r\n! \r\n────\r\n");
    assert.deepEqual(await handoffs.send(draft("s1")), { ok: false, reason: "composer-not-ready" });
    terminal.emit("s1", "\x1b[2J\x1b[H");
    assert.deepEqual(await handoffs.send(draft("s1")), { ok: false, reason: "composer-not-ready" });
    assert.equal(terminal.writes.length, 0);
  });
});

test("concurrent handoffs to different sessions get their own numbers", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft }) => {
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    terminal.add({ id: "q2", provider: "qwen", cwd: "/work" });
    const results = await Promise.all([handoffs.send(draft("q1")), handoffs.send(draft("q2"))]);
    assert.deepEqual(results.map((result) => result.handoff.number).sort(), [1, 2]);
  });
});

test("a turn the person starts long after a handoff is not credited to it", async () => {
  let now = 1_000_000;
  await withHandoffs(async ({ materials, handoffs, terminal, draft }) => {
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    const result = await handoffs.send(draft("q1"));
    now += 3 * 60 * 60 * 1000;
    terminal.setStatus("q1", "working");
    assert.deepEqual({ state: materials.handoff(result.handoff.id).delivery.state, started: materials.handoff(result.handoff.id).delivery.turnStartedAt },
      { state: "pasted", started: null });
  }, { now: () => now });
});

test("images that cannot be drawn are left out of the preview as well as the package", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft }) => {
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    const { preview } = await handoffs.preview(draft("q1"));
    assert.deepEqual(preview.files, ["1-hero-v1.png"]);
    assert.doesNotMatch(preview.text, /marked|crop/);
  }, { images: { canDraw: () => false, marked: async () => Buffer.from("marked"), crop: async () => Buffer.from("crop") } });
});

test("sessions that were running before the service started are mirrored from what they already printed", async () => {
  await withHandoffs(async ({ materials, terminal, draft }) => {
    terminal.add({ id: "c1", provider: "codex", cwd: "/work" });
    terminal.tui = codexTui(terminal);
    terminal.emit("c1", "\x1b[2J\x1b[H› Ask Codex to do anything\r\n");
    const drawn = terminal.readBuffer("c1").outputOffset;
    const restored = new HandoffService({
      materials,
      terminals: terminal,
      images: { canDraw: () => true, marked: async () => Buffer.from("marked"), crop: async () => Buffer.from("crop") },
      root: materials.handoffsPath,
      locale: () => "en",
      timing: { attachMs: 400, pasteMs: 400, pollMs: 10 }
    });
    terminal.service = restored;
    try {
      for (let frame = 0; frame < 400; frame += 1) terminal.emit("c1", `\x1b[${3 + (frame % 5)};${10 + (frame % 60)}H${frame % 2 ? "⠁" : " "}`);
      const kept = terminal.readBuffer("c1");
      terminal.buffers.set("c1", { buffer: kept.buffer.slice(drawn), outputOffset: kept.outputOffset });
      assert.equal((await restored.send(draft("c1"))).ok, true);
      assert.equal(terminal.writes.at(-1), "\r");
    } finally {
      restored.dispose();
    }
  });
});

test("the warning about a results folder outside the working folder follows real paths", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft, work }) => {
    const linked = join(tmpdir(), `canvastty-linked-${randomUUID()}`);
    await symlink(work, linked);
    try {
      terminal.add({ id: "q1", provider: "qwen", cwd: linked });
      handoffs.grantResultsFolder(join(work, "results"));
      const { preview } = await handoffs.preview(draft("q1", { resultsFolder: join(work, "results") }));
      assert.deepEqual(preview.warnings, []);
    } finally {
      await rm(linked, { force: true });
    }
  });
});

test("status from a later run of the session never ends the turn of an earlier one", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, draft }) => {
    terminal.add({ id: "s1", provider: "claude", cwd: "/work", startedAt: 100 });
    terminal.tui = claudeTui(terminal);
    const result = await handoffs.send(draft("s1"));
    assert.notEqual(result.handoff.delivery.turnStartedAt, null);
    terminal.sessions[0].startedAt = 200;
    terminal.setStatus("s1", "idle");
    assert.equal(materials.handoff(result.handoff.id).delivery.turnEndedAt, null);
  });
});

test("too many remarks are named as such, and a delivery error leaves a failed record", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, remark, draft }) => {
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    const many = Array.from({ length: 51 }, () => randomUUID());
    assert.deepEqual(await handoffs.send(draft("q1", { remarkIds: many })), { ok: false, reason: "too-many-remarks" });
    terminal.deliverInput = async () => {
      throw new Error("pty gone");
    };
    const result = await handoffs.send(draft("q1"));
    assert.deepEqual({ state: result.handoff.delivery.state, error: result.handoff.delivery.error }, { state: "failed", error: "pty gone" });
    assert.equal(materials.remark(remark.id).status, "open");
  });
});

test("Codex text that never lands is not submitted even though its images did", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft }) => {
    terminal.add({ id: "c1", provider: "codex", cwd: "/work" });
    let images = 0;
    terminal.tui = (id, data) => {
      const inner = data.startsWith(START) ? data.slice(START.length, -END.length) : "";
      if (IMAGE_LINE.test(codexToken(inner) ?? "")) setTimeout(() => terminal.emit(id, `[Image #${++images}] `), 15);
    };
    terminal.emit("c1", "\x1b[2J\x1b[H› Ask Codex to do anything\r\n");
    const result = await handoffs.send(draft("c1"));
    assert.equal(result.handoff.delivery.state, "pasted");
    assert.equal(terminal.writes.includes("\r"), false);
  });
});

test("images that could not be drawn are not counted as expected", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft }) => {
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    const result = await handoffs.send(draft("q1"));
    assert.equal(result.handoff.delivery.imagesExpected, 1);
    assert.doesNotMatch(terminal.writes[0], /marked\.png/);
  }, { images: { canDraw: () => true, marked: async () => null, crop: async () => Buffer.from("crop") } });
});

test("Codex gets image paths it can read as one path even with spaces, and text that stays inline counts once its end shows", async () => {
  const spaced = join(tmpdir(), `canvastty handoffs ${randomUUID()}`);
  try {
    await withHandoffs(async ({ handoffs, terminal, draft }) => {
      terminal.add({ id: "c1", provider: "codex", cwd: "/work" });
      let images = 0;
      terminal.tui = (id, data) => {
        if (data === "\r") {
          terminal.setStatus(id, "working");
          return;
        }
        const inner = data.slice(START.length, -END.length);
        const token = codexToken(inner);
        if (token && IMAGE_LINE.test(token)) {
          setTimeout(() => terminal.emit(id, `[Image #${++images}] `), 15);
          return;
        }
        const lines = inner.split("\n");
        setTimeout(() => terminal.emit(id, `\x1b[2J\x1b[H› ${lines.slice(-3).join("\r\n  ")}\r\n`), 15);
      };
      terminal.emit("c1", "\x1b[2J\x1b[H› Ask Codex to do anything\r\n");
      const result = await handoffs.send(draft("c1"));
      assert.ok(result.handoff.folder.includes(" "));
      assert.deepEqual({ state: result.handoff.delivery.state, attached: result.handoff.delivery.imagesAttached }, { state: "submitted", attached: 2 });
    }, { root: join(spaced, "handoffs") });
  } finally {
    await rm(spaced, { recursive: true, force: true });
  }
});


test("an accepted or reported remark cannot be sent again, and its status survives", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, remark, draft }) => {
    terminal.add({ id: "s1", provider: "claude", cwd: "/work" });
    terminal.tui = claudeTui(terminal);
    await materials.updateRemark(remark.id, { status: "accepted" });
    const refused = await handoffs.send(draft("s1"));
    assert.deepEqual(refused, { ok: false, reason: "unavailable" });
    assert.equal(materials.remark(remark.id).status, "accepted");
    assert.equal(terminal.writes.length, 0);
    await materials.updateRemark(remark.id, { status: "reopened" });
    const sent = await handoffs.send(draft("s1"));
    assert.equal(sent.ok, true);
    assert.equal(materials.remark(remark.id).status, "sent");
    materials.markRemarksSent([remark.id], sent.handoff.id);
    assert.equal(materials.remark(remark.id).status, "sent");
    materials.applyReport(sent.handoff.id, [remark.number], null);
    assert.equal(materials.remark(remark.id).status, "reported");
    terminal.add({ id: "s2", provider: "claude", cwd: "/work" });
    const refusedAgain = await handoffs.send(draft("s2"));
    assert.deepEqual(refusedAgain, { ok: false, reason: "unavailable" });
    assert.equal(materials.remark(remark.id).status, "reported");
    assert.equal(terminal.writes.length, 2);
  });
});

test("the preview counts drawn images at their source size before any bytes are written", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft }) => {
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    assert.deepEqual(await handoffs.preview(draft("q1")), { ok: false, reason: "too-long" });
  }, { packageLimit: 50, images: { canDraw: () => true, marked: async () => Buffer.alloc(8), crop: async () => Buffer.alloc(8) } });
  await withHandoffs(async ({ handoffs, terminal, draft }) => {
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    const preview = await handoffs.preview(draft("q1"));
    assert.equal(preview.ok, true);
  }, { packageLimit: 100_000, images: { canDraw: () => true, marked: async () => Buffer.alloc(8), crop: async () => Buffer.alloc(8) } });
});

test("drawn images are charged once: a package inside the estimate but under the limit sends fine", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft, sent }) => {
    terminal.add({ id: "q1", provider: "qwen", cwd: "/work" });
    terminal.tui = claudeTui(terminal);
    const result = await handoffs.send(draft("q1"));
    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
  }, { packageLimit: 120, images: { canDraw: () => true, marked: async () => Buffer.alloc(8), crop: async () => Buffer.alloc(8) } });
});

test("a handoff refuses delivery while the state cannot be persisted", async () => {
  await withHandoffs(async ({ materials, handoffs, terminal, draft, packages }) => {
    terminal.add({ provider: "claude", id: "s1" });
    const blocked = join(packages, "..", "state.json.tmp");
    await mkdir(blocked);
    const request = draft("s1");
    const result = await handoffs.send(request);
    assert.deepEqual({ ok: result.ok, reason: result.ok ? null : result.reason }, { ok: false, reason: "unavailable" });
    assert.equal(terminal.writes.length, 0, "nothing reached the terminal");
    const failed = materials.handoff(request.id).delivery;
    assert.equal(failed.state, "failed");
    assert.equal(failed.stateSaved, false);
    assert.notEqual(failed.error, null);
    assert.deepEqual(await handoffs.send(request), { ok: false, reason: "already-sent" });
    await rm(blocked, { recursive: true });
    terminal.tui = claudeTui(terminal);
    assert.equal((await handoffs.send(draft("s1"))).handoff.delivery.state, "submitted");
  });
});

test("a delivered handoff says when the outcome could not be saved", async () => {
  await withHandoffs(async ({ handoffs, terminal, draft, packages }) => {
    terminal.add({ provider: "claude", id: "s1" });
    terminal.tui = claudeTui(terminal);
    const blocked = join(packages, "..", "state.json.tmp");
    const deliverInput = terminal.deliverInput.bind(terminal);
    terminal.deliverInput = async (id, data) => {
      if (data === "\r") await mkdir(blocked, { recursive: true });
      return deliverInput(id, data);
    };
    const result = await handoffs.send(draft("s1"));
    assert.equal(result.ok, true);
    assert.equal(result.handoff.delivery.state, "submitted");
    assert.equal(result.handoff.delivery.stateSaved, false);
    assert.equal(terminal.writes.length > 0, true, "the terminal did receive the package");
    await rm(blocked, { recursive: true });
  });
});
