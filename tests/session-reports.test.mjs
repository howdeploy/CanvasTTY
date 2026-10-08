import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SessionReports} from '../src/main/services/SessionReports.ts';
import {SessionTimelineService} from '../src/main/services/SessionTimelineService.ts';

test('completion automatically saves a masked timeline report in under two seconds',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ctty-reports-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const timeline=new SessionTimelineService(root,text=>text.replaceAll('private-value','[redacted]'));await timeline.load();
 await timeline.append('card','command','completed','private-value');
 const changes=[],reports=new SessionReports(root,id=>timeline.report(id),(id,readyAt)=>changes.push({id,readyAt}));
 const start=performance.now();await reports.complete('card');assert.ok(performance.now()-start<2000);
 assert.equal(changes[0].id,'card');assert.equal(typeof changes[0].readyAt,'number');
 const text=await reports.report('card');assert.match(text,/completed/);assert.match(text,/Network visibility is incomplete/);assert.ok(!text.includes('private-value'));
 const [name]=await readdir(join(root,'session-reports'));if(process.platform!=='win32')assert.equal((await stat(join(root,'session-reports',name))).mode&0o777,0o600); // Windows has no owner-only mode bits.
 await timeline.append('card','git-risk','Late Git audit','private-value');
 assert.match(await reports.report('card'),/Late Git audit/);
 const refreshed=await readFile(join(root,'session-reports',name),'utf8');
 assert.match(refreshed,/Late Git audit/);assert.ok(!refreshed.includes('private-value'));
 reports.invalidate('card');assert.equal(changes.at(-1).readyAt,null);
 await timeline.append('card','command','next turn');assert.match(await reports.report('card'),/next turn/);
});

test('a later turn/removal cancels a pending completion without a stale ready badge',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ctty-report-race-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const changes=[];let release;
 const reports=new SessionReports(root,()=>new Promise(resolve=>release=resolve),(id,at)=>changes.push([id,at]));
 const pending=reports.complete('../untrusted-id');reports.forget('../untrusted-id');release('old report');await pending;
 assert.deepEqual(changes,[]);assert.deepEqual(await readdir(root),[]);
});
