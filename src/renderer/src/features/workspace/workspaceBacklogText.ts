import type { LocaleId } from "../../../../shared/contracts";

export type BacklogTextKey =
  | "inspector" | "inspectorTabs" | "tabTimeline" | "tabUsage" | "tabReport" | "tabCheckpoints"
  | "restoreConfirm" | "restoreFailed" | "noTimeline" | "loadMore" | "inputTokens" | "outputTokens"
  | "cost" | "usageSource" | "usageUnknown" | "exportReport" | "noReport" | "checkpoint" | "noCheckpoints"
  | "preview" | "restoreCheckpoint" | "back" | "taskSummary" | "working" | "waiting" | "done" | "failed"
  | "elapsed" | "gatherTask" | "workspaceTools" | "layout" | "layoutTree" | "layoutStatus" | "layoutProject"
  | "layoutGrid" | "undoLayout" | "broadcast" | "broadcastEnable" | "broadcastTargetCount" | "snapshot"
  | "exportSnapshot" | "importSnapshot" | "snapshotExported" | "confirmImport" | "importPreview" | "confirmBypass"
  | "importComplete" | "importSessionsComplete" | "presets" | "presetName" | "savePreset" | "presetSaved" | "openPreset"
  | "noPresets"
  | "contextPreview" | "contextPreviewDescription" | "contextFiles" | "contextOutsideWarning" | "contextAllowOutside"
  | "contextTooLong" | "contextTruncated" | "contextEditablePreview" | "contextConfirmSend" | "searchOutput" | "outputLine"
  | "broadcastPlaceholder" | "broadcastSend" | "broadcastFailed" | "contextFailed"
  | "historicalOutput" | "historicalOutputContext" | "historicalOutputLoading" | "outputHistoryPruned"
  | "tabTasks" | "tabBudget" | "taskBoard" | "taskTitle" | "taskDescription" | "taskDependencies" | "taskOwner"
  | "unassigned" | "addTask" | "noTasks" | "closeTask" | "taskOpen" | "taskClaimed" | "taskDone" | "taskClosed"
  | "budgetLimits" | "budgetTokens" | "budgetCost" | "budgetMinutes" | "budgetUsage" | "budgetRemaining" | "budgetDataNone" | "budgetDataPartial" | "budgetCostPartialPause"
  | "budgetPaused" | "budgetWarning" | "budgetSet" | "budgetRaise" | "budgetClear" | "budgetNoLimits" | "budgetReason"
  | "taskStateWaitingResponse" | "taskStateWorking" | "taskStateWaiting" | "taskStateDone" | "taskStateFailed" | "delete"
  | "tabNotifications" | "tabSecrets" | "notificationChannels" | "notificationDesktop" | "notificationGlasses"
  | "notificationDnd" | "notificationDndOff" | "notificationDndHour" | "notificationDndUntilClear" | "notificationImportantOnly" | "notificationThisCard"
  | "saveTaskFlow" | "flowName" | "flowSaved" | "conversationTokens" | "reviewRequested"
  | "timelineText" | "timelineType" | "timelineAgent" | "timelineSearch" | "timelineAll" | "sendGroupPrompt";

