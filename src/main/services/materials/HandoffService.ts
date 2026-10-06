import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type {
  HandoffBlock,
  HandoffDelivery,
  HandoffDraft,
  HandoffItem,
  HandoffPreview,
  HandoffPreviewResult,
  HandoffResult,
  HandoffWarning,
  LocaleId,
  MaterialFailure,
  MaterialHandoff,
  MaterialRemark,
  ProviderId,
  RemarkTarget,
  SessionMetadata,
  Size,
  TerminalDataEvent
} from "../../../shared/contracts";
import { IPC } from "../../../shared/contracts.ts";
import { extensionForMime, materialType, HANDOFF_NOTE_LIMIT, handoffBlockFor } from "../../../shared/materials.ts";
import { terminalFileQuotePath } from "../../../shared/terminalFileDrop.ts";
import { codexComposerReady } from "../agent-control/AgentControlGateway.ts";
import {
  handoffPointerText,
  handoffText,
  HANDOFF_TEXT_LIMIT,
  type HandoffImageMode,
  type HandoffTextImage,
  type HandoffTextInput,
  type HandoffTextTarget,
  terminalSafe
} from "./handoffText.ts";
import { anchorRect, cropRect, type PixelRect } from "./imageRegions.ts";
import { HANDOFF_REMARK_LIMIT, isId, MAX_SESSION_ID } from "./materialState.ts";
import type { MaterialService, MaterialVersionFile } from "./MaterialService.ts";
import { imageMarkers, pasteMarkers, SessionScreen, withoutBraille, type ScreenPort } from "./sessionScreen.ts";

const HANDOFF_FOLDER_LIMIT = 50;
const HANDOFF_PACKAGE_LIMIT = 512 * 1024 * 1024;
const HANDOFF_FOLDERS_BYTES_LIMIT = 1024 * 1024 * 1024;
const IMAGE_ATTACHMENT_LIMIT = 9;
const VISIBLE_TAIL_CHARS = 48;
const TURN_START_WINDOW_MS = 10 * 60 * 1000;
const RESTARTED = "The session restarted or exited during delivery.";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

interface HandoffTerminalPort extends ScreenPort {
  listMetadata(): SessionMetadata[];
  launchPending(id: string): boolean;
  deliverInput(id: string, data: string, waitMs?: number): Promise<{ delivered: true } | { delivered: false; reason: string }>;
  pluginContext(id: string): { workingDirectory: string; environment: unknown | null } | null;
}

export interface HandoffImageOps {
  canDraw(mimeType: string, natural: Size): boolean;
  marked(source: string, rect: PixelRect, natural: Size): Promise<Uint8Array | null>;
  crop(source: string, rect: PixelRect, natural: Size): Promise<Uint8Array | null>;
}

interface HandoffTiming {
  attachMs: number;
  pasteMs: number;
  pollMs: number;
}

interface HandoffServiceOptions {
  materials: MaterialService;
  terminals: HandoffTerminalPort;
  images: HandoffImageOps;
  root: string;
  locale(): LocaleId;
  now?(): number;
  timing?: Partial<HandoffTiming>;
  packageLimit?: number;
  foldersBytesLimit?: number;
  onSent?(handoff: MaterialHandoff): void;
}

interface PlannedFile {
  name: string;
  source: string;
  byteSize: number;
  operation: "copy" | "marked" | "crop";
  rect?: PixelRect;
  natural?: Size;
}

interface HandoffPlan {
  id: string;
  number: number;
  folder: string;
  session: SessionMetadata;
  remarks: MaterialRemark[];
  items: HandoffItem[];
  files: PlannedFile[];
  text: HandoffTextInput;
  resultsFolder: string | null;
  warnings: HandoffWarning[];
  availableBytes: number;
}

interface HandoffFolder {
  path: string;
  time: number;
  bytes: number;
}

type Checked = { ok: true; plan: HandoffPlan } | { ok: false; reason: HandoffBlock | MaterialFailure };

