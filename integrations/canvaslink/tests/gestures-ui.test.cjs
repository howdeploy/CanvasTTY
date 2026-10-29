'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openUI}=require('../scripts/ui-test-harness.cjs');

async function fixture(t,options={}) {
 const ui=await openUI({width:1024,height:900,touch:true,connected:true,...options});
 t.after(async()=>{const unhandled=await ui.page.evaluate(()=>window.__unhandled||[]);await ui.browser.close();assert.deepEqual(ui.errors,[],'browser page/console errors');assert.deepEqual(unhandled,[],'unhandled API promises');});
 await ui.page.waitForFunction(()=>document.querySelector('#video').videoWidth===1280);
 await ui.page.evaluate(()=>{
  window.__gestureEvents=[];window.__viewEvents=[];window.__unhandled=[];
  window.addEventListener('canvaslink:pointer',e=>__gestureEvents.push(e.detail));
  window.addEventListener('canvaslink:view',e=>__viewEvents.push(e.detail));
  window.addEventListener('unhandledrejection',e=>__unhandled.push(String(e.reason)));
 });
 return ui;
}
test('fit/mode/reset preserve instrumentation, labels, icons and publish view state',async t=>{
 const {page}=await fixture(t);
 for(const selector of ['#fit #zoom-label','#mode #mode-label','#reset-view','#gesture-hint']){
  assert.equal(await page.locator(selector).count(),1,`production markup must contain ${selector}`);
 }
 await clear(page);await menu(page,'fit');
 const fit=await page.evaluate(()=>({matrix:getComputedStyle(document.getElementById('video')).transform,label:document.getElementById('zoom-label').textContent,view:__viewEvents.at(-1)}));
 assert.match(fit.matrix,/matrix\(2, 0, 0, 2,/);assert.match(fit.label,/200|2/);
 assert.deepEqual(fit.view,{scale:2,offset:{x:0,y:0},trackpad:false});
 await menu(page,'mode');
 assert.equal(await page.locator('#mode').getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator('#mode-label').textContent(),'Тачпад');
 assert.equal(await page.locator('#mode-label').count(),1,'mode label is preserved');
 assert.match(await page.locator('#gesture-hint').textContent(),/дв[ау]|2|пальц/i);
 await menu(page,'reset-view');
 assert.deepEqual(await page.evaluate(()=>__viewEvents.at(-1)),{scale:1,offset:{x:0,y:0},trackpad:true});
 await menu(page,'mode');assert.equal(await page.locator('#mode-label').textContent(),'Касание');
});

test('direct drag releases exactly once on viewport capture loss but ignores bubbled video loss',async t=>{
 const {page}=await fixture(t);const a=await area(page);await clear(page);
 await page.mouse.move(a.x-40,a.y);await page.mouse.down();await page.mouse.move(a.x+40,a.y);
 await page.evaluate(()=>document.querySelector('#video').dispatchEvent(new PointerEvent('lostpointercapture',{pointerId:1,bubbles:true})));
 assert.equal((await inputs(page)).filter(c=>c.input?.action==='up').length,0,'child capture transfer is not cancellation');
 await page.evaluate(()=>document.querySelector('#viewport').releasePointerCapture(1));
 await page.mouse.move(a.x+45,a.y);
 assert.equal((await inputs(page)).filter(c=>c.input?.action==='up').length,1,'capture loss releases before physical pointerup');
 await page.mouse.up();
 const values=(await inputs(page)).map(c=>c.input);
 assert.equal(values.filter(c=>c.action==='down').length,1);assert.equal(values.filter(c=>c.action==='up').length,1,'capture loss releases remote down');
 assert.equal(values.at(-1).action,'up','nothing follows the release');
 assert.deepEqual(await page.evaluate(()=>__gestureEvents.map(e=>({x:e.x,y:e.y,action:e.action,trackpad:e.trackpad}))),values.map(e=>({x:e.x,y:e.y,action:e.action,trackpad:false})));
});

test('blur ends a drag and a connection interruption cannot replay its tail',async t=>{
 const {page}=await fixture(t);const a=await area(page);await clear(page);
 await page.mouse.move(a.x-40,a.y);await page.mouse.down();await page.mouse.move(a.x+40,a.y);
 await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
 assert.deepEqual((await inputs(page)).filter(c=>c.input?.action!=='move').map(c=>c.input.action),['down','up']);
 await page.mouse.up();await clear(page);
 await page.mouse.move(a.x-40,a.y);await page.mouse.down();await page.mouse.move(a.x+40,a.y);
 await page.evaluate(()=>__uiFixture.emit({connection:'reconnecting'}));await clear(page);
 await page.evaluate(()=>__uiFixture.emit({connection:'connected'}));
 await page.mouse.move(a.x+60,a.y);await page.mouse.up();
 assert.deepEqual(await inputs(page),[],'interrupted gesture is discarded, not resumed');
});

test('editing suppresses pointer/wheel input and workspace touch restores safe keyboard ownership',async t=>{
 const {page}=await fixture(t);const a=await area(page);
 await page.evaluate(()=>{const e=document.createElement('input');e.id='local-test-editor';document.body.append(e);e.focus();});await clear(page);
 await page.touchscreen.tap(a.x,a.y);await page.mouse.move(a.x,a.y);await page.mouse.wheel(1,20);
 assert.deepEqual(await inputs(page),[],'no remote gestures while editing a prompt');
 await page.evaluate(()=>document.getElementById('local-test-editor').remove());await page.touchscreen.tap(a.x,a.y);await clear(page);
 assert.equal(await page.evaluate(()=>document.activeElement.id),'viewport','workspace takes explicit keyboard focus');
 await page.keyboard.down('Enter');await page.keyboard.down('Enter');await page.keyboard.up('Enter');
 const keys=await inputs(page);assert.deepEqual(keys,[{type:'key',key:'Enter',modifiers:[]}],'hardware autorepeat never repeats Enter');
});

test('trackpad two-finger pinch zooms locally without scrolling or a ghost tap',async t=>{
 const {page,context}=await fixture(t);const a=await area(page);await menu(page,'mode');await clear(page);
 const touch=await touchSession(context,page);
 await touch('touchStart',[[0,a.x-50,a.y],[1,a.x+50,a.y]]);
 await touch('touchMove',[[0,a.x-90,a.y],[1,a.x+90,a.y]]);
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await touch('touchEnd',[[1,a.x+90,a.y]]);await touch('touchEnd',[]);
 assert.deepEqual(await inputs(page),[],'pinch is local-only and never clicks');
 const view=await page.evaluate(()=>__viewEvents.at(-1));assert.ok(view&&view.scale>1.6&&view.scale<2,'trackpad pinch zooms');
 await page.touchscreen.tap(a.x,a.y);
 assert.deepEqual((await inputs(page)).map(c=>c.input.action),['down','up'],'next independent tap still works');
});

test('direct pinch keeps the off-centre content anchor and clamps local pan bounds',async t=>{
 const {page,context}=await fixture(t);const a=await area(page);const x=a.x+80,y=a.y;
 const touch=await touchSession(context,page);await clear(page);
 await page.touchscreen.tap(x,y);const before=(await inputs(page))[0].input;await clear(page);
 await touch('touchStart',[[0,x-50,y],[1,x+50,y]]);
 await touch('touchMove',[[0,x-100,y],[1,x+100,y]]);
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await touch('touchEnd',[]);
 const view=await page.evaluate(()=>__viewEvents.at(-1));
 assert.ok(Math.abs(view.scale-2)<.02);assert.ok(Math.abs(view.offset.x+80)<2,'anchor compensation');
 assert.deepEqual(await inputs(page),[],'direct pinch is local-only');
 await page.touchscreen.tap(x,y);const after=(await inputs(page))[0].input;
 assert.ok(Math.abs(before.x-after.x)<.003&&Math.abs(before.y-after.y)<.003,'same content remains under the pinch centre');
 await menu(page,'fit');await clear(page);
 await touch('touchStart',[[0,a.x-50,y],[1,a.x+50,y]]);
 await touch('touchMove',[[0,a.x-20,y+30],[1,a.x+80,y+30]]);
 await touch('touchEnd',[]);
 assert.deepEqual(await page.evaluate(()=>__viewEvents.at(-1)?.offset),{x:0,y:0},'fit cannot be panned outside the viewport');
});

test('trackpad motion returning to its origin is not mistaken for a tap',async t=>{
 const {page,context}=await fixture(t);const a=await area(page);await menu(page,'mode');await clear(page);
 const touch=await touchSession(context,page);
 await touch('touchStart',[[0,a.x,a.y]]);await touch('touchMove',[[0,a.x+70,a.y]]);await touch('touchMove',[[0,a.x,a.y]]);await touch('touchEnd',[]);
 const values=(await inputs(page)).map(c=>c.input);
 assert.ok(values.length>0);assert.ok(values.every(e=>e.action==='move'),'movement never becomes a click on release');
});

test('trackpad long-press drag releases once on touchcancel and cannot fire after a second finger',async t=>{
 const {page,context}=await fixture(t);const a=await area(page);await menu(page,'mode');await clear(page);const touch=await touchSession(context,page);
 await touch('touchStart',[[0,a.x,a.y]]);
 await page.waitForFunction(()=>__uiFixture.calls.some(c=>c.input?.action==='down'),{},{timeout:1500});
 await touch('touchMove',[[0,a.x+40,a.y+20]]);await touch('touchCancel',[]);
 assert.deepEqual((await inputs(page)).filter(c=>c.input.action!=='move').map(c=>c.input.action),['down','up']);
 assert.ok((await inputs(page)).some(c=>c.input.action==='move'&&c.input.drag===true),'held cursor moves as a drag');
 await clear(page);await touch('touchStart',[[0,a.x-30,a.y]]);
 await touch('touchStart',[[0,a.x-30,a.y],[1,a.x+30,a.y]]);await touch('touchEnd',[]);
 await page.waitForTimeout(550);assert.deepEqual(await inputs(page),[],'no delayed long-press after multitouch');
});

test('editing and mode switches safely release an existing down before discarding its tail',async t=>{
 const {page}=await fixture(t);let a=await area(page);await page.evaluate(()=>{const e=document.createElement('input');e.id='local-test-editor';document.body.append(e);});await page.locator('#viewport').focus();a=await area(page);await clear(page);
 await page.mouse.move(a.x-40,a.y);await page.mouse.down();await page.mouse.move(a.x+40,a.y);
 await page.locator('#local-test-editor').focus();
 assert.deepEqual((await inputs(page)).filter(c=>c.input.action!=='move').map(c=>c.input.action),['down','up'],'editor focus releases held remote button');
 await page.mouse.up();await page.locator('#viewport').focus();await clear(page);
 await page.mouse.move(a.x-40,a.y);await page.mouse.down();await page.mouse.move(a.x+40,a.y);
 await page.evaluate(()=>document.querySelector('#mode').click());
 assert.deepEqual((await inputs(page)).filter(c=>c.input.action!=='move').map(c=>c.input.action),['down','up'],'switching mode releases with the original mode');
 await clear(page);await page.mouse.move(a.x+70,a.y);await page.mouse.up();assert.deepEqual(await inputs(page),[]);
});

test('Ctrl-wheel pinch zooms locally at the pointer instead of sending remote scroll',async t=>{
 const {page}=await fixture(t);const a=await area(page);await clear(page);
 await page.mouse.move(a.x+60,a.y);await page.keyboard.down('Control');await page.mouse.wheel(0,-150);await page.keyboard.up('Control');
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.deepEqual(await inputs(page),[],'browser trackpad pinch must not scroll the remote terminal');
 const v=await page.evaluate(()=>__viewEvents.at(-1));assert.ok(v?.scale>1);assert.ok(v.offset.x<0,'zoom anchor follows the wheel pointer');
});

test('scroll deltas normalize wheel units and clamp the v2 payload',async t=>{
 const {page}=await fixture(t);const a=await area(page);await clear(page);
 await page.mouse.move(a.x,a.y);await page.mouse.wheel(9999,-9999);
 await page.waitForFunction(()=>__uiFixture.calls.some(c=>c.input?.type==='scroll'));
 assert.deepEqual((await inputs(page))[0].input,{type:'scroll',x:.5,y:.5,dx:2000,dy:-2000});
 await clear(page);
 await page.evaluate(()=>document.querySelector('#viewport').dispatchEvent(new WheelEvent('wheel',{clientX:500,clientY:300,deltaMode:1,deltaX:1,deltaY:2,bubbles:true,cancelable:true})));
 const line=(await inputs(page))[0].input;assert.equal(line.dx,16);assert.equal(line.dy,32);
});

test('two-finger trackpad translation scrolls once per centroid change and never clicks',async t=>{
 const {page,context}=await fixture(t);const a=await area(page);await menu(page,'mode');await clear(page);const touch=await touchSession(context,page);
 await touch('touchStart',[[0,a.x-50,a.y],[1,a.x+50,a.y]]);
 await touch('touchMove',[[0,a.x-30,a.y+30],[1,a.x+70,a.y+30]]);
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await touch('touchEnd',[[1,a.x+70,a.y+30]]);await touch('touchMove',[[1,a.x+80,a.y+40]]);await touch('touchEnd',[]);
 assert.deepEqual((await inputs(page)).map(c=>c.input),[{type:'scroll',x:.5,y:.5,dx:-20,dy:-30}]);
 assert.deepEqual(await page.evaluate(()=>__viewEvents),[],'translation does not change local zoom');
});

test('Settings swipe scrolls under the finger while slider movement stays a drag',async t=>{
 const {page,context}=await fixture(t);const a=await area(page),touch=await touchSession(context,page);
 await page.evaluate(()=>__uiFixture.emit({source:{target:'control',surface:'settings',dragRects:[]}}));await clear(page);
 await touch('touchStart',[[0,a.x,a.y+40]]);await touch('touchMove',[[0,a.x,a.y-40]]);await touch('touchEnd',[]);
 const scroll=(await inputs(page)).map(c=>c.input);assert.ok(scroll.length>0);assert.ok(scroll.every(c=>c.type==='scroll'));assert.ok(scroll[0].dy>0);
 await page.evaluate(()=>__uiFixture.emit({source:{target:'control',surface:'settings',dragRects:[{x:0,y:0,width:1,height:1}]}}));await clear(page);
 await touch('touchStart',[[0,a.x-40,a.y]]);await touch('touchMove',[[0,a.x+40,a.y]]);await touch('touchEnd',[]);
 const slider=(await inputs(page)).map(c=>c.input);assert.deepEqual(slider.filter(c=>c.action!=='move').map(c=>c.action),['down','up']);assert.ok(slider.every(c=>c.type==='pointer'));
});
test('Settings scrolling uses remote CSS units rather than high density video pixels',async t=>{
 const {page,context}=await fixture(t);const a=await area(page),touch=await touchSession(context,page);
 async function swipe(width){
  await page.evaluate(width=>__uiFixture.emit({source:{target:'control',surface:'settings',viewport:{width,height:800},dragRects:[]}}),width);await clear(page);
  await touch('touchStart',[[0,a.x,a.y+40]]);await touch('touchMove',[[0,a.x,a.y-40]]);await touch('touchEnd',[]);
  return (await inputs(page)).filter(c=>c.input.type==='scroll').reduce((sum,c)=>sum+c.input.dy,0);
 }
 const normal=await swipe(1280),dense=await swipe(640);assert.ok(normal>0);assert.ok(Math.abs(dense*2-normal)<.001);
});

test('pointer geometry uses contained video content at fit and zoom across portrait/landscape',async t=>{
 const {page}=await fixture(t,{width:390,height:844});
 for(const size of [{width:390,height:844},{width:844,height:390},{width:1280,height:800}]){
  await page.setViewportSize(size);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  for(let zoom=0;zoom<2;zoom++){
   if(zoom)await menu(page,'fit');
   const g=await page.evaluate(()=>{const v=document.querySelector('#video'),r=v.getBoundingClientRect(),p=document.querySelector('#viewport').getBoundingClientRect(),f=Math.min(r.width/v.videoWidth,r.height/v.videoHeight);return {left:r.left+(r.width-v.videoWidth*f)/2,top:r.top+(r.height-v.videoHeight*f)/2,width:v.videoWidth*f,height:v.videoHeight*f,p:{left:p.left,top:p.top,width:p.width,height:p.height}};});
   const at={x:g.left+g.width*.6,y:g.top+g.height*.55};assert.ok(at.x<g.p.left+g.p.width&&at.y<g.p.top+g.p.height,'target remains visible');
   await clear(page);await page.touchscreen.tap(at.x,at.y);
   const values=(await inputs(page)).map(c=>c.input);assert.deepEqual(values.map(e=>e.action),['down','up'],JSON.stringify({size,zoom,at,g,dom:await page.evaluate(({x,y})=>({at:document.elementFromPoint(x,y)?.outerHTML,active:document.activeElement.id,innerWidth,innerHeight}),at)}));
   for(const e of values){assert.ok(Math.abs(e.x-.6)<.006&&Math.abs(e.y-.55)<.006,'coordinates map to actual object-fit content');assert.equal(e.button,0);}
   if(zoom)await menu(page,'fit');
  }
 }
});

test('direct touch drag emits one down/move/up chain and cancel has no tap',async t=>{
 const {page,context}=await fixture(t);const a=await area(page);const touch=await touchSession(context,page);await clear(page);
 await touch('touchStart',[[0,a.x-40,a.y]]);await touch('touchMove',[[0,a.x,a.y]]);await touch('touchMove',[[0,a.x+40,a.y+20]]);await touch('touchEnd',[]);
 let values=(await inputs(page)).map(c=>c.input);assert.deepEqual(values.map(e=>e.action),['down','move','move','up']);assert.ok(values.every(e=>e.x>=0&&e.x<=1&&e.y>=0&&e.y<=1));
 await clear(page);await touch('touchStart',[[0,a.x,a.y]]);await touch('touchCancel',[]);assert.deepEqual(await inputs(page),[]);
});

test('sync throws and rejected API promises are consumed without input replay',async t=>{
 const {page}=await fixture(t);const a=await area(page);await clear(page);
 await page.evaluate(()=>{CanvasLinkClient.sendInput=()=>Promise.reject(Error('fixture rejection'));CanvasLinkClient.sendText=()=>Promise.reject(Error('fixture rejection'));CanvasLinkClient.sendKey=()=>{throw Error('fixture sync error');};});
 await page.touchscreen.tap(a.x,a.y);await page.keyboard.press('a');await page.keyboard.press('Enter');
 await page.evaluate(()=>{CanvasLinkClient.sendInput=()=>{throw Error('fixture sync error');};});
 await page.touchscreen.tap(a.x,a.y);await page.waitForTimeout(100);
 assert.deepEqual(await page.evaluate(()=>__unhandled),[]);assert.deepEqual(await inputs(page),[]);
});

test('capture acquisition failure cancels input without a browser exception',async t=>{
 const {page,errors}=await fixture(t);const a=await area(page);await clear(page);
 await page.evaluate(()=>document.querySelector('#viewport').setPointerCapture=()=>{throw new DOMException('Fixture capture race','NotFoundError');});
 await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(a.x+40,a.y);await page.mouse.up();
 assert.deepEqual(await inputs(page),[]);assert.deepEqual(errors,[],'capture race is handled');
});

test('a third finger suppresses the whole multitouch sequence until every contact ends',async t=>{
 const {page,context}=await fixture(t);const a=await area(page);const touch=await touchSession(context,page);await clear(page);
 await touch('touchStart',[[0,a.x-50,a.y],[1,a.x+50,a.y]]);
 await touch('touchStart',[[0,a.x-50,a.y],[1,a.x+50,a.y],[2,a.x,a.y+50]]);
 await touch('touchEnd',[[0,a.x-50,a.y],[1,a.x+50,a.y]]);
 await touch('touchMove',[[0,a.x-90,a.y],[1,a.x+90,a.y]]);
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await touch('touchEnd',[]);
 assert.deepEqual(await inputs(page),[]);assert.deepEqual(await page.evaluate(()=>__viewEvents),[],'no resumed pair or zoom jump after third contact');
 await page.touchscreen.tap(a.x,a.y);assert.deepEqual((await inputs(page)).map(c=>c.input.action),['down','up']);
});

test('an open HTML dialog owns Escape and hardware keys instead of the terminal',async t=>{
 const {page}=await fixture(t);await clear(page);
 const prevented=await page.evaluate(()=>{
  document.querySelector('#diagnostics').show();const v=document.querySelector('#viewport');v.focus();
  const e=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});v.dispatchEvent(e);return e.defaultPrevented;
 });
 assert.equal(prevented,false,'gesture layer must not cancel dialog Escape');assert.deepEqual(await inputs(page),[]);
 await page.evaluate(()=>document.querySelector('#diagnostics').close());
 for(const [button,dialog]of [['#diagnostics-toggle','#diagnostics'],['#disconnect','#disconnect-dialog']]){
  await page.locator('#menu-toggle').click();await page.locator(button).click();await page.waitForFunction(selector=>document.querySelector(selector).open,dialog);
  await page.keyboard.press('Escape');await page.waitForFunction(selector=>!document.querySelector(selector).open,dialog);
 }
 assert.deepEqual(await inputs(page),[],'real native dialog Escape does not send a remote key');
});

