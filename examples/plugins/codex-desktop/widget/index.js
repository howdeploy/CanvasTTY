const host = window.CanvasTTYPlugin;
const elements = Object.fromEntries(
  [
    "status",
    "message",
    "error",
    "open",
    "windows",
    "refresh",
    "attach",
    "detach",
  ].map((id) => [id, document.getElementById(id)]),
);
const copy = {
  en: {
    open: "Open in canvas",
    refresh: "Refresh",
    attach: "Embed window",
    detach: "Return to desktop",
    ready: "Choose a window",
    running: "Embedded",
    loading: "Loading…",
    empty:
      "Start Codex or ChatGPT Desktop, then press Refresh. Its window will appear here. Returning it to the desktop does not close the app.",
    missing: "No Codex or ChatGPT desktop window found.",
    unsupported:
      "This plugin needs the desktop:embed SDK extension and a Windows host. Update CanvasTTY to a build with native window support.",
    home: "Open the Codex Desktop canvas card.",
    error: "Could not access the desktop window.",
  },
  ru: {
    open: "Открыть в канвасе",
    refresh: "Обновить",
    attach: "Встроить окно",
    detach: "Вернуть на рабочий стол",
    ready: "Выберите окно",
    running: "Встроено",
    loading: "Загрузка…",
    empty:
      "Запустите Codex или ChatGPT Desktop и нажмите «Обновить». Его окно появится здесь. Возврат на рабочий стол не закрывает приложение.",
    missing: "Окно Codex или ChatGPT Desktop не найдено.",
    unsupported:
      "Плагину нужны расширение SDK desktop:embed и Windows. Обновите CanvasTTY до сборки со встраиванием окон.",
    home: "Открыть карточку Codex Desktop в канвасе.",
    error: "Не удалось получить доступ к окну приложения.",
  },
};
let locale = "en",
  home = true,
  attached = false,
  busy = false,
  candidates = [],
  timer = null,
  visible = true,
  initialized = false;
const text = () => copy[locale];
const supports = () =>
  Boolean(
    host?.desktopWindows?.list &&
      host.desktopWindows.attach &&
      host.desktopWindows.detach &&
      host.desktopWindows.status,
  );
function render() {
  document.body.dataset.home = String(home);
  document.body.dataset.attached = String(attached);
  elements.status.textContent = busy
    ? text().loading
    : attached
      ? text().running
      : text().ready;
  for (const action of ["open", "refresh", "attach", "detach"]) {
    elements[action].textContent = text()[action];
    elements[action].disabled = busy;
  }
  elements.open.hidden = !home;
  elements.refresh.hidden = home || attached;
  elements.attach.hidden = home || attached;
  elements.detach.hidden = home || !attached;
  elements.windows.hidden = home || attached;
  elements.windows.setAttribute(
    "aria-label",
    locale === "ru" ? "Окно Codex Desktop" : "Codex desktop window",
  );
  elements.attach.disabled = busy || !candidates.length || !supports();
  elements.message.textContent = home
    ? text().home
    : !supports()
      ? text().unsupported
      : text().empty;
}
function failure(error) {
  elements.error.textContent =
    error instanceof Error ? error.message : text().error;
  elements.error.hidden = false;
}
async function action(callback) {
  if (busy) return;
  busy = true;
  elements.error.hidden = true;
  render();
  try {
    await callback();
  } catch (error) {
    failure(error);
  } finally {
    busy = false;
    render();
  }
}
async function refresh() {
  if (!supports()) {
    render();
    return;
  }
  const all = await host.desktopWindows.list();
  candidates = all.filter((item) => /^(codex|chatgpt)$/i.test(item.process));
  elements.windows.replaceChildren();
  for (const item of candidates) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.title;
    elements.windows.append(option);
  }
  if (!candidates.length) {
    elements.error.textContent = text().missing;
    elements.error.hidden = false;
  }
}
function schedule() {
  if (timer !== null) clearTimeout(timer);
  if (!visible || home || !supports()) return;
  timer = setTimeout(async () => {
    if (!busy) {
      try {
        attached = Boolean((await host.desktopWindows.status()).attached);
        render();
      } catch (error) {
        failure(error);
      }
    }
    schedule();
  }, 2000);
}
elements.open.addEventListener(
  "click",
  () => void action(() => host.canvas.open("codex-desktop-canvas")),
);
elements.refresh.addEventListener("click", () => void action(refresh));
elements.attach.addEventListener(
  "click",
  () =>
    void action(async () => {
      await host.desktopWindows.attach(elements.windows.value, 104);
      attached = true;
      schedule();
    }),
);
elements.detach.addEventListener(
  "click",
  () =>
    void action(async () => {
      await host.desktopWindows.detach();
      attached = false;
      await refresh();
    }),
);
host.onContext((context) => {
  locale = context.appearance.locale === "ru" ? "ru" : "en";
  home = context.contribution.kind === "home-widget";
  document.documentElement.lang = locale;
  document.documentElement.dataset.palette = context.appearance.palette;
  render();
  if (!initialized) {
    initialized = true;
    if (!home) void action(refresh).finally(schedule);
  }
});
host.onVisibilityChange?.((state) => {
  visible = state === "visible";
  schedule();
});
window.addEventListener("pagehide", () => {
  if (timer !== null) clearTimeout(timer);
});
host.ready();
render();