type Reserved = { ok: true; plan: HandoffPlan; screen: SessionScreen | null } | { ok: false; reason: HandoffBlock | MaterialFailure };

const DEFAULT_TIMING: HandoffTiming = { attachMs: 8_000, pasteMs: 6_000, pollMs: 120 };

export class HandoffService {
  private readonly options: HandoffServiceOptions;
  private readonly timing: HandoffTiming;
  private readonly screens = new Map<string, SessionScreen>();
  private readonly sending = new Set<string>();
  private readonly resultsFolders = new Set<string>();
  private readonly submitting = new Map<string, { sessionId: string; turnStartedAt: number | null }>();
  private planning: Promise<unknown> = Promise.resolve();

  constructor(options: HandoffServiceOptions) {
    this.options = options;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    for (const session of options.terminals.listMetadata()) this.trackScreen(session);
  }

  grantResultsFolder(path: string): void {
    this.resultsFolders.add(path);
  }

  async preview(draft: unknown): Promise<HandoffPreviewResult> {
    const checked = await this.check(draft, false);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    const { plan } = checked;
    const text = this.compose(plan);
    const preview: HandoffPreview = {
      text,
      files: plan.files.map((file) => file.name),
      imageMode: plan.text.imageMode === "paths" ? "paths" : "attach",
      images: plan.text.images.length,
      warnings: plan.warnings
    };
    return { ok: true, preview };
  }

  async send(draft: unknown): Promise<HandoffResult> {
    const sessionId = isRecord(draft) && typeof draft.sessionId === "string" ? draft.sessionId : "";
    if (this.sending.has(sessionId)) return { ok: false, reason: "busy" };
    this.sending.add(sessionId);
    try {
      const reserved = await this.exclusive(() => this.prepare(draft, sessionId));
      if (!reserved.ok) return reserved;
      const { plan, screen } = reserved;
      let outcome: Partial<HandoffDelivery>;
      try {
        outcome = await this.deliver(plan, this.compose(plan), screen);
      } catch (error) {
        outcome = { state: "failed", error: error instanceof Error ? error.message : "Delivery failed." };
      }
      const early = this.submitting.get(plan.id)?.turnStartedAt ?? null;
      this.submitting.delete(plan.id);
      if (outcome.state === "submitted" && early !== null) outcome.turnStartedAt = early;
      this.options.materials.updateHandoffDelivery(plan.id, outcome);
      if (outcome.state === "submitted") this.options.materials.markRemarksSent(plan.remarks.map((remark) => remark.id), plan.id);
      const persisted = await this.options.materials.flush(true).then(() => true, () => false);
      if (!persisted) {
        outcome = { ...outcome, stateSaved: false };
        this.options.materials.updateHandoffDelivery(plan.id, outcome);
      }
      await this.prune().catch(() => undefined);
      const recorded = this.options.materials.handoff(plan.id);
      if (!recorded) return { ok: false, reason: "unavailable" };
      if (recorded.delivery.state === "submitted" || recorded.delivery.state === "pasted") this.options.onSent?.(recorded);
      return { ok: true, handoff: recorded };
    } finally {
      this.sending.delete(sessionId);
    }
  }

