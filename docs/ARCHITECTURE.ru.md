# Архитектура

[English](ARCHITECTURE.md) · [Русский](ARCHITECTURE.ru.md) · [简体中文](ARCHITECTURE.zh-CN.md)

## Границы процессов

CanvasTTY использует трёхслойную модель Electron:

```text
React renderer
    │ типизированный API window.canvasTTY
    ▼
preload bridge (contextBridge)
    │ IPC-каналы из белого списка
    ▼
Electron main process
    ├── SettingsStore  → проверенное атомарное JSON-хранилище
    ├── TerminalManager → lifecycle node-pty, ограниченный scrollback и batching вывода
    ├── LimitsService  → очищенные adapters лимитов и кэш
    ├── PluginManager  → установка из GitHub, manifest, assets, permissions, storage
    ├── PluginSecretsService → защищённое системное шифрование credentials плагинов с fail-closed поведением
    ├── PluginMediaService → разрешённые медиапапки, ranged audio streams, плейлисты
    ├── BrowserService → встроенные вкладки и lifecycle изолированных WebContentsView
    ├── canvastty-plugin:// → статические plugin resources под CSP
    ├── canvastty-media:// → локальные аудиопотоки с проверкой разрешений
    └── нативные dialogs/window controls
```

- `src/shared/contracts.ts` — единственный публичный контракт между процессами. Любое изменение межпроцессных данных сначала объявляется здесь.
- `src/preload/index.ts` открывает только типизированные возможности, нужные renderer. Node integration выключен, context isolation и sandbox включены.
- `src/main/ipc/registerIpc.ts` владеет нативными side effects и проверяет доступ к сохраняемым медиа.
- `src/main/services/TerminalManager.ts` — источник истины для живого состояния сессий и PTY buffers. Scrollback хранится в ограниченном chunk-буфере, а PTY data объединяются в IPC-пакеты по 16 мс, чтобы clear/redraw sequences попадали в xterm вместе. Новый PTY имеет статус `idle`; завершение процесса даёт только `done` или `failed`. `working` и `needs_approval` принимаются только как типизированные lifecycle signals провайдера и никогда не выводятся из существования PTY или текста терминала.
- `src/main/services/LimitsService.ts` читает Codex через app-server protocol установленного CLI, а Claude, Kimi, OpenCode Go и Grok Build — через provider usage/billing endpoints. Credentials читаются только в доверенном main-процессе, отправляются только соответствующему провайдеру по HTTPS, не логируются и не выходят через IPC. Сервис отвечает за timeout, structural normalization, cache, stale fallback и cleanup подпроцессов; сырые ответы провайдеров через IPC не проходят.
- `src/main/services/SettingsStore.ts` нормализует каждое изменение и сохраняет его сериализованной атомарной записью.
- `src/main/services/PluginManager.ts` устанавливает готовые статические репозитории без выполнения package scripts, отклоняет symlinks и слишком большие пакеты, хранит реестр включения, отдаёт только файлы внутри пакета и применяет permissions/storage quotas для каждого плагина.
- `src/main/services/PluginSecretsService.ts` сериализует запись секретов каждого плагина, шифрует весь ограниченный payload через Electron `safeStorage`, отклоняет plaintext-only backend и удаляет зашифрованный файл при uninstall.
- `src/main/services/PluginMediaService.ts` сохраняет разрешения только после нативного выбора папки, скрывает абсолютные пути, пропускает symlinks и отдаёт аудио с HTTP Range. Чтение плейлистов остаётся внутри разрешённых библиотек; ограниченная атомарная запись разрешена только в `Playlists/`.
- `src/main/services/BrowserService.ts` владеет вкладками встроенного браузера в `WebContentsView`. Удалённые страницы используют отдельный persistent partition с выключенным Node, включёнными context isolation/sandbox и отклонением website permissions по умолчанию. Это core service, а не возможность runtime-плагина.
- `TerminalManager` подмешивает MCP helper, не оставляя постоянных изменений в provider-конфигах. Claude Code и Codex получают CLI arguments, OpenCode — объединённый launch-only `OPENCODE_CONFIG_CONTENT` с одной scoped browser-tool permission, Kimi — per-run MCP config или временную запись с compare-and-swap и recovery journal для старых версий. Hermes получает временную запись `mcp_servers.canvastty_browser` в `HERMES_HOME/config.yaml` (по умолчанию `~/.hermes/config.yaml` в POSIX или `%LOCALAPPDATA%\hermes\config.yaml` в Windows); чувствительные capability-значения остаются ссылками на окружение дочернего процесса. Временная конфигурация Kimi и Hermes живёт до завершения последней владеющей PTY-сессии, после чего исходные байты точно восстанавливаются, если файл не менялся параллельно. Journal восстанавливает Hermes после прерванного запуска при следующем старте CanvasTTY, а compare-and-swap сохраняет одновременные пользовательские изменения. Сторонние MCP-записи, credentials и file/shell permissions не затрагиваются. OpenCode YOLO существует только как inline override текущего запуска, а Hermes получает штатный `--yolo`; постоянные permission-настройки не меняются.
- `src/main/services/providerCliRegistry.ts` — единственный владелец обнаружения provider CLI. При запуске main-процесса он создаёт один неизменяемый snapshot для Codex, Claude, Kimi, OpenCode, Hermes и Grok Build, последовательно проверяя smoke-only overrides, унаследованный `PATH`, системные каталоги платформы и известные пользовательские/provider-каталоги. Доступная запись хранит абсолютный executable, тип launcher-а и дополненный дочерний `PATH`; POSIX-кандидат обязан быть исполняемым файлом, а Windows-кандидат — поддерживаемым native или batch launcher-ом. `TerminalManager`, `LimitsService`, agent-browser probes и provider smoke используют один и тот же snapshot и не повторяют поиск команды. Недоступный CLI создаёт failed-сессию с копируемой диагностикой проверенных путей до создания PTY или временной browser-конфигурации, а соответствующий HOME limit остаётся `cli-not-found`. CanvasTTY не читает shell startup scripts; после установки или перемещения CLI приложение нужно перезапустить.

