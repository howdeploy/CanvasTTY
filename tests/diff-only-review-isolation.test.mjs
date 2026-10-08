import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, realpathSync, symlinkSync, linkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, dirname, delimiter} from 'node:path';
import {createDiffOnlyReviewWorkspace, isHostOwnedDiffOnlyReviewWorkspace} from '../src/main/services/DiffOnlyReviewWorkspace.ts';
import {AgentIsolation, SANDBOX_EXEC} from '../src/main/services/isolation/AgentIsolation.ts';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {availableRegistry, fakeSpawner} from './helpers/terminal.mjs';
import {isolationPaths} from '../src/main/services/isolation/isolationPaths.ts';
import {prepareReviewerHome} from '../src/main/services/isolation/reviewerHome.ts';
import {pathToFileURL} from 'node:url';

test('diff review workspaces contain only a bounded read-only patch and reject forged paths', t => {
  const patch='diff --git a/a b/a\n+supplied patch\n';
  const workspace=createDiffOnlyReviewWorkspace(patch);
  t.after(()=>workspace.cleanup());
  assert.equal(isHostOwnedDiffOnlyReviewWorkspace(workspace),true);
  if(process.platform==='win32'){
    // Windows reports only the read-only attribute through the mode: no write bit on the patch or its folder.
    assert.equal(statSync(workspace.directory).mode & 0o222,0);
    assert.equal(statSync(workspace.diffPath).mode & 0o222,0);
  }else{
    assert.equal(statSync(workspace.directory).mode & 0o777,0o500);
    assert.equal(statSync(workspace.diffPath).mode & 0o777,0o400);
  }
  assert.equal(isHostOwnedDiffOnlyReviewWorkspace(workspace,'win32'),true,'the read-only attribute check accepts the host workspace');
  chmodSync(workspace.diffPath,0o600);
  assert.equal(isHostOwnedDiffOnlyReviewWorkspace(workspace),false,'a writable patch is no longer the host workspace');
  assert.equal(isHostOwnedDiffOnlyReviewWorkspace(workspace,'win32'),false,'a patch without the read-only attribute is rejected on Windows');
  chmodSync(workspace.diffPath,0o400);
  assert.equal(isHostOwnedDiffOnlyReviewWorkspace(workspace),true);
  assert.equal(existsSync(join(workspace.directory,'other.txt')),false);
  assert.equal(isHostOwnedDiffOnlyReviewWorkspace({directory:workspace.directory,diffPath:workspace.diffPath,cleanup(){}}),false);
  assert.throws(()=>createDiffOnlyReviewWorkspace('x'.repeat(64*1024+1)),/exceeds/u);
});

test('diff-only reviewer launch refuses to run when host OS isolation is unavailable', t => {
  const calls=[];
  const terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner(calls));
  t.after(()=>terminals.disposeAll());
  const project=mkdtempSync(join(tmpdir(),'ctty-review-unavailable-'));
  t.after(()=>rmSync(project,{recursive:true,force:true}));
  const parent=terminals.create({provider:'codex',profile:'normal',cwd:project,position:{x:0,y:0},role:'orchestrator'});
  const workspace=createDiffOnlyReviewWorkspace('supplied diff');
  t.after(()=>workspace.cleanup());
  assert.throws(()=>terminals.createReadOnlyReviewer({taskRootSessionId:parent.id,provider:'codex',model:'fixture-reviewer',title:'Review',workspace}),/Plan|isolation|containment/u);
  assert.equal(calls.length,1,'only the parent PTY may launch');
});

