import type { ProviderId } from '../../shared/contracts.ts';

/** Main-only literal startup payload; never a shell command or persisted session field. */
export interface AgentStartup { task?: string }
export function startupArguments(provider: ProviderId, startup?: AgentStartup): string[] {
  const task = startup?.task;
  if (!task) return [];
  if (typeof task !== 'string' || task.includes('\0') || Buffer.byteLength(task, 'utf8') > 60 * 1024) throw new Error('Initial agent prompt exceeds the literal startup limit.');
  if (provider === 'terminal') throw new Error('A shell does not support an initial agent task.');
  if (provider === 'kimi') throw new Error('Native Kimi initial task delivery is unverified. Select local ACP.');
  const message = `CanvasTTY task:\n${task}`;
  switch (provider) {
    case 'qwen': case 'antigravity': return ['--prompt-interactive', message];
    case 'opencode': return ['--prompt', message];
    case 'hermes': return ['--query', message];
    case 'omp': case 'pi': case 'devin': return ['--', message];
    default: return [message];
  }
}
