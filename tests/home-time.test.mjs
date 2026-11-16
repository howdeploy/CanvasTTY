import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultHomeTime, normalizeHomeTime, formatHomeClock, timerAction, timerRemaining, formatTimer } from '../src/shared/homeTime.ts';
import { SettingsStore } from '../src/main/services/SettingsStore.ts';
const timer = { id:'tea', label:'Tea', durationMs:60000, remainingMs:60000, endsAt:null, status:'idle' };
test('zones use regional date and daylight-saving rules, including dates across midnight', () => {
  const options = {hour12:false,showSeconds:false};
  const clock = zone => ({id:'clock',label:'',timeZone:zone});
  assert.equal(formatHomeClock(clock('Europe/Moscow'),new Date('2026-01-01T12:00Z'),'en-GB',options).time,'15:00');
  assert.equal(formatHomeClock(clock('America/New_York'),new Date('2026-01-01T12:00Z'),'en-GB',options).time,'07:00');
  assert.equal(formatHomeClock(clock('America/New_York'),new Date('2026-07-01T12:00Z'),'en-GB',options).time,'08:00');
  const tokyo = formatHomeClock(clock('Asia/Tokyo'),new Date('2026-01-01T23:30Z'),'en-GB',options);
  assert.equal(tokyo.time,'08:30'); assert.match(tokyo.date,/2 January/);
  const twelve = formatHomeClock(clock('UTC'),new Date('2026-01-01T23:30:02Z'),'en-GB',{hour12:true,showSeconds:true});
  assert.equal(twelve.time,'11:30:02'); assert.match(twelve.period,/pm/i);
});
test('independent timers pause, resume and reset from deadlines without interval drift', () => {
  const first = timerAction(timer,'start',1000), second = timerAction({...timer,id:'other'},'start',9000);
  assert.equal(timerRemaining(first,16000),45000); assert.equal(timerRemaining(second,16000),53000);
  const paused = timerAction(first,'pause',16000);
  assert.equal(timerRemaining(paused,900000),45000);
  const resumed = timerAction(paused,'start',900000);
  assert.equal(resumed.endsAt,945000);
  assert.equal(timerRemaining(resumed,999999),0);
  assert.equal(timerAction(resumed,'start',999999).endsAt,1059999);
  assert.deepEqual(timerAction(resumed,'reset',0),timer);
  assert.equal(formatTimer(3599999),'1:00:00'); assert.equal(formatTimer(999),'0:01');
});
test('corrupt, duplicate and unbounded settings are normalized safely', () => {
  const value=normalizeHomeTime({clocks:[{id:'a',timeZone:'not/a/zone'},{id:'b',label:'Tokyo',timeZone:'Asia/Tokyo'},{id:'b',timeZone:'UTC'}],timers:[timer,{...timer},{...timer,id:'bad',durationMs:NaN},{...timer,id:'paused',status:'paused',remainingMs:Infinity}],hour12:'true'});
  assert.equal(value.clocks.length,1); assert.equal(value.timers.length,2); assert.equal(value.timers[1].remainingMs,60000); assert.equal(value.hour12,false);
  assert.deepEqual(normalizeHomeTime(null),defaultHomeTime());
  assert.equal(normalizeHomeTime({clocks:Array.from({length:20},(_,i)=>({id:`c${i}`,timeZone:'UTC'})),timers:Array.from({length:20},(_,i)=>({...timer,id:`t${i}`}))}).clocks.length,6);
});
test('profile restart restores zones, paused remaining time and running deadlines',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ct-home-time-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new SettingsStore(root,'ru');await store.load();
  const value={...defaultHomeTime(),clocks:[{id:'moscow',label:'Москва',timeZone:'Europe/Moscow'},{id:'tokyo',label:'Токио',timeZone:'Asia/Tokyo'}],timers:[timerAction(timer,'start',Date.now()),{...timer,id:'pause',status:'paused',remainingMs:15000}]};
  await store.update({homeTime:value});
  const restarted=new SettingsStore(root,'ru');await restarted.load();assert.deepEqual(restarted.get().homeTime,value);
});
