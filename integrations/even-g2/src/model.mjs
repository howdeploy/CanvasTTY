export const STATUS = {
  idle: "Готов",
  working: "Работает",
  needs_approval: "Нужен ответ",
  unavailable: "Статус неизвестен",
  done: "Завершён",
  failed: "Ошибка",
};
export function wrap(text, width = 32) {
  const lines = [];
  for (const line of String(text || "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .split("\n")) {
    const rest = Array.from(line.trim());
    if (!rest.length) {
      if (lines.at(-1) !== "") lines.push("");
      continue;
    }
    while (rest.length) {
      let end = Math.min(width, rest.length);
      if (rest.length > width) {
        const s = rest.slice(0, width + 1).lastIndexOf(" ");
        if (s > 8) end = s;
      }
      lines.push(rest.splice(0, end).join(""));
      while (rest[0] === " ") rest.shift();
    }
  }
  return lines;
}
export class ViewModel {
  constructor() {
    this.view = "home";
    this.sessions = [];
    this.selection = 0;
    this.sessionId = null;
    this.page = 0;
    this.body = "";
    this.revision = "";
    this.state = "idle";
    this.pendingOwn = false;
    this.limits = null;
    this.cache = new Map();
    this.interaction = null;
    this.choiceSelection = 0;
    this.consumedMenus = new Set();
    this.closeDialog = null;
    this.renameDialog = null;
    this.createDialog = null;
  }
  home(data) {
    const selected = this.sessions[this.selection]?.id;
    this.sessions = data.sessions;
    this.limits = data.limits;
    for (const id of this.cache.keys())
      if (!this.sessions.some((s) => s.id === id)) this.cache.delete(id);
    const i = this.sessions.findIndex((s) => s.id === selected);
    this.selection =
      i >= 0
        ? i
        : Math.min(this.selection, Math.max(0, this.sessions.length - 1));
    if (this.sessionId && !this.sessions.some((s) => s.id === this.sessionId)) {
      this.view = "home";
      this.sessionId = null;
      this.interaction = null;
    }
    if (
      this.closeDialog &&
      !this.sessions.some((s) => s.id === this.closeDialog.sessionId)
    )
      this.closeDialog = null;
    if (
      this.renameDialog &&
      !this.sessions.some(
        (session) => session.id === this.renameDialog.sessionId,
      )
    )
      this.renameDialog = null;
  }
  open(id) {
    this.view = "terminal";
    this.sessionId = id;
    this.page = 0;
    this.body = "Загружаю ответ…";
    this.revision = "";
    this.interaction = null;
    this.state = this.sessions.find((s) => s.id === id)?.status || "idle";
    this.pendingOwn = false;
    const cached = this.cache.get(id);
    if (cached) this.terminal(cached);
  }
  loadFailed(id) {
    if (this.sessionId === id && !this.revision) {
      this.body = "Не удалось загрузить ответ. Проверьте подключение к Mac.";
      this.state = "failed";
    }
  }
  terminal(data) {
    this.cache.set(data.session.id, data);
    if (data.session.id !== this.sessionId) return;
    this.state = data.session.status;
    const next = data.interaction?.kind === "choices" ? data.interaction : null;
    if (next && this.consumedMenus.has(next.id)) return;
    if (next?.id !== this.interaction?.id)
      this.choiceSelection = next?.selected ?? 0;
    this.interaction = next;
    if (data.revision !== this.revision) {
      this.body = data.body;
      this.revision = data.revision;
      if (this.pendingOwn && this.state !== "working") {
        this.page = 0;
        this.pendingOwn = false;
      }
      this.page = Math.min(this.page, this.pages().length - 1);
    }
  }
  dismissMenu(id) {
    this.consumedMenus.add(id);
    if (this.consumedMenus.size > 32)
      this.consumedMenus.delete(this.consumedMenus.values().next().value);
    if (this.interaction?.id === id) {
      this.interaction = null;
      this.body = "Выбор передан Codex. Ожидаю обновления.";
      this.revision = "";
    }
  }
  choiceBody() {
    const menu = this.interaction;
    return menu
      ? menu.title +
          "\n\n" +
          menu.options
            .map(
              (o, i) =>
                (i === this.choiceSelection ? "› " : "  ") +
                o.number +
                ". " +
                o.label,
            )
            .join("\n")
      : this.body;
  }
  pages() {
    const lines = wrap(this.body);
    const result = [];
    for (let i = 0; i < Math.max(1, lines.length); i += 6)
      result.push(lines.slice(i, i + 6).join("\n"));
    return result;
  }
  scroll(delta) {
    if (this.createDialog) {
      this.createDialog.selected = Math.max(0, Math.min(
        this.createDialog.providers.length - 1, this.createDialog.selected + delta,
      ));
    } else if (this.renameDialog) {
      if (this.renameDialog.draft)
        this.renameDialog.selected = Math.max(
          0,
          Math.min(1, this.renameDialog.selected + delta),
        );
    } else if (this.closeDialog) {
      this.closeDialog.selected = Math.max(
        0,
        Math.min(1, this.closeDialog.selected + delta),
      );
    } else if (this.view === "terminal" && this.interaction) {
      this.choiceSelection = Math.max(
        0,
        Math.min(
          this.interaction.options.length - 1,
          this.choiceSelection + delta,
        ),
      );
    } else if (this.view === "terminal") {
      this.page = Math.max(
        0,
        Math.min(this.pages().length - 1, this.page + delta),
      );
    } else {
      this.selection = Math.max(
        0,
        Math.min(this.sessions.length - 1, this.selection + delta),
      );
    }
  }
  frame(override = "", warning = "") {
    if (override)
      return ["CANVASTTY", ...wrap(override).slice(0, 8)].join("\n");
    if (this.createDialog) {
      const { providers, selected } = this.createDialog;
      const start = Math.max(0, selected - 5);
      return [
        "СОЗДАТЬ АГЕНТА",
        ...providers.slice(start, start + 6).map((provider, i) =>
          `${start + i === selected ? "> " : "  "}${provider.label}`),
        "Свайп: выбрать · клик: создать",
        "2 клика: отмена",
      ].join("\n");
    }
    if (this.renameDialog) {
      const d = this.renameDialog;
      return [
        "ПЕРЕИМЕНОВАТЬ ТЕРМИНАЛ",
        ...wrap(d.draft || d.original).slice(0, 3),
        ...(d.draft
          ? [
              (d.selected === 0 ? "> " : "  ") + "Отмена",
              (d.selected === 1 ? "> " : "  ") + "Сохранить имя",
              warning || "Свайп: выбор · клик: подтвердить",
            ]
          : [
              warning || "Удерживай: продиктовать имя",
              "Или введи имя на телефоне",
            ]),
        "2 клика: отмена",
      ].join("\n");
    }
    if (this.closeDialog) {
      const d = this.closeDialog;
      return [
        "ЗАКРЫТЬ ТЕРМИНАЛ?",
        ...wrap(d.title).slice(0, 2),
        "Процесс в окне будет остановлен.",
        "Файлы проекта сохранятся.",
        (d.selected === 0 ? "> " : "  ") + "Отмена",
        (d.selected === 1 ? "> " : "  ") + "Закрыть терминал",
        warning || "Свайп: выбрать · клик: подтвердить",
        "2 клика: отмена",
      ].join("\n");
    }
    if (this.view === "terminal") {
      if (this.interaction) {
        const menu = this.interaction,
          question = wrap(menu.title),
          option = wrap(menu.options[this.choiceSelection]?.label || "");
        const short = (lines, n) =>
          lines.length > n
            ? [...lines.slice(0, n - 1), lines[n - 1].slice(0, 29) + "…"]
            : lines;
        return [
          "CODEX · ВЫБОР",
          warning || "Свайп: сменить вариант",
          ...short(question, 2),
          "> " + (this.choiceSelection + 1) + ".",
          ...short(option, 3),
          "Клик: выбрать · 2 клика: Home",
          menu.customIndex !== null
            ? "Удержание: свой ответ"
            : "Свой ответ не предусмотрен",
        ].join("\n");
      }
      const s = this.sessions.find((s) => s.id === this.sessionId);
      return [
        (s?.title || "Терминал").slice(0, 32),
        warning || STATUS[this.state] || this.state,
        this.pages()[this.page] || "",
        `${this.page + 1}/${this.pages().length} · свайп / 2 клика: Home`,
      ].join("\n");
    }
    const provider = this.limits?.providers?.find(
      (p) => p.provider === "codex",
    );
    const window =
      provider?.windows?.find(
        (w) => w.isDefaultBucket && w.usedPercent !== null,
      ) || provider?.windows?.find((w) => w.usedPercent !== null);
    const quota = window
      ? `Codex: ${window.usedPercent}% использовано${provider.state === "stale" ? " *" : ""}`
      : "Codex: лимиты не получены";
    const active = this.sessions.filter((s) => s.status === "working").length;
    const start = Math.max(0, this.selection - 1);
    return [
      "CANVASTTY · HOME",
      warning || quota,
      `Терминалы: ${this.sessions.length}  В работе: ${active}`,
      ...this.sessions
        .slice(start, start + 3)
        .map(
          (s, i) =>
            `${start + i === this.selection ? ">" : " "} ${s.title.slice(0, 20)} · ${STATUS[s.status] || "?"}`,
        ),
      this.sessions.length
        ? "Клик: открыть выбранный"
        : "Создать: в меню очков",
      "Создать агента: меню More agents",
    ].join("\n");
  }
}
export class Gestures {
  constructor(actions) {
    this.actions = actions;
    this.recording = false;
  }
  click() {
    this.actions.select();
  }
  long() {
    this.recording = true;
    this.actions.record();
  }
  release() {
    if (this.recording) {
      this.recording = false;
      this.actions.send();
    }
  }
  cancel() {
    this.recording = false;
  }
  double() {
    this.cancel();
    this.actions.back();
  }
}
