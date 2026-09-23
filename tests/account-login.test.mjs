import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountLoginService, accountLoginCommand } from '../src/main/services/AccountLogin.ts';

function fixture(t, remoteHome = '/root/.canvastty/accounts/acct') {
  const created = [], inputs = [], runs = [];
  const terminals = {
    create(request) { created.push(request); return { id: `s${created.length}`, ...request }; },
    input(id, data) { inputs.push({ id, data }); }
  };
  const run = async (host, command) => { runs.push({ host: host.id, command: command[0] }); return { code: 0, stdout: `${remoteHome}\n`, stderr: '' }; };
  return { created, inputs, runs, make: userDataPath => new AccountLoginService({ settings: () => ({ locale: 'ru', remoteHosts: [{ id: 'srv', label: 'Server', sshHost: 'srv.example' }] }), terminals, run, userDataPath }) };
}

test('login commands select the account directory and never embed credentials', () => {
  assert.equal(accountLoginCommand('codex', "/root/it's"), `CODEX_HOME='/root/it'\\''s' codex login --device-auth -c 'cli_auth_credentials_store="file"'`);
  assert.equal(accountLoginCommand('claude', '/home/a'), "CLAUDE_CONFIG_DIR='/home/a' claude auth login");
  assert.throws(() => accountLoginCommand('grok', '/x'), /Codex and Claude/);
});

test('a remote account gets a private managed directory and a login terminal on its server', async t => {
  const f = fixture(t);
  const result = await f.make('/unused').start({ accountId: 'acct', provider: 'codex', hostId: 'srv', directory: '' });
  assert.equal(result.directory, '/root/.canvastty/accounts/acct');
  assert.match(f.runs[0].command, /umask 077; d="\$HOME\/\.canvastty\/accounts\/acct"; mkdir -p/);
  assert.deepEqual([f.created[0].hostId, f.created[0].provider, f.created[0].title], ['srv', 'terminal', 'Вход: Codex · Server']);
  assert.equal(f.inputs[0].data, `${accountLoginCommand('codex', result.directory)}\r`);
  const omitted = await f.make('/unused').start({ accountId: 'acct', provider: 'codex', hostId: 'srv' });
  assert.equal(omitted.directory, '/root/.canvastty/accounts/acct', 'an omitted directory also gets the managed one');
});

test('a local account directory is created privately under the app data folder', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'canvastty-login-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(t);
  const result = await f.make(root).start({ accountId: 'local-acct', provider: 'claude', hostId: 'local', directory: '' });
  assert.equal(result.directory, join(root, 'account-homes', 'local-acct'));
  assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
  assert.equal(f.created[0].hostId, undefined);
  assert.equal(f.runs.length, 0);
});

test('invalid providers, ids, hosts and directories are rejected before any terminal opens', async t => {
  const f = fixture(t), service = f.make('/unused');
  await assert.rejects(service.start({ accountId: 'a', provider: 'grok', hostId: 'local', directory: '' }), /Codex and Claude/);
  await assert.rejects(service.start({ accountId: '../x', provider: 'codex', hostId: 'local', directory: '' }), /account id/);
  await assert.rejects(service.start({ accountId: 'a', provider: 'codex', hostId: 'unknown', directory: '' }), /saved server/);
  await assert.rejects(service.start({ accountId: 'a', provider: 'codex', hostId: 'srv', directory: 'relative' }), /absolute/);
  assert.equal(f.created.length, 0);
});
