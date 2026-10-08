import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalPasteMode } from "../src/main/services/TerminalPasteMode.ts";
import { fire, installMiniDom, typeInto } from "./helpers/mini-dom.mjs";

// react-dom detects the DOM when it is first evaluated, so the document must exist before the bundle loads.
const { document, restore } = installMiniDom();
const platformGlobals = new Map(["CompositionEvent", "requestAnimationFrame", "cancelAnimationFrame"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const compositionFrames = new Map(); let frameId = 0;
Object.assign(globalThis, {CompositionEvent: class {}, requestAnimationFrame: callback => {compositionFrames.set(++frameId, callback);return frameId;}, cancelAnimationFrame: id => compositionFrames.delete(id)});
after(() => {for (const [name,descriptor] of platformGlobals) {if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
after(restore);

// The terminal card's code (xterm) loads after the first frame. These tests mount the real deferred card with
// real React and a terminal import the test controls: delayed, failing, or a card that throws while rendering.
// React stays outside the bundle so the component and the test share Node's copy of it.
const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/renderer/src/features/terminal/DeferredTerminalCard.tsx", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  write: false,
  plugins: [{
    name: "node-react",
    setup(builder) {
      builder.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
    }
  }]
});
const { createComponentLoader, DeferredTerminalCard, useDeferredComponent } =
  await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);
const { createElement: h, act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");

const session = (id) => ({
  id, provider: "terminal", title: `Shell ${id}`, status: "running", startedAt: 1,
  position: { x: 0, y: 0 }, size: { width: 400, height: 300 }
});
const shortcuts = { terminalCopy: "Meta+C", terminalPaste: "Meta+V" };

/** What the real card does with input, without xterm: one field that sends what is typed to the PTY. */
function stubCard(broken = new Set()) {
  return function StubTerminalCard({ sessionId, focused }) {
    if (broken.has(sessionId)) throw new Error(`terminal ${sessionId} failed to draw`);
    return h("textarea", {
      "data-stub-card": sessionId,
      ref: (field) => { if (field && focused) field.focus(); },
      onInput: (event) => {
        const text = event.currentTarget.value;
        event.currentTarget.value = "";
        window.canvasTTY.terminal.input(sessionId, text);
      }
    });
  };
}

function Workspace({ loader, focusedId }) {
  const card = useDeferredComponent(loader, true);
  return h("main", null,
    h("section", { "data-other-surface": "browser" }, "Browser card"),
    ...["a", "b"].map((id) => h(DeferredTerminalCard, {
      key: id,
      card,
      inputHeld: false,
      loading: {
        session: session(id), locale: "en", borderSkin: "default", shortcuts, stackIndex: 1, fullscreen: false,
        selected: id === focusedId, groupSelected: false, focused: id === focusedId, focusRevision: 0,
        onInputHoldChange() {}, onSelect() {}
      },
      render: (Card) => h(Card, { sessionId: id, focused: id === focusedId })
    })));
}

function mount(t, loader, focusedId = "a") {
  const inputs = [];
  globalThis.canvasTTY = {
    terminal: { input: (id, text) => inputs.push([id, text]) },
    window: { isMacOS: true },
    clipboard: { hasImage: async () => false, readText: async () => "" }
  };
  const errors = [];
  t.mock.method(console, "error", (...args) => { errors.push(args.map(String).join(" ")); });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.parentNode?.removeChild(container);
    delete globalThis.canvasTTY;
  });
  const render = () => act(async () => root.render(h(Workspace, { loader, focusedId })));
  return { container, inputs, errors, render };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("keystrokes typed while the terminal code loads reach the PTY in order, then the loaded card takes over", async (t) => {
  const pending = deferred();
  const loader = createComponentLoader(() => pending.promise);
  const { container, inputs, render } = mount(t, loader);
  await render();

  const shells = container.querySelectorAll("article.terminal-card--loading");
  assert.equal(shells.length, 2, "both terminals show a loading shell");
  assert.equal(shells[0].getAttribute("aria-busy"), "true");
  const field = document.activeElement;
  assert.equal(field.tagName, "TEXTAREA", "the focused card's loading shell takes keystrokes");
  assert.equal(field.closest("article").getAttribute("data-session-id"), "a");

  await act(async () => {
    typeInto(field, "ec");
    fire(field, "keydown", { key: "Enter", code: "Enter", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false });
    typeInto(field, "ho");
  });
  assert.deepEqual(inputs, [["a", "ec"], ["a", "\r"], ["a", "ho"]], "typed text and keys are forwarded, in order");

  await act(async () => pending.resolve(stubCard()));
  assert.equal(container.querySelectorAll("article").length, 0, "the loading shells are gone");
  assert.equal(document.activeElement.getAttribute("data-stub-card"), "a", "the loaded card has the focus");
  await act(async () => { typeInto(document.activeElement, "!"); });
  assert.deepEqual(inputs.at(-1), ["a", "!"]);
  assert.equal(inputs.length, 4, "nothing typed before the swap was sent twice");
});

test("a failed terminal import affects only terminal cards and Retry loads them", async (t) => {
  let attempts = 0;
  const loader = createComponentLoader(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("chunk failed");
    return stubCard();
  });
  const { container, errors, render } = mount(t, loader);
  await render();

  assert.equal(container.querySelector("[data-other-surface]")?.textContent, "Browser card", "the rest of the window still renders");
  assert.equal(container.querySelectorAll("article.terminal-card--load-error").length, 2);
  assert.equal(container.querySelectorAll("[role=\"alert\"]").length, 2);
  assert.ok(errors.some((line) => line.includes("could not load the terminal panel")));

  await act(async () => { fire(container.querySelector("button"), "click"); });
  assert.equal(attempts, 2, "Retry requested the terminal code again");
  assert.equal(container.querySelectorAll("article").length, 0);
  assert.deepEqual(container.querySelectorAll("[data-stub-card]").map((node) => node.getAttribute("data-stub-card")), ["a", "b"]);
});

test("a terminal card that throws while drawing fails alone, and Retry mounts it again", async (t) => {
  const broken = new Set(["a"]);
  const Card = stubCard(broken);
  const loader = createComponentLoader(async () => Card);
  await loader.load();
  const { container, render } = mount(t, loader, "b");
  await render();

  assert.equal(container.querySelector("[data-other-surface]")?.textContent, "Browser card");
  const failed = container.querySelectorAll("article.terminal-card--load-error");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].getAttribute("data-session-id"), "a");
  assert.deepEqual(container.querySelectorAll("[data-stub-card]").map((node) => node.getAttribute("data-stub-card")), ["b"]);

  broken.delete("a");
  await act(async () => { fire(failed[0].querySelector("button"), "click"); });
  assert.equal(container.querySelectorAll("article").length, 0);
  assert.deepEqual(container.querySelectorAll("[data-stub-card]").map((node) => node.getAttribute("data-stub-card")), ["a", "b"]);
});


