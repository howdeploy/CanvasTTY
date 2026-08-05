<p align="center">
  <img src="docs/assets/canvastty-cover.png" alt="CanvasTTY — un escritorio espacial para terminales locales y agentes de IA" width="100%">
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.es.md"><strong>Español</strong></a> ·
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
      <strong>Tus terminales son lugares, no pestañas.</strong><br>
      CanvasTTY es un escritorio espacial en Electron para PTY locales reales y sesiones CLI de agentes de IA. Mantén una zona Home fija, organiza terminales en vivo sobre un lienzo infinito y consulta los límites de los proveedores con datos reales.
    </td>
  </tr>
</table>

## Stack

| Escritorio | Interfaz | Terminal | Proveedores |
|:--|:--|:--|:--|
| **Electron**<br>electron-vite | **React**<br>TypeScript | **xterm.js**<br>node-pty | **Codex**<br>Claude · Kimi |

## Un lienzo, sesiones reales

Lanza un shell o un agente en el directorio de un proyecto, mueve y redimensiona su terminal en vivo, aléjate para navegar de forma semántica y vuelve a Home para sesiones, límites, medios y accesos de lanzamiento. CanvasTTY mantiene el estado del PTY en el proceso main de confianza y expone al renderer solo capacidades tipadas y en lista blanca.

## Instalación

Descarga la vista previa pública `0.9.x` desde [GitHub Releases](https://github.com/howdeploy/CanvasTTY/releases): AppImage/deb para Linux x86_64, instalador/portable para Windows x64 y dmg/zip para macOS Apple Silicon. Los paquetes aún no están firmados ni notarizados; las builds para Intel Mac no se incluyen por ahora. Lee [instalación y seguridad de datos locales](docs/installing-and-security.md).

O ejecuta desde el código fuente:

```bash
npm install
npm run dev
```

## Documentación

| Empieza aquí | Extiende CanvasTTY |
|:--|:--|
| [Centro de documentación](docs/README.md) | [Creación de widgets](docs/widget-authoring.md) |
| [Primeros pasos](docs/getting-started.md) | [Métricas y telemetría](docs/metrics-and-telemetry.md) |
| [Instalación, releases y datos locales](docs/installing-and-security.md) | [Política de seguridad](SECURITY.md) |
| [Arquitectura](docs/ARCHITECTURE.md) | [Contrato de UI](docs/UI_CONTRACT.md) |

> CanvasTTY es actualmente un MVP de Electron. Los widgets personalizados son extensiones a nivel de código fuente; aún no hay un registro de plugins en runtime.

## Comprobaciones rápidas

```bash
npm test
npm run typecheck
npm run build
```
