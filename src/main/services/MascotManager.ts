import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { nativeImage } from "electron";
import { isPathInside } from "../../agent-runtime/path-inside.mjs";
import type { MascotLaunch, MascotProjectSummary } from "../../shared/contracts";
import type { PluginManager } from "./PluginManager";

interface MascotRecord extends MascotProjectSummary { createdAt: number; installedBuildId?: string }
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const execFileAsync = promisify(execFile);

export class MascotManager {
  private readonly root: string;
  private readonly pipeline: string;
  private readonly plugins: PluginManager;
  private readonly changed: (projects: MascotProjectSummary[]) => void;
  private readonly installed: (pluginId: string, contributionId: string) => void;
  private readonly records = new Map<string, MascotRecord>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private readonly previews = new Set<ChildProcess>();
  private readonly rejectedResults = new Map<string, string>();
  private readonly pendingRetries = new Set<string>();

  constructor(userDataPath: string, pipelinePath: string, plugins: PluginManager,
    changed: (projects: MascotProjectSummary[]) => void,
    installed: (pluginId: string, contributionId: string) => void) {
    this.root = join(userDataPath, "mascots");
    this.pipeline = pipelinePath;
    this.plugins = plugins;
    this.changed = changed;
    this.installed = installed;
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isProjectId(entry.name)) continue;
      try {
        const record = JSON.parse(await readFile(join(this.root, entry.name, "mascot-project.json"), "utf8")) as MascotRecord;
        if (record.id === entry.name && isMascotRecord(record)) this.records.set(entry.name, record);
      } catch { /* An incomplete project remains on disk for manual recovery. */ }
    }
    this.timer = setInterval(() => { void this.checkResults(); }, 3_000);
    void this.checkResults();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const child of this.previews) child.kill();
    this.previews.clear();
  }

  list(): MascotProjectSummary[] {
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt)
      .map(({ createdAt: _createdAt, ...record }) => ({ ...record,
        registered: this.plugins.list().some((plugin) => plugin.manifest.id === record.pluginId && plugin.sourceUrl === `mascot:${record.id}`)
      }));
  }

  async start(value: Uint8Array): Promise<MascotLaunch> {
    await stat(join(this.pipeline, "SKILL.md"));
    const template = await readFile(join(this.pipeline, "templates", "launch-prompt.txt"), "utf8");
    if (!template) throw new Error("Mascot launch prompt is missing.");
    if (!(value instanceof Uint8Array) || value.byteLength < 32 || value.byteLength > MAX_IMAGE_BYTES) {
      throw new Error("Choose a PNG or JPEG up to 20 MB.");
    }
    const bytes = Buffer.from(value);
    const isPng = bytes.subarray(0, 8).equals(PNG_SIGNATURE);
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!isPng && !isJpeg) throw new Error("The character image must be a PNG or JPEG.");
    const image = nativeImage.createFromBuffer(bytes);
    const size = image.getSize();
    if (image.isEmpty() || size.width < 32 || size.height < 32 || size.width > 4096 || size.height > 4096) {
      throw new Error("The image dimensions must be between 32 and 4096 pixels.");
    }
    const bitmap = image.toBitmap();
    let visible = false;
    for (let index = 3; index < bitmap.length; index += 4) {
      if (bitmap[index] > 0) visible = true;
      if (visible) break;
    }
    if (!visible) throw new Error("The image must contain visible character pixels.");
    const python = await resolveMascotPython();

    const id = randomUUID();
    const cwd = join(this.root, id);
    await mkdir(this.root, { recursive: true });
    const uploadPath = join(this.root, `.upload-${id}.${isJpeg ? "jpg" : "png"}`);
    await writeFile(uploadPath, bytes, { flag: "wx" });
    try {
      await execFileAsync(python, [join(this.pipeline, "scripts", "prepare_input.py"), "--image", uploadPath, "--project", cwd],
        { timeout: 15_000, maxBuffer: 4096, windowsHide: true });
    } finally {
      await unlink(uploadPath);
    }
    const imagePath = join(cwd, "references", "character.png");
    const originalPath = join(cwd, "references", isJpeg ? "character.jpg" : "character.png");
    const previewUrl = await this.startPreview(python, cwd);
    const record: MascotRecord = { id, name: "New mascot", status: "creating", createdAt: Date.now() };
    await this.save(record);
    this.records.set(id, record);
    this.changed(this.list());

    const prompt = template
      .replaceAll("[PROJECT_DIR]", cwd)
      .replaceAll("[PIPELINE_DIR]", this.pipeline)
      .replaceAll("[PREVIEW_URL]", previewUrl)
      .trim() + `\n\nThe original upload is preserved at ${originalPath}. Intake has already prepared ${imagePath}; do not run prepare_input.py again. `
      + (isJpeg ? `The JPEG working copy has corrected EXIF orientation and PNG encoding; it still needs the skill's full-body image-generation preparation and background removal. ` : "")
      + `Python 3.10+ with Pillow and NumPy was verified at ${python}. Use this exact executable for every pipeline script, not a bare python command. `
      + `Absolute script paths: qa_frames.py = ${join(this.pipeline, "scripts", "qa_frames.py")}; `
      + `scaffold_plugin.py = ${join(this.pipeline, "scripts", "scaffold_plugin.py")}; `
      + `build_sprite.py = ${join(this.pipeline, "scripts", "build_sprite.py")}; `
      + `preview_animation.py = ${join(this.pipeline, "scripts", "preview_animation.py")}; `
      + `finalize_mascot.py = ${join(this.pipeline, "scripts", "finalize_mascot.py")}. `
      + `Pass ${join(cwd, "character.json")} as the config argument and quote paths when invoking them in the shell.`;
    return { project: this.list()[0]!, cwd, imagePath, prompt, previewUrl };
  }

  private startPreview(python: string, cwd: string): Promise<string> {
    return new Promise((resolveUrl, reject) => {
      const child = spawn(python, [join(this.pipeline, "scripts", "serve_preview.py"), cwd, "--port", "0"],
        { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      this.previews.add(child);
      let output = "";
      let settled = false;
      const fail = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(new Error("The mascot preview server could not start."));
      };
      const timer = setTimeout(fail, 10_000);
      child.once("error", fail);
      child.once("exit", () => { this.previews.delete(child); fail(); });
      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        output += chunk.toString("utf8");
        if (output.length > 4096) return fail();
        if (!output.includes("\n")) return;
        try {
          const value = JSON.parse(output.split("\n")[0]!) as { url?: string };
          if (!value.url || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(value.url)) return fail();
          settled = true;
          clearTimeout(timer);
          resolveUrl(value.url);
        } catch { fail(); }
      });
    });
  }

  async link(projectId: string, sessionId: string): Promise<void> {
    const record = this.require(projectId);
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("Codex session ID is invalid.");
    record.sessionId = sessionId;
    await this.save(record);
    this.changed(this.list());
  }

  async fail(projectId: string, message: string): Promise<void> {
    const record = this.require(projectId);
    if (record.status === "ready") return;
    await this.recordError(record, "creation", new Error(message));
  }

  async retry(projectId: string): Promise<void> {
    const record = this.require(projectId);
    if (this.checking) { this.pendingRetries.add(projectId); return; }
    this.rejectedResults.delete(projectId);
    if (record.status === "failed") record.status = "creating";
    await this.save(record);
    this.changed(this.list());
    // An active check owns the record; the next poll handles a retry queued during it.
    await this.checkResults();
  }

  async errorLog(projectId: string): Promise<string> {
    this.require(projectId);
    const project = await realpath(join(this.root, projectId));
    const path = await realpath(join(project, "installation-error.log"));
    if (!isPathInside(project, path)) throw new Error("Mascot log path escapes its project.");
    return path;
  }

  private async recordError(record: MascotRecord, stage: string, cause: unknown): Promise<void> {
    const error = cause as { message?: string; stack?: string; stderr?: string; stdout?: string };
    const detail = [error?.stack ?? error?.message ?? String(cause), error?.stdout, error?.stderr].filter(Boolean).join("\n");
    record.errorLogPath = join(this.root, record.id, "installation-error.log");
    await appendFile(record.errorLogPath, `\n${new Date().toISOString()} stage=${stage} requested=${record.requestedBuildId ?? "unknown"}\n${detail}\n`);
    const lines = (error?.stderr || error?.message || String(cause)).trim().split(/\r?\n/).filter(Boolean);
    record.error = (lines.at(-1) ?? "Mascot installation failed.").slice(0, 500);
    record.errorStage = stage;
    if (record.status !== "ready") record.status = "failed";
    await this.save(record);
    this.changed(this.list());
  }

  private require(id: string): MascotRecord {
    const record = this.records.get(id);
    if (!record) throw new Error("Mascot project does not exist.");
    return record;
  }

  private async save(record: MascotRecord): Promise<void> {
    const path = join(this.root, record.id, "mascot-project.json");
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2));
    await rename(temporary, path);
  }

  private async checkResults(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const record of this.records.values()) {
        const path = join(this.root, record.id, "mascot-result.json");
        let raw: string;
        try { raw = await readFile(path, "utf8"); } catch { continue; }
        if (this.rejectedResults.get(record.id) === raw) continue;
        let stage = "handoff";
        try {
          const result = JSON.parse(raw) as Record<string, unknown>;
          if (result.status === "reviewed") continue;
          if (result.installationApproved !== true || typeof result.buildId !== "string") continue;
          if (record.installedBuildId === result.buildId) {
            if (record.errorStage === "card load" && record.pluginId) {
              stage = "card load";
              const plugin = this.plugins.list().find((item) => item.manifest.id === record.pluginId && item.sourceUrl === `mascot:${record.id}`);
              if (!plugin) throw new Error("Installed mascot is not registered.");
              this.installed(plugin.manifest.id, plugin.manifest.contributions[0]!.id);
              delete record.error;
              delete record.errorStage;
              delete record.errorLogPath;
              await this.save(record);
              this.changed(this.list());
            }
            continue;
          }
          record.requestedBuildId = result.buildId;
          if (result.schemaVersion !== 1 || result.status !== "ready_for_host"
            || typeof result.name !== "string" || typeof result.id !== "string"
            || typeof result.pluginDirectory !== "string" || !Array.isArray(result.actions) || result.actions.length === 0
            || !result.actions.every((action) => typeof action === "string")
            || !result.presentation || typeof result.presentation !== "object"
            || (result.presentation as Record<string, unknown>).transparentCard !== true
            || (result.presentation as Record<string, unknown>).resizable !== true) {
            throw new Error("Mascot handoff is incomplete.");
          }
          const projectRoot = await realpath(join(this.root, record.id));
          stage = "package/review validation";
          const python = await resolveMascotPython();
          if (result.delivery !== undefined && result.delivery !== "draft" && result.delivery !== "final") throw new Error("Unknown mascot delivery mode.");
          await execFileAsync(python, [join(this.pipeline, "scripts", "finalize_mascot.py"), join(projectRoot, "character.json"), "--verify-only", "--install-approved", ...(result.delivery === "draft" ? ["--draft"] : [])], {
            timeout: 30_000,
            maxBuffer: 1_048_576,
            windowsHide: true
          });
          const verified = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
          const build = JSON.parse(await readFile(join(projectRoot, "build-report.json"), "utf8")) as { build_id?: string };
          if (JSON.stringify(verified) !== JSON.stringify(result) || verified.buildId !== build.build_id || verified.installationApproved !== true) {
            throw new Error("The approved mascot build changed before installation.");
          }
          if (verified.status !== "ready_for_host" || typeof verified.pluginDirectory !== "string"
            || typeof verified.id !== "string" || typeof verified.name !== "string") {
            throw new Error("Mascot finalization did not produce a valid handoff.");
          }
          if (!isAbsolute(verified.pluginDirectory)) throw new Error("Mascot plugin path must be absolute.");
          const pluginRoot = await realpath(resolve(verified.pluginDirectory));
          if (!isPathInside(projectRoot, pluginRoot)) throw new Error("Mascot plugin path escapes its project.");
          const config = JSON.parse(await readFile(join(projectRoot, "character.json"), "utf8")) as { id: string; name: string; plugin_dir: string };
          if (verified.id !== config.id || verified.name !== config.name || pluginRoot !== await realpath(resolve(projectRoot, config.plugin_dir))) throw new Error("Mascot handoff does not match the verified configuration.");
          const review = JSON.parse(await readFile(join(projectRoot, result.delivery === "draft" ? "draft-review.json" : "review.json"), "utf8")) as { limitations?: string[] };
          const limits = result.delivery === "draft" ? review.limitations : [];
          if (JSON.stringify(result.limitations ?? []) !== JSON.stringify(limits)) throw new Error("Mascot handoff limits differ from the accepted review.");
          stage = "registration";
          const installed = await this.plugins.installLocalMascot(record.id, pluginRoot, verified.id);
          record.status = "ready";
          record.name = verified.name.slice(0, 100);
          record.pluginId = installed.manifest.id;
          record.installedBuildId = String(verified.buildId);
          record.delivery = result.delivery === "draft" ? "draft" : "final";
          record.limitations = Array.isArray(result.limitations) ? result.limitations.filter((item): item is string => typeof item === "string") : [];
          delete record.error;
          delete record.errorStage;
          delete record.errorLogPath;
          this.rejectedResults.delete(record.id);
          await this.save(record);
          this.changed(this.list());
          stage = "card load";
          this.installed(installed.manifest.id, installed.manifest.contributions[0]!.id);
        } catch (cause) {
          if (stage === "handoff" && cause instanceof SyntaxError) continue;
          this.rejectedResults.set(record.id, raw);
          await this.recordError(record, stage, cause);
        }
      }
    } finally {
      this.checking = false;
      for (const id of this.pendingRetries) this.rejectedResults.delete(id);
      this.pendingRetries.clear();
    }
  }
}

