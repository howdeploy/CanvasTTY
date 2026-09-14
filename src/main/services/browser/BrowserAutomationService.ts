import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import type {
  AgentPresenceSnapshot,
  BrowserDialogSnapshot,
  BrowserElementBounds,
  BrowserElementRef,
  BrowserObservation,
  BrowserObservedElement
} from "../../../shared/contracts.ts";
import { BrowserKernelError, throwIfAborted } from "./BrowserErrors.ts";

const MAX_OBSERVE_ELEMENTS = 200;
const MAX_READ_CHARACTERS = 100_000;
const MAX_READ_ITEMS = 500;
export const BROWSER_SCREENSHOT_MAX_BINARY_BYTES = 340 * 1024;
const CDP_VERSION = "1.3";
const PRESENCE_WORLD = "canvastty-agent-presence";
const INTERACTIVE_ROLES = new Set([
  "button", "checkbox", "combobox", "link", "listbox",
  "menuitem", "option", "radio", "searchbox", "slider", "spinbutton", "switch", "tab",
  "textbox", "treeitem"
]);
const READABLE_ROLES = new Set([
  "StaticText", "paragraph", "heading", "link", "button", "listitem", "cell", "rowheader",
  "columnheader", "textbox", "searchbox", "alert", "status"
]);
const ALLOWED_KEYS = new Set([
  "Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft",
  "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space"
]);

interface CdpAxValue {
  value?: unknown;
}

interface CdpAxProperty {
  name?: string;
  value?: CdpAxValue;
}

interface CdpAxNode {
  nodeId?: string;
  backendDOMNodeId?: number;
  frameId?: string;
  ignored?: boolean;
  role?: CdpAxValue;
  name?: CdpAxValue;
  description?: CdpAxValue;
  value?: CdpAxValue;
  properties?: CdpAxProperty[];
}

interface CdpFrameTree {
  frame?: { id?: string };
  childFrames?: CdpFrameTree[];
}

interface CdpDomNode {
  backendNodeId?: number;
  nodeName?: string;
  attributes?: string[];
  frameId?: string;
  children?: CdpDomNode[];
  contentDocument?: CdpDomNode;
  shadowRoots?: CdpDomNode[];
  templateContent?: CdpDomNode;
}

interface RefEntry {
  value: BrowserElementRef;
  bounds: BrowserElementBounds | null;
}

interface TabSession {
  contents: WebContents;
  revision: number;
  refs: Map<string, RefEntry>;
  attachPromise: Promise<void> | null;
  messageListener: (_event: unknown, method: string, params: unknown) => void;
  detachListener: (_event: unknown, reason: string) => void;
  onDialog?: (dialog: BrowserDialogSnapshot | null) => void;
  presences: AgentPresenceSnapshot[];
  presenceContextId: number | null;
  sensitiveNodes: Map<number, boolean>;
  electronDialog: ElectronDialogRequest | null;
  electronDialogListener: (info: ElectronDialogInfo, callback: ElectronDialogCallback) => void;
  electronCancelDialogsListener: () => void;
  dialogOpenedWaiters: Set<() => void>;
  dialogBlockedCommands: Set<Promise<void>>;
  inflightRequests: Set<string>;
  networkLastChangeAt: number;
}

interface ElectronDialogInfo {
  dialogType?: string;
  messageText?: string;
  defaultPromptText?: string;
}

type ElectronDialogCallback = (accept: boolean, promptText: string) => void;

interface ElectronDialogRequest {
  callback: ElectronDialogCallback;
}

const ELECTRON_RUN_DIALOG_EVENT = "-run-dialog";
const ELECTRON_CANCEL_DIALOGS_EVENT = "-cancel-dialogs";

export interface BrowserScreenshot {
  untrustedWebContent: true;
  mimeType: "image/png" | "image/jpeg";
  base64: string;
  width: number;
  height: number;
}

export interface BrowserReadPage {
  untrustedWebContent: true;
  tabId: string;
  url: string;
  title: string;
  documentRevision: number;
  text: string;
  links: Array<{ text: string; url: string }>;
  truncated: boolean;
  nextCursor: string | null;
}

export interface BrowserPointerResult {
  x: number;
  y: number;
}

export class BrowserAutomationService {
  private readonly sessions = new Map<string, TabSession>();

  async register(
    tabId: string,
    contents: WebContents,
    revision: number,
    onDialog?: (dialog: BrowserDialogSnapshot | null) => void
  ): Promise<void> {
    const current = this.sessions.get(tabId);
    if (current?.contents === contents) {
      current.revision = revision;
      current.onDialog = onDialog;
      await this.attach(current);
      return;
    }
    if (current) this.unregister(tabId);

    const session: TabSession = {
      contents,
      revision,
      refs: new Map(),
      attachPromise: null,
      messageListener: (_event, method, params) => this.onMessage(tabId, method, params),
      detachListener: () => {
        const live = this.sessions.get(tabId);
        if (live) {
          live.attachPromise = null;
          live.presenceContextId = null;
          live.refs.clear();
          live.inflightRequests.clear();
          live.networkLastChangeAt = Date.now();
        }
      },
      onDialog,
      presences: [],
      presenceContextId: null,
      sensitiveNodes: new Map(),
      electronDialog: null,
      electronDialogListener: (info, callback) => this.onElectronDialog(tabId, info, callback),
      electronCancelDialogsListener: () => this.cancelElectronDialog(tabId),
      dialogOpenedWaiters: new Set(),
      dialogBlockedCommands: new Set(),
      inflightRequests: new Set(),
      networkLastChangeAt: Date.now()
    };
    this.sessions.set(tabId, session);
    // Electron consumes JavaScript dialogs in its private WebContents handler before
    // CDP can emit Page.javascriptDialogOpening. Replace that handler for this
    // dedicated remote WebContents so alert/confirm/prompt remain pending until the
    // trusted browser chrome or an authenticated agent answers them.
    const dialogEvents = contents as unknown as EventEmitter;
    dialogEvents.removeAllListeners(ELECTRON_RUN_DIALOG_EVENT);
    dialogEvents.on(ELECTRON_RUN_DIALOG_EVENT, session.electronDialogListener);
    dialogEvents.prependListener(ELECTRON_CANCEL_DIALOGS_EVENT, session.electronCancelDialogsListener);
    contents.debugger.on("message", session.messageListener);
    contents.debugger.on("detach", session.detachListener);
    await this.attach(session);
  }