test('native macOS sandbox exposes review.diff, denies project reads, and blocks review workspace writes', {
  skip:process.platform!=='darwin'||process.env.CANVASTTY_TEST_NATIVE_SANDBOX!=='1'
}, t => {
  const root=mkdtempSync(join(tmpdir(),'ctty-review-native-'));
  const workspace=createDiffOnlyReviewWorkspace('SUPPLIED-DIFF-READABLE');
  t.after(()=>{workspace.cleanup();rmSync(root,{recursive:true,force:true});});
  const project=join(root,'project'),home=join(root,'home'),userData=join(root,'userdata'),isolationTemp=join(root,'isolation-temp');
  for(const path of [project,home,userData,isolationTemp])mkdirSync(path,{recursive:true});
  const sentinel=join(project,'forbidden-sentinel.txt'),writeProbe=join(workspace.directory,'forbidden-write.txt');
  const privateHomeFile=join(home,'other-repository','private-file.txt'),auth=join(home,'.codex','auth.json');
  const fixtureToken=['FIXTURE','PROVIDER','AUTH'].join('-');
  const alias=join(root,'home-alias'),runtimeFile=join(project,'host-runtime.sh'),externalRuntime=join(root,'host-runtime-outside.sh');
  symlinkSync(home,alias);writeFileSync(runtimeFile,'HOST-RUNTIME-READABLE');writeFileSync(externalRuntime,'HOST-RUNTIME-OUTSIDE-READABLE');
  mkdirSync(join(home,'other-repository'));mkdirSync(join(home,'.codex'));
  writeFileSync(privateHomeFile,'UNRELATED-HOME-SENTINEL');writeFileSync(auth,JSON.stringify({tokens:{access_token:fixtureToken}}));
  const outside=join(root,'outside-project.txt');writeFileSync(outside,'OUTSIDE-PROJECT-SENTINEL');
  const hardlink=join(home,'.codex','review-leak');
  writeFileSync(sentinel,'ORIGINAL-PROJECT-SENTINEL');
  linkSync(sentinel,hardlink);
  const isolation=new AgentIsolation({
    userDataPath:userData,enabled:()=>true,platform:'darwin',sandboxExecPath:SANDBOX_EXEC,tempRoot:isolationTemp,
    hostEnvironment:{HOME:home,PATH:'/usr/bin:/bin'}
  });
  const launch=isolation.wrap({
    sessionId:'diff-review-sandbox-test',provider:'codex',cwd:workspace.directory,networkProjectRoot:project,
    command:'/bin/sh',args:['-c',[
      'if cat "$REVIEW_SENTINEL" >/dev/null 2>&1; then echo SOURCE-READ-ALLOWED; else echo SOURCE-READ-DENIED; fi',
      'if cat "$REVIEW_HOME_FILE" >/dev/null 2>&1; then echo HOME-READ-ALLOWED; else echo HOME-READ-DENIED; fi',
      'if ls "$REVIEW_HOME_DIR" >/dev/null 2>&1; then echo HOME-DIRECTORY-READ-ALLOWED; else echo HOME-DIRECTORY-READ-DENIED; fi',
      'if ls "$REVIEW_PROJECT_DIR" >/dev/null 2>&1; then echo PROJECT-DIRECTORY-READ-ALLOWED; else echo PROJECT-DIRECTORY-READ-DENIED; fi',
      'if cat "$REVIEW_HOME_ALIAS" >/dev/null 2>&1; then echo ALIAS-READ-ALLOWED; else echo ALIAS-READ-DENIED; fi',
      'if cat "$REVIEW_OUTSIDE" >/dev/null 2>&1; then echo OUTSIDE-READ-ALLOWED; else echo OUTSIDE-READ-DENIED; fi',
      'if cat "$REVIEW_HARDLINK" >/dev/null 2>&1; then echo HARDLINK-READ-ALLOWED; else echo HARDLINK-READ-DENIED; fi',
      'if touch "$REVIEW_WRITE" 2>/dev/null; then echo WORKSPACE-WRITE-ALLOWED; else echo WORKSPACE-WRITE-DENIED; fi',
      'if printf A-HOME-SENTINEL > "$CODEX_HOME/reviewer-home-sentinel"; then echo OWN-HOME-WRITE-ALLOWED; else echo OWN-HOME-WRITE-DENIED; fi',
      'if printf A-TEMP-SENTINEL > "$TMPDIR/reviewer-temp-sentinel"; then echo OWN-TEMP-WRITE-ALLOWED; else echo OWN-TEMP-WRITE-DENIED; fi',
      'if touch "$REVIEW_RUN_ROOT/run-root-write" 2>/dev/null; then echo PRIVATE-RUN-WRITE-ALLOWED; else echo PRIVATE-RUN-WRITE-DENIED; fi',
      'cat "$REVIEW_DIFF"', 'cat "$CODEX_HOME/auth.json"', 'cat "$REVIEW_RUNTIME"', 'cat "$REVIEW_EXTERNAL_RUNTIME"'
    ].join('; ')],
    env:{HOME:home,PATH:'/usr/bin:/bin',REVIEW_SENTINEL:sentinel,REVIEW_HOME_FILE:privateHomeFile,REVIEW_HOME_DIR:home,REVIEW_PROJECT_DIR:project,REVIEW_HOME_ALIAS:join(alias,'other-repository','private-file.txt'),REVIEW_AUTH:auth,REVIEW_WRITE:writeProbe,REVIEW_DIFF:workspace.diffPath,REVIEW_RUNTIME:runtimeFile,REVIEW_EXTERNAL_RUNTIME:externalRuntime,REVIEW_OUTSIDE:outside,REVIEW_HARDLINK:hardlink},
    profile:'plan',deniedReadPaths:[project],restrictHomeReads:true,runtimeReadable:[runtimeFile,externalRuntime]
  });
  let secondLaunch;
  let peerLaunch;
  let runA;
  let runB;
  try{
    const runsRoot=realpathSync(join(userData,'launch-runs'));
    const invalidRunsRoot=join(root,'invalid-runs-root'),symlinkData=join(invalidRunsRoot,'symlink-data'),fileData=join(invalidRunsRoot,'file-data'),runsTarget=join(invalidRunsRoot,'runs-target');
    mkdirSync(symlinkData,{recursive:true});mkdirSync(fileData);mkdirSync(runsTarget);writeFileSync(join(fileData,'launch-runs'),'not a directory');
    symlinkSync(runsTarget,join(symlinkData,'launch-runs'));
    for(const invalidData of [symlinkData,fileData]) {
      const invalidIsolation=new AgentIsolation({userDataPath:invalidData,enabled:()=>true,platform:'darwin',sandboxExecPath:SANDBOX_EXEC,tempRoot:isolationTemp,
        hostEnvironment:{HOME:home,PATH:'/usr/bin:/bin'}});
      assert.throws(()=>invalidIsolation.wrap({sessionId:'invalid-reviewer-root',provider:'codex',cwd:workspace.directory,networkProjectRoot:project,
        command:'/bin/sh',args:[],env:{HOME:home},profile:'plan',deniedReadPaths:[project],restrictHomeReads:true}),/private launch-runs/u);
    }
    const tempA=realpathSync(launch.env.TMPDIR);
    runA=dirname(tempA);
    const homeSentinel=join(launch.env.CODEX_HOME,'reviewer-home-sentinel');
    const tempSentinel=join(tempA,'reviewer-temp-sentinel');
    assert.equal(dirname(runA),runsRoot,'the host-created reviewer run must be a direct launch-runs child');
    launch.env.REVIEW_RUN_ROOT=runA;
    const child=spawnSync(launch.command,launch.args,{cwd:workspace.directory,env:launch.env,encoding:'utf8',timeout:15_000});
    assert.equal(child.error,undefined,child.error?.message);
    assert.equal(child.status,0,`${child.stderr} signal=${child.signal}`);
    assert.match(child.stdout,/SOURCE-READ-DENIED/u);
    assert.match(child.stdout,/HOME-READ-DENIED/u);
    assert.match(child.stdout,/HOME-DIRECTORY-READ-DENIED/u);
    assert.match(child.stdout,/PROJECT-DIRECTORY-READ-DENIED/u);
    assert.match(child.stdout,/ALIAS-READ-DENIED/u);
    assert.match(child.stdout,/OUTSIDE-READ-DENIED/u);
    assert.match(child.stdout,/HARDLINK-READ-DENIED/u);
    assert.match(child.stdout,/WORKSPACE-WRITE-DENIED/u);
    assert.match(child.stdout,/OWN-HOME-WRITE-ALLOWED/u);
    assert.match(child.stdout,/OWN-TEMP-WRITE-ALLOWED/u);
    assert.match(child.stdout,/PRIVATE-RUN-WRITE-DENIED/u);
    assert.equal(readFileSync(homeSentinel,'utf8'),'A-HOME-SENTINEL');
    assert.equal(readFileSync(tempSentinel,'utf8'),'A-TEMP-SENTINEL');
    assert.match(child.stdout,/SUPPLIED-DIFF-READABLE/u);
    assert.ok(child.stdout.includes(fixtureToken));
    assert.match(child.stdout,/HOST-RUNTIME-READABLE/u);
    assert.match(child.stdout,/HOST-RUNTIME-OUTSIDE-READABLE/u);
    assert.equal(existsSync(writeProbe),false);
    secondLaunch=isolation.wrap({
      sessionId:'diff-review-sandbox-test-second',provider:'codex',cwd:workspace.directory,networkProjectRoot:project,
      command:'/bin/sh',args:['-c',[
        'if cat "$REVIEW_A_HOME_SENTINEL" >/dev/null 2>&1; then echo OTHER-HOME-READ-ALLOWED; else echo OTHER-HOME-READ-DENIED; fi',
        'if cat "$REVIEW_A_TEMP_SENTINEL" >/dev/null 2>&1; then echo OTHER-TEMP-READ-ALLOWED; else echo OTHER-TEMP-READ-DENIED; fi',
        'if printf B-HOME-WRITE > "$CODEX_HOME/reviewer-home-write"; then echo OWN-HOME-WRITE-ALLOWED; else echo OWN-HOME-WRITE-DENIED; fi',
        'if printf B-TEMP-WRITE > "$TMPDIR/reviewer-temp-write"; then echo OWN-TEMP-WRITE-ALLOWED; else echo OWN-TEMP-WRITE-DENIED; fi'
      ].join('; ')],
      env:{HOME:home,PATH:'/usr/bin:/bin',REVIEW_A_HOME_SENTINEL:homeSentinel,REVIEW_A_TEMP_SENTINEL:tempSentinel},
      profile:'plan',deniedReadPaths:[project],restrictHomeReads:true
    });
    const tempB=realpathSync(secondLaunch.env.TMPDIR);
    runB=dirname(tempB);
    assert.equal(dirname(runB),runsRoot);
    assert.notEqual(runB,runA);
    const second=spawnSync(secondLaunch.command,secondLaunch.args,{cwd:workspace.directory,env:secondLaunch.env,encoding:'utf8',timeout:15_000});
    assert.equal(second.error,undefined,second.error?.message);
    assert.equal(second.status,0,`${second.stderr} signal=${second.signal}`);
    assert.match(second.stdout,/OTHER-HOME-READ-DENIED/u);
    assert.match(second.stdout,/OTHER-TEMP-READ-DENIED/u);
    assert.match(second.stdout,/OWN-HOME-WRITE-ALLOWED/u);
    assert.match(second.stdout,/OWN-TEMP-WRITE-ALLOWED/u);
    assert.equal(readFileSync(join(secondLaunch.env.CODEX_HOME,'reviewer-home-write'),'utf8'),'B-HOME-WRITE');
    assert.equal(readFileSync(join(tempB,'reviewer-temp-write'),'utf8'),'B-TEMP-WRITE');
    peerLaunch=isolation.wrap({
      sessionId:'diff-review-sandbox-peer',provider:'codex',cwd:workspace.directory,networkProjectRoot:project,
      command:'/bin/sh',args:['-c',[
        'if cat "$REVIEW_A_HOME_SENTINEL" >/dev/null 2>&1; then echo PEER-HOME-READ-ALLOWED; else echo PEER-HOME-READ-DENIED; fi',
        'if cat "$REVIEW_A_TEMP_SENTINEL" >/dev/null 2>&1; then echo PEER-TEMP-READ-ALLOWED; else echo PEER-TEMP-READ-DENIED; fi',
        'if cat "$REVIEW_OUTSIDE" >/dev/null 2>&1; then echo PEER-OUTSIDE-READ-ALLOWED; else echo PEER-OUTSIDE-READ-DENIED; fi',
        'cat "$REVIEW_OUTSIDE"'
      ].join('; ')],
      env:{HOME:home,PATH:'/usr/bin:/bin',REVIEW_A_HOME_SENTINEL:homeSentinel,REVIEW_A_TEMP_SENTINEL:tempSentinel,REVIEW_OUTSIDE:outside},
      profile:'normal'
    });
    const peer=spawnSync(peerLaunch.command,peerLaunch.args,{cwd:workspace.directory,env:peerLaunch.env,encoding:'utf8',timeout:15_000});
    assert.equal(peer.error,undefined,peer.error?.message);
    assert.equal(peer.status,0,`${peer.stderr} signal=${peer.signal}`);
    assert.match(peer.stdout,/PEER-HOME-READ-DENIED/u);
    assert.match(peer.stdout,/PEER-TEMP-READ-DENIED/u);
    assert.match(peer.stdout,/PEER-OUTSIDE-READ-ALLOWED/u);
    assert.match(peer.stdout,/OUTSIDE-PROJECT-SENTINEL/u);
  }finally{
    peerLaunch?.cleanup();
    secondLaunch?.cleanup();
    launch.cleanup();
    if(runA)assert.equal(existsSync(runA),false,'cleanup removes the exact first private run');
    if(runB)assert.equal(existsSync(runB),false,'cleanup removes the exact second private run');
  }
});

