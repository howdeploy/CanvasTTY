import { preloadedSurface } from "../../lib/preloadedSurface";

// The card dialogs exist only while they are open, so their code (and their texts) is not part of the startup bundle:
// App preloads it once it is idle, and an open before that loads its chunk at once.
export const pluginReviewHostSurface = preloadedSurface(() => import("./PluginChangesReviewDialog").then((module) => module.PluginReviewHost));
export const checkpointsHostSurface = preloadedSurface(() => import("./CheckpointsDialog").then((module) => module.CheckpointsHost));