  unregister(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    this.sessions.delete(tabId);
    this.cancelElectronDialog(tabId, session);
    const dialogEvents = session.contents as unknown as EventEmitter;
    dialogEvents.removeListener(ELECTRON_RUN_DIALOG_EVENT, session.electronDialogListener);
    dialogEvents.removeListener(ELECTRON_CANCEL_DIALOGS_EVENT, session.electronCancelDialogsListener);
    session.contents.debugger.removeListener("message", session.messageListener);
    session.contents.debugger.removeListener("detach", session.detachListener);
    if (!session.contents.isDestroyed() && session.contents.debugger.isAttached()) {
      try {
        session.contents.debugger.detach();
      } catch {
        // Closing a tab can race with Chromium detaching the debugger.
      }
    }
  }

  updateRevision(tabId: string, revision: number): void {
    const session = this.requireSession(tabId);
    if (session.revision === revision) return;
    session.revision = revision;
    session.refs.clear();
    session.presenceContextId = null;
    session.sensitiveNodes.clear();
  }

  async observe(
    tabId: string,
    revision: number,
    options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}
  ): Promise<BrowserObservation> {
    const session = await this.ready(tabId, revision);
    throwIfAborted(options.signal);
    const nodes = (await this.fullAxTree(session, options.signal)).filter((node) => {
      const role = axString(node.role);
      return !node.ignored && node.backendDOMNodeId && INTERACTIVE_ROLES.has(role);
    }).slice(0, 1_000);
    const metrics = await this.command<{ cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }>(
      session,
      "Page.getLayoutMetrics"
    );
    const viewportWidth = metrics.cssLayoutViewport?.clientWidth ?? Number.MAX_SAFE_INTEGER;
    const viewportHeight = metrics.cssLayoutViewport?.clientHeight ?? Number.MAX_SAFE_INTEGER;
    if (viewportWidth <= 0 || viewportHeight <= 0) throw viewportUnavailable();
    const visible: Array<{ node: CdpAxNode; bounds: BrowserElementBounds }> = [];
    for (const node of nodes) {
      throwIfAborted(options.signal);
      const bounds = await this.box(session, node.backendDOMNodeId!);
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue;
      if (bounds.x + bounds.width <= 0 || bounds.y + bounds.height <= 0
        || bounds.x >= viewportWidth || bounds.y >= viewportHeight) continue;
      visible.push({ node, bounds });
    }
    const offset = decodeCursor(options.cursor, revision);
    const limit = clampInteger(options.limit, 1, MAX_OBSERVE_ELEMENTS, 80);
    const page = visible.slice(offset, offset + limit);
    const elements: BrowserObservedElement[] = [];
    for (const item of page) {
      throwIfAborted(options.signal);
      const { node, bounds } = item;
      const backendNodeId = node.backendDOMNodeId!;
      const frameId = node.frameId || "main";
      const refValue: BrowserElementRef = {
        ref: stableElementRefId(tabId, revision, frameId, backendNodeId),
        tabId,
        frameId,
        documentRevision: revision,
        backendNodeId
      };
      session.refs.set(refValue.ref, { value: refValue, bounds });
      const protectedValue = axBooleanProperty(node, "protected")
        || await this.isSensitiveNode(session, backendNodeId);
      elements.push({
        ref: refValue,
        role: axString(node.role) || "unknown",
        name: axString(node.name).slice(0, 500),
        description: optionalAxString(node.description),
        value: protectedValue ? null : optionalAxString(node.value),
        bounds,
        disabled: axBooleanProperty(node, "disabled"),
        focused: axBooleanProperty(node, "focused"),
        editable: axBooleanProperty(node, "editable")
          || ["textbox", "searchbox", "combobox"].includes(axString(node.role))
      });
    }
    trimRefs(session.refs);
    const nextOffset = offset + page.length;
    return {
      untrustedWebContent: true,
      tabId,
      url: session.contents.getURL(),
      title: session.contents.getTitle(),
      documentRevision: revision,
      elements,
      nextCursor: nextOffset < visible.length ? encodeCursor(revision, nextOffset) : null
    };
  }

  async readPage(
    tabId: string,
    revision: number,
    options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}
  ): Promise<BrowserReadPage> {
    const session = await this.ready(tabId, revision);
    throwIfAborted(options.signal);
    const readable = (await this.fullAxTree(session, options.signal)).filter((node) => (
      !node.ignored && READABLE_ROLES.has(axString(node.role))
    ));
    const offset = decodeCursor(options.cursor, revision);
    const limit = clampInteger(options.limit, 1, MAX_READ_ITEMS, 200);
    const page = readable.slice(offset, offset + limit);
    const parts: string[] = [];
    const links: Array<{ text: string; url: string }> = [];
    const seenLinks = new Set<string>();
    let length = 0;
    let truncated = false;
    let consumed = 0;
    for (const node of page) {
      throwIfAborted(options.signal);
      const protectedValue = axBooleanProperty(node, "protected")
        || Boolean(node.backendDOMNodeId && await this.isSensitiveNode(session, node.backendDOMNodeId));
      const name = axString(node.name).trim();
      const value = protectedValue ? "" : axString(node.value).trim();
      const text = [name, value && value !== name ? value : ""].filter(Boolean).join(": ");
      const link = axPropertyString(node, "url");
      if (link) {
        const url = cleanLinkUrl(link);
        if (url && !seenLinks.has(url) && links.length < 200) {
          links.push({ text: name.slice(0, 500), url });
          seenLinks.add(url);
        }
      }
      if (!text || parts.at(-1) === text) {
        consumed += 1;
        continue;
      }
      if (length + text.length + 1 > MAX_READ_CHARACTERS) {
        truncated = true;
        break;
      }
      consumed += 1;
      parts.push(text);
      length += text.length + 1;
    }
    return {
      untrustedWebContent: true,
      tabId,
      url: session.contents.getURL(),
      title: session.contents.getTitle(),
      documentRevision: revision,
      text: parts.join("\n"),
      links,
      truncated,
      nextCursor: offset + consumed < readable.length
        ? encodeCursor(revision, offset + consumed)
        : null
    };
  }

  async screenshot(tabId: string, revision: number, signal?: AbortSignal): Promise<BrowserScreenshot> {
    const session = await this.ready(tabId, revision);
    throwIfAborted(signal);
    const sensitiveBefore = await this.sensitiveBoundsForScreenshot(session);
    const masks = await this.maskSensitiveInputs(session);
    try {
      let image = await session.contents.capturePage();
      throwIfAborted(signal);
      const capturedSize = image.getSize();
      if (image.isEmpty() || capturedSize.width <= 0 || capturedSize.height <= 0) throw viewportUnavailable();
      const sensitiveAfter = await this.sensitiveBoundsForScreenshot(session);
      const sensitiveBounds = mergeSensitiveBounds(sensitiveBefore, sensitiveAfter);
      image = await this.redactSensitivePixels(session, image, sensitiveBounds);
      let bytes = image.toPNG();
      let mimeType: BrowserScreenshot["mimeType"] = "image/png";
      if (bytes.byteLength > BROWSER_SCREENSHOT_MAX_BINARY_BYTES) {
        mimeType = "image/jpeg";
        const originalSize = image.getSize();
        let scale = Math.min(1, Math.sqrt(BROWSER_SCREENSHOT_MAX_BINARY_BYTES / bytes.byteLength) * 0.9);
        for (let pass = 0; pass < 5; pass += 1) {
          const width = Math.min(originalSize.width, Math.max(160, Math.floor(originalSize.width * scale)));
          const height = Math.min(originalSize.height, Math.max(100, Math.floor(originalSize.height * scale)));
          image = image.resize({ width, height, quality: "good" });
          for (const quality of [80, 65, 50, 35, 25]) {
            bytes = image.toJPEG(quality);
            if (bytes.byteLength <= BROWSER_SCREENSHOT_MAX_BINARY_BYTES) break;
          }
          if (bytes.byteLength <= BROWSER_SCREENSHOT_MAX_BINARY_BYTES) break;
          scale *= 0.72;
        }
      }
      if (bytes.byteLength > BROWSER_SCREENSHOT_MAX_BINARY_BYTES) {
        throw new BrowserKernelError("PAYLOAD_TOO_LARGE", "Browser screenshot cannot fit the 512 KB bridge result limit.");
      }
      if (bytes.byteLength === 0) throw viewportUnavailable();
      const size = image.getSize();
      return {
        untrustedWebContent: true,
        mimeType,
        base64: bytes.toString("base64"),
        width: size.width,
        height: size.height
      };
    } finally {
      await this.restoreSensitiveInputs(session, masks).catch(() => undefined);
    }
  }

  private async sensitiveBoundsForScreenshot(session: TabSession): Promise<BrowserElementBounds[]> {
    let response: { nodes?: CdpDomNode[] };
    try {
      response = await this.command<{ nodes?: CdpDomNode[] }>(session, "DOM.getFlattenedDocument", {
        depth: -1,
        pierce: true
      });
    } catch (error) {
      throw screenshotRedactionUnavailable("Sensitive fields could not be enumerated safely.", error);
    }
    if (!Array.isArray(response.nodes) || response.nodes.length === 0) {
      throw screenshotRedactionUnavailable("Sensitive field enumeration returned an invalid DOM snapshot.");
    }

    const bounds: BrowserElementBounds[] = [];
    const seen = new Set<number>();
    for (const node of response.nodes) {
      const backendNodeId = node.backendNodeId;
      if (!isSensitiveElement(node.nodeName, node.attributes)) continue;
      if (!backendNodeId) {
        throw screenshotRedactionUnavailable("A sensitive field had no stable DOM identity.");
      }
      if (seen.has(backendNodeId)) continue;
      seen.add(backendNodeId);
      const box = await this.screenshotBox(session, backendNodeId);
      if (box && box.width > 0 && box.height > 0) bounds.push(box);
    }
    return bounds;
  }

  private async screenshotBox(
    session: TabSession,
    backendNodeId: number
  ): Promise<BrowserElementBounds | null> {
    try {
      const response = await session.contents.debugger.sendCommand("DOM.getBoxModel", {
        backendNodeId
      }) as { model?: { border?: number[]; content?: number[] } };
      const quad = response.model?.border ?? response.model?.content;
      if (!quad || quad.length < 8) {
        throw screenshotRedactionUnavailable("Sensitive field bounds were incomplete.");
      }
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      if (xs.some((value) => !Number.isFinite(value)) || ys.some((value) => !Number.isFinite(value))) {
        throw screenshotRedactionUnavailable("Sensitive field bounds were invalid.");
      }
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      return {
        x: left,
        y: top,
        width: Math.max(...xs) - left,
        height: Math.max(...ys) - top
      };
    } catch (error) {
      const message = rawErrorMessage(error);
      // Elements without a layout object (display:none, detached templates) do
      // not contribute pixels to the captured viewport and need no rectangle.
      if (/could not compute box model|does not have a layout object/i.test(message)) return null;
      if (error instanceof BrowserKernelError && error.code === "BRIDGE_UNAVAILABLE") throw error;
      throw screenshotRedactionUnavailable("Sensitive field bounds could not be resolved safely.", error);
    }
  }

  private async redactSensitivePixels(
    session: TabSession,
    image: Electron.NativeImage,
    bounds: readonly BrowserElementBounds[]
  ): Promise<Electron.NativeImage> {
    if (bounds.length === 0) return image;
    const metrics = await this.command<{
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number };
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
    }>(session, "Page.getLayoutMetrics");
    const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
    const viewportWidth = viewport?.clientWidth;
    const viewportHeight = viewport?.clientHeight;
    if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)
      || viewportWidth! <= 0 || viewportHeight! <= 0) {
      throw screenshotRedactionUnavailable("Screenshot viewport metrics were unavailable.");
    }

    const scaleFactor = Math.max(1, ...image.getScaleFactors().filter((value) => Number.isFinite(value) && value > 0));
    const bitmap = image.toBitmap({ scaleFactor });
    const dimensions = bitmapDimensions(bitmap, image.getAspectRatio(scaleFactor));
    redactBitmapPixels(bitmap, dimensions.width, dimensions.height, {
      width: viewportWidth!,
      height: viewportHeight!,
      offsetX: metrics.cssVisualViewport?.pageX ?? 0,
      offsetY: metrics.cssVisualViewport?.pageY ?? 0
    }, bounds);

    try {
      const { nativeImage } = await import("electron");
      const redacted = nativeImage.createFromBitmap(bitmap, {
        width: dimensions.width,
        height: dimensions.height,
        scaleFactor
      });
      if (redacted.isEmpty()) throw new Error("Native redacted image is empty.");
      return redacted;
    } catch (error) {
      throw screenshotRedactionUnavailable("Screenshot pixels could not be redacted safely.", error);
    }
  }

  async click(
    tabId: string,
    revision: number,
    ref: BrowserElementRef | string | undefined,
    signal?: AbortSignal
  ): Promise<BrowserPointerResult> {
    const { session, point } = await this.refPoint(tabId, revision, ref);
    throwIfAborted(signal);
    const pressed = await this.commandAllowDialog(session, "Input.dispatchMouseEvent", {
      type: "mousePressed", ...point, button: "left", clickCount: 1
    });
    if (!pressed.completed) return point;
    await this.commandAllowDialog(session, "Input.dispatchMouseEvent", {
      type: "mouseReleased", ...point, button: "left", clickCount: 1
    });
    return point;
  }

  async hover(
    tabId: string,
    revision: number,
    ref: BrowserElementRef | string | undefined,
    signal?: AbortSignal
  ): Promise<BrowserPointerResult> {
    const { session, point } = await this.refPoint(tabId, revision, ref);
    throwIfAborted(signal);
    await this.commandAllowDialog(session, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    return point;
  }

  async type(
    tabId: string,
    revision: number,
    ref: BrowserElementRef | string | undefined,
    text: string | undefined,
    signal?: AbortSignal
  ): Promise<BrowserPointerResult> {
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 64 * 1024) {
      throw new BrowserKernelError("PAYLOAD_TOO_LARGE", "Browser input text exceeds 64 KB.");
    }
    const { session, entry, point } = await this.refPoint(tabId, revision, ref);
    throwIfAborted(signal);
    const focused = await this.commandAllowDialog(session, "DOM.focus", {
      backendNodeId: entry.value.backendNodeId
    });
    if (!focused.completed) return point;
    const resolved = await this.command<{ object?: { objectId?: string } }>(session, "DOM.resolveNode", {
      backendNodeId: entry.value.backendNodeId
    });
    const objectId = resolved.object?.objectId;
    if (objectId) {
      const selected = await this.commandAllowDialog(session, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(){if(this instanceof HTMLInputElement||this instanceof HTMLTextAreaElement){this.focus();this.select();}}",
        silent: true
      });
      if (!selected.completed) return point;
    }
    await this.commandAllowDialog(session, "Input.insertText", { text });
    return point;
  }

  async select(
    tabId: string,
    revision: number,
    ref: BrowserElementRef | string | undefined,
    values: string[] | undefined,
    signal?: AbortSignal
  ): Promise<void> {
    if (!Array.isArray(values) || values.length === 0 || values.length > 64
      || values.some((value) => typeof value !== "string" || value.length > 2_048)) {
      throw new BrowserKernelError("PAYLOAD_TOO_LARGE", "Browser select values are invalid.");
    }
    const session = await this.ready(tabId, revision);
    const entry = this.resolveRef(session, tabId, revision, ref);
    throwIfAborted(signal);
    const resolved = await this.command<{ object?: { objectId?: string } }>(session, "DOM.resolveNode", {
      backendNodeId: entry.value.backendNodeId
    });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw staleRef();
    const call = await this.commandAllowDialog<{ exceptionDetails?: unknown }>(session, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function(values){if(!(this instanceof HTMLSelectElement))throw new Error('not-select');const wanted=new Set(values);for(const option of this.options)option.selected=wanted.has(option.value);this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}",
      arguments: [{ value: values }],
      silent: true
    });
    if (!call.completed) return;
    if (call.value.exceptionDetails) {
      throw new BrowserKernelError("STALE_REF", "Observed element is not a selectable control.", { retryable: true });
    }
  }

  async press(
    tabId: string,
    revision: number,
    ref: BrowserElementRef | string | undefined,
    key: string | undefined,
    signal?: AbortSignal
  ): Promise<void> {
    if (!key || key.length > 40 || !(ALLOWED_KEYS.has(key) || /^[a-zA-Z0-9]$/.test(key))) {
      throw new BrowserKernelError("PERMISSION_DENIED", "Browser key is not allow-listed.");
    }
    const session = await this.ready(tabId, revision);
    throwIfAborted(signal);
    if (ref !== undefined) {
      const entry = this.resolveRef(session, tabId, revision, ref);
      const focused = await this.commandAllowDialog(session, "DOM.focus", {
        backendNodeId: entry.value.backendNodeId
      });
      if (!focused.completed) return;
    }
    const normalized = key === "Space" ? " " : key;
    const down = await this.commandAllowDialog(session, "Input.dispatchKeyEvent", { type: "keyDown", key: normalized });
    if (!down.completed) return;
    await this.commandAllowDialog(session, "Input.dispatchKeyEvent", { type: "keyUp", key: normalized });
  }

  async scroll(
    tabId: string,
    revision: number,
    ref: BrowserElementRef | string | undefined,
    deltaX: number | undefined,
    deltaY: number | undefined,
    direction: "up" | "down" | "left" | "right" | undefined,
    signal?: AbortSignal
  ): Promise<BrowserPointerResult> {
    const session = await this.ready(tabId, revision);
    throwIfAborted(signal);
    const point = ref === undefined
      ? await this.viewportCenter(session)
      : (await this.refPoint(tabId, revision, ref)).point;
    const fallback = direction === "up" ? { x: 0, y: -600 }
      : direction === "left" ? { x: -600, y: 0 }
        : direction === "right" ? { x: 600, y: 0 }
          : { x: 0, y: 600 };
    await this.commandAllowDialog(session, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...point,
      deltaX: clampNumber(deltaX, -5_000, 5_000, fallback.x),
      deltaY: clampNumber(deltaY, -5_000, 5_000, fallback.y)
    });
    return point;
  }

  private async viewportCenter(session: TabSession): Promise<BrowserPointerResult> {
    const metrics = await this.command<{ cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }>(
      session,
      "Page.getLayoutMetrics"
    );
    return {
      x: Math.max(0, (metrics.cssLayoutViewport?.clientWidth ?? 800) / 2),
      y: Math.max(0, (metrics.cssLayoutViewport?.clientHeight ?? 600) / 2)
    };
  }

  private async fullAxTree(session: TabSession, signal?: AbortSignal): Promise<CdpAxNode[]> {
    const tree = await this.command<{ frameTree?: CdpFrameTree }>(session, "Page.getFrameTree");
    const frameIds = collectFrameIds(tree.frameTree);
    const nodes: CdpAxNode[] = [];
    for (const frameId of frameIds) {
      throwIfAborted(signal);
      try {
        const response = await this.command<{ nodes?: CdpAxNode[] }>(
          session,
          "Accessibility.getFullAXTree",
          { frameId }
        );
        for (const node of response.nodes ?? []) {
          nodes.push(node.frameId ? node : { ...node, frameId });
          if (nodes.length >= 10_000) return nodes;
        }
      } catch (error) {
        if (frameId === frameIds[0]) throw error;
        // A child frame can detach between Page.getFrameTree and the AX request.
      }
    }
    return nodes;
  }

  async drag(
    tabId: string,
    revision: number,
    ref: BrowserElementRef | string | undefined,
    targetRef: BrowserElementRef | string | undefined,
    signal?: AbortSignal
  ): Promise<BrowserPointerResult> {
    const source = await this.refPoint(tabId, revision, ref);
    const target = await this.refPoint(tabId, revision, targetRef);
    throwIfAborted(signal);
    const positioned = await this.commandAllowDialog(source.session, "Input.dispatchMouseEvent", {
      type: "mouseMoved", ...source.point
    });
    if (!positioned.completed) return target.point;
    const pressed = await this.commandAllowDialog(source.session, "Input.dispatchMouseEvent", {
      type: "mousePressed", ...source.point, button: "left", clickCount: 1
    });
    if (!pressed.completed) return target.point;

    // Chromium can enter its native text/HTML drag loop once a pressed pointer
    // crosses into the target. In that state the mouseMoved CDP response is held
    // until a mouseReleased event arrives. Queue the remaining pointer events in
    // protocol order before awaiting any response so the release can always end
    // that loop. Every response is still awaited (or drained after a dialog).
    const pendingPointerEvents: Array<ReturnType<typeof this.commandAllowDialog>> = [];
    for (let step = 1; step <= 6; step += 1) {
      throwIfAborted(signal);
      pendingPointerEvents.push(this.commandAllowDialog(source.session, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: source.point.x + (target.point.x - source.point.x) * step / 6,
        y: source.point.y + (target.point.y - source.point.y) * step / 6,
        button: "left",
        buttons: 1
      }));
    }
    pendingPointerEvents.push(this.commandAllowDialog(source.session, "Input.dispatchMouseEvent", {
      type: "mouseReleased", ...target.point, button: "left", clickCount: 1
    }));
    const results = await Promise.all(pendingPointerEvents);
    if (results.some((result) => !result.completed)) return target.point;
    return target.point;
  }

  async upload(
    tabId: string,
    revision: number,
    ref: BrowserElementRef | string | undefined,
    paths: readonly string[],
    signal?: AbortSignal
  ): Promise<void> {
    const session = await this.ready(tabId, revision);
    const entry = this.resolveRef(session, tabId, revision, ref);
    throwIfAborted(signal);
    await this.commandAllowDialog(session, "DOM.setFileInputFiles", {
      files: [...paths],
      backendNodeId: entry.value.backendNodeId
    });
  }

  async handleDialog(tabId: string, accept: boolean, promptText?: string): Promise<void> {
    const session = await this.ready(tabId, this.requireSession(tabId).revision);
    if (session.electronDialog) {
      const request = session.electronDialog;
      session.electronDialog = null;
      request.callback(accept, typeof promptText === "string" ? promptText.slice(0, 8_192) : "");
      await this.drainDialogBlockedCommands(session);
      session.onDialog?.(null);
      return;
    }
    await this.command(session, "Page.handleJavaScriptDialog", {
      accept,
      ...(typeof promptText === "string" ? { promptText: promptText.slice(0, 8_192) } : {})
    });
    await this.drainDialogBlockedCommands(session);
    session.onDialog?.(null);
  }

  async waitFor(
    tabId: string,
    revision: number,
    condition: "load" | "network-idle" | "text" | "element" | "url" | undefined,
    value: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ matched: true }> {
    const startedAt = Date.now();
    let idleSince: number | null = null;
    while (Date.now() - startedAt < timeoutMs) {
      throwIfAborted(signal);
      const session = await this.ready(tabId, revision);
      if (condition === "load" && !session.contents.isLoading()) return { matched: true };
      if (condition === "network-idle") {
        const networkIdleSince = session.inflightRequests.size === 0
          ? session.networkLastChangeAt
          : null;
        // Keep isLoading as an extra document-readiness guard, but network
        // idleness is defined by CDP request lifecycle events rather than this
        // coarse WebContents flag.
        if (networkIdleSince !== null && !session.contents.isLoading()) {
          idleSince = Math.max(idleSince ?? 0, networkIdleSince);
        } else {
          idleSince = null;
        }
        if (idleSince !== null && Date.now() - idleSince >= 500) return { matched: true };
      }
      if (condition === "url" && value && session.contents.getURL().includes(value)) return { matched: true };
      if (condition === "text" && value) {
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
          const page = await this.readPage(tabId, revision, { cursor, limit: MAX_READ_ITEMS, signal });
          if (page.text.includes(value)) return { matched: true };
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
      }
      if (condition === "element" && value) {
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
          const observation = await this.observe(tabId, revision, {
            cursor,
            limit: MAX_OBSERVE_ELEMENTS,
            signal
          });
          if (observation.elements.some((element) => element.name.includes(value) || element.role === value)) {
            return { matched: true };
          }
          if (!observation.nextCursor) break;
          cursor = observation.nextCursor;
        }
      }
      await abortableDelay(100, signal);
    }
    throw new BrowserKernelError("TIMEOUT", "Browser wait condition timed out.", { retryable: true });
  }

  async setAgentPresences(tabId: string, values: readonly AgentPresenceSnapshot[]): Promise<void> {
    const session = this.sessions.get(tabId);
    if (!session) return;
    session.presences = values.slice(0, 24).map((presence) => structuredClone(presence));
    try {
      await this.renderPresence(session);
    } catch {
      // Presence is diagnostic UI and must never break browser commands.
    }
  }

  private async ready(tabId: string, revision: number): Promise<TabSession> {
    const session = this.requireSession(tabId);
    if (session.contents.isDestroyed()) {
      throw new BrowserKernelError("TAB_CLOSED", "Browser tab is closed.");
    }
    if (session.revision !== revision) throw staleRef(session.revision);
    await this.attach(session);
    return session;
  }

  private requireSession(tabId: string): TabSession {
    const session = this.sessions.get(tabId);
    if (!session) throw new BrowserKernelError("TAB_NOT_FOUND", "Browser tab is unavailable.");
    return session;
  }

  private attach(session: TabSession): Promise<void> {
    if (session.attachPromise) return session.attachPromise;
    session.attachPromise = (async () => {
      try {
        if (!session.contents.debugger.isAttached()) session.contents.debugger.attach(CDP_VERSION);
        await session.contents.debugger.sendCommand("Page.enable");
        await session.contents.debugger.sendCommand("DOM.enable");
        await session.contents.debugger.sendCommand("Runtime.enable");
        await session.contents.debugger.sendCommand("Accessibility.enable");
        session.inflightRequests.clear();
        session.networkLastChangeAt = Date.now();
        await session.contents.debugger.sendCommand("Network.enable");
        if (session.presences.length > 0) await this.renderPresence(session);
      } catch (error) {
        session.attachPromise = null;
        throw new BrowserKernelError("BRIDGE_UNAVAILABLE", "Chromium automation channel is unavailable.", {
          retryable: true,
          cause: error
        });
      }
    })();
    return session.attachPromise;
  }

  private async command<T = Record<string, unknown>>(
    session: TabSession,
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    try {
      return await session.contents.debugger.sendCommand(method, params) as T;
    } catch (error) {
      if (/node|document|object/i.test(error instanceof Error ? error.message : String(error))) throw staleRef();
      throw new BrowserKernelError("BRIDGE_UNAVAILABLE", "Chromium automation command failed.", {
        retryable: true,
        details: { method },
        cause: error
      });
    }
  }

  private async commandAllowDialog<T = Record<string, unknown>>(
    session: TabSession,
    method: string,
    params?: Record<string, unknown>
  ): Promise<{ completed: true; value: T } | { completed: false }> {
    let notifyOpened: (() => void) | null = null;
    const opened = new Promise<{ completed: false }>((resolve) => {
      notifyOpened = () => resolve({ completed: false });
      session.dialogOpenedWaiters.add(notifyOpened);
    });
    const pending = this.command<T>(session, method, params);
    try {
      const result = await Promise.race([
        pending.then((value) => ({ completed: true as const, value })),
        opened
      ]);
      if (!result.completed) {
        const drain = pending.then(() => undefined, () => undefined);
        session.dialogBlockedCommands.add(drain);
        void drain.finally(() => session.dialogBlockedCommands.delete(drain));
      }
      return result;
    } finally {
      if (notifyOpened) session.dialogOpenedWaiters.delete(notifyOpened);
    }
  }

  private async box(session: TabSession, backendNodeId: number): Promise<BrowserElementBounds | null> {
    try {
      const response = await this.command<{ model?: { border?: number[]; content?: number[] } }>(
        session,
        "DOM.getBoxModel",
        { backendNodeId }
      );
      const quad = response.model?.border ?? response.model?.content;
      if (!quad || quad.length < 8) return null;
      const xs = [quad[0], quad[2], quad[4], quad[6]].filter(Number.isFinite);
      const ys = [quad[1], quad[3], quad[5], quad[7]].filter(Number.isFinite);
      if (xs.length !== 4 || ys.length !== 4) return null;
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
    } catch {
      return null;
    }
  }

  private async isSensitiveNode(session: TabSession, backendNodeId: number): Promise<boolean> {
    const cached = session.sensitiveNodes.get(backendNodeId);
    if (cached !== undefined) return cached;
    let sensitive = false;
    try {
      const response = await this.command<{
        node?: { nodeName?: string; attributes?: string[] };
      }>(session, "DOM.describeNode", { backendNodeId, depth: 0, pierce: false });
      const nodeName = String(response.node?.nodeName ?? "").toLowerCase();
      sensitive = isSensitiveElement(nodeName, response.node?.attributes);
    } catch {
      // A classification failure must never turn an unknown editable field into
      // a readable credential source. Over-redaction is the safe fallback.
      sensitive = true;
    }
    session.sensitiveNodes.set(backendNodeId, sensitive);
    return sensitive;
  }

  private async maskSensitiveInputs(session: TabSession): Promise<number[]> {
    const tree = await this.command<{ frameTree?: CdpFrameTree }>(session, "Page.getFrameTree");
    const frameIds = collectFrameIds(tree.frameTree);
    const contexts: number[] = [];
    for (const frameId of frameIds) {
      try {
        const world = await this.command<{ executionContextId?: number }>(session, "Page.createIsolatedWorld", {
          frameId,
          worldName: `${PRESENCE_WORLD}-screenshot-mask`,
          grantUniveralAccess: false
        });
        if (!world.executionContextId) continue;
        await this.command(session, "Runtime.evaluate", {
          contextId: world.executionContextId,
          expression: MASK_SENSITIVE_EXPRESSION,
          returnByValue: true,
          silent: true
        });
        contexts.push(world.executionContextId);
      } catch {
        // Cross-origin or already-detached frames can disappear during capture.
      }
    }
    return contexts;
  }

  private async restoreSensitiveInputs(session: TabSession, contexts: readonly number[]): Promise<void> {
    await Promise.all(contexts.map((contextId) => this.command(session, "Runtime.evaluate", {
      contextId,
      expression: RESTORE_SENSITIVE_EXPRESSION,
      returnByValue: true,
      silent: true
    }).catch(() => undefined)));
  }

  private resolveRef(
    session: TabSession,
    tabId: string,
    revision: number,
    candidate: BrowserElementRef | string | undefined
  ): RefEntry {
    const id = typeof candidate === "string" ? candidate : candidate?.ref;
    const entry = id ? session.refs.get(id) : undefined;
    if (!entry || entry.value.tabId !== tabId || entry.value.documentRevision !== revision) throw staleRef();
    if (typeof candidate === "object" && (
      candidate.backendNodeId !== entry.value.backendNodeId
      || candidate.frameId !== entry.value.frameId
      || candidate.tabId !== entry.value.tabId
      || candidate.documentRevision !== entry.value.documentRevision
    )) throw staleRef();
    return entry;
  }

  private async refPoint(
    tabId: string,
    revision: number,
    ref: BrowserElementRef | string | undefined
  ): Promise<{ session: TabSession; entry: RefEntry; point: BrowserPointerResult }> {
    const session = await this.ready(tabId, revision);
    const entry = this.resolveRef(session, tabId, revision, ref);
    const bounds = await this.box(session, entry.value.backendNodeId) ?? entry.bounds;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) throw staleRef();
    return {
      session,
      entry,
      point: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    };
  }

  private onMessage(tabId: string, method: string, params: unknown): void {
    const session = this.sessions.get(tabId);
    if (!session || !params || typeof params !== "object") return;
    if (method === "Network.requestWillBeSent") {
      const requestId = (params as { requestId?: unknown }).requestId;
      if (typeof requestId === "string" && requestId) {
        session.inflightRequests.add(requestId);
        session.networkLastChangeAt = Date.now();
      }
    }
    if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      const requestId = (params as { requestId?: unknown }).requestId;
      if (typeof requestId === "string" && requestId) {
        session.inflightRequests.delete(requestId);
        session.networkLastChangeAt = Date.now();
      }
    }
    if (method === "Page.javascriptDialogOpening") {
      const source = params as Record<string, unknown>;
      const rawType = String(source.type ?? "alert");
      const type = rawType === "confirm" || rawType === "prompt" || rawType === "beforeunload"
        ? rawType
        : "alert";
      session.onDialog?.({
        tabId,
        type,
        message: String(source.message ?? "").slice(0, 4_096),
        defaultPrompt: String(source.defaultPrompt ?? "").slice(0, 8_192),
        openedAt: Date.now()
      });
      this.notifyDialogOpened(session);
    }
    if (method === "Page.javascriptDialogClosed") session.onDialog?.(null);
    if (method === "Page.frameNavigated") {
      const source = params as { frame?: { parentId?: string } };
      if (!source.frame?.parentId) {
        session.refs.clear();
        session.sensitiveNodes.clear();
        session.presenceContextId = null;
        if (session.presences.length > 0) void this.renderPresence(session).catch(() => undefined);
      }
    }
  }

  private onElectronDialog(
    tabId: string,
    info: ElectronDialogInfo,
    callback: ElectronDialogCallback
  ): void {
    const session = this.sessions.get(tabId);
    if (!session) {
      callback(false, "");
      return;
    }
    if (session.electronDialog) session.electronDialog.callback(false, "");
    session.electronDialog = { callback };
    const rawType = String(info.dialogType ?? "alert");
    const type = rawType === "confirm" || rawType === "prompt" ? rawType : "alert";
    session.onDialog?.({
      tabId,
      type,
      message: String(info.messageText ?? "").slice(0, 4_096),
      defaultPrompt: String(info.defaultPromptText ?? "").slice(0, 8_192),
      openedAt: Date.now()
    });
    this.notifyDialogOpened(session);
  }

  private notifyDialogOpened(session: TabSession): void {
    const waiters = [...session.dialogOpenedWaiters];
    session.dialogOpenedWaiters.clear();
    for (const notify of waiters) notify();
  }

  private async drainDialogBlockedCommands(session: TabSession): Promise<void> {
    const commands = [...session.dialogBlockedCommands];
    if (commands.length === 0) return;
    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        Promise.all(commands),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new BrowserKernelError(
            "TIMEOUT",
            "Browser input did not resume after the JavaScript dialog closed.",
            { retryable: true }
          )), 5_000);
          timeout.unref();
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private cancelElectronDialog(tabId: string, knownSession?: TabSession): void {
    const session = knownSession ?? this.sessions.get(tabId);
    if (!session?.electronDialog) return;
    const request = session.electronDialog;
    session.electronDialog = null;
    request.callback(false, "");
    session.onDialog?.(null);
  }

  private async renderPresence(session: TabSession): Promise<void> {
    if (!session.contents.debugger.isAttached()) return;
    if (session.presenceContextId === null) {
      const tree = await this.command<{ frameTree?: { frame?: { id?: string } } }>(session, "Page.getFrameTree");
      const frameId = tree.frameTree?.frame?.id;
      if (!frameId) return;
      const world = await this.command<{ executionContextId?: number }>(session, "Page.createIsolatedWorld", {
        frameId,
        worldName: PRESENCE_WORLD,
        grantUniveralAccess: false
      });
      session.presenceContextId = world.executionContextId ?? null;
    }
    if (session.presenceContextId === null) return;
    const safe = session.presences.filter((presence) => presence.cursor.updatedAt > 0).map((presence) => ({
      id: presence.connectionId.slice(0, 160),
      color: /^#[0-9a-f]{6}$/i.test(presence.brandColor) ? presence.brandColor : "#7A8291",
      x: clampNumber(presence.cursor.x, -10_000, 10_000, 0),
      y: clampNumber(presence.cursor.y, -10_000, 10_000, 0),
      stale: presence.connectionState === "stale"
    }));
    const payload = JSON.stringify(safe).replace(/</g, "\\u003c");
    await this.command(session, "Runtime.evaluate", {
      contextId: session.presenceContextId,
      expression: presenceExpression(payload),
      returnByValue: true,
      silent: true
    });
  }
}