  observe(channel: string, payload: unknown): void {
    if (channel === IPC.terminalData) {
      const event = payload as TerminalDataEvent;
      this.screens.get(event.id)?.feed(event);
      return;
    }
    if (channel === IPC.terminalRemoved) {
      if (isRecord(payload) && typeof payload.id === "string") this.dropScreen(payload.id);
      return;
    }
    if (channel !== IPC.terminalSession || !isRecord(payload) || !isRecord(payload.session)) return;
    const session = payload.session as unknown as SessionMetadata;
    this.trackScreen(session);
    for (const pending of this.submitting.values()) {
      if (pending.sessionId === session.id && pending.turnStartedAt === null && session.status === "working") {
        pending.turnStartedAt = this.now();
      }
    }
    const latest = this.options.materials.latestHandoff(session.id);
    if (!latest || latest.delivery.state !== "submitted" || latest.delivery.sentAt === null) return;
    if (latest.sessionStartedAt !== null && session.startedAt !== latest.sessionStartedAt) return;
    const now = this.now();
    if (latest.delivery.turnStartedAt === null && session.status === "working" && now - latest.delivery.sentAt <= TURN_START_WINDOW_MS) {
      this.options.materials.updateHandoffDelivery(latest.id, { turnStartedAt: now });
    } else if (latest.delivery.turnStartedAt !== null && latest.delivery.turnEndedAt === null
      && (session.status === "idle" || session.status === "done" || session.status === "failed")) {
      this.options.materials.updateHandoffDelivery(latest.id, { turnEndedAt: now });
    }
  }

  dispose(): void {
    for (const screen of this.screens.values()) screen.dispose();
    this.screens.clear();
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.planning.catch(() => undefined).then(task);
    this.planning = run.catch(() => undefined);
    return run;
  }

  private async prepare(draft: unknown, sessionId: string): Promise<Reserved> {
    const reserved = await this.reserve(draft, sessionId);
    if (!reserved.ok) return reserved;
    const { plan } = reserved;
    const textBytes = Buffer.byteLength(`${handoffText(plan.text)}\n`, "utf8");
    const filesLimit = Math.min(this.packageLimit(), plan.availableBytes - textBytes);
    let unwritten: "too-long" | "quota" | "unreadable" | null = null;
    try {
      if (await this.writePackage(plan, filesLimit)) {
        await writeFile(join(plan.folder, "handoff.md"), `${handoffText(plan.text)}\n`, { encoding: "utf8", mode: 0o600 });
        await this.prunePackages();
      } else {
        unwritten = filesLimit < this.packageLimit() ? "quota" : "too-long";
      }
    } catch {
      unwritten = "unreadable";
    }
    if (unwritten) {
      await rm(plan.folder, { recursive: true, force: true }).catch(() => undefined);
      this.options.materials.updateHandoffDelivery(plan.id, {
        state: "failed",
        error: unwritten === "unreadable" ? "The handoff files could not be written." : "The handoff files would exceed the storage limit."
      });
      return { ok: false, reason: unwritten };
    }
    this.options.materials.updateHandoffDelivery(plan.id, { imagesExpected: plan.text.images.length });
    try {
      await this.options.materials.flush(true);
    } catch {
      this.options.materials.updateHandoffDelivery(plan.id, {
        state: "failed", error: "The handoff state could not be saved.", stateSaved: false
      });
      return { ok: false, reason: "unavailable" };
    }
    return reserved;
  }

  private async reserve(draft: unknown, sessionId: string): Promise<Reserved> {
    const checked = await this.check(draft, true);
    if (!checked.ok) return checked;
    const { plan } = checked;
    const screen = this.screenFor(sessionId);
    const blocked = await this.composerBlock(plan, screen);
    if (blocked) return { ok: false, reason: blocked };
    const protectedPaths = this.protectedFolders();
    this.options.materials.recordHandoff({
      id: plan.id,
      number: plan.number,
      createdAt: this.now(),
      sessionId: plan.session.id,
      sessionTitle: plan.session.title,
      provider: plan.session.provider,
      remarkIds: plan.remarks.map((remark) => remark.id),
      items: plan.items,
      note: plan.text.note,
      folder: plan.folder,
      resultsFolder: plan.resultsFolder,
      sessionStartedAt: plan.session.startedAt,
      delivery: {
        state: "sending",
        imagesExpected: plan.text.images.length,
        imagesAttached: 0,
        sentAt: null,
        turnStartedAt: null,
        turnEndedAt: null,
        note: null,
        error: null,
        stateSaved: true
      }
    }, this.options.materials.snapshot().handoffs.filter((handoff) => protectedPaths.has(handoff.folder)).map((handoff) => handoff.id));
    return { ok: true, plan, screen };
  }

