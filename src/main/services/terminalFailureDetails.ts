const MAX_FAILURE_DETAILS_CHARS = 8_000;
const MAX_FAILURE_DETAILS_LINES = 48;

export function terminalFailureDetails(buffer: string): string | null {
  const lines = stripTerminalControls(buffer)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;

  const tracebackStart = lines.reduce(
    (lastMatch, line, index) => line === "Traceback (most recent call last):" ? index : lastMatch,
    -1
  );
  const details = lines.slice(tracebackStart >= 0 ? tracebackStart : -MAX_FAILURE_DETAILS_LINES).join("\n");
  return details.length <= MAX_FAILURE_DETAILS_CHARS
    ? details
    : `…${details.slice(-(MAX_FAILURE_DETAILS_CHARS - 1))}`;
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_][ -/]*[@-~])/g, "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
    .replace(/\t/g, " ");
}
