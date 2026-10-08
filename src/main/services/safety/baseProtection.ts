import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPathInside } from '../../../agent-runtime/path-inside.mjs';
import { analyzeAction, commandFromArgv, realish, type HardFacts, type PrivateData, type ToolAction } from './commandFacts.ts';

/**
 * Base protection: a small set of deny-only rules the core applies to every local agent tool call it sees through
 * the agents' own hooks (Claude Code, Codex and Qwen Code PreToolUse; OpenCode's plugin), before any plugin decides.
 * On by default; Settings → Agents → "Base protection" turns it off. It never allows anything and never asks a
 * model: local rules only, no git, no network.
 */

const BASE_DENY_RULES = ['app-private', 'elevation', 'pipe-to-shell', 'download-exec', 'disk', 'fork-bomb', 'delete-outside', 'write-outside', 'unknown-target'] as const;
export type BaseDenyRule = typeof BASE_DENY_RULES[number];

/** What the model reads: why the call was refused and what to do instead. */
const DENY_MESSAGES: Readonly<Record<BaseDenyRule, string>> = {
  'app-private': 'CanvasTTY blocked this: it reads CanvasTTY\'s own access tokens or secret stores, or talks to its control socket. Agents can\'t control CanvasTTY this way, and guessing its protocol will not work. If you need other agents, ask the person to start you from CanvasTTY\'s launcher with the Orchestrator role: you will then get the canvastty_agents tools: list_providers shows which agents CanvasTTY can launch, then spawn_agent, wait_for_agent and get_agent_result. Do not search the filesystem for agent CLIs or their configuration. Otherwise continue your task without controlling CanvasTTY.',
  elevation: 'CanvasTTY blocked this command: it asks for administrator rights (sudo, doas, runas). Do the work without elevation; if the task truly needs it, stop and ask the person to run that step.',
  'pipe-to-shell': 'CanvasTTY blocked this command: it pipes downloaded or generated text straight into a shell or interpreter. Download the file first, show what it contains, and ask the person before running it.',
  'download-exec': 'CanvasTTY blocked this command: it downloads code and runs it in one step. Download the file first, show what it contains, and ask the person before running it.',
  disk: 'CanvasTTY blocked this command: it erases, formats or writes a disk directly. Do not do this; ask the person if disk changes are really needed.',
  'fork-bomb': 'CanvasTTY blocked this command: it would exhaust the computer\'s processes. Do not run it.',
  'delete-outside': 'CanvasTTY blocked this command: it deletes files outside the project folder (or the folder itself). Delete only inside the project; if something elsewhere must go, ask the person.',
  'write-outside': 'CanvasTTY blocked this command: it writes outside the project folder. Keep changes inside the project; if a file elsewhere must change, ask the person.',
  'unknown-target': 'CanvasTTY blocked this command: it deletes or moves a path held in a shell variable or command output that CanvasTTY cannot resolve, so it cannot tell whether the path is inside the project folder. Write the path out, or set the variable in the same command to a path inside the project, and run it again.'
};
const TEMP_WRITE_MESSAGE = 'CanvasTTY blocked this command: it writes to the temporary folder (/tmp or $TMPDIR), which is outside the project folder. Make a scratch folder inside the project instead (for example ./tmp, added to .gitignore if needed) and use that; if a file elsewhere must change, ask the person.';

export interface BaseVerdict { rule: BaseDenyRule; message: string }

/** Tool names of the CLIs' hooks: shells and file writes. Anything else is not checked. */
const SHELL_TOOLS = new Set(['Bash', 'bash', 'run_shell_command', 'shell', 'local_shell', 'exec_command']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write_file', 'edit', 'replace', 'apply_patch']);
const MAX_PATHS = 32;
const MAX_PATH_CHARS = 4_096;

/** The files an `apply_patch` envelope touches. */
export function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gmu)) {
    const path = (match[1] ?? match[2] ?? '').trim();
    if (path && path.length <= MAX_PATH_CHARS) paths.push(path);
    if (paths.length >= MAX_PATHS) break;
  }
  return paths;
}

const PREVIEW_PATH = /"(?:file_path|filePath|path|notebook_path|absolute_path)"\s*:\s*"((?:[^"\\]|\\.){1,4096})"/gu;

/**
 * A hook's tool call as the rules read it. Only a shell tool carries a command; only a file tool carries paths.
 * For cut input only the path of a file tool at the start of its JSON preview is read (it can add a deny, never
 * anything else).
 */
