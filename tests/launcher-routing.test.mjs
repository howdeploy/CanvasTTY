import assert from 'node:assert/strict';
import test from 'node:test';
import { launchOptions, reconcileLaunchDraft, compatibleLaunchAccounts } from '../src/renderer/src/features/launcher/launchDraft.ts';
import { accountRouteBinding } from '../src/shared/providerAccountPolicy.ts';
import { SessionLaunchPolicy } from '../src/main/services/SessionLaunchPolicy.ts';
import { TerminalManager } from '../src/main/services/TerminalManager.ts';
const defaults={lastDirectory:process.cwd(),defaultDataClass:'D0',pathPolicies:[],providerAccounts:[],apiProfiles:[],remoteHosts:[],containerProfiles:[],requiresSandboxProfiles:[],maxAccountsPerProviderPerHost:1,agentBudgets:{maxLocalAgents:4,maxRemoteAgentsPerHost:4,maxChildren:4,maxDepth:2}};
const account={id:'a',label:'Account',provider:'codex',hostId:'server',binding:{kind:'cli-home',directory:'/remote/fake-home'}};
const host={id:'server',label:'Server',sshHost:'fake.invalid',workspaces:[{localPath:process.cwd(),remotePath:'/srv/source'}]};
test('ordinary typed launch preserves explicit account/model/fixed host and task class to the real manager',()=>{
 const settings={...defaults,providerAccounts:[account],remoteHosts:[host]};
 const draft={...reconcileLaunchDraft(null,'codex',settings),accountId:'a',model:'model-a',dataClass:'D1',profile:'yolo'};
 const options=launchOptions(draft,settings);
 assert.equal(options.accountId,'a');assert.equal(options.hostId,'server');assert.equal(options.cwd,process.cwd());assert.equal(options.dataClass,'D1');
 const calls=[];const registry={get:provider=>({state:'available',provider,executable:'/fake/codex',launcher:'native',environment:{PATH:'/usr/bin'},checked:[]})};
 const terminals=new TerminalManager(()=>{},registry,undefined,undefined,true,(command,args)=>{calls.push({command,args});return {pid:1,write(){},kill(){},resize(){},pause(){},resume(){},onData(){return {dispose(){}}},onExit(){return {dispose(){}}}};});
 terminals.configureRemoteHosts(id=>settings.remoteHosts.find(h=>h.id===id));terminals.configureLaunchPolicy(new SessionLaunchPolicy(()=>settings));
 const session=terminals.create({...options,position:{x:0,y:0}});
 assert.equal(session.accountId,'a');assert.equal(session.model,'model-a');assert.equal(session.hostId,'server');assert.equal(session.dataClass,'D1');assert.equal(session.profile,'yolo');assert.equal(calls.length,1);terminals.disposeAll();
});
test('settings handoff and a changed last folder preserve the pending launch; a new provider starts its own draft',()=>{
 const draft={...reconcileLaunchDraft(null,'codex',defaults),cwd:'/chosen',accountId:'a',model:'custom',profile:'yolo',isolation:'worktree',ref:'branch',dataClass:'D2'};
 assert.equal(reconcileLaunchDraft(draft,'codex',{...defaults,lastDirectory:'/new-default'}),draft);
 assert.equal(reconcileLaunchDraft(draft,null,defaults),null);
 assert.equal(reconcileLaunchDraft(draft,'kimi',defaults).accountId,'');
});
test('an invalid explicit selection never becomes ambient and unsupported route changes retain draft errors',()=>{
 const settings={...defaults,providerAccounts:[account],remoteHosts:[host]};const draft={...reconcileLaunchDraft(null,'codex',settings),accountId:'a'};
 assert.throws(()=>launchOptions({...draft,accountId:''},settings),/Choose.*account/i);
 assert.throws(()=>launchOptions({...draft,accountId:'gone'},settings),/not configured/i);
 assert.throws(()=>launchOptions({...draft,isolation:'worktree'},settings),/local/i);
 assert.throws(()=>launchOptions({...draft,transport:'acp'},settings),/ACP/i);
 assert.equal(draft.accountId,'a');assert.equal(launchOptions(reconcileLaunchDraft(null,'codex',defaults),defaults).accountId,undefined);
});
test('explicit classification remains subject to path ordering at the real launch policy boundary',()=>{
 const policy=new SessionLaunchPolicy(()=>({...defaults,pathPolicies:[{pattern:'**',dataClass:'D2'},{pattern:'*',dataClass:'D0'}]}),{repositoryRoot:()=>process.cwd()});
 const options=launchOptions({...reconcileLaunchDraft(null,'codex',defaults),dataClass:'D0'},defaults);
 assert.throws(()=>policy.check(options,[]),/D2/);
});
test('ACP and worktree choices retain all typed routing fields',()=>{
 const local={...account,provider:'kimi',hostId:'local',binding:{kind:'cli-home',directory:'/tmp/fake-home'}};
 const settings={...defaults,providerAccounts:[local]};
 const draft={...reconcileLaunchDraft(null,'kimi',settings),accountId:'a',transport:'acp',isolation:'worktree',ref:'base',profile:'yolo',model:'kimi-model',dataClass:'D1'};
 const options=launchOptions(draft,settings);
 assert.deepEqual(options,{provider:'kimi',cwd:process.cwd(),profile:'yolo',transport:'acp',accountId:'a',model:'kimi-model',dataClass:'D1',isolation:{mode:'worktree',ref:'base'},context:{enabled:false}});
 const changed={...settings,providerAccounts:[{...local,models:[]}]};
 assert.throws(()=>launchOptions(draft,changed),/model/);
 assert.equal(draft.accountId,'a');assert.equal(draft.model,'kimi-model');
});
test('ambient local class preview uses the same provider cap as runtime',()=>{
 const settings={...defaults,defaultDataClass:'D2'};
 assert.throws(()=>launchOptions(reconcileLaunchDraft(null,'codex',settings),settings),/at most D1.*D2/);
});