test('zoom stays bounded and survives composer/viewport resize without resetting the view',async t=>{
 const {page}=await fixture(t);const a=await area(page);await menu(page,'fit');
 const before=await page.locator('#video').evaluate(el=>el.style.transform);
 await page.setViewportSize({width:1024,height:650});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.locator('#video').evaluate(el=>el.style.transform),before,'keyboard/layout changes preserve the user view');
 const v=await area(page);await clear(page);
 await page.mouse.move(v.x,v.y);await page.keyboard.down('Control');await page.mouse.wheel(0,-99999);
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.evaluate(()=>__viewEvents.at(-1).scale),8);
 await page.mouse.wheel(0,99999);await page.keyboard.up('Control');
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.evaluate(()=>__viewEvents.at(-1).scale),1);assert.deepEqual(await inputs(page),[]);
});

test('trackpad cursor starts at the last direct tap and relative movement stays normalized',async t=>{
 const {page,context}=await fixture(t);const a=await area(page);await page.touchscreen.tap(a.x+40,a.y);const start=(await inputs(page))[0].input;
 await menu(page,'mode');await clear(page);const touch=await touchSession(context,page);
 await touch('touchStart',[[0,a.x,a.y]]);await touch('touchMove',[[0,a.x+50,a.y+20]]);await touch('touchEnd',[]);
 const values=(await inputs(page)).map(c=>c.input);assert.ok(values.length>0&&values.every(v=>v.action==='move'));
 assert.ok(Math.abs(values.at(-1).x-(start.x+50/a.width))<.005,'relative movement has no cursor jump');
 assert.ok(values.every(v=>v.x>=0&&v.x<=1&&v.y>=0&&v.y<=1));
});