function HeldWorkspace({loader,row,holds}) {
 const card=useDeferredComponent(loader,true);const [held,setHeld]=useState(false);
 return h(DeferredTerminalCard,{card,inputHeld:held,loading:{session:row,locale:"en",borderSkin:"default",shortcuts,stackIndex:1,fullscreen:false,
  selected:true,groupSelected:false,focused:true,focusRevision:0,onRetry(){},onSelect(){},onInputHoldChange(active){holds.push(active);setHeld(active);}},
  render:Card=>h(Card,{sessionId:row.id,focused:true})});
}
async function mountHeld(t, options={}) {
 const loaded=deferred(),loader=createComponentLoader(()=>loaded.promise),reads=[],inputs=[],holds=[];
 const mode=new TerminalPasteMode();if(options.bracketed)mode.accept('\x1b[?2004h');
 globalThis.canvasTTY={terminal:{input:(id,text)=>inputs.push([id,text]),pasteClipboard:async(id,text,startedAt)=>{if(options.hostPaste)return options.hostPaste(id,text,startedAt);if(options.deliver)await options.deliver();if(row.id!==id||row.startedAt!==startedAt)throw Error('stale launch');inputs.push([id,mode.paste(text)]);}},window:{isMacOS:true},clipboard:{hasImage:async()=>false,readText:()=>{const next=deferred();reads.push(next);return next.promise;}}};
 const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);let row=options.row??session('held'),unmounted=false;
 const render=()=>act(async()=>root.render(h(HeldWorkspace,{loader,row,holds})));
 const unmount=async()=>{if(!unmounted){unmounted=true;await act(async()=>root.unmount());}};
 t.after(async()=>{await unmount();container.parentNode?.removeChild(container);delete globalThis.canvasTTY;});await render();
 const field=()=>container.querySelector('textarea');const shell=()=>container.querySelector('article.terminal-card--loading');
 const paste=()=>act(async()=>{fire(field(),'keydown',{key:'v',code:'KeyV',metaKey:true,ctrlKey:false,shiftKey:false,altKey:false});});
 const start=()=>act(async()=>{fire(field(),'compositionstart',{data:''});});
 const finish=(text='IME text')=>act(async()=>{const node=field();node.value=text;fire(node,'compositionend',{data:text});});
 return{container,loaded,reads,inputs,holds,field,shell,paste,start,finish,unmount,change:async patch=>{row={...row,...patch};await render();}};
}
for(const order of [[0,1],[1,0]])test(`loading shell holds both clipboard operations until final completion (${order})`,async t=>{
 const f=await mountHeld(t);await f.paste();await f.paste();assert.equal(f.reads.length,2);
 await act(async()=>f.loaded.resolve(stubCard()));assert.ok(f.shell());
 await act(async()=>f.reads[order[0]].resolve(`paste ${order[0]}`));assert.ok(f.shell(),'first completion cannot unmount another paste');
 assert.deepEqual(f.holds,[true]);await act(async()=>f.reads[order[1]].resolve(`paste ${order[1]}`));
 assert.equal(f.shell(),null);assert.deepEqual(f.inputs,order.map(i=>['held',`paste ${i}`]));assert.deepEqual(f.holds,[true,false]);
});
for(const first of ['paste','composition'])test(`paste and IME own independent loading holds (${first} finishes first)`,async t=>{
 const f=await mountHeld(t);await f.paste();await f.start();await f.start();await act(async()=>f.loaded.resolve(stubCard()));assert.ok(f.shell());
 if(first==='paste')await act(async()=>f.reads[0].resolve('paste'));else{await f.finish();await f.finish();}
 assert.ok(f.shell());assert.deepEqual(f.holds,[true]);
 if(first==='paste')await f.finish();else await act(async()=>f.reads[0].resolve('paste'));
 assert.equal(f.shell(),null);assert.deepEqual(f.holds,[true,false]);assert.deepEqual(f.inputs,first==='paste'?[['held','paste'],['held','IME text']]:[['held','IME text'],['held','paste']]);
});
test('rejected clipboard operation cannot release a second pending paste',async t=>{
 const f=await mountHeld(t);await f.paste();await f.paste();await act(async()=>f.loaded.resolve(stubCard()));
 await act(async()=>f.reads[0].reject(new Error('clipboard failed')));assert.ok(f.shell());assert.deepEqual(f.holds,[true]);
 await act(async()=>f.reads[1].resolve('kept'));assert.equal(f.shell(),null);assert.deepEqual(f.inputs,[['held','kept']]);assert.deepEqual(f.holds,[true,false]);
});
for(const transition of ['restart','session roundtrip','unmount'])test(`pending input does not escape loading shell ${transition}`,async t=>{
 const f=await mountHeld(t);await f.paste();await f.start();
 if(transition==='unmount'){await f.unmount();await act(async()=>f.reads[0].resolve('stale'));assert.deepEqual(f.inputs,[]);assert.deepEqual(f.holds,[true,false]);return;}
 if(transition==='restart')await f.change({startedAt:2});else{await f.change({id:'other'});await f.change({id:'held'});}
 await f.finish('stale IME');await f.paste();assert.equal(f.reads.length,2);
 await act(async()=>f.reads[0].resolve('stale'));assert.deepEqual(f.inputs,[]);assert.deepEqual(f.holds,[true,false,true]);
 await act(async()=>f.loaded.resolve(stubCard()));assert.ok(f.shell());await act(async()=>f.reads[1].resolve('new paste'));
 assert.equal(f.shell(),null);assert.deepEqual(f.inputs,[['held','new paste']]);assert.deepEqual(f.holds,[true,false,true,false]);
});
for(const bracketed of [true,false])test(`loading clipboard uses negotiated paste semantics for multiline text (bracketed=${bracketed})`,async t=>{
 const f=await mountHeld(t,{bracketed});await f.paste();await act(async()=>f.reads[0].resolve('first\nsecond\r\nthird\rfour'));
 assert.deepEqual(f.inputs,[['held',bracketed?'\x1b[200~first\rsecond\rthird\rfour\x1b[201~':'first\rsecond\rthird\rfour']]);
});
test('loading hold extends through host delivery and a restart rejects an already dispatched clipboard request',async t=>{
 const delivery=deferred();const f=await mountHeld(t,{bracketed:true,deliver:()=>delivery.promise});await f.paste();await act(async()=>f.reads[0].resolve('old\npaste'));
 await act(async()=>f.loaded.resolve(stubCard()));assert.ok(f.shell());assert.deepEqual(f.holds,[true]);
 await f.change({startedAt:2});await act(async()=>delivery.resolve());assert.deepEqual(f.inputs,[]);assert.deepEqual(f.holds,[true,false]);
});
test('loading image paste keeps native Ctrl-V instead of passing image bytes through text paste',async t=>{
 const f=await mountHeld(t,{bracketed:true});globalThis.canvasTTY.clipboard.hasImage=async()=>true;
 await f.paste();assert.deepEqual(f.inputs,[['held','\x16']]);assert.equal(f.reads.length,0);
});
test('real loading handler delivers overlapping multiline reads through host negotiated mode and emits user-input events',async t=>{
 let output;const writes=[];const manager=new TerminalManager(()=>{},{get:provider=>({state:'available',provider,executable:'/fixture/codex',launcher:'native',environment:{},checked:[]})},undefined,undefined,true,()=>({pid:51000,process:'codex',write:data=>writes.push(data),resize(){},kill(){},onData:fn=>{output=fn;return{dispose(){}};},onExit(){return{dispose(){}};}}));
 t.after(()=>manager.disposeAll());const row=manager.create({provider:'codex',profile:'normal',cwd:process.cwd(),position:{x:0,y:0}});
 const f=await mountHeld(t,{row,hostPaste:(...args)=>manager.pasteClipboard(...args)});const notices=[];
 t.mock.method(window,'dispatchEvent',event=>{if(event.type==='canvastty:terminal-input')notices.push(event.detail.sessionId);return true;});
 output('\x1b[?2004h');await f.paste();await f.paste();await act(async()=>f.loaded.resolve(stubCard()));
 await act(async()=>f.reads[1].resolve('two\nlines'));assert.ok(f.shell());
 await act(async()=>f.reads[0].resolve('first\r\nlast'));assert.equal(f.shell(),null);
 assert.deepEqual(writes,['\x1b[200~two\rlines\x1b[201~','\x1b[200~first\rlast\x1b[201~']);assert.deepEqual(notices,[row.id,row.id]);
});
