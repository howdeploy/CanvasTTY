import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const run = promisify(execFile);
if (process.env.CANVASTTY_GEOMETRY_DISPOSABLE_DESKTOP !== "1") throw new Error("Native input requires a disposable test desktop");
const [kind, ...args] = process.argv.slice(2);
if (!["drag", "alt-drag", "scroll", "screenshot"].includes(kind)) throw new Error("Unsupported test operation");
if (kind !== "screenshot" && (args.length !== 4 || args.some((value) => !Number.isFinite(Number(value))))) throw new Error("Invalid pointer coordinates");
if (process.platform === "linux") {
  if (kind === "screenshot") await run("import", ["-window", "root", args[0]]);
  else {
    const [x, y, endX, endY] = args.map(Number);
    const commands = ["mousemove", String(x), String(y), "sleep", "0.08"];
    if (kind === "scroll") commands.push("click", "--repeat", "3", "--delay", "40", "5");
    else {
      commands.push("mousedown", "1");
      for (let i = 1; i <= 6; i++) commands.push("sleep", "0.03", "mousemove", String(Math.round(x + (endX - x) * i / 6)), String(Math.round(y + (endY - y) * i / 6)));
      commands.push("mouseup", "1");
    }
    if (kind === "alt-drag") await run("xdotool", ["keydown", "Alt_L"]);
    try { await run("xdotool", commands); }
    finally { if (kind === "alt-drag") await run("xdotool", ["keyup", "Alt_L"]); }
  }
} else if (process.platform === "darwin") {
  if (kind === "screenshot") await run("/usr/sbin/screencapture", ["-x", args[0]]);
  else await run(process.env.CANVASTTY_GEOMETRY_MAC_INPUT, [kind, ...args]);
} else if (process.platform === "win32") {
  await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    fileURLToPath(new URL("./browser-geometry-input.ps1", import.meta.url)), kind, ...args]);
} else throw new Error(`Unsupported native test platform: ${process.platform}`);
