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

const context = 'Keep "quoted" preferences literal.\nРусский \\ path `literal` $(literal)';
test('passive context flags precede model/resume and do not duplicate context in the initial task', () => {
  for (const [provider, flag] of Object.entries({ codex: '-c', claude: '--append-system-prompt', grok: '--rules', omp: '--append-system-prompt', pi: '--append-system-prompt' })) {
    const launch = resolveTerminalLaunch(provider, 'normal', ['--fixture'], { providerCli: cli(provider), model: 'fixture-model', resumePrevious: true, startup: { task, context } });
    const args = launch.args, index = args.indexOf(flag);
    assert.ok(index > 0 && index < args.indexOf('--model'), provider);
    if (provider === 'codex') assert.equal(JSON.parse(args[index + 1].slice('developer_instructions='.length)), context);
    else assert.equal(args[index + 1], context);
    assert.equal(args.at(-1), `CanvasTTY task:\n${task}`);
    const passive = resolveTerminalLaunch(provider, 'normal', [], { providerCli: cli(provider), startup: { context } });
    assert.equal(passive.args.length, 2);
  }
});
test('prompt-only adapters require a real task and carry context in the one final literal message', () => {
  for (const provider of ['qwen', 'opencode', 'hermes', 'cursor', 'minimax', 'devin', 'antigravity']) {
    assert.throws(() => resolveTerminalLaunch(provider, 'normal', [], { providerCli: cli(provider), startup: { context } }), /task|passive/);
    for (const emptyTask of ['', ' ', '\n\t', '\u00a0']) assert.throws(() => resolveTerminalLaunch(provider, 'normal', [], { providerCli: cli(provider), startup: { context, task: emptyTask } }), /task|passive/);
    const launch = resolveTerminalLaunch(provider, 'normal', [], { providerCli: cli(provider), startup: { context, task } });
    assert.equal(launch.args.filter(arg => arg.includes(context)).length, 1);
    assert.ok(launch.args.at(-1).startsWith('CanvasTTY context:\n'));
    assert.ok(launch.args.at(-1).endsWith(`CanvasTTY task:\n${task}`));
  }
  for (const provider of ['terminal', 'kimi']) assert.throws(() => resolveTerminalLaunch(provider, 'normal', [], { providerCli: cli(provider), startup: { context } }));
});
test('complete startup payload is bounded in UTF-8 and refuses NUL or unverified batch context', () => {
  const taskAtLimit = 'x'.repeat(60 * 1024);
  assert.equal(resolveTerminalLaunch('codex', 'normal', [], { providerCli: cli('codex'), startup: { task: taskAtLimit } }).args.at(-1), `CanvasTTY task:\n${taskAtLimit}`);
  assert.throws(() => resolveTerminalLaunch('codex', 'normal', [], { providerCli: cli('codex'), startup: { task: taskAtLimit + 'x' } }), /limit/);
  for (const startup of [{ task: 'я'.repeat(16000), context: 'я'.repeat(16000) }, { context: 'bad\0text' }, { context: '\ud800' }]) assert.throws(() => resolveTerminalLaunch('codex', 'normal', [], { providerCli: cli('codex'), startup }), /limit|literal|UTF|Unicode/);
  assert.throws(() => resolveTerminalLaunch('claude', 'normal', [], { providerCli: { ...cli('claude'), launcher: 'batch', commandPrompt: 'cmd.exe' }, startup: { context } }), /batch|verified/);
  const literal = resolveTerminalLaunch('codex', 'normal', [], { providerCli: cli('codex'), startup: { context: 'control\u007fcharacter' } }).args[1];
  assert.ok(!literal.includes('\u007f')); assert.equal(JSON.parse(literal.slice('developer_instructions='.length)), 'control\u007fcharacter');
});
test('remote composition preserves passive context and task as distinct literal arguments', () => {
  const args = resolveTerminalLaunch('codex', 'normal', [], { providerCli: cli('codex'), startup: { task, context } }).args;
  const launch = remoteAgentLaunch({ sshHost: 'unused.invalid' }, process.cwd(), process.execPath, { absoluteExecutable: true, args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args] });
  assert.deepEqual(JSON.parse(execFileSync('/bin/sh', ['-c', launch.args.at(-1)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })), args);
  assert.equal(JSON.parse(args[1].slice('developer_instructions='.length)), context);
});
