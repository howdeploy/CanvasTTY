import { useEffect, useMemo, useRef, useState } from "react";
import type {
  InstalledPlugin,
  LimitsSnapshot,
  LocaleId,
  PaletteId,
  PluginContribution,
  PluginPermission,
  ProviderId,
  SessionSnapshot
} from "../../../../shared/contracts";
import {
  pluginCanvasFocusInput,
  pluginCanvasWheelInput,
  type PluginCanvasWheelInput
} from "./pluginInputBridge";
import { createFrameReplyGate } from "./frameReplies";
import { pluginVisibilityMessage } from "../../../../shared/pluginVisibility";
import { isProviderId } from "../../../../shared/providerCatalog.ts";

const storageListeners = new Map<string, Set<(key: string, value: unknown) => void>>();

interface PluginFrameProps {
  plugin: InstalledPlugin;
  contribution: PluginContribution;
  locale: LocaleId;
  palette: PaletteId;
  sessions: readonly SessionSnapshot[];
  limits: LimitsSnapshot | null;
  canvasInstanceId?: string;
  className?: string;
  captureCanvasWheelOverWidgets: boolean;
  onCanvasWheel(event: PluginCanvasWheelInput): void;
  onFocus(): void;
  onHoverChange(active: boolean): void;
  onOpenLauncher(provider: ProviderId): void;
  onError(message: string): void;
  /**
   * Nobody can see the frame (summary, HOME editing, off-screen, minimized). The document stays loaded;
   * the host tells it so, and the injected bridge reports `document.visibilityState === "hidden"`,
   * fires `visibilitychange`, caps its timers at one wake-up a second and holds its animation frames.
   */
  suspended?: boolean;
}

interface PluginMessage {
  source?: unknown;
  type?: unknown;
  requestId?: unknown;
  method?: unknown;
  params?: unknown;
}

