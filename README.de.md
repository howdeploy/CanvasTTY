<p align="center">
  <img src="docs/assets/canvastty-cover.png" alt="CanvasTTY — ein räumlicher Desktop für lokale Terminals und KI-Agenten" width="100%">
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.de.md"><strong>Deutsch</strong></a> ·
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
      <strong>Ihre Terminals sind Orte, keine Tabs.</strong><br>
      CanvasTTY ist ein räumlicher Electron-Desktop für echte lokale PTYs und CLI-Sitzungen von KI-Agenten. Feste Home-Zone, Live-Terminals auf einer unendlichen Fläche und Provider-Limits aus realen Datenquellen.
    </td>
  </tr>
</table>

## Stack

| Desktop | Oberfläche | Terminal | Provider |
|:--|:--|:--|:--|
| **Electron**<br>electron-vite | **React**<br>TypeScript | **xterm.js**<br>node-pty | **Codex**<br>Claude · Kimi |

## Eine Fläche, echte Sitzungen

Starten Sie eine Shell oder einen Agenten im Projektverzeichnis, verschieben und skalieren Sie das Live-Terminal, zoomen Sie heraus zur semantischen Navigation und kehren Sie zu Home zurück — zu Sitzungen, Limits, Medien und Start-Shortcuts. CanvasTTY hält den PTY-Zustand im vertrauenswürdigen Main-Prozess und gibt dem Renderer nur typisierte, freigegebene Fähigkeiten frei.

## Installation

Laden Sie die öffentliche Vorschau `0.9.x` von [GitHub Releases](https://github.com/howdeploy/CanvasTTY/releases): AppImage/deb für Linux x86_64, Installer/portable App für Windows x64 und dmg/zip für Apple-Silicon-macOS. Pakete sind noch nicht code-signiert oder notarisiert; Intel-Mac-Builds fehlen vorerst. Siehe [Installation und lokale Datensicherheit](docs/installing-and-security.md).

Oder aus dem Quellcode starten:

```bash
npm install
npm run dev
```

## Dokumentation

| Hier starten | CanvasTTY erweitern |
|:--|:--|
| [Dokumentations-Hub](docs/README.md) | [Widget-Authoring](docs/widget-authoring.md) |
| [Erste Schritte](docs/getting-started.md) | [Metriken und Telemetrie](docs/metrics-and-telemetry.md) |
| [Installation, Releases und lokale Daten](docs/installing-and-security.md) | [Sicherheitsrichtlinie](SECURITY.md) |
| [Architektur](docs/ARCHITECTURE.md) | [UI-Vertrag](docs/UI_CONTRACT.md) |

> CanvasTTY ist derzeit ein Electron-MVP. Eigene Widgets sind Erweiterungen auf Quellcode-Ebene; ein Runtime-Plugin-Registry gibt es noch nicht.

## Schnellchecks

```bash
npm test
npm run typecheck
npm run build
```
