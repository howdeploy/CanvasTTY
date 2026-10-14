import assert from "node:assert/strict";
import test from "node:test";
import { subagentWorktreeResolver } from "../src/main/services/SubagentWorktreeResolver.ts";

const request = { provider: "codex", parentSessionId: "root", projectRoot: "/trusted-project", cwd: "/trusted-project/src", liveChildren: 0 };
const provider = { pluginId: "environments", pluginName: "Environments", serviceId: "env", kinds: [{ kind: "worktree", label: "Worktree" }], secrets: false };

test("the first and subsequent workers choose separate worktrees from the trusted project", async () => {
  const roots = [];
  const resolve = subagentWorktreeResolver({
    isGitProject: async root => { roots.push(root); return true; },
    providers: () => [provider]
  });
  const choice = { pluginId: "environments", kind: "worktree" };
  assert.deepEqual(await resolve(request), choice);
  assert.deepEqual(await resolve({ ...request, liveChildren: 1 }), choice);
  assert.deepEqual(roots, [request.projectRoot, request.projectRoot]);
});

test("without a trusted worktree provider or Git project selection stays local", async () => {
  const unavailable = subagentWorktreeResolver({ isGitProject: async () => true, providers: () => [] });
  assert.equal(await unavailable({ ...request, isolate: "worktree" }), null);
  const noGit = subagentWorktreeResolver({ isGitProject: async () => false, providers: () => [provider] });
  assert.equal(await noGit({ ...request, isolate: "worktree" }), null);
});

for (const compatible of [true,false]) test(`worktree selection skips an incompatible first provider (${compatible?'compatible fallback':'local fallback'})`,async()=>{
 const restricted={...provider,pluginId:'claude-only',kinds:[{kind:'worktree',label:'Claude',appliesTo:['claude']}]};
 const second={...provider,pluginId:'codex-only',kinds:[{kind:'worktree',label:'Codex',appliesTo:['codex']}]};
 const resolve=subagentWorktreeResolver({isGitProject:async()=>true,providers:()=>compatible?[restricted,second]:[restricted]});
 assert.deepEqual(await resolve(request),compatible?{pluginId:'codex-only',kind:'worktree'}:null);
});

import { AgentControlService } from '../src/main/services/AgentControlService.ts';
import { TerminalManager } from '../src/main/services/TerminalManager.ts';
import { availableRegistry, fakeSpawner } from './helpers/terminal.mjs';

test('worktree resolution receives the child provider and incompatible auto launches stay local while explicit isolation refuses',async t=>{
 const terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner([]));t.after(()=>terminals.disposeAll());
 const parent=terminals.create({provider:'claude',profile:'normal',cwd:process.cwd(),role:'orchestrator',position:{x:0,y:0}});
 const seen=[],resolver=subagentWorktreeResolver({isGitProject:async()=>true,providers:()=>[{...provider,kinds:[{kind:'worktree',label:'Claude',appliesTo:['claude']}]}]});
 const control=new AgentControlService(terminals,{resolveSubagentEnvironment:input=>{seen.push(input);return resolver(input);}});
 const child=await control.spawn({parentSessionId:parent.id,provider:'codex',cwd:process.cwd()});
 assert.equal(seen[0].provider,'codex');assert.equal(child.environment,undefined);
 await assert.rejects(control.spawn({parentSessionId:parent.id,provider:'codex',cwd:process.cwd(),isolate:'worktree'}),/does not provide a worktree/u);
});

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGitProjectRoot } from '../src/main/services/SubagentWorktreeResolver.ts';

test('only the top of a Git working tree counts as a Git project', async t => {
 const root = await mkdtemp(join(tmpdir(), 'ctty-git-root-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const project = join(root, 'project'), inside = join(project, 'src'), plain = join(root, 'plain');
 await Promise.all([mkdir(inside, { recursive: true }), mkdir(plain)]);
 execFileSync('git', ['init', '-q', project], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
 assert.equal(await isGitProjectRoot(project), true);
 assert.equal(await isGitProjectRoot(inside), false, 'a folder inside a repository is not its top');
 assert.equal(await isGitProjectRoot(plain), false);
 assert.equal(await isGitProjectRoot(join(root, 'missing')), false);
});
