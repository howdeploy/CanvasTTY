import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, symlinkSync, linkSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextProfileStore } from '../src/main/services/ContextProfileStore.ts';
import { ContextLaunchService } from '../src/main/services/ContextLaunchService.ts';

async function fixture(t, files = { 'AGENTS.md': 'Follow LIVE_FIRST conventions.' }, imports = [{ path: 'AGENTS.md', kind: 'instructions' }]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'context-import-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'); mkdirSync(cwd);
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(cwd, path, '..'), { recursive: true }); writeFileSync(join(cwd, path), text); }
  const policies = []; const store = new ContextProfileStore(join(root, 'profiles'), () => policies);
  const state = await store.saveProject({ label: 'Project', root: cwd, importsEnabled: true, imports }, 0);
  const project = state.projects[0]; const service = new ContextLaunchService(store);
  const capture = () => service.capture({ enabled: true, provider: 'claude' }, { sourceCwd: cwd, assertCurrent() {} });
  const preview = (maxDataClass = 'D2') => store.preview({ projectId: project.id, maxDataClass });
  return { root, cwd, store, project, service, capture, preview, policies };
}

test('imports are live in preview and launch; source modification and deletion invalidate prepared snapshots', async t => {
  const f = await fixture(t); const before = f.capture();
  assert.match(f.preview().text, /LIVE_FIRST/); assert.match(f.service.project(before, { provider: 'claude', maxDataClass: 'D2' }).text, /LIVE_FIRST/);
  assert.equal(f.store.get().rules.length, 0); assert.equal(f.preview().included[0].provenance.sourceLine, 1);
  writeFileSync(join(f.cwd, 'AGENTS.md'), 'LIVE_SECOND'); assert.throws(() => before.assertCurrent(), /changed/);
  const after = f.capture(); assert.notEqual(before.digest, after.digest); assert.match(f.preview().text, /LIVE_SECOND/); assert.doesNotMatch(f.preview().text, /LIVE_FIRST/);
  rmSync(join(f.cwd, 'AGENTS.md')); assert.throws(() => after.assertCurrent(), /changed/); assert.equal(f.preview().text, '');
  assert.equal(f.preview().diagnostics[0].status, 'missing');
});

test('classification uses live path policy with unknown D2 and section classes only raise it; provenance stays local and filtered', async t => {
  const f = await fixture(t); assert.equal(f.preview('D1').text, ''); assert.deepEqual(f.preview('D1').included, []);
  f.policies.push({ pattern: 'AGENTS.md', dataClass: 'D0' }); const first = f.capture();
  assert.equal(f.preview('D0').included[0].dataClass, 'D0');
  f.policies[0].dataClass = 'D3'; assert.throws(() => first.assertCurrent(), /policy|changed/);
  assert.doesNotMatch(JSON.stringify(f.preview('D2')), /AGENTS|LIVE_FIRST|sourceHash/);
  const s = f.store.get(); await f.store.saveProject({ ...f.project, imports: [{ path: 'AGENTS.md', kind: 'instructions', dataClass: 'D1' }] }, s.revision);
  assert.equal(f.preview('D3').included[0].dataClass, 'D3');
  const route = f.service.project(f.capture(), { provider: 'claude', maxDataClass: 'D3' }); assert.doesNotMatch(route.text, /sourceHash|sourcePath|AGENTS.md/);
});

test('bounded static config parsers never execute JavaScript; YAML aliases, tags and unsafe objects fail', async t => {
  const f = await fixture(t, { 'eslint.config.js': 'globalThis.__contextImportExecuted = true; throw Error("EXECUTED");', '.prettierrc.yaml': 'semi: false\nprintWidth: 88\n' }, [{ path: 'eslint.config.js', kind: 'config' }, { path: '.prettierrc.yaml', kind: 'config' }]);
  globalThis.__contextImportExecuted = false; const p = f.preview(); assert.equal(globalThis.__contextImportExecuted, false);
  assert.ok(p.included.some(r => r.key === 'code-style.prettier.semi' && r.value === false)); assert.ok(p.diagnostics.some(d => d.status === 'reference'));
  for (const text of ['a: &a [1]\nb: *a', 'a: !!js/function "evil"', 'a: 1\na: 2', '__proto__: evil', 'a: .inf']) { writeFileSync(join(f.cwd, '.prettierrc.yaml'), text); assert.throws(() => f.preview(), /import|value|config|YAML/); }
});

