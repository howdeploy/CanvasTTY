import { CANVAS_LAUNCHER_ITEMS, PROVIDER_LABELS } from "../../../src/shared/providerCatalog.ts";

// Codex and Terminal retain their existing direct OS menu actions.
export const MORE_AGENTS = CANVAS_LAUNCHER_ITEMS
  .filter(provider => provider !== "terminal" && provider !== "codex")
  .map(provider => ({ provider, label: PROVIDER_LABELS[provider] }));
