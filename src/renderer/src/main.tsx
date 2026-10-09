import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import { App } from "./App";
import { markBootOnce } from "./lib/bootMarks";
import { handleUncaughtRenderError } from "./lib/uncaughtErrorRecovery";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/terminalSkins.css";
import "./styles/ornateTerminalSkins.css";
import "./styles/pixelTerminalSkins.css";
import "./styles/pixelSkinPackCreator.css";
import "./styles/mascots.css";
import "./styles/appSkins.css";
import "./styles/patterns.css";

const container = document.getElementById("root")!;
window.addEventListener("error", (event) => {
  try {
    window.canvasTTY.diagnostics.reportError({ kind: "window", message: event.message,
      stack: event.error instanceof Error ? event.error.stack : undefined });
  } catch { /* A failed bridge must not create another uncaught exception. */ }
});
window.addEventListener("unhandledrejection", (event) => {
  const error: unknown = event.reason;
  try {
    window.canvasTTY.diagnostics.reportError({ kind: "unhandled-rejection",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined });
  } catch { /* Keep the original rejection visible if reporting is unavailable. */ }
});
createRoot(container, {
  // React unmounts the whole tree on an uncaught render error while the renderer process lives on:
  // without this the window stays black and the main process has no crash to recover from.
  onUncaughtError: (error, errorInfo) => handleUncaughtRenderError(container, error, errorInfo.componentStack)
}).render(
  <StrictMode>
    <App />
  </StrictMode>
);
// The first paint after this initial render commits: the earliest point the window shows anything
// other than a blank/loading document.
requestAnimationFrame(() => requestAnimationFrame(() => markBootOnce("rendererFirstPaint")));