const inputs=page=>page.evaluate(()=>__uiFixture.calls.filter(c=>['input','key','text'].includes(c.type)));
const clear=page=>page.evaluate(()=>{__uiFixture.calls.length=0;__gestureEvents.length=0;__viewEvents.length=0;});
async function area(page){const b=await page.locator('#viewport').boundingBox();assert.ok(b&&b.width>0&&b.height>0,'visible viewport');return {x:b.x+b.width/2,y:b.y+b.height/2,width:b.width,height:b.height,left:b.x,top:b.y};}
async function touchSession(context,page){
 const cdp=await context.newCDPSession(page);
 return async(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([id,x,y])=>({id,x,y,radiusX:2,radiusY:2,force:1}))});
}

test('connection boundary blocks gestures and never replays them on reconnect',async t=>{
 const {page}=await fixture(t);const a=await area(page);
 await page.evaluate(()=>__uiFixture.emit({connection:'reconnecting'}));await clear(page);
 await page.touchscreen.tap(a.x,a.y);await page.mouse.move(a.x,a.y);await page.mouse.wheel(30,80);
 await page.evaluate(()=>__uiFixture.emit({connection:'suspended'}));
 await page.touchscreen.tap(a.x,a.y);
 await page.evaluate(()=>__uiFixture.emit({connection:'connected'}));
 assert.deepEqual(await inputs(page),[],'no offline call or delayed replay');
});

