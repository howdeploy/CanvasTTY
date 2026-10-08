import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { OrchestrationTemplateService } from '../src/main/services/OrchestrationTemplateService.ts';
import { AgentControlService } from '../src/main/services/AgentControlService.ts';
import { ScopedOrchestrationHandler } from '../src/main/services/agent-browser/OrchestrationTools.ts';
import { TerminalManager } from '../src/main/services/TerminalManager.ts';
import { availableRegistry, fakeSpawner } from './helpers/terminal.mjs';

test('agent-written project flows cannot become instructions without host approval of that exact content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ctty-flow-approval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), store = join(root, 'private', 'flow-approvals.json');
  await mkdir(project);
  const service = new OrchestrationTemplateService(store);
  const input = { id: 'custom', name: 'Custom', description: 'Workflow', finalStep: 'Finish',
    roles: [{ id: 'worker', title: 'Work', instruction: 'Implement the request.', count: 1 }] };
  const path = await service.save(project, input);
  let flow = (await service.list(project)).templates.find(row => row.id === 'custom');
  assert.throws(() => service.instructions(flow), /approval/u);
  const preview = await service.preview(project, 'custom');
  await service.approve(project, 'custom', preview.digest);
  flow = (await service.list(project)).templates.find(row => row.id === 'custom');
  assert.match(service.instructions(flow), /Implement the request/u);
  const restartedBeforeEdit = new OrchestrationTemplateService(store);
  const persistedFlow = (await restartedBeforeEdit.list(project)).templates.find(row => row.id === 'custom');
  assert.match(restartedBeforeEdit.instructions(persistedFlow), /Implement the request/u);
  assert.throws(() => service.instructions({ ...flow, trusted: true }), /approval/u, 'a forged trust flag is insufficient');
  await writeFile(path, (await readFile(path, 'utf8')).replace('Implement the request.', 'AGENT-CHANGED-INSTRUCTIONS'));
  flow = (await service.list(project)).templates.find(row => row.id === 'custom');
  assert.throws(() => service.instructions(flow), /approval/u);
  await assert.rejects(service.approve(project, 'custom', preview.digest), /changed/u);
  const restarted = new OrchestrationTemplateService(store);
  assert.throws(() => restarted.instructions(flow), /approval/u);
  const builtIn = (await restarted.list(project)).templates.find(row => row.builtIn);
  assert.match(restarted.instructions(builtIn), /User task/u);
});

test('the authenticated agent template tools hide unapproved prompts and reject apply after edits', async t => {
  const root=await mkdtemp(join(tmpdir(),'ctty-flow-tool-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const service=new OrchestrationTemplateService(join(root,'private','flow-approvals.json'));
  const project=join(root,'project');await mkdir(project);
  const path=await service.save(project,{id:'custom',name:'Custom',description:'Workflow',finalStep:'Finish',
    roles:[{id:'worker',title:'Work',instruction:'UNAPPROVED-PROMPT-SENTINEL',count:1}]});
  const terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner([]));
  t.after(()=>terminals.disposeAll());
  const parent=terminals.create({provider:'codex',profile:'normal',cwd:project,position:{x:0,y:0},role:'orchestrator'});
  const handler=new ScopedOrchestrationHandler(new AgentControlService(terminals),null,undefined,{templates:service});
  const call=(tool,args={})=>handler.execute(parent.id,{id:'flow-test',tool,arguments:args});
  let listing=await call('list_orchestration_templates');assert.ok(!JSON.stringify(listing).includes('UNAPPROVED-PROMPT-SENTINEL'));
  await assert.rejects(call('apply_orchestration_template',{templateId:'custom',task:'A task'}),/approval/u);
  const preview=await service.preview(project,'custom');await service.approve(project,'custom',preview.digest);
  assert.match((await call('apply_orchestration_template',{templateId:'custom',task:'A task'})).instructions,/UNAPPROVED-PROMPT-SENTINEL/u);
  await writeFile(path,(await readFile(path,'utf8')).replace('UNAPPROVED-PROMPT-SENTINEL','EDITED-PROMPT-SENTINEL'));
  listing=await call('list_orchestration_templates');assert.ok(!JSON.stringify(listing).includes('EDITED-PROMPT-SENTINEL'));
  await assert.rejects(call('apply_orchestration_template',{templateId:'custom',task:'A task'}),/approval/u);
});

test('a trust record inside the project has no effect and approval cannot cross project roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ctty-flow-approval-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), other = join(root, 'other');
  await mkdir(project); await mkdir(other);
  const service = new OrchestrationTemplateService(join(root, 'private', 'flow-approvals.json'));
  const input = { id: 'custom', name: 'Custom', description: 'Workflow', finalStep: 'Finish',
    roles: [{ id: 'worker', title: 'Work', instruction: 'Same content.', count: 1 }] };
  await service.save(project, input); await service.save(other, input);
  const preview = await service.preview(project, 'custom');
  await service.approve(project, 'custom', preview.digest);
  await writeFile(join(other, '.canvastty', 'flow-approvals.json'), JSON.stringify({ custom: preview.digest }));
  const candidate = (await service.list(other)).templates.find(row => row.id === 'custom');
  assert.throws(() => service.instructions(candidate), /approval/u);
});