Основной `BrowserWindow` создаётся и показывается с лёгкой локальной стартовой страницей до инициализации settings, plugins, media и IPC. Успешная инициализация заменяет её доверенным renderer; bootstrap failure показывает видимую error page и сохраняет fallback на native dialog. Main process удерживает single-instance lock и восстанавливает/фокусирует существующее окно при повторном запуске.

Код runtime-плагина никогда не импортируется в main или доверенный renderer bundle. HOME widgets и canvas apps работают в sandboxed iframe с opaque origin. Отдельные plugin windows используют узкий preload, который пересылает тот же message SDK через IPC handler с проверкой фактического sender URL `canvastty-plugin://<id>/<entry>`. Произвольные нативные окна ОС не встраиваются.

Доступ плагина к музыке основан на capabilities, а не на общем доступе к файловой системе. Media scan возвращает library IDs, относительные пути, metadata и `canvastty-media://` stream URLs; сырой текст плейлиста остаётся единственным format-neutral содержимым файла. Media URL разрешается только включённому плагину-владельцу и только внутри ранее выбранного root библиотеки. Удаление плагина отзывает сохранённые folder grants.

Встроенный браузер разделён между поверхностями: `BrowserCard` рисует доверенный внешний chrome окна, вкладки, навигацию, agent badges, downloads, dialogs и canvas geometry, а `BrowserService` размещает активный native view поверх измеренного viewport карточки. Во время движения карточки или камеры native view остаётся live и получает coalesced geometry updates по кадрам; он скрывается только в semantic summary, при редактировании HOME и за trusted modal surfaces. Дробные renderer bounds расширяются до охватывающих device-independent pixels, а активный tab view переподключается только при фактической смене вкладки. Typed pointer bridge возвращает click/hover activity native page в canvas selection и явно восстанавливает фокус страницы, не блокируя её ввод. Само подключение или heartbeat не создаёт presence: badge появляется только после browser-команды, а cursor — только после появления реальной pointer position.

## Границы renderer

`App.tsx` — граница оркестрации. Он загружает settings/sessions, подписывается на события main process, координирует dialogs и persistence. Feature components не вызывают API несвязанных фич.

```text
App
├── WorkspaceCanvas        camera, pan, zoom, пространственная композиция
│   ├── HomeZone           сохраняемая сетка, граница и edit gestures
│   │   ├── homeModel      чистое получение строк лимитов/активных сессий
│   │   └── HomeMediaWidget независимые pick/replace/remove controls
│   ├── TerminalCard       xterm, selection, rename, drag, resize и snap
│   ├── PluginCanvasCard   sandboxed plugin app с bounds и summary
│   └── BrowserCard        доверенный browser chrome и geometry для native view
├── AgentLaunchDialog      фиксированный provider + folder + profile + launch
└── SettingsPanel          General, Appearance, Controls и Plugins
    └── PluginSettingsSection preview, permissions, registry и contributions
```

Domain decisions остаются в чистых selectors вроде `homeModel.ts`, orchestration — в `App.tsx`, rendering/local interaction — в feature components. IPC calls принадлежат `App.tsx` или фиче, которая единолично владеет capability.

## Поток сессии

