// A small in-memory DOM that real react-dom can render into, so renderer components can be mounted,
// typed into and re-rendered in Node without a browser. It covers the node, attribute, style, focus
// and bubbling-event behavior React uses; layout, CSS and the rest of the platform are absent.
class MiniEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
    this.cancelable = init.cancelable ?? false;
    this.defaultPrevented = false;
    this.timeStamp = Date.now();
    this.isTrusted = true;
    this.target = null;
    this.currentTarget = null;
    this.eventPhase = 0;
    this.propagationStopped = false;
    Object.assign(this, init);
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
  stopImmediatePropagation() { this.propagationStopped = true; }
}

class MiniNode {
  constructor(document, nodeType, nodeName) {
    this.ownerDocument = document;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.parentNode = null;
    this.childNodes = [];
    this.listeners = new Map();
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get nextSibling() {
    const siblings = this.parentNode?.childNodes;
    return siblings ? siblings[siblings.indexOf(this) + 1] ?? null : null;
  }
  get textContent() { return this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (value !== "" && value != null) this.appendChild(this.ownerDocument.createTextNode(String(value)));
  }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, reference) {
    child.parentNode?.removeChild(child);
    const index = reference ? this.childNodes.indexOf(reference) : -1;
    if (index < 0) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    if (this.ownerDocument.activeElement && !this.ownerDocument.body.contains(this.ownerDocument.activeElement)) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
    return child;
  }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }
  addEventListener(type, listener, options) {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const key = `${type}:${capture}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(listener);
  }
  removeEventListener(type, listener, options) {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    this.listeners.get(`${type}:${capture}`)?.delete(listener);
  }
  dispatchEvent(event) {
    event.target = this;
    const path = [];
    for (let current = this; current; current = current.parentNode ?? (current.nodeType === 9 ? null : null)) path.push(current);
    const invoke = (node, capture) => {
      event.currentTarget = node;
      for (const listener of [...(node.listeners.get(`${event.type}:${capture}`) ?? [])]) {
        if (typeof listener === "function") listener.call(node, event);
        else listener.handleEvent(event);
      }
    };
    for (const node of [...path].reverse()) { if (event.propagationStopped) break; invoke(node, true); }
    for (const node of path) {
      if (event.propagationStopped || (!event.bubbles && node !== this)) break;
      invoke(node, false);
    }
    event.currentTarget = null;
    return !event.defaultPrevented;
  }
}

class MiniText extends MiniNode {
  constructor(document, data) { super(document, 3, "#text"); this.data = data; }
  get nodeValue() { return this.data; }
  set nodeValue(value) { this.data = String(value); }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
}

class MiniElement extends MiniNode {
  constructor(document, tagName, namespaceURI) {
    super(document, 1, tagName.toUpperCase());
    this.tagName = tagName.toUpperCase();
    this.localName = tagName.toLowerCase();
    this.namespaceURI = namespaceURI ?? "http://www.w3.org/1999/xhtml";
    this.attributes = new Map();
    const style = {};
    style.setProperty = (name, value) => { style[name] = value; };
    style.removeProperty = (name) => { delete style[name]; };
    this.style = style;
    this.value = "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  setAttributeNS(_namespace, name, value) { this.setAttribute(name, value); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  removeAttributeNS(_namespace, name) { this.removeAttribute(name); }
  get className() { return this.getAttribute("class") ?? ""; }
  /** `data-*` attributes by their camelCase names, as `element.dataset` reads them. */
  get dataset() {
    const attribute = (name) => `data-${String(name).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    return new Proxy({}, {
      get: (_target, name) => this.getAttribute(attribute(name)) ?? undefined,
      set: (_target, name, value) => { this.setAttribute(attribute(name), value); return true; },
      has: (_target, name) => this.hasAttribute(attribute(name))
    });
  }
  focus() {
    const document = this.ownerDocument;
    if (document.activeElement === this) return;
    const previous = document.activeElement;
    document.activeElement = this;
    previous?.dispatchEvent?.(new MiniEvent("focusout", { bubbles: true, relatedTarget: this }));
    this.dispatchEvent(new MiniEvent("focusin", { bubbles: true, relatedTarget: previous }));
  }
  blur() {
    const document = this.ownerDocument;
    if (document.activeElement !== this) return;
    document.activeElement = document.body;
    this.dispatchEvent(new MiniEvent("focusout", { bubbles: true }));
  }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  querySelectorAll(selector) {
    const found = [];
    const matches = miniSelector(selector);
    const walk = (node) => { for (const child of node.childNodes) { if (child.nodeType === 1) { if (matches(child)) found.push(child); walk(child); } } };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) {
    const matches = miniSelector(selector);
    for (let current = this; current && current.nodeType === 1; current = current.parentNode) if (matches(current)) return current;
    return null;
  }
}

