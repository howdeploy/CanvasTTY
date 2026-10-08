import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type OrchestrationTaskStatus = "open" | "claimed" | "done" | "closed";

export interface OrchestrationTask {
  id: string;
  rootSessionId: string;
  title: string;
  description: string;
  progress: string;
  ownerSessionId: string | null;
  ownerName: string | null;
  status: OrchestrationTaskStatus;
  dependencies: string[];
  result: string | null;
  createdBySessionId: string;
  createdAt: number;
  updatedAt: number;
}

export interface OrchestrationTaskBoardChange {
  projectRoot: string;
  rootSessionId: string;
  tasks: OrchestrationTask[];
  revision: number;
}

export interface NewOrchestrationTask {
  title: string;
  description?: string;
  dependencies?: string[];
  ownerSessionId?: string | null;
  ownerName?: string | null;
}

export interface OrchestrationTaskPatch {
  title?: string;
  description?: string;
  progress?: string;
  status?: "open" | "claimed";
  ownerSessionId?: string | null;
  ownerName?: string | null;
  dependencies?: string[];
}

interface BoardState {
  version: 1;
  revision: number;
  tasks: OrchestrationTask[];
}

const EMPTY_BOARD: BoardState = { version: 1, revision: 0, tasks: [] };
const MAX_TASKS = 512;
const MAX_TITLE = 240;
const MAX_DESCRIPTION = 8_000;
const MAX_PROGRESS = 4_000;
const MAX_RESULT = 8_000;
const MAX_DEPENDENCIES = 64;
const locks = new Map<string, Promise<void>>();

/**
 * Atomic, project-keyed task storage outside the project tree. Agent shell tools can edit project files but cannot
 * bypass these ownership checks by editing the board file. One root session owns one task group on the project board.
 */
export class OrchestrationTaskBoard {
  private readonly storageRoot: string;
  private readonly listeners = new Set<(change: OrchestrationTaskBoardChange) => void>();

  constructor(storageRoot: string) {
    this.storageRoot = resolve(storageRoot);
  }

