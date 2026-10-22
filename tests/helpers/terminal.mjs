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

/**
 * A PTY spawner that pushes `{ command, args, options, process }` to `calls` and
 * returns a fake PTY: `emitData`/`emitExit` drive its listeners, `lastResize`
 * holds the last size, and `onWrite(data, options)` sees what was written.
 */
/**
 * What OpenCode prints once its prompt has focus: the alternate screen, its hidden cursor while it draws, then the
 * cursor shown in the input field (TerminalManager types queued input only after that for OpenCode).
 */
export const OPENCODE_INPUT_READY = "\x1b[?1049h\x1b[?2004h\x1b[?25l  Ask anything\x1b[?25h";

/** Shows OpenCode's input field on the fake PTY OpenCode was spawned on, once that PTY exists. */
export async function openCodeInputReady(calls, index = calls.length) {
  for (let i = 0; i < 200 && calls.length <= index; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  calls[index].process.emitData(OPENCODE_INPUT_READY);
}

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

/** Codex's empty task composer with its dim placeholder (automated Codex prompts wait for it). */
export const CODEX_COMPOSER_READY = "\x1b[2J\x1b[H>_ OpenAI Codex\r\n\r\n› \x1b[2mAsk Codex to do anything\x1b[22m\r\n";

/**
 * fakeSpawner whose PTYs show their CLI's input field shortly after they start: OpenCode's cursor in its full-screen
 * view, Codex's empty task composer (input waits for those for OpenCode and for automated Codex prompts).
 */
export function inputReadySpawner(calls, options) {
  const spawner = fakeSpawner(calls, options);
  return (command, args, spawnOptions) => {
    const process = spawner(command, args, spawnOptions);
    const ready = /(?:^|\/)codex$/u.test(command) ? CODEX_COMPOSER_READY : OPENCODE_INPUT_READY;
    setTimeout(() => process.emitData(ready), 10);
    return process;
  };
}