/** One compound selector: a tag name, `.class`, `[attribute]` and `[attribute="value"]`, which is all the tests need. */
function miniSelector(selector) {
  const tag = /^[a-z]+/i.exec(selector)?.[0]?.toUpperCase();
  const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
  const attributes = [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map((match) => [match[1], match[2]]);
  return (element) => (!tag || element.tagName === tag)
    && classes.every((name) => element.className.split(/\s+/).includes(name))
    && attributes.every(([name, value]) => value === undefined ? element.hasAttribute(name) : element.getAttribute(name) === value);
}

/** Installs a fresh document and window on globalThis; returns the document and a restore function. */
export function installMiniDom() {
  // Node's own Event, EventTarget and MessageEvent stay untouched: its message ports depend on them.
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLIFrameElement", "IS_REACT_ACT_ENVIRONMENT",
    "addEventListener", "removeEventListener", "dispatchEvent", "getSelection"];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const document = new MiniNode(null, 9, "#document");
  document.ownerDocument = document;
  document.createElement = (tag) => new MiniElement(document, tag);
  document.createElementNS = (namespace, tag) => new MiniElement(document, tag, namespace);
  document.createTextNode = (data) => new MiniText(document, String(data));
  document.createComment = (data) => Object.assign(new MiniNode(document, 8, "#comment"), { data });
  document.documentElement = document.createElement("html");
  document.appendChild(document.documentElement);
  document.body = document.createElement("body");
  document.documentElement.appendChild(document.body);
  document.activeElement = document.body;
  // React feature-detects native input events with `"oninput" in document`.
  for (const name of ["oninput", "onchange", "onscroll", "onscrollend"]) document[name] = null;
  document.hidden = false;
  document.visibilityState = "visible";
  const window = globalThis;
  document.defaultView = window;
  const define = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  define("document", document);
  define("navigator", { userAgent: "node" });
  define("HTMLElement", MiniElement);
  define("HTMLIFrameElement", class HTMLIFrameElement extends MiniElement {});
  define("addEventListener", () => undefined);
  define("removeEventListener", () => undefined);
  define("dispatchEvent", () => true);
  const selection = { rangeCount: 0, anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0,
    removeAllRanges() {}, addRange() {}, extend() {} };
  define("getSelection", () => selection);
  define("IS_REACT_ACT_ENVIRONMENT", true);
  if (!("window" in globalThis) || globalThis.window !== globalThis) define("window", globalThis);
  const restore = () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
  return { document, restore };
}

/** Dispatches a bubbling, cancelable event of `type` with extra fields on `target`. */
export function fire(target, type, fields = {}) {
  return target.dispatchEvent(new MiniEvent(type, { bubbles: true, cancelable: true, ...fields }));
}

/** Types `text` the way a textarea reports it: the value changes, then an input event bubbles. */
export function typeInto(field, text) {
  field.value = text;
  return fire(field, "input", { data: text, inputType: "insertText" });
}