function presenceExpression(payload: string): string {
  return `(()=>{const values=${payload};let host=globalThis.__canvasttyPresenceHost;if(!host||!host.isConnected){host=document.createElement('div');host.setAttribute('data-canvastty-presence','');host.style.cssText='all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;overflow:visible!important;';document.documentElement.appendChild(host);globalThis.__canvasttyPresenceHost=host;}host.replaceChildren(...values.map(v=>{const marker=document.createElement('div');marker.style.cssText='all:initial!important;position:absolute!important;left:'+v.x+'px!important;top:'+v.y+'px!important;transform:translate(-3px,-3px)!important;pointer-events:none!important;opacity:'+(v.stale?'.45':'1')+'!important;';const dot=document.createElement('span');dot.style.cssText='display:block!important;width:10px!important;height:10px!important;border-radius:999px!important;background:'+v.color+'!important;border:2px solid white!important;box-shadow:0 1px 5px rgba(0,0,0,.45)!important;';marker.append(dot);return marker;}));return true;})()`;
}

const MASK_SENSITIVE_EXPRESSION = `(()=>{const sensitive=(el)=>{const ac=(el.getAttribute('autocomplete')||'').toLowerCase();const identity=['name','id','aria-label','aria-labelledby','placeholder','title'].map(k=>el.getAttribute(k)||'').join(' ').toLowerCase();return (el.type||'').toLowerCase()==='password'||/current-password|new-password|one-time-code/.test(ac)||/password|passwd|passcode|one[-_ ]?time|otp|token|secret|api[-_ ]?key|auth(?:orization)?/.test(identity);};const entries=[];const roots=[document];for(let i=0;i<roots.length;i++){for(const node of roots[i].querySelectorAll('*')){if(node.shadowRoot)roots.push(node.shadowRoot);}for(const el of roots[i].querySelectorAll('input,textarea')){if(!sensitive(el))continue;entries.push([el,el.getAttribute('style')]);el.style.setProperty('color','transparent','important');el.style.setProperty('-webkit-text-fill-color','transparent','important');el.style.setProperty('caret-color','transparent','important');el.style.setProperty('text-shadow','none','important');el.style.setProperty('background','#20242b','important');el.style.setProperty('box-shadow','inset 0 0 0 9999px #20242b','important');}}globalThis.__canvasttyScreenshotMasks=entries;return entries.length;})()`;