function isProjectId(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value); }

async function resolveMascotPython(): Promise<string> {
  const bundled = join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python");
  const candidates: Array<[string, string[]]> = [];
  if (process.env.CANVASTTY_MASCOT_PYTHON) candidates.push([process.env.CANVASTTY_MASCOT_PYTHON, []]);
  if (process.platform === "win32") candidates.push([join(bundled, "python.exe"), []], ["python", []], ["py", ["-3"]]);
  else candidates.push(["python3", []], ["python", []], [join(bundled, "bin", "python3"), []]);
  for (const [command, args] of candidates) {
    try {
      const { stdout } = await execFileAsync(command, [...args, "-c",
        "import sys, PIL, numpy; sys.exit(1) if sys.version_info < (3, 10) else print(sys.executable)"],
      { timeout: 5_000, maxBuffer: 1024, windowsHide: true });
      const executable = stdout.trim();
      if (isAbsolute(executable)) return executable;
    } catch { /* Try the next installed Python. */ }
  }
  throw new Error("Mascot creation needs Python 3.10+ with Pillow and NumPy. Install those packages or set CANVASTTY_MASCOT_PYTHON to a working Python executable.");
}

function isMascotRecord(value: MascotRecord): boolean {
  return typeof value.name === "string" && typeof value.createdAt === "number"
    && (value.status === "creating" || value.status === "ready" || value.status === "failed");
}