  private async composerBlock(plan: HandoffPlan, screen: SessionScreen | null): Promise<HandoffBlock | null> {
    if (!screen) return null;
    if (!composerReady(plan.session.provider, await screen.text())) return "composer-not-ready";
    if (plan.session.provider === "claude" && await screen.typedAfter("❯")) return "composer-not-ready";
    return null;
  }

  private deliveryError(plan: HandoffPlan, screen: SessionScreen | null): string | null {
    const session = this.options.terminals.listMetadata().find((candidate) => candidate.id === plan.session.id);
    if (!session || session.exitCode !== null || session.startedAt !== plan.session.startedAt
      || (screen !== null && this.screens.get(session.id) !== screen)) return RESTARTED;
    const blocked = handoffBlockFor(session, this.options.terminals.launchPending(session.id));
    return blocked || this.options.terminals.pluginContext(session.id)?.environment
      ? "The agent's session is no longer ready for delivery."
      : null;
  }

  private async check(draft: unknown, strict: boolean): Promise<Checked> {
    if (isRecord(draft) && Array.isArray(draft.remarkIds) && draft.remarkIds.length > HANDOFF_REMARK_LIMIT) {
      return { ok: false, reason: "too-many-remarks" };
    }
    const parsed = parseDraft(draft);
    if (!parsed) return { ok: false, reason: isRecord(draft) && Array.isArray(draft.remarkIds) && draft.remarkIds.length === 0 ? "no-remarks" : "unavailable" };
    if (this.options.materials.handoff(parsed.id)) return { ok: false, reason: "already-sent" };
    if (parsed.resultsFolder !== null && !this.resultsFolders.has(parsed.resultsFolder)) return { ok: false, reason: "unavailable" };
    const session = this.options.terminals.listMetadata().find((candidate) => candidate.id === parsed.sessionId);
    if (!session) return { ok: false, reason: "no-session" };
    const block = handoffBlockFor(session, this.options.terminals.launchPending(session.id));
    if (block) return { ok: false, reason: block };
    const context = this.options.terminals.pluginContext(session.id);
    if (context?.environment) return { ok: false, reason: "remote-environment" };
    const remarks = parsed.remarkIds
      .map((id) => this.options.materials.remark(id))
      .filter((remark): remark is MaterialRemark => remark !== null)
      .sort((left, right) => left.number - right.number);
    if (remarks.length === 0) return { ok: false, reason: "no-remarks" };
    if (remarks.some((remark) => remark.status !== "open" && remark.status !== "reopened")) return { ok: false, reason: "unavailable" };
    const editable: string[] = [];
    for (const id of parsed.editableMaterialIds) {
      const location = this.options.materials.material(id)?.location;
      if (location) editable.push(location);
    }
    const id = parsed.id;
    const folder = join(this.options.root, id);
    const number = this.options.materials.nextHandoffNumber();
    const files: PlannedFile[] = [];
    const images: HandoffTextImage[] = [];
    const copies = new Map<string, string>();
    const items = new Map<string, HandoffItem>();
    const textRemarks = [];
    for (const remark of remarks) {
      const target = await this.planTarget(remark.target, `${remark.number}`, folder, files, images, copies);
      if (!target) return { ok: false, reason: "unavailable" };
      const reference = remark.reference
        ? await this.planTarget(remark.reference, `${remark.number}-ref`, folder, files, images, copies, true)
        : null;
      if (remark.reference && !reference) return { ok: false, reason: "unavailable" };
      for (const anchorTarget of [remark.target, remark.reference]) {
        if (!anchorTarget) continue;
        const key = `${anchorTarget.materialId}:${anchorTarget.versionId}`;
        if (!items.has(key)) {
          items.set(key, { materialId: anchorTarget.materialId, versionId: anchorTarget.versionId, editable: false });
        }
      }
      textRemarks.push({ number: remark.number, text: remark.text, target, reference });
    }
    for (const materialId of parsed.editableMaterialIds) {
      const material = this.options.materials.material(materialId);
      if (!material?.location) continue;
      for (const item of items.values()) if (item.materialId === materialId) item.editable = true;
      if (![...items.values()].some((item) => item.materialId === materialId)) {
        items.set(`${materialId}:live`, { materialId, versionId: null, editable: true });
      }
    }
    if (packageBytes(files) > this.packageLimit()) return { ok: false, reason: "too-long" };
    const warnings: HandoffWarning[] = [];
    if (session.status === "unavailable") warnings.push("status-unknown");
    const workingDirectory = context?.workingDirectory ?? session.cwd;
    const realWorkingDirectory = await realpath(workingDirectory).catch(() => workingDirectory);
    if (parsed.resultsFolder && !isInside(realWorkingDirectory, parsed.resultsFolder)) warnings.push("results-outside-workdir");
    const imageMode = imageModeFor(session.provider);
    const text: HandoffTextInput = {
      locale: this.options.locale(),
      number,
      folder,
      remarks: textRemarks,
      editable,
      note: parsed.note,
      resultsFolder: parsed.resultsFolder,
      reportFile: parsed.resultsFolder ? join(parsed.resultsFolder, `canvastty-report-${number}.json`) : null,
      imageMode,
      images: images.slice(0, IMAGE_ATTACHMENT_LIMIT)
    };
    if (strict && handoffPointerText(text, join(folder, "handoff.md")).length > HANDOFF_TEXT_LIMIT) {
      return { ok: false, reason: "too-long" };
    }
    const available = await this.remainingCapacity().catch(() => null);
    if (!available) return { ok: false, reason: "unreadable" };
    if (available.folders >= HANDOFF_FOLDER_LIMIT || packageBytes(files) + Buffer.byteLength(`${handoffText(text)}\n`, "utf8") > available.bytes) {
      return { ok: false, reason: "quota" };
    }
    return {
      ok: true,
      plan: {
        id,
        number,
        folder,
        session,
        remarks,
        items: [...items.values()],
        files,
        text,
        resultsFolder: parsed.resultsFolder,
        warnings,
        availableBytes: available.bytes
      }
    };
  }

