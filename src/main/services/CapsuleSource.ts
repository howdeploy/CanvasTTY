import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { DataClass } from '../../shared/contracts.ts';

const exec = promisify(execFile);
export interface CapsuleSourceProof { version: 1; sourceRoot: string; commonDirectory: string; rootDev: number; rootIno: number; commonDev: number; commonIno: number; taskDataClass: DataClass }
export function validCapsuleSourceProof(value: unknown): value is CapsuleSourceProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as CapsuleSourceProof;
  return p.version === 1 && ['D0', 'D1', 'D2', 'D3'].includes(p.taskDataClass) && [p.sourceRoot, p.commonDirectory].every(path => typeof path === 'string' && isAbsolute(path) && path.length <= 4096) && [p.rootDev, p.rootIno, p.commonDev, p.commonIno].every(value => Number.isSafeInteger(value) && value >= 0);
}
async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec('git', ['--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, timeout: 5000, maxBuffer: 65536, encoding: 'utf8' })).stdout.replace(/\n$/u, '');
}
export async function inspectCapsuleSource(source: string, taskDataClass: DataClass): Promise<CapsuleSourceProof> {
  const sourceRoot = await realpath(await git(source, ['rev-parse', '--show-toplevel']));
  const part = relative(sourceRoot, source);
  if (isAbsolute(part) || part === '..' || part.startsWith('../') || part.startsWith('..\\') || await git(source, ['rev-parse', '--show-superproject-working-tree'])) throw new Error('Capsule source must belong to its original repository, outside submodules.');
  const pointer = await lstat(join(sourceRoot, '.git'));
  if (pointer.isSymbolicLink() || !(pointer.isDirectory() || pointer.isFile() && pointer.nlink === 1)) throw new Error('Unsafe capsule repository pointer.');
  const commonDirectory = await realpath(resolve(source, await git(source, ['rev-parse', '--git-common-dir'])));
  const root = await lstat(sourceRoot), common = await lstat(commonDirectory);
  if (!root.isDirectory() || !common.isDirectory()) throw new Error('Capsule repository identity is unavailable.');
  return { version: 1, sourceRoot, commonDirectory, rootDev: root.dev, rootIno: root.ino, commonDev: common.dev, commonIno: common.ino, taskDataClass };
}
export async function assertCapsuleSourceFiles(source: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    let directory = dirname(join(source, path));
    while (directory !== source) {
      try { await lstat(join(directory, '.git')); throw new Error('Selected capsule path crosses a nested repository or submodule.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = dirname(directory); if (parent === directory) throw new Error('Capsule path is outside its source.'); directory = parent;
    }
  }
  const tracked = await git(source, ['ls-files', '--stage', '-z', '--', ...paths]);
  for (const entry of tracked.split('\0').filter(Boolean)) {
    const fields = entry.split('\t', 1)[0]!.split(' ');
    if (!['100644', '100755'].includes(fields[0]!) || fields[2] !== '0') throw new Error('Capsule files cannot be Git links, submodules or unresolved merges.');
  }
}
