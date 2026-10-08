import type { Event, Input, WebContents } from "electron";
import type {
  CanvasNavigationMouseButton,
  CanvasNavigationPointerBindingInput
} from "../../shared/contracts.ts";
import {
  canvasNavigationMouseButtonFromElectronButton,
  canvasNavigationModifierFromKey,
  isCanvasNavigationModifierActive,
  isCanvasNavigationBindingActive,
  isCanvasNavigationBindingKey,
  isCanvasNavigationBindingMouseButton,
  isCanvasNavigationMouseButton,
  normalizeCanvasNavigationInputKey,
  parseCanvasNavigationBinding
} from "../../shared/canvasNavigation.ts";

export interface CanvasNavigationKeyboardInput {
  type: "keyDown" | "keyUp";
  key: string;
  code?: string;
  alt: boolean;
  control: boolean;
  meta: boolean;
  shift: boolean;
}

export interface CanvasNavigationOverrideTransition {
  active: boolean;
  changed: boolean;
  reserved: boolean;
}

export interface CanvasNavigationBindings {
  wheelBinding: string | null;
  navigationBinding: string | null;
}

export interface CanvasNavigationOverrideState {
  wheelActive: boolean;
  navigationActive: boolean;
}

export interface CanvasNavigationInputAttachmentOptions {
  preventMouseBindings?: boolean;
  captureMacEditShortcuts?: boolean;
}

export function shouldPreventCanvasNavigationInput(
  input: Pick<CanvasNavigationKeyboardInput, "key">,
  transition: CanvasNavigationOverrideTransition
): boolean {
  return transition.reserved && canvasNavigationModifierFromKey(input.key) === null;
}

export class CanvasNavigationOverrideTracker {
  private binding: string | null;
  private suspended = false;
  private isActive = false;
  private readonly pressedKeys = new Set<string>();
  private readonly pressedMouseButtons = new Set<CanvasNavigationMouseButton>();
  private modifiers = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

  constructor(binding: string | null) {
    this.binding = binding;
  }

  get active(): boolean {
    return this.isActive;
  }

  get shouldCaptureMenuShortcuts(): boolean {
    const parsed = parseCanvasNavigationBinding(this.binding);
    if (!parsed || !parsed.modifiers.every((modifier) => isCanvasNavigationModifierActive(this.modifiers, modifier))) {
      return false;
    }
    if (parsed.key !== null && isCanvasNavigationMouseButton(parsed.key)) return false;
    return parsed.key !== null || parsed.modifiers.includes("Alt");
  }

  setBinding(binding: string | null): CanvasNavigationOverrideTransition {
    this.binding = binding;
    return this.clearState();
  }

  setSuspended(suspended: boolean): CanvasNavigationOverrideTransition {
    this.suspended = suspended;
    return this.clearState();
  }

  update(input: CanvasNavigationKeyboardInput): CanvasNavigationOverrideTransition {
    if (this.suspended) return { active: false, changed: false, reserved: false };
    const previous = this.isActive;
    const modifier = canvasNavigationModifierFromKey(input.key);
    this.modifiers = {
      altKey: input.alt,
      ctrlKey: input.control,
      metaKey: input.meta,
      shiftKey: input.shift
    };
    if (modifier !== null) {
      const pressed = input.type === "keyDown";
      if (modifier === "Alt") this.modifiers.altKey = pressed;
      else if (modifier === "Ctrl") this.modifiers.ctrlKey = pressed;
      else if (modifier === "Meta") this.modifiers.metaKey = pressed;
      else this.modifiers.shiftKey = pressed;
    }
    const key = normalizeCanvasNavigationInputKey(input.key, input.code);
    let reserved = modifier !== null && isCanvasNavigationBindingKey(input.key, this.binding);
    if (modifier === null && key && isCanvasNavigationBindingKey(key, this.binding)) {
      if (input.type === "keyDown") {
        const alreadyOwned = this.pressedKeys.has(key);
        const completesBinding = isCanvasNavigationBindingActive({
          ...this.modifiers,
          pressedKeys: new Set([key]),
          pressedMouseButtons: this.pressedMouseButtons
        }, this.binding);
        if (alreadyOwned || completesBinding) {
          this.pressedKeys.add(key);
          reserved = true;
        }
      } else {
        reserved = this.pressedKeys.delete(key);
      }
    }
    this.isActive = isCanvasNavigationBindingActive({
      ...this.modifiers,
      pressedKeys: this.pressedKeys,
      pressedMouseButtons: this.pressedMouseButtons
    }, this.binding);
    return {
      active: this.isActive,
      changed: previous !== this.isActive,
      reserved
    };
  }

