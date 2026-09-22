import { useEffect, useRef, useState } from "react";
import type { LocaleId } from "../../../../shared/contracts";
import type {
  EvenG2Config,
  EvenG2State,
  EvenG2Command,
} from "../../../../shared/evenG2";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import "./evenG2Controls.css";

type Stage = "overview" | "transport" | "scope" | "pair";
export function EvenG2Controls({
  locale,
}: {
  locale: LocaleId;
}): React.JSX.Element {
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
              t(locale, "evenG2ConnectionSettingsUnavailable"),
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
        t(locale, "evenG2TheActionWasNotCompleted"),
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
            t(locale, "evenG2LoadingConnectionSettings")}
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
    ["transport", t(locale, "evenG2Connection")],
    ["scope", t(locale, "evenG2Access")],
    ["pair", t(locale, "evenG2Connect")],
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
            {t(locale, "evenG2YourSessionsOnYourGlasses")}
          </h3>
          <p>
            {t(locale, "evenG2ReadResponsesSpeakToAn")}
          </p>
        </div>
        <span
          className={
            "g2-settings__status " + (activePeers.length ? "is-online" : "")
          }
        >
          {activePeers.length
            ? t(locale, "evenG2Connected")
            : state.config.enabled
              ? t(locale, "evenG2Enabled")
              : t(locale, "evenG2Off")}
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
              {t(locale, "evenG2ConnectOnceChooseWhatYour")}
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
              {t(locale, "evenG2ConnectEvenG2")}{" "}
              <UiIcon name="arrow" />
            </button>
          </div>
          <div className="g2-settings__network">
            <p>{t(locale, "evenG2CanvasTTYChoosesALocalNetwork")}</p>
            <button type="button" onClick={() => setStage("transport")}>
              {t(locale, "evenG2LocalNetworkSettings")}
            </button>
          </div>
          {state.peers.map((peer) => (
            <div className="g2-peer" key={peer.id}>
              <div className="g2-peer__top">
                <div>
                  <strong>{peer.name}</strong>
                  <p>
                    {Date.now() - peer.lastSeen < 12000
                      ? t(locale, "evenG2EvenAppIsOnline")
                      : t(locale, "evenG2WaitingForEvenApp")}
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
                  {t(locale, "evenG2ManageAccess")}
                </button>
              </div>
              <div className="g2-checks">
                <span>
                  <i
                    className={
                      peer.telemetry?.display === "confirmed" ? "pass" : ""
                    }
                  />
                  {t(locale, "evenG2Display")}:{" "}
                  {peer.telemetry?.display === "confirmed"
                    ? t(locale, "evenG2Acknowledged")
                    : t(locale, "evenG2NotChecked")}
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
                  {t(locale, "evenG2Microphone")}:{" "}
                  {peer.telemetry?.microphone === "unknown"
                    ? t(locale, "evenG2Unconfirmed")
                    : peer.telemetry?.audioBytes
                      ? t(locale, "evenG2AudioReceived")
                      : t(locale, "evenG2NotChecked")}
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
                    {t(locale, "evenG2DeviceDiagnostics")}
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
                {t(locale, "evenG2InEvenAppOpenSettings")}
              </p>
              {revoke === peer.id ? (
                <div className="g2-actions">
                  <span>
                    {t(locale, "evenG2RevokeThisDeviceSAccess")}
                  </span>
                  <button onClick={() => setRevoke(null)}>
                    {t(locale, "evenG2Cancel")}
                  </button>
                  <button
                    className="g2-danger"
                    onClick={() =>
                      void command({ type: "revoke", id: peer.id }).then(() =>
                        setRevoke(null),
                      )
                    }
                  >
                    {t(locale, "evenG2Revoke")}
                  </button>
                </div>
              ) : (
                <button className="g2-link" onClick={() => setRevoke(peer.id)}>
                  {t(locale, "evenG2DisconnectDevice")}
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
              {t(locale, "evenG2TurnOffEvenG2Integration")}
            </button>
          )}
        </>
      ) : (
        <>
          <nav
            className="g2-steps"
            aria-label={t(locale, "evenG2ConnectionSteps")}
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
              <h4>{t(locale, "evenG2ConnectToCanvasTTY")}</h4>
              <span className="g2-tag">
                {t(locale, "evenG2DirectLocalConnection")}
              </span>
              <p className="g2-muted">
                {t(locale, "evenG2CanvasTTYChoosesALocalNetwork")}
              </p>
              {!draft.publicOrigin && (
                <>
                  <ol>
                    <li>
                      {t(locale, "evenG2ConnectYourPhoneAndComputer")}
                    </li>
                    <li>
                      {t(locale, "evenG2ChooseThisComputerSAddress")}
                    </li>
                    <li>
                      {t(locale, "evenG2EnterTheCodeInThe")}
                    </li>
                  </ol>
                  <label>
                    {t(locale, "evenG2ComputerNetworkAddress")}
                    <select
                      value={draft.interfaceName}
                      onChange={(event) =>
                        patch({ interfaceName: event.target.value })
                      }
                    >
                      <option value="">
                        {t(locale, "evenG2ChooseANetwork")}
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
                    ? t(locale, "evenG2HTTPSAddressSelected")
                    : selected
                      ? t(locale, "evenG2AddressAvailable")
                      : t(locale, "evenG2ConnectThisComputerToWi")}
                </span>
                <button disabled={busy} onClick={() => void refresh()}>
                  {t(locale, "evenG2Refresh")}
                </button>
              </div>
              {!draft.publicOrigin && (
                <p className="g2-muted">
                  {t(locale, "evenG2ThisLocalPreviewUsesHTTP")}
                </p>
              )}
              <div className="g2-actions">
                <button onClick={() => void cancel()}>
                  {t(locale, "evenG2Cancel")}
                </button>
                <button
                  className="g2-primary"
                  disabled={(!selected && !draft.publicOrigin) || busy}
                  onClick={() => setStage("scope")}
                >
                  {t(locale, "evenG2ChooseAccess")}{" "}
                  <UiIcon name="arrow" />
                </button>
              </div>
            </div>
          )}
          {stage === "scope" && (
            <div className="g2-settings__body">
              <h4>
                {t(locale, "evenG2ChooseTheWorkspaceAndSessions")}
              </h4>
              <label>
                {t(locale, "evenG2FolderForNewSessions")}
                <div className="g2-path">
                  <span>
                    {draft.workspace ||
                      t(locale, "evenG2NoFolderSelected")}
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
                    {t(locale, "evenG2Choose")}
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
                    {t(locale, "evenG2NoSessionsAreOpenYou")}
                  </p>
                )}
              </div>
              <div className="g2-permissions">
                {(
                  [
                    [
                      "allowInput",
                      t(locale, "evenG2SendTextVoiceAndRename"),
                    ],
                    [
                      "allowCreate",
                      t(locale, "evenG2CreateSessionsInThisFolder"),
                    ],
                    [
                      "allowClose",
                      t(locale, "evenG2CloseSharedSessions"),
                    ],
                    [
                      "allowBrowser",
                      t(locale, "evenG2OpenTheProjectBrowser"),
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
                <h4>{t(locale, "evenG2VoiceOnThisMac")}</h4>
                <p>
                  {state.speech?.available
                    ? t(locale, "evenG2Ready") + state.speech.model
                    : t(locale, "evenG2PrepareLocalRecognitionOnceAudio")}
                </p>
                {state.speechSetup?.phase === "downloading" ||
                state.speechSetup?.phase === "verifying" ? (
                  <>
                    <progress
                      max={state.speechSetup.total}
                      value={state.speechSetup.received}
                      aria-label={t(locale, "evenG2SpeechModelDownload")}
                    />
                    <p>
                      {state.speechSetup.phase === "verifying"
                        ? t(locale, "evenG2VerifyingDownload")
                        : `${Math.round(state.speechSetup.received / 1048576)} / ${Math.round(state.speechSetup.total / 1048576)} МБ`}
                    </p>
                    <button
                      onClick={() =>
                        void command({ type: "cancel-speech-setup" })
                      }
                    >
                      {t(locale, "evenG2CancelDownload")}
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
                        ? t(locale, "evenG2UseBuiltInNemotron3")
                        : t(locale, "evenG2PrepareNemotron35716")}
                    </button>
                  )
                )}
                {state.speechSetup?.phase === "error" && (
                  <p role="status">
                    {t(locale, "evenG2TheModelCouldNotBe")}
                  </p>
                )}
                <details>
                  <summary>
                    {t(locale, "evenG2UseAnExistingSpeechApplication")}
                  </summary>
                  <label>
                    {t(locale, "evenG2HandyExecutable")}
                    <input
                      value={draft.speechExecutable}
                      onChange={(e) =>
                        patch({ speechExecutable: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    {t(locale, "evenG2InstalledModelID")}
                    <input
                      value={draft.speechModel}
                      onChange={(e) => patch({ speechModel: e.target.value })}
                    />
                  </label>
                </details>
              </div>
              <p className="g2-muted">
                {t(locale, "evenG2TheseSettingsApplyToPaired")}
              </p>
              <div className="g2-actions">
                <button onClick={() => setStage("overview")}>
                  {t(locale, "evenG2Back")}
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
                    ? t(locale, "evenG2SaveAccess")
                    : t(locale, "evenG2EnableAndConnect")}{" "}
                  <UiIcon name="arrow" />
                </button>
              </div>
            </div>
          )}
          {stage === "pair" && (
            <div className="g2-settings__body">
              <h4>
                {t(locale, "evenG2OpenCanvasTTYInEvenApp")}
              </h4>
              <p>
                {t(locale, "evenG2EnterTheseSixDigitsIn")}
              </p>
              {!state.transport.ready && (
                <p className="g2-settings__error">
                  {t(locale, "evenG2TheSelectedNetworkIsUnavailable")}
                </p>
              )}
              {state.pairing ? (
                <>
                  <div className="g2-pair-offer">
                    <div>
                      <p className="g2-muted">
                        {t(locale, "evenG2CanvasTTYPairingCode")}
                      </p>
                      <strong className="g2-pair-code">
                        {state.pairing.code}
                      </strong>
                      <p className="g2-muted">
                        {t(locale, "evenG2ValidFor")}{" "}
                        {Math.max(
                          0,
                          Math.ceil(
                            (state.pairing.expiresAt - Date.now()) / 1000,
                          ),
                        )}{" "}
                        {t(locale, "evenG2Seconds")}
                      </p>
                      <button
                        onClick={() =>
                          window.canvasTTY.clipboard.writeText(
                            state.pairing!.code,
                          )
                        }
                      >
                        <UiIcon name="copy" />
                        {t(locale, "evenG2CopyCode")}
                      </button>
                    </div>
                  </div>
                  {state.pairing.pending ? (
                    <div className="g2-approval">
                      <strong>{state.pairing.pending.name}</strong>
                      <p>
                        {t(locale, "evenG2ThisAppEnteredTheCorrect")}
                      </p>
                      <div className="g2-actions">
                        <button
                          onClick={() => void command({ type: "reject" })}
                        >
                          {t(locale, "evenG2Reject")}
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
                          {t(locale, "evenG2AllowConnection")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="g2-waiting">
                      {t(locale, "evenG2WaitingForConfirmationFromEven")}
                    </p>
                  )}
                </>
              ) : (
                <button
                  className="g2-primary"
                  disabled={busy || !state.transport.ready}
                  onClick={() => void command({ type: "begin-pairing" })}
                >
                  {t(locale, "evenG2CreatePairingCode")}
                </button>
              )}
              <div className="g2-actions">
                <button onClick={() => void cancel()}>
                  {t(locale, "evenG2FinishLater")}
                </button>
                {state.pairing && (
                  <button
                    disabled={busy}
                    onClick={() => void command({ type: "begin-pairing" })}
                  >
                    {t(locale, "evenG2NewCode")}
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
