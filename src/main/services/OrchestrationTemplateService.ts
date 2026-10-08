import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { lazyRequire } from "../lazyRequire.ts";
const yaml = lazyRequire<typeof import("yaml")>("yaml");
import type { ReasoningEffort } from "../../shared/launchModel.ts";

const FLOW_DIRECTORY = join(".canvastty", "flows");
const MAX_FLOW_BYTES = 64 * 1024;
const MAX_FLOW_FILES = 128;
const MAX_ROLES = 16;
const MAX_TEXT = 8_000;
const ALLOWED_KEYS = new Set(["id", "name", "description", "roles", "finalStep"]);
const ROLE_KEYS = new Set(["id", "title", "instruction", "count", "model", "effort"]);
const EFFORTS = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);

export interface OrchestrationTemplateRole {
  id: string;
  title: string;
  instruction: string;
  count: number;
  model?: string;
  effort?: ReasoningEffort;
}

/** A flow can choose role names, prompts, a model and reasoning effort; it cannot change the caller's permissions. */
export interface OrchestrationTemplate {
  id: string;
  name: string;
  description: string;
  roles: OrchestrationTemplateRole[];
  finalStep: string;
  expectedSubagents: number;
  builtIn: boolean;
  source?: string;
  trusted?: boolean;
  digest?: string;
}

export interface OrchestrationTemplateIssue {
  file: string;
  line: number;
  message: string;
}

export interface OrchestrationTemplateList {
  templates: OrchestrationTemplate[];
  errors: OrchestrationTemplateIssue[];
}

const BUILT_IN_FLOWS: readonly Omit<OrchestrationTemplate, "expectedSubagents" | "builtIn">[] = [
  {
    id: "split-parallel-synthesize",
    name: "Split, work in parallel, synthesize",
    description: "Break a task into independent pieces, run the pieces concurrently, then combine the results.",
    roles: [
      { id: "planner", title: "Plan the split", instruction: "Break the requested work into independent, bounded parts. Do not edit files. Return the parts and dependencies.", count: 1 },
      { id: "worker", title: "Complete one part", instruction: "Complete only the assigned part. State changed files and the result clearly.", count: 3 }
    ],
    finalStep: "Review every result, resolve conflicts, and present one concise combined outcome."
  },
  {
    id: "executor-reviewer",
    name: "Executor and reviewer",
    description: "One agent implements; a second independently reviews the diff and reports concrete issues.",
    roles: [
      { id: "executor", title: "Implement", instruction: "Implement the requested change and report the files changed and verification performed.", count: 1 },
      { id: "reviewer", title: "Review", instruction: "Read the implementation diff and report only actionable bugs, regressions, and missing checks. Do not modify files.", count: 1, effort: "high" }
    ],
    finalStep: "Consider the review findings, ask the executor to fix valid issues, then report the final change and remaining risks."
  },
  {
    id: "three-options-judge",
    name: "Three options and a judge",
    description: "Explore three independent solutions and compare them against the request before choosing.",
    roles: [
      { id: "option", title: "Propose one solution", instruction: "Develop one distinct solution. Explain tradeoffs and how it meets the request.", count: 3 },
      { id: "judge", title: "Compare the options", instruction: "Compare the three proposals against the user's constraints. Choose one and explain why.", count: 1, effort: "high" }
    ],
    finalStep: "Present the selected option, its reason, and the main tradeoff. Do not implement without the user's request."
  },
  {
    id: "find-and-verify-bugs",
    name: "Find bugs and verify findings",
    description: "Search independently for defects, then have another agent validate each candidate against the source.",
    roles: [
      { id: "finder", title: "Find candidate bugs", instruction: "Inspect the assigned area and return specific candidate bugs with file and line evidence. Do not edit files.", count: 2 },
      { id: "verifier", title: "Verify candidate bugs", instruction: "Check each candidate against source and call paths. Reject false positives and provide evidence for validated bugs.", count: 1, effort: "high" }
    ],
    finalStep: "Report only independently verified findings, with impact and source evidence."
  }
];

/** Loads project flows on every call so a new file is visible without restarting CanvasTTY. */
export class OrchestrationTemplateService {
  private readonly approvedTemplates = new WeakSet<object>();
  private approvalQueue: Promise<void> = Promise.resolve();
  private readonly approvalPath?: string;
  constructor(approvalPath?: string) { this.approvalPath = approvalPath; }