const text: Record<BacklogTextKey, readonly [string, string]> = {
  inspector: ["События сессии", "Session activity"],
  timelineText: ["Поиск по событиям", "Search events"], timelineType: ["Тип события", "Event type"],
  timelineAgent: ["Карточка", "Card"], timelineSearch: ["Искать", "Search"], timelineAll: ["Все", "All"],
  sendGroupPrompt: ["Отправить запрос группе", "Prompt selected group"],
  inspectorTabs: ["Разделы событий сессии", "Session activity sections"],
  tabTimeline: ["Хронология", "Timeline"], tabUsage: ["Расход", "Usage"], tabReport: ["Отчёт", "Report"], tabCheckpoints: ["Контрольные точки", "Checkpoints"],
  restoreConfirm: ["Восстановить эту контрольную точку? Текущие изменения могут быть потеряны.", "Restore this checkpoint? Current changes may be lost."],
  restoreFailed: ["Не удалось восстановить контрольную точку.", "Could not restore the checkpoint."],
  noTimeline: ["Событий пока нет.", "No timeline events yet."], loadMore: ["Загрузить ещё", "Load more"],
  inputTokens: ["Входные токены", "Input tokens"], outputTokens: ["Выходные токены", "Output tokens"],
  cost: ["Стоимость", "Cost"], usageSource: ["Источник", "Source"], usageUnknown: ["Нет данных о расходе.", "Usage data is unavailable."],
  conversationTokens: ["Всего токенов беседы", "Conversation total tokens"],
  exportReport: ["Скачать Markdown", "Download Markdown"], noReport: ["Отчёт пока пуст.", "No report available yet."],
  checkpoint: ["Контрольная точка", "Checkpoint"], noCheckpoints: ["Контрольных точек нет.", "No checkpoints available."],
  preview: ["Предпросмотр", "Preview"], restoreCheckpoint: ["Восстановить точку", "Restore checkpoint"], back: ["Назад к списку", "Back to list"],
  taskSummary: ["Сводка задачи", "Task summary"], working: ["работают", "working"], waiting: ["ждут", "waiting"], done: ["готовы", "done"], failed: ["ошибки", "failed"],
  elapsed: ["Прошло с начала задачи", "Elapsed since task start"], gatherTask: ["Собрать задачу", "Gather task"],
  workspaceTools: ["Инструменты холста", "Workspace tools"], layout: ["Автораскладка карточек", "Arrange cards"],
  layoutTree: ["По задачам", "By task"], layoutStatus: ["По статусу", "By status"], layoutProject: ["По проекту", "By project"], layoutGrid: ["Сетка", "Grid"], undoLayout: ["Отменить раскладку", "Undo layout"],
  broadcast: ["Общий ввод", "Broadcast input"], broadcastEnable: ["Включить общий ввод", "Enable broadcast input"], broadcastTargetCount: ["Получатели: {count}", "Recipients: {count}"],
  snapshot: ["Снимок рабочего пространства", "Workspace snapshot"], exportSnapshot: ["Экспортировать снимок", "Export snapshot"], importSnapshot: ["Импортировать снимок", "Import snapshot"],
  snapshotExported: ["Снимок скачан.", "Snapshot downloaded."], confirmImport: ["Восстановить снимок", "Restore snapshot"], importPreview: ["Будут восстановлены карточки: {count}", "Cards to restore: {count}"],
  importSessionsComplete: ["Импорт карточек и задач завершён. Настройки холста ещё не сохранены.", "Card and task import completed. Canvas settings have not been saved yet."],
  confirmBypass: ["Я подтверждаю запуск профилей Bypass.", "I confirm launching Bypass profiles."], importComplete: ["Импорт завершён.", "Import completed."],
  presets: ["Пресеты", "Presets"], presetName: ["Название пресета", "Preset name"], savePreset: ["Сохранить текущий холст", "Save current canvas"],
  presetSaved: ["Пресет сохранён.", "Preset saved."], openPreset: ["Открыть", "Open"], noPresets: ["Сохранённых пресетов нет.", "No saved presets."],
  contextPreview: ["Предпросмотр передачи контекста", "Preview context handoff"], contextPreviewDescription: ["Проверьте и отредактируйте текст до передачи агенту.", "Review and edit the text before sending it to the agent."],
  contextFiles: ["Пути файлов", "File paths"], contextOutsideWarning: ["Файлы вне папки проекта", "Files outside the project folder"], contextAllowOutside: ["Разрешить передачу этих файлов", "Allow these files to be sent"],
  contextTruncated: ["Большой текст сокращён. Проверьте отметку в предпросмотре.", "Large text was truncated. Check the marker in the preview."],
  contextEditablePreview: ["Текст, который получит агент", "Text the agent will receive"], contextConfirmSend: ["Подтвердить и вставить", "Confirm and paste"],
  searchOutput: ["Вывод терминалов", "Terminal output"], outputLine: ["строка", "line"],
  broadcastPlaceholder: ["Команда для выбранных карточек…", "Prompt for selected cards…"],
  broadcastFailed: ["Не удалось отправить сообщение всем выбранным карточкам.", "Could not deliver the message to every selected card."],
  broadcastSend: ["Отправить всем", "Send to all"], contextFailed: ["Не удалось подготовить предпросмотр. Ничего не отправлено.", "Could not prepare the preview. Nothing was sent."],
  contextTooLong: ["Сократите текст до {limit} символов перед отправкой.", "Shorten the text to {limit} characters before sending."],
  historicalOutput: ["Исторический вывод терминала", "Historical terminal output"],
  historicalOutputContext: ["Показан маскированный контекст найденной строки.", "This masked excerpt shows the matched historical line."],
  historicalOutputLoading: ["Загружаем найденную строку…", "Loading the matched line…"],
  outputHistoryPruned: ["Часть раннего вывода недоступна в этой истории.", "Some earlier output is unavailable in this history."],
  taskStateWaitingResponse: ["Ожидает ответа", "Waiting for response"], taskStateWorking: ["В работе", "Working"],
  taskStateWaiting: ["Ожидает подтверждения", "Waiting for approval"], taskStateDone: ["Готово", "Done"], taskStateFailed: ["Ошибка", "Failed"],
  tabTasks: ["Задачи", "Tasks"], tabBudget: ["Бюджет", "Budget"], taskBoard: ["Общая доска задачи", "Shared task board"],
  taskTitle: ["Название задачи", "Task title"], taskDescription: ["Описание", "Description"], taskDependencies: ["Зависимости — ID через запятую", "Dependencies — comma-separated IDs"],
  taskOwner: ["Исполнитель", "Owner"], unassigned: ["Не назначен", "Unassigned"], addTask: ["Добавить задачу", "Add task"], noTasks: ["В этой задаче нет подзадач.", "No subtasks in this task."],
  closeTask: ["Закрыть", "Close"], taskOpen: ["Открыта", "Open"], taskClaimed: ["В работе", "Claimed"], taskDone: ["Готова", "Done"], taskClosed: ["Закрыта", "Closed"],
  budgetLimits: ["Лимиты задачи и всего дерева", "Task and tree limits"], budgetTokens: ["Токены", "Tokens"], budgetCost: ["Стоимость, USD", "Cost, USD"], budgetMinutes: ["Время, минуты", "Time, minutes"],
  budgetUsage: ["Использовано", "Used"], budgetRemaining: ["Остаток", "Remaining"], budgetDataNone: ["Нет данных от CLI", "CLI did not provide this data"],
  budgetDataPartial: ["Неизвестно: часть затрат", "Unknown: some costs are unavailable"],
  budgetCostPartialPause: ["Бюджет стоимости приостановил задачу: затраты известны не по всем участникам.", "The cost budget paused this task because cost is unknown for some members."],
  budgetPaused: ["Лимит достигнут: подагенты приостановлены.", "Limit reached: subagents are paused."], budgetWarning: ["Достигнут порог предупреждения.", "The warning threshold has been reached."],
  budgetSet: ["Сохранить лимиты", "Save limits"], budgetRaise: ["Поднять лимиты на 25%", "Raise limits by 25%"], budgetClear: ["Снять бюджет", "Clear budget"],
  budgetNoLimits: ["Лимиты не заданы.", "No limits set."], budgetReason: ["Причина паузы", "Pause reason"], delete: ["Удалить", "Delete"],
  tabNotifications: ["Уведомления", "Notifications"], tabSecrets: ["Защита и ключи", "Safety & secrets"], notificationChannels: ["Каналы", "Channels"],
  notificationDesktop: ["Рабочий стол", "Desktop"], notificationGlasses: ["Очки", "Glasses"],
  notificationDnd: ["Не беспокоить", "Do not disturb"], notificationDndOff: ["Выключено", "Off"],
  notificationDndHour: ["На 1 час", "For 1 hour"], notificationDndUntilClear: ["Пока не выключу", "Until cleared"],
  notificationImportantOnly: ["Только важные события", "Important events only"], notificationThisCard: ["Только эта карточка", "This card only"],
  saveTaskFlow: ["Сохранить подзадачи как workflow…", "Save subtasks as workflow…"], flowName: ["Название workflow", "Workflow name"],
  flowSaved: ["Файл workflow сохранён", "Workflow file saved"],
  reviewRequested: ["Требуется проверка", "Review requested"]
};

export function backlogText(locale: LocaleId, key: BacklogTextKey): string {
  return text[key][locale === "ru" ? 0 : 1];
}
