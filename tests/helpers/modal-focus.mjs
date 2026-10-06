import { findAll } from "./fake-react.mjs";

export function modalFixture(t, Component, props, { __render, __flush, __unmount }) {
  const saved = { window: globalThis.window, HTMLElement: globalThis.HTMLElement };
  const listeners = new Map();
  const doc = {
    activeElement: null,
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? new Set();
      entries.add(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, event) { for (const listener of listeners.get(type) ?? []) listener(event); }
  };
  class Element {
    constructor(key, props = {}) {
      this.key = key;
      this.ownerDocument = doc;
      this.isConnected = true;
      this.update(props);
    }
    update(props) {
      this.disabled = Boolean(props.disabled);
      this.hidden = Boolean(props.hidden);
      this.tabIndex = props.tabIndex ?? 0;
    }
    focus() {
      doc.activeElement = this;
      doc.dispatch("focusin", { target: this });
    }
    matches() { return this.disabled; }
    closest() { return this.hidden ? this : null; }
    getClientRects() { return this.hidden ? [] : [{}]; }
  }
  globalThis.HTMLElement = Element;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout };
  const trigger = new Element("trigger");
  const root = new Element("dialog", { tabIndex: -1 });
  root.controls = [];
  root.contains = (element) => element === root || root.controls.includes(element);
  root.querySelectorAll = () => root.controls;
  doc.body = new Element("body");
  doc.activeElement = trigger;
  const render = () => {
    const tree = __render(() => {
      const tree = Component(props);
      const section = findAll(tree, (node) => node.props?.role === "dialog")[0];
      if (section.props.ref) section.props.ref.current = root;
      root.controls = findAll(section, (node) => node !== section
        && (["button", "input", "select", "textarea"].includes(node.type) || node.props?.tabIndex !== undefined
          || (node.type === "a" && node.props?.href) || node.props?.contentEditable === true)).map((node, index) => {
        const element = root.controls[index] ?? new Element(`${node.type}:${index}`);
        element.update(node.props);
        return element;
      });
      return tree;
    });
    __flush();
    return tree;
  };
  t.after(() => {
    __unmount();
    globalThis.window = saved.window;
    globalThis.HTMLElement = saved.HTMLElement;
  });
  const key = (value, shiftKey = false) => {
    const event = { key: value, shiftKey, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    doc.dispatch("keydown", event);
    return event;
  };
  return { doc, root, trigger, render, key };
}