  async list(projectRoot: string): Promise<OrchestrationTemplateList> {
    const templates: OrchestrationTemplate[] = BUILT_IN_FLOWS.map((flow) => ({
      ...structuredClone(flow),
      expectedSubagents: flow.roles.reduce((sum, role) => sum + role.count, 0),
      builtIn: true, trusted: true
    }));
    for (const template of templates) this.approvedTemplates.add(template);
    const errors: OrchestrationTemplateIssue[] = [];
    const root = await realpath(projectRoot);
    let approvals = new Map<string, string>();
    try { approvals = await this.readApprovals(); }
    catch { errors.push({ file: "flow approvals", line: 0, message: "Flow approvals could not be read. Project flows require approval again before use." }); }
    let flowDirectory: string | null;
    try { flowDirectory = await projectFlowDirectory(root, false); }
    catch { return { templates, errors: [{ file: FLOW_DIRECTORY, line: 1, message: "The flow directory must stay inside the project." }] }; }
    if (!flowDirectory) return { templates, errors };
    let files: string[];
    try {
      files = (await readdir(flowDirectory)).filter((file) => /\.(?:yaml|yml)$/iu.test(file)).sort().slice(0, MAX_FLOW_FILES);
    } catch (error) {
      if (isMissing(error)) return { templates, errors };
      return { templates, errors: [{ file: FLOW_DIRECTORY, line: 1, message: "The flow directory could not be read." }] };
    }
    for (const file of files) {
      const display = `${FLOW_DIRECTORY}/${file}`;
      try {
        const path = join(flowDirectory, file);
        const [actual, info] = await Promise.all([realpath(path), stat(path)]);
        if (!info.isFile()) {
          errors.push({ file: display, line: 1, message: "Flow files must be regular files inside .canvastty/flows." });
          continue;
        }
        try { assertInsideProject(flowDirectory, actual); }
        catch {
          errors.push({ file: display, line: 1, message: "Flow files must be regular files inside .canvastty/flows." });
          continue;
        }
        if (info.size > MAX_FLOW_BYTES) {
          errors.push({ file: display, line: 1, message: `Flow file exceeds ${MAX_FLOW_BYTES} bytes.` });
          continue;
        }
        const source = await readFile(actual, "utf8");
        if (Buffer.byteLength(source, "utf8") > MAX_FLOW_BYTES) throw new Error("Flow changed beyond its size limit.");
        const parsed = parseFlow(source, display);
        if ("issue" in parsed) errors.push(parsed.issue);
        else if (templates.some((item) => item.id === parsed.template.id)) {
          errors.push({ file: display, line: 1, message: `Flow id "${parsed.template.id}" is already in use.` });
        } else {
          const digest = createHash("sha256").update(source).digest("hex");
          const trusted = approvals.get(JSON.stringify([root, parsed.template.id])) === digest;
          const template = { ...parsed.template, digest, trusted };
          templates.push(template);
          if (trusted) this.approvedTemplates.add(template);
        }
      } catch {
        errors.push({ file: display, line: 1, message: "Flow file could not be read." });
      }
    }
    return { templates, errors };
  }

