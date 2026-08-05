<p align="center">
  <img src="docs/assets/canvastty-cover.png" alt="CanvasTTY — a spatial desktop for local terminals and AI agents" width="100%">
</p>

<p align="center">
  <a href="README.md"><strong>English</strong></a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.pt-BR.md">Português</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<table>
  <tr>
    <td>
      <strong>Your terminals are places, not tabs.</strong><br>
      CanvasTTY is an Electron spatial desktop for real local PTYs and AI-agent CLI sessions. Keep a fixed Home zone, arrange live terminals on an infinite canvas, and see provider limits backed by real data sources.
    </td>
  </tr>
</table>

## Stack

| Desktop | Interface | Terminal | Providers |
|:--|:--|:--|:--|
| **Electron**<br>electron-vite | **React**<br>TypeScript | **xterm.js**<br>node-pty | **Codex**<br>Claude · Kimi |

## One canvas, real sessions

Launch a shell or agent in a project directory, move and resize its live terminal, zoom out to navigate semantically, and return to Home for sessions, limits, media, and launch shortcuts. CanvasTTY keeps PTY state in the trusted main process and exposes only typed, allow-listed capabilities to the renderer.

## Install

Download the `0.9.x` public preview from [GitHub Releases](https://github.com/howdeploy/CanvasTTY/releases): AppImage/deb for Linux x86_64, installer/portable app for Windows x64, and dmg/zip for Apple Silicon macOS. Packages are not yet code-signed or notarized; Intel Mac builds are not included yet. Read [installing and local-data security](docs/installing-and-security.md).

Or run from source:

```bash
npm install
npm run dev
```

## Docs

| Start here | Build on CanvasTTY |
|:--|:--|
| [Documentation hub](docs/README.md) | [Widget authoring](docs/widget-authoring.md) |
| [Getting started](docs/getting-started.md) | [Metrics and telemetry](docs/metrics-and-telemetry.md) |
| [Install, releases, and local data](docs/installing-and-security.md) | [Security policy](SECURITY.md) |
| [Architecture](docs/ARCHITECTURE.md) | [UI contract](docs/UI_CONTRACT.md) |

> CanvasTTY is currently an Electron MVP. Custom widgets are source-level extensions; there is no runtime plugin registry yet.

## Quick checks

```bash
npm test
npm run typecheck
npm run build
```