export function PluginFrame({
  plugin,
  contribution,
  locale,
  palette,
  sessions,
  limits,
  canvasInstanceId,
  className,
  captureCanvasWheelOverWidgets,
  onCanvasWheel,
  onFocus,
  onHoverChange,
  onOpenLauncher,
  onError,
  suspended = false
}: PluginFrameProps): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null);
  // Tells which document a finished request belongs to, so a reload never receives an earlier reply.
  const [replies] = useState(createFrameReplyGate);
  const entryUrl = useMemo(
    () => `canvastty-plugin://${plugin.manifest.id}/${encodeAssetPath(contribution.entry)}`,
    [contribution.entry, plugin.manifest.id]
  );
  // The plugin the frame serves right now, read when a reply is ready; and a new document the moment the
  // host points the frame elsewhere (during render, before the frame can load or ask anything).
  const servedPlugin = useRef(plugin.manifest.id);
  servedPlugin.current = plugin.manifest.id;
  replies.showing(plugin.manifest.id, entryUrl);

  const context = useMemo(() => ({
    apiVersion: 1,
    plugin: {
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      permissions: plugin.manifest.permissions,
      modules: plugin.selectedModules
    },
    contribution: {
      id: contribution.id,
      kind: contribution.kind,
      title: contribution.title
    },
    appearance: { locale, palette }
  }), [contribution.id, contribution.kind, contribution.title, locale, palette, plugin.manifest]);

  useEffect(() => {
    const receive = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow || !isRecord(event.data)) return;
      const message = event.data as PluginMessage;
      if (message.source !== "canvastty-plugin") return;
      const input = pluginCanvasFocusInput(event.data);
      if (input?.type === "focus") {
        onFocus();
        return;
      }
      if (input?.type === "hover") {
        if (input.active) {
          onHoverChange(true);
        } else {
          const pluginFrame = frame.current;
          requestAnimationFrame(() => {
            const widget = pluginFrame?.closest<HTMLElement>("[data-canvas-widget-id]");
            if (!widget?.matches(":hover")) onHoverChange(false);
          });
        }
        return;
      }
      if (message.type === "canvas-wheel") {
        if (!captureCanvasWheelOverWidgets) return;
        const pluginFrame = frame.current;
        const bounds = pluginFrame?.getBoundingClientRect();
        const wheel = bounds && pluginFrame ? pluginCanvasWheelInput(event.data, {
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
          layoutWidth: pluginFrame.clientWidth,
          layoutHeight: pluginFrame.clientHeight
        }) : null;
        if (wheel) onCanvasWheel(wheel);
        return;
      }
      if (message.type === "ready") {
        postToFrame(frame.current, { source: "canvastty-host", type: "context", value: context });
        return;
      }
      if (message.type !== "request" || typeof message.requestId !== "string" || message.requestId.length > 80) return;
      if (typeof message.method !== "string" || message.method.length > 80) return;

      const mayReply = replies.received(message.requestId, event.source, plugin.manifest.id);
      void handleRequest({
        plugin,
        method: message.method,
        params: isRecord(message.params) ? message.params : {},
        context,
        sessions,
        limits,
        canvasInstanceId,
        onOpenLauncher
      }).then((value) => {
        if (!mayReply(frame.current?.contentWindow, servedPlugin.current)) return;
        postToFrame(frame.current, {
          source: "canvastty-host",
          type: "response",
          requestId: message.requestId,
          ok: true,
          value
        });
      }).catch((error: unknown) => {
        const description = safeError(error);
        onError(description);
        if (!mayReply(frame.current?.contentWindow, servedPlugin.current)) return;
        postToFrame(frame.current, {
          source: "canvastty-host",
          type: "response",
          requestId: message.requestId,
          ok: false,
          error: description
        });
      });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [canvasInstanceId, captureCanvasWheelOverWidgets, context, limits, onCanvasWheel, onError, onFocus, onHoverChange, onOpenLauncher, plugin, replies, sessions]);

  useEffect(() => {
    postToFrame(frame.current, { source: "canvastty-host", type: "context", value: context });
  }, [context]);

  useEffect(() => {
    postCanvasInputPolicy(frame.current, captureCanvasWheelOverWidgets);
  }, [captureCanvasWheelOverWidgets]);

  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  useEffect(() => {
    postToFrame(frame.current, pluginVisibilityMessage(!suspended));
  }, [suspended]);

  useEffect(() => subscribeStorage(plugin.manifest.id, (key, value) => {
    postToFrame(frame.current, { source: "canvastty-host", type: "storage-change", key, value });
  }), [plugin.manifest.id]);

  const hasServices = Boolean(plugin.manifest.services?.length);
  useEffect(() => {
    if (!hasServices) return;
    const pluginId = plugin.manifest.id;
    return window.canvasTTY.plugins.onServiceEvent(({ pluginId: owner, serviceId, event, data }) => {
      if (owner !== pluginId) return;
      postToFrame(frame.current, { source: "canvastty-host", type: "service-event", value: { serviceId, event, data } });
    });
  }, [hasServices, plugin.manifest.id]);

  return (
    <iframe
      ref={frame}
      className={className ? `plugin-frame ${className}` : "plugin-frame"}
      src={entryUrl}
      title={`${plugin.manifest.name}: ${contribution.title}`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      inert={suspended}
      data-suspended={suspended ? "true" : undefined}
      onFocus={onFocus}
      onLoad={() => {
        replies.loaded();
        postToFrame(frame.current, { source: "canvastty-host", type: "context", value: context });
        postCanvasInputPolicy(frame.current, captureCanvasWheelOverWidgets);
        // A new document starts visible; tell it at once if it loaded while suspended.
        if (suspendedRef.current) postToFrame(frame.current, pluginVisibilityMessage(false));
      }}
    />
  );
}