test('selected-file launch uses the prepared class and capsule identity and rejects unprepared drafts', () => {
 const profile = { id: 'image', hostId: 'local', commands: { opencode: '/usr/bin/opencode' } };
 const api = { id: 'backend', name: 'Backend', protocol: 'openai-compatible', baseUrl: 'https://api.example/v1', secretRef: 'OPENAI_API_KEY' };
 const a = { id: 'api', label: 'API', provider: 'opencode', binding: { kind: 'api-profile', profileId: api.id } };
 a.assessment = { profile: { training: 'may-train', retention: 'persistent', thirdPartyProcessing: 'unknown', contractualMode: 'api' }, evidence: { kind: 'user-attested', reviewedAt: '2026-09-21', models: '*', sources: [], note: 'Synthetic fixture', binding: accountRouteBinding(a, [api]) } };
 const settings = { ...defaults, defaultDataClass: 'D2', providerAccounts: [a], apiProfiles: [api], containerProfiles: [profile] };
 const capsule = { files: ['code.ts'], task: 'Fix code', prepared: { id: '00000000-0000-4000-8000-000000000001', dataClass: 'D1' }, capturedInput: JSON.stringify([process.cwd(), ['code.ts'], 'Fix code', 'D1']) };
 const draft = { ...reconcileLaunchDraft(null, 'opencode', settings), isolation: 'container', accountId: a.id, containerProfileId: profile.id, dataClass: 'D1', capsule };
 assert.equal(launchOptions(draft, settings).isolation.capsuleId, capsule.prepared.id);
 assert.equal(launchOptions(draft, settings).dataClass, 'D1');
 assert.throws(() => launchOptions({ ...draft, capsule: { ...capsule, prepared: undefined } }, settings), /captur|prepar/i);
 assert.throws(() => launchOptions({ ...draft, cwd: '/changed' }, settings), /captur|prepar/i);
 assert.throws(() => launchOptions({ ...draft, capsule: { ...capsule, prepared: { ...capsule.prepared, dataClass: 'D2' } } }, settings), /D2/);
 assert.equal(reconcileLaunchDraft(draft, 'opencode', settings), draft);
});

test('remote API account appears only for its own configured container host', () => {
 const api = { id: 'backend', name: 'Backend', protocol: 'openai-compatible', baseUrl: 'https://api.example/v1', hostId: 'server', remoteCredential: { kind: 'environment', name: 'OPENAI_API_KEY' } };
 const a = { id: 'api', label: 'API', provider: 'opencode', hostId: 'server', binding: { kind: 'api-profile', profileId: api.id } };
 const settings = { ...defaults, providerAccounts: [a], apiProfiles: [api], containerProfiles: [{ id: 'image', hostId: 'server', commands: { opencode: '/usr/bin/opencode' } }] };
 const draft = { ...reconcileLaunchDraft(null, 'opencode', settings), isolation: 'container', containerProfileId: 'image' };
 assert.equal(compatibleLaunchAccounts(draft, settings)[0]?.id, 'api');
 assert.equal(compatibleLaunchAccounts({ ...draft, isolation: 'direct' }, settings).length, 0);
});

