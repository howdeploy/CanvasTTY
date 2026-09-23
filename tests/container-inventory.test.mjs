import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerExecutionService } from '../src/main/services/ContainerExecutionService.ts';
const profile = { id: 'local', label: 'Local', hostId: 'local', runtime: 'docker', executable: '/usr/bin/docker', endpoint: { kind: 'unix', socket: '/run/docker.sock' }, image: 'fixture:existing', python: '/usr/bin/python3', commands: { terminal: '/bin/sh' }, network: 'none', cpus: 2, memoryMb: 1024, pids: 128, user: '1000:1000' };
const info = { ID: 'fixture', Name: 'fixture', DockerRootDir: '/var/lib/docker', OSType: 'linux', CgroupVersion: '2', CgroupDriver: 'systemd', CpuCfsPeriod: true, CpuCfsQuota: true, MemoryLimit: true, PidsLimit: true, SecurityOptions: [] };
const row = { id: 'a'.repeat(64), name: 'outside', image: 'fixture:existing', state: 'running', status: 'Up 1 minute' };
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ct-inventory-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { containerProfiles: [structuredClone(profile)], remoteHosts: [] }, calls = [];
  const control = { rows: [row], failure: null, gate: null, daemon: info, changeDuringList: false };
  const service = new ContainerExecutionService(() => settings, { rootDirectory: root, resolveEndpoint: async p => ({ executable: p.executable, socket: p.endpoint.socket, executableIdentity: 'fixture' }), runner: async (_command, args) => {
    calls.push(args); if (control.gate) await control.gate;
    if (args.includes(control.failure)) throw new Error('fixture-private-output');
    if (args.includes('info')) return { stdout: JSON.stringify(control.daemon) };
    if (args.includes('image')) return { stdout: JSON.stringify([{ Id: 'sha256:' + 'b'.repeat(64), Os: 'linux', Architecture: 'amd64', Config: { Env: ['API_KEY=fixture'] } }]) };
    if (args.includes('ls') && control.changeDuringList) control.daemon = { ...info, ID: 'replacement' };
    if (args.includes('ls')) return { stdout: typeof control.rows === 'string' ? control.rows : control.rows.map(value => JSON.stringify(value)).join('\n') };
    throw new Error('Unexpected mutation');
  } });
  return { service, settings, control, calls };
}
test('inventory is on demand, groups shared endpoints, coalesces reads and supports forced refresh', async t => {
  const f = await fixture(t); assert.equal(f.calls.length, 0);
  f.settings.containerProfiles.push({ ...profile, id: 'second', label: 'Second' });
  const [first, second] = await Promise.all([f.service.inventory(), f.service.inventory()]);
  assert.deepEqual(first, second); assert.equal(first.length, 1);
  assert.equal(first[0].available, true); assert.equal(first[0].profiles.length, 2);
  assert.equal(first[0].profiles.every(p => p.imageAvailable), true);
  assert.deepEqual(first[0].containers, [{ ...row, managed: false }]);
  assert.equal(f.calls.filter(a => a.includes('ls')).length, 1);
  first[0].containers[0].name = 'caller mutation';
  assert.equal((await f.service.inventory())[0].containers[0].name, 'outside');
  await f.service.inventory(undefined, true); assert.equal(f.calls.filter(a => a.includes('ls')).length, 2);
  assert.equal(f.calls.some(a => a.some(s => ['create', 'start', 'pull', 'rm', 'stop'].includes(s))), false);
});
test('image failure preserves engine inventory while malformed/oversized inventory stays unavailable and redacted', async t => {
  const f = await fixture(t); f.control.failure = 'image';
  let result = (await f.service.inventory())[0]; assert.equal(result.available, true); assert.equal(result.profiles[0].imageAvailable, false);
  for (const raw of ['fixture-private-output', 'x'.repeat(2 * 1024 * 1024 + 1), JSON.stringify({ ...row, command: 'private' }), JSON.stringify({ ...row, id: 'short' }), JSON.stringify({ ...row, name: 'bad\u001bname' })]) {
    f.control.rows = raw; result = (await f.service.inventory(undefined, true))[0];
    assert.equal(result.available, false); assert.deepEqual(result.containers, []); assert.equal(JSON.stringify(result).includes('private'), false);
  }
});
test('inventory bounds visible rows and rejects invalid profile selection before engine work', async t => {
  const f = await fixture(t); f.control.rows = Array.from({ length: 65 }, (_, i) => ({ ...row, id: i.toString(16).padStart(64, '0') }));
  const value = (await f.service.inventory())[0]; assert.equal(value.containers.length, 64); assert.equal(value.truncated, true);
  const before = f.calls.length;
  for (const selection of [['missing'], ['local', 'local'], Array(65).fill('local'), 'local']) await assert.rejects(() => f.service.inventory(selection));
  assert.equal(f.calls.length, before); assert.deepEqual(await f.service.inventory([]), []);
});
test('settings change during an inventory probe cannot publish facts for the edited route', async t => {
  const f = await fixture(t); let release; f.control.gate = new Promise(resolve => { release = resolve; });
  const pending = f.service.inventory();
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  f.settings.containerProfiles[0].endpoint.socket = '/run/other.sock'; release();
  const value = (await pending)[0]; assert.equal(value.available, false); assert.equal(value.reasonCode, 'configuration-changed'); assert.deepEqual(value.containers, []);
});

test('daemon replacement between engine identity and inventory cannot publish stale identity', async t => {
  const f = await fixture(t); f.control.changeDuringList = true;
  const value = (await f.service.inventory())[0]; assert.equal(value.available, false); assert.deepEqual(value.containers, []);
});