async function handleRequest({
  plugin,
  method,
  params,
  context,
  sessions,
  limits,
  canvasInstanceId,
  onOpenLauncher
}: {
  plugin: InstalledPlugin;
  method: string;
  params: Record<string, unknown>;
  context: unknown;
  sessions: readonly SessionSnapshot[];
  limits: LimitsSnapshot | null;
  canvasInstanceId?: string;
  onOpenLauncher(provider: ProviderId): void;
}): Promise<unknown> {
  const pluginId = plugin.manifest.id;
  if (method === "host.getContext") return context;
  if (method === "storage.get") {
    requirePermission(plugin, "storage");
    return window.canvasTTY.plugins.storageGet(pluginId, stringParam(params.key, "key"));
  }
  if (method === "storage.set") {
    requirePermission(plugin, "storage");
    const key = stringParam(params.key, "key");
    await window.canvasTTY.plugins.storageSet(pluginId, key, params.value);
    return null;
  }
  if (method === "secrets.get") {
    requirePermission(plugin, "secrets");
    return window.canvasTTY.plugins.secretsGet(pluginId, stringParam(params.key, "key"));
  }
  if (method === "secrets.set") {
    requirePermission(plugin, "secrets");
    await window.canvasTTY.plugins.secretsSet(
      pluginId,
      stringParam(params.key, "key"),
      secretValue(params.value)
    );
    return null;
  }
  if (method === "secrets.delete") {
    requirePermission(plugin, "secrets");
    await window.canvasTTY.plugins.secretsDelete(pluginId, stringParam(params.key, "key"));
    return null;
  }
  if (method === "sessions.list") {
    requirePermission(plugin, "sessions:read");
    return sessions.map((session) => ({
      id: session.id,
      provider: session.provider,
      title: session.title,
      status: session.status,
      startedAt: session.startedAt,
      exitCode: session.exitCode
    }));
  }
  if (method === "limits.get") {
    requirePermission(plugin, "limits:read");
    return pluginLimitsResponse(limits);
  }
  if (method === "hermesHud.getState") {
    requirePermission(plugin, "hermes:hud");
    return window.canvasTTY.plugins.hermesHudStatus(pluginId);
  }
  if (method === "hermesHud.open") {
    requirePermission(plugin, "hermes:hud");
    return window.canvasTTY.plugins.hermesHudOpen(pluginId);
  }
  if (method === "hermesHud.close") {
    requirePermission(plugin, "hermes:hud");
    return window.canvasTTY.plugins.hermesHudClose(pluginId);
  }
  if (method === "launcher.open") {
    requirePermission(plugin, "launcher:open");
    const provider = stringParam(params.provider, "provider");
    if (!isProviderId(provider)) throw new Error("Plugin requested an unknown launcher provider.");
    onOpenLauncher(provider);
    return null;
  }
  if (method === "external.open") {
    requirePermission(plugin, "external:open");
    await window.canvasTTY.plugins.openExternal(pluginId, stringParam(params.url, "url"));
    return null;
  }
  if (method === "browser.open") {
    requirePermission(plugin, "browser:open");
    await window.canvasTTY.plugins.openBrowser(pluginId, stringParam(params.url, "url"));
    return null;
  }
  if (method === "media.pickLibrary") {
    requirePermission(plugin, "media:library");
    return window.canvasTTY.plugins.mediaPickLibrary(pluginId);
  }
  if (method === "media.listLibraries") {
    requirePermission(plugin, "media:library");
    return window.canvasTTY.plugins.mediaListLibraries(pluginId);
  }
  if (method === "media.scanLibrary") {
    requirePermission(plugin, "media:library");
    return window.canvasTTY.plugins.mediaScanLibrary(pluginId, stringParam(params.libraryId, "libraryId"));
  }
  if (method === "media.revokeLibrary") {
    requirePermission(plugin, "media:library");
    await window.canvasTTY.plugins.mediaRevokeLibrary(pluginId, stringParam(params.libraryId, "libraryId"));
    return null;
  }
  if (method === "playlists.list") {
    requirePermission(plugin, "playlists:read");
    return window.canvasTTY.plugins.playlistsList(pluginId, stringParam(params.libraryId, "libraryId"));
  }
  if (method === "playlists.read") {
    requirePermission(plugin, "playlists:read");
    return window.canvasTTY.plugins.playlistsRead(
      pluginId,
      stringParam(params.libraryId, "libraryId"),
      stringParam(params.playlistId, "playlistId")
    );
  }
  if (method === "playlists.write") {
    requirePermission(plugin, "playlists:write");
    return window.canvasTTY.plugins.playlistsWrite(
      pluginId,
      stringParam(params.libraryId, "libraryId"),
      stringParam(params.name, "name"),
      playlistContent(params.content)
    );
  }
  if (method === "service.request") {
    // Only this frame's own plugin id is ever passed, so a plugin reaches only its own services.
    return window.canvasTTY.plugins.serviceRequest(
      pluginId,
      stringParam(params.serviceId, "serviceId"),
      stringParam(params.method, "method"),
      params.params
    );
  }
  if (method === "window.open") {
    const contributionId = stringParam(params.contributionId, "contributionId");
    const target = plugin.manifest.contributions.find((contribution) => (
      contribution.id === contributionId && contribution.kind === "window"
    ));
    if (!target) throw new Error("Plugin requested an unknown window contribution.");
    await window.canvasTTY.plugins.openWindow(pluginId, contributionId);
    return null;
  }
  if (method === "canvas.open") {
    const contributionId = stringParam(params.contributionId, "contributionId");
    const target = plugin.manifest.contributions.find((contribution) => (
      contribution.id === contributionId && contribution.kind === "canvas-app"
    ));
    if (!target) throw new Error("Plugin requested an unknown canvas contribution.");
    await window.canvasTTY.plugins.openCanvas(pluginId, contributionId, canvasInstanceId);
    return null;
  }
  throw new Error(`Unsupported plugin method: ${method}.`);
}

