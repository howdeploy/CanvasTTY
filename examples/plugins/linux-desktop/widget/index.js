const host = window.CanvasTTYPlugin;
const ui = Object.fromEntries(["toolbar", "windows", "window-label", "window-value", "window-options", "empty-title", "refresh", "attach", "detach", "status", "message", "error"].map(id => [id, document.getElementById(id)]));
const messages = {
  en: { label: "Application window", title: "Your application on the canvas", refresh: "Refresh", attach: "Embed window", detach: "Detach", ready: "Choose a window to embed", attached: "Embedded · mouse and keyboard available", busy: "Loading…",
    hint: "Open an application using X11 or XWayland, then refresh the list. Detach returns the window to your desktop and keeps the application running.",
    missing: "No eligible X11 windows found.", unsupported: "This CanvasTTY build does not provide the desktop:embed SDK." },
  ru: { label: "Окно приложения", title: "Приложение прямо на холсте", refresh: "Обновить", attach: "Встроить окно", detach: "Отсоединить", ready: "Выберите окно для встраивания", attached: "Встроено · доступны мышь и клавиатура", busy: "Загрузка…",
    hint: "Откройте приложение через X11 или XWayland и обновите список. «Отсоединить» вернёт окно на рабочий стол, приложение продолжит работать.",
    missing: "Подходящие X11-окна не найдены.", unsupported: "Эта сборка CanvasTTY не предоставляет SDK desktop:embed." }
};
let locale = "en", attached = false, busy = false, initialized = false, visible = true, timer, lastInset = 0;
let candidates = [], selectedId = "", activeIndex = 0;
const supported = Boolean(host?.desktopWindows?.list && host.desktopWindows.attach && host.desktopWindows.detach && host.desktopWindows.status);
function render() {
  const text = messages[locale];
  document.body.dataset.attached = String(attached);
  ui["window-label"].textContent = text.label;
  ui["empty-title"].textContent = text.title;
  ui["window-value"].textContent = candidates.find(item => item.id === selectedId)?.title || text.ready;
  ui.refresh.textContent = text.refresh;
  ui.attach.textContent = text.attach;
  ui.detach.textContent = text.detach;
  ui.status.textContent = busy ? text.busy : attached ? text.attached : text.ready;
  ui.message.textContent = supported ? text.hint : text.unsupported;
  ui.refresh.disabled = !supported || busy || attached;
  ui.windows.disabled = !supported || busy || attached || !candidates.length;
  ui.attach.disabled = !supported || busy || attached || !selectedId;
  if (ui.windows.disabled) closePicker();
  ui.attach.hidden = attached;
  ui.detach.hidden = !attached;
  ui.detach.disabled = busy;
  ui.toolbar.setAttribute("aria-busy", String(busy));
}
function showError(error) { ui.error.textContent = error instanceof Error ? error.message : String(error); ui.error.hidden = false; }
async function action(callback) {
  if (busy || !supported) return;
  busy = true;
  ui.error.hidden = true;
  render();
  try { await callback(); } catch (error) { showError(error); }
  finally { busy = false; render(); }
}
async function refresh() {
  const previous = candidates.find(item => item.id === selectedId);
  candidates = await host.desktopWindows.list();
  selectedId = (candidates.find(item => item.title === previous?.title && item.process === previous?.process) || candidates[0])?.id || "";
  ui["window-options"].replaceChildren(...candidates.map((item, index) => {
    const option = document.createElement("div");
    option.id = `window-option-${index}`;
    option.className = "window-option";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(item.id === selectedId));
    const title = document.createElement("strong"), process = document.createElement("small");
    title.textContent = item.title;
    process.textContent = item.process;
    option.append(title, process);
    option.addEventListener("pointerdown", event => event.preventDefault());
    option.addEventListener("pointermove", () => highlight(index));
    option.addEventListener("click", () => {
      selectedId = item.id;
      closePicker();
      render();
      ui.windows.focus();
    });
    return option;
  }));
  if (!candidates.length) showError(messages[locale].missing);
}
function highlight(index, scroll = false) {
  activeIndex = index;
  [...ui["window-options"].children].forEach((option, i) => {
    option.dataset.active = String(i === index);
    option.setAttribute("aria-selected", String(candidates[i].id === selectedId));
  });
  const option = ui["window-options"].children[index];
  if (option) {
    ui.windows.setAttribute("aria-activedescendant", option.id);
    if (scroll) option.scrollIntoView({ block: "nearest" });
  }
}
function closePicker() {
  ui["window-options"].hidden = true;
  ui.windows.setAttribute("aria-expanded", "false");
  ui.windows.removeAttribute("aria-activedescendant");
}
function openPicker(index = Math.max(0, candidates.findIndex(item => item.id === selectedId))) {
  if (ui.windows.disabled) return;
  const bounds = ui.windows.getBoundingClientRect();
  ui["window-options"].style.setProperty("--picker-space", `${Math.max(0, window.innerHeight - bounds.bottom - 12)}px`);
  ui["window-options"].hidden = false;
  ui.windows.setAttribute("aria-expanded", "true");
  highlight(index, true);
}
ui.windows.addEventListener("click", () => ui["window-options"].hidden ? openPicker() : closePicker());
ui.windows.addEventListener("keydown", event => {
  const opened = !ui["window-options"].hidden;
  if (event.key === "Tab" || event.key === "Escape") {
    closePicker();
    if (event.key === "Escape" && opened) { event.preventDefault(); event.stopPropagation(); }
    return;
  }
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    if (!opened) openPicker();
    else highlight(event.key === "Home" ? 0 : event.key === "End" ? candidates.length - 1
      : (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length, true);
  } else if (opened && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    ui["window-options"].children[activeIndex]?.click();
  }
});
document.addEventListener("pointerdown", event => { if (!ui.windows.parentElement.contains(event.target)) closePicker(); });
ui.windows.addEventListener("blur", closePicker);
window.addEventListener("resize", closePicker);
async function updateLayout() {
  if (!supported) return;
  const insetTop = Math.max(40, ui.toolbar.offsetHeight);
  if (insetTop === lastInset) return;
  await host.request("desktopWindows.layout", { insetTop });
  lastInset = insetTop;
}
window.addEventListener("message", event => {
  if (event.source !== parent || event.data?.source !== "canvastty-host" || event.data.type !== "desktop-appearance") return;
  const appearance = event.data.value;
  if (!appearance || !Number.isFinite(appearance.scale) || appearance.scale <= 0) return;
  const root = document.documentElement;
  root.style.setProperty("--control-scale", String(Math.max(1, Math.min(3, 1 / appearance.scale))));
  if (typeof appearance.font === "string") root.style.setProperty("--font", appearance.font);
  for (const [name, value] of Object.entries(appearance.colors ?? {})) {
    if (typeof value === "string" && value) root.style.setProperty(name, value);
  }
  root.dataset.compact = String(window.innerWidth * appearance.scale < 560);
});
const resize = new ResizeObserver(() => void updateLayout().catch(showError));
resize.observe(ui.toolbar);
function schedule() {
  clearTimeout(timer);
  if (!visible || !attached) return;
  timer = setTimeout(async () => {
    if (!busy) {
      try { attached = Boolean((await host.desktopWindows.status()).attached); render(); }
      catch (error) { showError(error); }
    }
    schedule();
  }, 2000);
}
ui.refresh.addEventListener("click", () => void action(refresh));
ui.attach.addEventListener("click", () => void action(async () => {
  await host.desktopWindows.attach(selectedId, Math.max(40, Math.min(300, ui.toolbar.offsetHeight)));
  attached = true;
  schedule();
  lastInset = 0;
  await updateLayout();
}));
ui.detach.addEventListener("click", () => void action(async () => {
  await host.desktopWindows.detach();
  attached = false;
  clearTimeout(timer);
  await refresh();
}));
host?.onContext(context => {
  locale = context.appearance.locale === "ru" ? "ru" : "en";
  document.documentElement.lang = locale;
  document.documentElement.dataset.palette = context.appearance.palette;
  render();
  if (!initialized) { initialized = true; void action(refresh); }
});
host?.onVisibilityChange?.(state => { visible = state === "visible"; if (!visible) closePicker(); schedule(); });
window.addEventListener("pagehide", () => { clearTimeout(timer); resize.disconnect(); });
host?.ready();
render();
