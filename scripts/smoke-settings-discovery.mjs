// Real built-renderer smoke with isolated userData and read-only IPC fixtures.
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (!process.versions.electron) {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-settings-smoke-"));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    require("electron"),
    [fileURLToPath(import.meta.url), dir],
    { windowsHide: true, stdio: "inherit", env: environment },
  );
  process.exitCode =
    (await new Promise((resolve) => child.on("exit", resolve))) ?? 1;
} else {
  void (async () => {
    const { app, BrowserWindow, ipcMain, session } = require("electron");
    const dir = process.argv.at(-1);
    app.setPath("userData", join(dir, "userData"));
    app.setPath("sessionData", join(dir, "session"));
    const timeout = setTimeout(() => {
      console.error("FAIL settings smoke timed out");
      app.exit(1);
    }, 35000);
    try {
      await app.whenReady();
      const preload = join(root, "out/preload/index.cjs");
      const source = await readFile(preload, "utf8");
      const channels = new Set(
        [...source.matchAll(/["']([a-z][\w-]*:[\w:-]+)["']/g)].map(
          (match) => match[1],
        ),
      );
      for (const channel of channels)
        ipcMain.handle(channel, () => {
          if (channel === "settings:get")
            throw new Error("Isolated smoke uses renderer default settings");
          if (channel === "window:get-state")
            return { isMacOS: false, maximized: false, fullscreen: false };
          if (channel === "update:status") return { type: "idle" };
          if (channel === "provider-secrets:status") return {};
          if (channel === "app:version") return "settings-smoke";
          if (channel === "materials:snapshot")
            return {
              revision: 0,
              materials: [],
              remarks: [],
              storage: { usedBytes: 0, limitBytes: 0 },
            };
          return /list|search|snapshot|sessions/i.test(channel) ? [] : null;
        });
      session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
        callback({
          cancel: !/^(file|data|blob|canvastty-[a-z]+):/.test(details.url),
        }),
      );
      const win = new BrowserWindow({
        show: false,
        width: 1440,
        height: 1000,
        webPreferences: {
          preload,
          contextIsolation: true,
          sandbox: false,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      const errors = [];
      win.webContents.on("console-message", (details) => {
        if (details.level === "error") errors.push(details.message);
      });
      const js = (code) => win.webContents.executeJavaScript(code, true);
      const wait = async (code, label) => {
        const start = Date.now();
        while (Date.now() - start < 15000) {
          if (await js(code).catch(() => false)) return;
          await delay(75);
        }
        throw new Error(
          "Timed out: " +
            label +
            "; " +
            JSON.stringify(
              await js(
                "({active:document.activeElement?.outerHTML?.slice(0,300),panel:document.querySelector('.settings-panel')?.innerText?.slice(0,1500),body:document.body.innerText.slice(0,1000)})",
              ),
            ) +
            "; errors=" +
            JSON.stringify(errors),
        );
      };
      await win.loadFile(join(root, "out/renderer/index.html"));
      await wait(
        "Boolean(document.querySelector('.limits-settings-link'))",
        "limits settings link",
      );
      await js("document.querySelector('.limits-settings-link').click();true");
      await wait(
        "document.querySelector('#settings-tab-agents')?.getAttribute('aria-selected')==='true' && document.activeElement?.dataset.settingLabel",
        "direct quota destination",
      );
      const destination = await js(
        "document.activeElement.dataset.settingLabel",
      );
      console.log(
        "PASS unavailable HOME quota links open and focus Agents / Limit display: " +
          destination,
      );
      const image = await win.webContents.capturePage();
      await writeFile(join(dir, "settings.png"), image.toPNG());
      console.log(
        "PASS quota navigation screenshot: " +
          join(dir, "settings.png"),
      );
      win.destroy();
      clearTimeout(timeout);
      app.exit(0);
    } catch (error) {
      console.error(error);
      clearTimeout(timeout);
      app.exit(1);
    }
  })();
}
