import { spawn as spawnChild } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AcpSessionState, AcpModelOption, AcpPermission } from '../../shared/contracts.ts';

const MAX_FRAME = 1_048_576;
const MAX_OUTPUT = 240_000;
const MAX_PROMPT = 65_536;
const MAX_PENDING = 64;
type Json = Record<string, unknown>;
type RpcId = string | number;
export type AcpProcess = Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr' | 'on' | 'removeListener' | 'kill' | 'pid'>;
export interface AcpOptions {
  spawn?: (command: string, args: string[], options: { cwd: string; env: Record<string, string>; stdio: 'pipe' }) => AcpProcess;
  deadlines?: Partial<Record<'initialize' | 'authenticate' | 'session' | 'turn' | 'permission' | 'cancel', number>>;
  orchestrationCommand?: { command: string; args: string[]; environment?: Record<string, string> };
}
export interface AcpLaunch {
  command: string; args: string[]; cwd: string; environment: Record<string, string>;
  provider: string; expectedModel?: string; requireModel?: boolean; restoreId?: string;
  mcpServers?: Json[];
  onState(state: AcpSessionState): void;
  onText(text: string): void;
  onSessionId(id: string): void;
  checkModel(value: string | undefined): void;
  onExit(): void | Promise<void>;
}
interface Pending { resolve(value: Json): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface Permission { wireId: RpcId; view: AcpPermission; timer: ReturnType<typeof setTimeout> }

/** Deliberately narrow ACP v1 JSONL client. No privileged filesystem or terminal handlers. */
export class ACPAdapter {
  readonly ready: Promise<void>;
  private resolveStopped!: () => void;
  private rejectStopped!: (error: Error) => void;
  readonly stopped = new Promise<void>((resolve, reject) => { this.resolveStopped = resolve; this.rejectStopped = reject; });
  private readonly child: AcpProcess;
  private readonly launch: AcpLaunch;
  private readonly deadlines;
  private pending = new Map<RpcId, Pending>();
  private permissions = new Map<string, Permission>();
  private incomingIds = new Set<RpcId>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private sessionId?: string;
  private modelConfigId?: string;
  private legacyModels = false;
  private closed = false;
  private failing = false;
  private exited = false;
  private turn = false;
  private changingModel = false;
  private cancelTimer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;
  private processGroup?: number;
  private groupCheckTimer?: ReturnType<typeof setTimeout>;
  private state: AcpSessionState = { phase: 'starting', output: '', models: [], permissions: [] };
  private readonly onData = (data: Buffer): void => this.receive(data);
  private readonly onStderr = (): void => { /* Drain; diagnostics may contain credentials. */ };
  private readonly onError = (): void => this.fail('ACP process failed. Check the installed CLI and existing account configuration.');
  private readonly onProcessExit = (): void => {
    if (this.exited) return;
    this.exited = true;
    this.fail('ACP process exited.', false);
    if (this.processGroup) {
      this.signal('SIGTERM'); this.armKill();
      const deadline = Date.now() + 5_000;
      const confirm = (): void => {
        if (!this.groupAlive()) { this.finishExit(); return; }
        if (Date.now() >= deadline) {
          this.state.error = 'ACP process group could not be confirmed stopped; workspace ownership is retained.'; this.publish();
          this.rejectStopped(new Error(this.state.error)); return;
        }
        this.groupCheckTimer = setTimeout(confirm, 25);
      };
      confirm();
      return;
    }
    this.finishExit();
  };
  private finishExit(): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    if (this.groupCheckTimer) clearTimeout(this.groupCheckTimer);
    this.child.removeListener('exit', this.onProcessExit); this.child.removeListener('close', this.onProcessExit);
    this.child.removeListener('error', this.onError);
    this.child.stdin.removeListener('error', this.onError); this.child.stdout.removeListener('error', this.onError); this.child.stderr.removeListener('error', this.onError);
    void Promise.resolve(this.launch.onExit()).finally(() => this.resolveStopped()).catch(() => undefined);
  }