test('safe relative Unicode paths, no symlinks/hardlinks/devices, nested project boundary and root replacement', async t => {
  const f = await fixture(t, { 'настройки/AGENTS.md': 'Unicode convention' }, [{ path: 'настройки/AGENTS.md', kind: 'instructions' }]); assert.match(f.preview().text, /Unicode convention/);
  const external = join(f.root, 'outside'); mkdirSync(external); writeFileSync(join(external, 'AGENTS.md'), 'OUTSIDE');
  rmSync(join(f.cwd, 'настройки'), { recursive: true }); symlinkSync(external, join(f.cwd, 'настройки')); assert.throws(() => f.preview(), /import|link|safe/);
  unlinkSync(join(f.cwd, 'настройки')); mkdirSync(join(f.cwd, 'настройки')); linkSync(join(external, 'AGENTS.md'), join(f.cwd, 'настройки/AGENTS.md')); assert.throws(() => f.preview(), /import|link|safe/);
  rmSync(join(f.cwd, 'настройки/AGENTS.md')); writeFileSync(join(f.cwd, 'настройки/AGENTS.md'), 'Nested');
  await f.store.saveProject({ root: join(f.cwd, 'настройки'), label: 'Nested' }, f.store.get().revision); assert.throws(() => f.preview(), /nested|project|import/);
  for (const path of ['../AGENTS.md', '/AGENTS.md', 'x/../AGENTS.md', 'x\\AGENTS.md', '.git/AGENTS.md', 'a\u0000/AGENTS.md']) await assert.rejects(f.store.saveProject({ ...f.project, imports: [{ path, kind: 'instructions' }] }, f.store.get().revision));
  const g = await fixture(t); renameSync(g.cwd, join(g.root, 'old')); mkdirSync(g.cwd); writeFileSync(join(g.cwd, 'AGENTS.md'), 'REPLACED'); assert.throws(() => g.preview(), /project|root|changed/);
});

test('README sections and selected static CSS tokens preserve references and allow explicit semantic overrides', async t => {
  const f = await fixture(t, { 'README.md': '# Product\nUNRELATED\n## Development\nUse tests.\n## Install\nUNRELATED_TOO\n', 'theme.css': ':root {\n--brand: #123456;\n--button-fg: var(--brand);\n}\n.dark { --brand: #abcdef; }\n.widget { --private: nope; }' }, [{ path: 'README.md', kind: 'readme' }, { path: 'theme.css', kind: 'css', selectors: [':root'] }]);
  const p = f.preview(); assert.match(p.text, /Use tests/); assert.doesNotMatch(p.text, /UNRELATED|abcdef|private/);
  const token = p.included.find(r => r.key === 'design.css.--button-fg'); assert.equal(token.value, 'var(--brand)'); assert.equal(token.provenance.sourceLine, 3);
  await f.store.saveRule({ scope: 'project', ownerId: f.project.id, category: 'design', key: token.key, value: '#fff', tags: [], dataClass: 'D2', enabled: true }, f.store.get().revision);
  assert.equal(f.preview().included.find(r => r.key === token.key).source, 'explicit');
});

