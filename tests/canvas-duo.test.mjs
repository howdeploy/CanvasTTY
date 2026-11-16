import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { CanvasDuoService, duoLanAddress, parseDuoInvite, sealDuo, openDuo } from '../src/main/services/CanvasDuoService.ts';
const fixture = () => {
  const writes = [];
  const cards = [
    { id: 'shared', title: 'Shared shell', provider: 'terminal', exitCode: null, position: { x: 10, y: 20 }, size: { width: 700, height: 400 } },
    { id: 'private', title: 'Private shell', provider: 'terminal', exitCode: null, position: { x: 800, y: 20 }, size: { width: 700, height: 400 } }
  ];
  const port = { listMetadata: () => cards, geometry: () => ({ cols: 80, rows: 24 }),
    readBuffer: id => ({ buffer: id === 'shared' ? '\x1b[31mpublic output\x1b[0m' : 'SECRET-MUST-NOT-LEAK', outputOffset: id === 'shared' ? 26 : 20 }),
    inputChecked(id, text) { writes.push({ id, text }); return true; } };
  return { service: new CanvasDuoService(port), writes };
};
const loopback = code => { const invite = parseDuoInvite(code); invite.host = '127.0.0.1'; return 'canvasduo://' + Buffer.from(JSON.stringify(invite)).toString('base64url'); };
async function start(service, controlled = []) { return service.command({ action: 'host', transport: 'lan', selected: ['shared'], controlled }); }

test('Duo invitations accept literal LAN addresses and reject redirects or external hosts', () => {
  for (const host of ['10.0.0.1', '192.168.1.2', '172.16.0.1', '172.31.255.255', '127.0.0.1', '100.126.114.45']) assert.equal(duoLanAddress(host), true);
  for (const host of ['8.8.8.8', '169.254.169.254', 'localhost', '192.168.1.2.evil.com', '127.0.0.1@evil', '172.32.1.1', '10.999.1.2', '100.128.1.1']) assert.equal(duoLanAddress(host), false);
  assert.throws(() => parseDuoInvite('https://example.com'));
});
test('Duo encryption authenticates direction, payload and key', () => {
  const key = randomBytes(32); const packet = sealDuo({ text: 'private output' }, key, 'request');
  assert.equal(JSON.stringify(packet).includes('private output'), false);
  assert.deepEqual(openDuo(packet, key, 'request'), { text: 'private output' });
  assert.throws(() => openDuo(packet, key, 'response'));
  assert.throws(() => openDuo(packet, randomBytes(32), 'request'));
  assert.throws(() => openDuo({ ...packet, data: packet.data.replace(/^./, c => c === 'A' ? 'B' : 'A') }, key, 'request'));
});
test('real Duo transport shares only selected cards, cursors and comments; input needs a live grant', async t => {
  const { service: host, writes } = fixture(); const { service: guest } = fixture();
  t.after(() => Promise.all([host.stop(), guest.stop()]));
  const created = await start(host);
  const joined = await guest.command({ action: 'join', invite: loopback(created.state.invites[0]) });
  assert.equal(joined.state.role, 'guest');
  assert.deepEqual(joined.snapshot.cards.map(c => c.id), ['shared']);
  assert.match(joined.snapshot.cards[0].text, /public output/);
  assert.equal(JSON.stringify(joined).includes('SECRET-MUST-NOT-LEAK'), false);
  await assert.rejects(guest.command({ action: 'input', cardId: 'shared', text: 'echo unsafe\r' }), /not granted/);
  assert.equal(writes.length, 0);
  await host.command({ action: 'select', selected: ['shared'], controlled: ['shared'] });
  await guest.command({ action: 'input', cardId: 'shared', text: 'echo safe\r' });
  assert.deepEqual(writes, [{ id: 'shared', text: 'echo safe\r' }]);
  await guest.command({ action: 'comment', cardId: 'shared', text: '<script>plain text</script>' });
  await guest.command({ action: 'cursor', cardId: 'shared', x: .25, y: .75 });
  const view = await host.command({ action: 'snapshot' });
  assert.equal(view.snapshot.comments[0].text, '<script>plain text</script>');
  assert.equal(view.snapshot.cursors[0].x, .25);
  await host.command({ action: 'select', selected: [], controlled: [] });
  const revoked = await guest.command({ action: 'snapshot' });
  assert.deepEqual(revoked.snapshot.cards, []);
  assert.deepEqual(revoked.snapshot.comments, []);
  await assert.rejects(guest.command({ action: 'input', cardId: 'shared', text: 'no\r' }), /not shared/);
  await host.stop();
  await assert.rejects(guest.command({ action: 'snapshot' }));
});
test('Duo refuses browser origins, wrong keys, another guest and repeated input packets', async t => {
  const { service: host, writes } = fixture(); t.after(() => host.stop());
  const created = await start(host, ['shared']); const invite = parseDuoInvite(loopback(created.state.invites[0]));
  const key = Buffer.from(invite.key, 'base64url'); const endpoint = `http://${invite.host}:${invite.port}/duo`;
  const message = { id: randomUUID(), peer: 'first-guest', at: Date.now(), action: 'input', cardId: 'shared', text: 'once\r' };
  const packet = JSON.stringify(sealDuo(message, key, 'request'));
  const post = (data, headers = {}) => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: data });
  assert.equal((await post(packet, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post(JSON.stringify(sealDuo(message, randomBytes(32), 'request')))).status, 403);
  const response = await post(packet); assert.equal(response.status, 200);
  assert.equal(openDuo(await response.json(), key, 'response').ok, true);
  assert.equal((await post(packet)).status, 403);
  assert.equal(writes.length, 1);
  assert.equal((await post(JSON.stringify(sealDuo({ ...message, id: randomUUID(), peer: 'other-guest' }, key, 'request')))).status, 403);
  assert.equal(writes.length, 1);
});
test('Duo lifecycle serializes repeated starts and revokes the old invitation', async t => {
  const { service } = fixture(); t.after(() => service.stop());
  const [a, b] = await Promise.all([start(service), start(service)]);
  const old = parseDuoInvite(loopback(a.state.invites[0]));
  assert.notEqual(a.state.invites[0], b.state.invites[0]);
  await assert.rejects(fetch(`http://127.0.0.1:${old.port}/duo`, { method: 'POST', body: '{}' }));
  await service.stop(); assert.equal(service.state().role, 'idle');
  assert.deepEqual(service.state().controlled, []);
});

