// Unit tests must not inherit an active CanvasTTY session's runtime capability or Codex invocation.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('CANVASTTY_RUNTIME_') || key.startsWith('CANVASTTY_SHELL_') || key.startsWith('CANVASTTY_CAPTURE_')) delete env[key];
const files = readdirSync(new URL('../tests/', import.meta.url)).filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`);
const child = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...process.argv.slice(2), ...files], { cwd: new URL('../', import.meta.url), env, stdio: 'inherit' });
if (child.error) throw child.error;
process.exit(child.status ?? 1);
