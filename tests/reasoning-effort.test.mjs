import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { providerEffortArguments, resolveTerminalLaunch } from '../src/main/services/terminalLaunch.ts';
import { SessionLaunchPolicy } from '../src/main/services/SessionLaunchPolicy.ts';
import { SettingsStore } from '../src/main/services/SettingsStore.ts';
import { normalizePersistedTerminalSessions, persistedTerminalSession } from '../src/main/services/TerminalSessionStore.ts';

const cli = provider => ({ state: 'available', provider, executable: `/bin/${provider}`, launcher: 'native', environment: {}, checked: [] });

test('reasoning effort uses each CLI verified flag and rejects unsupported agents', () => {
  assert.deepEqual(providerEffortArguments('codex', 'high'), ['-c', 'model_reasoning_effort="high"']);
  assert.deepEqual(providerEffortArguments('claude', 'max'), ['--effort', 'max']);
  assert.deepEqual(providerEffortArguments('grok', 'xhigh'), ['--reasoning-effort', 'xhigh']);
  assert.deepEqual(providerEffortArguments('cursor'), []);
  assert.throws(() => providerEffortArguments('claude', 'minimal'), /not supported/);
  assert.throws(() => providerEffortArguments('cursor', 'high'), /not supported/);
  const launch = resolveTerminalLaunch('claude', 'normal', [], { providerCli: cli('claude'), model: 'opus', effort: 'high', startup: { task: 'Fix it' } });
  assert.deepEqual(launch.args.slice(0, 4), ['--model', 'opus', '--effort', 'high']);
});

test('launch policy accepts supported PTY effort and rejects ACP, containers and unsupported levels', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvastty-effort-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { ...(await new SettingsStore(root, 'en').load()), defaultDataClass: 'D0' };
  const policy = new SessionLaunchPolicy(() => settings);
  const base = { cwd: process.cwd(), profile: 'normal' };
  assert.equal(policy.check({ ...base, provider: 'codex', effort: 'xhigh' }, []).effort, 'xhigh');
  assert.throws(() => policy.check({ ...base, provider: 'claude', effort: 'minimal' }, []), /not supported/);
  assert.throws(() => policy.check({ ...base, provider: 'kimi', effort: 'high' }, []), /not supported/);
  assert.throws(() => policy.check({ ...base, provider: 'claude', effort: 'high', transport: 'acp' }, []), /PTY/);
  assert.throws(() => policy.check({ ...base, provider: 'claude', effort: 'turbo' }, []), /Unknown reasoning effort/);
});

test('saved sessions keep a valid effort and drop an entry whose effort the agent cannot use', () => {
  const metadata = { id: 's1', revision: 0, provider: 'claude', profile: 'normal', title: 'Claude', titleCustomized: false, cwd: '/tmp', position: { x: 0, y: 0 }, size: { width: 700, height: 430 }, role: 'interactive', status: 'idle', startedAt: 0, exitCode: null, failureDetails: null, effort: 'high' };
  const saved = persistedTerminalSession(metadata);
  assert.equal(saved.effort, 'high');
  const restored = normalizePersistedTerminalSessions({ version: 1, sessions: [saved, { ...saved, id: 's2', provider: 'cursor' }] });
  assert.deepEqual(restored.sessions.map(session => [session.id, session.effort]), [['s1', 'high']]);
});

test('the launcher forwards a supported effort and drops a hidden one for ACP', async t => {
  const { launchOptions, reconcileLaunchDraft } = await import('../src/renderer/src/features/launcher/launchDraft.ts');
  const root = await mkdtemp(join(tmpdir(), 'canvastty-effort-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { ...(await new SettingsStore(root, 'en').load()), defaultDataClass: 'D0' };
  const draft = { ...reconcileLaunchDraft(null, 'claude', settings), cwd: process.cwd(), effort: 'high' };
  assert.equal(launchOptions(draft, settings).effort, 'high');
  const cursorDraft = { ...reconcileLaunchDraft(null, 'cursor', settings), cwd: process.cwd(), transport: 'acp', effort: 'high' };
  assert.equal('effort' in launchOptions(cursorDraft, settings), false);
  assert.throws(() => launchOptions({ ...reconcileLaunchDraft(null, 'cursor', settings), cwd: process.cwd(), effort: 'high' }, settings), /reasoning effort/);
});
