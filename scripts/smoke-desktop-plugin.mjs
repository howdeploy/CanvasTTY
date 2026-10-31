// End-to-end plugin/iframe/preload/IPC/Win32 test. Only offscreen fixture windows
// and an isolated Electron profile are used; no existing desktop app is touched.
import { readFile, writeFile, mkdir, mkdtemp, cp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { once } from "node:events";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!process.versions.electron) {
  if (process.platform !== "win32") {
    console.log("SKIP Windows-only desktop plugin smoke");
    process.exit(0);
  }
  const { build } = await import("esbuild");
  const dir = await mkdtemp(join(tmpdir(), "canvastty-desktop-smoke-"));
  const plugin = JSON.parse(
    await readFile(
      join(root, "examples/plugins/codex-desktop/canvastty.plugin.json"),
      "utf8",
    ),
  );
  await writeFile(join(dir, "manifest.json"), JSON.stringify(plugin));
  await cp(
    join(root, "native/desktop-apps"),
    join(dir, "native/desktop-apps"),
    { recursive: true },
  );
  await build({
    entryPoints: [join(root, "src/preload/index.ts")],
    outfile: join(dir, "preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    logLevel: "silent",
  });
  await build({
    entryPoints: [join(root, "src/main/ipc/desktopWindowIpc.ts")],
    outfile: join(dir, "ipc.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["electron"],
    logLevel: "silent",
  });
  await build({
    stdin: {
      contents: `import React from "react"; import {createRoot} from "react-dom/client";
    import {PluginFrame} from "./src/renderer/src/features/plugins/PluginFrame.tsx";
    const manifest=${JSON.stringify(plugin)}; const noop=()=>{};
    window.smokeErrors=[];
    const view=React.createElement("article",{className:"plugin-canvas-card","data-canvas-widget-id":"fixture",style:{position:"absolute",left:30,top:30,width:900,height:650}},React.createElement(PluginFrame,{
      plugin:{manifest,enabled:true,sourceUrl:"https://github.com/bbutterm/canvastty-plugin-codex-desktop",installedAt:1,selectedModules:[],enabledHooks:[],nativeCodeTrusted:false,decisionsMayAllow:false},
      contribution:manifest.contributions[1],canvasInstanceId:"fixture",locale:"en",palette:"night",sessions:[],limits:null,
      captureCanvasWheelOverWidgets:false,onCanvasWheel:noop,onFocus:noop,onHoverChange:noop,onOpenLauncher:noop,onError:(message)=>window.smokeErrors.push(message)
    }));
    let rendererRoot;
    window.smokeMount=()=>{rendererRoot=createRoot(document.getElementById("root"));rendererRoot.render(view);};
    window.smokeUnmount=()=>rendererRoot.unmount();
    window.smokeMount();`,
      resolveDir: root,
      loader: "jsx",
    },
    outfile: join(dir, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    loader: { ".svg": "dataurl" },
    logLevel: "silent",
  });
  await writeFile(
    join(dir, "index.html"),
    '<meta charset="UTF-8"><style>body{margin:0;background:#252934}iframe{width:100%;height:100%;border:0}</style><div id="root"></div><script type="module" src="./renderer.js"></script>',
  );
  const source = await readFile(
    join(root, "src/main/services/PluginManager.ts"),
    "utf8",
  );
  const marker = "const PLUGIN_SDK_SOURCE = ";
  const sdk = source
    .slice(
      source.indexOf(marker) + marker.length,
      source.indexOf("const PLUGIN_INPUT_BRIDGE_SOURCE = "),
    )
    .trim()
    .replace(/;\s*$/, "");
  // Evaluate only the repository's static string literal, not any plugin content.
  await writeFile(
    join(dir, "sdk.js"),
    (await import("node:vm")).runInNewContext(sdk),
  );
  const compile = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Add-Type -Path '${join(root, "tests/fixtures/ForeignDesktopWindow.cs").replaceAll("'", "''")}' -OutputAssembly '${join(dir, "Codex.exe").replaceAll("'", "''")}' -OutputType ConsoleApplication -ReferencedAssemblies System.Windows.Forms,System.Drawing`,
    ],
    { windowsHide: true, stdio: "inherit" },
  );
  await new Promise((resolve, reject) => {
    compile.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Fixture compile failed")),
    );
    compile.on("error", reject);
  });
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    require("electron"),
    [fileURLToPath(import.meta.url), "--desktop-plugin-harness", dir],
    { cwd: dir, windowsHide: true, stdio: "inherit", env: environment },
  );
  const code = await new Promise((resolve) => child.on("exit", resolve));
  process.exitCode = code ?? 1;
} else {
  void (async () => {
    const dir = process.argv.at(-1);
    const { app, BrowserWindow, ipcMain, protocol } = require("electron");
    protocol.registerSchemesAsPrivileged([
      {
        scheme: "canvastty-plugin",
        privileges: { standard: true, secure: true, supportFetchAPI: true },
      },
    ]);
    app.setPath("userData", join(dir, "userData"));
    app.setPath("sessionData", join(dir, "session"));
    const deadline = setTimeout(() => {
      console.error("FAIL desktop plugin smoke timed out");
      app.exit(1);
    }, 45000);
    let fixture;
    try {
      await app.whenReady();
      const win = new BrowserWindow({
        show: true,
        x: -20000,
        y: -20000,
        width: 1100,
        height: 850,
        webPreferences: {
          preload: join(dir, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          backgroundThrottling: false,
        },
      });
      fixture = spawn(
        join(dir, "Codex.exe"),
        [win.getNativeWindowHandle().readBigUInt64LE().toString()],
        { windowsHide: true, stdio: "pipe" },
      );
      const queue = [],
        waiters = [];
      createInterface({ input: fixture.stdout }).on("line", (line) => {
        try {
          const data = JSON.parse(line);
          const next = waiters.shift();
          if (next) next(data);
          else queue.push(data);
        } catch {}
      });
      const next = () =>
        queue.length
          ? Promise.resolve(queue.shift())
          : new Promise((resolve) => waiters.push(resolve));
      const original = await next();
      const state = async (command = "state") => {
        fixture.stdin.write(command + "\n");
        return next();
      };
      const manifest = JSON.parse(
        await readFile(join(dir, "manifest.json"), "utf8"),
      );
      protocol.handle("canvastty-plugin", async (request) => {
        const url = new URL(request.url);
        const file =
          url.hostname === "host"
            ? join(dir, "sdk.js")
            : join(
                root,
                "examples/plugins/codex-desktop",
                decodeURIComponent(url.pathname),
              );
        const content = await readFile(file);
        return new Response(content, {
          headers: {
            "Content-Type": file.endsWith(".js")
              ? "application/javascript"
              : file.endsWith(".css")
                ? "text/css"
                : "text/html",
            "Content-Security-Policy":
              "default-src 'self' canvastty-plugin:; script-src 'self' canvastty-plugin:; style-src 'self' canvastty-plugin:",
          },
        });
      });
      const { registerDesktopWindowIpc } = await import(
        pathToFileURL(join(dir, "ipc.mjs")).href
      );
      const plugins = {
        assertPermission(id, permission) {
          if (id !== manifest.id || permission !== "desktop:embed")
            throw new Error("Wrong permission");
        },
        hasPermission() {
          return true;
        },
        contribution() {
          return manifest.contributions[1];
        },
      };
      const settings = {
        get: () => ({
          pluginCanvas: [
            {
              id: "fixture",
              pluginId: manifest.id,
              contributionId: manifest.contributions[1].id,
            },
          ],
        }),
      };
      registerDesktopWindowIpc(
        ipcMain,
        plugins,
        settings,
        () => win,
        (event) => {
          if (
            event.sender !== win.webContents ||
            event.senderFrame !== win.webContents.mainFrame
          )
            throw new Error("Untrusted sender");
        },
        join(root, "native/desktop-apps/window-host.ps1"),
      );
      const js = (code) => win.webContents.executeJavaScript(code, true);
      const wait = async (code, label) => {
        const start = Date.now();
        while (Date.now() - start < 15000) {
          if (await js(code).catch(() => false)) return;
          await delay(100);
        }
        throw new Error(
          "Timed out: " +
            label +
            " " +
            JSON.stringify(await js("window.smokeErrors")),
        );
      };
      const pluginJs = async (code) => {
        const child = win.webContents.mainFrame.frames.find((frame) =>
          frame.url.includes("codex-desktop"),
        );
        if (!child) throw new Error("Plugin iframe not found");
        return child.executeJavaScript(code, true);
      };
      await win.loadFile(join(dir, "index.html"));
      win.showInactive();
      await wait("Boolean(document.querySelector('iframe'))", "frame");
      let ready = false;
      for (let i = 0; i < 120; i++) {
        try {
          if (
            await pluginJs(
              "document.querySelector('#windows').options.length>0",
            )
          ) {
            ready = true;
            break;
          }
        } catch {}
        await delay(100);
      }
      if (!ready)
        throw new Error(
          "Fixture not listed: " +
            (await pluginJs("document.body.innerText")) +
            "; windows=" +
            JSON.stringify(
              await pluginJs("window.CanvasTTYPlugin.desktopWindows.list()"),
            ),
        );
      console.log(
        "PASS real sandboxed plugin lists the separate Codex fixture",
      );
      await pluginJs("document.querySelector('#attach').click(); true");
      let embedded = false;
      for (let i = 0; i < 120; i++) {
        if (await pluginJs("document.body.dataset.attached==='true'")) {
          embedded = true;
          break;
        }
        await delay(100);
      }
      if (!embedded)
        throw new Error(
          "Attach failed: " + (await pluginJs("document.body.innerText")),
        );
      await delay(300);
      let current = await state();
      if (current.parent === "0")
        throw new Error("Foreign HWND was not embedded");
      if (current.width < 800 || current.height < 400)
        throw new Error(
          "Native viewport was not sized: " + JSON.stringify(current),
        );
      current = await state("click");
      if (current.clicks !== 1)
        throw new Error("Foreign native control did not work");
      console.log(
        "PASS plugin → SDK → trusted iframe → IPC → separate native process, including live controls",
      );
      await js(
        "const modal=document.createElement('div');modal.id='fixture-modal';modal.setAttribute('role','dialog');modal.style.cssText='position:fixed;inset:0;z-index:999;background:black';document.body.append(modal);true",
      );
      await delay(350);
      current = await state();
      if (current.visible)
        throw new Error("Native content covered a host modal");
      await js("document.getElementById('fixture-modal').remove();true");
      await delay(350);
      current = await state();
      if (!current.visible)
        throw new Error("Native content did not return after closing modal");
      console.log(
        "PASS host modal hides the foreign native surface and closing it restores visibility",
      );
      await js(
        "document.querySelector('.plugin-canvas-card').style.width='760px'; true",
      );
      await delay(350);
      current = await state();
      if (current.width !== 760)
        throw new Error(
          "Native resize did not follow the card: " +
            JSON.stringify(current) +
            "; viewport=" +
            JSON.stringify(
              await js(
                "({visibility:document.visibilityState,width:innerWidth,height:innerHeight,rect:document.querySelector('iframe').getBoundingClientRect().toJSON(),point:document.elementFromPoint(40,150)?.tagName,errors:window.smokeErrors})",
              ),
            ) +
            "; host=" +
            win.isVisible(),
        );
      await pluginJs("document.querySelector('#detach').click(); true");
      await delay(600);
      current = await state();
      if (current.parent !== "0" || current.style !== original.style)
        throw new Error(
          "Foreign window was not restored: " + JSON.stringify(current),
        );
      console.log(
        "PASS resize follows canvas card; detach restores the living foreign window and original styles",
      );
      await pluginJs("document.querySelector('#attach').click();true");
      await delay(350);
      await js("window.smokeUnmount();true");
      await delay(350);
      current = await state();
      if (current.parent !== "0")
        throw new Error(
          "Closing the plugin card did not restore the foreign window",
        );
      console.log("PASS closing the plugin card restores the foreign window");
      await js("window.smokeMount();true");
      await delay(700);
      await pluginJs("document.querySelector('#attach').click();true");
      await delay(350);
      current = await state();
      if (current.parent === "0")
        throw new Error("Reopened plugin did not embed the fixture");
      const closed = once(win, "closed");
      win.close();
      await closed;
      current = await state();
      if (current.parent !== "0" || current.style !== original.style)
        throw new Error("Host shutdown did not restore the foreign window");
      console.log(
        "PASS closing CanvasTTY restores the foreign window before destroying the native parent",
      );
      fixture.stdin.write("quit\n");
      clearTimeout(deadline);
      await delay(250);
      app.exit(0);
    } catch (error) {
      console.error(error);
      fixture?.stdin.end();
      clearTimeout(deadline);
      app.exit(1);
    }
  })();
}
