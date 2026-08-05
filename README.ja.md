<p align="center">
  <img src="docs/assets/canvastty-cover.png" alt="CanvasTTY — ローカル端末と AI エージェント向けの空間デスクトップ" width="100%">
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.ja.md"><strong>日本語</strong></a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.pt-BR.md">Português</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<table>
  <tr>
    <td>
      <strong>ターミナルはタブではなく「場所」です。</strong><br>
      CanvasTTY は、本物のローカル PTY と AI エージェント CLI セッションのための Electron 空間デスクトップです。固定の Home ゾーン、無限キャンバス上のライブ端末、実データに基づくプロバイダ制限を備えています。
    </td>
  </tr>
</table>

## スタック

| デスクトップ | UI | ターミナル | プロバイダ |
|:--|:--|:--|:--|
| **Electron**<br>electron-vite | **React**<br>TypeScript | **xterm.js**<br>node-pty | **Codex**<br>Claude · Kimi |

## 1 枚のキャンバス、本物のセッション

プロジェクトディレクトリでシェルやエージェントを起動し、ライブ端末を移動・リサイズ。ズームアウトして意味的に俯瞰し、Home に戻ってセッション・制限・メディア・起動ショートカットを確認できます。CanvasTTY は信頼できる main プロセスで PTY 状態を保持し、renderer には型付きの許可リスト能力のみを公開します。

## インストール

[GitHub Releases](https://github.com/howdeploy/CanvasTTY/releases) から公開プレビュー `0.9.x` を入手してください。Linux x86_64 は AppImage/deb、Windows x64 はインストーラ/ポータブル、Apple Silicon macOS は dmg/zip です。パッケージはまだコード署名・公証されておらず、Intel Mac ビルドは未提供です。[インストールとローカルデータのセキュリティ](docs/installing-and-security.md) を先に読んでください。

ソースから実行する場合:

```bash
npm install
npm run dev
```

## ドキュメント

| まずはここから | CanvasTTY を拡張する |
|:--|:--|
| [ドキュメントハブ](docs/README.md) | [ウィジェット作成](docs/widget-authoring.md) |
| [はじめに](docs/getting-started.md) | [メトリクスとテレメトリ](docs/metrics-and-telemetry.md) |
| [インストール、リリース、ローカルデータ](docs/installing-and-security.md) | [セキュリティポリシー](SECURITY.md) |
| [アーキテクチャ](docs/ARCHITECTURE.md) | [UI 契約](docs/UI_CONTRACT.md) |

> CanvasTTY は現時点で Electron MVP です。カスタムウィジェットはソースレベルの拡張で、ランタイムのプラグインレジストリはまだありません。

## クイックチェック

```bash
npm test
npm run typecheck
npm run build
```
