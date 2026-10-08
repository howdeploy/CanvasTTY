import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { seatbeltProfile } from '../src/main/services/isolation/seatbelt.ts';
const native = process.platform === 'darwin' && process.env.CANVASTTY_TEST_NATIVE_SANDBOX === '1';
const paths = { writable: [], writableFiles: [], creatableFolders: [], unreadable: [], readableAgain: [],
  protectedWrites: [], protectedDirectories: [], gitHooks: [], projectRoots: [], socketFolders: [], socketPrefixes: [] };

test('strict macOS network modes deny Mach-service lookups while open mode preserves them', { skip: !native }, t => {
  const root = mkdtempSync(join(tmpdir(), 'ctty-dns-mach-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'probe');
  const home = join(root, 'home');
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', HOME: home, TMPDIR: root };
  const build = spawnSync('/usr/bin/xcrun', ['clang', fileURLToPath(new URL('./fixtures/mac-dns-service.c', import.meta.url)), '-o', binary], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const services = ['com.apple.dnssd.service', 'com.apple.coreservices.launchservicesd'];
  const policies = [undefined, { mode: 'offline' }, { mode: 'allowed-domains', proxyPort: 32123 }];
  for (const policy of policies) {
    const profile = seatbeltProfile(paths, policy);
    for (const service of services) {
      const child = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, binary, service], { encoding: 'utf8', timeout: 5000, env });
      assert.equal(child.error, undefined);
      assert.equal(child.status, policy ? 1 : 0, `${policy?.mode ?? 'open'} ${service}: ${child.stdout} ${child.stderr}`);
      assert.match(child.stdout, policy ? /port=none/u : /port=present/u, `${policy?.mode ?? 'open'} ${service}`);
    }
    for (const [name, command, args] of [
      ['shell', '/bin/sh', ['-c', 'exit 0']],
      ['Node', process.execPath, ['-e', 'process.exit(0)']],
      ['curl', '/usr/bin/curl', ['--version']]
    ]) {
      const child = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, command, ...args], { encoding: 'utf8', timeout: 5000, env });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, `${policy?.mode ?? 'open'} ${name}: ${child.stdout} ${child.stderr}`);
    }
  }
});

test('a real resolver call works in open macOS isolation and fails in both strict modes', {
  skip: !native || process.env.CANVASTTY_TEST_PUBLIC_DNS !== '1'
}, () => {
  const script = 'require("node:dns").lookup("www.iana.org",{all:true},(error,rows)=>process.exit(error || !rows?.length ? 1 : 0))';
  for (const policy of [undefined, { mode: 'offline' }, { mode: 'allowed-domains', proxyPort: 32123 }]) {
    const child = spawnSync('/usr/bin/sandbox-exec', ['-p', seatbeltProfile(paths, policy), process.execPath, '-e', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, policy ? 1 : 0, `${policy?.mode ?? 'open'}: ${child.stderr}`);
  }
});
