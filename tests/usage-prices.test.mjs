import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UsagePrices} from '../src/main/services/UsagePrices.ts';
const price=(model,inputPerMillion=1,provider='codex')=>({provider,model,inputPerMillion,outputPerMillion:2});
test('normalized price collisions never replace or persist an ambiguous price table',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'ctty-prices-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const path=join(directory,'prices.json'),prices=new UsagePrices(path);await prices.load();
 await prices.set([price('  model-a  '),price('model-a',3,'opencode')]);
 assert.deepEqual(prices.get(),[price('model-a'),price('model-a',3,'opencode')]);
 const saved=await readFile(path,'utf8');
 for(const rows of [[price('model-a'),price('model-a ',9)],[price('\tmodel-a'),price('model-a',9)],[price('model-a '),price(' model-a',9)]]) {
  await assert.rejects(prices.set(rows),/Duplicate model price/);
  assert.equal(await readFile(path,'utf8'),saved,'invalid edit must not replace persisted prices');
 }
 const restored=new UsagePrices(path);await restored.load();assert.deepEqual(restored.get(),prices.get());
 await writeFile(path,JSON.stringify([price('model-a'),price('model-a ',9)]));
 await assert.rejects(new UsagePrices(path).load(),/Duplicate model price/,'an existing ambiguous file is rejected rather than silently using its first price');
});
