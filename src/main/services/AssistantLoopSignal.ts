/**
 * `loop.detected` from the Assistant plugin marks a subagent as looping, which permits a retry and raises an
 * attention notice. The plugin id in a manifest is self-declared, so any GitHub repository could install itself as
 * `canvastty-assistant`. The signal is accepted only from the plugin whose install record names the Assistant's own
 * repository, that is enabled, and whose services the person trusted as native code.
 */
export const ASSISTANT_PLUGIN_ID = "canvastty-assistant";
export const ASSISTANT_SERVICE_ID = "assistant";
/** Canonical install sources (PluginManager.normalizeGithubUrl form) of the first-party Assistant plugin. */
export const ASSISTANT_PLUGIN_SOURCES: ReadonlySet<string> = new Set([
  "https://github.com/howdeploy/canvastty-plugin-assistant.git",
  "https://github.com/BIackFIame/canvastty-plugin-assistant.git"
]);

export interface PluginInstallRecord { sourceUrl: string; enabled: boolean; nativeCodeTrusted: boolean }
export interface LoopSignalSession { provider: string; exitCode: number | null; status: string; role?: string }
export interface LoopSignalDeps {
  installRecord(pluginId: string): PluginInstallRecord | null;
  session(sessionId: string): LoopSignalSession | undefined;
  turnEpoch(sessionId: string): number | null;
  consumeEvidence(sessionId: string, evidenceId: string, turnEpoch: number): boolean;
  markLoopDetected(sessionId: string): boolean;
}
export interface AcceptedLoopSignal {
  sessionId: string;
  label: string;
  reason?: string;
  /** The event without its single-use host evidence, safe to broadcast to the renderer. */
  data: Record<string, unknown>;
}

export function isInstalledAssistant(record: PluginInstallRecord | null): boolean {
  if (!record || !record.enabled || !record.nativeCodeTrusted) return false;
  // GitHub owner and repository names are case-insensitive.
  const source = record.sourceUrl.toLowerCase();
  return [...ASSISTANT_PLUGIN_SOURCES].some((known) => known.toLowerCase() === source);
}

/** Returns the accepted signal, or null when it must be ignored. Evidence is consumed only for a verified sender. */
export function acceptLoopSignal(deps: LoopSignalDeps, pluginId: string, serviceId: string, data: unknown,
  redact: (text: string) => string): AcceptedLoopSignal | null {
  if (pluginId !== ASSISTANT_PLUGIN_ID || serviceId !== ASSISTANT_SERVICE_ID) return null;
  if (!isInstalledAssistant(deps.installRecord(pluginId))) return null;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const values = data as Record<string, unknown>;
  const { sessionId, evidenceId } = values;
  if (typeof sessionId !== "string" || typeof evidenceId !== "string") return null;
  const session = deps.session(sessionId);
  const turnEpoch = deps.turnEpoch(sessionId);
  if (!session || session.provider === "terminal" || session.exitCode !== null
    || session.status === "done" || session.status === "failed"
    || turnEpoch === null || !deps.consumeEvidence(sessionId, evidenceId, turnEpoch)) return null;
  if (session.role === "subagent") {
    try { if (!deps.markLoopDetected(sessionId)) return null; } catch { return null; }
  }
  const kind = values.kind;
  const label = kind === "repeated-error" ? "Repeated tool errors detected"
    : kind === "no-file-progress" || kind === "no-progress" ? "No observed file progress" : "Repeated action detected";
  const reason = typeof values.reason === "string" ? redact(values.reason).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160) : undefined;
  const { evidenceId: _evidenceId, ...safeData } = values;
  return { sessionId, label, ...(reason !== undefined ? { reason } : {}), data: safeData };
}
