import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

test('persistent diagnostic logs redact Duo capabilities and raw invitation links',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'ct-duo-logs-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const {outputFiles}=await build({entryPoints:[fileURLToPath(new URL('../src/main/services/DiagnosticLog.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 const {DiagnosticLog}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
 const log=new DiagnosticLog(directory);
 const invite='canvasduo://'+'a'.repeat(150);
 const key='TEST_AES_VALUE',guestSeed='TEST_GUEST_VALUE',hostKey='TEST_HOST_VALUE';
 log.record('warn','test','failure',{invite,invitation:invite,nested:{version:3,key,guestSeed,hostKey},error:new Error('Cannot open '+invite)});
 await log.flush();
 const path=join(directory,'application.jsonl'),json=await readFile(path,'utf8');
 for(const secret of [invite,key,guestSeed,hostKey])assert(!json.includes(secret));
 assert(json.includes('<duo-invitation>'));assert.equal(JSON.parse(json).event,'failure');
 if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o777,0o600);
});
