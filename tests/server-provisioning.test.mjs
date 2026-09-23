import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerProvisioning } from '../src/main/services/ServerProvisioning.ts';

const host = { id: 'srv', label: 'Server', sshHost: 'srv.example' };

function fixture({ os = 'ubuntu', mem = 4000, swap = 0, noRoot = false, swapFails = false, reach = { codex: true, claude: false, opencode: true }, installed = ['codex', 'opencode'], hostRule } = {}) {
  const scripts = [];
  const hosts = [{ ...host, ...(hostRule ? { providerAccess: hostRule } : {}) }];
  const run = async (_host, command) => {
    const script = command[0];
    scripts.push(script);
    if (noRoot) return { code: 3, stdout: 'CTTY_NO_ROOT\n', stderr: '' };
    if (script.includes('os-release')) return { code: 0, stdout: `os=${os}\nmem=${mem}\nswap=${swap}\napt=yes\n`, stderr: '' };
    if (swapFails && script.includes('swapfile')) return { code: 5, stdout: 'CTTY_SWAP_FAILED\n', stderr: '' };
    if (script.includes('apt-get')) return { code: 0, stdout: 'node=v22 podman=5.7\n', stderr: '' };
    return { code: 0, stdout: 'ok\n', stderr: '' };
  };
  const service = new ServerProvisioning({
    hosts: () => hosts, run,
    access: { probe: async () => ({ hostId: 'srv', collectedAt: 0, reachable: true, providers: reach }) },
    discovery: { discover: async (_h, _t, providers) => ({ hostId: 'srv', collectedAt: 0, reachable: true, providers: providers.map(provider => ({ provider, installed: installed.includes(provider) })) }) }
  });
  return { service, scripts };
}

async function finish(service, ids) {
  for (let i = 0; i < 200; i++) {
    const jobs = service.status(ids);
    if (jobs.every(job => job.finishedAt)) return jobs;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Provisioning did not finish.');
}

test('installs only agents whose API answers from the server and skips blocked ones', async () => {
  const { service, scripts } = fixture();
  const [job] = await finish(service, service.start(['srv']));
  assert.equal(job.phase, 'done');
  assert.deepEqual(job.installed, ['codex', 'opencode']);
  assert.deepEqual(job.skipped, [{ provider: 'claude', reason: 'api-blocked' }, { provider: 'qwen', reason: 'api-unknown' }]);
  const npm = scripts.find(script => script.includes('npm install'));
  assert.match(npm, /@openai\/codex opencode-ai/);
  assert.equal(npm.includes('claude-code'), false);
  assert.equal(scripts.some(script => script.includes('swapfile')), false);
  assert.ok(scripts.every(script => /^sh -c '[^']*'$/u.test(script)), 'scripts stay inside one single-quoted word');
});

test('servers with less than 2 GB and no swap get a swap file before npm', async () => {
  const { service, scripts } = fixture({ mem: 889 });
  const [job] = await finish(service, service.start(['srv']));
  assert.equal(job.phase, 'done');
  const swapIndex = scripts.findIndex(script => script.includes('fallocate -l 2G /swapfile'));
  assert.match(scripts[swapIndex], /swapon --show=NAME --noheadings \| grep -qx \/swapfile \|\| \{ echo CTTY_SWAP_FAILED; exit 5; \}; grep -q/);
  assert.ok(swapIndex > 0 && swapIndex < scripts.findIndex(script => script.includes('npm install')));
});

test('host rules, missing root, unsupported systems and unverified installs are reported', async () => {
  const blocked = fixture({ hostRule: { mode: 'blocklist', providers: ['codex'] }, installed: ['opencode'] });
  const [ruled] = await finish(blocked.service, blocked.service.start(['srv']));
  assert.deepEqual(ruled.skipped.find(item => item.provider === 'codex'), { provider: 'codex', reason: 'host-rule' });
  const noRoot = fixture({ noRoot: true });
  const [denied] = await finish(noRoot.service, noRoot.service.start(['srv']));
  assert.equal(denied.phase, 'failed');
  assert.match(denied.error, /root or passwordless sudo/);
  const other = fixture({ os: 'fedora' });
  const [unsupported] = await finish(other.service, other.service.start(['srv']));
  assert.match(unsupported.error, /Ubuntu and Debian/);
  const partial = fixture({ installed: ['opencode'] });
  const [missing] = await finish(partial.service, partial.service.start(['srv']));
  assert.equal(missing.phase, 'failed');
  assert.match(missing.error, /codex/);
});

test('only saved valid servers can be prepared and a running job is reused', async () => {
  const { service } = fixture();
  assert.throws(() => service.start(['unknown']), /not a valid saved server/);
  assert.throws(() => service.start([]), /Choose saved servers/);
  const first = service.start(['srv']);
  assert.deepEqual(service.start(['srv']), first);
  await finish(service, first);
});

test('a swap file that cannot be activated stops preparation before npm runs', async () => {
  const { service, scripts } = fixture({ mem: 889, swapFails: true });
  const [job] = await finish(service, service.start(['srv']));
  assert.equal(job.phase, 'failed');
  assert.match(job.error, /swap failed/);
  assert.equal(scripts.some(script => script.includes('npm install')), false);
});