const RESTORE_SENSITIVE_EXPRESSION = `(()=>{for(const [el,style] of globalThis.__canvasttyScreenshotMasks||[]){if(!el||!el.isConnected)continue;if(style===null)el.removeAttribute('style');else el.setAttribute('style',style);}globalThis.__canvasttyScreenshotMasks=[];return true;})()`;

function axString(value: CdpAxValue | undefined): string {
  return typeof value?.value === "string" ? value.value : "";
}

function optionalAxString(value: CdpAxValue | undefined): string | null {
  const result = axString(value).slice(0, 1_000);
  return result || null;
}

function axBooleanProperty(node: CdpAxNode, name: string): boolean {
  const value = node.properties?.find((property) => property.name === name)?.value?.value;
  return value === true;
}

function axPropertyString(node: CdpAxNode, name: string): string {
  const value = node.properties?.find((property) => property.name === name)?.value?.value;
  return typeof value === "string" ? value : "";
}

function cleanLinkUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isSensitiveElement(nodeNameValue: string | undefined, rawAttributes: string[] | undefined): boolean {
  const nodeName = String(nodeNameValue ?? "").toLowerCase();
  if (nodeName !== "input" && nodeName !== "textarea") return false;
  const attributes = attributeMap(rawAttributes);
  const identity = [
    attributes.name,
    attributes.id,
    attributes["aria-label"],
    attributes["aria-labelledby"],
    attributes.placeholder,
    attributes.title
  ].filter(Boolean).join(" ");
  return attributes.type?.toLowerCase() === "password"
    || /(?:current-password|new-password|one-time-code)/i.test(attributes.autocomplete ?? "")
    || /(?:password|passwd|passcode|one[-_ ]?time|otp|token|secret|api[-_ ]?key|auth(?:orization)?)/i.test(identity);
}