1. Home запрашивает терминал или открывает provider-specific launch card.
2. `App` отправляет типизированный запрос `terminal:create`.
3. `TerminalManager` проверяет запрос, запускает PTY, хранит metadata и ограниченный chunked scrollback, затем отправляет lifecycle events и data events пакетами по 16 мс.
4. `App` согласует lifecycle snapshots по session ID.
5. `TerminalCard` подписывается на PTY stream, отправляет PTY input/grid resize и фиксирует типизированные canvas bounds после drag или edge resize.

`SessionMetadata` владеет world-space position и размером карточки. `App` согласует bounds, а `TerminalCard` может хранить transient geometry pointer-move до pointer-up. Main process проверяет и ограничивает размеры до отправки session snapshot. Camera wheel обрабатывается только на пустом canvas; интерактивные поверхности сохраняют native scroll/input ownership.

Одна живая `TerminalCard` владеет одним xterm instance на всё время жизни session ID. Смена palette обновляет `terminal.options.theme` на месте; title/settings не должны пересоздавать terminal или его renderer scrollback. Window title обновляется как session metadata через `terminal:rename`. PTY input/resize, пришедшие одновременно с exit, сдерживаются на границе main process и не превращаются в uncaught Electron errors.

Batching вывода — граница IPC/rendering, а не истории: каждый PTY chunk сразу добавляется в ограниченный scrollback, а ожидающий renderer output сбрасывается по таймеру 16 мс, перед exit и перед dispose. Trimming двигается по chunks вместо пересборки всего буфера на каждую запись; snapshot объединяет только сохранённый suffix.

Координаты указателя терминала преобразуются из визуально трансформированного rectangle канваса обратно в layout coordinates xterm до selection/wheel handling. Направления колеса терминала и канваса независимо нормализуются из сохранённых settings. Выделенный текст копируется через типизированный clipboard bridge по `Ctrl+C`, `Ctrl+Shift+C` или `Cmd+C`; вставка использует `Ctrl+Shift+V`, `Cmd+V` или `Shift+Insert` и входит в xterm через `Terminal.paste`, а не synthetic keystrokes. `Shift+Enter` отправляет CSI-u modified Enter напрямую в PTY.

Application shortcuts нормализуются в `SettingsStore`, сопоставляются в `App` и отображаются из тех же сохранённых bindings в canvas hint. `App` владеет эксклюзивным selection canvas application и выбранной terminal session для действий вроде rename. `TerminalCard` владеет xterm focus и inline editor, `BrowserService` — focus native page. Нажатие на пустой canvas снимает любой selection. Опциональный hover focus использует одинаковую настроенную задержку entry/exit для терминалов и встроенного Browser; focus-in/focus-out sequences программного перехода терминала подавляются до PTY input, чтобы TUI агента не сбрасывал позицию истории.

Session counters, progress bars и statuses всегда выводятся из настоящих `SessionSnapshot`. UI не синтезирует telemetry.

## Поток лимитов провайдера

1. `App` запрашивает очищенный `LimitsSnapshot` при bootstrap и каждые 60 секунд.
2. `LimitsService` дедуплицирует refresh и хранит 60-секундный cache.
3. Codex опрашивается через `codex app-server` методом `account/rateLimits/read`. Claude, Kimi, OpenCode Go и Grok Build используют read-only usage/billing endpoints и credentials установленных CLI. OpenCode Go отдаёт настоящие rolling, weekly и monthly windows; Grok Build — настоящий общий billing period. Ответы структурно проверяются и сокращаются до percentage, window и reset time.
4. Если refresh не удался после успешного чтения, последний валидный snapshot возвращается как stale. Отсутствующие/неподдерживаемые adapters возвращают явную unavailable reason, а не `0%`.
5. Weekly window Claude существует только для Claude.ai subscription session. API Usage Billing возвращает `subscription-required`, а не выдуманную quota. CanvasTTY не разбирает provider TUI screens.

## Точки расширения

- Новый provider добавляется в `ProviderId`, `providers.ts`, `TerminalManager.resolveLaunch`, карту официальных provider assets и опциональный безопасный limit adapter.
- Сохраняемая setting добавляется в `AppSettings`, defaults/normalization в `SettingsStore` и только во владеющую фичу. Settings владеет пользовательскими canvas controls и shortcuts; camera math и snapping geometry остаются чистыми renderer concerns.
- Canvas entity добавляется отдельным feature component с явной position и callbacks; camera ownership остаётся в `WorkspaceCanvas`.
- Runtime extension публикуется со статическими HTML/CSS/JS entries и `canvastty.plugin.json` API v1. Виды contributions: `home-widget`, `canvas-app`, `window`; capability access ограничен declared permissions. См. [Runtime-плагины](plugins.ru.md).

Каждое расширение должно пройти `npm run typecheck`, `npm run build` и проверку взаимодействия в настоящем Electron.
