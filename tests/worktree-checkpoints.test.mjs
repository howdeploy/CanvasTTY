import assert from "node:assert/strict";
import {mkdtemp,readFile,readdir,rm,writeFile,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import test from "node:test";
import {GitCheckpoints} from "../src/main/services/GitCheckpoints.ts";
import {createHash} from "node:crypto";
const exec=promisify(execFile);
const temp=()=>mkdtemp(join(tmpdir(),"canvastty-checkpoint-test-"));

test("git checkpoints leave staged and unstaged edits intact, preview and restore both; retention prunes old captures safely",async()=>{
  const dir=await temp();const git=(...args)=>exec("git",["-C",dir,...args]);try {
    await git("init");await git("config","user.name","Test");await git("config","user.email","test@example.invalid");await git("config","core.autocrlf","false");
    await writeFile(join(dir,"file.txt"),"base\n");await git("add","file.txt");await git("commit","-m","base");
    await writeFile(join(dir,"file.txt"),"staged\n");await git("add","file.txt");await writeFile(join(dir,"file.txt"),"unstaged\n");
    const before=(await git("diff","--cached")).stdout;const checkpoints=new GitCheckpoints(text=>text);
    await checkpoints.capture("session",dir);assert.equal((await git("diff","--cached")).stdout,before);assert.equal(await readFile(join(dir,"file.txt"),"utf8"),"unstaged\n");
    const saved=(await checkpoints.list("session",dir))[0];await writeFile(join(dir,"file.txt"),"later\n");
    await git("update-ref",saved.id,"HEAD");
    const forged="refs/canvastty/session/9999999999999-agent-forged";
    await git("update-ref",forged,"HEAD");
    assert.equal((await checkpoints.list("session",dir)).some(entry=>entry.id===forged),false);
    await assert.rejects(checkpoints.preview("session",dir,forged),/does not belong/);
    assert.match((await checkpoints.preview("session",dir,saved.id)).text,/later/);
    await git("update-ref",saved.id,"HEAD");
    await checkpoints.restore("session",dir,saved.id);assert.equal(await readFile(join(dir,"file.txt"),"utf8"),"unstaged\n");assert.equal((await git("diff","--cached")).stdout,before);
    await assert.rejects(checkpoints.preview("foreign",dir,saved.id),/does not belong/);
    const nongit=join(dir,"plain");await mkdir(nongit);assert.equal(await checkpoints.available(nongit),false);
    await checkpoints.capture("other",dir);
    const other=(await checkpoints.list("other",dir))[0];
    const first=(await checkpoints.list("session",dir))[0];
    for(let index=0;index<51;index++)await checkpoints.capture("session",dir);
    const retained=await checkpoints.list("session",dir);
    assert.equal(retained.length,50);assert.equal(retained.some(row=>row.id===first.id),false);
    await assert.rejects(git("rev-parse","--verify",first.id));
    assert.equal((await checkpoints.list("other",dir))[0].id,other.id);
    assert.equal(await readFile(join(dir,"file.txt"),"utf8"),"unstaged\n");
    assert.equal((await git("diff","--cached")).stdout,before);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("rollback points are listed with their kind, and a restore first saves the current work as a before-restore point", async (t) => {
  const run = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), "ctty-checkpoint-kind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => run("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { env });
  await git("init", "-q"); await writeFile(join(root, "file.txt"), "one\n"); await git("add", "file.txt"); await git("commit", "-qm", "base");
  const checkpoints = new GitCheckpoints((text) => text, 50, join(root, ".app", "checkpoints.json"));
  await writeFile(join(root, "file.txt"), "two\n");
  await checkpoints.capture("session", root);
  const [point] = await checkpoints.list("session", root);
  assert.equal(point.kind, "before-turn");
  assert.equal(Object.hasOwn(point, "label"), false, "no main-process text reaches the dialog");
  await writeFile(join(root, "file.txt"), "three\n");
  assert.deepEqual(await checkpoints.restore("session", root, point.id), { ok: true });
  assert.equal(await readFile(join(root, "file.txt"), "utf8"), "two\n");
  const kinds = (await checkpoints.list("session", root)).map((entry) => entry.kind);
  assert.deepEqual(kinds.sort(), ["before-restore", "before-turn"]);
  await assert.rejects(checkpoints.preview("session", root, "refs/canvastty/session/1-00000000-0000-0000-0000-000000000000"),
    (error) => error.code === "unknown-checkpoint");
});