  updatePointer(input: CanvasNavigationPointerBindingInput): CanvasNavigationOverrideTransition {
    if (this.suspended) return { active: false, changed: false, reserved: false };
    const previous = this.isActive;
    this.modifiers = {
      altKey: input.altKey,
      ctrlKey: input.ctrlKey,
      metaKey: input.metaKey,
      shiftKey: input.shiftKey
    };
    let reserved = false;
    if (isCanvasNavigationBindingMouseButton(input.button, this.binding)) {
      if (input.pressed) {
        const alreadyOwned = this.pressedMouseButtons.has(input.button);
        const completesBinding = isCanvasNavigationBindingActive({
          ...this.modifiers,
          pressedKeys: this.pressedKeys,
          pressedMouseButtons: new Set([input.button])
        }, this.binding);
        if (alreadyOwned || completesBinding) {
          this.pressedMouseButtons.add(input.button);
          reserved = true;
        }
      } else {
        reserved = this.pressedMouseButtons.delete(input.button);
      }
    }
    this.isActive = isCanvasNavigationBindingActive({
      ...this.modifiers,
      pressedKeys: this.pressedKeys,
      pressedMouseButtons: this.pressedMouseButtons
    }, this.binding);
    return {
      active: this.isActive,
      changed: previous !== this.isActive,
      reserved
    };
  }

  ownsMouseButton(button: CanvasNavigationMouseButton): boolean {
    return this.isActive
      && this.pressedMouseButtons.has(button)
      && isCanvasNavigationBindingMouseButton(button, this.binding);
  }

  reset(): CanvasNavigationOverrideTransition {
    return this.clearState();
  }

  private clearState(): CanvasNavigationOverrideTransition {
    const changed = this.isActive;
    this.isActive = false;
    this.pressedKeys.clear();
    this.pressedMouseButtons.clear();
    this.modifiers = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    return { active: false, changed, reserved: false };
  }

}

export class CanvasNavigationInputController {
  private readonly wheelTracker: CanvasNavigationOverrideTracker;
  private readonly navigationTracker: CanvasNavigationOverrideTracker;
  private readonly attachedContents = new Set<WebContents>();
  private readonly onActiveChange: (state: CanvasNavigationOverrideState) => void;
  private menuShortcutContents: WebContents | null = null;
  /** Contents whose renderer reported keyboard focus in a terminal surface or shortcut recorder. */
  private readonly terminalEditFocus = new WeakSet<WebContents>();

  constructor(
    bindings: CanvasNavigationBindings,
    onActiveChange: (state: CanvasNavigationOverrideState) => void
  ) {
    this.wheelTracker = new CanvasNavigationOverrideTracker(bindings.wheelBinding);
    this.navigationTracker = new CanvasNavigationOverrideTracker(bindings.navigationBinding);
    this.onActiveChange = onActiveChange;
  }

  get active(): boolean {
    return this.navigationTracker.active;
  }

  get wheelActive(): boolean {
    return this.wheelTracker.active;
  }

  attach(contents: WebContents, options: CanvasNavigationInputAttachmentOptions = {}): void {
    if (this.attachedContents.has(contents)) return;
    this.attachedContents.add(contents);
    contents.on("before-input-event", (event, input) => this.handleInput(contents, event, input, options));
    contents.on("before-mouse-event", (event, input) => {
      const transition = this.handleMouseInput(input);
      if (options.preventMouseBindings !== false && transition.reserved) event.preventDefault();
    });
    contents.once("destroyed", () => {
      this.attachedContents.delete(contents);
      if (this.menuShortcutContents === contents) this.menuShortcutContents = null;
      this.resetTrackers();
    });
  }

  /**
   * The renderer reports whether a terminal surface or shortcut recorder has keyboard focus. Both consume
   * Command+C/V/A themselves, so those shortcuts bypass the Edit menu. The terminal-named API covers both;
   * ordinary fields and plugin pages keep the menu's native Copy, Paste and Select All.
   */
  setTerminalEditFocus(contents: WebContents, focused: boolean): void {
    if (focused) this.terminalEditFocus.add(contents);
    else {
      this.terminalEditFocus.delete(contents);
      if (this.menuShortcutContents === contents) this.releaseMenuShortcuts();
    }
  }

  setBindings(bindings: CanvasNavigationBindings): void {
    this.releaseMenuShortcuts();
    const previous = this.state();
    this.wheelTracker.setBinding(bindings.wheelBinding);
    this.navigationTracker.setBinding(bindings.navigationBinding);
    this.emitIfChanged(previous);
  }

  setShortcutCaptureActive(active: boolean): void {
    this.releaseMenuShortcuts();
    const previous = this.state();
    this.wheelTracker.setSuspended(active);
    this.navigationTracker.setSuspended(active);
    this.emitIfChanged(previous);
  }

  reset(): void {
    this.releaseMenuShortcuts();
    this.resetTrackers();
  }

  updatePointerBinding(input: CanvasNavigationPointerBindingInput): CanvasNavigationOverrideTransition {
    const previous = this.state();
    const wheelTransition = this.wheelTracker.updatePointer(input);
    const navigationTransition = this.navigationTracker.updatePointer(input);
    this.emitIfChanged(previous);
    return {
      active: wheelTransition.active || navigationTransition.active,
      changed: wheelTransition.changed || navigationTransition.changed,
      reserved: wheelTransition.reserved || navigationTransition.reserved
    };
  }

