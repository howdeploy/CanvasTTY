<p align="center">
  <img src="docs/assets/canvastty-cover.png" alt="CanvasTTY — пространственный рабочий стол для локальных терминалов и AI-агентов" width="100%">
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.pt-BR.md">Português</a> ·
  <a href="README.ru.md"><strong>Русский</strong></a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<table>
  <tr>
    <td>
      <strong>Терминалы — это места, а не вкладки.</strong><br>
      CanvasTTY — пространственный Electron-десктоп для настоящих локальных PTY и CLI-сессий AI-агентов. Фиксированная зона Home, живые терминалы на бесконечном канвасе и лимиты провайдеров, подкреплённые реальными источниками данных.
    </td>
  </tr>
</table>

## Стек

| Десктоп | Интерфейс | Терминал | Провайдеры |
|:--|:--|:--|:--|
| **Electron**<br>electron-vite | **React**<br>TypeScript | **xterm.js**<br>node-pty | **Codex**<br>Claude · Kimi |

## Один канвас, настоящие сессии

Запускайте shell или агента в каталоге проекта, перемещайте и растягивайте живой терминал, отдаляйте камеру, чтобы ориентироваться по смысловым сводкам, и возвращайтесь в Home — к сессиям, лимитам, медиа и кнопкам запуска. CanvasTTY хранит состояние PTY в доверенном main-процессе и открывает renderer доступ только к типизированным возможностям из белого списка.

## Установка

Скачайте публичный превью-релиз `0.9.x` из [GitHub Releases](https://github.com/howdeploy/CanvasTTY/releases): AppImage/deb для Linux x86_64, установщик и portable-версию для Windows x64, dmg/zip для macOS на Apple Silicon. Пакеты пока не имеют цифровой подписи и не заверены Apple (notarization); сборки для Intel Mac ещё нет. Сначала прочитайте про [установку и локальные данные](docs/installing-and-security.ru.md).

Или запустите из исходников:

```bash
npm install
npm run dev
```

## Документация

| С чего начать | Разработка для CanvasTTY |
|:--|:--|
| [Центр документации](docs/README.ru.md) | [Создание виджетов](docs/widget-authoring.ru.md) |
| [Быстрый старт](docs/getting-started.ru.md) | [Метрики и телеметрия](docs/metrics-and-telemetry.ru.md) |
| [Установка, релизы и локальные данные](docs/installing-and-security.ru.md) | [Политика безопасности](SECURITY.md) |
| [Архитектура](docs/ARCHITECTURE.md) | [UI-контракт](docs/UI_CONTRACT.md) |

> Сейчас CanvasTTY — Electron MVP. Пользовательские виджеты подключаются на уровне исходного кода; runtime-реестра плагинов пока нет.

## Быстрая проверка

```bash
npm test
npm run typecheck
npm run build
```