  private async planTarget(
    target: RemarkTarget,
    prefix: string,
    folder: string,
    files: PlannedFile[],
    images: HandoffTextImage[],
    copies: Map<string, string>,
    reference = false
  ): Promise<HandoffTextTarget | null> {
    const version = this.options.materials.versionFile(target.materialId, target.versionId);
    if (!version) return null;
    const stem = `${prefix}-${slug(version.name)}-v${version.number}`;
    const file = copies.get(version.versionId) ?? `${stem}${extensionFor(version)}`;
    if (!copies.has(version.versionId)) {
      copies.set(version.versionId, file);
      files.push({ name: file, source: version.path, byteSize: version.byteSize, operation: "copy" });
    }
    let marked: string | null = null;
    let crop: string | null = null;
    const drawable = version.kind === "image" && version.natural !== null && target.anchor.kind !== "whole"
      && this.options.images.canDraw(version.mimeType, version.natural);
    if (drawable && !reference) {
      marked = `${stem}-marked.png`;
      files.push({ name: marked, source: version.path, byteSize: version.byteSize, operation: "marked", rect: anchorRect(target.anchor, version.natural!), natural: version.natural! });
    }
    if (drawable) {
      crop = `${stem}-crop.png`;
      files.push({ name: crop, source: version.path, byteSize: version.byteSize, operation: "crop", rect: cropRect(target.anchor, version.natural!), natural: version.natural! });
    }
    if (version.kind === "image") {
      for (const name of reference ? [crop ?? file] : [marked ?? file, ...(crop ? [crop] : [])]) {
        images.push({ name, path: join(folder, name) });
      }
    }
    return {
      name: version.name,
      versionNumber: version.number,
      anchor: target.anchor,
      natural: version.natural,
      file,
      marked,
      crop,
      location: version.location
    };
  }

