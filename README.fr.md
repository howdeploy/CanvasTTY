<p align="center">
  <img src="docs/assets/canvastty-cover.png" alt="CanvasTTY — un bureau spatial pour terminaux locaux et agents d’IA" width="100%">
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.fr.md"><strong>Français</strong></a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.pt-BR.md">Português</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<table>
  <tr>
    <td>
      <strong>Vos terminaux sont des lieux, pas des onglets.</strong><br>
      CanvasTTY est un bureau spatial Electron pour de vrais PTY locaux et des sessions CLI d’agents d’IA. Zone Home fixe, terminaux live sur un canevas infini, et quotas fournisseurs adossés à de vraies sources de données.
    </td>
  </tr>
</table>

## Stack

| Bureau | Interface | Terminal | Fournisseurs |
|:--|:--|:--|:--|
| **Electron**<br>electron-vite | **React**<br>TypeScript | **xterm.js**<br>node-pty | **Codex**<br>Claude · Kimi |

## Un canevas, de vraies sessions

Lancez un shell ou un agent dans le dossier d’un projet, déplacez et redimensionnez le terminal live, zoomez pour une navigation sémantique, puis revenez à Home pour les sessions, quotas, médias et raccourcis de lancement. CanvasTTY garde l’état PTY dans le processus main de confiance et n’expose au renderer que des capacités typées et autorisées.

## Installation

Téléchargez la préversion publique `0.9.x` depuis [GitHub Releases](https://github.com/howdeploy/CanvasTTY/releases) : AppImage/deb pour Linux x86_64, installateur/portable pour Windows x64, dmg/zip pour macOS Apple Silicon. Les paquets ne sont pas encore signés ni notarisés ; les builds Intel Mac ne sont pas encore fournies. Lisez [installation et sécurité des données locales](docs/installing-and-security.md).

Ou lancez depuis les sources :

```bash
npm install
npm run dev
```

## Documentation

| Commencer ici | Étendre CanvasTTY |
|:--|:--|
| [Hub documentation](docs/README.md) | [Création de widgets](docs/widget-authoring.md) |
| [Premiers pas](docs/getting-started.md) | [Métriques et télémétrie](docs/metrics-and-telemetry.md) |
| [Install, releases et données locales](docs/installing-and-security.md) | [Politique de sécurité](SECURITY.md) |
| [Architecture](docs/ARCHITECTURE.md) | [Contrat UI](docs/UI_CONTRACT.md) |

> CanvasTTY est pour l’instant un MVP Electron. Les widgets personnalisés s’ajoutent au niveau du code source ; il n’y a pas encore de registre de plugins à l’exécution.

## Vérifications rapides

```bash
npm test
npm run typecheck
npm run build
```
