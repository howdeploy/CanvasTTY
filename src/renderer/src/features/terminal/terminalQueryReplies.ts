import type { Terminal } from "@xterm/xterm";

/** Match xterm's synchronous replies only while it handles the corresponding query. */
export function terminalQueryReplies(terminal: Pick<Terminal, "parser">): {
  isReply(data: string): boolean;
  dispose(): void;
} {
  let expected: RegExp | undefined;
  const arm = (pattern: RegExp): false => {
    expected = pattern;
    // A keyboard/paste event in a later task must never inherit this query's origin.
    queueMicrotask(() => { if (expected === pattern) expected = undefined; });
    return false;
  };
  const parser = terminal.parser;
  const handlers = [
    parser.registerCsiHandler({ final: "n" }, (params) => params[0] === 5
      ? arm(/^\x1b\[0n$/u) : params[0] === 6 ? arm(/^\x1b\[\d+;\d+R$/u) : false),
    parser.registerCsiHandler({ prefix: "?", final: "n" }, (params) => params[0] === 6
      ? arm(/^\x1b\[\?\d+;\d+R$/u) : false),
    parser.registerCsiHandler({ final: "c" }, () => arm(/^\x1b\[\?[\d;]+c$/u)),
    parser.registerCsiHandler({ prefix: ">", final: "c" }, () => arm(/^\x1b\[>[\d;]+c$/u)),
    parser.registerEscHandler({ final: "Z" }, () => arm(/^\x1b\[\?[\d;]+c$/u)),
    parser.registerCsiHandler({ intermediates: "$", final: "p" }, () => arm(/^\x1b\[\d+;[0-4]\$y$/u)),
    parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, () => arm(/^\x1b\[\?\d+;[0-4]\$y$/u)),
    parser.registerCsiHandler({ final: "t" }, (params) => [14, 16, 18].includes(Number(params[0]))
      ? arm(/^\x1b\[(?:4|6|8);\d+;\d+t$/u) : false),
    parser.registerDcsHandler({ intermediates: "$", final: "q" }, () => arm(/^\x1bP[01](?:\$r[^\x1b]*)?\x1b\\$/u)),
    ...[4, 10, 11, 12].map((id) => parser.registerOscHandler(id, (data) => data.split(";").includes("?")
      ? arm(/^\x1b\](?:4;\d+|10|11|12);rgb:[\da-f]+\/[\da-f]+\/[\da-f]+\x1b\\$/iu) : false))
  ];
  return {
    isReply: (data) => expected?.test(data) ?? false,
    dispose: () => { expected = undefined; handlers.forEach((handler) => handler.dispose()); }
  };
}