  private compose(plan: HandoffPlan): string {
    const text = handoffText(plan.text);
    return text.length <= HANDOFF_TEXT_LIMIT ? text : handoffPointerText(plan.text, join(plan.folder, "handoff.md"));
  }

  private async writePackage(plan: HandoffPlan, limit: number): Promise<boolean> {
    await mkdir(plan.folder, { recursive: true, mode: 0o700 });
    const produced = new Set<string>();
    let total = 0;
    for (const file of plan.files) {
      const target = join(plan.folder, file.name);
      if (file.operation === "copy") {
        await copyFile(file.source, target, constants.COPYFILE_FICLONE);
        total += (await lstat(target)).size;
        if (total > limit) return false;
        produced.add(file.name);
        continue;
      }
      const bytes = file.operation === "marked"
        ? await this.options.images.marked(file.source, file.rect!, file.natural!)
        : await this.options.images.crop(file.source, file.rect!, file.natural!);
      if (!bytes) continue;
      total += bytes.byteLength;
      if (total > limit) return false;
      await writeFile(target, bytes, { mode: 0o600 });
      produced.add(file.name);
    }
    plan.text.images = plan.text.images.filter((image) => produced.has(image.name));
    for (const remark of plan.text.remarks) {
      for (const target of [remark.target, remark.reference]) {
        if (!target) continue;
        if (target.marked && !produced.has(target.marked)) target.marked = null;
        if (target.crop && !produced.has(target.crop)) target.crop = null;
      }
    }
    return true;
  }

  private async deliver(plan: HandoffPlan, text: string, screen: SessionScreen | null): Promise<Partial<HandoffDelivery>> {
    const id = plan.session.id;
    const images = plan.text.images;
    const failed = (reason: string): Partial<HandoffDelivery> => ({ state: "failed", error: reason });
    const paste = async (data: string): Promise<string | null> => {
      const error = this.deliveryError(plan, screen);
      if (error) return error;
      const written = await this.options.terminals.deliverInput(id, `${PASTE_START}${data}${PASTE_END}`, 0);
      return written.delivered ? null : written.reason;
    };
    if (!screen) {
      const error = await paste(text);
      return error ? failed(error) : { state: "pasted", note: "not-observed", sentAt: this.now(), imagesAttached: 0 };
    }
    if (await this.composerBlock(plan, screen)) return failed("The agent's prompt changed before delivery.");
    const baseline = await screen.text();
    const beforeImages = imageMarkers(baseline);
    const header = text.split("\n")[0];
    let beforeText = baseline;
    let attached = 0;
    if (plan.text.imageMode === "codex") {
      for (const image of images) {
        const error = await paste(terminalFileQuotePath(terminalSafe(image.path), process.platform));
        if (error) return failed(error);
        const expected = beforeImages + attached + 1;
        if (await this.waitFor(screen, (current) => imageMarkers(current) >= expected, this.timing.attachMs)) attached += 1;
      }
      beforeText = await screen.text();
      const error = await paste(text);
      if (error) return failed(error);
    } else {
      const error = await paste(text);
      if (error) return failed(error);
      await this.waitFor(screen, (current) => imageMarkers(current) >= beforeImages + images.length, this.timing.attachMs);
      attached = Math.max(0, Math.min(images.length, imageMarkers(await screen.text()) - beforeImages));
    }
    const tail = compact(text).slice(-VISIBLE_TAIL_CHARS);
    const tailsBefore = occurrences(compact(withoutBraille(beforeText)), tail);
    const pastesBefore = pasteMarkers(beforeText);
    const imagesBefore = imageMarkers(beforeText);
    const visible = await this.waitFor(screen, (current) => (
      current.includes(header)
      || occurrences(compact(withoutBraille(current)), tail) > tailsBefore
      || pasteMarkers(current) > pastesBefore
      || imageMarkers(current) > imagesBefore
    ), this.timing.pasteMs);
    if (!visible) return { state: "pasted", note: "not-seen", sentAt: this.now(), imagesAttached: attached };
    const error = this.deliveryError(plan, screen);
    if (error) return error === RESTARTED
      ? failed(error)
      : { state: "pasted", note: "enter-failed", sentAt: this.now(), imagesAttached: attached, error };
    this.submitting.set(plan.id, { sessionId: id, turnStartedAt: null });
    const submitted = await this.options.terminals.deliverInput(id, "\r", 0);
    return submitted.delivered
      ? { state: "submitted", sentAt: this.now(), imagesAttached: attached }
      : { state: "pasted", note: "enter-failed", sentAt: this.now(), imagesAttached: attached, error: submitted.reason };
  }

