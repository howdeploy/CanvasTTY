import { MORE_AGENTS } from "./create-menu.mjs";
import { normalizeSessionTitle } from "../../../src/shared/companion.ts";
import { pairComputer } from "./connect.mjs";
import { BRIDGE_ORIGIN, LOCAL_ONLY } from "./build-config.mjs";
import {
  localFetcher,
  readLocalConnection,
  connectionFromCode,
} from "./local-fetch.mjs";
import * as sdk from "@evenrealities/even_hub_sdk";
import { HudBridge } from "./hud-bridge.mjs";
import { ViewModel, Gestures, STATUS } from "./model.mjs";
import { validatePairing } from "./pairing.mjs";
import { inputEvent } from "./input.mjs";

const $ = (id) => document.getElementById(id),
  BASE = BRIDGE_ORIGIN || location.origin,
  KEY = "canvastty.g2.home.token.v4";
const CONNECTION_KEY = "canvastty.g2.local.v1";
let localConnection = null,
  localFetch = null;
const model = new ViewModel();
let native = null,
  hud = null,
  token = "",
  alive = true,
  foreground = true,
  notice = "",
  lastFrame = "",
  latestHome = null;
let mic = null,
  wanted = false,
  generation = 0,
  micQueue = Promise.resolve(),
  micPending = 0,
  parts = [],
  size = 0,
  lastAudioAt = 0,
  startedAt = 0;
let voiceRequest = null,
  voiceSession = null,
  voiceBusy = false;
let voicePurpose = "input",
  voiceRenameTarget = null;
let overlay = false,
  pairBusy = false,
  createBusy = false,
  exitBusy = false;
let micFault = "",
  micOffRequest = null,
  micOffState = null;
let micUsed = false,
  micTest = false,
  micTestBytes = 0,
  micTestTimer = null,
  controlBusy = false,
  controlFeedback = "";
const drafts = new Map();
const diagnostics = [];
const micDiagnostics = [];
let lastCaptureBytes = 0,
  pairAbort = null;