  /** Writes a validated project flow with an atomic replace. Built-in ids cannot be shadowed. */
  async save(projectRoot: string, flow: Omit<OrchestrationTemplate, "builtIn" | "source" | "expectedSubagents">): Promise<string> {
    const source = yaml().stringify(flow);
    if (Buffer.byteLength(source, "utf8") > MAX_FLOW_BYTES) throw new Error(`Flow file exceeds ${MAX_FLOW_BYTES} bytes.`);
    const parsed = parseFlow(source, "flow.yaml");
    if ("issue" in parsed) throw new Error(formatIssue(parsed.issue));
    if (BUILT_IN_FLOWS.some((builtIn) => builtIn.id === parsed.template.id)) throw new Error("A built-in flow cannot be overwritten.");
    const directory = await projectFlowDirectory(await realpath(projectRoot), true);
    const safeId = parsed.template.id.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "");
    if (!safeId) throw new Error("Flow id must include a letter or number.");
    const target = join(directory, `${safeId}.yaml`);
    const temporary = join(directory, `.${safeId}.${randomUUID()}.tmp`);
    await writeFile(temporary, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { await rename(temporary, target); }
    catch (error) {
      const { unlink } = await import("node:fs/promises");
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return target;
  }

  /** The string a launcher can append to the orchestrator's initial prompt. */
  instructions(template: OrchestrationTemplate): string {
    if (!this.approvedTemplates.has(template)) throw new Error("This project flow requires the person's approval of its current instructions.");
    return buildOrchestrationTemplateInstructions(template);
  }

  /** Desktop-only preview: the agent tools never return unapproved prompt fields. */
  async preview(projectRoot: string, id: string): Promise<{ instructions: string; digest: string | null }> {
    const template = (await this.list(projectRoot)).templates.find(row => row.id === id);
    if (!template) throw new Error("Flow no longer exists.");
    return { instructions: buildOrchestrationTemplateInstructions(template), digest: template.digest ?? null };
  }

  /** Bind approval to the exact bytes shown by the desktop, outside every agent-writable project. */
  approve(projectRoot: string, id: string, expectedDigest: string): Promise<void> {
    const work = this.approvalQueue.then(async () => {
      if (!this.approvalPath) throw new Error("Flow approval storage is unavailable.");
      const root = await realpath(projectRoot);
      const template = (await this.list(root)).templates.find(row => row.id === id);
      if (!template || template.builtIn || !/^[a-f0-9]{64}$/u.test(expectedDigest) || template.digest !== expectedDigest)
        throw new Error("Flow changed since the preview. Review its current instructions before approval.");
      const approvals = await this.readApprovals(), key = JSON.stringify([root, id]);
      if (!approvals.has(key) && approvals.size >= 4096) throw new Error("Flow approval storage is full.");
      approvals.set(key, expectedDigest);
      await mkdir(dirname(this.approvalPath), { recursive: true, mode: 0o700 });
      const temporary = `${this.approvalPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify([...approvals]), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.approvalPath);
      } finally { await rm(temporary, { force: true }); }
    });
    this.approvalQueue = work.catch(() => undefined);
    return work;
  }

  private async readApprovals(): Promise<Map<string, string>> {
    if (!this.approvalPath) return new Map();
    let text: string;
    try { text = await readFile(this.approvalPath, "utf8"); }
    catch (error) { if (isMissing(error)) return new Map(); throw error; }
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("Flow approvals are too large.");
    const entries: unknown = JSON.parse(text);
    if (!Array.isArray(entries) || entries.length > 4096) throw new Error("Invalid flow approvals.");
    const map = new Map<string, string>();
    for (const row of entries) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || typeof row[1] !== "string" || !/^[a-f0-9]{64}$/u.test(row[1]))
        throw new Error("Invalid flow approval.");
      const key: unknown = JSON.parse(row[0]);
      if (!Array.isArray(key) || key.length !== 2 || typeof key[0] !== "string" || !isAbsolute(key[0]) || typeof key[1] !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(key[1]))
        throw new Error("Invalid flow approval scope.");
      map.set(row[0], row[1]);
    }
    return map;
  }
}

/** Resolve flow paths inside the canonical project root, creating missing components only for saves. */
async function projectFlowDirectory(root: string, createIfMissing: true): Promise<string>;
async function projectFlowDirectory(root: string, createIfMissing: false): Promise<string | null>;
async function projectFlowDirectory(root: string, createIfMissing: boolean): Promise<string | null> {
  let directory = root;
  for (const name of [".canvastty", "flows"]) {
    const path = join(directory, name);
    try { directory = await realpath(path); }
    catch (error) {
      if (!isMissing(error)) throw error;
      if (!createIfMissing) return null;
      await mkdir(path, { mode: 0o700 });
      directory = await realpath(path);
    }
    assertInsideProject(root, directory);
  }
  return directory;
}

function assertInsideProject(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Orchestration flow paths must stay inside the project.");
  }
}

export function buildOrchestrationTemplateInstructions(template: OrchestrationTemplate): string {
  return [
    `Orchestration flow: ${template.name}`,
    template.description,
    `Expected subagents: ${template.expectedSubagents}.`,
    "Follow the roles below in order; start independent roles in parallel when dependencies allow.",
    ...template.roles.map((role) => {
      const defaults = [role.model ? `model=${role.model}` : "", role.effort ? `effort=${role.effort}` : ""].filter(Boolean).join(", ");
      return `- ${role.count} × ${role.title} (${role.id})${defaults ? `; suggested ${defaults}` : ""}: ${role.instruction}`;
    }),
    `Final step: ${template.finalStep}`,
    "A flow only sets a work pattern and model defaults. Preserve the orchestration permissions, project-folder limits, launch profile ceiling, and budgets already enforced by CanvasTTY.",
    "User task:",
    "{{TASK}}"
  ].join("\n");
}

function parseFlow(source: string, file: string): { template: OrchestrationTemplate } | { issue: OrchestrationTemplateIssue } {
  let document;
  const lines=new (yaml().LineCounter)();
  try { document = yaml().parseDocument(source, { uniqueKeys: true, prettyErrors: false, lineCounter:lines }); }
  catch (error) { return { issue: { file, line: 1, message: `Invalid YAML: ${message(error)}` } }; }
  if (document.errors.length > 0) {
    const error = document.errors[0]!;
    const line = error.pos ? lines.linePos(error.pos[0]).line : 1;
    return { issue: { file, line, message: `Invalid YAML: ${cleanMessage(error.message)}` } };
  }
  const value: unknown = document.toJS();
  const issue = validateFlow(value, file);
  if (issue) {
    const role=/^roles\[(\d+)\](?:\.([a-zA-Z]+))?/u.exec(issue.message);
    const quoted=/unknown field "([^"]+)"/iu.exec(issue.message);
    const field=/^(id|name|description|finalStep|roles)\b/u.exec(issue.message)?.[1];
    const unknown=/^Unknown flow field "([^"]+)"/u.exec(issue.message)?.[1];
    const path=role ? ["roles",Number(role[1]),...(role[2] || quoted?.[1] ? [role[2] ?? quoted![1]] : [])] : [unknown ?? field ?? "id"];
    const node=document.getIn(path,true) as {range?:[number,number,number]}|undefined;
    if(node?.range)issue.line=lines.linePos(node.range[0]).line;
    return { issue };
  }
  const candidate = value as Record<string, unknown>;
  const roles = candidate.roles as OrchestrationTemplateRole[];
  const id = candidate.id as string;
  return {
    template: {
      id,
      name: candidate.name as string,
      description: candidate.description as string,
      roles,
      finalStep: candidate.finalStep as string,
      expectedSubagents: roles.reduce((sum, role) => sum + role.count, 0),
      builtIn: false,
      source: file
    }
  };
}

function validateFlow(value: unknown, file: string): OrchestrationTemplateIssue | null {
  const fail = (message: string, line = 1): OrchestrationTemplateIssue => ({ file, line, message });
  if (!isRecord(value)) return fail("Flow must be a YAML object.");
  const extra = Object.keys(value).find((key) => !ALLOWED_KEYS.has(key));
  if (extra) return fail(`Unknown flow field "${extra}"; flows cannot set launch permissions, profiles or folders.`);
  if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.id)) return fail("id must be a lowercase slug of at most 64 characters.");
  if (BUILT_IN_FLOWS.some((flow) => flow.id === value.id)) return fail("A project flow cannot replace a built-in flow.");
  if (!nonEmpty(value.name, 120)) return fail("name must contain 1 to 120 characters.");
  if (!nonEmpty(value.description, 500)) return fail("description must contain 1 to 500 characters.");
  if (!nonEmpty(value.finalStep, MAX_TEXT)) return fail("finalStep must contain 1 to 8000 characters.");
  if (!Array.isArray(value.roles) || value.roles.length < 1 || value.roles.length > MAX_ROLES) return fail(`roles must contain 1 to ${MAX_ROLES} entries.`);
  let total = 0;
  const ids = new Set<string>();
  for (let index = 0; index < value.roles.length; index += 1) {
    const role: unknown = value.roles[index];
    if (!isRecord(role)) return fail(`roles[${index}] must be an object.`);
    const roleExtra = Object.keys(role).find((key) => !ROLE_KEYS.has(key));
    if (roleExtra) return fail(`roles[${index}] has unknown field "${roleExtra}"; role permissions are fixed by CanvasTTY.`);
    if (typeof role.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,47}$/u.test(role.id) || ids.has(role.id)) return fail(`roles[${index}].id must be a unique lowercase slug.`);
    ids.add(role.id);
    if (!nonEmpty(role.title, 120)) return fail(`roles[${index}].title must contain 1 to 120 characters.`);
    if (!nonEmpty(role.instruction, MAX_TEXT)) return fail(`roles[${index}].instruction must contain 1 to ${MAX_TEXT} characters.`);
    if (!Number.isInteger(role.count) || (role.count as number) < 1 || (role.count as number) > 12) return fail(`roles[${index}].count must be an integer from 1 to 12.`);
    if (role.model !== undefined && !nonEmpty(role.model, 160)) return fail(`roles[${index}].model must contain 1 to 160 characters.`);
    if (role.effort !== undefined && !EFFORTS.has(role.effort as ReasoningEffort)) return fail(`roles[${index}].effort is not supported.`);
    total += role.count as number;
  }
  if (total > 32) return fail("A flow may expect at most 32 subagents.");
  return null;
}

function formatIssue(issue: OrchestrationTemplateIssue): string {
  return `${issue.file}:${issue.line}: ${issue.message}`;
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
function isMissing(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"); }
function message(error: unknown): string { return cleanMessage(error instanceof Error ? error.message : "document could not be parsed"); }
function cleanMessage(value: string): string { return value.replace(/[\r\n\t]+/gu, " ").slice(0, 240); }
