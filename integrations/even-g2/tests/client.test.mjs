import { MORE_AGENTS } from "../src/create-menu.mjs";
import { CANVAS_LAUNCHER_ITEMS } from "../../../src/shared/contracts.ts";
import { normalizeSessionTitle } from "../../../src/shared/companion.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as sdk from "@evenrealities/even_hub_sdk";
import { HudBridge } from "../src/hud-bridge.mjs";
import { ViewModel, Gestures, STATUS } from "../src/model.mjs";
import { validatePairing } from "../src/pairing.mjs";
import { inputEvent } from "../src/input.mjs";

const source = readFileSync(
  new URL("../src/main.mjs", import.meta.url),
  "utf8",
).replace(/^import\b[\s\S]*?;\n/gm, "");
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
};
class Element {
  constructor() {
    this.textContent = "";
    this.value = "";
    this.dataset = {};
    this.children = [];
    this.classList = { toggle() {} };
    this.details = { open: true };
  }
  replaceChildren() {
    this.children = [];
  }
  append(child) {
    this.children.push(child);
  }
  get childNodes() {
    return this.children;
  }
  closest() {
    return this.details;
  }
}
async function harness({ localOnly = false } = {}) {
  const key = "a".repeat(64),
    elements = new Map(),
    buttons = ["codex", "terminal", ...CANVAS_LAUNCHER_ITEMS.filter(p => p !== "codex" && p !== "terminal")].map(provider => {
      const button = new Element(); button.dataset.new = provider; return button;
    });
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const sessions = [
    { id: "existing", title: "Codex · G2", provider: "codex", status: "idle" },
  ];
  const requests = [],
    frames = [],
    exits = [],
    micCalls = [],
    timers = new Map();
  const saved = [],
    enteredCodes = [];
  const localTarget = {
    version: 1,
    computer: "c".repeat(64),
    key: "d".repeat(64),
    origins: ["http://192.168.2.108:3481"],
  };
  let nextTimer = 0,
    callback,
    page,
    failTerminal = false,
    audioImpl = async () => true,
    interaction = null;
  const native = {
    getDeviceInfo: async () => ({}),
    onEvenHubEvent: (cb) => {
      callback = cb;
    },
    getLocalStorage: async () => (localOnly ? "" : key),
    setLocalStorage: async (name, value) => {
      saved.push({ name, value });
      return true;
    },
    audioControl: (on, source) => {
      micCalls.push({ on, source });
      return audioImpl(on, source);
    },
    createStartUpPageContainer: async (p) => {
      page = p;
      return 0;
    },
    textContainerUpgrade: async (p) => {
      frames.push(p.content);
      return true;
    },
    shutDownPageContainer: async (mode) => {
      exits.push(mode);
      return true;
    },
  };
  const context = {
    LOCAL_ONLY: localOnly,
    MORE_AGENTS,
    connectionFromCode: async (value) => {
      enteredCodes.push(value);
      return { connection: localTarget, code: "123456" };
    },
    localFetcher: (connection) =>
      Object.assign((url, options) => context.fetch(url, options), {
        connection: () => connection,
      }),
    BRIDGE_ORIGIN: "http://127.0.0.1:3480",
    sdk: { ...sdk, waitForEvenAppBridge: async () => native },
    HudBridge,
    ViewModel,
    Gestures,
    STATUS,
    normalizeSessionTitle,
    validatePairing,
    inputEvent,
    document: {
      getElementById: el,
      querySelectorAll: (selector) =>
        selector === "[data-new]" ? buttons : [],
      createElement: () => new Element(),
    },
    window: { addEventListener() {} },
    location: { hash: "" },
    history: { replaceState() {} },
    URLSearchParams,
    AbortController,
    AbortSignal,
    pairComputer: async (base, code, options) => {
      if (!localOnly) throw new Error("pairing rejected");
      assert.equal(code, "123456");
      options.onPending();
      return {
        token: key,
        home: await (
          await options.fetcher(base + "/g2/api/home", {
            headers: { Authorization: "Bearer " + key },
          })
        ).json(),
      };
    },
    Uint8Array,
    Date,
    btoa,
    crypto: globalThis.crypto,
    setInterval: () => 1,
    setTimeout: (cb, ms) => {
      const id = ++nextTimer;
      timers.set(id, { cb, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, options) => {
      requests.push({
        path: new URL(url).pathname,
        authorization: options.headers.Authorization,
        body: options.body ? JSON.parse(options.body) : null,
      });
      if (options.headers.Authorization !== "Bearer " + key)
        return { ok: false };
      const path = new URL(url).pathname;
      let data;
      if (path === "/g2/api/home")
        data = {
          sessions: sessions.map((s) => ({ ...s })),
          limits: null,
          speechAvailable: true,
          speechModel: "Nemotron 3.5 (Handy)",
          features: {
            terminalChoices: true,
            manualInput: true,
            sessionClose: true,
            projectBrowser: true,
            sessionCreate: true,
            sessionRename: true,
          },
        };
      if (path === "/g2/api/terminal") {
        if (failTerminal) throw new Error("Timeout");
        const session = sessions.find(
          (s) => s.id === new URL(url).searchParams.get("id"),
        );
        data = {
          session: { ...session },
          body: "Понг.",
          revision: interaction?.id || "1",
          interaction,
        };
      }
      if (path === "/g2/api/create") {
        const provider = JSON.parse(options.body).provider;
        const session = {
          id: "new-" + sessions.length,
          title: provider,
          provider,
          status: "idle",
        };
        sessions.push(session);
        data = { session };
      }
      if (path === "/g2/api/session-rename") {
        const body = JSON.parse(options.body),
          session = sessions.find((session) => session.id === body.sessionId);
        session.title = body.title;
        data = { session: { ...session } };
      }
      if (path === "/g2/api/voice")
        data = { accepted: true, transcript: "Бот поддержки" };
      if (path === "/g2/api/control") {
        interaction = null;
        data = { accepted: true };
      }
      if (path === "/g2/api/session-close") {
        const body = JSON.parse(options.body);
        const i = sessions.findIndex((s) => s.id === body.sessionId);
        if (i >= 0) sessions.splice(i, 1);
        data = { closed: true };
      }
      if (path === "/g2/api/browser")
        data = {
          opened: true,
          title: "Project",
          url: "http://127.0.0.1:5173/",
        };
      return { ok: true, json: async () => data };
    },
  };
  await vm.runInNewContext(`(async()=>{${source}\n})()`, context);
  await flush();
  return {
    el,
    saved,
    enteredCodes,
    buttons,
    requests,
    frames,
    exits,
    micCalls,
    setMenu: (value) => {
      interaction = value;
    },
    setAudio: (fn) => {
      audioImpl = fn;
    },
    timeout: async (ms) => {
      for (const t of [...timers.values()].filter((t) => t.ms === ms)) t.cb();
      await flush();
    },
    pressVoice: async () => {
      el("voice").onpointerdown({
        preventDefault() {},
        currentTarget: { setPointerCapture() {} },
        pointerId: 1,
      });
      await flush();
    },
    get page() {
      return page;
    },
    fail: () => {
      failTerminal = true;
    },
    event: async (e) => {
      callback(e);
      await flush();
    },
    poll: async () => {
      const timer = [...timers.values()].find((t) => t.ms === 1200);
      assert.ok(timer);
      timer.cb();
      await flush();
    },
  };
}
test("blank repeat pairing and rejected replacement preserve authentication for open and create", async () => {
  const h = await harness();
  await h.el("pair").onsubmit({ preventDefault() {} });
  h.el("token").value = "b".repeat(64);
  await h.el("pair").onsubmit({ preventDefault() {} });
  h.el("sessions").children[0].onclick();
  await flush();
  assert.equal(h.el("answer").textContent, "Понг.");
  await h.buttons[0].onclick();
  await h.buttons[1].onclick();
  assert.equal(h.requests.filter((r) => r.path === "/g2/api/create").length, 2);
  assert.match(h.el("summary").textContent, /3 терминалов/);
  assert.equal(h.el("answer").textContent, "Понг.");
});
test("real SDK startup declares valid OS menu and overlay dismissal keeps polling alive", async () => {
  const h = await harness();
  assert.equal(sdk.validateEvenHubPageContainer(h.page).valid, true);
  assert.deepEqual(
    h.page.menuObject.menuItems.map((i) => i.itemName),
    [
      "Home CanvasTTY",
      "New Codex",
      "New Terminal",
      "Close Terminal",
      "Project Browser",
      "Rename Terminal",
      "More agents",
    ],
  );
  await h.event({
    sysEvent: { eventType: sdk.OsEventTypeList.FOREGROUND_ENTER_EVENT },
  });
  await h.event({ menuItemClickEvent: { itemID: 2 } });
  await h.event({
    sysEvent: { eventType: sdk.OsEventTypeList.FOREGROUND_EXIT_EVENT },
  });
  const count = h.requests.length;
  await h.poll();
  assert.ok(h.requests.length > count);
  assert.equal(h.el("connection").textContent, "Компьютер подключён · G2");
  assert.equal(h.el("answer").textContent, "Понг.");
  assert.match(h.frames.at(-1), /Понг/);
  await h.event({ menuItemClickEvent: { itemID: 1 } });
  assert.match(h.frames.at(-1), /CANVASTTY · HOME/);
  await h.event({ menuItemClickEvent: { itemID: 3 } });
  assert.equal(h.requests.filter((r) => r.path === "/g2/api/create").length, 2);
});
test("motion and untyped messages do not open terminals", async () => {
  const h = await harness();
  await h.event({ sysEvent: { imuData: { x: 1, y: 0, z: 0 } } });
  await h.event({ jsonData: { unrelated: true } });
  assert.match(h.frames.at(-1), /CANVASTTY · HOME/);
});
test("a failed refresh preserves cached answer and reports disconnection", async () => {
  const h = await harness();
  h.fail();
  h.el("sessions").children[0].onclick();
  await flush();
  assert.equal(h.el("answer").textContent, "Понг.");
  await h.poll();
  assert.equal(h.el("connection").textContent, "Компьютер недоступен");
});
test("root double tap requests system confirmation and cancelling leaves display operational", async () => {
  const h = await harness();
  await h.event({
    sysEvent: { eventType: sdk.OsEventTypeList.DOUBLE_CLICK_EVENT },
  });
  assert.deepEqual(h.exits, [1]);
  await h.event({
    sysEvent: { eventType: sdk.OsEventTypeList.FOREGROUND_ENTER_EVENT },
  });
  await h.event({
    sysEvent: { eventType: sdk.OsEventTypeList.FOREGROUND_EXIT_EVENT },
  });
  h.el("sessions").children[0].onclick();
  await flush();
  await h.poll();
  assert.match(h.frames.at(-1), /Понг/);
  assert.equal(h.el("connection").textContent, "Компьютер подключён · G2");
});
test("double tap in a terminal returns Home without requesting exit", async () => {
  const h = await harness();
  h.el("sessions").children[0].onclick();
  await flush();
  await h.event({
    sysEvent: { eventType: sdk.OsEventTypeList.DOUBLE_CLICK_EVENT },
  });
  assert.deepEqual(h.exits, []);
  assert.match(h.frames.at(-1), /CANVASTTY · HOME/);
});
test("real SDK default-zero sys and text clicks open the selected session", async () => {
  for (const type of ["sysEvent", "textEvent", "listEvent"]) {
    const h = await harness();
    await h.event(sdk.evenHubEventFromJson({ type, jsonData: {} }));
    assert.equal(h.el("answer").textContent, "Понг.", type);
    assert.match(h.frames.at(-1), /Понг/);
  }
});
test("explicit system action is not shadowed by an empty text event", async () => {
  const h = await harness();
  h.el("sessions").children[0].onclick();
  await flush();
  await h.event({ textEvent: {}, sysEvent: { eventType: 3 } });
  assert.match(h.frames.at(-1), /CANVASTTY · HOME/);
});
test("settled microphone rejection keeps Home and permits a fresh explicit hold", async () => {
  const h = await harness();
  h.el("sessions").children[0].onclick();
  await flush();
  h.setAudio(async () => false);
  await h.pressVoice();
  assert.equal(h.el("voice").disabled, false);
  assert.match(h.el("mic-status").textContent, /не подтвержден/);
  await h.event({ sysEvent: { eventType: 3 } });
  assert.match(h.frames.at(-1), /CANVASTTY · HOME/);
  assert.match(h.frames.at(-1), /Микрофон/);
  assert.doesNotMatch(h.frames.at(-1), /СЛУШАЮ/);
  h.setAudio(async () => true);
  h.el("sessions").children[0].onclick();
  await flush();
  assert.equal(h.el("voice").disabled, false);
  await h.pressVoice();
  assert.match(h.el("voice").textContent, /Говорите/);
  await h.el("mic-stop").onclick();
  await flush();
  assert.deepEqual(
    h.micCalls.map((c) => c.on),
    [true, false, true, false],
  );
  assert.equal(h.requests.filter((r) => r.path === "/g2/api/voice").length, 0);
});
test("unsettled microphone keeps phone navigation usable and defers glasses writes until late ACK and off", async () => {
  const h = await harness();
  h.el("sessions").children[0].onclick();
  await flush();
  let finish;
  h.setAudio((on) =>
    on
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(true),
  );
  await h.pressVoice();
  assert.match(h.el("voice").textContent, /Включаю/);
  assert.doesNotMatch(h.el("voice").textContent, /Говорите/);
  h.el("home").onclick();
  await flush();
  assert.match(h.el("hud").textContent, /CANVASTTY · HOME/);
  assert.match(h.frames.at(-1), /ВКЛЮЧАЮ МИКРОФОН/);
  await h.timeout(2500);
  assert.match(h.el("hud").textContent, /CANVASTTY · HOME/);
  assert.match(h.frames.at(-1), /ВКЛЮЧАЮ МИКРОФОН/);
  assert.deepEqual(
    h.micCalls.map((c) => c.on),
    [true],
  );
  await h.event({ sysEvent: { eventType: 3 } });
  assert.deepEqual(h.exits, [1]);
  finish(true);
  await flush();
  assert.deepEqual(
    h.micCalls.map((c) => c.on),
    [true, false],
  );
  assert.match(h.frames.at(-1), /CANVASTTY · HOME/);
  assert.equal(h.requests.filter((r) => r.path === "/g2/api/voice").length, 0);
});
test("microphone stop timeout does not block selecting another terminal", async () => {
  const h = await harness();
  h.el("sessions").children[0].onclick();
  await flush();
  await h.pressVoice();
  h.setAudio(() => new Promise(() => {}));
  h.el("home").onclick();
  await flush();
  await h.timeout(2500);
  assert.match(h.frames.at(-1), /CANVASTTY · HOME/);
  h.el("sessions").children[0].onclick();
  await flush();
  assert.equal(h.el("answer").textContent, "Понг.");
  assert.match(h.el("mic-status").textContent, /Жду завершения/);
  assert.equal(h.el("voice").disabled, true);
});
test("startup and navigation do not probe off before the first explicit microphone enable", async () => {
  const h = await harness();
  assert.deepEqual(h.micCalls, []);
  assert.match(h.el("mic-status").textContent, /ещё не включался/);
  h.el("sessions").children[0].onclick();
  await flush();
  assert.equal(h.el("voice").disabled, false);
  assert.deepEqual(h.micCalls, []);
  h.setAudio((on) => Promise.resolve(on));
  await h.pressVoice();
  assert.equal(h.micCalls[0].on, true);
  assert.match(h.el("voice").textContent, /Говорите/);
  h.el("home").onclick();
  await flush();
  assert.match(h.el("mic-status").textContent, /не подтвержден/);
});
test("microphone self-test counts G2 PCM and stops without an ASR or agent request", async () => {
  const h = await harness();
  await h.el("mic-test").onclick();
  await flush();
  await h.event({
    audioEvent: {
      source: sdk.AudioInputSource.Glasses,
      audioPcm: new Uint8Array(32000),
    },
  });
  await h.timeout(2000);
  assert.deepEqual(
    h.micCalls.map((c) => c.on),
    [true, false],
  );
  assert.match(h.el("notice").textContent, /32000/);
  assert.equal(
    h.requests.some(
      (r) => r.path === "/g2/api/voice" || r.path === "/g2/api/control",
    ),
    false,
  );
});
const testMenu = {
  kind: "choices",
  id: "menu-one",
  title: "Выберите базу",
  options: [
    { number: 1, label: "SQLite" },
    { number: 2, label: "Postgres" },
    { number: 3, label: "Type something else" },
  ],
  selected: 0,
  customIndex: 2,
};
test("swipe highlights an option locally, click submits it once with its menu id", async () => {
  const h = await harness();
  h.setMenu(testMenu);
  h.el("sessions").children[0].onclick();
  await flush();
  await h.event({ textEvent: { eventType: 2 } });
  await h.poll();
  assert.match(h.frames.at(-1), /Postgres/);
  assert.equal(
    h.requests.some((r) => r.path === "/g2/api/control"),
    false,
  );
  await h.event({ sysEvent: {} });
  const sent = h.requests.filter((r) => r.path === "/g2/api/control");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.index, 1);
  assert.equal(sent[0].body.menuId, "menu-one");
  assert.equal(sent[0].body.sessionId, "existing");
});
test("holding a choice selects explicit custom input without starting the microphone", async () => {
  const h = await harness();
  h.setMenu(testMenu);
  h.el("sessions").children[0].onclick();
  await flush();
  await h.event({ sysEvent: { eventType: 9 } });
  await h.event({ sysEvent: { eventType: 10 } });
  const sent = h.requests.find((r) => r.path === "/g2/api/control");
  assert.equal(sent.body.action, "custom");
  assert.deepEqual(h.micCalls, []);
  h.el("draft").value = "Мой текст";
  await h.el("manual").onsubmit({ preventDefault() {} });
  assert.equal(h.requests.at(-1).body.text, "Мой текст");
});
test("hold does not pick a non-custom last approval option", async () => {
  const h = await harness();
  h.setMenu({ ...testMenu, id: "approval", customIndex: null });
  h.el("sessions").children[0].onclick();
  await flush();
  await h.event({ sysEvent: { eventType: 9 } });
  await h.event({ sysEvent: { eventType: 10 } });
  assert.equal(
    h.requests.some((r) => r.path === "/g2/api/control"),
    false,
  );
  assert.deepEqual(h.micCalls, []);
});

test("closing from the glasses menu defaults to cancel; only an explicit selection closes the captured terminal", async () => {
  const h = await harness();
  await h.event({ menuItemClickEvent: { itemID: 4 } });
  assert.match(h.frames.at(-1), /ЗАКРЫТЬ ТЕРМИНАЛ/);
  await h.event({ sysEvent: { eventType: 9 } });
  await h.event({ sysEvent: { eventType: 10 } });
  assert.equal(
    h.requests.some((r) => r.path === "/g2/api/session-close"),
    false,
  );
  await h.event({ sysEvent: { eventType: 0 } });
  assert.equal(
    h.requests.some((r) => r.path === "/g2/api/session-close"),
    false,
  );
  await h.event({ menuItemClickEvent: { itemID: 4 } });
  await h.event({ sysEvent: { eventType: 2 } });
  await h.event({ sysEvent: { eventType: 0 } });
  const closes = h.requests.filter((r) => r.path === "/g2/api/session-close");
  assert.equal(closes.length, 1);
  assert.equal(closes[0].body.sessionId, "existing");
  assert.match(h.el("summary").textContent, /0 терминалов/);
  assert.match(h.frames.at(-1), /CANVASTTY · HOME/);
});

test("project browser menu uses the selected terminal and reports the actual browser result", async () => {
  const h = await harness();
  await h.event({ menuItemClickEvent: { itemID: 5 } });
  const opens = h.requests.filter((r) => r.path === "/g2/api/browser");
  assert.equal(opens.length, 1);
  assert.equal(opens[0].body.sessionId, "existing");
  assert.match(h.frames.at(-1), /Браузер открыт на Mac/);
  assert.match(h.el("notice").textContent, /127.0.0.1:5173/);
});

test("phone rename changes the captured session without sending a command", async () => {
  const h = await harness();
  await h.event({ menuItemClickEvent: { itemID: 6 } });
  assert.match(h.frames.at(-1), /ПЕРЕИМЕНОВАТЬ/);
  h.el("rename-input").value = "Бот поддержки";
  h.el("rename-input").oninput();
  await h.el("rename-form").onsubmit({ preventDefault() {} });
  await flush();
  const names = h.requests.filter((r) => r.path === "/g2/api/session-rename");
  assert.equal(names.length, 1);
  assert.equal(names[0].body.sessionId, "existing");
  assert.equal(names[0].body.title, "Бот поддержки");
  assert.equal(
    h.requests.some((r) => r.path === "/g2/api/control"),
    false,
  );
  assert.match(h.el("notice").textContent, /Новое имя/);
});

test("glasses rename dictation previews the name and requires an explicit save choice", async () => {
  const h = await harness();
  await h.event({ menuItemClickEvent: { itemID: 6 } });
  await h.event({
    sysEvent: { eventType: sdk.OsEventTypeList.LONG_PRESS_EVENT },
  });
  await h.event({
    audioEvent: {
      source: sdk.AudioInputSource.Glasses,
      audioPcm: new Uint8Array(32000),
    },
  });
  await h.event({
    sysEvent: { eventType: sdk.OsEventTypeList.LONG_PRESS_RELEASE_EVENT },
  });
  const audio = h.requests.find((r) => r.path === "/g2/api/voice");
  assert.equal(audio.body.purpose, "rename");
  assert.equal(audio.body.sessionId, "existing");
  assert.match(h.frames.at(-1), /Бот поддержки/);
  assert.equal(
    h.requests.some(
      (r) =>
        r.path === "/g2/api/session-rename" || r.path === "/g2/api/control",
    ),
    false,
  );
  await h.event({
    sysEvent: { eventType: sdk.OsEventTypeList.SCROLL_BOTTOM_EVENT },
  });
  await h.event({ sysEvent: { eventType: sdk.OsEventTypeList.CLICK_EVENT } });
  assert.equal(
    h.requests.filter((r) => r.path === "/g2/api/session-rename").length,
    1,
  );
});

test("double tap cancels renaming without issuing any change", async () => {
  const h = await harness();
  await h.event({ menuItemClickEvent: { itemID: 6 } });
  h.el("rename-input").value = "Не сохранять";
  h.el("rename-input").oninput();
  await h.event({
    sysEvent: { eventType: sdk.OsEventTypeList.DOUBLE_CLICK_EVENT },
  });
  assert.equal(
    h.requests.some((r) => r.path === "/g2/api/session-rename"),
    false,
  );
  assert.match(h.frames.at(-1), /CANVASTTY · HOME/);
});

test("failed OFF can recover from a glasses hold without sending discarded audio", async () => {
  const h = await harness();
  h.el("sessions").children[0].onclick();
  await flush();
  await h.event({ sysEvent: { eventType: 9 } });
  await h.event({
    audioEvent: {
      source: sdk.AudioInputSource.Glasses,
      audioPcm: new Uint8Array(32000),
    },
  });
  h.setAudio(async () => false);
  await h.event({ sysEvent: { eventType: 10 } });
  assert.equal(h.el("voice").disabled, false);
  assert.equal(h.requests.filter((r) => r.path === "/g2/api/voice").length, 0);
  h.setAudio(async () => true);
  await h.event({ sysEvent: { eventType: 9 } });
  assert.match(h.el("voice").textContent, /Говорите/);
  await h.event({
    audioEvent: {
      source: sdk.AudioInputSource.Glasses,
      audioPcm: new Uint8Array(32000),
    },
  });
  await h.event({ sysEvent: { eventType: 10 } });
  assert.deepEqual(
    h.micCalls.map((c) => c.on),
    [true, false, true, false],
  );
  assert.equal(h.requests.filter((r) => r.path === "/g2/api/voice").length, 1);
});

test("microphone failure telemetry survives navigation noise", async () => {
  const h = await harness();
  h.el("sessions").children[0].onclick();
  await flush();
  h.setAudio(async () => false);
  await h.pressVoice();
  for (let i = 0; i < 35; i++) await h.event({ textEvent: { eventType: 2 } });
  await h.poll();
  const state = h.requests
    .filter((r) => r.path === "/g2/api/device-state")
    .at(-1).body;
  assert.ok(
    state.diagnostics.some((line) => line.includes("mic:off ack=false")),
  );
  assert.ok(state.diagnostics.length <= 24);
});

test("code-only phone form resolves the typed code, pairs, and persists the entire local connection", async () => {
  const h = await harness({ localOnly: true });
  h.el("token").value = "123456";
  await h.el("pair").onsubmit({ preventDefault() {} });
  await flush();
  assert.deepEqual(h.enteredCodes, ["123456"]);
  assert.match(h.el("connection").textContent, /Компьютер подключён/);
  assert.equal(h.saved[0].name, "canvastty.g2.local.v1");
  assert.equal(
    JSON.parse(h.saved[0].value).connection.origins[0],
    "http://192.168.2.108:3481",
  );
  assert.equal(h.el("token").value, "");
});

test("each additional hotbar agent can be selected with glasses gestures without dictation", async () => {
  for (let index = 0; index < MORE_AGENTS.length; index++) {
    const h = await harness();
    await h.event({ menuItemClickEvent: { itemID: 7 } });
    assert.match(h.frames.at(-1), /СОЗДАТЬ АГЕНТА/);
    for (let i = 0; i < index; i++) await h.event({ textEvent: { eventType: 2 } });
    await h.event({ sysEvent: { eventType: 9 } });
    await h.event({ sysEvent: { eventType: 10 } });
    assert.deepEqual(h.micCalls, []);
    assert.equal(h.requests.filter(r => r.path === "/g2/api/create").length, 0);
    await h.event({ sysEvent: { eventType: 0 } });
    const creates = h.requests.filter(r => r.path === "/g2/api/create");
    assert.equal(creates.length, 1);
    assert.equal(creates[0].body.provider, MORE_AGENTS[index].provider);
  }
});

test("cancelling the agent picker preserves the current terminal and sends no create", async () => {
  const h = await harness();
  h.el("sessions").children[0].onclick();
  await flush();
  await h.event({ menuItemClickEvent: { itemID: 7 } });
  await h.event({ sysEvent: { eventType: 3 } });
  assert.equal(h.requests.filter(r => r.path === "/g2/api/create").length, 0);
  assert.doesNotMatch(h.frames.at(-1), /СОЗДАТЬ АГЕНТА/);
  assert.equal(h.exits.length, 0);
});

test("phone launch buttons send every hotbar provider through the create API", async () => {
  const h = await harness();
  for (const button of h.buttons) {
    await button.onclick();
    assert.equal(h.requests.filter(r => r.path === "/g2/api/create").at(-1).body.provider, button.dataset.new);
  }
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const providers = [...html.matchAll(/data-new="([a-z]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(providers, [...CANVAS_LAUNCHER_ITEMS].sort());
});
