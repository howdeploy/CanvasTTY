import { useEffect, useRef, useState } from "react";
import type { LocaleId } from "../../../../shared/contracts";
import type {
  EvenG2Config,
  EvenG2State,
  EvenG2Command,
} from "../../../../shared/evenG2";
import { UiIcon } from "../../components/UiIcon";
import "./evenG2Controls.css";

type Stage = "overview" | "transport" | "scope" | "pair";
export function EvenG2Controls({
  locale,
}: {
  locale: LocaleId;
}): React.JSX.Element {
  const ru = locale === "ru";
  const text = (en: string, russian: string) => (ru ? russian : en);
  const [state, setState] = useState<EvenG2State | null>(null);
  const [draft, setDraft] = useState<EvenG2Config | null>(null);
  const [editing, setEditing] = useState(false);
  const [stage, setStage] = useState<Stage>("overview");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revoke, setRevoke] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const initialized = useRef(false);
  const pairRequested = useRef(false);
  const preparingSpeech = useRef(false);
  useEffect(() => { panelRef.current?.scrollIntoView({ block: "start" }); }, [stage]);
  useEffect(() => {
    let active = true;
    const read = () =>
      void window.canvasTTY.evenG2
        .state()
        .then((next) => {
          if (!active) return;
          setState(next);
          if (
            preparingSpeech.current &&
            next.speechSetup?.phase === "ready" &&
            next.config.speechExecutable.endsWith("canvastty-speech")
          ) {
            preparingSpeech.current = false;
            setDraft((previous) =>
              previous
                ? {
                    ...previous,
                    speechExecutable: next.config.speechExecutable,
                    speechModel: next.config.speechModel,
                  }
                : next.config,
            );
          }
          if (!initialized.current) {
            setDraft(next.config);
            initialized.current = true;
          }
        })
        .catch(() => {
          if (active)
            setError(
              text(
                "Connection settings unavailable.",
                "Настройки подключения недоступны.",
              ),
            );
        });
    read();
    const timer = setInterval(read, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [locale]);
  useEffect(() => {
    if (
      stage === "pair" &&
      state?.config.enabled &&
      state.transport.ready &&
      !state.pairing &&
      !pairRequested.current &&
      !busy
    ) {
      pairRequested.current = true;
      void command({ type: "begin-pairing" });
    }
  }, [stage, state, busy]);
  async function command(value: EvenG2Command): Promise<EvenG2State | null> {
    setBusy(true);
    setError("");
    try {
      const next = await window.canvasTTY.evenG2.command(value);
      setState(next);
      return next;
    } catch {
      setError(
        text(
          "The action was not completed. Check the connection and settings.",
          "Действие не завершено. Проверьте соединение и параметры.",
        ),
      );
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function refresh(): Promise<void> {
    const next = await command({ type: "refresh" });
    if (next)
      setDraft((previous) =>
        previous
          ? {
              ...previous,
              interfaceName:
                previous.interfaceName ||
                next.transport.addresses[0]?.name ||
                "",
            }
          : next.config,
      );
  }
  async function saveAndPair(): Promise<void> {
    if (!draft) return;
    const next = await command({
      type: "configure",
      config: { ...draft, enabled: true, publicOrigin: "" },
    });
    if (next) {
      setDraft(next.config);
      if (!editing) pairRequested.current = false;
      setStage(editing ? "overview" : "pair");
    }
  }
  async function cancel(): Promise<void> {
    await command({ type: "cancel-pairing" });
    setStage("overview");
  }
  const patch = (value: Partial<EvenG2Config>) =>
    setDraft((previous) => (previous ? { ...previous, ...value } : previous));
  if (!state || !draft)
    return (
      <section className="g2-settings" ref={panelRef}>
        <h3>Even G2</h3>
        <p>
          {error ||
            text(
              "Loading connection settings…",
              "Загрузка настроек подключения…",
            )}
        </p>
      </section>
    );
  const activePeers = state.peers.filter(
    (peer) => Date.now() - peer.lastSeen < 12000,
  );
  const selected = state.transport.addresses.find(
    (address) => address.name === draft.interfaceName,
  );
  const steps: Array<[Stage, string]> = [
    ["transport", text("Connection", "Связь")],
    ["scope", text("Access", "Доступ")],
    ["pair", text("Connect", "Подключение")],
  ];
  return (
    <section className="g2-settings" aria-label="Even G2">
      <header className="g2-settings__heading">
        <span className="g2-settings__icon">
          <svg
            width="34"
            height="22"
            viewBox="0 0 34 22"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="1"
              y="8"
              width="13"
              height="11"
              rx="4"
              stroke="currentColor"
              strokeWidth="2"
            />
            <rect
              x="20"
              y="8"
              width="13"
              height="11"
              rx="4"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              d="M14 12C16 10 18 10 20 12M2 9L5 2M32 9L29 2"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
        </span>
        <div>
          <span className="g2-settings__eyebrow">EVEN G2</span>
          <h3>
            {text("Your sessions. On your glasses.", "Ваши сессии — на очках.")}
          </h3>
          <p>
            {text(
              "Read responses, speak to an agent, and control shared terminals.",
              "Читайте ответы, диктуйте агенту и управляйте выбранными терминалами.",
            )}
          </p>
        </div>
        <span
          className={
            "g2-settings__status " + (activePeers.length ? "is-online" : "")
          }
        >
          {activePeers.length
            ? text("Connected", "Подключено")
            : state.config.enabled
              ? text("Enabled", "Включено")
              : text("Off", "Выключено")}
        </span>
      </header>
      {error && (
        <p className="g2-settings__error" role="alert">
          {error}
        </p>
      )}
      {stage === "overview" ? (
        <>
          <div className="g2-settings__entry">
            <p>
              {text(
                "Connect once. Choose what your glasses can access.",
                "Подключите один раз и выберите, что будет доступно с очков.",
              )}
            </p>
            <button
              className="g2-primary"
              onClick={async () => {
                setEditing(false);
                pairRequested.current = false;
                if (state.speech?.available === false && state.speechSetup?.supported) { setStage("scope"); return; }
                const configured = state.config.sessionIds.length > 0 || (state.config.allowCreate && !!state.config.workspace);
                if (configured && state.config.enabled && !state.config.publicOrigin && state.transport.ready) {
                  setStage("pair");
                } else if (configured) {
                  const next = await command({type:"configure",config:{...state.config,enabled:true,publicOrigin:"",interfaceName:""}});
                  if (next) { setDraft(next.config); setStage("pair"); }
                } else {
                  patch({publicOrigin:"",interfaceName:""}); setStage("scope"); void refresh();
                }
              }}
            >
              {text("Connect Even G2", "Подключить Even G2")}{" "}
              <UiIcon name="arrow" />
            </button>
          </div>
          <button onClick={() => setStage("transport")}>
            {text("Local network settings", "Параметры локальной сети")}
          </button>
          {state.peers.map((peer) => (
            <div className="g2-peer" key={peer.id}>
              <div className="g2-peer__top">
                <div>
                  <strong>{peer.name}</strong>
                  <p>
                    {Date.now() - peer.lastSeen < 12000
                      ? text("Even App is online", "Even App на связи")
                      : text("Waiting for Even App", "Ожидаю Even App")}
                  </p>
                </div>
                <button
                  onClick={() => {
                    setEditing(true);
                    setDraft({
                      ...state.config,
                      sessionIds: [...peer.grant.sessionIds],
                    });
                    setStage("scope");
                  }}
                >
                  {text("Manage access", "Изменить доступ")}
                </button>
              </div>
              <div className="g2-checks">
                <span>
                  <i
                    className={
                      peer.telemetry?.display === "confirmed" ? "pass" : ""
                    }
                  />
                  {text("Display", "Дисплей")}:{" "}
                  {peer.telemetry?.display === "confirmed"
                    ? text("acknowledged", "подтверждён")
                    : text("not checked", "не проверен")}
                </span>
                <span>
                  <i
                    className={
                      peer.telemetry?.microphone === "off" &&
                      peer.telemetry.audioBytes > 0
                        ? "pass"
                        : ""
                    }
                  />
                  {text("Microphone", "Микрофон")}:{" "}
                  {peer.telemetry?.microphone === "unknown"
                    ? text("unconfirmed", "не подтверждён")
                    : peer.telemetry?.audioBytes
                      ? text("audio received", "звук получен")
                      : text("not checked", "не проверен")}
                </span>
              </div>
              {peer.telemetry?.error && (
                <p className="g2-settings__error" role="status">
                  {peer.telemetry.error}
                </p>
              )}
              {!!peer.telemetry?.diagnostics?.length && (
                <details>
                  <summary>
                    {text("Device diagnostics", "Диагностика с телефона")}
                  </summary>
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      fontSize: 11,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {peer.telemetry.diagnostics.join("\n")}
                  </pre>
                </details>
              )}
              <p className="g2-muted">
                {text(
                  "In Even App, open Settings → Check microphone. It does not send audio to the agent.",
                  "В Even App откройте Настройки → Проверить микрофон. Этот тест не отправляет звук агенту.",
                )}
              </p>
              {revoke === peer.id ? (
                <div className="g2-actions">
                  <span>
                    {text(
                      "Revoke this device’s access?",
                      "Отозвать доступ устройства?",
                    )}
                  </span>
                  <button onClick={() => setRevoke(null)}>
                    {text("Cancel", "Отмена")}
                  </button>
                  <button
                    className="g2-danger"
                    onClick={() =>
                      void command({ type: "revoke", id: peer.id }).then(() =>
                        setRevoke(null),
                      )
                    }
                  >
                    {text("Revoke", "Отозвать")}
                  </button>
                </div>
              ) : (
                <button className="g2-link" onClick={() => setRevoke(peer.id)}>
                  {text("Disconnect device", "Отключить устройство")}
                </button>
              )}
            </div>
          ))}
          {state.config.enabled && (
            <button
              className="g2-link"
              disabled={busy}
              onClick={() =>
                void command({
                  type: "configure",
                  config: { ...state.config, enabled: false },
                }).then((next) => {
                  if (next) setDraft(next.config);
                })
              }
            >
              {text(
                "Turn off Even G2 integration",
                "Выключить интеграцию Even G2",
              )}
            </button>
          )}
        </>
      ) : (
        <>
          <nav
            className="g2-steps"
            aria-label={text("Connection steps", "Шаги подключения")}
          >
            {steps
              .filter(([id]) => id !== "transport")
              .map(([id, label], index) => (
                <button
                  key={id}
                  className={stage === id ? "active" : ""}
                  disabled={busy || (id === "pair" && !state.config.enabled)}
                  onClick={() => setStage(id)}
                >
                  <b>{index + 1}</b>
                  {label}
                </button>
              ))}
          </nav>
          {stage === "transport" && (
            <div className="g2-settings__body">
              <h4>{text("Connect to CanvasTTY", "Подключение к CanvasTTY")}</h4>
              <span className="g2-tag">
                {text(
                  "Direct local connection",
                  "Прямое локальное подключение",
                )}
              </span>
              <p className="g2-muted">
                {text(
                  "CanvasTTY chooses a local network automatically. Both devices must be on the same network.",
                  "CanvasTTY выбирает локальную сеть автоматически. Телефон и Mac должны быть в одной сети.",
                )}
              </p>
              {!draft.publicOrigin && (
                <>
                  <ol>
                    <li>
                      {text(
                        "Connect your phone and computer to the same Wi-Fi network.",
                        "Подключите телефон и компьютер к одной Wi-Fi-сети.",
                      )}
                    </li>
                    <li>
                      {text(
                        "Choose this computer’s address below, then choose which sessions to share.",
                        "Выберите адрес этого компьютера ниже, затем сессии для доступа с очков.",
                      )}
                    </li>
                    <li>
                      {text(
                        "Enter the code in the installed CanvasTTY G2 app in Even App.",
                        "Введите код в установленном CanvasTTY G2 в Even App.",
                      )}
                    </li>
                  </ol>
                  <label>
                    {text(
                      "Computer network address",
                      "Сетевой адрес компьютера",
                    )}
                    <select
                      value={draft.interfaceName}
                      onChange={(event) =>
                        patch({ interfaceName: event.target.value })
                      }
                    >
                      <option value="">
                        {text("Choose a network", "Выберите сеть")}
                      </option>
                      {state.transport.addresses.map((address) => (
                        <option key={address.id} value={address.name}>
                          {address.address} · {address.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              <div className="g2-actions">
                <span className="g2-muted">
                  {draft.publicOrigin
                    ? text("HTTPS address selected", "Выбран HTTPS-адрес")
                    : selected
                      ? text("Address available", "Адрес доступен")
                      : text(
                          "Connect this computer to Wi-Fi",
                          "Подключите компьютер к Wi-Fi",
                        )}
                </span>
                <button disabled={busy} onClick={() => void refresh()}>
                  {text("Refresh", "Обновить")}
                </button>
              </div>
              {!draft.publicOrigin && (
                <p className="g2-muted">
                  {text(
                    "This local preview uses HTTP on the selected interface. Use a trusted Wi-Fi network. Android debugging and an external server are not required.",
                    "Локальный режим использует HTTP на выбранном сетевом интерфейсе. Используйте доверенную Wi-Fi-сеть. Отладка Android и внешний сервер не требуются.",
                  )}
                </p>
              )}
              <div className="g2-actions">
                <button onClick={() => void cancel()}>
                  {text("Cancel", "Отмена")}
                </button>
                <button
                  className="g2-primary"
                  disabled={(!selected && !draft.publicOrigin) || busy}
                  onClick={() => setStage("scope")}
                >
                  {text("Choose access", "Выбрать доступ")}{" "}
                  <UiIcon name="arrow" />
                </button>
              </div>
            </div>
          )}
          {stage === "scope" && (
            <div className="g2-settings__body">
              <h4>
                {text(
                  "Choose the workspace and sessions",
                  "Выберите рабочую папку и сессии",
                )}
              </h4>
              <label>
                {text("Folder for new sessions", "Папка для новых сессий")}
                <div className="g2-path">
                  <span>
                    {draft.workspace ||
                      text("No folder selected", "Папка не выбрана")}
                  </span>
                  <button
                    onClick={() =>
                      void window.canvasTTY.dialog
                        .pickDirectory(draft.workspace || undefined)
                        .then((path) => {
                          if (path) patch({ workspace: path });
                        })
                    }
                  >
                    <UiIcon name="folder" />
                    {text("Choose", "Выбрать")}
                  </button>
                </div>
              </label>
              <div className="g2-session-list">
                {state.availableSessions.length ? (
                  state.availableSessions.map((session) => (
                    <label key={session.id}>
                      <input
                        type="checkbox"
                        checked={draft.sessionIds.includes(session.id)}
                        onChange={(e) =>
                          patch({
                            sessionIds: e.target.checked
                              ? [...draft.sessionIds, session.id]
                              : draft.sessionIds.filter(
                                  (id) => id !== session.id,
                                ),
                          })
                        }
                      />
                      <span>
                        {session.title}
                        <small>{session.provider}</small>
                      </span>
                    </label>
                  ))
                ) : (
                  <p className="g2-muted">
                    {text(
                      "No sessions are open. You can allow creating a new session in the selected folder.",
                      "Открытых сессий нет. Можно разрешить создание новой в выбранной папке.",
                    )}
                  </p>
                )}
              </div>
              <div className="g2-permissions">
                {(
                  [
                    [
                      "allowInput",
                      text(
                        "Send text/voice and rename sessions",
                        "Отправлять текст и голос, переименовывать сессии",
                      ),
                    ],
                    [
                      "allowCreate",
                      text(
                        "Create sessions in this folder",
                        "Создавать сессии в этой папке",
                      ),
                    ],
                    [
                      "allowClose",
                      text(
                        "Close shared sessions",
                        "Закрывать выбранные сессии",
                      ),
                    ],
                    [
                      "allowBrowser",
                      text(
                        "Open the project browser",
                        "Открывать браузер проекта",
                      ),
                    ],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={draft[key]}
                      onChange={(e) => patch({ [key]: e.target.checked })}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="g2-speech-setup">
                <h4>{text("Voice on this Mac", "Голос на этом Mac")}</h4>
                <p>
                  {state.speech?.available
                    ? text("Ready: ", "Готово: ") + state.speech.model
                    : text(
                        "Prepare local recognition once. Audio stays on your Mac.",
                        "Один раз подготовьте локальное распознавание. Звук остаётся на Mac.",
                      )}
                </p>
                {state.speechSetup?.phase === "downloading" ||
                state.speechSetup?.phase === "verifying" ? (
                  <>
                    <progress
                      max={state.speechSetup.total}
                      value={state.speechSetup.received}
                      aria-label={text(
                        "Speech model download",
                        "Загрузка модели речи",
                      )}
                    />
                    <p>
                      {state.speechSetup.phase === "verifying"
                        ? text("Verifying download…", "Проверяю загрузку…")
                        : `${Math.round(state.speechSetup.received / 1048576)} / ${Math.round(state.speechSetup.total / 1048576)} МБ`}
                    </p>
                    <button
                      onClick={() =>
                        void command({ type: "cancel-speech-setup" })
                      }
                    >
                      {text("Cancel download", "Отменить загрузку")}
                    </button>
                  </>
                ) : (
                  state.speechSetup?.supported && (
                    <button
                      onClick={() => {
                        preparingSpeech.current = true;
                        void command({ type: "prepare-speech" });
                      }}
                      disabled={busy}
                    >
                      {state.speechSetup.phase === "ready"
                        ? text(
                            "Use built-in Nemotron 3.5",
                            "Использовать встроенный Nemotron 3.5",
                          )
                        : text(
                            "Prepare Nemotron 3.5 · 716 MB",
                            "Подготовить Nemotron 3.5 · 716 МБ",
                          )}
                    </button>
                  )
                )}
                {state.speechSetup?.phase === "error" && (
                  <p role="status">
                    {text(
                      "The model could not be downloaded. Check Internet access and retry.",
                      "Не удалось загрузить модель. Проверьте интернет и повторите.",
                    )}
                  </p>
                )}
                <details>
                  <summary>
                    {text(
                      "Use an existing speech application",
                      "Использовать установленное приложение речи",
                    )}
                  </summary>
                  <label>
                    {text("Handy executable", "Исполняемый файл Handy")}
                    <input
                      value={draft.speechExecutable}
                      onChange={(e) =>
                        patch({ speechExecutable: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    {text("Installed model ID", "ID установленной модели")}
                    <input
                      value={draft.speechModel}
                      onChange={(e) => patch({ speechModel: e.target.value })}
                    />
                  </label>
                </details>
              </div>
              <p className="g2-muted">
                {text(
                  "These settings apply to paired devices. Sessions outside this list remain inaccessible.",
                  "Эти настройки применяются к подключённым устройствам. Сессии вне списка остаются недоступными.",
                )}
              </p>
              <div className="g2-actions">
                <button onClick={() => setStage("overview")}>
                  {text("Back", "Назад")}
                </button>
                <button
                  className="g2-primary"
                  disabled={
                    busy ||
                    (!draft.sessionIds.length &&
                      !(draft.allowCreate && draft.workspace))
                  }
                  onClick={() => void saveAndPair()}
                >
                  {editing
                    ? text("Save access", "Сохранить доступ")
                    : text("Enable and connect", "Включить и подключить")}{" "}
                  <UiIcon name="arrow" />
                </button>
              </div>
            </div>
          )}
          {stage === "pair" && (
            <div className="g2-settings__body">
              <h4>
                {text(
                  "Open CanvasTTY in Even App",
                  "Откройте CanvasTTY в Even App",
                )}
              </h4>
              <p>
                {text(
                  "Enter these six digits in CanvasTTY G2 in Even App, then approve the connection here. Keep both devices on the same Wi-Fi.",
                  "Введите эти шесть цифр в CanvasTTY G2 в Even App, затем подтвердите подключение здесь. Оба устройства должны быть в одной сети Wi-Fi.",
                )}
              </p>
              {!state.transport.ready && (
                <p className="g2-settings__error">
                  {text(
                    "The selected network is unavailable. Check Wi-Fi and refresh the address.",
                    "Выбранная сеть недоступна. Проверьте Wi-Fi и обновите адрес.",
                  )}
                </p>
              )}
              {state.pairing ? (
                <>
                  <div className="g2-pair-offer">
                    <div>
                      <p className="g2-muted">
                        {text(
                          "CanvasTTY pairing code",
                          "Код подключения CanvasTTY",
                        )}
                      </p>
                      <strong className="g2-pair-code">
                        {state.pairing.code}
                      </strong>
                      <p className="g2-muted">
                        {text("Valid for", "Действует ещё")}{" "}
                        {Math.max(
                          0,
                          Math.ceil(
                            (state.pairing.expiresAt - Date.now()) / 1000,
                          ),
                        )}{" "}
                        {text("seconds", "секунд")}
                      </p>
                      <button
                        onClick={() =>
                          window.canvasTTY.clipboard.writeText(
                            state.pairing!.code,
                          )
                        }
                      >
                        <UiIcon name="copy" />
                        {text("Copy code", "Копировать код")}
                      </button>
                    </div>
                  </div>
                  {state.pairing.pending ? (
                    <div className="g2-approval">
                      <strong>{state.pairing.pending.name}</strong>
                      <p>
                        {text(
                          "This app entered the correct code. Allow access to the sessions selected above?",
                          "Приложение ввело правильный код. Разрешить доступ к выбранным выше сессиям?",
                        )}
                      </p>
                      <div className="g2-actions">
                        <button
                          onClick={() => void command({ type: "reject" })}
                        >
                          {text("Reject", "Отклонить")}
                        </button>
                        <button
                          className="g2-primary"
                          disabled={busy}
                          onClick={() =>
                            void command({
                              type: "approve",
                              id: state.pairing!.pending!.id,
                            }).then((next) => {
                              if (next) setStage("overview");
                            })
                          }
                        >
                          {text("Allow connection", "Разрешить подключение")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="g2-waiting">
                      {text(
                        "Waiting for confirmation from Even App…",
                        "Ожидаю запрос из Even App…",
                      )}
                    </p>
                  )}
                </>
              ) : (
                <button
                  className="g2-primary"
                  disabled={busy || !state.transport.ready}
                  onClick={() => void command({ type: "begin-pairing" })}
                >
                  {text("Create pairing code", "Создать код подключения")}
                </button>
              )}
              <div className="g2-actions">
                <button onClick={() => void cancel()}>
                  {text("Finish later", "Завершить позже")}
                </button>
                {state.pairing && (
                  <button
                    disabled={busy}
                    onClick={() => void command({ type: "begin-pairing" })}
                  >
                    {text("New code", "Новый код")}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