test('UTF8, file inventory and aggregate projection bounds reject excess without source reads when imports are off', async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, 'AGENTS.md'), 'я'.repeat(33000)); assert.throws(() => f.preview(), /bound|limit|import/);
  writeFileSync(join(f.cwd, 'AGENTS.md'), Buffer.from([0xff, 0xfe])); assert.throws(() => f.preview(), /UTF|encoded|import/);
  await assert.rejects(f.store.saveProject({ ...f.project, imports: Array.from({ length: 33 }, (_, i) => ({ path: `p${i}/AGENTS.md`, kind: 'instructions' })) }, f.store.get().revision), /bound|limit|import/);
  await f.store.saveProject({ ...f.project, importsEnabled: false }, f.store.get().revision); assert.equal(f.preview().text, '');
  const service = new ContextLaunchService({ capture() { throw Error('SOURCE IO'); } });
  assert.equal(service.capture({ enabled: false, provider: 'claude' }, () => { throw Error('PATH IO'); }), undefined);
});

test('hidden missing diagnostics never disclose paths and a reloaded store preserves main-owned root identity', async t => {
  const f = await fixture(t); rmSync(join(f.cwd, 'AGENTS.md'));
  assert.doesNotMatch(JSON.stringify(f.preview('D1')), /AGENTS|sourcePath|missing/);
  await assert.rejects(f.store.saveProject({ ...f.project, rootIdentity: '1:2:3' }, f.store.get().revision), /identity/);
  const reloaded = new ContextProfileStore(join(f.root, 'profiles'));
  renameSync(f.cwd, join(f.root, 'old')); mkdirSync(f.cwd); writeFileSync(join(f.cwd, 'AGENTS.md'), 'replacement');
  assert.throws(() => reloaded.preview({ projectId: f.project.id, maxDataClass: 'D3' }), /root identity changed/);
});

test('projection reserves 48 current rules and rejects aggregate overflow before route selection', async t => {
  const f = await fixture(t); const state = f.store.get();
  state.rules = Array.from({ length: 2000 }, (_, index) => ({ id: `r${index}`, scope: 'user', category: 'design', key: `key${index}`, value: 'v', tags: [], dataClass: 'D0', source: 'explicit', confidence: 1, enabled: true, updatedAt: 0 }));
  writeFileSync(join(f.root, 'profiles', 'profiles.json'), JSON.stringify(state), { mode: 0o600 });
  const full = new ContextProfileStore(join(f.root, 'profiles'));
  assert.throws(() => full.capture(f.cwd), /aggregate rule bound/);
  state.rules.pop(); writeFileSync(join(f.root, 'profiles', 'profiles.json'), JSON.stringify(state), { mode: 0o600 });
  const service = new ContextLaunchService(new ContextProfileStore(join(f.root, 'profiles')));
  const snapshot = service.capture({ enabled: true, provider: 'claude', current: Array.from({ length: 48 }, (_, i) => ({ key: `current${i}`, category: 'design', value: 'v', dataClass: 'D0' })) }, { sourceCwd: f.cwd, assertCurrent() {} });
  assert.doesNotThrow(() => service.project(snapshot, { provider: 'claude', maxDataClass: 'D2' }));
});

test('CSS static boundaries and cursor applicability cannot turn nested or scoped text into global rules', async t => {
  const f = await fixture(t, { 'theme.css': ':root { --ok: var(--base); content: "--fake: RED;"; }\n@media(x) { :root { --secret: RED; } }\n.dark { --ok: BLACK; }', '.cursor/rules/style.mdc': '---\nglobs: "**/*.css"\nalwaysApply: false\n---\nNEVER_GLOBAL' }, [{ path: 'theme.css', kind: 'css', selectors: [':root'] }, { path: '.cursor/rules/style.mdc', kind: 'instructions' }]);
  const p = f.preview(); assert.match(p.text, /var\(--base\)/); assert.doesNotMatch(p.text, /RED|BLACK|NEVER_GLOBAL|fake|secret/); assert.equal(p.diagnostics.filter(d => d.status === 'unsupported').length, 2);
  writeFileSync(join(f.cwd, '.cursor/rules/style.mdc'), '---\nalwaysApply: true\ndescription: Global conventions\n---\nNOW_GLOBAL');
  assert.match(f.preview().text, /NOW_GLOBAL/);
});