test('hardware keys leave native button activation and editor/IME handling intact',async t=>{
 const {page}=await fixture(t);await clear(page);
 await page.locator('#menu-toggle').click();await page.locator('#mode').focus();await page.keyboard.press('Enter');
 assert.equal(await page.locator('#mode').getAttribute('aria-pressed'),'true','Enter activates the UI button');
 assert.deepEqual(await inputs(page),[],'UI activation is not remote Enter');
 await page.evaluate(()=>{const e=document.createElement('input');e.id='local-test-editor';document.body.append(e);e.focus();});
 await page.keyboard.type('safe');await page.keyboard.press('Enter');
 assert.deepEqual(await inputs(page),[],'composer owns hardware input');
 await page.evaluate(()=>{
  const host=document.createElement('div');host.innerHTML='<select id="test-select"><option>one</option></select><div id="test-edit" contenteditable="plaintext-only"><span>edit</span></div>';
  document.body.append(host);
  for(const selector of ['#test-select','#test-edit span']){
   document.querySelector(selector).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  }
  const v=document.querySelector('#viewport');v.tabIndex=0;v.focus();
  v.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));
  v.dispatchEvent(new KeyboardEvent('keydown',{key:'a',keyCode:229,bubbles:true,cancelable:true}));
 });
 assert.deepEqual(await inputs(page),[],'select, contenteditable and IME are never intercepted');
});

async function menu(page,id){await page.locator('#menu-toggle').click();await page.locator('#'+id).click();}
