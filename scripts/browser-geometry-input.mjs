import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const run = promisify(execFile);
if (process.env.CANVASTTY_GEOMETRY_DISPOSABLE_DESKTOP !== "1") throw new Error("Native input requires a disposable test desktop");
const [kind, ...args] = process.argv.slice(2);
if (!["drag", "screenshot"].includes(kind)) throw new Error("Unsupported test operation");
if (kind === "drag" && (args.length !== 4 || args.some((value) => !Number.isFinite(Number(value))))) throw new Error("Invalid pointer coordinates");
if (process.platform === "linux") {
  if (kind === "screenshot") await run("import", ["-window", "root", args[0]]);
  else {
    const [x, y, endX, endY] = args.map(Number);
    const commands = ["mousemove", "--sync", String(x), String(y), "sleep", "0.08", "mousedown", "1"];
    for (let i = 1; i <= 6; i++) commands.push("sleep", "0.03", "mousemove", "--sync", String(Math.round(x + (endX - x) * i / 6)), String(Math.round(y + (endY - y) * i / 6)));
    commands.push("mouseup", "1");
    await run("xdotool", commands);
  }
} else if (process.platform === "darwin") {
  if (kind === "screenshot") await run("/usr/sbin/screencapture", ["-x", args[0]]);
  else await run(process.env.CANVASTTY_GEOMETRY_MAC_INPUT, args);
} else if (process.platform === "win32") {
  await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    fileURLToPath(new URL("./browser-geometry-input.ps1", import.meta.url)), kind, ...args]);
} else throw new Error(`Unsupported native test platform: ${process.platform}`);
