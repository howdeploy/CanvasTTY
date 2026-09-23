import type { ProviderId } from '../../shared/contracts.ts';

const TASK_HEADING = 'CanvasTTY task:\n';
// Retain the existing 60 KiB task capacity, including its fixed heading in the complete bound.
const MAX_STARTUP_BYTES = 60 * 1024 + Buffer.byteLength(TASK_HEADING, 'utf8');

/** Main-only literal startup payload; never a shell command or persisted session field. */
export interface AgentStartup { task?: string; context?: string }
export function startupParts(provider: ProviderId, startup?: AgentStartup): { contextArgs: string[]; taskArgs: string[] } {
  const task = startup?.task;
  const context = startup?.context;
  for (const value of [task, context]) if (value !== undefined && (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 60 * 1024 || Buffer.from(value, 'utf8').toString('utf8') !== value)) throw new Error('Initial agent prompt exceeds the literal startup limit or contains invalid Unicode.');
  if (!task && !context) return { contextArgs: [], taskArgs: [] };
  if (provider === 'terminal') throw new Error('A shell does not support an initial agent task.');
  if (provider === 'kimi') throw new Error('Native Kimi initial task delivery is unverified. Select local ACP.');
  const contextArgs = !context ? [] : provider === 'codex' ? ['-c', `developer_instructions=${JSON.stringify(context).replace(/\u007f/gu, '\\u007f')}`]
    : provider === 'claude' || provider === 'omp' || provider === 'pi' ? ['--append-system-prompt', context]
    : provider === 'grok' ? ['--rules', context] : [];
  if (context && !contextArgs.length && !task?.trim()) throw new Error('This provider needs an explicit initial task to deliver context; passive context is unverified.');
  const message = task ? `${context && !contextArgs.length ? `CanvasTTY context:\n${context}\n\n` : ''}${TASK_HEADING}${task}` : '';
  if (Buffer.byteLength(message, 'utf8') + contextArgs.reduce((size, arg) => size + Buffer.byteLength(arg, 'utf8'), 0) > MAX_STARTUP_BYTES) throw new Error('Initial agent prompt exceeds the literal startup limit.');
  if (!task) return { contextArgs, taskArgs: [] };
  let taskArgs: string[];
  switch (provider) {
    case 'qwen': case 'antigravity': taskArgs = ['--prompt-interactive', message]; break;
    case 'opencode': taskArgs = ['--prompt', message]; break;
    case 'hermes': taskArgs = ['--query', message]; break;
    case 'omp': case 'pi': case 'devin': taskArgs = ['--', message]; break;
    default: taskArgs = [message];
  }
  return { contextArgs, taskArgs };
}
export function startupArguments(provider: ProviderId, startup?: AgentStartup): string[] {
  const { contextArgs, taskArgs } = startupParts(provider, startup);
  return [...contextArgs, ...taskArgs];
}
