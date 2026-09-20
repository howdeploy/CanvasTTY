# Встроенный браузер и журнал аудита

[English](browser.md) · [Русский](browser.ru.md) · [简体中文](browser.zh-CN.md) · [Документация](README.ru.md)

В CanvasTTY `1.0.2` встроенный браузер доступен из HOME как доверенное canvas-приложение. Он использует sandboxed Electron `WebContentsView`, вкладки и единый постоянный Chromium-профиль; это не capability runtime-плагинов.

## Как открыть и использовать браузер

1. Откройте **Browser** на HOME. CanvasTTY создаст или восстановит карточку браузера на канвасе.
2. Используйте доверенную панель вкладок и адресную строку для HTTP(S)-навигации или поиска. Back, forward, reload, новая вкладка, закрытие вкладки и **Закрыть все** остаются за пределами удалённой страницы.
3. Перемещайте и меняйте размер карточки как у терминала. Ниже semantic scale native page заменяется стабильной summary; в live scale страница продолжает рендериться во время движения камеры или карточки.
4. Нажатие на live page выбирает браузер и возвращает keyboard focus. Настроенный single/double click управляет только фокусировкой камеры. **Настройки → Управление → Автофокус при наведении** использует одну задержку для терминалов и браузера. Клик по пустому канвасу снимает выбор приложения.
5. Панель загрузок показывает недавний прогресс. JavaScript alert/confirm/prompt приостанавливаются, пока пользователь не ответит через доверенный dialog CanvasTTY.

Скрытие карточки не закрывает вкладки. **Закрыть все** удаляет их после подтверждения. **Настройки → Браузер → Восстанавливать вкладки** определяет, вернутся ли безопасные URL после перезапуска.

## Настройки браузера

| Настройка | Поведение |
|:--|:--|
| **Доступ агентов** | Разрешает сессиям Claude Code, Codex, Kimi, OpenCode и Hermes, запущенным через CanvasTTY, использовать типизированные browser tools; по умолчанию включено |
| **Индикаторы агентов** | Показывает badges после реальной browser-команды агента и cursor только после появления настоящей pointer position; по умолчанию включено |
| **Восстанавливать вкладки** | Сохраняет порядок вкладок, активную вкладку и безопасные restore URL; по умолчанию включено |
| **Загрузки** | Показывает до шести последних загрузок, локальный прогресс и статус |
| **Действия браузера** | Показывает десять последних результатов human/agent-команд из памяти; runtime-буфер ограничен 1000 событиями и очищается при перезапуске приложения |
| **Очистить данные браузера** | Закрывает вкладки и удаляет restore state, site storage, cache, HTTP auth cache, staged uploads и текущий список загрузок |

Очистка browser data **не удаляет** постоянный журнал аудита, описанный ниже.

## Доступ агентов

Только agent-сессии, запущенные CanvasTTY, получают отдельное browser-подключение на время запуска. Main process передаёт одноразовую bootstrap capability через child environment встроенному stdio MCP helper. Claude и Codex получают per-run CLI arguments, OpenCode — временную MCP-запись через `OPENCODE_CONFIG_CONTENT`, Kimi — per-run файл или восстанавливаемую временную конфигурацию, а Hermes — восстанавливаемую временную запись `mcp_servers.canvastty_browser`, чьи capability-поля ссылаются на окружение дочернего процесса. После успешной аутентификации capability заменяется session-scoped reconnect capability, которая хранится только в памяти helper; повторная bootstrap-аутентификация разрешена лишь пока тот же запуск уже подключён, а завершение PTY отзывает весь доступ. В Linux/macOS используется Unix socket текущего пользователя; в Windows — встроенный native named-pipe host с DACL только для точного SID текущего пользователя. Само подключение и heartbeat не помечают агента активным в браузере: presence начинается с его первой browser-команды.

Набор tools покрывает вкладки, навигацию, observe/read, screenshot, click/hover/type/select/press, scroll/drag, ожидания, dialogs, downloads и activity вызывающего агента. Он не открывает cookies, сохранённые пароли, authorization headers, local/session storage, произвольный JavaScript, filesystem/shell, raw CDP, TCP listener или remote-debugging port.

Agent mutations выполняются FIFO внутри вкладки, дедуплицируются по request ID, проверяют document revision до side effect, ограничены rate limit и timeout и блокируются, если обязательную запись audit attempt нельзя сохранить. Reads могут выполняться параллельно; у разных вкладок независимые mutation lanes.

## Границы сайтов и файлов

- Удалённые страницы работают в sandbox с context isolation, без Node.js и preload CanvasTTY.
- Top-level navigation принимает только канонические HTTP(S) URL. HTTP(S)-popup становится внутренней вкладкой; privileged/external schemes отклоняются.
- Hardware, geolocation, notifications, clipboard read, insecure certificate bypass, webviews, client certificates и HTTP-auth prompts запрещены.
- Загрузки попадают в управляемый CanvasTTY каталог внутри пользовательской папки Downloads. Upload проходит проверку пути, количества и суммарного размера; файл копируется через no-follow descriptor в private staging до передачи Chromium.
- Посещаемый сайт по-прежнему может сам отправлять введённые ему данные в сеть. Локальная граница CanvasTTY не является обещанием приватности со стороны сайта.

## Лента действий и постоянный журнал

Лента в Settings — короткоживущий оперативный список. Отдельно main process дописывает JSONL-аудит в:

```text
<Electron userData>/browser/audit/browser-audit.jsonl
```

Активный файл создаётся с режимом `0600`. Записи содержат идентификаторы actor/provider/session, operation, phase attempt/result, tab ID, origin без query/fragment, document revisions, duration, outcome/error code и hash-связи цепочки. Из журнала вырезаются typed values, page text, screenshots/base64, credentials, authorization/cookie fields, passwords, secrets, tokens и API keys.

Активный файл ротируется при 100 МБ. Ротированные файлы остаются частью hash chain; файлы старше 30 дней удаляются при инициализации или ротации store. При открытии store проверяет существующую цепочку; после нарушения integrity новые записи не принимаются. Если pre-action запись agent mutation сохранить нельзя, агент получает `AUDIT_UNAVAILABLE`, а side effect не выполняется.

Удалённого сборщика логов и telemetry endpoint CanvasTTY нет. Кнопка **Очистить данные браузера** сохраняет audit evidence. Для ручного удаления полностью закройте CanvasTTY и удалите целиком каталог `userData/browser/audit`, понимая, что локальная история аудита будет потеряна безвозвратно.

Зоны ответственности реализации описаны в [архитектуре](ARCHITECTURE.ru.md), правила канваса и взаимодействия — в [UI-контракте](UI_CONTRACT.ru.md), пути остальных локальных данных — в [руководстве по установке](installing-and-security.ru.md).