export function actionFromHook(toolName: string, toolInput: unknown, preview: string | null = null): ToolAction {
  const raw = toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput) ? toolInput as Record<string, unknown> : null;
  const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_CHARS ? value : null;
  const commandCwd = text(raw?.cwd) ?? text(raw?.workdir) ?? text(raw?.directory);
  if (SHELL_TOOLS.has(toolName)) {
    const candidate = raw?.command ?? raw?.cmd;
    const command = typeof candidate === 'string' ? candidate
      : Array.isArray(candidate) && candidate.length && candidate.every(item => typeof item === 'string') ? commandFromArgv(candidate as string[]) : null;
    return { kind: 'shell', command, commandCwd, paths: [] };
  }
  if (!EDIT_TOOLS.has(toolName)) return { kind: null, command: null, commandCwd: null, paths: [] };
  if (!raw && preview && toolName !== 'apply_patch') {
    const paths: string[] = [];
    for (const match of preview.matchAll(PREVIEW_PATH)) {
      try { const value: unknown = JSON.parse(`"${match[1]}"`); if (typeof value === 'string' && value) paths.push(value); } catch { /* a cut escape */ }
      if (paths.length >= 4) break;
    }
    return { kind: 'edit', command: null, commandCwd: null, paths };
  }
  if (toolName === 'apply_patch') {
    const patch = text(raw?.command) ?? (typeof raw?.patch === 'string' ? raw.patch : typeof raw?.input === 'string' ? raw.input : typeof raw?.patchText === 'string' ? raw.patchText : '');
    return { kind: 'edit', command: null, commandCwd, paths: patchPaths(patch ?? '') };
  }
  const path = text(raw?.file_path) ?? text(raw?.filePath) ?? text(raw?.path) ?? text(raw?.notebook_path) ?? text(raw?.absolute_path);
  return { kind: 'edit', command: null, commandCwd: null, paths: path ? [path] : [] };
}

/**
 * CanvasTTY's own private data under its userData folder (the app passes `app.getPath('userData')`; tests pass a
 * temporary folder): the control token and descriptor, the gateways' connection records and sockets, the secret
 * stores, the per-account homes and the prepared launch runs. Its settings and layouts are not listed.
 */
export function canvasTtyPrivateData(userDataPath: string): PrivateData {
  const names = ['agent-control', join('browser', 'runtime'), join('lifecycle', 'runtime'), join('orchestration', 'runtime'),
    'provider-secrets.bin', 'plugin-secrets', 'account-homes', 'github-oauth.json', 'launch-runs', 'plugin-data',
    'checkpoints.json', 'checkpoint-objects', 'flow-approvals.json', 'task-budgets.json', 'usage-prices.json', 'session-timeline'];
  return {
    appRoots: [userDataPath],
    paths: names.map(name => join(userDataPath, name)),
    markers: ['agent-control', 'provider-secrets', 'plugin-secrets', 'account-homes', 'github-oauth', 'plugin-data',
      'checkpoints', 'checkpoint-objects', 'flow-approvals', 'task-budgets', 'usage-prices', 'session-timeline']
  };
}

/** The first deny rule a set of facts breaks, in a fixed order. */
export function denyRule(facts: HardFacts): BaseDenyRule | null {
  if (facts.appPrivate) return 'app-private';
  if (facts.elevation) return 'elevation';
  if (facts.pipeToShell) return 'pipe-to-shell';
  if (facts.downloadExec) return 'download-exec';
  if (facts.disk) return 'disk';
  if (facts.forkBomb) return 'fork-bomb';
  if (facts.deletesOutside) return 'delete-outside';
  if (facts.writesOutside) return 'write-outside';
  if (facts.unknownTarget) return 'unknown-target';
  return null;
}

/**
 * Base protection for one hook call: a deny with its message, or null (no opinion). `root` is the session's
 * working folder; `agentRoots` the agent's own config folders, whose plan and memory folders are not "outside".
 * Any failure is null: the rules only ever add a deny.
 */
export function checkBaseProtection(input: {
  toolName: string; toolInput: unknown; preview?: string | null; root: string; commandCwd?: string | null;
  home?: string; agentRoots?: readonly string[];
  /** CanvasTTY's own private data (canvasTtyPrivateData); its socket folders are known without it. */
  privateData?: PrivateData;
}): BaseVerdict | null {
  try {
    const action = actionFromHook(input.toolName, input.toolInput, input.preview ?? null);
    if (action.kind === null) return null;
    // The agent's current folder (the hook reports it) resolves relative paths; the working folder stays the root.
    if (!action.commandCwd && input.commandCwd) action.commandCwd = input.commandCwd;
    const facts = analyzeAction(action, input.root, {
      ...(input.home ? { home: input.home } : {}),
      ...(input.agentRoots ? { agentRoots: input.agentRoots } : {}),
      ...(input.privateData ? { privateData: input.privateData } : {})
    });
    const rule = denyRule(facts);
    if (!rule) return null;
    return { rule, message: rule === 'write-outside' && writesOnlyToTemp(facts) ? TEMP_WRITE_MESSAGE : DENY_MESSAGES[rule] };
  } catch {
    return null;
  }
}

/** The temporary folders of this computer, resolved (macOS: /tmp is /private/tmp; $TMPDIR is under /var/folders). */
function temporaryRoots(): string[] {
  const roots = new Set<string>();
  for (const path of ['/tmp', '/var/tmp', tmpdir(), process.env.TEMP ?? '', process.env.TMP ?? '']) {
    if (!path) continue;
    roots.add(path);
    roots.add(realish(path));
  }
  return [...roots];
}

const within = (path: string, root: string): boolean => isPathInside(root, path);

function writesOnlyToTemp(facts: HardFacts): boolean {
  if (facts.deletesOutside || !facts.outsideWrites.length) return false;
  const roots = temporaryRoots();
  return facts.outsideWrites.every(path => roots.some(root => within(path, root)));
}
