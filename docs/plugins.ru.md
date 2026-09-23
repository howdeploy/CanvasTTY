# Runtime-плагины

[English](plugins.md) · [Русский](plugins.ru.md) · [简体中文](plugins.zh-CN.md) · [Документация](README.ru.md)

Runtime-плагин CanvasTTY устанавливается из HTTPS GitHub-репозитория. Он может добавить sandboxed web-поверхности и опционально объявить scripts хуков агентов. Web-contributions работают без Node.js; каждый hook script остаётся выключенным, пока пользователь отдельно не включит его в **Настройки → Агенты → Хуки**.

## Модель доверия

Установка плагина разрешает стороннему browser-коду выполняться локально. CanvasTTY уменьшает поверхность риска, но не может сделать неизвестный код доверенным:

- CanvasTTY скачивает только tar-архив default branch по корневой ссылке GitHub-репозитория и не запускает `npm install`, build hooks, нативные модули или scripts репозитория во время установки/обновления.
- В пакете запрещены symlink; лимит — 500 файлов или каталогов / 25 МБ, один отдаваемый ресурс — не больше 8 МБ.
- Iframe получает opaque sandbox origin, не видит parent DOM, `window.canvasTTY` и Node.js API.
- Узкий preload отдельного окна не открывает Node primitives и передаёт те же SDK-запросы через IPC с проверкой plugin/contribution по фактическому URL.
- Каждый привилегированный SDK-метод требует permission из manifest. Полный список разрешений показывается до подтверждения установки.
- Sandboxed web-contributions не получают учётные данные провайдеров, PTY buffer, рабочие каталоги, сырые ответы API или доступ к файловой системе.
- Выключение или удаление плагина сразу прекращает отдачу его ресурсов и закрывает отдельные окна.
- Agent hooks никогда не включаются автоматически. Включённый hook script эквивалентен нативному приложению: он получает payload события агента, выполняется с правами учётной записи пользователя и потенциально видит доступные ей конфиги или credentials. Обновление, смена modules или выключение плагина отзывает все такие разрешения.

CanvasTTY не встраивает произвольные нативные окна ОС. Contribution `window` — это sandboxed `BrowserWindow`, которым владеет CanvasTTY. Native reparenting ненадёжен и непереносим между Wayland, macOS, Windows, разными DPI, popup и GPU surfaces.

## Структура пакета

В корне репозитория обязателен `canvastty.plugin.json`. Entry — относительный путь к готовому статическому HTML; inline scripts блокируются plugin CSP.

```text
canvastty.plugin.json
shared/plugin.css
widgets/status.html
widgets/status.js
apps/notes.html
apps/notes.js
windows/focus.html
windows/focus.js
hooks/audit.mjs
```

Рабочий пример sandboxed web-поверхностей без привилегированного хука: [`examples/plugins/studio-kit`](../examples/plugins/studio-kit).
Для IDE доступны [JSON Schema manifest](canvastty-plugin.schema.json) и [TypeScript declarations SDK](plugin-api.d.ts).

## Manifest v1

```json
{
  "apiVersion": 1,
  "id": "com.example.studio-kit",
  "name": "Studio Kit",
  "version": "1.0.0",
  "description": "Небольшие поверхности CanvasTTY на реальных данных host.",
  "permissions": ["storage", "secrets", "sessions:read", "launcher:open"],
  "hooks": [
    {
      "id": "audit",
      "title": "Локальный журнал аудита",
      "description": "Записывает выбранные события жизненного цикла агента в журнал под управлением пользователя.",
      "entry": "hooks/audit.mjs",
      "providers": ["codex", "claude", "kimi"],
      "events": ["session-start", "permission-request", "session-end"]
    }
  ],
  "settingsContribution": "notes",
  "contributions": [
    {
      "id": "session-status",
      "kind": "home-widget",
      "title": "Session status",
      "entry": "widgets/status.html",
      "defaultSize": { "columns": 4, "rows": 2 }
    },
    {
      "id": "notes",
      "kind": "canvas-app",
      "title": "Notes",
      "entry": "apps/notes.html",
      "defaultSize": { "width": 680, "height": 440 },
      "minSize": { "width": 320, "height": 180 }
    },
    {
      "id": "focus",
      "kind": "window",
      "title": "Focus",
      "entry": "windows/focus.html",
      "defaultSize": { "width": 900, "height": 620 }
    }
  ]
}
```

