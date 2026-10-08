import type {
  PluginCardAction,
  PluginCardActionResult,
  PluginCardBadge,
  PluginCardDecorations,
  PluginCardTone
} from "../../shared/contracts.ts";
import { cardActionMatches } from "../../shared/pluginCardActions.ts";
import { normalizeCardActionInput, normalizeCardReview } from "./PluginChangeReviews.ts";
import type { PluginSessionSummary } from "./PluginSessions.ts";

/** A trusted plugin service that declared `cardActions` (PluginManager.cardActionProviders). */
export interface CardActionProvider {
  pluginId: string;
  pluginName: string;
  serviceId: string;
  actions: PluginCardAction[];
}

export interface PluginCardsDependencies {
  invokeWithConsent?<T>(pluginId: string, actionId: string, sessionId: string, action: () => Promise<T>): Promise<T>;
  providers(): CardActionProvider[];
  /** Plugins whose services run now (native code trusted); badges of others are not shown. */
  trustedPlugins(): ReadonlySet<string>;
  call(pluginId: string, serviceId: string, method: "canvastty.cards.invoke", params: unknown, timeoutMs: number): Promise<unknown>;
  session(sessionId: string): PluginSessionSummary | null;
  redact(text: string): string;
  /** Pushes the new decorations to the window. */
  changed(decorations: PluginCardDecorations): void;
  timeoutMs?: number;
}

/** What a card action service receives (`canvastty.cards.invoke`). */
export interface CardActionInvocation {
  actionId: string;
  sessionId: string;
  session: PluginSessionSummary;
  input?: Record<string, unknown>;
}

const CARD_ACTION_TIMEOUT_MS = 15_000;
const MAX_BADGE_TEXT = 24;
const MAX_BADGE_TOOLTIP = 200;
const MAX_MESSAGE = 2_000;
const MAX_BADGES_PER_CARD = 4;
const TONES = new Set<PluginCardTone>(["neutral", "info", "warn", "error"]);

/**
 * Card badges and actions (EP-7). A service with `cards:decorate` sets a short plain-text badge on any card and
 * declares actions shown on the cards its filter matches. An action calls the service and its answer is shown
 * as a toast on the card. No HTML anywhere: the window renders text only.
 */
export class PluginCards {
  private readonly deps: PluginCardsDependencies;
  /** Session id -> plugin id -> badge. */
  private readonly badges = new Map<string, Map<string, PluginCardBadge>>();

  constructor(deps: PluginCardsDependencies) {
    this.deps = deps;
  }

  /** `cards.setBadge` from a service: `badge` null removes this plugin's badge from the card. */
  setBadge(pluginId: string, params: unknown): null {
    const values = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
    const sessionId = values.sessionId;
    if (typeof sessionId !== "string" || !this.deps.session(sessionId)) throw new Error("No card has that session id.");
    if (values.badge === null || values.badge === undefined) {
      const perCard = this.badges.get(sessionId);
      if (perCard?.delete(pluginId)) {
        if (perCard.size === 0) this.badges.delete(sessionId);
        this.publish();
      }
      return null;
    }
    const badge = values.badge as Record<string, unknown>;
    if (typeof badge !== "object" || Array.isArray(badge)) throw new Error("badge must be an object or null.");
    const text = typeof badge.text === "string" ? oneLine(badge.text) : "";
    if (!text || text.length > MAX_BADGE_TEXT) throw new Error(`badge.text must be 1 to ${MAX_BADGE_TEXT} characters.`);
    const tone = badge.tone === undefined ? "neutral" : badge.tone;
    if (!TONES.has(tone as PluginCardTone)) throw new Error("badge.tone must be neutral, info, warn or error.");
    if (badge.tooltip !== undefined && (typeof badge.tooltip !== "string" || badge.tooltip.length > MAX_BADGE_TOOLTIP)) {
      throw new Error(`badge.tooltip must be text of at most ${MAX_BADGE_TOOLTIP} characters.`);
    }
    const perCard = this.badges.get(sessionId) ?? new Map<string, PluginCardBadge>();
    // Badges of plugins that are no longer trusted are hidden; they must not
    // keep a trusted plugin out of the card's slots.
    const trusted = this.deps.trustedPlugins();
    for (const owner of [...perCard.keys()]) {
      if (owner !== pluginId && !trusted.has(owner)) perCard.delete(owner);
    }
    if (!perCard.has(pluginId) && perCard.size >= MAX_BADGES_PER_CARD) throw new Error("This card already shows the most plugin badges.");
    perCard.set(pluginId, {
      pluginId,
      text: this.deps.redact(text),
      tone: tone as PluginCardTone,
      ...(typeof badge.tooltip === "string" && badge.tooltip ? { tooltip: this.deps.redact(oneLine(badge.tooltip)) } : {})
    });
    this.badges.set(sessionId, perCard);
    this.publish();
    return null;
  }