import { TerminalManager } from '../src/main/services/TerminalManager.ts';
import { SessionLaunchPolicy } from '../src/main/services/SessionLaunchPolicy.ts';
import { accountRouteBinding } from '../src/shared/providerAccountPolicy.ts';
import { persistedTerminalSession } from '../src/main/services/TerminalSessionStore.ts';
test('actual preview/policy/manager launch transports fresh imported context exactly once and preserves disclosure floor', async t => {
  const f = await fixture(t), calls = [], exits = [];
  const account = { id: 'private', label: 'Private', provider: 'claude' };
  account.assessment = { profile: { training: 'none', retention: 'bounded', thirdPartyProcessing: 'no', contractualMode: 'business' }, evidence: { kind: 'user-attested', reviewedAt: new Date().toISOString().slice(0, 10), sources: [], note: 'Explicit test assessment', binding: accountRouteBinding(account), models: '*' } };
  const settings = { defaultDataClass: 'D0', contextProfilesEnabled: true, providerAccounts: [account], pathPolicies: [], remoteHosts: [] };
  const manager = new TerminalManager(() => {}, { get: provider => ({ state: 'available', provider, executable: '/fake/' + provider, launcher: 'native', environment: {}, checked: [] }) }, undefined, undefined, false, (command, args) => { calls.push({ command, args }); return { pid: 1, onData() {}, onExit(fn) { exits.push(fn); }, kill() {}, resize() {}, write() { throw Error('No PTY startup typing'); } }; });
  t.after(() => manager.disposeAll());
  manager.configureLaunchPolicy(new SessionLaunchPolicy(() => settings, { context: f.service })); manager.configureContextLaunch(f.service, () => settings.contextProfilesEnabled);
  const request = { provider: 'claude', cwd: f.cwd, profile: 'normal', position: { x: 0, y: 0 }, context: { enabled: true } };
  const preview = await manager.previewContextLaunch(request); assert.match(preview.text, /LIVE_FIRST/); assert.equal(calls.length, 0);
  const session = manager.create(request); assert.equal(calls[0].args.filter(arg => String(arg).includes('LIVE_FIRST')).length, 1); assert.equal(session.disclosureClass, 'D2'); assert.equal(session.contextSummary.status, 'delivered');
  assert.doesNotMatch(JSON.stringify(persistedTerminalSession(session)), /LIVE_FIRST|AGENTS.md|sourceHash/);
  exits[0]({ exitCode: 0 }); writeFileSync(join(f.cwd, 'AGENTS.md'), 'NEXT_LAUNCH');
  const restarted = manager.restart(session.id); assert.match(calls[1].args.join('\n'), /NEXT_LAUNCH/); assert.doesNotMatch(calls[1].args.join('\n'), /LIVE_FIRST/); assert.notEqual(restarted.contextSummary.digest, session.contextSummary.digest);
  exits[1]({ exitCode: 0 }); rmSync(join(f.cwd, 'AGENTS.md')); settings.contextProfilesEnabled = false;
  settings.providerAccounts[0].maxDataClass = 'D1'; assert.throws(() => manager.restart(session.id), /D2|disclosure|history|clearance/i);
});

test('configuration provenance points to the actual top-level quoted key and README code fences never select a section', async t => {
  const f = await fixture(t, { '.prettierrc.yaml': "nested:\n  semi: false\n'semi': true\n\"printWidth\": 88\n", 'README.md': '# Product\n```md\n## Development\nHIDDEN_FAKE_SECTION\n```\n## Installation\nHIDDEN_TOO\n## Development\nVISIBLE_REAL\n```md\n# Product\nVISIBLE_CODE\n```\n## Install\nHIDDEN_LAST' }, [{ path: '.prettierrc.yaml', kind: 'config' }, { path: 'README.md', kind: 'readme' }]);
  const p = f.preview(); assert.equal(p.included.find(r => r.key === 'code-style.prettier.semi').provenance.sourceLine, 3); assert.equal(p.included.find(r => r.key === 'code-style.prettier.printWidth').provenance.sourceLine, 4);
  assert.match(p.text, /VISIBLE_REAL/); assert.match(p.text, /VISIBLE_CODE/); assert.doesNotMatch(p.text, /HIDDEN/);
  await assert.rejects(f.store.saveProject({ ...f.project, imports: [{ path: 'a/'.repeat(20) + 'AGENTS.md', kind: 'instructions' }] }, f.store.get().revision), /depth/);
});