  private async waitFor(screen: SessionScreen, predicate: (text: string) => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      if (predicate(await screen.text())) return true;
      if (this.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, this.timing.pollMs));
    }
  }

  private screenFor(id: string): SessionScreen | null {
    const session = this.options.terminals.listMetadata().find((candidate) => candidate.id === id);
    if (session) this.trackScreen(session);
    return this.screens.get(id) ?? null;
  }

  private trackScreen(session: SessionMetadata): void {
    const mirrored = (session.provider === "claude" || session.provider === "codex") && session.exitCode === null;
    if (mirrored && !this.screens.has(session.id)) this.screens.set(session.id, new SessionScreen(this.options.terminals, session.id));
    if (!mirrored) this.dropScreen(session.id);
  }

  private dropScreen(id: string): void {
    this.screens.get(id)?.dispose();
    this.screens.delete(id);
  }

  prune(): Promise<void> {
    return this.exclusive(() => this.prunePackages());
  }

  private protectedFolders(): Set<string> {
    const protectedPaths = new Set<string>();
    const sessions = new Map(this.options.terminals.listMetadata().map((session) => [session.id, session]));
    const delivered = new Set<string>();
    for (const handoff of this.options.materials.snapshot().handoffs.slice().reverse()) {
      if (handoff.delivery.state === "sending") protectedPaths.add(handoff.folder);
      if (handoff.delivery.state !== "pasted" && handoff.delivery.state !== "submitted") continue;
      if (delivered.has(handoff.sessionId)) continue;
      const session = sessions.get(handoff.sessionId);
      if (!session || session.exitCode !== null || session.status === "done" || session.status === "failed"
        || (handoff.sessionStartedAt !== null && handoff.sessionStartedAt !== session.startedAt)) continue;
      delivered.add(handoff.sessionId);
      if (handoff.delivery.state === "pasted" || handoff.delivery.turnEndedAt === null) protectedPaths.add(handoff.folder);
    }
    return protectedPaths;
  }

  private async remainingCapacity(): Promise<{ folders: number; bytes: number }> {
    const protectedPaths = this.protectedFolders();
    const folders = (await this.packageFolders()).filter((folder) => protectedPaths.has(folder.path));
    return {
      folders: folders.length,
      bytes: Math.max(0, this.foldersBytesLimit() - folders.reduce((sum, folder) => sum + folder.bytes, 0))
    };
  }

  private async packageFolders(): Promise<HandoffFolder[]> {
    const entries = await readdir(this.options.root).catch((error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    const folders = await Promise.all(entries.map(async (entry) => {
      const path = join(this.options.root, entry);
      const info = await lstat(path).catch(() => null);
      if (!info?.isDirectory()) return null;
      return { path, time: info.mtimeMs, bytes: await folderBytes(path).catch(() => this.foldersBytesLimit()) };
    }));
    return folders.filter((folder): folder is HandoffFolder => folder !== null).sort((left, right) => right.time - left.time);
  }

  private async prunePackages(): Promise<void> {
    if (this.options.materials.snapshot().loadError) return;
    const protectedPaths = this.protectedFolders();
    const folders = await this.packageFolders();
    const protectedPackages = folders.filter((folder) => protectedPaths.has(folder.path));
    let kept = protectedPackages.length;
    let bytes = protectedPackages.reduce((sum, folder) => sum + folder.bytes, 0);
    let exhausted = false;
    const stale = folders.filter((folder) => {
      if (protectedPaths.has(folder.path)) return false;
      if (exhausted || kept >= HANDOFF_FOLDER_LIMIT || (kept > 0 && bytes + folder.bytes > this.foldersBytesLimit())) {
        exhausted = true;
        return true;
      }
      kept += 1;
      bytes += folder.bytes;
      return false;
    });
    await Promise.all(stale.map((folder) => rm(folder.path, { recursive: true, force: true })));
  }

  private foldersBytesLimit(): number {
    return this.options.foldersBytesLimit ?? HANDOFF_FOLDERS_BYTES_LIMIT;
  }

  private packageLimit(): number {
    return this.options.packageLimit ?? HANDOFF_PACKAGE_LIMIT;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function packageBytes(files: readonly PlannedFile[]): number {
  return files.reduce((total, file) => total + file.byteSize, 0);
}

async function folderBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path)) {
    const info = await lstat(join(path, entry)).catch(() => null);
    if (info?.isFile()) total += info.size;
  }
  return total;
}

