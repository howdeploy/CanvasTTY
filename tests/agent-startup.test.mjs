import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { remoteAgentLaunch } from '../src/main/services/remoteAgentLaunch.ts';
import assert from 'node:assert/strict';
import { resolveTerminalLaunch } from '../src/main/services/terminalLaunch.ts';
const task = '! echo unsafe\n/command @file --flag\nРусский `literal` $(literal) "quotes"';
const cli = provider => ({ provider, state: 'available', executable: `/fixture/${provider}`, launcher: 'native', environment: {}, checked: [] });
test('initial task is one final literal argv element after model and resume flags for each verified native transport', () => {
  const prefixes = { codex: [], claude: [], qwen: ['--prompt-interactive'], opencode: ['--prompt'], hermes: ['--query'], grok: [], omp: ['--'], pi: ['--'], cursor: [], minimax: [], devin: ['--'], antigravity: ['--prompt-interactive'] };
  for (const [provider, prefix] of Object.entries(prefixes)) {
    const base = resolveTerminalLaunch(provider, 'normal', ['--fixture'], { providerCli: cli(provider), model: provider === 'minimax' ? undefined : 'fixture-model', resumePrevious: true });
    const launch = resolveTerminalLaunch(provider, 'normal', ['--fixture'], { providerCli: cli(provider), model: provider === 'minimax' ? undefined : 'fixture-model', resumePrevious: true, startup: { task } });
    assert.deepEqual(launch.args, [...base.args, ...prefix, `CanvasTTY task:\n${task}`], provider);
  }
});
test('native Kimi and batch launchers refuse unverified task delivery before spawning', () => {
  assert.throws(() => resolveTerminalLaunch('kimi', 'normal', [], { providerCli: cli('kimi'), startup: { task } }), /ACP|unsupported|verified/i);
  assert.throws(() => resolveTerminalLaunch('claude', 'normal', [], { providerCli: { ...cli('claude'), launcher: 'batch', commandPrompt: 'cmd.exe' }, startup: { task } }), /batch|verified/i);
});


test('actual POSIX serialization preserves one multiline task without expansion for remote native launch', () => {
  const args = resolveTerminalLaunch('cursor', 'normal', [], { providerCli: cli('cursor'), startup: { task } }).args;
  const launch = remoteAgentLaunch({ sshHost: 'unused.invalid' }, process.cwd(), process.execPath, { absoluteExecutable: true, args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args] });
  const decoded = JSON.parse(execFileSync('/bin/sh', ['-c', launch.args.at(-1)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }));
  assert.deepEqual(decoded, args);
});
