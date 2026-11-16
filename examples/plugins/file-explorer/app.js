/* Canvas Files: sandboxed UI. All filesystem access is mediated by the host. */
(() => {
  "use strict";
  const host = window.CanvasTTYPlugin;
  const $ = (id) => document.getElementById(id);
  const strings = {
    en: {
      places: "FOLDERS", addFolder: "＋ Add folder", local: "Local files", hidden: "Hidden", name: "Name", size: "Size",
      welcome: "Your files. On the canvas.", chooseHint: "Add a folder to browse, preview and drag files into a terminal.",
      chooseFolder: "Choose folder", dragHint: "Drag a file into a terminal to insert its path", more: "Load more",
      back: "Back", forward: "Forward", up: "Parent folder", refresh: "Refresh", list: "List view", grid: "Grid view",
      search: "Filter this folder", preview: "Select a file to preview", empty: "This folder is empty", noMatch: "No matching files",
      noMatchHint: "Change the filter or show hidden files.", previewTitle: "Preview", popout: "Open in separate window",
      reveal: "Show in file manager", forget: "Remove folder access", type: "Type", modified: "Modified", fit: "Fit / 100%",
      unsupported: "No built-in preview for this format. Show it in your system file manager to open it with a compatible app.",
      codec: "This codec or file could not be played. Show the file in your system file manager to use another player.",
      imageError: "The image could not be decoded.", loading: "Loading…", truncated: "Preview limited to the first 256 KiB.",
      items: "items", openFolder: "Open folder", folder: "Folder", windowHint: "Select a file in Canvas Files to preview it here.",
      upgrade: "This CanvasTTY build does not include the files:read API. Install the accompanying host update first."
    },
    ru: {
      places: "ПАПКИ", addFolder: "＋ Добавить папку", local: "Локальные файлы", hidden: "Скрытые", name: "Имя", size: "Размер",
      welcome: "Файлы рядом с работой.", chooseHint: "Добавьте папку: просматривайте файлы и перетаскивайте их в терминал.",
      chooseFolder: "Выбрать папку", dragHint: "Перетащите файл в терминал, чтобы вставить путь", more: "Загрузить ещё",
      back: "Назад", forward: "Вперёд", up: "На уровень выше", refresh: "Обновить", list: "Список", grid: "Плитки",
      search: "Фильтр в этой папке", preview: "Выберите файл для предпросмотра", empty: "В папке пока пусто", noMatch: "Файлы не найдены",
      noMatchHint: "Измените фильтр или включите скрытые файлы.", previewTitle: "Просмотр", popout: "Открыть в отдельном окне",
      reveal: "Показать в проводнике", forget: "Убрать доступ к папке", type: "Тип", modified: "Изменён", fit: "Вписать / 100%",
      unsupported: "Для этого формата нет встроенного предпросмотра. Покажите файл в системном проводнике и откройте подходящим приложением.",
      codec: "Не удалось воспроизвести этот файл или кодек. Покажите файл в проводнике и откройте другим проигрывателем.",
      imageError: "Не удалось прочитать изображение.", loading: "Загрузка…", truncated: "Показаны первые 256 КиБ файла.",
      items: "объектов", openFolder: "Открыть папку", folder: "Папка", windowHint: "Выберите файл в Canvas Files — он появится здесь.",
      upgrade: "В этой сборке CanvasTTY ещё нет API files:read. Сначала установите прилагаемое обновление хоста."
    }
  };
  let locale = "en";
  let context;
  let roots = [];
  let location = null;
  let entries = [];
  let selected = null;
  let history = [];
  let historyIndex = -1;
  let nextOffset = null;
  let total = 0;
  let listRevision = 0;
  let previewRevision = 0;
  let searchTimer;
  let windowMode = document.body.classList.contains("preview-window");
  let showHidden = false;
  let view = "list";
  const tr = (key) => strings[locale][key] || key;
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  function button(label, action, className = "") {
    const element = node("button", className, label);
    element.addEventListener("click", () => run(action));
    return element;
  }
  async function run(action) {
    try { await action(); } catch (error) { showError(error); }
  }
  function showError(error) {
    const message = String(error?.message || error);
    $("error").textContent = /unsupported plugin method|unknown plugin permission|files.*unavailable/i.test(message)
      ? tr("upgrade") : message;
    $("error").hidden = false;
  }
  function clearError() { $("error").hidden = true; }
  function applyContext(value) {
    context = value;
    locale = value.appearance.locale === "ru" ? "ru" : "en";
    document.documentElement.lang = locale;
    document.body.dataset.palette = value.appearance.palette;
    document.querySelectorAll("[data-i18n]").forEach((element) => { element.textContent = tr(element.dataset.i18n); });
    document.querySelectorAll("[data-title]").forEach((element) => {
      element.title = tr(element.dataset.title);
      element.setAttribute("aria-label", element.title);
    });
    if ($("search")) { $("search").placeholder = tr("search"); $("search").setAttribute("aria-label", tr("search")); }
    if (!windowMode) { renderRoots(); renderBreadcrumbs(); renderEntries(); }
  }
  function size(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  function fileSymbol(entry) {
    if (entry.kind === "directory") return "▱";
    if (entry.kind === "image") return "IMG";
    if (entry.kind === "video") return "▶";
    if (entry.kind === "audio") return "♪";
    return entry.name.includes(".") ? entry.name.split(".").pop().slice(0, 4) : "TXT";
  }
  function renderRoots() {
    $("roots").replaceChildren(...roots.map((root) => {
      const row = node("div", `root${location?.rootId === root.id ? " active" : ""}`);
      const open = button("", () => navigate(root.id, ""), "root-main");
      open.title = root.name;
      open.append(node("span", "", "▱"), node("span", "", root.name));
      const forget = button("×", async () => {
        await host.files.revoke(root.id);
        const openPreview = await host.storage.get("previewSelection");
        if (openPreview?.rootId === root.id) await host.storage.set("previewSelection", null);
        roots = await host.files.roots();
        history = history.filter((item) => item.rootId !== root.id);
        historyIndex = history.length - 1;
        if (location?.rootId === root.id) {
          location = null; entries = []; selected = null; total = 0; nextOffset = null;
          listRevision++;
          await renderPreview(null);
          await host.storage.set("lastLocation", null);
          if (roots.length) await navigate(roots[0].id, "");
        }
        renderRoots(); renderBreadcrumbs(); renderEntries();
      }, "forget");
      forget.title = tr("forget"); forget.setAttribute("aria-label", `${tr("forget")}: ${root.name}`);
      row.append(open, forget); return row;
    }));
  }
  function renderBreadcrumbs() {
    if (!$("breadcrumbs")) return;
    const root = roots.find((item) => item.id === location?.rootId);
    $("breadcrumbs").replaceChildren();
    if (root) {
      $("breadcrumbs").append(button(root.name, () => navigate(root.id, "")));
      const parts = location.relativePath ? location.relativePath.split("/") : [];
      parts.forEach((part, index) => {
        $("breadcrumbs").append(node("span", "", "/"), button(part, () => navigate(root.id, parts.slice(0, index + 1).join("/"))));
      });
    }
    $("up").disabled = !location?.relativePath;
    $("back").disabled = historyIndex <= 0;
    $("forward").disabled = historyIndex >= history.length - 1;
    $("refresh").disabled = !location;
    $("search").disabled = !location;
  }
  async function chooseFolder() {
    clearError();
    const root = await host.files.pickFolder();
    if (!root) return;
    roots = await host.files.roots();
    await navigate(root.id, "");
  }
  async function navigate(rootId, relativePath, record = true) {
    clearTimeout(searchTimer);
    location = { rootId, relativePath };
    if (record) { history = history.slice(0, historyIndex + 1); history.push({ ...location }); historyIndex = history.length - 1; }
    $("search").value = "";
    selected = null;
    void renderPreview(null);
    renderRoots(); renderBreadcrumbs();
    await Promise.all([loadFolder(), host.storage.set("lastLocation", location)]);
  }
  async function loadFolder(append = false) {
    if (!location) return;
    const revision = ++listRevision;
    const target = { ...location };
    clearError();
    $("entries").setAttribute("aria-busy", "true");
    if (!append) { entries = []; selected = null; total = 0; renderEntries(); void renderPreview(null); }
    $("more").disabled = true;
    try {
      const result = await host.files.list(target.rootId, target.relativePath, {
        offset: append ? nextOffset : 0, showHidden, query: $("search").value.trim()
      });
      if (revision !== listRevision) return;
      entries = append ? [...entries, ...result.entries] : result.entries;
      nextOffset = result.nextOffset; total = result.total;
      renderEntries();
    } catch (error) {
      if (revision === listRevision) { nextOffset = null; renderEntries(); showError(error); }
    } finally {
      if (revision === listRevision) { $("entries").removeAttribute("aria-busy"); $("more").disabled = false; }
    }
  }
  function renderEntries() {
    if (!$("entries")) return;
    $("browser").classList.toggle("grid", view === "grid");
    $("list-view").classList.toggle("active", view === "list");
    $("grid-view").classList.toggle("active", view === "grid");
    $("list-view").setAttribute("aria-pressed", String(view === "list"));
    $("grid-view").setAttribute("aria-pressed", String(view === "grid"));
    $("entries").replaceChildren(...entries.map((entry, index) => {
      const row = node("div", "entry");
      row.id = `file-${index}`; row.dataset.path = entry.relativePath;
      row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(entry.relativePath === selected?.relativePath));
      row.title = entry.name; row.draggable = true;
      row.append(node("span", `entry-icon ${entry.kind}`, fileSymbol(entry)), node("span", "entry-name", entry.name),
        node("span", "entry-size", entry.kind === "directory" ? "—" : size(entry.size)));
      row.addEventListener("click", () => { $("entries").focus(); run(() => select(entry)); });
      row.addEventListener("dblclick", () => run(() => openEntry(entry)));
      row.addEventListener("dragstart", (event) => {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-canvastty-file", entry.dragToken);
        event.dataTransfer.setData("text/plain", entry.name);
      });
      return row;
    }));
    const activeIndex = entries.findIndex((entry) => entry.relativePath === selected?.relativePath);
    if (activeIndex >= 0) $("entries").setAttribute("aria-activedescendant", `file-${activeIndex}`);
    else $("entries").removeAttribute("aria-activedescendant");
    $("more").hidden = nextOffset === null || !location;
    $("count").textContent = location ? `${entries.length} / ${total} ${tr("items")}` : "";
    $("empty").hidden = entries.length > 0;
    $("empty").querySelector("h1").textContent = location ? tr($("search").value ? "noMatch" : "empty") : tr("welcome");
    $("empty").querySelector("p").textContent = location ? tr("noMatchHint") : tr("chooseHint");
    $("choose-first").hidden = Boolean(location);
  }
  async function select(entry) {
    selected = entry;
    document.querySelectorAll(".entry").forEach((row) => row.setAttribute("aria-selected", String(row.dataset.path === entry.relativePath)));
    const index = entries.indexOf(entry);
    if (index >= 0) $("entries").setAttribute("aria-activedescendant", `file-${index}`);
    await renderPreview(entry, location.rootId);
  }
  async function openEntry(entry) {
    if (entry.kind === "directory") return navigate(location.rootId, entry.relativePath);
    await openWindow(entry, location.rootId);
  }
  async function openWindow(entry, rootId) {
    // Release the inline player before opening the second one; never play both at once.
    $("preview").querySelectorAll("audio,video").forEach((media) => media.pause());
    await host.storage.set("previewSelection", { rootId, relativePath: entry.relativePath });
    await host.request("window.open", { contributionId: "preview", reuse: true });
  }
  async function renderPreview(entry, rootId) {
    const revision = ++previewRevision;
    const panel = $("preview");
    panel.querySelectorAll("audio,video").forEach((media) => { media.pause(); media.removeAttribute("src"); media.load(); });
    panel.replaceChildren();
    if (!entry) {
      const placeholder = node("div", "preview-placeholder");
      placeholder.append(node("div", "preview-symbol", "⌑"), node("div", "", tr(windowMode ? "windowHint" : "preview")));
      panel.append(placeholder); return;
    }
    const head = node("div", "preview-head");
    head.append(node("strong", "", entry.name));
    if (!windowMode && entry.kind !== "directory") {
      const popout = button("↗", () => openWindow(entry, rootId), "icon-button");
      popout.title = tr("popout"); popout.setAttribute("aria-label", tr("popout")); head.append(popout);
    }
    const stage = node("div", "media-stage");
    const meta = node("div", "preview-meta");
    const detail = (label, value) => { const row = node("div", "detail"); row.append(node("span", "", label), node("span", "", value)); meta.append(row); };
    detail(tr("type"), entry.kind === "directory" ? tr("folder") : entry.mimeType === "application/octet-stream" ? entry.name.split(".").pop().toUpperCase() : entry.mimeType);
    if (entry.kind !== "directory") detail(tr("size"), size(entry.size));
    detail(tr("modified"), new Date(entry.modifiedAt).toLocaleDateString(locale));
    const actions = node("div", "preview-actions");
    if (!windowMode && entry.kind === "directory") actions.append(button(tr("openFolder"), () => navigate(rootId, entry.relativePath)));
    actions.append(button(tr("reveal"), () => host.files.reveal(rootId, entry.relativePath)));
    if (!windowMode && entry.kind !== "directory") actions.append(button(tr("popout"), () => openWindow(entry, rootId)));
    meta.append(actions);
    panel.append(head, stage, meta);
    const failed = (key) => {
      if (revision !== previewRevision) return;
      stage.append(node("div", "preview-placeholder", tr(key)));
    };
    if (entry.kind === "image") {
      const image = node("img"); image.alt = entry.name; image.src = entry.streamUrl;
      image.addEventListener("error", () => { image.hidden = true; failed("imageError"); }, { once: true });
      stage.append(image);
      actions.prepend(button(tr("fit"), () => { image.classList.toggle("actual-size"); }));
    } else if (entry.kind === "video" || entry.kind === "audio") {
      if (entry.kind === "audio") stage.append(node("div", "preview-symbol", "♪"));
      const media = node(entry.kind); media.controls = true; media.preload = "metadata";
      media.setAttribute("aria-label", entry.name);
      if (entry.kind === "video") media.setAttribute("playsinline", "");
      media.addEventListener("error", () => failed("codec"), { once: true });
      media.src = entry.streamUrl; stage.append(media);
    } else if (entry.kind === "text") {
      stage.append(node("div", "preview-placeholder", tr("loading")));
      try {
        const result = await host.files.readText(rootId, entry.relativePath);
        if (revision !== previewRevision) return;
        stage.replaceChildren(node("pre", "", result.content));
        if (result.truncated) meta.prepend(node("div", "", tr("truncated")));
      } catch (error) {
        if (revision === previewRevision) stage.replaceChildren(node("div", "preview-placeholder", String(error.message || error)));
      }
    } else {
      stage.append(node("div", "preview-symbol", fileSymbol(entry)));
      if (entry.kind !== "directory") stage.append(node("div", "preview-placeholder", tr("unsupported")));
    }
  }
  async function restoreWindowSelection() {
    await renderPreview(null);
    const revision = ++previewRevision;
    const value = await host.storage.get("previewSelection");
    if (revision !== previewRevision) return;
    if (!value || typeof value.rootId !== "string" || typeof value.relativePath !== "string") return renderPreview(null);
    const entry = await host.files.stat(value.rootId, value.relativePath);
    if (revision !== previewRevision) return;
    clearError(); await renderPreview(entry, value.rootId);
    document.title = entry.name;
  }
  function goHistory(delta) {
    const index = historyIndex + delta;
    if (index < 0 || index >= history.length) return;
    historyIndex = index;
    return navigate(history[index].rootId, history[index].relativePath, false);
  }
  function goUp() {
    if (!location?.relativePath) return;
    return navigate(location.rootId, location.relativePath.split("/").slice(0, -1).join("/"));
  }
  async function initialize() {
    if (!host?.files) { showError(tr("upgrade")); return; }
    applyContext(await host.request("host.getContext"));
    host.onContext(applyContext);
    host.ready();
    if (windowMode) {
      await restoreWindowSelection();
      host.onStorageChange((key) => { if (key === "previewSelection") run(restoreWindowSelection); });
      return;
    }
    $("add-folder").addEventListener("click", () => run(chooseFolder));
    $("choose-first").addEventListener("click", () => run(chooseFolder));
    $("back").addEventListener("click", () => run(() => goHistory(-1)));
    $("forward").addEventListener("click", () => run(() => goHistory(1)));
    $("up").addEventListener("click", () => run(goUp));
    $("refresh").addEventListener("click", () => run(() => loadFolder()));
    $("search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => run(() => loadFolder()), 180); });
    $("hidden").addEventListener("change", () => { showHidden = $("hidden").checked; run(async () => { await host.storage.set("showHidden", showHidden); await loadFolder(); }); });
    for (const mode of ["list", "grid"]) $(mode + "-view").addEventListener("click", () => { view = mode; renderEntries(); run(() => host.storage.set("view", mode)); });
    $("more").addEventListener("click", () => run(() => loadFolder(true)));
    $("entries").addEventListener("keydown", (event) => {
      if (!entries.length) return;
      const index = entries.findIndex((entry) => entry.relativePath === selected?.relativePath);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = event.key === "ArrowDown" ? Math.min(entries.length - 1, index + 1) : Math.max(0, index - 1);
        run(() => select(entries[next])); $("entries").children[next]?.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter" && selected) { event.preventDefault(); run(() => openEntry(selected)); }
    });
    document.addEventListener("keydown", (event) => {
      const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") { event.preventDefault(); $("search").focus(); }
      if (editing) return;
      if (event.key === "Backspace" || (event.altKey && event.key === "ArrowUp")) { event.preventDefault(); run(goUp); }
      if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); run(() => goHistory(-1)); }
      if (event.altKey && event.key === "ArrowRight") { event.preventDefault(); run(() => goHistory(1)); }
    });
    const [savedRoots, savedLocation, savedView, savedHidden] = await Promise.all([
      host.files.roots(), host.storage.get("lastLocation"), host.storage.get("view"), host.storage.get("showHidden")
    ]);
    roots = savedRoots;
    view = savedView === "grid" ? "grid" : "list"; showHidden = savedHidden === true;
    $("hidden").checked = showHidden;
    renderRoots(); renderBreadcrumbs(); renderEntries(); await renderPreview(null);
    if (roots.some((root) => root.id === savedLocation?.rootId) && typeof savedLocation.relativePath === "string") {
      await navigate(savedLocation.rootId, savedLocation.relativePath);
    } else if (roots.length) await navigate(roots[0].id, "");
  }
  run(initialize);
})();
