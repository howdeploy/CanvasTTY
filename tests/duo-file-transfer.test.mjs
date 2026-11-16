import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DuoFileTransferService,sendDuoFiles} from '../src/main/services/DuoFileTransferService.ts';
const digest=data=>createHash('sha256').update(data).digest('hex');
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'duo-files-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,service:new DuoFileTransferService(join(root,'imports'))};}
test('explicit guest files transfer in bounded chunks, verify hashes and quote host paths without submitting input',async t=>{
 const {root,service}=await fixture(t),data=Buffer.from('Привет\0PNG\n'.repeat(11000)),source=join(root,"image ' quoted.bin");await writeFile(source,data);
 const calls=[],request=async args=>{calls.push(args);return service.receive(args,()=>true);};
 const text=await sendDuoFiles([source],request,()=>true);assert.match(text,/^'/);assert.match(text,/' $/);
 assert(calls.filter(c=>c[0]==='chunk').length>1);assert(calls.every(c=>JSON.stringify(c).length<48000));
 const directory=join(root,'imports',(await readdir(join(root,'imports')))[0]);
 const imported=join(directory,(await readdir(directory))[0]);assert.deepEqual(await readFile(imported),data);
 if(process.platform!=='win32')assert.equal((await stat(imported)).mode&0o777,0o600);
 service.clear();await service.queue;assert.deepEqual(await readFile(imported),data,'Committed paths remain usable by host PTYs');
});
test('uploads reject traversal, oversized files, missing bytes, invalid offsets and checksum mismatch',async t=>{
 const {service}=await fixture(t),valid={name:'safe.txt',size:3,hash:digest('abc')};
 for(const patch of [{name:'../escape'},{name:'x\\y'},{name:'..'},{name:'x\n'},{size:32*1024*1024+1},{size:-1},{hash:'bad'}])await assert.rejects(service.receive(['begin',{...valid,...patch}],()=>true));
 const {id}=await service.receive(['begin',valid],()=>true);
 await assert.rejects(service.receive(['commit',id],()=>true),/Incomplete/);
 await assert.rejects(service.receive(['chunk',id,{offset:1,data:Buffer.from('abc').toString('base64')}],()=>true),/chunk/);
 await assert.rejects(service.receive(['chunk',id,{offset:0,data:'!!'}],()=>true),/chunk/);
 await service.receive(['chunk',id,{offset:0,data:Buffer.from('bad').toString('base64')}],()=>true);
 await assert.rejects(service.receive(['commit',id],()=>true),/checksum/);
 await service.receive(['cancel',id],()=>true);
});
test('revoked transfer stops, removes incomplete files and never falls back to a local path',async t=>{
 const {root,service}=await fixture(t),source=join(root,'large.bin');await writeFile(source,Buffer.alloc(90000,9));let allowed=true,chunks=0;
 await assert.rejects(sendDuoFiles([source],async args=>{
   const result=await service.receive(args,()=>allowed);
   if(args[0]==='chunk'&&++chunks===1)allowed=false;
   return result;
 },()=>allowed),/permission/);
 assert.equal(chunks,1);service.clear();await service.queue;assert.deepEqual(await readdir(join(root,'imports')),[]);
 await assert.rejects(sendDuoFiles([root],()=>{throw Error('Must not send directories');},()=>true),/folders/);
 await assert.rejects(service.receive(['begin',{name:'no',size:0,hash:digest('')}],()=>false),/revoked/);
});
