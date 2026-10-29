import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BrowserSnapshot } from "../../shared/contracts";
import { BrowserCard } from "./features/browser/BrowserCard";
import { fixedCameraStore } from "./features/workspace/cameraStore";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/browserWindow.css";
const camera = fixedCameraStore({ x: 0, y: 0, zoom: 1 });
function BrowserWindowApp(): React.JSX.Element {
  const [browser, setBrowser] = useState<BrowserSnapshot | null>(null);
  const [size, setSize] = useState({ width: innerWidth, height: innerHeight });
  const [error, setError] = useState("");
  useEffect(() => {
    const off = window.canvasTTY.browser.onState(({ snapshot }) => setBrowser(snapshot));
    void window.canvasTTY.browser.getState().then(setBrowser).catch((error) => setError(String(error)));
    const resize = (): void => setSize({ width: innerWidth, height: innerHeight });
    window.addEventListener("resize", resize);
    return () => { off(); window.removeEventListener("resize", resize); };
  }, []);
  const locale = navigator.language.startsWith("ru") ? "ru" : "en";
  return <main className="standalone-browser">
    {browser && <BrowserCard browser={browser} bounds={{ position: { x: 0, y: 0 }, size }} locale={locale}
      camera={camera} visible={true} stackIndex={1} uiScale={1} snapEnabled={false}
      focusActivation="single" focused={false} selected={false} showAgentPresence={false}
      getSnapTargets={() => []} onBoundsChange={() => {}} onActivate={() => window.canvasTTY.browser.focus()}
      onSelect={() => {}} onWidgetFocus={() => {}} onWidgetHoverChange={() => {}}
      onClose={() => window.close()} onError={setError} />}
    {error && <button className="standalone-browser__error" onClick={() => setError("")}>{error}</button>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<BrowserWindowApp />);
