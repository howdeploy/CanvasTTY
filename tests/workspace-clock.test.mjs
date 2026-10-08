import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

test("the first visible workspace clock subscriber gets a fresh snapshot immediately", async (t) => {
  const previousNow=Date.now;
  const previousDocument=Object.getOwnPropertyDescriptor(globalThis,"document");
  const previousWindow=Object.getOwnPropertyDescriptor(globalThis,"window");
  let now=1_000;
  let timer;
  let unsubscribe=()=>undefined;
  Date.now=()=>now;
  Object.defineProperty(globalThis,"document",{configurable:true,value:{hidden:false,addEventListener(){},removeEventListener(){}}});
  Object.defineProperty(globalThis,"window",{configurable:true,value:{
    setInterval(callback,interval){assert.equal(interval,1_000);timer=callback;return 1;},
    clearInterval(){timer=undefined;}
  }});
  t.after(()=>{
    unsubscribe();
    Date.now=previousNow;
    if(previousDocument)Object.defineProperty(globalThis,"document",previousDocument);else delete globalThis.document;
    if(previousWindow)Object.defineProperty(globalThis,"window",previousWindow);else delete globalThis.window;
  });

  const url=new URL("../src/renderer/src/features/workspace/visibleRefresh.ts",import.meta.url);
  url.searchParams.set("case",randomUUID());
  const {subscribeToWorkspaceClock,workspaceClockNow}=await import(url.href);
  now=2_000;
  let updates=0;
  unsubscribe=subscribeToWorkspaceClock(()=>{updates++;});
  assert.equal(workspaceClockNow(),2_000);
  assert.equal(updates,1);
  assert.equal(typeof timer,"function");
});