  constructor(launch: AcpLaunch, options: AcpOptions = {}) {
    this.launch = launch;
    this.deadlines = { initialize: 15_000, authenticate: 15_000, session: 15_000, turn: 600_000, permission: 120_000, cancel: 2_000, ...options.deadlines };
    if (!options.spawn && process.platform === 'win32') throw new Error('ACP process-tree cleanup is not verified on Windows; use PTY.');
    this.child = (options.spawn ?? ((command, args, config) => spawnChild(command, args, { ...config, detached: true, windowsHide: true })))(launch.command, launch.args, { cwd: launch.cwd, env: launch.environment, stdio: 'pipe' });
    if (!options.spawn) this.processGroup = this.child.pid;
    void this.stopped.catch(() => undefined);
    this.child.stdout.on('data', this.onData); this.child.stderr.on('data', this.onStderr);
    this.child.on('error', this.onError); this.child.on('exit', this.onProcessExit); this.child.on('close', this.onProcessExit);
    this.child.stdin.on('error', this.onError); this.child.stdout.on('error', this.onError); this.child.stderr.on('error', this.onError);
    this.ready = this.initialize().catch(error => { this.fail(error instanceof Error ? error.message : 'ACP initialization failed.'); throw error; });
    // The manager awaits readiness; disposal may race the first await.
    void this.ready.catch(() => undefined);
  }

