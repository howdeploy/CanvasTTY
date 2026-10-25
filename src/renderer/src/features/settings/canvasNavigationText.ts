import type { LocaleId } from "../../../../shared/contracts";

// The canvas wheel and navigation settings' text. Only Settings shows it, so it lives here, in the lazily loaded
// Settings chunk, rather than in the startup string table.
const CANVAS_NAVIGATION_TEXT = {
  ru: {
    canvasWheelCapture: "Перехват колеса и жеста масштаба над виджетами",
    canvasWheelCaptureDescription: "«Выключено» оставляет обычную прокрутку колесом и жест масштаба виджету с фокусом ввода, включая открытую страницу браузера. «Включено», а также «По комбинации» при нажатой комбинации, передают их канвасу; жест масштаба и Ctrl/Command + прокрутка над браузером всегда масштабируют канвас. Клики и перетаскивание не перехватываются.",
    canvasWheelCaptureKey: "По комбинации",
    canvasWheelOverride: "Комбинация для колеса и жеста масштаба",
    canvasOverrideBindingsMatch: "Комбинации совпадают: полный перехват имеет приоритет и также забирает перетаскивание.",
    canvasNavigationOverrideDescription: "Пока комбинация или кнопка мыши удерживается, прокрутка колесом, жест масштаба и перетаскивание над любым виджетом принадлежат канвасу. Перетаскивание с нажатым колёсиком работает всегда."
  },
  en: {
    canvasWheelCapture: "Wheel/pinch capture over widgets",
    canvasWheelCaptureDescription: "Off leaves plain wheel/pinch with the focused input widget, including a live Browser page. On and an active binding route it to the canvas; Browser pinch and Ctrl/Command + scroll always zoom the canvas. Clicks and drag are not captured.",
    canvasWheelCaptureKey: "Key",
    canvasWheelOverride: "Wheel/pinch shortcut",
    canvasOverrideBindingsMatch: "The shortcuts match: full navigation takes priority and also captures drag.",
    canvasNavigationOverrideDescription: "While the shortcut or mouse button is held, wheel, pinch, and drag over every widget belong to the canvas. Middle-button drag always pans."
  }
} satisfies Record<LocaleId, Record<string, string>>;

export type CanvasNavigationTextKey = keyof typeof CANVAS_NAVIGATION_TEXT.en;

export function canvasNavigationText(locale: LocaleId, key: CanvasNavigationTextKey): string {
  return CANVAS_NAVIGATION_TEXT[locale === "ru" ? "ru" : "en"][key];
}