let telemetrySignature = "";
function trace(message) {
  const line = new Date().toISOString().slice(11, 23) + " " + message;
  diagnostics.push(line);
  if (/^(mic:|voice:stop|lifecycle:)/.test(message)) {
    micDiagnostics.push(line);
    if (micDiagnostics.length > 16) micDiagnostics.shift();
  }
  if (diagnostics.length > 64) diagnostics.shift();
  $("diagnostics").textContent = diagnostics.join("\n");
}
function id() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
async function request(path, body, credential = token) {
  if (!credential) throw new Error("Введите код подключения.");
  if (LOCAL_ONLY && !localFetch)
    throw new Error("Введите код подключения из CanvasTTY на Mac.");
  const response = await (localFetch || fetch)(
    (localFetch?.connection().origins[0] || BASE) + path,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + credential,
        "Content-Type": "application/json",
      },
      body:
        body === undefined
          ? undefined
          : JSON.stringify({
              ...body,
              requestId: body.requestId || id(),
              sentAt: body.sentAt || Date.now(),
            }),
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(
        path.includes("voice")
          ? 65000
          : path.includes("/create") || path.includes("/browser")
            ? 15000
            : 8000,
      ),
    },
  );
  if (!response.ok) throw new Error("Компьютер не подтвердил запрос.");
  return response.json();
}
function clearAudio() {
  for (const p of parts) p.fill(0);
  parts = [];
  size = 0;
}
function micDeadline(operation, on, state = { sent: true }) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        state.sent
          ? "Нет подтверждения микрофона за 2,5 с."
          : "Канал очков занят. Команда микрофона ещё не отправлена.",
      );
      micFault = error.message;
      trace(
        "mic:" +
          (on ? "on" : "off") +
          (state.sent ? " deadline" : " queue-deadline"),
      );
      paint();
      reject(error);
    }, 2500);
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}
function setMic(on, ticket) {
  if (!on && micOffRequest)
    return micDeadline(micOffRequest, false, micOffState);
  const state = { sent: false };
  micPending++;
  const operation = micQueue.then(async () => {
    if (on && (!wanted || ticket !== generation || !foreground)) return false;
    if (on) {
      if (!hud?.started) throw new Error("Экран G2 не готов.");
      await hud.waitForIdle();
    }
    if (on && (!wanted || ticket !== generation || !foreground || overlay))
      return false;
    trace("mic:" + (on ? "on" : "off") + " queued");
    try {
      const ack = await hud.microphone(on, {
        canStart: () =>
          wanted && ticket === generation && foreground && !overlay,
        onDispatch: () => {
          state.sent = true;
          if (on) micUsed = true;
          mic = null;
          trace("mic:" + (on ? "on" : "off") + " sent");
        },
      });
      if (!state.sent) return false;
      trace(
        "mic:" +
          (on ? "on" : "off") +
          " ack=" +
          (ack === true ? "true" : ack === false ? "false" : typeof ack),
      );
      if (ack !== true)
        throw new Error(
          "G2 не подтвердил " +
            (on ? "включение" : "выключение") +
            " микрофона.",
        );
      mic = on;
      micFault = "";
      paint();
      return true;
    } catch (e) {
      micFault = e.message;
      trace("mic:" + (on ? "on" : "off") + " failed");
      paint();
      throw e;
    }
  });
  // A caller timeout does not release an unsettled native operation. A queued
  // off still follows a late enable ACK, while navigation remains independent.
  micQueue = operation.catch(() => {});
  void operation
    .finally(() => {
      micPending--;
      paint();
    })
    .catch(() => {});
  if (!on) {
    micOffRequest = operation;
    micOffState = state;
    void operation
      .finally(() => {
        if (micOffRequest === operation) {
          micOffRequest = null;
          micOffState = null;
        }
        paint();
      })
      .catch(() => {});
  }
  return micDeadline(operation, on, state);
}
function statusLabel() {
  if (wanted) return mic === true ? "Говорите…" : "Включаю микрофон…";
  if (voiceBusy)
    return "Распознаю: " + (latestHome?.speechModel || "локально") + "…";
  return STATUS[model.state] || "Готов";
}
function setPanel(name) {
  if (name !== "workspace" && model.renameDialog) {
    model.renameDialog = null;
    void stopVoice(false, "rename-navigation");
  }
  for (const section of document.querySelectorAll("[data-view]"))
    section.hidden = section.dataset.view !== name;
  for (const button of document.querySelectorAll("[data-panel]"))
    button.setAttribute("aria-pressed", String(button.dataset.panel === name));
}
function paint() {
  $("speech-engine").textContent = latestHome?.speechModel || "Нет данных";
  $("session-empty").hidden = model.sessions.length > 0;
  $("session-empty").textContent = latestHome
    ? "Доступных сессий пока нет. Создайте терминал или измените доступ на Mac."
    : "Подключите компьютер, чтобы увидеть доступные сессии.";
  $("open-connection").dataset.connected = String(
    $("connection").textContent.startsWith("Компьютер подключён"),
  );
  $("clock").textContent = new Date().toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
  $("summary").textContent =
    `${model.sessions.length} терминалов · ${model.sessions.filter((s) => s.status === "working").length} в работе`;
  $("title").textContent =
    model.view === "home"
      ? "Home CanvasTTY"
      : model.sessions.find((s) => s.id === model.sessionId)?.title ||
        "Терминал";
  $("phase").textContent = statusLabel();
  $("answer").textContent =
    model.view === "home"
      ? "Выберите терминал из списка."
      : model.choiceBody() || "Ответа пока нет.";
  $("rename-form").hidden = !model.renameDialog;
  $("rename-current").textContent = model.renameDialog?.original || "";
  $("rename-preview").textContent = model.renameDialog?.draft || "";
  $("rename-save").disabled =
    controlBusy || voiceBusy || wanted || !model.renameDialog?.draft;
  $("rename-cancel").disabled = controlBusy;
  $("rename-input").disabled = controlBusy || voiceBusy || wanted;
  $("rename-terminal").disabled =
    controlBusy ||
    voiceBusy ||
    createBusy ||
    wanted ||
    !selectedSession() ||
    latestHome?.features?.sessionRename !== true;
  $("close-dialog").hidden = !model.closeDialog;
  $("close-title").textContent = model.closeDialog
    ? "Закрыть «" + model.closeDialog.title + "»?"
    : "";
  $("close-confirm").disabled = controlBusy;
  $("close-cancel").disabled = controlBusy;
  for (const button of document.querySelectorAll("[data-new]"))
    button.disabled =
      createBusy || !token || latestHome?.features?.sessionCreate !== true;
  $("close-terminal").disabled =
    controlBusy ||
    !selectedSession() ||
    latestHome?.features?.sessionClose !== true;
  $("project-browser").disabled =
    controlBusy ||
    !selectedSession() ||
    latestHome?.features?.projectBrowser !== true;
  $("page").textContent =
    model.view === "terminal" && model.interaction
      ? `Вариант ${model.choiceSelection + 1}/${model.interaction.options.length}`
      : `${model.page + 1}/${model.pages().length}`;
  $("voice").disabled =
    !native ||
    !token ||
    (!model.renameDialog &&
      (model.view !== "terminal" || !model.sessionId || !!model.interaction)) ||
    !!model.closeDialog ||
    !!model.createDialog ||
    !foreground ||
    overlay ||
    createBusy ||
    voiceBusy ||
    controlBusy ||
    (!wanted && (micPending > 0 || !!micOffRequest)) ||
    latestHome?.speechAvailable === false;
  $("voice").classList.toggle("recording", wanted && mic === true);
  $("voice").textContent = wanted
    ? mic === true
      ? "Говорите. Отпустите для отправки."
      : "Включаю микрофон…"
    : micFault
      ? "Удерживайте, чтобы повторить включение"
      : model.renameDialog
        ? "Удерживайте, чтобы назвать терминал"
        : "Удерживайте, чтобы говорить";
  $("mic-status").textContent = !micUsed
    ? "Микрофон ещё не включался приложением."
    : mic === null
      ? micPending > 0
        ? "Жду завершения команды микрофона."
        : "Состояние микрофона не подтверждено. Удерживайте для новой попытки или нажмите «Выключить микрофон»."
      : mic === true
        ? "Микрофон G2 включён."
        : micFault || "Микрофон выключен.";
  $("mic-stop").disabled =
    !native || !foreground || overlay || !micUsed || (mic === false && !wanted);
  $("mic-test").disabled =
    !native ||
    !foreground ||
    overlay ||
    wanted ||
    voiceBusy ||
    controlBusy ||
    !!micOffRequest ||
    micPending > 0;
  $("choices").hidden =
    !!model.renameDialog || model.view !== "terminal" || !model.interaction;
  $("choose").disabled = controlBusy;
  $("custom").disabled = controlBusy || model.interaction?.customIndex == null;
  $("manual").hidden =
    model.view !== "terminal" ||
    !!model.interaction ||
    latestHome?.features?.manualInput !== true ||
    !!model.renameDialog;
  $("send-text").disabled = controlBusy || voiceBusy;
  $("notice").textContent =
    notice ||
    "Свайп — выбор или страница. Клик — открыть. Удержание — голос. Home и создание — пункты системного меню очков.";
  const override = createBusy
    ? "СОЗДАЮ ТЕРМИНАЛ\nНа Mac…"
    : wanted
      ? micTest
        ? "ПРОВЕРКА МИКРОФОНА\nАгенту ничего не отправляется."
        : mic === true
          ? voicePurpose === "rename"
            ? "НОВОЕ ИМЯ\nПроизнесите название и отпустите."
            : "СЛУШАЮ\nОтпустите удержание, когда закончите."
          : "ВКЛЮЧАЮ МИКРОФОН\nЖду подтверждение G2."
      : voiceBusy && model.view === "terminal"
        ? "РАСПОЗНАЮ НА MAC\nМикрофон выключен."
        : "";
  const warning =
    !wanted && micUsed && mic !== false
      ? mic === null
        ? micPending > 0
          ? "Микрофон: жду ответ G2"
          : "Микрофон: удержите для повтора"
        : "Микрофон: выключаю…"
      : controlBusy
        ? "Передаю выбор…"
        : controlFeedback;
  const frame = model.frame(override, warning);
  $("hud").textContent = frame;
  if (frame !== lastFrame && foreground && !overlay) {
    lastFrame = frame;
    if (hud?.started) {
      void hud.render(frame).then((ok) => {
        if (frame === lastFrame)
          $("ack").textContent = ok
            ? "Дисплей подтвердил обновление"
            : "Обновление дисплея не подтверждено";
      });
    }
  }
}
function renderHome() {
  const host = $("sessions"),
    signature = JSON.stringify(
      model.sessions.map((s) => [s.id, s.title, s.status]),
    );
  if (host.dataset.signature !== signature) {
    host.dataset.signature = signature;
    host.replaceChildren();
    for (const s of model.sessions) {
      const button = document.createElement("button");
      button.className = "session";
      button.dataset.id = s.id;
      button.textContent = s.title;
      const detail = document.createElement("small");
      detail.textContent = `${s.provider} · ${STATUS[s.status] || s.status}`;
      button.append(detail);
      button.onclick = () => void openSession(s.id);
      host.append(button);
    }
  }
  for (const b of host.children)
    b.classList.toggle("active", b.dataset.id === model.sessionId);
  const limits = $("limits");
  limits.replaceChildren();
  for (const p of model.limits?.providers || []) {
    if (p.state === "unavailable") continue;
    const w =
      p.windows?.find((w) => w.isDefaultBucket && w.usedPercent !== null) ||
      p.windows?.find((w) => w.usedPercent !== null);
    if (!w) continue;
    const row = document.createElement("div");
    row.textContent = `${p.provider}: ${w.usedPercent}% использовано${p.state === "stale" ? " (прошлые данные)" : ""}`;
    limits.append(row);
  }
  if (!limits.childNodes.length) limits.textContent = "Нет данных";
}
async function openSession(sessionId) {
  model.createDialog = null;
  setPanel("workspace");
  model.closeDialog = null;
  model.renameDialog = null;
  void stopVoice(false);
  if (model.sessionId) drafts.set(model.sessionId, $("draft").value);
  model.open(sessionId);
  $("draft").value = drafts.get(sessionId) || "";
  model.selection = Math.max(
    0,
    model.sessions.findIndex((s) => s.id === sessionId),
  );
  notice = "";
  controlFeedback = "";
  trace("navigation:terminal");
  paint();
  try {
    model.terminal(
      await request("/g2/api/terminal?id=" + encodeURIComponent(sessionId)),
    );
    paint();
  } catch (e) {
    model.loadFailed(sessionId);
    notice = e.message;
    paint();
  }
}
async function home() {
  model.createDialog = null;
  setPanel("workspace");
  model.closeDialog = null;
  model.renameDialog = null;
  void stopVoice(false);
  model.view = "home";
  notice = "";
  controlFeedback = "";
  trace("navigation:home");
  paint();
}
function selectedSession() {
  return model.view === "terminal"
    ? model.sessions.find((s) => s.id === model.sessionId)
    : model.sessions[model.selection];
}
function requestRename() {
  if (
    controlBusy ||
    voiceBusy ||
    createBusy ||
    wanted ||
    latestHome?.features?.sessionRename !== true
  )
    return;
  const session = selectedSession();
  if (!session) return;
  void stopVoice(false, "rename-open");
  model.closeDialog = null;
  model.renameDialog = {
    sessionId: session.id,
    original: session.title,
    draft: "",
    selected: 0,
    requestId: id(),
  };
  $("rename-input").value = "";
  notice = "Продиктуйте новое имя удержанием или введите его ниже.";
  controlFeedback = "";
  setPanel("workspace");
  paint();
  $("rename-form").scrollIntoView?.({ block: "center" });
}
function cancelRename() {
  if (controlBusy) return;
  model.renameDialog = null;
  void stopVoice(false, "rename-cancel");
  notice = "Переименование отменено.";
  paint();
}
function renameDraft(value) {
  if (!model.renameDialog || controlBusy || voiceBusy || wanted) return;
  try {
    model.renameDialog.draft = normalizeSessionTitle(value);
    notice = "Проверьте имя и нажмите «Сохранить».";
  } catch {
    model.renameDialog.draft = "";
    notice = "Введите имя от 1 до 80 символов.";
  }
  model.renameDialog.selected = 0;
  model.renameDialog.requestId = id();
  paint();
}
async function confirmRename(fromPhone = false) {
  const dialog = model.renameDialog;
  if (!dialog || !dialog.draft || controlBusy || voiceBusy || wanted) return;
  if (!fromPhone && dialog.selected === 0) {
    cancelRename();
    return;
  }
  controlBusy = true;
  controlFeedback = "Сохраняю имя…";
  paint();
  try {
    const result = await request("/g2/api/session-rename", {
      sessionId: dialog.sessionId,
      title: normalizeSessionTitle(dialog.draft),
      requestId: dialog.requestId,
    });
    if (result.session?.id !== dialog.sessionId)
      throw new Error("invalid-session");
    if (latestHome) {
      latestHome = {
        ...latestHome,
        sessions: latestHome.sessions.map((session) =>
          session.id === dialog.sessionId ? result.session : session,
        ),
      };
      model.home(latestHome);
      renderHome();
    }
    if (model.renameDialog === dialog) model.renameDialog = null;
    notice = "Новое имя: " + result.session.title;
    controlFeedback = "Имя сохранено";
    trace("terminal:renamed");
  } catch {
    notice = "Переименование не подтверждено. Проверьте имя в списке.";
    controlFeedback = "Имя не подтверждено";
  } finally {
    controlBusy = false;
    paint();
  }
}
function requestClose() {
  setPanel("workspace");
  if (controlBusy || latestHome?.features?.sessionClose !== true) return;
  const session = selectedSession();
  if (!session) return;
  void stopVoice(false);
  model.renameDialog = null;
  model.closeDialog = {
    sessionId: session.id,
    title: session.title,
    selected: 0,
    requestId: id(),
  };
  paint();
}
async function confirmClose() {
  const dialog = model.closeDialog;
  if (!dialog || controlBusy) return;
  if (dialog.selected === 0) {
    model.closeDialog = null;
    paint();
    return;
  }
  controlBusy = true;
  paint();
  try {
    await request("/g2/api/session-close", {
      sessionId: dialog.sessionId,
      requestId: dialog.requestId,
    });
    drafts.delete(dialog.sessionId);
    model.closeDialog = null;
    latestHome = await request("/g2/api/home");
    model.home(latestHome);
    renderHome();
    notice = "Терминал закрыт. Файлы проекта сохранены.";
    trace("terminal:closed");
  } catch {
    notice = "Закрытие не подтверждено. Проверьте список терминалов.";
  } finally {
    controlBusy = false;
    paint();
  }
}
async function openProjectBrowser() {
  const session = selectedSession();
  if (!session || controlBusy || latestHome?.features?.projectBrowser !== true)
    return;
  void stopVoice(false);
  model.closeDialog = null;
  model.renameDialog = null;
  controlBusy = true;
  paint();
  try {
    const result = await request("/g2/api/browser", {
      sessionId: session.id,
      requestId: id(),
    });
    controlFeedback = "Браузер открыт на Mac";
    notice =
      (result.title || "Браузер проекта") +
      (result.url ? " · " + result.url : "") +
      ". Управляйте страницей поручениями агенту.";
    trace("browser:opened");
  } catch {
    notice = "Открытие браузера не подтверждено.";
    controlFeedback = "Браузер: ошибка";
  } finally {
    controlBusy = false;
    paint();
  }
}
async function chooseOption(custom = false) {
  const menu = model.interaction;
  if (!menu || controlBusy || model.view !== "terminal") return;
  if (custom && menu.customIndex == null) {
    notice = "В этом меню нет варианта для своего текста.";
    controlFeedback = "Свой ответ не предусмотрен";
    paint();
    return;
  }
  const sessionId = model.sessionId,
    index = custom ? menu.customIndex : model.choiceSelection;
  controlBusy = true;
  controlFeedback = "";
  void stopVoice(false);
  paint();
  try {
    await request("/g2/api/control", {
      sessionId,
      requestId: id(),
      menuId: menu.id,
      index,
      action: custom ? "custom" : "choose",
    });
    model.dismissMenu(menu.id);
    notice = custom
      ? "Введите свой ответ в поле ниже."
      : "Нажатия переданы Codex.";
    trace("choice:accepted");
  } catch {
    notice = "Выбор не подтверждён. Проверьте обновлённое меню перед повтором.";
    controlFeedback = "Выбор не подтверждён";
  } finally {
    controlBusy = false;
    paint();
  }
}
function chooseAgent() {
  if (createBusy || voiceBusy || controlBusy || wanted || latestHome?.features?.sessionCreate !== true) return;
  model.renameDialog = null;
  model.closeDialog = null;
  model.createDialog = { providers: MORE_AGENTS, selected: 0 };
  notice = "Выберите агента на очках: свайп и клик. Двойной клик — отмена.";
  paint();
}
async function createSession(provider) {
  if (createBusy || latestHome?.features?.sessionCreate !== true) return;
  createBusy = true;
  model.createDialog = null;
  model.renameDialog = null;
  model.closeDialog = null;
  notice = "";
  paint();
  for (const b of document.querySelectorAll("[data-new]")) b.disabled = true;
  try {
    void stopVoice(false);
    const d = await request("/g2/api/create", { provider });
    latestHome = await request("/g2/api/home");
    model.home(latestHome);
    renderHome();
    await openSession(d.session.id);
  } catch (e) {
    notice =
      "Создание не подтверждено. Проверьте список перед повтором. " + e.message;
  } finally {
    createBusy = false;
    for (const b of document.querySelectorAll("[data-new]")) b.disabled = false;
    paint();
  }
}
async function back() {
  if (model.createDialog) { model.createDialog = null; notice = ""; paint(); return; }
  if (model.renameDialog) {
    cancelRename();
    return;
  }
  if (model.closeDialog) {
    model.closeDialog = null;
    paint();
    return;
  }
  if (model.view === "terminal") return home();
  if (exitBusy) return;
  exitBusy = true;
  try {
    void stopVoice(false);
    // The OS asks for confirmation. Keep our page alive if the user cancels.
    if (native && (await native.shutDownPageContainer(1)) !== true) {
      notice = "Меню выхода не открылось. Приложение продолжает работать.";
      paint();
    }
  } finally {
    exitBusy = false;
  }
}
async function startVoice(test = false) {
  const renameTarget = !test ? model.renameDialog : null;
  if (
    !native ||
    !token ||
    !foreground ||
    overlay ||
    voiceBusy ||
    createBusy ||
    controlBusy ||
    model.closeDialog ||
    model.createDialog ||
    (!test &&
      !renameTarget &&
      (model.view !== "terminal" || !model.sessionId || model.interaction)) ||
    wanted ||
    micPending > 0 ||
    micOffRequest ||
    (!test && latestHome?.speechAvailable === false)
  )
    return;
  // A settled rejection is not a permanently busy channel. A new explicit
  // hold may ask for ON again; only its own true ACK permits collecting PCM.
  // Pending native operations remain a barrier, even after a caller timeout.
  if (micFault) trace("mic:retry user-requested");
  const ticket = ++generation;
  wanted = true;
  micTest = test;
  micTestBytes = 0;
  clearAudio();
  voiceSession = test ? null : renameTarget?.sessionId || model.sessionId;
  voicePurpose = renameTarget ? "rename" : "input";
  voiceRenameTarget = renameTarget;
  startedAt = lastAudioAt = Date.now();
  notice = "";
  paint();
  try {
    if ((await setMic(true, ticket)) !== true) return;
    if (ticket === generation) {
      paint();
      if (test) micTestTimer = setTimeout(() => void stopVoice(false), 2000);
    }
  } catch (e) {
    if (ticket !== generation) return;
    wanted = false;
    micTest = false;
    try {
      if (micUsed) await setMic(false, ticket);
    } catch {}
    notice = e.message;
    paint();
  }
}
async function stopVoice(submit, reason = "explicit", forceOff = false) {
  const wasTest = micTest,
    testBytes = micTestBytes;
  micTest = false;
  if (micTestTimer) {
    clearTimeout(micTestTimer);
    micTestTimer = null;
  }
  if (wasTest) submit = false;
  const hadWanted = wanted;
  const purpose = voicePurpose,
    renameTarget = voiceRenameTarget;
  wanted = false;
  const ticket = ++generation;
  const chunks = parts;
  parts = [];
  const length = size;
  size = 0;
  lastCaptureBytes = wasTest ? testBytes : length;
  if (hadWanted || forceOff)
    trace(
      "voice:stop " +
        reason +
        " bytes=" +
        length +
        " elapsed=" +
        Math.max(0, Date.now() - startedAt),
    );
  if (!submit) {
    for (const c of chunks) c.fill(0);
    if (voiceRequest)
      void request("/g2/api/cancel", { requestId: voiceRequest }).catch(
        () => {},
      );
  }
  paint();
  if (
    native &&
    micUsed &&
    (mic === true || hadWanted || micOffRequest || forceOff)
  ) {
    try {
      await setMic(false, ticket);
    } catch (e) {
      for (const c of chunks) c.fill(0);
      notice = e.message;
      paint();
      return;
    }
  }
  if (!submit) {
    if (wasTest) {
      notice = testBytes
        ? "Тест: получено " +
          testBytes +
          " байт с G2. Агенту ничего не отправлено."
        : "Тест: аудиоданные с G2 не получены. Агенту ничего не отправлено.";
      trace("mic:test bytes=" + testBytes);
    }
    paint();
    return;
  }
  if (!hadWanted || ticket !== generation) {
    for (const c of chunks) c.fill(0);
    return;
  }
  if (length < 6400) {
    for (const c of chunks) c.fill(0);
    notice = "Недостаточно звука с очков. Повторите фразу.";
    paint();
    return;
  }
  const pcm = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    pcm.set(c, offset);
    offset += c.length;
    c.fill(0);
  }
  let binary = "";
  for (let i = 0; i < pcm.length; i += 8192)
    binary += String.fromCharCode(...pcm.subarray(i, i + 8192));
  pcm.fill(0);
  const requestId = id(),
    sessionId = voiceSession;
  voiceRequest = requestId;
  voiceBusy = true;
  paint();
  try {
    const result = await request("/g2/api/voice", {
      requestId,
      sessionId,
      purpose,
      audio: btoa(binary),
    });
    binary = "";
    if (ticket !== generation) return;
    if (result.accepted && purpose === "rename") {
      if (model.renameDialog !== renameTarget) return;
      const title = normalizeSessionTitle(result.transcript);
      renameTarget.draft = title;
      renameTarget.selected = 0;
      renameTarget.requestId = id();
      $("rename-input").value = title;
      notice =
        "Проверьте имя: " +
        title +
        ". Для сохранения выберите «Сохранить имя».";
    } else if (result.accepted) {
      model.pendingOwn = true;
      notice = "Отправлено: " + result.transcript;
    } else
      notice = result.cancelled
        ? "Отменено"
        : "Речь не распознана. Команда не отправлена.";
  } catch {
    notice =
      "Результат передачи неизвестен. Проверьте терминал перед повтором.";
  } finally {
    if (voiceRequest === requestId) {
      voiceRequest = null;
      voiceBusy = false;
    }
    paint();
  }
}
const gestures = new Gestures({
  select: () => {
    if (model.createDialog) {
      const selected = model.createDialog.providers[model.createDialog.selected];
      if (selected) void createSession(selected.provider);
    }
    else if (model.renameDialog) void confirmRename();
    else if (model.closeDialog) void confirmClose();
    else if (model.view === "terminal" && model.interaction)
      void chooseOption();
    else if (model.view !== "terminal" && model.sessions.length)
      void openSession(model.sessions[model.selection].id);
  },
  back: () => void back(),
  record: () => {
    if (model.closeDialog || model.createDialog) return;
    if (model.renameDialog) {
      void startVoice();
      return;
    }
    if (model.view === "terminal" && model.interaction) void chooseOption(true);
    else void startVoice();
  },
  send: () => void stopVoice(true, "hold-release"),
});
async function event(e) {
  if (e.menuItemClickEvent) {
    gestures.cancel();
    const item = e.menuItemClickEvent.itemID;
    if (item !== 7) model.createDialog = null;
    trace("menu:" + Number(item));
    if (item === 1) await home();
    else if (item === 2) await createSession("codex");
    else if (item === 3) await createSession("terminal");
    else if (item === 4) requestClose();
    else if (item === 5) await openProjectBrowser();
    else if (item === 6) requestRename();
    else if (item === 7) chooseAgent();
    return;
  }
  if (e.audioEvent) {
    const a = e.audioEvent;
    if (
      !wanted ||
      mic !== true ||
      !foreground ||
      a.source !== sdk.AudioInputSource.Glasses
    )
      return;
    if (
      !(a.audioPcm instanceof Uint8Array) ||
      a.audioPcm.length % 2 ||
      a.audioPcm.length > 32000
    )
      return;
    if (micTest) {
      micTestBytes += a.audioPcm.length;
      lastAudioAt = Date.now();
      return;
    }
    if (size + a.audioPcm.length > 960000) {
      await stopVoice(false);
      notice = "Фраза длиннее 30 секунд. Она не отправлена.";
      paint();
      return;
    }
    if (a.audioPcm.length) {
      parts.push(a.audioPcm.slice());
      size += a.audioPcm.length;
      lastAudioAt = Date.now();
    }
    return;
  }
  const input = inputEvent(e, sdk);
  if (!input) return;
  const t = input.type;
  trace(
    input.kind +
      ":" +
      t +
      (input.defaulted ? " default-zero" : "") +
      " view=" +
      model.view +
      " overlay=" +
      overlay,
  );
  // These events describe the OS overlay, not destruction/recreation of our page.
  if (t === sdk.OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    overlay = true;
    gestures.cancel();
    void stopVoice(false);
    return;
  }
  if (t === sdk.OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    overlay = false;
    lastFrame = "";
    paint();
    return;
  }
  if (
    t === sdk.OsEventTypeList.ABNORMAL_EXIT_EVENT ||
    t === sdk.OsEventTypeList.SYSTEM_EXIT_EVENT
  ) {
    foreground = false;
    gestures.cancel();
    void stopVoice(false);
    await hud.suspend();
    return;
  }
  if (!foreground || overlay) return;
  if (t === sdk.OsEventTypeList.LONG_PRESS_EVENT) gestures.long();
  else if (t === sdk.OsEventTypeList.LONG_PRESS_RELEASE_EVENT)
    gestures.release();
  else if (t === sdk.OsEventTypeList.DOUBLE_CLICK_EVENT) gestures.double();
  else if (t === sdk.OsEventTypeList.CLICK_EVENT) gestures.click();
  else if (t === sdk.OsEventTypeList.SCROLL_TOP_EVENT) {
    controlFeedback = "";
    model.scroll(-1);
    paint();
  } else if (t === sdk.OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    controlFeedback = "";
    model.scroll(1);
    paint();
  }
}
async function poll() {
  if (!alive) return;
  try {
    if (token && foreground) {
      latestHome = await request("/g2/api/home");
      model.home(latestHome);
      renderHome();
      const selected =
        model.view === "terminal"
          ? model.sessionId
          : model.sessions[model.selection]?.id;
      if (selected) {
        const data = await request(
          "/g2/api/terminal?id=" + encodeURIComponent(selected),
        );
        model.terminal(data);
      }
      if (native) {
        const state = {
          clientVersion: "0.5.6",
          display: hud?.displayState === "confirmed" ? "confirmed" : "unknown",
          microphone: !micUsed
            ? "never"
            : mic === null
              ? "unknown"
              : mic
                ? "on"
                : "off",
          audioBytes: lastCaptureBytes,
          error: micFault,
          diagnostics: [
            ...new Set([...micDiagnostics, ...diagnostics.slice(-8)]),
          ]
            .sort()
            .slice(-24),
        };
        const signature = JSON.stringify(state);
        if (signature !== telemetrySignature) {
          await request("/g2/api/device-state", state);
          telemetrySignature = signature;
        }
      }
      $("connection").textContent = native
        ? "Компьютер подключён · G2"
        : "Предпросмотр · без очков";
      paint();
    }
  } catch {
    $("connection").textContent = token
      ? "Компьютер недоступен"
      : "Нужно подключение";
    if (model.sessionId) model.loadFailed(model.sessionId);
    if (wanted) await stopVoice(false);
    paint();
  } finally {
    if (alive) setTimeout(() => void poll(), 1200);
  }
}
$("home").onclick = () => void home();
$("prev").onclick = () => {
  model.scroll(-1);
  paint();
};
$("next").onclick = () => {
  model.scroll(1);
  paint();
};
$("back-home").onclick = () => void home();
$("mic-stop").onclick = () => stopVoice(false, "retry-stop", true);
$("rename-terminal").onclick = requestRename;
$("rename-input").oninput = () => renameDraft($("rename-input").value);
$("rename-form").onsubmit = (e) => {
  e.preventDefault();
  return confirmRename(true);
};
$("rename-cancel").onclick = cancelRename;
$("close-terminal").onclick = requestClose;
$("project-browser").onclick = openProjectBrowser;
$("close-cancel").onclick = () => {
  if (!controlBusy) {
    model.closeDialog = null;
    paint();
  }
};
$("close-confirm").onclick = () => {
  if (model.closeDialog) {
    model.closeDialog.selected = 1;
    return confirmClose();
  }
};
$("mic-test").onclick = () => startVoice(true);
$("choose").onclick = () => chooseOption();
$("custom").onclick = () => chooseOption(true);
$("manual").onsubmit = async (e) => {
  e.preventDefault();
  if (
    controlBusy ||
    voiceBusy ||
    model.view !== "terminal" ||
    model.interaction ||
    model.renameDialog
  )
    return;
  const sessionId = model.sessionId,
    text = $("draft").value;
  if (!text.trim()) return;
  controlBusy = true;
  paint();
  try {
    await request("/g2/api/control", {
      sessionId,
      requestId: id(),
      action: "text",
      text,
    });
    drafts.delete(sessionId);
    if (model.sessionId === sessionId) {
      $("draft").value = "";
      model.pendingOwn = true;
      notice = "Текст передан в терминал.";
    }
  } catch {
    notice =
      "Передача текста не подтверждена. Проверьте терминал перед повтором.";
  } finally {
    controlBusy = false;
    paint();
  }
};
$("voice").onpointerdown = (e) => {
  e.preventDefault();
  e.currentTarget.setPointerCapture(e.pointerId);
  void startVoice();
};
$("voice").onpointerup = (e) => {
  e.preventDefault();
  void stopVoice(true);
};
$("voice").onpointercancel = () => void stopVoice(false);
for (const b of document.querySelectorAll("[data-new]"))
  b.onclick = () => createSession(b.dataset.new);