test('reviewer runtime grants cannot reopen a directory or protected app data', t => {
  const root=mkdtempSync(join(tmpdir(),'ctty-review-runtime-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'home'),project=join(root,'project'),userData=join(root,'data');
  for(const path of [home,project,userData])mkdirSync(path);
  const privateFile=join(userData,'flow-approvals.json');writeFileSync(privateFile,'[]');
  const linkedSource=join(root,'runtime-source');writeFileSync(linkedSource,'fixture');
  const linkedRuntime=join(root,'linked-runtime');linkSync(linkedSource,linkedRuntime);
  const input={sessionId:'runtime-test',provider:'codex',cwd:join(root,'review'),sessionTemp:join(root,'temp'),env:{HOME:home},
    userDataPath:userData,readOnlyProject:true,deniedReadPaths:[project],restrictHomeReads:true};
  assert.throws(()=>isolationPaths({...input,runtimeReadable:[home]}),/must be a file/u);
  assert.throws(()=>isolationPaths({...input,runtimeReadable:[privateFile]}),/protected data/u);
  assert.throws(()=>isolationPaths({...input,runtimeReadable:[linkedRuntime]}),/single-link/u);
  assert.throws(()=>isolationPaths({...input,env:{HOME:home,CODEX_HOME:project}}),/protected tree/u);
});

test('OpenCode reviewers retain only the host lifecycle plugin and fail closed without it', t => {
  const root=mkdtempSync(join(tmpdir(),'ctty-review-opencode-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'home'),temp=join(root,'temp'),plugin=join(root,'opencode-plugin.mjs');
  mkdirSync(home);mkdirSync(temp);writeFileSync(plugin,'// trusted host runtime fixture');
  const env={HOME:home,OPENCODE_CONFIG:'/tmp/untrusted-opencode.json',OPENCODE_CONFIG_CONTENT:JSON.stringify({
    plugin:['file:///untrusted/plugin.mjs'],mcp:{credential:'untrusted'},permission:{allow:['*']},custom:'discard'
  })};
  prepareReviewerHome(env,'opencode',temp,[plugin]);
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT),{plugin:[pathToFileURL(realpathSync(plugin)).href]});
  assert.equal(env.OPENCODE_CONFIG,undefined);

  const withoutPlugin={HOME:home,OPENCODE_CONFIG_CONTENT:JSON.stringify({plugin:['file:///untrusted/plugin.mjs']})};
  assert.throws(()=>prepareReviewerHome(withoutPlugin,'opencode',temp,[]),/verified CanvasTTY lifecycle plugin/u);
});

test('reviewer auth FIFO is refused without blocking the main process', {skip:process.platform==='win32'}, t => {
  const root=mkdtempSync(join(tmpdir(),'ctty-review-auth-fifo-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'home'),temp=join(root,'temp'),auth=join(home,'.codex','auth.json');
  mkdirSync(join(home,'.codex'),{recursive:true});mkdirSync(temp);
  const created=spawnSync('mkfifo',[auth],{encoding:'utf8'});
  assert.equal(created.status,0,created.stderr);
  const moduleUrl=new URL('../src/main/services/isolation/reviewerHome.ts',import.meta.url).href;
  const script=`
    const {prepareReviewerHome}=await import(${JSON.stringify(moduleUrl)});
    try {
      prepareReviewerHome({HOME:${JSON.stringify(home)}},'codex',${JSON.stringify(temp)});
      console.log('unexpected-accepted');process.exitCode=2;
    } catch(error) {
      if(error?.message?.includes('bounded file')) console.log('fifo-refused');
      else {console.error(error);process.exitCode=1;}
    }
  `;
  const child=spawnSync(process.execPath,['--experimental-strip-types','--no-warnings','--input-type=module','-e',script],
    {encoding:'utf8',timeout:3_000});
  assert.equal(child.error,undefined,`FIFO handling blocked or failed to start: ${child.error?.message}`);
  assert.equal(child.status,0,child.stderr);
  assert.equal(child.stdout.trim(),'fifo-refused');
});

test('the installed Node and Codex executables can report versions in a reviewer sandbox with a fake HOME', {
  skip:process.platform!=='darwin'||process.env.CANVASTTY_TEST_NATIVE_SANDBOX!=='1'
}, t => {
  const root=mkdtempSync(join(tmpdir(),'ctty-review-cli-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'home'),project=join(root,'project'),userData=join(root,'data');
  for(const path of [home,project,userData,join(root,'isolation')])mkdirSync(path);
  const workspace=createDiffOnlyReviewWorkspace('FIXTURE DIFF');t.after(()=>workspace.cleanup());
  const codex=(process.env.PATH??'').split(delimiter).map(path=>join(path,'codex')).find(existsSync);
  const cases=[[process.execPath,/v\d+\./u],...(codex?[[codex,/codex-cli \d+/u]]:[])];
  for(const [command,expected] of cases) {
    const isolation=new AgentIsolation({userDataPath:userData,enabled:()=>true,tempRoot:join(root,'isolation'),hostEnvironment:process.env});
    const launch=isolation.wrap({sessionId:'reviewer-version',provider:'codex',cwd:workspace.directory,
      networkProjectRoot:project,command,args:['--version'],env:{HOME:home,CODEX_HOME:join(home,'.codex'),PATH:process.env.PATH??'/usr/bin:/bin',DISABLE_AUTOUPDATER:'1'},
      profile:'plan',deniedReadPaths:[project],restrictHomeReads:true});
    try {
      const result=spawnSync(launch.command,launch.args,{cwd:workspace.directory,env:launch.env,encoding:'utf8',timeout:15000});
      assert.equal(result.status,0,`${result.stderr} signal=${result.signal}`);assert.match(result.stdout,expected);
    } finally {launch.cleanup();}
  }
});

test('a reviewer on the worker model account reads a private copy of the account run file, not launch-runs itself', {
  skip:process.platform!=='darwin'||process.env.CANVASTTY_TEST_NATIVE_SANDBOX!=='1'
}, t => {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'ctty-review-account-')));
  const workspace=createDiffOnlyReviewWorkspace('+x');
  t.after(()=>{workspace.cleanup();rmSync(root,{recursive:true,force:true});});
  const home=join(root,'home'),userData=join(root,'userdata'),project=join(root,'project'),temp=join(root,'tmp');
  for(const path of [home,userData,project,temp])mkdirSync(path,{recursive:true});
  const run=join(userData,'launch-runs','worker','r1','canvastty-accounts');mkdirSync(run,{recursive:true});
  const source=join(run,'opencode.json');writeFileSync(source,'{"provider":{"p":{"options":{"baseURL":"https://api.z.ai/api/coding/paas/v4"}}}}');
  const plugin=join(process.cwd(),'src','agent-runtime','opencode-plugin.mjs');
  const isolation=new AgentIsolation({userDataPath:userData,enabled:()=>true,platform:'darwin',sandboxExecPath:SANDBOX_EXEC,tempRoot:temp,hostEnvironment:{HOME:home,PATH:'/usr/bin:/bin'}});
  const launch=isolation.wrap({sessionId:'reviewer',provider:'opencode',cwd:workspace.directory,networkProjectRoot:project,command:'/bin/sh',
    args:['-c','cat "$OPENCODE_CONFIG"; if cat "$SOURCE" >/dev/null 2>&1; then echo RUNS-READ-ALLOWED; else echo RUNS-READ-DENIED; fi'],
    env:{HOME:home,PATH:'/usr/bin:/bin',OPENCODE_CONFIG:source,OPENCODE_CONFIG_CONTENT:'{"plugin":[]}',SOURCE:source},
    profile:'plan',deniedReadPaths:[project],restrictHomeReads:true,runtimeReadable:[plugin],apiDomains:['api.z.ai']});
  try {
    assert.notEqual(launch.env.OPENCODE_CONFIG,source);
    const child=spawnSync(launch.command,launch.args,{cwd:workspace.directory,env:{...launch.env,SOURCE:source},encoding:'utf8',timeout:15_000});
    assert.equal(child.status,0,child.stderr);
    assert.match(child.stdout,/api\.z\.ai/u);
    assert.match(child.stdout,/RUNS-READ-DENIED/u);
  } finally { launch.cleanup(); }
  // Without an account (no API hosts) the reviewer gets no OpenCode config file at all.
  const plain=isolation.wrap({sessionId:'reviewer2',provider:'opencode',cwd:workspace.directory,networkProjectRoot:project,command:'/bin/sh',args:['-c','true'],
    env:{HOME:home,PATH:'/usr/bin:/bin',OPENCODE_CONFIG:source,OPENCODE_CONFIG_CONTENT:'{"plugin":[]}'},profile:'plan',deniedReadPaths:[project],restrictHomeReads:true,runtimeReadable:[plugin]});
  assert.equal(plain.env.OPENCODE_CONFIG,undefined);plain.cleanup();
});
