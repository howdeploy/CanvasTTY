https://github.com/user-attachments/assets/444612f7-cda1-4fd6-8514-2f4fac9cc520

<p align="center">
  <a href="README.md">English</a> ·
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
| **Electron**<br>electron-vite | **React**<br>TypeScript | **xterm.js**<br>node-pty | **Codex**<br>Claude · Kimi · OpenCode · Hermes · Grok Build |

Интерфейс приложения сейчас поддерживает английский и русский языки. Документация также доступна на упрощённом китайском.

## Один канвас, настоящие сессии

Запускайте shell или агента в каталоге проекта, перемещайте и растягивайте живой терминал, отдаляйте камеру, чтобы ориентироваться по смысловым сводкам, и возвращайтесь в Home — к сессиям, лимитам, медиа и кнопкам запуска. CanvasTTY хранит состояние PTY в доверенном main-процессе и открывает renderer доступ только к типизированным возможностям из белого списка.

## Терминалы и CLI-провайдеры в Windows

В Windows кнопка Terminal запускает встроенный Windows PowerShell в чистой сессии `-NoLogo -NoProfile`, а при его недоступности использует `pwsh` или `cmd.exe`. Перед передачей в `node-pty`/ConPTY CanvasTTY находит для Codex, Claude, Kimi, OpenCode, Hermes и Grok Build конкретный файл `.exe`, `.com`, `.cmd` или `.bat`: сначала в пользовательском `PATH`, затем в стандартных каталогах CLI.

CanvasTTY не устанавливает CLI провайдеров. Если нужный CLI отсутствует, окно запуска сообщает, какой провайдер не найден и какие каталоги были проверены. Установите CLI и перезапустите CanvasTTY, чтобы desktop-процесс получил обновлённое окружение.

## Установка

Скачайте свежий релиз из [GitHub Releases](https://github.com/howdeploy/CanvasTTY/releases): AppImage/deb для Linux x86_64, установщик и portable-версию для Windows x64, dmg/zip для macOS на Apple Silicon. Бандлы macOS подписаны ad-hoc и проходят проверку целостности, но не имеют Developer ID и notarization Apple; пакеты Windows остаются неподписанными. Сборки для Intel Mac ещё нет. Сначала прочитайте про [установку и локальные данные](docs/installing-and-security.ru.md).

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
| [Встроенный браузер и журнал аудита](docs/browser.ru.md) | [Встроенный browser skill агента](agent/browser/SKILL.md) |
| [Установка, релизы и локальные данные](docs/installing-and-security.ru.md) | [Политика безопасности](SECURITY.ru.md) |
| [Архитектура](docs/ARCHITECTURE.ru.md) | [UI-контракт](docs/UI_CONTRACT.ru.md) |
| [Разработка runtime-плагинов](docs/plugins.ru.md) | [Типы SDK плагинов](docs/plugin-api.d.ts) |
| [История изменений](CHANGELOG.ru.md) | [Лицензия MIT](LICENSE) |

## Runtime-плагины

CanvasTTY включает permissioned runtime для готовых статических GitHub-пакетов: HOME widgets, canvas apps и отдельные sandboxed окна. Host SDK поддерживает постоянные разрешения на выбранные пользователем музыкальные папки, seekable-потоки локального аудио и ограниченный импорт/экспорт плейлистов — этого достаточно для полноценного плеера-плагина. См. [руководство автора и модель безопасности](docs/plugins.ru.md), [схему manifest](docs/canvastty-plugin.schema.json) и [TypeScript-типы SDK](docs/plugin-api.d.ts).

Примеры плагинов:

- [canvastty-plugin-hermes-hud](https://github.com/howdeploy/canvastty-plugin-hermes-hud) — от автора CanvasTTY: HOME-виджет, который запускает и останавливает установленный Hermes Desktop в HUD-режиме и показывает подтверждённое состояние живого процесса; использует только узкое разрешение `hermes:hud`.
- [canvastty-music](https://github.com/Alitryel/canvastty-music) — от [@Alitryel](https://github.com/Alitryel): компактный плеер для локальных папок с музыкой и Яндекс Музыки с отдельным полноразмерным окном библиотеки, плейлистами, очередями воспроизведения и опциональным анимированным питомцем.
- [canvastty-plugin-hermes-dashboard](https://github.com/4444cjtr/canvastty-plugin-hermes-dashboard) — от [@4444cjtr](https://github.com/4444cjtr): HOME-виджет, который проверяет, запущен ли локальный Hermes Agent dashboard, запускает его через небольшой loopback-helper и открывает прямо в CanvasTTY как встроенную browser-карточку на канвасе.

## Встроенный браузер для агентов

CanvasTTY включает core-браузер, а не plugin capability: доверенная React-панель поверх sandboxed Electron `WebContentsView` с единым постоянным Chromium-профилем. Браузер запускается из HOME, восстанавливает безопасные HTTP(S)-вкладки, оставляет учётные данные сайтов внутри Chromium, управляет загрузками и даёт типизированные browser actions сессиям Claude Code, Codex, Kimi, OpenCode и Hermes, запущенным через CanvasTTY.

Карточка браузера использует ту же модель выбора, hover focus, перемещения, resize и semantic zoom, что и терминалы. В Settings находятся доступ агентов, восстановление вкладок, последние загрузки/действия и очистка browser data. Связь с агентами идёт через аутентифицированный локальный socket или named pipe и встроенный stdio MCP helper — без TCP, remote-debugging port, передачи cookies, паролей, auth headers, local storage, произвольного JavaScript или raw CDP.

Каждая browser-команда оставляет очищенную локальную запись. Постоянные JSONL-файлы журнала образуют hash chain в Electron `userData/browser/audit`, ротируются при 100 МБ и при инициализации или ротации удаляют ротированные файлы старше 30 дней. В журнал не попадают введённый/страничный текст, screenshots, credentials, query/fragment URL, headers, cookies и tokens. Подробнее: [браузер и журнал аудита](docs/browser.ru.md), [архитектура](docs/ARCHITECTURE.ru.md).

## Быстрая проверка

```bash
npm test
npm run typecheck
npm run build
```

## Лицензия

CanvasTTY распространяется по [лицензии MIT](LICENSE).
