import type { Terminal } from "@xterm/xterm";

interface Renderer {
  dispose(): void;
  handleResize(cols: number, rows: number): void;
  handleDevicePixelRatioChange(): void;
  handleFocus(): void;
  handleBlur(): void;
  renderRows(start: number, end: number): void;
  _handleOptionsChanged(): void;
  _handleColorChange?: () => void;
  _injectCss?: (...args: unknown[]) => void;
  _rowContainer?: HTMLElement;
  _selectionContainer?: HTMLElement;
  _canvas?: HTMLCanvasElement;
  _renderLayers?: { _canvas: HTMLCanvasElement }[];
  _widthCache?: {
    _flat: Float32Array;
    _holey: Map<string, number>;
    _container: HTMLElement;
    _measureElements: HTMLElement[];
  };
}

interface RenderService {
  _renderer: { value: Renderer };
  _needsSelectionRefresh: boolean;
  setRenderer(renderer: Renderer): void;
  refreshRows(start: number, end: number): void;
}

interface CachedRenderer {
  renderer: Renderer;
  dispose: () => void;
  options: Renderer["_handleOptionsChanged"];
  colors: Renderer["_handleColorChange"];
  css: Renderer["_injectCss"];
  rows: Renderer["renderRows"];
  elements: { element: HTMLElement; visibility: string }[];
  dpr: number;
}

/** Batch xterm's exact DOM measurements before a resumed renderer rebuilds its rows. */
function warmWidths(renderer: Renderer, terminal: Terminal): void {
  const cache = renderer._widthCache;
  if (!cache?._container || cache._measureElements?.length !== 4 || !cache._flat || !cache._holey) return;
  const pending = new Map<string, { flat: number; element: HTMLElement }>();
  const buffer = terminal.buffer.active;
  for (let y = buffer.viewportY; y < buffer.viewportY + terminal.rows; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    for (let x = 0; x < Math.min(line.length, terminal.cols); x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      const text = cell.getChars();
      if (!text) continue;
      const bold = Boolean(cell.isBold()), italic = Boolean(cell.isItalic());
      const variant = Number(bold) + 2 * Number(italic);
      const flat = variant === 0 && text.length === 1 && text.charCodeAt(0) < cache._flat.length ? text.charCodeAt(0) : -1;
      const key = text + (bold ? "B" : "") + (italic ? "I" : "");
      if (pending.has(key) || (flat >= 0 ? cache._flat[flat] !== -9999 : cache._holey.has(key))) continue;
      const element = cache._measureElements[variant].cloneNode(false) as HTMLElement;
      element.textContent = text.repeat(32);
      pending.set(key, { flat, element });
    }
  }
  if (pending.size === 0) return;
  const fragment = cache._container.ownerDocument.createDocumentFragment();
  for (const { element } of pending.values()) fragment.append(element);
  cache._container.append(fragment);
  try {
    for (const [key, { flat, element }] of pending) {
      const width = element.offsetWidth / 32;
      if (width <= 0) continue;
      if (flat >= 0) cache._flat[flat] = width;
      else cache._holey.set(key, width);
    }
  } finally {
    for (const { element } of pending.values()) element.remove();
  }
}