function mergeSensitiveBounds(
  before: readonly BrowserElementBounds[],
  after: readonly BrowserElementBounds[]
): BrowserElementBounds[] {
  const result: BrowserElementBounds[] = [];
  const seen = new Set<string>();
  for (const bounds of [...before, ...after]) {
    const key = [bounds.x, bounds.y, bounds.width, bounds.height]
      .map((value) => Math.round(value * 100) / 100)
      .join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(bounds);
  }
  return result;
}

function bitmapDimensions(bitmap: Buffer, aspectRatio: number): { width: number; height: number } {
  if (bitmap.byteLength === 0 || bitmap.byteLength % 4 !== 0
    || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    throw screenshotRedactionUnavailable("Screenshot bitmap format was invalid.");
  }
  const pixels = bitmap.byteLength / 4;
  const expectedWidth = Math.max(1, Math.round(Math.sqrt(pixels * aspectRatio)));
  for (let distance = 0; distance <= 64; distance += 1) {
    for (const width of distance === 0
      ? [expectedWidth]
      : [expectedWidth - distance, expectedWidth + distance]) {
      if (width <= 0 || pixels % width !== 0) continue;
      const height = pixels / width;
      if (Math.abs(width / height - aspectRatio) / aspectRatio <= 0.02) return { width, height };
    }
  }
  throw screenshotRedactionUnavailable("Screenshot bitmap dimensions could not be verified.");
}

