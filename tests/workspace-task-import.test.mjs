import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OrchestrationTaskBoard} from '../src/main/services/OrchestrationTaskBoard.ts';

test('unmapped inherited and non-string session identifiers cannot corrupt the persisted task board',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'ctty-task-import-map-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const board=new OrchestrationTaskBoard(join(directory,'boards'));
 const existing=await board.addTask(directory,'root','root',{title:'Existing task'});
 const task=(id,owner)=>({...existing,id,title:id,ownerSessionId:owner,ownerName:'Old owner',status:'claimed',createdBySessionId:owner});
 const rows=['constructor','toString','__proto__','invalid'].map(name=>task(`import-${name}`,name));
 await board.importGroup(directory,'root',rows,{invalid:42});
 const loaded=await new OrchestrationTaskBoard(join(directory,'boards')).listTasks(directory,'root');
 assert.equal(loaded.tasks.length,5);assert.equal(loaded.tasks[0].id,existing.id);
 for(const row of loaded.tasks.slice(1)){assert.equal(row.ownerSessionId,null);assert.equal(row.ownerName,null);assert.equal(row.status,'open');assert.equal(row.createdBySessionId,'root');}
 const own=Object.fromEntries([['constructor','new-child'],['toString','new-author'],['__proto__','other-child']]);
 await board.importGroup(directory,'root',[{...task('own-constructor','constructor'),createdBySessionId:'toString'},task('own-proto','__proto__')],own);
 const again=(await new OrchestrationTaskBoard(join(directory,'boards')).listTasks(directory,'root')).tasks;
 assert.equal(again.length,7);assert.equal(again[5].ownerSessionId,'new-child');assert.equal(again[5].ownerName,'Old owner');assert.equal(again[5].status,'claimed');assert.equal(again[5].createdBySessionId,'new-author');assert.equal(again[6].ownerSessionId,'other-child');
});