function autoSettings() {
 const profiles = [{id:'local-image',hostId:'local',commands:{opencode:'/usr/bin/opencode'}},{id:'remote-image',hostId:'server',commands:{opencode:'/usr/bin/opencode'}}];
 const apis = ['local','server'].map(hostId=>({id:`api-${hostId}`,hostId,protocol:'openai-compatible',baseUrl:'https://fixture.invalid/v1',defaultModel:'fixture',...(hostId==='local'?{secretRef:'OPENAI_API_KEY'}:{remoteCredential:{kind:'environment',name:'FIXTURE_API_KEY'}})}));
 const accounts = apis.map(a=>({id:`account-${a.hostId}`,label:a.hostId,provider:'opencode',hostId:a.hostId,binding:{kind:'api-profile',profileId:a.id}}));
 return {...defaults,containerProfiles:profiles,apiProfiles:apis,providerAccounts:accounts,remoteHosts:[host]};
}
test('container auto draft considers fixed API accounts across hosts without choosing an arbitrary first account',()=>{
 const settings=autoSettings(),base=reconcileLaunchDraft(null,'opencode',settings);
 assert.equal(base.containerRoute,'fixed');
 const draft={...base,isolation:'container',containerRoute:'auto'};
 assert.deepEqual(compatibleLaunchAccounts(draft,settings).map(a=>a.id),['account-local','account-server']);
 const options=launchOptions(draft,settings);
 assert.deepEqual(options.containerPlacement,{});assert.equal(options.accountId,undefined);assert.equal(options.hostId,undefined);assert.equal(options.isolation,undefined);
 const restricted=launchOptions({...draft,accountId:'account-server',model:'chosen'},settings);
 assert.equal(restricted.accountId,'account-server');assert.equal(restricted.model,'chosen');assert.equal(restricted.hostId,undefined);
});
test('auto container draft rejects incompatible explicit constraints, capsules and ACP without silently switching',()=>{
 const settings=autoSettings(),draft={...reconcileLaunchDraft(null,'opencode',settings),isolation:'container',containerRoute:'auto'};
 assert.throws(()=>launchOptions({...draft,accountId:'removed'},settings),/account/i);
 assert.throws(()=>launchOptions({...draft,transport:'acp'},settings),/PTY|ACP/i);
 assert.throws(()=>launchOptions({...draft,capsule:{files:[],task:'fixture'}},settings),/capsule|selected/i);
 assert.throws(()=>launchOptions({...draft,containerRoute:'unknown'},settings),/route/i);
 assert.equal(launchOptions(draft,{...settings,containerProfiles:[]}).containerPlacement!==undefined,true,'main preview reports no eligible route; settings-only UI never claims engine availability');
});
test('fixed auto transitions and settings handoffs preserve explicit draft choices',()=>{
 const settings=autoSettings(),draft={...reconcileLaunchDraft(null,'opencode',settings),isolation:'container',containerRoute:'auto',containerProfileId:'remote-image',accountId:'account-server'};
 assert.equal(reconcileLaunchDraft(draft,'opencode',{...settings,lastDirectory:'/changed'}),draft);
 const fixed=launchOptions({...draft,containerRoute:'fixed'},settings);
 assert.deepEqual(fixed.isolation,{mode:'container',profileId:'remote-image'});assert.equal(fixed.hostId,'server');assert.equal(fixed.containerPlacement,undefined);
 const local=launchOptions({...draft,isolation:'direct',accountId:'account-local'},settings);
 assert.deepEqual(local.isolation,{mode:'direct'});assert.equal(local.containerPlacement,undefined);
});

test('launcher forwards literal task and scoped context, retains drafts and enforces mandatory D2', () => {
 const a = { id:'private', label:'Private', provider:'claude', binding:{kind:'cli-home',directory:process.cwd()} };
 a.assessment = {profile:{training:'none',retention:'bounded',thirdPartyProcessing:'no',contractualMode:'business'},evidence:{kind:'user-attested',reviewedAt:new Date().toISOString().slice(0,10),sources:[],note:'Fixture account assessment',binding:accountRouteBinding(a),models:'*'}};
 const settings = {...defaults,contextProfilesEnabled:true,providerAccounts:[a]};
 const task = '  ! /command $(literal)\nРусский  ';
 const current = [{category:'design',key:'button.text',value:'Белый',dataClass:'D2'}];
 const draft = {...reconcileLaunchDraft(null,'claude',settings),accountId:a.id,initialPrompt:task,contextTaskId:'task-a',contextCategories:['design'],currentContext:current};
 const options = launchOptions(draft,settings);
 assert.equal(options.initialPrompt,task); assert.equal(options.dataClass,'D2');
 assert.deepEqual(options.context,{enabled:true,taskId:'task-a',categories:['design'],current});
 assert.equal(reconcileLaunchDraft(draft,'claude',{...settings,lastDirectory:'/different'}),draft);
 assert.deepEqual(launchOptions({...draft,contextEnabled:false},settings).context,{enabled:false});
 assert.deepEqual(launchOptions(draft,{...settings,contextProfilesEnabled:false}).context,{enabled:false});
 assert.throws(()=>launchOptions({...reconcileLaunchDraft(null,'cursor',defaults),initialPrompt:'task'},defaults),/D2/);
 assert.throws(()=>launchOptions({...draft,currentContext:[...current,...current]},settings),/Duplicate/);
});
