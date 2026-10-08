import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
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
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {index: resolve("src/main/index.ts"), SessionTimelineIndexWorker: resolve("src/main/services/SessionTimelineIndexWorker.ts")}
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
    // electron-vite leaves every bundle unminified; the renderer's (React, xterm and the app, about 1.8 MB)
    // is parsed on every window load, so it is minified. Source maps stay off, as before.
    build: {
      minify: "esbuild"
    }
  }
});
