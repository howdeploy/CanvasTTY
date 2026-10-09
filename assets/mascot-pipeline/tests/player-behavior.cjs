// Exercise the real player with a deterministic clock; no browser or artwork is required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../templates/plugin/player.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

async function player(withIdle = true, action = 'a') {
  const drawn = [], timers = [];
  const element = () => ({
    style: {}, dataset: {}, children: [], listeners: {}, attributes: {},
    classList: { remove() {}, contains() { return false; }, toggle() { return true; } },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); },
    focus() {}, contains() { return false; }, querySelector() { return this.children[0]; },
    setPointerCapture() {},
    getContext() { return { clearRect() {}, drawImage(_image, x) { drawn.push(x); } }; }
  });
  const sprite = element(), picker = element(), toggle = element(), menu = element();
  const document = {
    documentElement: element(), querySelector: () => sprite,
    getElementById: (id) => ({ picker, 'picker-toggle': toggle, 'picker-menu': menu }[id]),
    createElement: element, addEventListener() {}
  };
  const clips = { 'a:in': [[1, .1]], a: [[2, .1], [3, .1]], 'a:out': [[4, .1]],
    'b:in': [[5, .1]], b: [[6, .1]], 'b:out': [[7, .1]] };
  if (withIdle) clips.idle = [[0, .1]];
  const data = { cell: [1, 1], cols: 8, perSheet: 8, sheets: [{ file: 'synthetic.webp' }],
    deck: ['a', 'b'], clips, buildId: 'fixture' };
  const window = { SPRITE: data, location: { search: `?action=${action}` }, addEventListener() {} };
  vm.runInNewContext(source, { window, document, navigator: { language: 'en' },
    parent: { postMessage() {} }, URLSearchParams,
    Image: class { complete = true; naturalWidth = 8; decode() { return Promise.resolve(); } },
    setTimeout: (fn) => timers.push(fn), Math: Object.assign(Object.create(Math), { random: () => .5 }) });
  await flush();
  return {
    drawn,
    select(name) {
      const option = menu.children.find((item) => item.textContent === name);
      assert.ok(option, `missing option ${name}`);
      option.listeners.click();
    },
    async tick(count = 1) {
      for (let i = 0; i < count; i++) {
        assert.ok(timers.length, 'player must schedule its next frame');
        timers.shift()();
        await flush();
      }
    }
  };
}

(async () => {
  const selected = await player();
  await selected.tick(6);
  assert.deepEqual(selected.drawn, [1, 2, 3, 2, 3, 2, 3], 'selected action must enter once and stay in its loop');
  selected.select('a');
  await selected.tick(2);
  assert.equal(selected.drawn.filter((i) => i === 1).length, 1, 'same selection must not restart entry');
  selected.select('b');
  await selected.tick(5);
  assert.deepEqual(selected.drawn.slice(-5), [4, 0, 5, 6, 6], 'switch must exit, bridge through idle and loop new action');

  const rapid = await player();
  rapid.select('b'); // A is still entering.
  await rapid.tick(3);
  assert.equal(rapid.drawn.at(-1), 4, 'complete a compatible cycle before exiting');
  rapid.select('a');
  rapid.select('Idle'); // Latest request wins during the exit.
  await rapid.tick(3);
  assert.deepEqual(rapid.drawn.slice(-3), [0, 0, 0]);
  assert.ok(!rapid.drawn.includes(5), 'stale intermediate selection must not start');

  const noIdle = await player(false, 'b');
  await noIdle.tick(3);
  assert.deepEqual(noIdle.drawn, [5, 6, 6, 6], 'selected action must work without an idle clip');
  noIdle.select('a');
  await noIdle.tick(3);
  assert.deepEqual(noIdle.drawn.slice(-3), [7, 1, 2]);

  const all = await player(true, 'all');
  await all.tick(20);
  assert.ok(all.drawn.includes(4) && all.drawn.includes(7), 'All actions must leave actions rather than hold one forever');
  console.log('Player behavior checks passed: held action, same selection, switching, latest request, no idle, all actions.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