ID плагина и contribution — стабильные ключи persistence: после публикации их нельзя переименовывать. Версия использует semantic version. Опциональный `settingsContribution` ссылается на один `canvas-app`: CanvasTTY показывает для него отдельное действие **Настройки** в меню расширений. Каждый установленный `home-widget` также появляется рядом со встроенными виджетами в разделе **Настройки → Оформление → Состав HOME**, где он добавляется или удаляется. Опциональный `minSize` поддерживается для `canvas-app` и `window`, не может превышать `defaultSize` и ограничен снизу размером 240 × 140 px. Для старых manifest сохраняется минимум хоста 320 × 220 px. HOME начинает с просторной логической сетки 16 × 12, сохраняя исходную композицию 12 × 8. В редакторе видимая граница растягивается до 48 × 36 без уменьшения ячеек, а при нехватке места новый виджет расширяет её автоматически. Canvas app использует world-space pixels и участвует в том же snapping, что терминальные карточки.

Поле `platforms` необязательно; если оно задано, список должен содержать `"canvastty"`, иначе прямая установка или обновление отклоняются. `minHostVersion` носит информационный характер: витрина помечает плагины для более новой версии host, но не блокирует установку. Старые минимальные версии не считаются несовместимостью.

### Необязательные модули

Модульный manifest объявляет проверяемые по целостности coreFiles и до 16 необязательных modules. Для каждого файла задаются path, точный размер bytes и SHA-256. CanvasTTY загружает для предпросмотра только manifest, показывает галочки, размер и разрешения каждого модуля, а затем скачивает только ядро и выбранные модули. Последующее изменение выбора атомарно заменяет установленный пакет и удаляет файлы отключённых модулей. Поле module у contribution скрывает его, если соответствующий модуль не установлен.

Целостность файлов модулей (точный размер в байтах и SHA-256) проверяется по хэшам, объявленным в manifest плагина, а сам manifest загружается с GitHub по TLS без отдельной подписи. Поэтому якорем доверия является GitHub-репозиторий плагина: скомпрометированный репозиторий может опубликовать новый manifest с совпадающими хэшами.

### Опциональные хуки агентов

Поле `hooks` объявляет до 16 JavaScript entries (`.js`, `.mjs`, `.cjs`). Для каждого задаются стабильные `id`, `title`, `entry`, список `providers` и семантические `events`: `session-start`, `prompt-submit`, `permission-request`, `permission-result`, `after-tool`, `stop`, `session-end`. Не поддерживаемые конкретным provider события пропускаются. В modular plugin entry хука должен быть integrity-объявлен в его опциональном `module`, а без module — в `coreFiles`. Non-modular пакет обязан содержать файл по проверенному entry path.

Hook-only plugin использует пустой массив `contributions` и непустой `hooks`. Установка только копирует и проверяет файлы. Перед включением пользователь должен проверить исходник и репозиторий, затем отдельно подтвердить доверие в **Настройки → Агенты → Хуки**. Host-owned registry проверяется при каждом вызове, поэтому выключение блокирует последующие запуски даже в уже работающей сессии. Если launch-time bridge provider ещё не установлен, для включения понадобится новая или перезапущенная сессия агента.

Собственная проверка хуков provider остаётся обязательной. Например, Codex может дополнительно попросить проверить launch-time bridge CanvasTTY через свой `/hooks`. CanvasTTY не передаёт глобальный флаг Codex `--dangerously-bypass-hook-trust`: включение plugin hook не ослабляет проверку других хуков provider.

Script запускается отдельным процессом из каталога плагина и получает JSON через stdin с полями `apiVersion`, `pluginId`, `hookId`, `terminalSessionId`, `provider`, `event`, `providerEvent`, `payload`. Stdout/stderr отбрасываются, время выполнения ограничено, внутренние capability-токены CanvasTTY удаляются из environment. Это защита host internals, а не sandbox: script всё ещё может читать/менять файлы и запускать процессы с обычными правами пользователя.

host.onStorageChange(listener) сообщает всем открытым поверхностям того же плагина — canvas cards, HOME widgets и отдельным окнам — об изменениях через host.storage.set, поэтому нескольким поверхностям не требуется постоянный polling.

## Permissions

| Permission | Возможность SDK | Граница данных |
|:--|:--|:--|
| `storage` | `storage.get`, `storage.set` | Изолированное JSON-хранилище, 64 КБ на плагин |
| `secrets` | `secrets.get`, `secrets.set`, `secrets.delete` | Строковые секреты, зашифрованные через Electron `safeStorage`; без защищённого хранилища ОС вызов завершается ошибкой |
| `sessions:read` | `sessions.list` | Только ID, provider, title, status, startedAt и exitCode |
| `limits:read` | `limits.get` | Тот же очищенный `LimitsSnapshot`, который использует HOME |
| `launcher:open` | `launcher.open` | Открывает штатную Focus Card или запуск терминала; не обходит пользовательский выбор |
| `external:open` | `external.open` | Передаёт ОС только явную HTTP(S)-ссылку |
| `browser:open` | `browser.open` | Открывает только явную HTTP(S)-ссылку во встроенной карточке Browser и её общей browser-сессии, включая localhost |
| `media:library` | `media.*` | Только выбранные пользователем музыкальные папки; абсолютные пути не раскрываются, аудио отдаётся seekable-потоками `canvastty-media://` |
| `playlists:read` | `playlists.list`, `playlists.read` | Читает `.m3u`, `.m3u8` и `.pls` в разрешённой музыкальной папке, а `.json` — только в её `Playlists/`, до 4 МБ на файл |
| `playlists:write` | `playlists.write` | Атомарно записывает плейлист в каталог `Playlists/` разрешённой папки, до 4 МБ |
| `network` | browser `fetch` | Разрешает HTTPS и loopback в CSP; учётные данные CanvasTTY не прикрепляются |