  private async initialize(): Promise<void> {
    const result = await this.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'canvastty', version: '1' } }, this.deadlines.initialize);
    if (result.protocolVersion !== 1) throw new Error('ACP requires protocol version 1.');
    const methods = Array.isArray(result.authMethods) ? result.authMethods : [];
    // Only Cursor's documented existing-login check. Never execute advertised login commands.
    if (this.launch.provider === 'cursor' && methods.some(m => record(m)?.id === 'cursor_login')) await this.call('authenticate', { methodId: 'cursor_login' }, this.deadlines.authenticate);
    const params = { cwd: this.launch.cwd, mcpServers: this.launch.mcpServers ?? [] };
    let session: Json;
    if (this.launch.restoreId) {
      if (record(result.agentCapabilities)?.loadSession !== true) throw new Error('ACP resume unavailable: this agent does not advertise loadSession.');
      this.sessionId = this.launch.restoreId; // load may replay updates before its response.
      session = await this.call('session/load', { ...params, sessionId: this.sessionId }, this.deadlines.session);
      if (session.sessionId !== undefined && session.sessionId !== this.sessionId) throw new Error('ACP restored a different session.');
    } else {
      session = await this.call('session/new', params, this.deadlines.session);
      if (!validString(session.sessionId, 512)) throw new Error('ACP returned an invalid session ID.');
      this.sessionId = session.sessionId;
    }
    this.controls(session);
    const expected = this.launch.expectedModel;
    if (expected !== undefined && this.state.effectiveModel !== expected) { this.launch.checkModel(expected); await this.setModelInternal(expected); }
    if (expected !== undefined && this.state.effectiveModel !== expected) throw new Error('ACP did not confirm the requested model.');
    if (this.launch.requireModel && !this.state.effectiveModel) throw new Error('ACP did not confirm the account model.');
    this.launch.checkModel(this.state.effectiveModel);
    if (this.closed) throw new Error('ACP session closed during initialization.');
    this.launch.onSessionId(this.sessionId!);
    this.state.phase = 'idle'; this.publish();
  }

  send(text: string): void {
    assertAcpPrompt(text);
    if (this.closed || this.state.phase === 'starting') throw new Error('ACP session is not ready.');
    if (this.turn || this.changingModel) throw new Error('ACP already has an active turn or model change.');
    this.launch.checkModel(this.state.effectiveModel);
    this.turn = true; this.state.phase = 'running'; this.state.output = ''; delete this.state.stopReason; delete this.state.error; delete this.state.activity;
    this.publish();
    void this.call('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }, this.deadlines.turn).then(result => {
      if (this.closed) return;
      if (!['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(String(result.stopReason))) throw new Error('ACP returned an invalid stop reason.');
      this.turn = false; this.clearCancel(); this.settlePermissions();
      this.state.phase = 'done'; this.state.stopReason = String(result.stopReason); this.publish();
    }).catch(error => this.fail(error instanceof Error ? error.message : 'ACP prompt failed.'));
  }

  validatePolicy(): void { this.launch.checkModel(this.state.effectiveModel); }

  cancel(): void {
    if (this.closed || !this.turn || this.cancelTimer) return;
    this.settlePermissions();
    this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } });
    this.cancelTimer = setTimeout(() => this.fail('ACP cancellation timed out; process stopped.'), this.deadlines.cancel);
  }

  decide(token: string, optionId: string): void {
    const permission = this.permissions.get(token);
    if (!this.turn || !permission || !permission.view.options.some(o => o.optionId === optionId)) throw new Error('ACP permission is absent, expired, or has an invalid option.');
    this.permissions.delete(token); clearTimeout(permission.timer);
    this.reply(permission.wireId, { outcome: { outcome: 'selected', optionId } }); this.publish();
  }

  async setModel(value: string): Promise<void> {
    if (this.closed || this.state.phase === 'starting' || this.turn || this.changingModel) throw new Error('ACP model can only change while idle.');
    this.launch.checkModel(value);
    this.changingModel = true;
    try { await this.setModelInternal(value); this.launch.checkModel(this.state.effectiveModel); }
    catch (error) { this.fail(error instanceof Error ? error.message : 'ACP model selection failed.'); throw error; }
    finally { this.changingModel = false; }
  }

  private async setModelInternal(value: string): Promise<void> {
    if (!this.state.models.some(option => option.value === value)) throw new Error('Requested ACP model is not advertised by this account.');
    if (this.modelConfigId) {
      const response = await this.call('session/set_config_option', { sessionId: this.sessionId, configId: this.modelConfigId, value }, this.deadlines.session);
      this.controls(response);
    } else if (this.legacyModels && this.launch.provider === 'cursor') {
      await this.call('session/set_model', { sessionId: this.sessionId, modelId: value }, this.deadlines.session);
      // A nominal success is not evidence; wait for an authoritative current_model_update.
    } else throw new Error('ACP model selection is unavailable.');
    if (this.state.effectiveModel !== value) throw new Error('ACP did not confirm the selected model.');
  }

  dispose(): void { this.fail('ACP session disposed.'); }
  snapshot(): AcpSessionState { return structuredClone(this.state); }

  private controls(response: Json): void {
    let models: AcpModelOption[] = [], current: string | undefined;
    this.modelConfigId = undefined; this.legacyModels = false;
    if (Array.isArray(response.configOptions)) {
      const model = response.configOptions.map(record).find(item => item?.category === 'model');
      if (model?.type === 'select' && validString(model.id, 256) && Array.isArray(model.options)) {
        const offered = model.options.flatMap(o => { const item = record(o); return Array.isArray(item?.options) ? item.options : [o]; });
        if (offered.length > 512) throw new Error('ACP model catalog exceeds the limit.');
        models = offered.map(record).filter((o): o is Json => !!o && validString(o.value, 1024) && validString(o.name, 256)).map(o => ({ value: o.value as string, name: o.name as string }));
        if (new Set(models.map(o => o.value)).size !== models.length) throw new Error('ACP model catalog contains ambiguous values.');
        if (typeof model.currentValue === 'string' && models.some(o => o.value === model.currentValue)) current = model.currentValue;
        this.modelConfigId = model.id;
      }
    } else if (this.launch.provider === 'cursor') {
      const legacy = record(response.models);
      if (legacy && Array.isArray(legacy.availableModels) && legacy.availableModels.length <= 512) {
        models = legacy.availableModels.map(record).filter((o): o is Json => !!o && validString(o.modelId, 1024) && validString(o.name, 256)).map(o => ({ value: o.modelId as string, name: o.name as string }));
        if (models.some(o => o.value === legacy.currentModelId)) current = legacy.currentModelId as string;
        this.legacyModels = true;
      }
    }
    this.state.models = models; this.state.effectiveModel = current;
    if (this.state.phase !== 'starting') this.checkChangedModel();
    this.publish();
  }

  private checkChangedModel(): void {
    try { this.launch.checkModel(this.state.effectiveModel); }
    catch { this.state.error = 'Effective ACP model is incompatible with the account policy.'; this.cancel(); }
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    // Copy only up to one bounded frame, even when the process emits a giant chunk.
    let start = 0;
    try {
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 10) continue;
        const part = chunk.subarray(start, i);
        if (this.buffer.length + part.length > MAX_FRAME) throw new Error('ACP frame exceeds the byte limit.');
        const line = Buffer.concat([this.buffer, part]); this.buffer = Buffer.alloc(0); start = i + 1;
        if (!line.length) throw new Error('ACP emitted an empty frame.');
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
        this.message(value);
        if (this.closed) return;
      }
      if (this.buffer.length + chunk.length - start > MAX_FRAME) throw new Error('ACP frame exceeds the byte limit.');
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(start)]);
    } catch { this.fail('ACP emitted invalid JSON-RPC, UTF-8, or an oversized frame.'); }
  }

  private message(raw: unknown): void {
    const message = record(raw);
    if (!message || message.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC.');
    const hasId = Object.hasOwn(message, 'id');
    if (hasId && !(typeof message.id === 'string' && message.id.length <= 256 || typeof message.id === 'number' && Number.isSafeInteger(message.id))) throw new Error('Invalid RPC ID.');
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) throw new Error('Invalid RPC request.');
      const params = record(message.params) ?? {};
      if (hasId) {
        const id = message.id as RpcId;
        if (this.incomingIds.has(id) || this.incomingIds.size >= 4096) throw new Error('Duplicate or excessive server request IDs.');
        this.incomingIds.add(id);
        if (message.method === 'session/request_permission') { this.permission(id, params); return; }
        if (message.method === 'cursor/ask_question' || message.method === 'cursor/create_plan') {
          this.reply(id, { outcome: { outcome: 'cancelled' } }); return;
        }
        this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Client method unavailable.' } }); return;
      }
      if (message.method === 'session/update') {
        if (!this.sessionId || params.sessionId !== this.sessionId) throw new Error('Foreign session update.');
        const update = record(params.update); if (!update) throw new Error('Invalid update.');
        if (update.sessionUpdate === 'agent_message_chunk') {
          const content = record(update.content);
          if ((this.turn || this.state.phase === 'starting') && content?.type === 'text' && typeof content.text === 'string') {
            const text = content.text.slice(-MAX_OUTPUT);
            this.state.output = (this.state.output + text).slice(-MAX_OUTPUT); this.launch.onText(text); this.publish();
          }
        } else if (update.sessionUpdate === 'config_option_update') this.controls(update);
        else if (update.sessionUpdate === 'current_model_update' && this.legacyModels && typeof update.currentModelId === 'string') {
          this.state.effectiveModel = update.currentModelId; this.checkChangedModel(); this.publish();
        } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          // Deliberately omit rawInput/rawOutput, hidden reasoning and file contents.
          this.state.activity = validString(update.title, 256) ? update.title : validString(update.status, 64) ? update.status : 'Tool activity'; this.publish();
        }
      }
      return;
    }
    if (!hasId || Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) throw new Error('Invalid RPC response.');
    const pending = this.pending.get(message.id as RpcId); if (!pending) throw new Error('Unknown RPC response ID.');
    this.pending.delete(message.id as RpcId); clearTimeout(pending.timer);
    if (message.error !== undefined) {
      const error = record(message.error);
      pending.reject(new Error(`ACP request failed (code ${typeof error?.code === 'number' ? error.code : 'unknown'}). Check existing authentication and model access; CanvasTTY will not start a login.`));
    } else {
      const result = record(message.result); if (!result) { pending.reject(new Error('Invalid ACP response result.')); throw new Error('Invalid result.'); }
      pending.resolve(result);
    }
  }

  private permission(id: RpcId, params: Json): void {
    if (!this.turn || this.cancelTimer || params.sessionId !== this.sessionId || !Array.isArray(params.options) || params.options.length < 1 || params.options.length > 16) {
      this.reply(id, { outcome: { outcome: 'cancelled' } }); return;
    }
    const options = params.options.map(record);
    if (options.some(o => !o || !validString(o.optionId, 256) || !validString(o.name, 256) || !['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(String(o.kind))) || new Set(options.map(o => o?.optionId)).size !== options.length || this.permissions.size >= 8) {
      this.reply(id, { outcome: { outcome: 'cancelled' } }); return;
    }
    const token = randomUUID();
    const title = record(params.toolCall)?.title;
    const view: AcpPermission = { requestId: token, title: validString(title, 256) ? title : 'Agent requests permission', options: options.map(o => ({ optionId: o!.optionId as string, name: o!.name as string, kind: o!.kind as string })) };
    const timer = setTimeout(() => { this.permissions.delete(token); this.reply(id, { outcome: { outcome: 'cancelled' } }); this.publish(); }, this.deadlines.permission);
    this.permissions.set(token, { wireId: id, view, timer }); this.publish();
  }

  private call(method: string, params: Json, timeout: number): Promise<Json> {
    if (this.closed || this.pending.size >= MAX_PENDING) return Promise.reject(new Error('ACP is closed or has too many pending requests.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(`ACP ${method} deadline exceeded.`), timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
  private write(message: Json): void {
    if (this.closed) return;
    try { if (this.child.stdin.writableLength > MAX_FRAME) throw new Error('Backpressure'); this.child.stdin.write(`${JSON.stringify(message)}\n`); }
    catch { this.fail('ACP input stream failed.'); }
  }
  private reply(id: RpcId, result: Json): void { this.write({ jsonrpc: '2.0', id, result }); }
  private settlePermissions(): void {
    for (const permission of this.permissions.values()) { clearTimeout(permission.timer); this.reply(permission.wireId, { outcome: { outcome: 'cancelled' } }); }
    this.permissions.clear(); this.publish();
  }
  private clearCancel(): void { if (this.cancelTimer) clearTimeout(this.cancelTimer); this.cancelTimer = undefined; }
  private publish(): void { this.state.permissions = [...this.permissions.values()].map(p => p.view); this.launch.onState(this.snapshot()); }
  private fail(message: string, kill = true): void {
    if (this.closed || this.failing) return;
    this.failing = true;
    this.settlePermissions(); this.closed = true; this.turn = false; this.clearCancel(); this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); } this.pending.clear();
    this.child.stdout.removeListener('data', this.onData); this.child.stderr.removeListener('data', this.onStderr);
    this.child.stdout.resume(); this.child.stderr.resume();
    this.state.phase = 'failed'; this.state.error = message; this.publish();
    if (kill) {
      this.armKill();
      try { this.child.stdin.end(); this.signal('SIGTERM'); } catch { /* Already closed. */ }
    }
  }
  private armKill(): void {
    if (this.killTimer) return;
    this.killTimer = setTimeout(() => this.signal('SIGKILL'), 1_000); this.killTimer.unref?.();
  }
  private signal(signal: NodeJS.Signals): void {
    try { if (this.processGroup) process.kill(-this.processGroup, signal); else this.child.kill(signal); } catch { /* Already stopped. */ }
  }
  private groupAlive(): boolean {
    try { process.kill(-this.processGroup!, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }

}
export function assertAcpPrompt(text: unknown): asserts text is string {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_PROMPT) throw new Error('ACP prompt must contain 1–65536 characters.');
}
function record(value: unknown): Json | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined; }
function validString(value: unknown, limit: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value); }

export function miniMaxModelValue(provider: string, model: string): string { return `m:${encodeURIComponent(provider)}:${encodeURIComponent(model)}:u`; }
export function miniMaxModelIdentity(value: string): { provider: string; model: string } {
  const parts = value.split(':');
  if (parts[0] !== 'm' || !(parts.length === 4 && parts[3] === 'u' || parts.length === 5 && parts[3] === 'v' && parts[4])) throw new Error('MiniMax model identity is invalid.');
  const provider = decodeURIComponent(parts[1]); const model = decodeURIComponent(parts[2]);
  if (!validString(provider, 256) || !validString(model, 512) || encodeURIComponent(provider) !== parts[1] || encodeURIComponent(model) !== parts[2]) throw new Error('MiniMax model identity is invalid.');
  return { provider, model };
}