  ownsNavigationMouseButton(button: string | undefined): boolean {
    const normalized = canvasNavigationMouseButtonFromElectronButton(button);
    return normalized !== null && this.navigationTracker.ownsMouseButton(normalized);
  }

  ownsAnyMouseButton(button: string | undefined): boolean {
    const normalized = canvasNavigationMouseButtonFromElectronButton(button);
    return normalized !== null && (
      this.wheelTracker.ownsMouseButton(normalized)
      || this.navigationTracker.ownsMouseButton(normalized)
    );
  }

  private handleInput(
    contents: WebContents,
    event: Event,
    input: Input,
    options: CanvasNavigationInputAttachmentOptions
  ): void {
    if (input.type !== "keyDown" && input.type !== "keyUp") return;
    const keyboardInput = {
      type: input.type,
      key: input.key,
      code: input.code,
      alt: input.alt,
      control: input.control,
      meta: input.meta,
      shift: input.shift
    } satisfies CanvasNavigationKeyboardInput;
    const previous = this.state();
    const wheelTransition = this.wheelTracker.update(keyboardInput);
    const navigationTransition = this.navigationTracker.update(keyboardInput);
    const macEditShortcut = options.captureMacEditShortcuts === true
      && this.terminalEditFocus.has(contents) && topFrameFocused(contents)
      && input.type === "keyDown"
      && input.meta && !input.control && !input.alt && !input.shift
      && (input.code === "KeyA" || input.code === "KeyC" || input.code === "KeyV");
    const shouldCaptureMenuShortcuts = this.wheelTracker.shouldCaptureMenuShortcuts
      || this.navigationTracker.shouldCaptureMenuShortcuts
      || macEditShortcut;
    this.setMenuShortcutCapture(contents, shouldCaptureMenuShortcuts);
    const shouldPrevent = shouldPreventCanvasNavigationInput(input, {
      active: wheelTransition.active || navigationTransition.active,
      changed: wheelTransition.changed || navigationTransition.changed,
      reserved: wheelTransition.reserved || navigationTransition.reserved
    });
    if (shouldPrevent) event.preventDefault();
    this.emitIfChanged(previous);
  }

  private handleMouseInput(input: Electron.MouseInputEvent): CanvasNavigationOverrideTransition {
    if (input.type !== "mouseDown" && input.type !== "mouseUp") {
      return { active: this.active || this.wheelActive, changed: false, reserved: false };
    }
    const button = canvasNavigationMouseButtonFromElectronButton(input.button as string | undefined);
    if (button === null) {
      return { active: this.active || this.wheelActive, changed: false, reserved: false };
    }
    const modifiers = new Set(input.modifiers ?? []);
    return this.updatePointerBinding({
      button,
      pressed: input.type === "mouseDown",
      altKey: modifiers.has("alt"),
      ctrlKey: modifiers.has("control") || modifiers.has("ctrl"),
      metaKey: modifiers.has("meta") || modifiers.has("command") || modifiers.has("cmd"),
      shiftKey: modifiers.has("shift")
    });
  }

  private releaseMenuShortcuts(): void {
    if (this.menuShortcutContents && !this.menuShortcutContents.isDestroyed()) {
      this.menuShortcutContents.setIgnoreMenuShortcuts(false);
    }
    this.menuShortcutContents = null;
  }

  private setMenuShortcutCapture(contents: WebContents, active: boolean): void {
    if (this.menuShortcutContents !== contents) this.releaseMenuShortcuts();
    if (active) {
      if (this.menuShortcutContents !== contents) contents.setIgnoreMenuShortcuts(true);
      this.menuShortcutContents = contents;
    } else if (this.menuShortcutContents === contents) {
      this.releaseMenuShortcuts();
    }
  }

  private state(): CanvasNavigationOverrideState {
    return {
      wheelActive: this.wheelTracker.active,
      navigationActive: this.navigationTracker.active
    };
  }

  private resetTrackers(): void {
    const previous = this.state();
    this.wheelTracker.reset();
    this.navigationTracker.reset();
    this.emitIfChanged(previous);
  }

  private emitIfChanged(previous: CanvasNavigationOverrideState): void {
    const current = this.state();
    if (current.wheelActive !== previous.wheelActive
      || current.navigationActive !== previous.navigationActive) {
      this.onActiveChange(current);
    }
  }

}

/** An iframe (a plugin page) with focus is never a terminal surface; contents without the property count as top. */
function topFrameFocused(contents: WebContents): boolean {
  const focused = (contents as { focusedFrame?: unknown }).focusedFrame;
  const top = (contents as { mainFrame?: unknown }).mainFrame;
  return focused === undefined || focused === null || top === undefined || focused === top;
}