Permission не открывает generic IPC. Неизвестные методы и permissions отклоняются.

## SDK

Подключите host SDK внешним script:

```html
<script src='canvastty-plugin://host/sdk.js'></script>
<script src='./index.js'></script>
```

SDK создаёт `window.CanvasTTYPlugin`:

```js
const host = window.CanvasTTYPlugin;

host.onContext(({ appearance, contribution }) => {
  document.documentElement.dataset.palette = appearance.palette;
  document.title = contribution.title;
});

const sessions = await host.request("sessions.list");
await host.storage.set("draft", { text: "Локально для этого плагина" });
const draft = await host.storage.get("draft");
await host.secrets.set("oauth-token", token);
const restoredToken = await host.secrets.get("oauth-token");
await host.request("launcher.open", { provider: "codex" });
await host.canvas.open("notes");
await host.request("window.open", { contributionId: "focus" });
await host.request("browser.open", { url: "http://localhost:9210" });

const library = await host.media.pickLibrary();
if (library) {
  const audio = document.querySelector("audio");
  const tracks = await host.media.scanLibrary(library.id);
  if (audio) audio.src = tracks[0]?.streamUrl ?? "";
  const playlists = await host.playlists.list(library.id);
  const text = playlists[0] ? await host.playlists.read(library.id, playlists[0].id) : "";
  await host.playlists.write(library.id, "favorites.m3u8", text || "#EXTM3U\n");
}
```

Поддержаны `host.getContext`, `storage.*`, `secrets.*`, `sessions.list`, `limits.get`, `launcher.open`, `canvas.open`, `external.open`, `browser.open`, `window.open`, `media.*` и `playlists.*`. `canvas.open` открывает или фокусирует `canvas-app` того же плагина и по возможности ставит его рядом с вызывающей карточкой. `browser.open` завершается только после создания или фокусировки Browser-card workspace и одной навигации; принимаются лишь нормализованные HTTP(S)-URL, а не текст для поиска, `file:`, `data:`, `javascript:`, `about:` или URL с учётными данными. `window.open` может открыть только contribution типа `window` из того же manifest.

Используйте `storage` для несекретных JSON-настроек, а `secrets` — только для OAuth-токенов, API-ключей и других учётных данных. Поддерживается до 32 строковых ключей, 16 КБ на значение и 64 КБ на плагин. Секреты удаляются при uninstall и никогда не сохраняются в plaintext; если ОС не предоставляет защищённое шифрование, вызов явно завершается ошибкой.

Разрешения музыкальных библиотек сохраняются между перезапусками, перечисляются и отзываются только владеющим плагином. Сканирование пропускает symlink и возвращает относительные пути, метаданные и непрозрачные stream URL вместо абсолютного корня библиотеки. При удалении плагина все его разрешения на папки отзываются. Содержимое плейлиста возвращается как записано и не привязано к формату: плеер может использовать стандартные M3U/PLS или собственную JSON-схему; импортированный плейлист сам может содержать абсолютные пути.

### Как написать полноценный плеер-плагин

Локальному плееру обычно нужны:

```json
"permissions": ["storage", "media:library", "playlists:read", "playlists:write"]
```

Добавляйте `network` только для удалённых каталогов, радио, обложек или стримов; `external:open` — только для явных ссылок, открываемых в системном браузере; а `browser:open` — только для явных HTTP(S)-страниц, предназначенных для общей встроенной browser-сессии CanvasTTY. `storage` предназначен для настроек плеера, избранного, очереди и небольших JSON-метаданных; сами аудиофайлы остаются в выбранных пользователем папках.