function compact(value: string): string {
  return value.replace(/\s+/g, "");
}

function occurrences(text: string, part: string): number {
  if (!part) return 0;
  let count = 0;
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + part.length)) count += 1;
  return count;
}

function composerReady(provider: SessionMetadata["provider"], screen: string): boolean {
  if (provider === "codex") return codexComposerReady(withoutBraille(screen));
  if (provider !== "claude") return true;
  const prompt = screen.split("\n").filter((line) => /^\s*❯/.test(line)).at(-1);
  return prompt !== undefined && !/\[(?:Pasted text|Image) #\d+/.test(prompt);
}

function parseDraft(value: unknown): HandoffDraft | null {
  if (!isRecord(value) || !isId(value.id)) return null;
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0 || value.sessionId.length > MAX_SESSION_ID) return null;
  if (!Array.isArray(value.remarkIds) || value.remarkIds.length === 0 || value.remarkIds.length > HANDOFF_REMARK_LIMIT) return null;
  if (!value.remarkIds.every((id) => typeof id === "string")) return null;
  const editable = Array.isArray(value.editableMaterialIds) ? value.editableMaterialIds.filter((id): id is string => typeof id === "string") : [];
  if (typeof value.note !== "string" || value.note.length > HANDOFF_NOTE_LIMIT) return null;
  const resultsFolder = value.resultsFolder === null || value.resultsFolder === undefined
    ? null
    : typeof value.resultsFolder === "string" && isAbsolute(value.resultsFolder) && !value.resultsFolder.includes("\0")
      ? value.resultsFolder
      : undefined;
  if (resultsFolder === undefined) return null;
  return {
    id: value.id,
    sessionId: value.sessionId,
    remarkIds: [...new Set(value.remarkIds as string[])],
    editableMaterialIds: [...new Set(editable)].slice(0, HANDOFF_REMARK_LIMIT),
    note: value.note,
    resultsFolder
  };
}

function imageModeFor(provider: ProviderId): HandoffImageMode {
  if (provider === "claude") return "claude";
  if (provider === "codex") return "codex";
  return "paths";
}

function extensionFor(version: MaterialVersionFile): string {
  if (materialType(version.name).mimeType === version.mimeType) {
    const dot = version.name.lastIndexOf(".");
    if (dot > 0) return version.name.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, "");
  }
  return extensionForMime(version.mimeType);
}

function slug(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const cleaned = stem.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (cleaned || "material").slice(0, 48);
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
