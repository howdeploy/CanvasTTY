// Shared stand-ins for TerminalManager tests: a provider CLI registry where every
// CLI resolves, and a PTY spawner that records its calls instead of starting a process.

/** Every provider resolves to `/resolved/<provider>`, frozen like the real registry's answers. */
export function availableRegistry() {
  return {
    get(provider) {
      return Object.freeze({
        state: "available",
        provider,
        executable: `/resolved/${provider}`,
        launcher: "native",
        environment: Object.freeze({ PATH: "/resolved:/usr/bin" }),
        checked: Object.freeze([{ path: `/resolved/${provider}`, result: "selected" }])
      });
    },
    snapshot() {
      return {};
    }
  };
}

/** The verified startup sequence, emitted only when a test's fake OpenCode input view is up. */
export const OPENCODE_STARTUP_READY = "\x1b[?1049h\x1b[?2004h\x1b[?25l\x1b[?25h";

export async function openCodeInputReady(calls, index) {
  for (let i = 0; i < 100 && calls.length <= index; i++) await new Promise(resolve => setTimeout(resolve, 5));
  if (!calls[index]) throw new Error("The expected fake OpenCode PTY did not start");
  calls[index].process.emitData(OPENCODE_STARTUP_READY);
}

/** A fake editor echoes bracketed pastes but starts a turn only on a separate submit write. */
export function echoPromptInput(pty, provider, readyFrame) {
  const write = pty.write.bind(pty);
  let draft = "", pastes = 0;
  pty.write = (data) => {
    write(data);
    if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) {
      draft += data.slice(6, -6);
      pastes++;
      const text = draft.includes("\n") ? `[Pasted text #${pastes} +${draft.split("\n").length} lines]` : draft;
      const frame = (pty.provider ?? provider) === "kimi"
        ? `\x1b[2J\x1b[H╭──────────────────────────────────────────────────────────────────╮\r\n│ > ${text.padEnd(62)} │\r\n╰──────────────────────────────────────────────────────────────────╯\x1b[2;5H`
        : `\x1b[2J\x1b[H${(pty.provider ?? provider) === "claude" ? "❯" : "›"} ${text}`;
      (pty.emitData ?? pty.data).call(pty, frame);
    } else if (data === "\r" || /^\x1b\[\d+;\d+u$/u.test(data) || /^\x1b\[\d+(?:;\d+)?~$/u.test(data)) {
      draft = "";
      (pty.emitData ?? pty.data).call(pty, readyFrame);
    }
  };
}

/**
 * A PTY spawner that pushes `{ command, args, options, process }` to `calls` and
 * returns a fake PTY: `emitData`/`emitExit` drive its listeners, `lastResize`
 * holds the last size, and `onWrite(data, options)` sees what was written.
 */
export function fakeSpawner(calls, { pidBase = 20_000, onWrite } = {}) {
  return (command, args, options) => {
    let dataListener = () => undefined;
    let exitListener = () => undefined;
    const process = {
      pid: pidBase + calls.length,
      process: command,
      lastResize: null,
      write(data) { onWrite?.(data, options); },
      resize(cols, rows) { process.lastResize = { cols, rows }; },
      kill() {},
      pause() {},
      resume() {},
      onData(listener) {
        dataListener = listener;
        return { dispose() {} };
      },
      onExit(listener) {
        exitListener = listener;
        return { dispose() {} };
      },
      emitData(data) { dataListener(data); },
      emitExit(exitCode) { exitListener({ exitCode, signal: 0 }); }
    };
    calls.push({ command, args, options, process });
    return process;
  };
}