  subscribe(listener: (change: OrchestrationTaskBoardChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Agent-facing list is always scoped to one root orchestrator. */
  async listTasks(projectRoot: string, rootSessionId: string): Promise<{ revision: number; tasks: OrchestrationTask[] }> {
    requireId(rootSessionId, "rootSessionId");
    const state = await this.read(this.boardLocation(projectRoot).path);
    return { revision: state.revision, tasks: state.tasks.filter((task) => task.rootSessionId === rootSessionId).map(copyTask) };
  }

  /** Human-facing project view groups tasks by orchestrator; it is not exposed through agent tools. */
  async listProjectTasks(projectRoot: string): Promise<{ revision: number; tasks: OrchestrationTask[] }> {
    const state = await this.read(this.boardLocation(projectRoot).path);
    return { revision: state.revision, tasks: state.tasks.map(copyTask) };
  }

  async addTask(projectRoot: string, rootSessionId: string, createdBySessionId: string, input: NewOrchestrationTask): Promise<OrchestrationTask> {
    requireId(rootSessionId, "rootSessionId");
    requireId(createdBySessionId, "createdBySessionId");
    return this.mutate(projectRoot, rootSessionId, (state) => {
      ensureCapacity(state);
      const dependencies = validateDependencies(input.dependencies ?? []);
      ensureDependenciesExist(state, rootSessionId, dependencies);
      const now = Date.now();
      const next: OrchestrationTask = {
        id: randomUUID(), rootSessionId, title: requiredText(input.title, "title", MAX_TITLE),
        description: optionalText(input.description, "description", MAX_DESCRIPTION) ?? "",
        progress: "", ownerSessionId: optionalId(input.ownerSessionId), ownerName: optionalName(input.ownerName),
        status: input.ownerSessionId ? "claimed" : "open", dependencies, result: null,
        createdBySessionId, createdAt: now, updatedAt: now
      };
      state.tasks.push(next);
      return copyTask(next);
    });
  }

  /** Atomic claim: competing callers serialize through the store lock; the loser gets the current owner. */
  async claimTask(projectRoot: string, rootSessionId: string, actorSessionId: string, actorName: string, taskId: string): Promise<OrchestrationTask> {
    requireId(rootSessionId, "rootSessionId");
    requireId(actorSessionId, "actorSessionId");
    requireId(taskId, "taskId");
    return this.mutate(projectRoot, rootSessionId, (state) => {
      const task = findTask(state, rootSessionId, taskId);
      if (task.status === "claimed" && task.ownerSessionId !== actorSessionId) {
        const owner = task.ownerName || task.ownerSessionId || "another agent";
        throw new Error(`Task ${task.id} is already claimed by ${owner}.`);
      }
      if (task.status !== "open" && !(task.status === "claimed" && task.ownerSessionId === actorSessionId)) {
        throw new Error(`Task ${task.id} is ${task.status} and cannot be claimed.`);
      }
      requireDependenciesDone(state, rootSessionId, task);
      task.ownerSessionId = actorSessionId;
      task.ownerName = optionalName(actorName) ?? actorSessionId;
      task.status = "claimed";
      task.updatedAt = Date.now();
      return copyTask(task);
    });
  }

  /** Agent edits are limited to the task it owns; only the root orchestrator may reassign or alter dependencies. */
  async updateTask(projectRoot: string, rootSessionId: string, actorSessionId: string, taskId: string, patch: OrchestrationTaskPatch): Promise<OrchestrationTask> {
    return this.editTask(projectRoot, rootSessionId, actorSessionId, taskId, patch, false);
  }

  private async editTask(projectRoot: string, rootSessionId: string, actorSessionId: string, taskId: string, patch: OrchestrationTaskPatch, person: boolean): Promise<OrchestrationTask> {
    requireId(rootSessionId, "rootSessionId");
    requireId(actorSessionId, "actorSessionId");
    requireId(taskId, "taskId");
    if (!isRecord(patch) || Object.keys(patch).length === 0) throw new Error("At least one task field is required.");
    const allowed = new Set(["title", "description", "progress", "status", "ownerSessionId", "ownerName", "dependencies"]);
    const extra = Object.keys(patch).find((key) => !allowed.has(key));
    if (extra) throw new Error(`Unknown task field "${extra}".`);
    return this.mutate(projectRoot, rootSessionId, (state) => {
      const task = findTask(state, rootSessionId, taskId);
      if (!person && (task.status === "closed" || task.status === "done")) {
        throw new Error(`Task ${task.id} is ${task.status}; only the person may reopen or change it.`);
      }
      const isRoot = actorSessionId === rootSessionId;
      if (!isRoot && task.ownerSessionId !== actorSessionId) throw new Error(`Task ${task.id} belongs to another agent.`);
      if (!isRoot && (patch.ownerSessionId !== undefined || patch.ownerName !== undefined || patch.dependencies !== undefined)) {
        throw new Error("Only the orchestrator or person may reassign a task or change its dependencies.");
      }
      if (patch.title !== undefined) task.title = requiredText(patch.title, "title", MAX_TITLE);
      if (patch.description !== undefined) task.description = requiredText(patch.description, "description", MAX_DESCRIPTION);
      if (patch.progress !== undefined) task.progress = requiredText(patch.progress, "progress", MAX_PROGRESS);
      if (patch.dependencies !== undefined) {
        task.dependencies = validateDependencies(patch.dependencies);
        if (task.dependencies.includes(task.id)) throw new Error("A task cannot depend on itself.");
        ensureDependenciesExist(state, rootSessionId, task.dependencies);
        assertAcyclic(state.tasks.filter((item) => item.rootSessionId === rootSessionId), task.id);
      }
      if (patch.ownerSessionId !== undefined) {
        task.ownerSessionId = optionalId(patch.ownerSessionId);
        if (task.ownerSessionId === null) task.ownerName = null;
        else if (patch.ownerName !== undefined) task.ownerName = optionalName(patch.ownerName) ?? task.ownerSessionId;
        task.status = task.ownerSessionId ? "claimed" : "open";
      } else if (patch.ownerName !== undefined && isRoot) {
        task.ownerName = optionalName(patch.ownerName);
      }
      if (patch.status !== undefined) {
        if (patch.status === "claimed" && !task.ownerSessionId) throw new Error("A task must have an owner before it can be claimed.");
        if (patch.status === "open") {
          if (!isRoot && task.ownerSessionId !== actorSessionId) throw new Error("Only the task owner or orchestrator can release this task.");
          task.ownerSessionId = null;
          task.ownerName = null;
        }
        task.status = patch.status as "open" | "claimed";
      }
      task.updatedAt = Date.now();
      return copyTask(task);
    });
  }

  async completeTask(projectRoot: string, rootSessionId: string, actorSessionId: string, taskId: string, result: string): Promise<OrchestrationTask> {
    requireId(rootSessionId, "rootSessionId");
    requireId(actorSessionId, "actorSessionId");
    requireId(taskId, "taskId");
    const text = requiredText(result, "result", MAX_RESULT);
    return this.mutate(projectRoot, rootSessionId, (state) => {
      const task = findTask(state, rootSessionId, taskId);
      if (actorSessionId !== rootSessionId && task.ownerSessionId !== actorSessionId) throw new Error(`Task ${task.id} belongs to another agent.`);
      if (task.status === "done" || task.status === "closed") throw new Error(`Task ${task.id} is already ${task.status}.`);
      requireDependenciesDone(state, rootSessionId, task);
      task.status = "done";
      task.result = text;
      task.updatedAt = Date.now();
      return copyTask(task);
    });
  }

  /** Person/UI operations use explicit methods that bypass agent ownership while retaining the same atomic store. */
  async assignTask(projectRoot: string, rootSessionId: string, taskId: string, ownerSessionId: string | null, ownerName?: string | null): Promise<OrchestrationTask> {
    return this.editTask(projectRoot, rootSessionId, rootSessionId, taskId, { ownerSessionId, ...(ownerName !== undefined ? { ownerName } : {}) }, true);
  }

  async closeTask(projectRoot: string, rootSessionId: string, taskId: string): Promise<OrchestrationTask> {
    return this.mutate(projectRoot, rootSessionId, (state) => {
      const task = findTask(state, rootSessionId, taskId);
      task.status = "closed";
      task.updatedAt = Date.now();
      return copyTask(task);
    });
  }

  async reopenTask(projectRoot: string, rootSessionId: string, taskId: string): Promise<OrchestrationTask> {
    return this.mutate(projectRoot, rootSessionId, (state) => {
      const task = findTask(state, rootSessionId, taskId);
      if (task.status === "done") throw new Error("A completed task cannot be reopened without being edited first.");
      task.status = task.ownerSessionId ? "claimed" : "open";
      task.updatedAt = Date.now();
      return copyTask(task);
    });
  }

  /** Host-only workspace import. All ids are remapped, and a malformed graph writes nothing. */
  async importGroup(projectRoot:string,rootSessionId:string,rows:unknown,sessionIds:Record<string,string>):Promise<void> {
    requireId(rootSessionId,"rootSessionId");
    if(!Array.isArray(rows) || rows.length>MAX_TASKS || !rows.every(isOrchestrationTask))throw new Error("Invalid workspace task board.");
    const ids=new Map(rows.map(row=>[row.id,randomUUID()]));
    if(ids.size!==rows.length)throw new Error("Workspace tasks contain duplicate ids.");
    const imported:OrchestrationTask[]=rows.map(row=>({
      id:ids.get(row.id)!,rootSessionId,title:requiredText(row.title,"title",MAX_TITLE),
      description:optionalText(row.description,"description",MAX_DESCRIPTION) ?? "",
      progress:optionalText(row.progress,"progress",MAX_PROGRESS) ?? "",
      ownerSessionId:row.ownerSessionId ? sessionIds[row.ownerSessionId] ?? null : null,
      ownerName:row.ownerSessionId && sessionIds[row.ownerSessionId] ? optionalText(row.ownerName,"ownerName",200) ?? null : null,
      status:row.status==="claimed" && (!row.ownerSessionId || !sessionIds[row.ownerSessionId]) ? "open" : row.status,
      dependencies:validateDependencies(row.dependencies).map(id=>{const mapped=ids.get(id);if(!mapped)throw new Error("Workspace task has a missing dependency.");return mapped;}),
      result:optionalText(row.result,"result",MAX_RESULT) ?? null,
      createdBySessionId:sessionIds[row.createdBySessionId] ?? rootSessionId,createdAt:row.createdAt,updatedAt:row.updatedAt
    }));
    assertAcyclic(imported);
    await this.mutate(projectRoot,rootSessionId,state=>{if(state.tasks.length+imported.length>MAX_TASKS)throw new Error("Workspace task board exceeds capacity.");state.tasks.push(...imported);});
  }

  private async read(path: string): Promise<BoardState> {
    try {
      const text = await readFile(path, "utf8");
      if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) throw new Error("Task board exceeds 2 MB.");
      const candidate: unknown = JSON.parse(text);
      if (!isBoardState(candidate)) throw new Error("Task board has an invalid format.");
      return candidate;
    } catch (error) {
      if (isMissing(error)) return structuredClone(EMPTY_BOARD);
      throw new Error(`Could not read orchestration task board: ${errorText(error)}`);
    }
  }

  private async mutate<T>(projectRoot: string, rootSessionId: string, mutation: (state: BoardState) => T): Promise<T> {
    const location = this.boardLocation(projectRoot);
    return withLock(location.path, async () => {
      const state = await this.read(location.path);
      const result = mutation(state);
      state.revision += 1;
      const payload = JSON.stringify(state);
      if (Buffer.byteLength(payload, "utf8") > 2 * 1024 * 1024) throw new Error("Task board exceeds 2 MB.");
      await mkdir(dirname(location.path), { recursive: true, mode: 0o700 });
      const temporary = `${location.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try { await rename(temporary, location.path); }
      catch (error) {
        const { unlink } = await import("node:fs/promises");
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      const change: OrchestrationTaskBoardChange = {
        projectRoot: location.normalizedRoot,
        rootSessionId,
        revision: state.revision,
        tasks: state.tasks.filter((task) => task.rootSessionId === rootSessionId).map(copyTask)
      };
      for (const listener of this.listeners) {
        try { listener(change); } catch { /* one renderer listener cannot prevent persistence or another listener */ }
      }
      return result;
    });
  }

  private boardLocation(projectRoot: string): {path:string;normalizedRoot:string} {
    const normalizedRoot=resolve(projectRoot);
    const digest=createHash("sha256").update(normalizedRoot).digest("hex").slice(0,40);
    return {path:join(this.storageRoot,"orchestration-tasks",`${digest}.json`),normalizedRoot};
  }
}

function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolveLock) => { release = resolveLock; });
  locks.set(key, next);
  return previous.catch(() => undefined).then(run).finally(() => {
    release();
    if (locks.get(key) === next) locks.delete(key);
  });
}

function ensureCapacity(state: BoardState): void { if (state.tasks.length >= MAX_TASKS) throw new Error(`The project task board holds at most ${MAX_TASKS} tasks.`); }
function findTask(state: BoardState, rootSessionId: string, taskId: string): OrchestrationTask {
  const task = state.tasks.find((item) => item.rootSessionId === rootSessionId && item.id === taskId);
  if (!task) throw new Error("Task does not exist in this orchestrator's task group.");
  return task;
}
function ensureDependenciesExist(state: BoardState, rootSessionId: string, dependencies: string[]): void {
  for (const id of dependencies) findTask(state, rootSessionId, id);
}
function requireDependenciesDone(state: BoardState, rootSessionId: string, task: OrchestrationTask): void {
  const waiting = task.dependencies.map((id) => findTask(state, rootSessionId, id)).filter((dependency) => dependency.status !== "done");
  if (waiting.length > 0) throw new Error(`Task ${task.id} is waiting for dependencies: ${waiting.map((item) => item.title).join(", ")}.`);
}
function assertAcyclic(tasks: readonly OrchestrationTask[], startAt?: string): void {
  const byId = new Map(tasks.map((task) => [task.id, task])), active = new Set<string>(), checked = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) throw new Error("Task dependencies cannot form a cycle.");
    if (checked.has(id)) return;
    active.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    active.delete(id);
    checked.add(id);
  };
  for (const id of startAt ? [startAt] : tasks.map((task) => task.id)) visit(id);
}
function validateDependencies(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_DEPENDENCIES || value.some((item) => typeof item !== "string" || item.length > 80)) {
    throw new Error(`dependencies must be an array of at most ${MAX_DEPENDENCIES} task ids.`);
  }
  const result = [...new Set(value as string[])];
  if (result.length !== value.length) throw new Error("dependencies cannot contain duplicates.");
  return result;
}
function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) throw new Error(`${name} must contain 1 to ${max} characters.`);
  return value.trim();
}
function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max) throw new Error(`${name} must be at most ${max} characters.`);
  return value.trim();
}
function requireId(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || value.length < 1 || value.length > 160) throw new Error(`${name} is invalid.`); }
function optionalId(value: unknown): string | null { if (value === undefined || value === null || value === "") return null; requireId(value, "ownerSessionId"); return value; }
function optionalName(value: unknown): string | null { if (value === undefined || value === null || value === "") return null; if (typeof value !== "string" || value.length > 160) throw new Error("ownerName is invalid."); return value.trim(); }
function copyTask(task: OrchestrationTask): OrchestrationTask { return { ...task, dependencies: [...task.dependencies] }; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isBoardState(value: unknown): value is BoardState {
  return isRecord(value) && value.version === 1 && Number.isInteger(value.revision) && Array.isArray(value.tasks)
    && value.tasks.length <= MAX_TASKS && value.tasks.every(isOrchestrationTask);
}
function isOrchestrationTask(value: unknown): value is OrchestrationTask {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.rootSessionId === "string" && typeof value.title === "string"
    && typeof value.description === "string" && typeof value.progress === "string"
    && (value.ownerSessionId === null || typeof value.ownerSessionId === "string")
    && (value.ownerName === null || typeof value.ownerName === "string")
    && ["open", "claimed", "done", "closed"].includes(value.status as string)
    && Array.isArray(value.dependencies) && value.dependencies.every((dependency) => typeof dependency === "string")
    && (value.result === null || typeof value.result === "string") && typeof value.createdBySessionId === "string"
    && Number.isFinite(value.createdAt) && Number.isFinite(value.updatedAt);
}
function isMissing(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"); }
function errorText(error: unknown): string { return error instanceof Error ? error.message.slice(0, 240) : "file is unavailable"; }