/** Keep xterm 6's DOM renderer and a leased WebGL renderer warm without changing their drawing. */
export function cacheTerminalRenderers(terminal: Terminal): {
  dom(): void;
  webgl(addon: unknown): void;
  release(addon: unknown): void;
  dispose(): void;
} | null {
  const core = (terminal as Terminal & { _core?: {
    _createRenderer(): Renderer;
    _renderService: RenderService;
  } })._core;
  const service = core?._renderService;
  const dom = service?._renderer?.value;
  if (!core || !service || !dom?._rowContainer || !dom._selectionContainer
    || typeof core._createRenderer !== "function" || typeof service.setRenderer !== "function"
    || typeof service.refreshRows !== "function" || typeof dom._handleOptionsChanged !== "function"
    || typeof dom.renderRows !== "function") return null;
  const createRenderer = core._createRenderer;
  const setRenderer = service.setRenderer;
  const entries = new Map<Renderer, CachedRenderer>();
  let active = dom;
  const pixelRatio = (): number => terminal.element?.ownerDocument.defaultView?.devicePixelRatio ?? 1;
  const retain = (renderer: Renderer): CachedRenderer => {
    const existing = entries.get(renderer);
    if (existing) return existing;
    const elements = [renderer._rowContainer, renderer._selectionContainer, renderer._canvas,
      ...(renderer._renderLayers?.map((layer) => layer._canvas) ?? [])]
      .filter((element): element is HTMLElement => Boolean(element))
      .map((element) => ({ element, visibility: element.style.visibility }));
    const entry = { renderer, dispose: renderer.dispose, options: renderer._handleOptionsChanged,
      colors: renderer._handleColorChange, css: renderer._injectCss, rows: renderer.renderRows, elements, dpr: pixelRatio() };
    entries.set(renderer, entry);
    renderer.dispose = () => {
      renderer.handleBlur();
      for (const { element } of elements) {
        element.style.visibility = "hidden";
        element.setAttribute("data-renderer-parked", "true");
      }
    };
    // Parked renderers must not change the active screen's dimensions or redraw its cursor.
    renderer._handleOptionsChanged = () => { if (active === renderer) entry.options.call(renderer); };
    renderer.renderRows = (start, end) => { if (active === renderer) entry.rows.call(renderer, start, end); };
    if (entry.colors) renderer._handleColorChange = () => { if (active === renderer) entry.colors!.call(renderer); };
    if (entry.css) renderer._injectCss = (...args) => { if (active === renderer) entry.css!.apply(renderer, args); };
    return entry;
  };
  const restore = (entry: CachedRenderer): void => {
    const { renderer } = entry;
    renderer.dispose = entry.dispose;
    renderer._handleOptionsChanged = entry.options;
    renderer.renderRows = entry.rows;
    if (entry.colors) renderer._handleColorChange = entry.colors;
    if (entry.css) renderer._injectCss = entry.css;
    for (const { element, visibility } of entry.elements) {
      element.style.visibility = visibility;
      element.removeAttribute("data-renderer-parked");
    }
  };
  retain(dom);
  const switchRenderer = (renderer: Renderer): void => {
    if (active === renderer) return;
    const cached = entries.has(renderer);
    const entry = retain(renderer);
    active = renderer;
    if (cached) {
      // setRenderer subscribes on every call; cached renderers already have that subscription.
      service._renderer.value = renderer;
      service._needsSelectionRefresh = true;
      entry.options.call(renderer);
      if (entry.dpr !== pixelRatio()) {
        entry.dpr = pixelRatio();
        renderer.handleDevicePixelRatioChange();
      }
      warmWidths(renderer, terminal);
      renderer.handleResize(terminal.cols, terminal.rows);
      service.refreshRows(0, terminal.rows - 1);
    } else {
      setRenderer.call(service, renderer);
    }
    for (const { element, visibility } of entry.elements) {
      element.style.visibility = visibility;
      element.removeAttribute("data-renderer-parked");
    }
    if (terminal.textarea === terminal.element?.ownerDocument.activeElement) renderer.handleFocus();
    else renderer.handleBlur();
  };
  const cachedFactory = (): Renderer => dom;
  core._createRenderer = cachedFactory;
  service.setRenderer = switchRenderer;
  const addonRenderer = (addon: unknown): Renderer | undefined => (addon as { _renderer?: Renderer } | null)?._renderer;
  return {
    dom: () => switchRenderer(dom),
    webgl(addon) {
      const renderer = addonRenderer(addon);
      if (renderer) switchRenderer(renderer);
    },
    release(addon) {
      const renderer = addonRenderer(addon);
      const entry = renderer && entries.get(renderer);
      if (entry) { restore(entry); entries.delete(entry.renderer); }
    },
    dispose() {
      if (core._createRenderer === cachedFactory) core._createRenderer = createRenderer;
      if (service.setRenderer === switchRenderer) service.setRenderer = setRenderer;
      for (const entry of entries.values()) {
        restore(entry);
        if (entry.renderer !== active) entry.dispose.call(entry.renderer);
      }
      entries.clear();
    }
  };
}