  forgetSession(sessionId: string): void {
    if (this.badges.delete(sessionId)) this.publish();
  }

  /** Trust or plugin changes: recompute what the window shows. */
  refresh(): void {
    this.publish();
  }

  decorations(): PluginCardDecorations {
    const trusted = this.deps.trustedPlugins();
    const badges: Record<string, PluginCardBadge[]> = {};
    for (const [sessionId, perCard] of this.badges) {
      const shown = [...perCard.values()].filter((badge) => trusted.has(badge.pluginId));
      if (shown.length) badges[sessionId] = structuredClone(shown);
    }
    return {
      badges,
      actions: this.providers().flatMap((provider) => provider.actions.map((action) => ({
        pluginId: provider.pluginId,
        pluginName: provider.pluginName,
        actionId: action.id,
        title: action.title,
        ...(action.when ? { when: structuredClone(action.when) } : {})
      })))
    };
  }

  /** The person chose an action on a card. Errors and timeouts come back as an error toast, nothing else. */
  async invoke(pluginId: string, actionId: string, sessionId: string, input?: unknown): Promise<PluginCardActionResult> {
    // Action ids are unique within a plugin, whichever of its services declares them.
    const provider = this.providers()
      .find((candidate) => candidate.pluginId === pluginId && candidate.actions.some((action) => action.id === actionId));
    const action = provider?.actions.find((candidate) => candidate.id === actionId);
    if (!provider || !action) throw new Error("That card action is not available.");
    const session = this.deps.session(sessionId);
    if (!session) throw new Error("No card has that session id.");
    if (!cardActionMatches(action.when, session)) throw new Error("That action does not apply to this card.");
    const timeoutMs = this.deps.timeoutMs ?? CARD_ACTION_TIMEOUT_MS;
    const normalizedInput = normalizeCardActionInput(input);
    const params: CardActionInvocation = { actionId, sessionId, session, ...(normalizedInput ? { input: normalizedInput } : {}) };
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = await Promise.race([
        this.deps.invokeWithConsent
          ? this.deps.invokeWithConsent(pluginId,actionId,sessionId,() => this.deps.call(pluginId, provider.serviceId, "canvastty.cards.invoke", params, timeoutMs))
          : this.deps.call(pluginId, provider.serviceId, "canvastty.cards.invoke", params, timeoutMs),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("The plugin did not answer in time.")), timeoutMs);
        })
      ]);
      const record = answer && typeof answer === "object" && !Array.isArray(answer) ? answer as Record<string, unknown> : {};
      const tone = TONES.has(record.tone as PluginCardTone) ? record.tone as PluginCardTone : "neutral";
      const message = typeof record.message === "string" && record.message.trim() ? this.message(record.message) : undefined;
      const actions = new Set(this.providers().filter(row => row.pluginId === pluginId).flatMap(row => row.actions.map(action => action.id)));
      const review = record.review === undefined ? undefined : normalizeCardReview(record.review, this.deps.redact, actions);
      return { tone, ...(message ? { message } : {}), ...(review ? { review } : {}) };
    } catch (error) {
      return { tone: "error", message: this.message(`${provider.pluginName}: ${error instanceof Error ? error.message : "the action failed."}`) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Plain lines only: control characters (escape sequences included) are dropped, newlines kept. */
  private message(text: string): string {
    // eslint-disable-next-line no-control-regex
    const redacted = this.deps.redact(text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, "").trim());
    return redacted.length <= MAX_MESSAGE ? redacted : `${redacted.slice(0, MAX_MESSAGE)}…`;
  }

  private providers(): CardActionProvider[] {
    try {
      return [...this.deps.providers()].sort((left, right) => left.pluginId.localeCompare(right.pluginId));
    } catch {
      return [];
    }
  }

  private publish(): void {
    this.deps.changed(this.decorations());
  }
}

function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001F\u007F]+/gu, " ").trim();
}