/**
 * The renderer holds the raw snapshot, whose accountScope fingerprint exists only for
 * local usage history; plugins receive a deep copy without it.
 */
export function pluginLimitsResponse(
  snapshot: LimitsSnapshot | null
): { state: "ready"; snapshot: LimitsSnapshot } | { state: "loading"; snapshot: null } {
  if (!snapshot) return { state: "loading", snapshot: null };
  return {
    state: "ready",
    snapshot: {
      fetchedAt: snapshot.fetchedAt,
      providers: snapshot.providers.map((provider) => {
        if (provider.state === "unavailable") return structuredClone(provider);
        const { accountScope: _omitted, ...rest } = provider;
        return structuredClone(rest);
      })
    }
  };
}

function requirePermission(plugin: InstalledPlugin, permission: PluginPermission): void {
  if (!plugin.manifest.permissions.includes(permission)) {
    throw new Error(`Plugin permission is required: ${permission}.`);
  }
}

function postToFrame(frame: HTMLIFrameElement | null, message: object): void {
  frame?.contentWindow?.postMessage(message, "*");
}

function postCanvasInputPolicy(frame: HTMLIFrameElement | null, captureWheel: boolean): void {
  postToFrame(frame, { source: "canvastty-host", type: "canvas-input-policy", captureWheel });
}

function subscribeStorage(pluginId: string, listener: (key: string, value: unknown) => void): () => void {
  const listeners = storageListeners.get(pluginId) ?? new Set();
  listeners.add(listener);
  storageListeners.set(pluginId, listeners);
  startStorageBridge();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) storageListeners.delete(pluginId);
    stopStorageBridge();
  };
}

// The main process broadcasts every committed plugin storage write, covering
// both embedded frames and separate plugin windows; forward it to local frames.
let storageBridge: (() => void) | null = null;
let storageBridgeRefs = 0;

function startStorageBridge(): void {
  storageBridgeRefs += 1;
  storageBridge ??= window.canvasTTY.plugins.onStorageChanged((event) => {
    emitStorage(event.pluginId, event.key, event.value);
  });
}

function stopStorageBridge(): void {
  storageBridgeRefs -= 1;
  if (storageBridgeRefs > 0) return;
  storageBridge?.();
  storageBridge = null;
}

function emitStorage(pluginId: string, key: string, value: unknown): void {
  storageListeners.get(pluginId)?.forEach((listener) => listener(key, structuredClone(value)));
}

function stringParam(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new Error(`Plugin ${label} parameter is invalid.`);
  }
  return value;
}

function playlistContent(value: unknown): string {
  if (typeof value !== "string" || new Blob([value]).size > 4 * 1024 * 1024) {
    throw new Error("Plugin playlist content is invalid or exceeds 4 MB.");
  }
  return value;
}

function secretValue(value: unknown): string {
  if (typeof value !== "string" || new Blob([value]).size > 16 * 1024) {
    throw new Error("Plugin secret value is invalid or exceeds 16 KB.");
  }
  return value;
}

function encodeAssetPath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : "Plugin request failed.";
  // Plugins see the host's message, not Electron's IPC wrapper around it.
  return value
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 240);
}