export function redactBitmapPixels(
  bitmap: Buffer,
  bitmapWidth: number,
  bitmapHeight: number,
  viewport: { width: number; height: number; offsetX?: number; offsetY?: number },
  bounds: readonly BrowserElementBounds[]
): void {
  if (!Number.isInteger(bitmapWidth) || !Number.isInteger(bitmapHeight)
    || bitmapWidth <= 0 || bitmapHeight <= 0
    || bitmap.byteLength !== bitmapWidth * bitmapHeight * 4
    || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
    || viewport.width <= 0 || viewport.height <= 0) {
    throw screenshotRedactionUnavailable("Screenshot bitmap geometry was invalid.");
  }
  const scaleX = bitmapWidth / viewport.width;
  const scaleY = bitmapHeight / viewport.height;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0
    || Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY) > 0.08) {
    throw screenshotRedactionUnavailable("Screenshot scale could not be verified.");
  }
  const offsetX = Number.isFinite(viewport.offsetX) ? viewport.offsetX! : 0;
  const offsetY = Number.isFinite(viewport.offsetY) ? viewport.offsetY! : 0;
  for (const boundsValue of bounds) {
    if (![boundsValue.x, boundsValue.y, boundsValue.width, boundsValue.height].every(Number.isFinite)
      || boundsValue.width <= 0 || boundsValue.height <= 0) {
      throw screenshotRedactionUnavailable("Sensitive field rectangle was invalid.");
    }
    const leftCss = boundsValue.x - offsetX;
    const topCss = boundsValue.y - offsetY;
    const rightCss = leftCss + boundsValue.width;
    const bottomCss = topCss + boundsValue.height;
    if (rightCss <= 0 || bottomCss <= 0 || leftCss >= viewport.width || topCss >= viewport.height) continue;
    const left = Math.max(0, Math.floor((leftCss - 2) * scaleX));
    const top = Math.max(0, Math.floor((topCss - 2) * scaleY));
    const right = Math.min(bitmapWidth, Math.ceil((rightCss + 2) * scaleX));
    const bottom = Math.min(bitmapHeight, Math.ceil((bottomCss + 2) * scaleY));
    if (right <= left || bottom <= top) {
      throw screenshotRedactionUnavailable("Sensitive field pixels could not be located.");
    }
    for (let y = top; y < bottom; y += 1) {
      // Clearing all four bytes is independent of the platform-specific RGBA /
      // BGRA / ARGB bitmap ordering and guarantees no captured color survives.
      bitmap.fill(0, (y * bitmapWidth + left) * 4, (y * bitmapWidth + right) * 4);
    }
  }
}

