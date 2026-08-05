<p align="center">
  <img src="docs/assets/canvastty-cover.png" alt="CanvasTTY — 로컬 터미널과 AI 에이전트를 위한 공간 데스크톱" width="100%">
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md"><strong>한국어</strong></a> ·
  <a href="README.pt-BR.md">Português</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<table>
  <tr>
    <td>
      <strong>터미널은 탭이 아니라 장소입니다.</strong><br>
      CanvasTTY는 실제 로컬 PTY와 AI 에이전트 CLI 세션을 위한 Electron 공간 데스크톱입니다. 고정 Home 영역, 무한 캔버스 위의 라이브 터미널, 실제 데이터 소스 기반 프로바이더 한도를 제공합니다.
    </td>
  </tr>
</table>

## 스택

| 데스크톱 | 인터페이스 | 터미널 | 프로바이더 |
|:--|:--|:--|:--|
| **Electron**<br>electron-vite | **React**<br>TypeScript | **xterm.js**<br>node-pty | **Codex**<br>Claude · Kimi |

## 하나의 캔버스, 실제 세션

프로젝트 디렉터리에서 셸 또는 에이전트를 실행하고, 라이브 터미널을 이동·크기 조절하세요. 축소해 의미적으로 탐색하고, Home으로 돌아와 세션·한도·미디어·실행 단축키를 확인합니다. CanvasTTY는 신뢰할 수 있는 main 프로세스에 PTY 상태를 두고, renderer에는 타입이 지정된 허용 목록 기능만 노출합니다.

## 설치

[GitHub Releases](https://github.com/howdeploy/CanvasTTY/releases)에서 공개 프리뷰 `0.9.x`를 받으세요. Linux x86_64는 AppImage/deb, Windows x64는 설치 프로그램/포터블, Apple Silicon macOS는 dmg/zip입니다. 패키지는 아직 코드 서명·공증되지 않았고, Intel Mac 빌드는 포함되지 않습니다. 먼저 [설치 및 로컬 데이터 보안](docs/installing-and-security.md)을 읽으세요.

소스에서 실행:

```bash
npm install
npm run dev
```

## 문서

| 여기서 시작 | CanvasTTY 확장 |
|:--|:--|
| [문서 허브](docs/README.md) | [위젯 작성](docs/widget-authoring.md) |
| [시작하기](docs/getting-started.md) | [메트릭과 텔레메트리](docs/metrics-and-telemetry.md) |
| [설치, 릴리스, 로컬 데이터](docs/installing-and-security.md) | [보안 정책](SECURITY.md) |
| [아키텍처](docs/ARCHITECTURE.md) | [UI 계약](docs/UI_CONTRACT.md) |

> CanvasTTY는 현재 Electron MVP입니다. 커스텀 위젯은 소스 수준 확장이며, 런타임 플러그인 레지스트리는 아직 없습니다.

## 빠른 검사

```bash
npm test
npm run typecheck
npm run build
```