import { execFileSync } from 'node:child_process';
test('nonregular selected files cannot block reads and aggregate UTF8 bytes are bounded across selections', async t => {
  const f = await fixture(t); rmSync(join(f.cwd, 'AGENTS.md')); execFileSync('mkfifo', [join(f.cwd, 'AGENTS.md')]);
  assert.throws(() => f.preview(), /safely read context import/);
  const files = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`p${i}/AGENTS.md`, 'x'.repeat(60000)]));
  const g = await fixture(t, files, Object.keys(files).map(path => ({ path, kind: 'instructions' })));
  assert.throws(() => g.preview(), /aggregate byte bound/);
});

test('hidden imported winner never revives a contradictory public fallback; section D3 raises a public file', async t => {
  const f = await fixture(t); const key = f.preview().included[0].key;
  await f.store.saveRule({ scope: 'user', category: 'architecture', key, value: 'PUBLIC_FALLBACK', tags: [], dataClass: 'D0', enabled: true }, f.store.get().revision);
  assert.equal(f.preview('D1').text, '');
  f.policies.push({ pattern: 'AGENTS.md', dataClass: 'D0' });
  await f.store.saveProject({ ...f.project, imports: [{ path: 'AGENTS.md', kind: 'instructions', dataClass: 'D3' }] }, f.store.get().revision);
  assert.equal(f.preview('D2').text, ''); assert.equal(f.preview('D3').included[0].dataClass, 'D3');
});

test('selected CSS themes retain separate semantic keys instead of silently overriding root values', async t => {
  const f = await fixture(t, { 'theme.css': ':root { --brand: ivory; }\n.dark { --brand: black; }' }, [{ path: 'theme.css', kind: 'css', selectors: [':root', '.dark'] }]);
  const p = f.preview(); assert.equal(p.included.find(r => r.key === 'design.css.--brand').value, 'ivory'); assert.equal(p.included.find(r => r.key === 'design.css.theme..dark.--brand').value, 'black');
});


test('unsupported Cursor frontmatter stays bounded even with long whitespace and preserves narrow field semantics', async t => {
  const path = '.cursor/rules/large.mdc';
  const front = 'alwaysApply: true\ndescription: ' + ' '.repeat(10000) + '!\nunknown: false';
  const f = await fixture(t, { [path]: '---\n' + front + '\n---\nUNSUPPORTED_BODY\n' }, [{ path, kind: 'instructions' }]);
  const program = `const {ContextProfileStore}=await import(process.argv[1]);const store=new ContextProfileStore(process.argv[2]);console.log(JSON.stringify(store.preview({projectId:process.argv[3],maxDataClass:'D3'})));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program, new URL('../src/main/services/ContextProfileStore.ts', import.meta.url).href, join(f.root, 'profiles'), f.project.id], { timeout: 2000, maxBuffer: 65536, encoding: 'utf8' }));
  assert.equal(result.text, ''); assert.equal(result.diagnostics[0].status, 'unsupported');
  for (const invalid of ['alwaysApply: true\nalwaysApply: false', 'alwaysApply: true\ndescription: one\ndescription: two', 'alwaysApply: false', 'description: only']) {
    writeFileSync(join(f.cwd, path), '---\n' + invalid + '\n---\nUNSUPPORTED_BODY');
    assert.equal(f.preview().text, ''); assert.equal(f.preview().diagnostics[0].status, 'unsupported');
  }
  writeFileSync(join(f.cwd, path), '---\nalwaysApply: true\ndescription: ' + ' '.repeat(10000) + 'plain literal\n---\nSUPPORTED_BODY');
  assert.match(f.preview().text, /SUPPORTED_BODY/); assert.deepEqual(f.preview().diagnostics, []);
});
