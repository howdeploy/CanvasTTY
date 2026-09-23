import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskCapsuleService } from '../src/main/services/TaskCapsuleService.ts';
import { CapsuleLaunchService } from '../src/main/services/CapsuleLaunchService.ts';
import { ContextProfileStore } from '../src/main/services/ContextProfileStore.ts';

async function fixture(t, files = { 'theme.css': '.old { color: #000000; }\n.new { color: #ffffff; }\n' }) {
  const { ConventionValidatorService } = await import('../src/main/services/ConventionValidatorService.ts');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ct-conventions-'))), source = join(root, 'source'); await mkdir(source);
  t.after(() => rm(root, { recursive: true, force: true })); execFileSync('git', ['-C', source, 'init'], { stdio: 'pipe' });
  for (const [path, text] of Object.entries(files)) await writeFile(join(source, path), text);
  const settings = { defaultDataClass: 'D2', pathPolicies: [] }, store = new ContextProfileStore(join(root, 'context'), () => settings.pathPolicies);
  const state = await store.saveProject({ label: 'Test', root: source }, 0), projectId = state.projects[0].id;
  const capsules = new CapsuleLaunchService(new TaskCapsuleService({ rootDirectory: join(root, 'capsules') }), () => settings);
  const capsule = await capsules.prepare({ sourceCwd: source, files: Object.keys(files), task: { text: 'Check changes', dataClass: 'D2' } });
  const service = new ConventionValidatorService(capsules, store);
  const enable = async (enabled = true) => store.saveProject({ ...store.get().projects[0], validationEnabled: enabled }, store.get().revision);
  const rule = async (value, extra = {}) => store.saveRule({ scope: 'project', ownerId: projectId, category: 'design', key: 'validate.color', tags: [], enabled: true, dataClass: 'D2', value, ...extra }, store.get().revision);
  const run = async (clearance = 'D3') => { const review = await capsules.review(capsule.id); return service.run(capsule.id, review.reviewId, clearance); };
  return { root, source, settings, store, projectId, capsules, capsule, service, enable, rule, run };
}
test('disabled validation performs no snapshot, import capture or analysis', async t => {
  const f = await fixture(t); let reads = 0;
  f.capsules.conventionSnapshot = async () => { reads++; throw Error('snapshot'); }; f.store.capture = () => { reads++; throw Error('imports'); };
  const result = await f.service.run(f.capsule.id, '00000000-0000-4000-8000-000000000001', 'D2'); assert.equal(result.state, 'disabled'); assert.equal(reads, 0);
});
test('trusted changed lines ignore old violations and report exact CRLF Unicode text coordinates', async t => {
  const f = await fixture(t); await f.enable(); await f.rule({ kind: 'forbidden-colors', colors: ['#000000'] });
  await writeFile(join(f.capsule.directory, 'theme.css'), '.old { color: #000000; }\r\n/* привет +++ b/fake.css */\r\n.new { color: #000000; }\r\n');
  const r = await f.run(); assert.equal(r.warnings.length, 1); assert.equal(r.warnings[0].path, 'theme.css'); assert.equal(r.warnings[0].line, 3); assert.equal(r.state, 'complete');
});
test('only simple same-block pairs match; comments, strings and nested CSS produce no invented match', async t => {
  const f = await fixture(t, { 'theme.css': '' }); await f.enable(); await f.rule({ kind: 'forbidden-pair', foreground: '#000000', background: '#ffffff' });
  await writeFile(join(f.capsule.directory, 'theme.css'), '.a { color: #000000; }\n.b { background-color: #ffffff; }\n.c { color: #000000; background-color: #ffffff; }\n/* .d { color: #000000; background-color:#ffffff; } */\n.e { content: "color:#000000;background-color:#ffffff"; }\n@media all { .f { color:#000000; background-color:#ffffff; } }');
  const r = await f.run(); assert.equal(r.warnings.length, 1); assert.equal(r.warnings[0].line, 3); assert.ok(r.diagnostics.some(d => d.code === 'unsupported-css'));
});
test('binary and deleted files and changes without new lines have honest coverage', async t => {
  const f = await fixture(t, { 'theme.css': '.a { color: #000000; }\n.b { color: #000000; }\n', 'binary.css': Buffer.from([0, 1]), 'gone.css': 'x' }); await f.enable(); await f.rule({ kind: 'forbidden-colors', colors: ['#000000'] });
  await writeFile(join(f.capsule.directory, 'theme.css'), '.a { color: #000000; }\n'); await writeFile(join(f.capsule.directory, 'binary.css'), Buffer.from([0,2])); await rm(join(f.capsule.directory, 'gone.css'));
  const r = await f.run(); assert.equal(r.warnings.length,0); assert.ok(r.diagnostics.some(d=>d.code==='binary')); assert.ok(r.diagnostics.some(d=>d.code==='deleted')); assert.ok(r.coverage.some(c=>c.path==='theme.css'&&c.changedLines===0));
});
test('source context and classification changes invalidate current reports', async t => {
  const f = await fixture(t); await f.enable(); await f.rule({ kind:'forbidden-colors', colors:['#000000'] });
  await writeFile(join(f.capsule.directory,'theme.css'), '.a { color:#000000; }');
  let r=await f.run(); assert.equal((await f.service.current(r.id)).id,r.id);
  await f.rule({ kind:'forbidden-colors', colors:['#ffffff'] }); await assert.rejects(f.service.current(r.id),/changed|revision/);
  r=await f.run(); f.settings.pathPolicies=[{pattern:'theme.css',dataClass:'D3'}]; await assert.rejects(f.service.current(r.id),/policy|changed/);
  r=await f.run(); await writeFile(join(f.source,'theme.css'),'source changed'); await assert.rejects(f.service.current(r.id),/changed|source/i);
});
test('multiline color and pair checks locate a changed value line', async t => {
  const f = await fixture(t, { 'theme.css': '.a {\n color:\n #ffffff;\n background-color: #ffffff;\n}\n' }); await f.enable(); await f.rule({ kind:'forbidden-colors',colors:['#000000'] }); await f.rule({kind:'forbidden-pair',foreground:'#000000',background:'#ffffff'},{key:'validate.pair'});
  await writeFile(join(f.capsule.directory,'theme.css'),'.a {\n color:\n #000000;\n background-color: #ffffff;\n}\n'); const r = await f.run(); assert.equal(r.warnings.length,2); assert.deepEqual(r.warnings.map(w=>w.line),[3,3]);
});
test('repeated lines, Unicode filenames and patch-looking text never redirect coordinates', async t => {
  const f=await fixture(t,{'тема цвета.css':'.same { color:#000000; }\n.same { color:#000000; }\n.end { color:#ffffff; }\n'}); await f.enable(); await f.rule({kind:'forbidden-colors',colors:['#000000']});
  await writeFile(join(f.capsule.directory,'тема цвета.css'),'.same { color:#000000; }\n/* @@ -1,8 +666,3 @@ +++ b/evil.css */\n.same { color:#000000; }\n.end { color:#000000; }\n'); const r=await f.run(); assert.deepEqual(r.warnings.map(w=>[w.path,w.line]),[['тема цвета.css',4]]);
});
test('literal formatter requirements report newly changed values and never execute configs', async t=>{
  const f=await fixture(t,{'.prettierrc.yaml':'semi: true\nprintWidth: 80\n','.prettierrc.js':'throw new Error("never execute");\n'}); await f.enable(); await f.rule({kind:'formatter-config',file:'.prettierrc.yaml',required:{semi:true,printWidth:100}},{category:'code-style'});
  await writeFile(join(f.capsule.directory,'.prettierrc.yaml'),"'semi': false\nprintWidth: 80\n"); await writeFile(join(f.capsule.directory,'.prettierrc.js'),'process.exit(42);'); let r=await f.run(); assert.equal(r.warnings.length,1);assert.equal(r.warnings[0].line,1);assert.ok(r.diagnostics.some(d=>d.code==='executable-config'));
  await writeFile(join(f.capsule.directory,'.prettierrc.yaml'),'semi: false\nsemi: true\n'); r=await f.run();assert.equal(r.warnings.length,0);assert.ok(r.diagnostics.some(d=>d.code==='unsupported-config'));
});
test('package constraints cover only changed entries in selected sections with bounded static mappings',async t=>{
  const before={dependencies:{old:'1',allowed:'1'},devDependencies:{forbidden:'1'},keywords:['normal'],workspaces:['packages/*']};
  const f=await fixture(t,{'package.json':JSON.stringify(before,null,2)});await f.enable();await f.rule({kind:'dependencies',section:'dependencies',allow:['allowed']},{category:'dependencies'});
  const after={dependencies:{old:'1',allowed:'2',new:'1'},devDependencies:{forbidden:'2'},keywords:['normal'],workspaces:['packages/*']};await writeFile(join(f.capsule.directory,'package.json'),JSON.stringify(after,null,2));let r=await f.run();assert.equal(r.warnings.length,1);assert.match(r.warnings[0].message,/new/);assert.equal(r.warnings[0].line,5);
  await writeFile(join(f.capsule.directory,'package.json'),JSON.stringify({dependencies:Object.fromEntries(Array.from({length:65},(_,i)=>['pkg'+i,'1']))}));r=await f.run();assert.equal(r.warnings.length,0);assert.ok(r.diagnostics.some(d=>d.code==='unsupported-package'));
});
test('invalid vocabularies, executable targets and regexp filename shapes are scoped diagnostics',async t=>{
  const f=await fixture(t,{'bad_name.ts':'one'});await f.enable();await f.rule({kind:'filename',extension:'ts',style:'kebab-case'},{key:'validate.names',category:'naming'});await f.rule({kind:'filename',extension:'ts',style:'regex',pattern:'.*'},{key:'validate.regex'});await f.rule({kind:'formatter-config',file:'.prettierrc.js',required:{semi:true}},{key:'validate.script'});
  await writeFile(join(f.capsule.directory,'bad_name.ts'),'two');const r=await f.run();assert.equal(r.warnings.length,0);assert.equal(r.diagnostics.filter(d=>d.code==='invalid-rule').length,2);assert.ok(r.diagnostics.some(d=>d.code==='existing-filename'));
});
test('hidden specific winners do not revive public fallbacks or leak names and source content',async t=>{
  const f=await fixture(t);await f.enable();f.settings.defaultDataClass='D0';await f.rule({kind:'forbidden-colors',colors:['#000000']},{scope:'user',ownerId:undefined,dataClass:'D0'});await f.rule({kind:'forbidden-colors',colors:['#ffffff']},{dataClass:'D3'});await f.rule({kind:'unknown-private-kind',private:'private-value'},{key:'validate.private',dataClass:'D3'});
  await writeFile(join(f.capsule.directory,'theme.css'),'.a { color:#000000; }');let r=await f.run('D0');assert.equal(r.warnings.length,0);assert.doesNotMatch(JSON.stringify(r),/private-value|validate.private|unknown-private-kind/);
  f.settings.pathPolicies=[{pattern:'theme.css',dataClass:'D3'}];r=await f.run('D0');assert.equal(r.coverage.length,0);assert.doesNotMatch(JSON.stringify(r),/theme.css|#000000/);assert.ok(r.diagnostics.some(d=>d.code==='clearance'));
});
test('learned validator rules obey actual project threshold and explicit acceptance',async t=>{
  const f=await fixture(t);await f.enable();await f.store.saveLearning(f.projectId,{enabled:true,autoApply:true,threshold:.85,advisoryThreshold:.6},f.store.get().revision);
  await f.store.captureFeedback({eventId:'one',projectId:f.projectId,kind:'correction',category:'design',key:'validate.learned',value:{kind:'forbidden-colors',colors:['#000000']}},f.store.get().revision);
  await writeFile(join(f.capsule.directory,'theme.css'),'.a { color:#000000; }');assert.equal((await f.run()).warnings.length,0);const candidate=f.store.get().feedback.candidates[0];await f.store.feedbackAction({kind:'accept',id:candidate.id},f.store.get().revision);let r=await f.run();assert.equal(r.warnings.length,1);assert.equal(r.warnings[0].source,'inferred');
  await f.store.saveLearning(f.projectId,{enabled:false,autoApply:true,threshold:.85,advisoryThreshold:.6},f.store.get().revision);await assert.rejects(f.service.current(r.id),/revision|changed/);assert.equal((await f.run()).warnings.length,0);
});
test('live imported context and unchanged selected source edits invalidate previous reports',async t=>{
  const f=await fixture(t,{'theme.css':'a','other.ts':'unchanged'});await f.enable();await f.rule({kind:'forbidden-colors',colors:['#000000']});await writeFile(join(f.source,'AGENTS.md'),'literal context');await f.store.saveProject({...f.store.get().projects[0],importsEnabled:true,imports:[{kind:'instructions',path:'AGENTS.md'}]},f.store.get().revision);
  await writeFile(join(f.capsule.directory,'theme.css'),'.a { color:#000000; }');let r=await f.run();await writeFile(join(f.source,'AGENTS.md'),'new context');await assert.rejects(f.service.current(r.id),/source changed/);r=await f.run();await writeFile(join(f.source,'other.ts'),'changed');await assert.rejects(f.service.current(r.id),/source changed/);
});
test('agent validation requires exact owner and generation, with no caller clearance override',async t=>{
  const {ScopedCapsuleControl}=await import('../src/main/services/ScopedCapsuleControl.ts'); const f=await fixture(t);await f.enable();await f.rule({kind:'forbidden-colors',colors:['#000000']});
  let generation='00000000-0000-4000-8000-000000000009';const parent='00000000-0000-4000-8000-000000000008';const terminals={capsuleAuthority(id){if(id!==parent)throw Error('owner');return{generation,binding:'bound',cwd:f.source,dataClass:'D2'}}};const scoped=new ScopedCapsuleControl(terminals,{},f.capsules,undefined,f.service);const owned=await f.capsules.prepareForParent(parent,['theme.css'],'task');await writeFile(join(owned.directory,'theme.css'),'.a {color:#000000;}');const review=await f.capsules.review(owned.id),args={capsuleId:owned.id,reviewId:review.reviewId};
  await assert.rejects(scoped.execute(parent,'validate_capsule_conventions',{...args,maxDataClass:'D3'}),/unknown|unexpected|Invalid/i);await assert.rejects(scoped.execute('foreign','validate_capsule_conventions',args),/authorized/);const r=await scoped.execute(parent,'validate_capsule_conventions',args);assert.equal(r.warnings.length,1);generation='00000000-0000-4000-8000-000000000010';await assert.rejects(scoped.execute(parent,'validate_capsule_conventions',args),/authorized/);await assert.rejects(f.service.current(r.id),/authorized/);
});
test('multiline JSON configuration and dependency values report the changed scalar line', async t=>{
  const f=await fixture(t,{'.prettierrc.json':'{\n"semi":\ntrue\n}\n','package.json':'{\n"dependencies":{\n"forbidden":\n"1"\n}\n}\n'});await f.enable();await f.rule({kind:'formatter-config',file:'.prettierrc.json',required:{semi:true}},{key:'validate.formatter',category:'code-style'});await f.rule({kind:'dependencies',section:'dependencies',deny:['forbidden']},{key:'validate.deps',category:'dependencies'});
  await writeFile(join(f.capsule.directory,'.prettierrc.json'),'{\n"semi":\nfalse\n}\n');await writeFile(join(f.capsule.directory,'package.json'),'{\n"dependencies":{\n"forbidden":\n"2"\n}\n}\n');const r=await f.run();assert.deepEqual(r.warnings.map(w=>[w.path,w.line]).sort(),[['.prettierrc.json',3],['package.json',4]]);
});
test('new comments between unchanged CSS property and literal do not turn an old violation into a warning', async t=>{
  const f=await fixture(t,{'theme.css':'.a {\n color:\n #000000;\n}\n'});await f.enable();await f.rule({kind:'forbidden-colors',colors:['#000000']});await writeFile(join(f.capsule.directory,'theme.css'),'.a {\n color:\n /* new comment */\n #000000;\n}\n');const r=await f.run();assert.equal(r.warnings.length,0);
});
test('aggregate quadratic comparisons and findings have explicit bounded partial coverage',async()=>{
  const {checkConventions}=await import('../src/main/services/ConventionChecks.ts');
  const files=Array.from({length:128},(_,i)=>({path:`file${i}.txt`,before:Buffer.from(('a\n').repeat(998)),after:Buffer.from(('b\n').repeat(998))}));let result=checkConventions(files,[]);assert.equal(result.truncated,true);assert.ok(result.coverage.length<=4);assert.ok(result.diagnostics.some(d=>d.code==='line-bound'));
  const rule={id:'rule',scope:'user',category:'design',key:'validate.color',value:{kind:'forbidden-colors',colors:['#000000']},tags:[],dataClass:'D2',source:'explicit',confidence:1,enabled:true,updatedAt:0};result=checkConventions([{path:'many.css',before:Buffer.from(''),after:Buffer.from('.a {color:#000000;}\n'.repeat(400))}],[rule]);assert.equal(result.warnings.length,128);assert.equal(result.truncated,true);
});
