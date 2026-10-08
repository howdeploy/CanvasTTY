import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {ProviderUsageSource} from '../src/main/services/ProviderUsageSource.ts';

test('Codex usage reads only published cumulative counters from the exact rollout in a worker',async()=>{
  const home=await mkdtemp(join(tmpdir(),'usage-source-'));
  try {
    const rollout=join(home,'sessions','rollout.jsonl');await mkdir(join(home,'sessions'));
    await writeFile(rollout,[
      JSON.stringify({type:'response_item',payload:{type:'message',text:'PRIVATE TRANSCRIPT TEXT'}}),
      JSON.stringify({type:'turn_context',payload:{model:'codex-model-a'}}),
      JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,cached_input_tokens:20,output_tokens:9,total_tokens:109}}}}),
      JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:120,cached_input_tokens:24,output_tokens:12,total_tokens:132}}}})
    ].join('\n')+'\n');
    const db=new DatabaseSync(join(home,'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,tokens_used INTEGER,model TEXT,updated_at_ms INTEGER);');
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run('thread-1',rollout,132,'configured-model',100);
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run('thread-2',null,456,'other-model',101);db.close();

    const source=new ProviderUsageSource(home);
    const usage=await source.codexUsage('thread-1');
    assert.deepEqual(usage,{total:132,input:120,output:12,model:'codex-model-a'});
    assert.equal(await source.codexTotal('thread-1'),132);
    assert.equal(await source.codexUsage('thread-2')?.then(value=>value?.total),456);
    assert.equal(await source.codexUsage('missing'),null);
    assert.equal(await source.codexUsage("' OR 1=1"),null);
    assert.doesNotMatch(JSON.stringify(usage),/PRIVATE TRANSCRIPT TEXT/);
    const verify=new DatabaseSync(join(home,'state_5.sqlite'),{readOnly:true});
    assert.equal(verify.prepare('SELECT count(*) AS n FROM threads').get().n,2);verify.close();
  }finally{await rm(home,{recursive:true,force:true});}
});

test('Codex usage keeps the published SQLite total when a store has no rollout counters',async()=>{
  const home=await mkdtemp(join(tmpdir(),'usage-source-'));
  try {
    const db=new DatabaseSync(join(home,'state_1.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,tokens_used INTEGER,title TEXT);');
    db.prepare('INSERT INTO threads VALUES(?,?,?)').run('thread-1',123,'PRIVATE TITLE');
    db.prepare('INSERT INTO threads VALUES(?,?,?)').run('thread-2',456,'OTHER PRIVATE TITLE');db.close();
    const source=new ProviderUsageSource(home);
    assert.deepEqual(await source.codexUsage('thread-1'),{total:123,input:null,output:null});
    assert.equal(await source.codexTotal('thread-2'),456);
    assert.equal(await source.codexUsage('missing'),null);
  }finally{await rm(home,{recursive:true,force:true});}
});
