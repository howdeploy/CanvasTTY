import { resolve } from "node:path";
import { cpSync, mkdirSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { build as buildPreload } from "esbuild";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    define: {
      __CANVASTTY_GITHUB_OAUTH_CLIENT_ID__: JSON.stringify(
        process.env.GITHUB_OAUTH_CLIENT_ID?.trim()
          || process.env.CANVASTTY_GITHUB_CLIENT_ID?.trim()
          || ""
      )
    },
    plugins: [externalizeDepsPlugin(), {
      name: "canvaslink-host-assets",
      closeBundle() {
        const destination = resolve("out/main/canvaslink/host");
        mkdirSync(destination, { recursive: true });
        cpSync(resolve("integrations/canvaslink/host"), destination, { recursive: true });
      }
    }],
    build: {
      rollupOptions: {
        input: resolve("src/main/index.ts")
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), {
      name: "standalone-sandbox-preload",
      async closeBundle() {
        // Each sandboxed preload must be self-contained: its require cannot load local chunks.
        await buildPreload({ entryPoints: [resolve("src/preload/browserWindow.ts")],
          outfile: resolve("out/preload/browserWindow.cjs"), bundle: true,
          platform: "node", format: "cjs", external: ["electron"] });
      }
    }],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          browser: resolve("src/preload/browser.ts"),
          plugin: resolve("src/preload/plugin.ts")
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs"
        }
      }
    }
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react()],
    worker: { format: "es" },
    // electron-vite leaves every bundle unminified; the renderer's (React, xterm and the app, about 1.8 MB)
    // is parsed on every window load, so it is minified. Source maps stay off, as before.
    build: {
      minify: "esbuild",
      rollupOptions: { input: { index: resolve("src/renderer/index.html"), browserWindow: resolve("src/renderer/browser-window.html") } }
    }
  }
});