function viewportUnavailable(): BrowserKernelError {
  return new BrowserKernelError("VIEWPORT_UNAVAILABLE", "Browser view has no drawable surface. Bring its Browser card into view and retry.", {
    retryable: true
  });
}

function screenshotRedactionUnavailable(message: string, cause?: unknown): BrowserKernelError {
  return new BrowserKernelError("BRIDGE_UNAVAILABLE", message, {
    retryable: true,
    ...(cause === undefined ? {} : { cause })
  });
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return `${error.message} ${cause instanceof Error ? cause.message : String(cause ?? "")}`;
  }
  return String(error);
}

function attributeMap(values: string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < (values?.length ?? 0); index += 2) {
    const key = values![index];
    if (key) result[key.toLowerCase()] = values![index + 1] ?? "";
  }
  return result;
}

function collectFrameIds(tree: CdpFrameTree | undefined): string[] {
  if (!tree) return [];
  const values = tree.frame?.id ? [tree.frame.id] : [];
  for (const child of tree.childFrames ?? []) values.push(...collectFrameIds(child));
  return values;
}

export function stableElementRefId(
  tabId: string,
  revision: number,
  frameId: string,
  backendNodeId: number
): string {
  const digest = createHash("sha256")
    .update(tabId)
    .update("\0")
    .update(String(revision))
    .update("\0")
    .update(frameId)
    .update("\0")
    .update(String(backendNodeId))
    .digest("base64url")
    .slice(0, 24);
  return `ref_${digest}`;
}

function trimRefs(refs: Map<string, RefEntry>): void {
  while (refs.size > 1_000) refs.delete(refs.keys().next().value!);
}

function encodeCursor(revision: number, offset: number): string {
  return Buffer.from(`${revision}:${offset}`, "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined, revision: number): number {
  if (!value) return 0;
  try {
    const [encodedRevision, encodedOffset] = Buffer.from(value, "base64url").toString("utf8").split(":");
    if (Number(encodedRevision) !== revision) throw staleRef(revision);
    const offset = Number(encodedOffset);
    return Number.isInteger(offset) && offset >= 0 && offset <= 100_000 ? offset : 0;
  } catch (error) {
    if (error instanceof BrowserKernelError) throw error;
    return 0;
  }
}

function staleRef(currentRevision?: number): BrowserKernelError {
  return new BrowserKernelError("STALE_REF", "Browser element reference is stale.", {
    retryable: true,
    ...(currentRevision === undefined ? {} : { details: { currentRevision } })
  });
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value!)) : fallback;
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value!)) : fallback;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    if (!signal) return;
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Browser command was canceled.", "AbortError"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
