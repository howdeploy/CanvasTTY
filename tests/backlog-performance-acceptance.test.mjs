import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SessionTimelineService} from '../src/main/services/SessionTimelineService.ts';

test('a 100,000-event timeline returns its first page and filtered history in under one second',async t=>{
 const root=await mkdtemp(join(tmpdir(),'canvastty-timeline-perf-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=join(root,'session-timeline');await mkdir(directory);
 for(let part=0;part<10;part++){
  const rows=Array.from({length:10000},(_,i)=>{
   const index=part*10000+i;
   return JSON.stringify({id:`event-${index}`,sessionId:'card',at:index,type:'command',summary:`Command ${index}${index===0 ? ' oldest marker' : ''}`});
  });
  await writeFile(join(directory,`${String(part+1).padStart(16,'0')}-fixture.ndjson`),rows.join('\n')+'\n');
 }
 const timeline=new SessionTimelineService(root,text=>text);
 let mainThreadHeartbeat=false;const heartbeat=setInterval(()=>{mainThreadHeartbeat=true;},0);
 await timeline.load();clearInterval(heartbeat);
 assert.equal(mainThreadHeartbeat,true,'timeline startup should leave the main event loop available while segments are indexed');
 let start=performance.now();const page=await timeline.page('card',undefined,50);
 const pageMs=performance.now()-start;
 assert.equal(page.items.length,50);assert.equal(page.items[0].id,'event-99999');assert.ok(page.nextCursor);
 assert.ok(pageMs<1000,`first timeline page took ${pageMs.toFixed(1)} ms`);
 const originalRead=timeline.read.bind(timeline);let filteredParsedRows=0;
 timeline.read=async name=>{const rows=await originalRead(name);filteredParsedRows+=rows.length;return rows;};
 start=performance.now();const filtered=await timeline.page('card',undefined,50,{query:'oldest marker'});
 const filterMs=performance.now()-start;
 assert.deepEqual(filtered.items.map(row=>row.id),['event-0']);
 assert.ok(filteredParsedRows<=10_000,`indexed filter parsed ${filteredParsedRows} records instead of skipping unrelated segments`);
 timeline.read=originalRead;
 assert.ok(filterMs<1000,`filtered timeline took ${filterMs.toFixed(1)} ms`);
 let parsedRows=0;const read=timeline.read.bind(timeline);
 timeline.read=async name=>{const rows=await read(name);parsedRows+=rows.length;return rows;};
 start=performance.now();let cursor,pages=0;const ids=[];
 do {
  const result=await timeline.page('card',cursor,50);pages++;
  ids.push(...result.items.map(event=>event.id));
  cursor=result.nextCursor;
 }while(cursor);
 const allPagesMs=performance.now()-start;
 assert.deepEqual(ids,Array.from({length:100_000},(_,index)=>`event-${99_999-index}`));assert.equal(pages,2000);
 assert.ok(parsedRows<=110000,`sequential paging reparsed ${parsedRows} rows for 100,000 events`);
 assert.ok(allPagesMs<5000,`all cursor pages took ${allPagesMs.toFixed(1)} ms`);
 t.diagnostic(`100,000 events: first page ${pageMs.toFixed(1)} ms, full-history filter ${filterMs.toFixed(1)} ms`);
 t.diagnostic(`2,000 sequential pages: ${allPagesMs.toFixed(1)} ms, ${parsedRows} parsed rows`);
});
