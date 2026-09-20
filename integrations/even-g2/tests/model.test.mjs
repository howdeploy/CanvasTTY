import test from "node:test";
import assert from "node:assert/strict";
import { ViewModel, Gestures } from "../src/model.mjs";
test("repeated polling never appends history or advances the page", () => {
  const m = new ViewModel();
  m.open("a");
  const data = {
    session: { id: "a", status: "idle" },
    body: "Новый ответ\n" + "текст ".repeat(100),
    revision: "one",
  };
  m.terminal(data);
  m.scroll(1);
  const before = m.frame();
  for (let i = 0; i < 20; i++) m.terminal(data);
  assert.equal(m.frame(), before);
  assert.equal(m.page, 1);
});
test("background status preserves manual reading position and unrelated terminals are ignored", () => {
  const m = new ViewModel();
  m.open("a");
  m.terminal({
    session: { id: "a", status: "idle" },
    body: "текст ".repeat(200),
    revision: "one",
  });
  m.page = 2;
  m.terminal({
    session: { id: "a", status: "working" },
    body: m.body,
    revision: "one",
  });
  assert.equal(m.page, 2);
  m.terminal({
    session: { id: "b", status: "idle" },
    body: "wrong",
    revision: "other",
  });
  assert.notEqual(m.body, "wrong");
});
test("OS overlay cancels a hold without submitting voice; double click goes back", () => {
  const events = [];
  const g = new Gestures({
    select: () => events.push("select"),
    back: () => events.push("back"),
    record: () => events.push("record"),
    send: () => events.push("send"),
  });
  g.click();
  g.long();
  g.cancel();
  g.release();
  assert.deepEqual(events, ["select", "record"]);
  g.double();
  assert.equal(events.at(-1), "back");
});
test("opening a prefetched session has its answer immediately", () => {
  const m = new ViewModel();
  const session = { id: "a", status: "idle" };
  m.home({ sessions: [session] });
  m.terminal({ session, body: "Понг.", revision: "1" });
  m.open("a");
  assert.equal(m.body, "Понг.");
  m.loadFailed("a");
  assert.equal(m.body, "Понг.");
});
test("failed initial load cannot leave an endless loading message", () => {
  const m = new ViewModel();
  m.open("a");
  m.loadFailed("a");
  assert.doesNotMatch(m.body, /Загружаю/);
  assert.equal(m.state, "failed");
  m.terminal({
    session: { id: "a", status: "idle" },
    body: "Ответ",
    revision: "1",
  });
  assert.equal(m.body, "Ответ");
  assert.equal(m.state, "idle");
});
