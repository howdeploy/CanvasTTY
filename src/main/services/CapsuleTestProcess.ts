import { spawn } from 'node:child_process';

export interface TestProcessLaunch { command: string; args: string[]; cwd: string; environment: Record<string, string> }
export interface TestProcessOptions { timeoutMs: number; outputBytes: number; signal: AbortSignal; assertCurrent(): void }
export interface TestProcessResult { output: string; truncated: boolean; exitCode: number | null; reason?: 'timeout' | 'cancelled' | 'output-limit' | 'failed' }
export type TestProcessRunner = (launch: TestProcessLaunch, options: TestProcessOptions) => Promise<TestProcessResult>;

/** Bounded engine client capture. Killing this client is followed by owned container cleanup. */
export const runCapsuleTestProcess: TestProcessRunner = (launch, options) => new Promise((resolve, reject) => {
  try { options.signal.throwIfAborted(); options.assertCurrent(); } catch (error) { reject(error); return; }
  const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.environment, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  const chunks: Buffer[] = []; let bytes = 0, truncated = false, finished = false;
  let exitCode: number | null = null, reason: TestProcessResult['reason'];
  let forced: ReturnType<typeof setTimeout> | undefined, drain: ReturnType<typeof setTimeout> | undefined;
  const kill = (): void => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Process/group has already exited. */ } };
  const finish = (): void => {
    if (finished) return; finished = true;
    clearTimeout(deadline); clearInterval(watchdog); clearTimeout(forced); clearTimeout(drain);
    options.signal.removeEventListener('abort', cancel);
    child.stdout.destroy(); child.stderr.destroy();
    resolve({ output: Buffer.concat(chunks).toString('utf8'), truncated, exitCode, ...(reason ? { reason } : {}) });
  };
  const stop = (why: NonNullable<TestProcessResult['reason']>): void => {
    if (finished || reason) return;
    reason = why; kill(); forced = setTimeout(finish, 1000);
  };
  const cancel = (): void => stop('cancelled');
  const deadline = setTimeout(() => stop('timeout'), options.timeoutMs);
  const watchdog = setInterval(() => { try { options.assertCurrent(); } catch { stop('cancelled'); } }, 250);
  const collect = (chunk: Buffer): void => {
    if (finished || reason) return;
    const remaining = options.outputBytes - bytes;
    chunks.push(Buffer.from(chunk.subarray(0, remaining))); bytes += Math.min(remaining, chunk.length);
    if (chunk.length > remaining) { truncated = true; stop('output-limit'); }
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  child.once('error', () => stop('failed'));
  child.once('exit', code => { exitCode = code; drain = setTimeout(() => stop('failed'), 1000); });
  child.once('close', finish);
  options.signal.addEventListener('abort', cancel, { once: true });
  if (options.signal.aborted) cancel();
});