async function connectComputer(candidate) {
  if (pairBusy) return;
  $("pair-status").textContent = "";
  if (!candidate && token) {
    notice = "Компьютер уже подключён. Выберите терминал.";
    $("pair").closest("details").open = false;
    paint();
    return;
  }
  pairBusy = true;
  $("pair-submit").disabled = true;
  try {
    pairAbort = new AbortController();
    $("pair-status").textContent = "Соединяюсь с Mac по локальной сети…";
    const resolved = LOCAL_ONLY
      ? await connectionFromCode(candidate, { signal: pairAbort.signal, onTrace: message => trace("pair:" + message) })
      : null;
    const target = resolved?.connection || null;
    candidate = resolved?.code || candidate;
    const targetFetch = target ? localFetcher(target) : fetch;
    const paired = await validatePairing(candidate, {
      probe: (code) =>
        pairComputer(target?.origins[0] || BASE, code, {
          fetcher: targetFetch,
          signal: pairAbort.signal,
          onPending: () => {
            $("pair-status").textContent =
              "Подтвердите подключение в CanvasTTY на компьютере.";
          },
        }),
      persist: native
        ? (key) =>
            target
              ? native.setLocalStorage(
                  CONNECTION_KEY,
                  JSON.stringify({
                    connection: targetFetch.connection(),
                    token: key,
                  }),
                )
              : native.setLocalStorage(KEY, key)
        : null,
    });
    token = paired.token;
    localConnection = target ? targetFetch.connection() : null;
    localFetch = target ? targetFetch : null;
    latestHome = paired.home;
    $("token").value = "";
    model.home(latestHome);
    renderHome();
    notice = "Компьютер подключён";
    $("connection").textContent = native
      ? "Компьютер подключён · G2"
      : "Предпросмотр · без очков";
    $("pair").closest("details").open = false;
    setPanel("workspace");
  } catch (e) {
    notice = e.name === "AbortError" ? "Подключение отменено." : e.message;
    $("pair-status").textContent = notice + (e.diagnostics?.length ? "\n" + e.diagnostics[0] : "");
  } finally {
    pairAbort = null;
    pairBusy = false;
    $("pair-submit").disabled = false;
    paint();
  }
}
$("pair").onsubmit = (e) => {
  e.preventDefault();
  return connectComputer($("token").value.trim());
};
setInterval(() => {
  if (
    wanted &&
    (Date.now() - lastAudioAt > 8000 || Date.now() - startedAt > 30000)
  ) {
    const reason =
      Date.now() - lastAudioAt > 8000 ? "audio-gap" : "max-duration";
    void stopVoice(false, reason).then(() => {
      notice =
        "Приём остановлен: нет звука или превышено 30 секунд. Фраза не отправлена.";
      paint();
    });
  }
}, 1000);
window.addEventListener("pagehide", () => {
  trace("lifecycle:pagehide");
  pairAbort?.abort();
  alive = false;
  foreground = false;
  void stopVoice(false);
  void hud?.suspend();
});
try {
  native = await Promise.race([
    sdk.waitForEvenAppBridge(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("No native bridge")), 5000),
    ),
  ]);
  if (typeof native.callEvenApp === "function") {
    const hostCall = native.callEvenApp.bind(native);
    native.callEvenApp = async (method, params) => {
      const result = await hostCall(method, params);
      if (method === "audioControl")
        trace(
          "mic:host " +
            (params?.isOpen ? "on" : "off") +
            " result=" +
            (result === null || ["boolean", "number"].includes(typeof result)
              ? JSON.stringify(result)
              : typeof result),
        );
      return result;
    };
  }
  if (!(await native.getDeviceInfo())) throw new Error("No glasses");
  hud = new HudBridge(native, sdk);
  native.onEvenHubEvent(
    (e) => void event(e).catch(() => void stopVoice(false)),
  );
  if (!(await hud.startPage())) throw new Error("No display acknowledgment");
  // No off probe at startup: an idle microphone can reject it. Do not claim
  // hardware is off; first enable is an explicit user request requiring ACK.
  trace("startup: microphone not requested");
  if (LOCAL_ONLY) {
    const saved = await native.getLocalStorage(CONNECTION_KEY);
    if (saved) {
      try {
        const value = readLocalConnection(saved);
        token = value.token;
        localConnection = value.connection;
        localFetch = localFetcher(localConnection);
      } catch {
        notice = "Введите новый код подключения с компьютера.";
      }
    }
  } else token = (await native.getLocalStorage(KEY)) || "";
} catch {
  native = null;
  hud = null;
}
$("open-connection").onclick = () => {
  void stopVoice(false, "connection");
  setPanel("connection");
};
$("pair-cancel").onclick = () => pairAbort?.abort();
for (const button of document.querySelectorAll("[data-panel]"))
  button.onclick = () => setPanel(button.dataset.panel);
const offeredCode = new URLSearchParams(location.hash.slice(1)).get("pair");
if (offeredCode && /^\d{6}$/.test(offeredCode)) {
  $("token").value = offeredCode;
  $("pair-status").textContent =
    "Нажмите «Подключить компьютер», затем подтвердите запрос на Mac.";
  history.replaceState(null, "", location.pathname + location.search);
}
setPanel(offeredCode || !token ? "connection" : "workspace");
$("connection").textContent = token
  ? "Проверяю подключение…"
  : "Нужно подключение";
paint();
void poll();
