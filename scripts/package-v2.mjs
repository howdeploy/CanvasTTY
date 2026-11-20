import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { prepareV2Profile } from './prepare-v2-profile.mjs';
const repo = resolve(import.meta.dirname, '..');
const env = { ...process.env, VITE_BUILD_CHANNEL: 'LOCAL', VITE_BUILD_VERSION: JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version, VITE_APP_NAME: 'CanvasTTY 2.0' };
for (const [command, args] of [['npm', ['run', 'build']], ['./node_modules/.bin/electron-builder', ['--dir', '--mac', '--arm64', '--publish', 'never', '--config', 'electron-builder.v2.cjs']]]) {
  const result = spawnSync(command, args, { cwd: repo, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(await prepareV2Profile(join(repo, '../profile-alpha7')));