| Вызов SDK | Результат и назначение |
|:--|:--|
| `host.media.pickLibrary()` | Открывает системный выбор каталога и сохраняет разрешение; возвращает `{ id, name }` или `null` при отмене |
| `host.media.listLibraries()` | Восстанавливает разрешённые этому плагину библиотеки после перезапуска, не раскрывая абсолютные пути |
| `host.media.scanLibrary(libraryId)` | Рекурсивно возвращает до 20 000 поддерживаемых треков: ID, имя, относительный путь, размер, MIME type и `streamUrl` |
| `host.media.revokeLibrary(libraryId)` | Отзывает разрешение этого плагина на выбранную папку |
| `host.playlists.list(libraryId)` | Перечисляет до 2 000 доступных плейлистов внутри разрешённой библиотеки |
| `host.playlists.read(libraryId, playlistId)` | Возвращает исходный UTF-8 текст плейлиста размером до 4 МБ |
| `host.playlists.write(libraryId, name, content)` | Атомарно записывает `.m3u`, `.m3u8`, `.pls` или `.json` в каталог `Playlists/` библиотеки, до 4 МБ |

Сканируются аудиофайлы `.aac`, `.flac`, `.m4a`, `.mp3`, `.oga`, `.ogg`, `.opus`, `.wav` и `.webm`. `track.streamUrl` можно сразу назначить элементу `<audio>`: host поддерживает byte-range responses, поэтому определение длительности и перемотка работают. Плагин с `media:library` также может выполнить `fetch(track.streamUrl)`, если байты нужны для разбора метаданных в браузере. Полные overloads методов и result interfaces находятся в [`plugin-api.d.ts`](plugin-api.d.ts).

Рекомендуемый запуск: вызвать `listLibraries()`, предложить `pickLibrary()` только если разрешённых папок ещё нет, просканировать выбранную библиотеку, восстановить очередь и настройки из `storage`, затем получить и разобрать плейлисты. Отозванную или перемещённую папку показывайте явным состоянием «недоступно» и предложите выбрать её заново.

Context сообщает текущие locale и palette CanvasTTY. Локализация и внутренние стили — ответственность плагина. Плагин не должен выдумывать progress, sessions, status, limits или telemetry.

## Установка и управление

1. Опубликуйте готовый статический пакет в корне публичного GitHub-репозитория.
2. Откройте **Настройки → Плагины**.
3. Вставьте `https://github.com/owner/repository` и нажмите **Проверить**.
4. Прочитайте manifest и permissions, затем подтвердите **Установить**.
5. В том же разделе плагин можно включить, выключить или удалить. Его HOME widgets добавляются и удаляются рядом со встроенными виджетами в разделе **Оформление → Состав HOME**. Если manifest объявляет `settingsContribution`, карточка плагина также показывает отдельное действие **Настройки**.
6. Откройте **Настройки → Оформление → Состав HOME** и нажмите **Редактировать HOME**, чтобы двигать плитки, менять их размер или тянуть правый нижний угол границы HOME. Плитка Settings сохраняется как аварийная точка входа; остальные системные и plugin tiles опциональны.

Установщик намеренно не принимает приватные репозитории, ссылки GitHub вида `/tree/branch/subdirectory` и репозитории, которым нужен build. Публикуйте готовый пакет в корне.

Просмотр и поиск в витрине работают без входа, через публичный поиск GitHub. Вход необязателен и только повышает лимиты поиска GitHub; когда анонимный лимит исчерпан, CanvasTTY показывает, когда можно повторить. Опциональный вход в витрину использует GitHub OAuth Device Flow. Сопровождающий сборку может [зарегистрировать OAuth App и включить Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app), затем сохранить его публичный client ID в repository variable GitHub Actions `CANVASTTY_GITHUB_CLIENT_ID`. Официальная сборка встраивает это значение, когда оно настроено; для локальной сборки подходят `GITHUB_OAUTH_CLIENT_ID` и `CANVASTTY_GITHUB_CLIENT_ID`, а при запуске любая из них может переопределить встроенный ID. Client secret в приложение не встраивается и не требуется. По умолчанию вход открывает GitHub во встроенном Browser CanvasTTY, а системный браузер остаётся явным fallback. Без client ID интерфейс прямо сообщает, что OAuth недоступен, но проверка и установка по прямой ссылке продолжают работать. Отключение удаляет локальную зашифрованную сессию; при необходимости отдельно отзовите доступ в [настройках приложений GitHub](https://github.com/settings/applications).

## Чек-лист автора

- Используйте только structured host data и явные loading/unavailable/error states.
- Запрашивайте минимальный набор permissions.
- Держите scripts во внешних файлах; inline script не выполнится.
- Не рассчитывайте на Node.js, filesystem paths, PTY history, provider tokens или parent DOM.
- Проверяйте HOME widget в минимальном заявленном размере и при zoom канваса.
- Проверяйте canvas app в semantic summary ниже `0.5×`.
- Проверяйте одинаковые SDK-вызовы внутри iframe и отдельного окна.
- При изменении host/example запускайте `npm test`, `npm run typecheck`, `npm run build`.
