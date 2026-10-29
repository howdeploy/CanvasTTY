/**
 * Freezing and discarding hidden browser tabs, driven with a fake clock and a fake host (no Electron, no CDP).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserTabLifecycle } from "../src/main/services/browser/BrowserTabLifecycle.ts";

class FakeClock {
  now = 0;
  timers = new Map();
  nextId = 1;

  setTimer = (callback, ms) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, callback });
    return id;
  };

  clearTimer = (id) => {
    this.timers.delete(id);
  };

  async next() {
    const [id, timer] = [...this.timers.entries()].sort((left, right) => left[1].at - right[1].at)[0];
    this.timers.delete(id);
    this.now = Math.max(this.now, timer.at);
    timer.callback();
    await flush();
  }

  async tick(ms) {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].callback();
      await flush();
    }
    this.now = until;
    await flush();
  }
}

async function flush() {
  for (let index = 0; index < 20; index += 1) await new Promise(setImmediate);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(options = {}) {
  const clock = new FakeClock();
  const log = [];
  const blockers = { freeze: new Map(), discard: new Map() };
  const gates = {};
  const host = {
    freezeBlocker: (id) => blockers.freeze.get(id) ?? null,
    discardBlocker: async (id) => {
      log.push(`check:${id}`);
      if (gates.discardBlockerError) throw gates.discardBlockerError;
      return blockers.discard.get(id) ?? null;
    },
    freeze: async (id) => {
      log.push(`freeze:${id}`);
      if (gates.freeze) await gates.freeze.promise;
      if (gates.freezeError) throw gates.freezeError;
      log.push(`frozen:${id}`);
    },
    resume: async (id) => { log.push(`resume:${id}`); },
    discard: async (id) => {
      log.push(`discard:${id}`);
      if (gates.discard) await gates.discard.promise;
      if (gates.discardError) throw gates.discardError;
      return true;
    },
    restore: async (id) => { log.push(`restore:${id}`); },
    stateChanged: (id, state) => log.push(`state:${id}:${state}`)
  };
  const lifecycle = new BrowserTabLifecycle(host, {
    freezeAfterMs: 30_000,
    discardAfterMs: 600_000,
    maxLiveHiddenTabs: 6,
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (error) => log.push(`error:${error.message}`),
    ...options
  });
  return { clock, log, blockers, gates, lifecycle };
}

test("a hidden, undriven tab is frozen after 30 s and discarded after 10 min; a visible one never", async () => {
  const { clock, log, lifecycle } = fixture();
  lifecycle.track("hidden", false);
  lifecycle.track("shown", true);

  await clock.tick(29_999);
  assert.deepEqual(log, []);
  await clock.tick(1);
  assert.deepEqual(log, ["freeze:hidden", "frozen:hidden", "state:hidden:frozen"]);
  assert.equal(lifecycle.state("hidden"), "frozen");

  await clock.tick(600_000 - 30_000);
  assert.deepEqual(log.slice(3), ["check:hidden", "discard:hidden", "state:hidden:discarded"]);
  assert.equal(lifecycle.state("hidden"), "discarded");
  assert.equal(lifecycle.state("shown"), "active");
});

test("automation keeps a tab awake, and the idle time counts from when automation stopped", async () => {
  const { clock, log, lifecycle } = fixture();
  lifecycle.track("tab", false);
  await clock.tick(20_000);
  lifecycle.setBusy("tab", true);
  await clock.tick(60_000);
  assert.deepEqual(log, [], "a tab an agent drives is never frozen");
  lifecycle.setBusy("tab", false);
  await clock.tick(29_000);
  assert.deepEqual(log, []);
  await clock.tick(1_000);
  assert.deepEqual(log, ["freeze:tab", "frozen:tab", "state:tab:frozen"]);
});

test("a command for a frozen tab resumes it before it runs, and waits for a freeze still in flight", async () => {
  const { clock, log, gates, lifecycle } = fixture();
  lifecycle.track("tab", false);
  gates.freeze = deferred();
  await clock.tick(30_000);
  assert.deepEqual(log, ["freeze:tab"], "the freeze is in flight");

  // Automation arrives mid-freeze: BrowserAutomationService marks the tab busy, then awaits ensureLive.
  lifecycle.setBusy("tab", true);
  let commandRan = false;
  const command = lifecycle.ensureLive("tab").then((result) => {
    log.push("command");
    commandRan = true;
    return result;
  });
  await flush();
  assert.equal(commandRan, false, "the command waits for the freeze to finish");
  gates.freeze.resolve();
  assert.deepEqual(await command, { reloaded: false });
  assert.deepEqual(log, [
    "freeze:tab", "frozen:tab", "state:tab:frozen",
    "resume:tab", "state:tab:active",
    "command"
  ]);
});

test("showing a frozen tab resumes it; showing a discarded one restores it", async () => {
  const { clock, log, lifecycle } = fixture();
  lifecycle.track("a", false);
  lifecycle.track("b", false);
  await clock.tick(600_000);
  assert.equal(lifecycle.state("a"), "discarded");
  lifecycle.track("c", false);
  await clock.tick(30_000);
  assert.equal(lifecycle.state("c"), "frozen");
  log.length = 0;

  lifecycle.setVisible("c", true);
  lifecycle.setVisible("a", true);
  await flush();
  assert.deepEqual(log.filter((line) => line.split(":")[1] === "c"), ["resume:c", "state:c:active"]);
  assert.deepEqual(log.filter((line) => line.split(":")[1] === "a"), ["restore:a", "state:a:active"]);
  assert.deepEqual(await lifecycle.ensureLive("b"), { reloaded: true }, "an agent command reports the reload");
});

test("blocked tabs are retried later and never forced: media or a dialog block freezing, beforeunload blocks discarding", async () => {
  const { clock, log, blockers, lifecycle } = fixture();
  lifecycle.track("media", false);
  lifecycle.track("form", false);
  blockers.freeze.set("media", "media");
  blockers.discard.set("form", "beforeunload");

  await clock.tick(30_000);
  assert.deepEqual(log.filter((line) => line.startsWith("freeze")), ["freeze:form"]);
  await clock.tick(60_000);
  assert.equal(lifecycle.state("media"), "active", "still playing, still awake");
  blockers.freeze.delete("media");
  await clock.tick(30_000);
  assert.equal(lifecycle.state("media"), "frozen", "retried once the media stopped");

  await clock.tick(600_000);
  assert.equal(lifecycle.state("form"), "frozen", "a page with a beforeunload handler is never discarded");
  assert.ok(log.filter((line) => line === "check:form").length >= 2, "and is asked again later");
  assert.equal(lifecycle.state("media"), "discarded");
});

test("rejected freezes back off all expired deadlines and later recover", async () => {
  const { clock, log, gates, lifecycle } = fixture({ discardAfterMs: 30_000, retryAfterMs: 1_000 });
  gates.freezeError = new Error("debugger unavailable");
  lifecycle.track("tab", false);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await clock.next();
    assert.equal(clock.now, 30_000 + (attempt - 1) * 1_000);
    assert.equal(lifecycle.state("tab"), "active", "a rejected freeze does not change the state");
    assert.equal(log.filter((line) => line === "freeze:tab").length, attempt);
    assert.equal(log.filter((line) => line === "error:debugger unavailable").length, attempt);
    assert.deepEqual([...clock.timers.values()].map((timer) => timer.at), [clock.now + 1_000]);
    await clock.tick(999);
    assert.equal(log.filter((line) => line === "freeze:tab").length, attempt, "no retry before the interval");
  }
  gates.freezeError = null;
  await clock.tick(1);
  assert.deepEqual(log.slice(-5), ["frozen:tab", "state:tab:frozen", "check:tab", "discard:tab", "state:tab:discarded"]);
  assert.equal(lifecycle.state("tab"), "discarded");
  assert.equal(clock.timers.size, 0);
});

for (const failure of ["discardError", "discardBlockerError"]) {
  test(`a rejected ${failure} preserves a frozen tab, backs off and later recovers`, async () => {
    const { clock, log, gates, lifecycle } = fixture({ discardAfterMs: 60_000, retryAfterMs: 1_000 });
    lifecycle.track("tab", false);
    await clock.tick(30_000);
    gates[failure] = new Error("discard unavailable");

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await clock.next();
      assert.equal(clock.now, 60_000 + (attempt - 1) * 1_000);
      assert.equal(lifecycle.state("tab"), "frozen");
      assert.equal(log.filter((line) => line === "check:tab").length, attempt);
      assert.equal(log.filter((line) => line === "error:discard unavailable").length, attempt);
      assert.deepEqual([...clock.timers.values()].map((timer) => timer.at), [clock.now + 1_000]);
      await clock.tick(999);
      assert.equal(log.filter((line) => line === "check:tab").length, attempt);
    }
    gates[failure] = null;
    await clock.tick(1);
    assert.equal(lifecycle.state("tab"), "discarded");
    assert.equal(clock.timers.size, 0);
  });
}

test("a rejected discard of an active tab defers its expired freeze deadline too", async () => {
  const { clock, log, blockers, gates, lifecycle } = fixture({ discardAfterMs: 30_000, retryAfterMs: 1_000 });
  blockers.freeze.set("tab", "media");
  gates.discard = deferred();
  lifecycle.track("tab", false);
  await clock.next();
  await clock.tick(1_000);
  gates.discard.reject(new Error("discard unavailable"));
  await flush();
  assert.equal(lifecycle.state("tab"), "active");
  assert.deepEqual([...clock.timers.values()].map((timer) => timer.at), [32_000]);
  await clock.tick(999);
  assert.equal(log.filter((line) => line === "discard:tab").length, 1);
  gates.discard = null;
  await clock.tick(1);
  assert.equal(lifecycle.state("tab"), "discarded");
});

test("a rejected hidden-limit discard waits before another tab can queue it again", async () => {
  const { clock, log, gates, lifecycle } = fixture({ maxLiveHiddenTabs: 1, retryAfterMs: 1_000 });
  gates.discardError = new Error("discard unavailable");
  lifecycle.track("oldest", false);
  await clock.tick(100);
  lifecycle.track("newer", false);
  await clock.next();
  assert.equal(lifecycle.state("oldest"), "frozen");
  assert.deepEqual(log.filter((line) => line.startsWith("discard:")), ["discard:oldest"]);
  await clock.tick(100);
  assert.equal(log.filter((line) => line === "discard:oldest").length, 1, "newer's timer respects oldest's backoff");
  gates.discardError = null;
  await clock.tick(900);
  lifecycle.track("trigger", false);
  await clock.tick(30_000);
  assert.equal(lifecycle.state("oldest"), "discarded");
});

test("more than six live hidden tabs: the least recently used idle ones are discarded early", async () => {
  const { clock, log, lifecycle } = fixture();
  for (let index = 0; index < 8; index += 1) {
    lifecycle.track(`tab-${index}`, false);
    await clock.tick(1_000);
  }
  await clock.tick(30_000);
  const discarded = log.filter((line) => line.startsWith("discard:"));
  assert.deepEqual(discarded, ["discard:tab-0", "discard:tab-1"], "the two oldest go to sleep");
  assert.equal([0, 1, 2, 3, 4, 5, 6, 7].filter((index) => lifecycle.state(`tab-${index}`) !== "discarded").length, 6);
});

test("the hidden-tab limit skips a tab an agent drives and one that was hidden only moments ago", async () => {
  const { clock, lifecycle } = fixture();
  for (let index = 0; index < 7; index += 1) lifecycle.track(`tab-${index}`, false);
  lifecycle.setBusy("tab-0", true);
  await clock.tick(30_000);
  assert.equal(lifecycle.state("tab-0"), "active", "driven: neither frozen nor discarded");
  assert.equal([1, 2, 3, 4, 5, 6].filter((index) => lifecycle.state(`tab-${index}`) === "discarded").length, 1);
  lifecycle.track("fresh", false);
  await clock.tick(1_000);
  assert.equal(lifecycle.state("fresh"), "active");
});

test("turning the setting off resumes paused tabs and stops scheduling; on again schedules anew", async () => {
  const { clock, log, lifecycle } = fixture();
  lifecycle.track("tab", false);
  await clock.tick(30_000);
  assert.equal(lifecycle.state("tab"), "frozen");
  lifecycle.setEnabled(false);
  await flush();
  assert.equal(lifecycle.state("tab"), "active");
  await clock.tick(3_600_000);
  assert.equal(log.filter((line) => line.startsWith("freeze:")).length, 1, "nothing is paused while off");
  lifecycle.setEnabled(true);
  await clock.tick(30_000);
  assert.equal(lifecycle.state("tab"), "frozen");
});

test("disabling pause waits for an in-flight freeze and resumes it without waking sleeping tabs", async () => {
  const { clock, log, gates, lifecycle } = fixture();
  lifecycle.track("sleeping", false);
  await clock.tick(600_000);
  assert.equal(lifecycle.state("sleeping"), "discarded");
  lifecycle.track("pending", false);
  gates.freeze = deferred();
  await clock.tick(30_000);
  assert.equal(lifecycle.state("pending"), "active", "the freeze has started but has not completed");

  lifecycle.setEnabled(false);
  await flush();
  assert.equal(log.includes("resume:pending"), false, "the resume cannot overtake the freeze");
  gates.freeze.resolve();
  await flush();

  assert.deepEqual(log.slice(-5), [
    "freeze:pending", "frozen:pending", "state:pending:frozen", "resume:pending", "state:pending:active"
  ]);
  assert.equal(lifecycle.state("pending"), "active");
  assert.equal(lifecycle.state("sleeping"), "discarded");
  assert.equal(log.includes("restore:sleeping"), false);
  assert.equal(clock.timers.size, 0);
  await clock.tick(3_600_000);
  assert.equal(lifecycle.state("pending"), "active", "disabled pausing never schedules another freeze");
});

test("an untracked (closed) tab is left alone even when its freeze was in flight", async () => {
  const { clock, log, gates, lifecycle } = fixture();
  lifecycle.track("tab", false);
  gates.freeze = deferred();
  await clock.tick(30_000);
  lifecycle.untrack("tab");
  gates.freeze.resolve();
  await flush();
  await clock.tick(3_600_000);
  assert.deepEqual(log, ["freeze:tab", "frozen:tab"], "no state change or discard for a closed tab");
});