test('Duo guest disconnect releases its slot and revokes input before a new guest joins', async t => {
  const { service: host } = fixture(); const { service: first } = fixture(); const { service: second } = fixture();
  t.after(() => Promise.all([host.stop(), first.stop(), second.stop()]));
  const created = await start(host, ['shared']); const invite = loopback(created.state.invites[0]);
  await first.command({ action: 'join', invite });
  await first.command({ action: 'stop' });
  assert.deepEqual(host.state().controlled, []);
  const joined = await second.command({ action: 'join', invite });
  assert.equal(joined.state.role, 'guest');
  await assert.rejects(second.command({ action: 'input', cardId: 'shared', text: 'no inherited grant\r' }), /not granted/);
});

test('Duo permits reconnect after an unclean guest exit and revokes its old input grant', async t => {
  const { service: host } = fixture(); const { service: first } = fixture(); const { service: second } = fixture();
  t.after(() => Promise.all([host.stop(), first.stop(), second.stop()]));
  const created = await start(host, ['shared']); const invite = loopback(created.state.invites[0]);
  await first.command({ action: 'join', invite });
  // Process crash: no encrypted leave message reaches the host.
  await first.stop();
  const later = Date.now() + 61_000;
  t.mock.method(Date, 'now', () => later);
  const joined = await second.command({ action: 'join', invite });
  assert.equal(joined.state.role, 'guest');
  assert.equal(host.state().peer, true);
  assert.deepEqual(host.state().controlled, []);
  await assert.rejects(second.command({action:'input',cardId:'shared',text:'must not inherit\r'}), /not granted/);
});
