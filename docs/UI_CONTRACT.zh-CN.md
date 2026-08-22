# UI 契约

[English](UI_CONTRACT.md) · [Русский](UI_CONTRACT.ru.md) · [简体中文](UI_CONTRACT.zh-CN.md)

本契约用于保持已批准的 MVP 概念，并防止 feature ownership 漂移。

## Home 区域

- HOME 使用固定的 `82 × 72` 逻辑 cell 与 `18px` 间距，因此扩大页面不会让已有 widget 变小。新 profile 从 `16 × 12` 开始；原布局保留在左上角 `12 × 8` 区域，并为插件留下明确空间。持久化边界与 cell grid 只在 Edit HOME 中显示；右下角可将区域调整到 `48 × 36` 的安全上限。
- 左侧宽 tile 只包含用户选择的 Codex、Claude、Kimi、OpenCode Go 与 Grok Build 真实限额行；默认显示全部五个。可见行等分 tile 高度；四行或五行时切换为紧凑密度，确保每个图标、倒计时和 usage rail 都留在默认 tile 内。空选择显示明确的空状态。显示设置不会停止后台读取限额，也不会提供没有真实 adapter 的服务商。每行优先显示服务商最长的真实默认配额窗口（若提供则为 weekly），仅在必要时 fallback 到另一个真实窗口。它显示该窗口 `resetsAt` 的倒计时及对应 usage rail。短于一天使用 `HH:MM`，更长时间使用 `Nд HHч`/`Nd HHh`。窗口长度保留在 accessible metadata 中；不可用数据必须明确标记，不得伪造 reset 或 percentage。短黄色竖线表示最新刷新失败、当前显示的是最后一个有效 snapshot；它不是选择状态或 usage progress。
- 右侧 tile 是唯一的 session list。Viewport 显示三行，真实会话更多时滚动，并且不丢弃任何行。每行显示 provider mark、本地化 semantic state 与 identity。Hover 失败行的 error mark 会打开 accessible panel，显示经过长度限制、去除 terminal-control 序列的最终 PTY 输出（包括提供的 traceback）；Copy action 只复制该显示输出。若 PTY 没有可见输出，面板会如实显示这一点及实际退出码。UI 不会编造原因，也不会从 terminal text 推断 state。这里不显示 session duration 或 limit-style progress rail。
- Clock 是主导的中间 tile，只渲染 `HH:MM`。旁边的 media tile 是自治 widget：点击选择或替换 image/GIF；删除操作留在 widget 内。
- 底部 dock 始终包含 Terminal 与 Browser，以及 Settings 中启用的 agent provider。等宽列数由实际可见按钮计算，因此禁用 agent 不会留下空白单元格。新建和迁移后的 profile 默认启用所有当前 agent；隐藏 launcher 按钮不会停止或删除现有 session。Settings 是独立 tile。Browser 打开或聚焦唯一的内置浏览器卡片，绝不启动外部浏览器。Agent badge 不会覆盖 Browser launcher 图标。
- 除 Settings 外，所有默认 tile 都可隐藏；Settings 保留为恢复入口。Edit HOME 显示完整 cell grid 与精确 HOME 边界，隐藏所有 terminal/canvas-plugin window，并在 Save 前把变化保留为 draft。Tile 移动时不得 overlap，可暂时跨越任意 HOME 边缘；只有全部 tile 完全位于边界内时才可 Save。任意 edge/corner 均可 resize 并保持对边不动；可见提示只放在左上与右下 corner。边界可在不穿过已摆放 widget 的前提下扩大或缩小。空间不足时添加 widget 会自动扩大 HOME。
- Runtime HOME widget 使用同一 tile bounds 与 zoom behavior。其 UI 在 sandbox iframe 中运行，无法访问可信 renderer DOM 或 `window.canvasTTY`。

## 启动与设置

- 点击服务商会打开该服务商的 Focus Card。服务商固定，不提供第二个 provider selector。
- Focus Card 只包含 provider mark、project folder、Normal/YOLO profile、launch action 与上下文危险确认。
- Settings 顶部使用 General、Appearance、Agents、Controls、Browser、Plugins 分区。General 负责语言；Appearance 负责两个互相独立的颜色设置：按角色划分的 HOME palette preset/custom color，以及 Canvas background。修改其中一个不得重绘另一个。Appearance 还负责 Canvas pattern、shortcut hint、system HOME tile 与 HOME editor 入口。自定义 HOME 颜色只接受经过校验的 `#RRGGBB` 值，并且绝不重绘 provider mark；Agents 独立决定 HOME launcher 中显示哪些 provider 按钮，以及 HOME 限额 tile 中显示哪些真实服务商的限额行；一个选择不得改变另一个；Controls 负责 click focus、hover focus、window snapping、edge panning、zoom sensitivity、wheel direction、普通 scroll 的 pan/zoom、widget 上 Off/On/Key wheel/pinch capture、完整 canvas navigation override 与 action shortcut；Browser 负责 agent access、agent indicator visibility、tab restore、download、脱敏 activity 与 browser data 清理；Plugins 负责 install preview、permission review、installed-plugin list、enable/disable/uninstall 与 contribution action。Media control 不出现在这里。
- Click focus 有 Off、Single click、Double click 三种明确模式，默认 Off。即使 camera focus 为 Off，selection 与可见 outline 仍然有效；Double click 模式不会在第一次点击时跳转 camera。
- 当前 Terminal 与内置 Browser 之间的 selection 是排他的：点击空白 canvas 会清除选择。Input focus 独立保存，因此未来加入 multi-selection 时无需重新定义 wheel ownership。
- Hover focus 是独立且默认关闭的 input-focus 模式。经过可配置延迟（慢速 `500ms`、正常 `250ms`、快速 `80ms`），指针下具备 input 的 widget 会获得逻辑 focus，但不会改变 selection；Terminal 与 native Browser 的 keyboard input 会跟随该 focus。指针离开只会取消尚未触发的 focus 转移；已分配的 focus 会一直保留，直到点击或悬停到另一个 focusable widget，或点击所有 widget 之外。可聚焦界面包括 Terminal、native Browser、plugin iframe/canvas，以及真正可滚动的 HOME 列表；装饰性和仅执行 action 的 tile 不会获取 focus。
- Keyboard shortcut 可由用户重映射并在本地持久化。默认 `Home` 聚焦 Home 区域，`F2` 重命名选中的终端窗口。Rename 在 header 内联完成，不会重建 PTY。Canvas 右下角的紧凑被动提示立即反映持久化 binding，并可在 Appearance 中隐藏。
- Snapping 默认开启，关闭时不改变现有 window bounds。Edge panning 默认关闭，速度可选 slow/normal/fast。Terminal scroll 与 canvas navigation 的滚轮方向分别配置；canvas inversion 同时作用于两个 pan 轴和历史 wheel zoom。新配置使用普通 scroll 进行 pan，迁移后的配置保留 wheel zoom、方向与灵敏度。

## 视觉系统

- 大型扁平 pastel tile，清晰的 dark/light contrast，克制阴影；不使用装饰性 micro-control，也不给不言自明的 control 添加说明性 microcopy。
- 当前持久化边界能放入视口时，Home 以 `1:1` 渲染。Auto-fit 使用离散 scale step，最低 `0.2×`，camera coordinate 取整数，使大型 plugin layout 中的 border 与 dock spacing 保持视觉均匀。
- System action 使用仓库内 vendored 的官方 Lucide SVG。不要在 TSX 手绘 system icon，也不要添加 icon runtime package。
- Provider mark 使用未修改的 vendor asset，不重绘、不改色、不加 filter、不近似替代。Kimi raster mark 不得超过其原生 `48px`。
- Dots、grid、diagonal 与 rings 使用克制的 CSS pattern。Waves 使用 `assets/patterns/waves.svg` seamless tile，不以 radial gradient 仿制。
- Terminal card 保持 `54px` header。正常 scale 下，在用户明确重命名前，header 显示 provider mark 与 terminal working directory；custom title 随后替换路径。Close 始终显示在最右侧；canvas card 不提供 maximize/fullscreen。Terminal chrome 不显示 lifecycle dot。
- Provider PTY 退出后，可通过 header action 或 `Ctrl+D` 在同一 session 中重启。Card、title、bounds、scrollback 与 xterm 保持不变，同时创建新的 provider process 与 browser capability。
- Terminal card 在低于 `0.5×` 时切换为 semantic summary。Camera 越远，summary typography 反向缩放，使相同卡片保持一致、可读的层级，而不是显示微小 xterm text。
- Semantic summary 模式中，点击卡片仍会选中并显示 outline，camera focus 只遵循 Off/Single click/Double click。Renderer、xterm 与 plugin 卡片使用和正常 scale 相同的 wheel focus 矩阵：只有 focused 且具备 input 的卡片能在 Off 或 Key 未按下时保留 wheel；On、激活的 Key binding 或完整 navigation override 会把它交给 canvas。Browser summary 与其他 non-native placeholder surface 的 wheel/pinch 始终归 canvas。
- Terminal 任意 edge/corner 都是 resize target。最小 card size 为 `420 × 260`；resize 更新 xterm viewport 并保持对边不动。
- 在任意 canvas zoom 下，实时终端 selection 都跟随可见指针位置。有文字选择时，`Ctrl+C`/`Ctrl+Shift+C` 或 `Cmd+C` 复制；`Ctrl+Shift+V`/`Cmd+V` 与 `Shift+Insert` 从系统剪贴板粘贴。没有选择时，普通 `Ctrl+C` 仍是 PTY interrupt。`Shift+Enter` 向 PTY 发送换行 sequence（`ESC [ 13 ; 2 u`），而不是提交当前行。
- Canvas plugin app 使用同一 movable card grammar、`54px` header、resize/snap behavior，以及 `0.5×` 以下的 semantic summary。`window` contribution 打开 CanvasTTY 管理的独立 sandbox window；不支持嵌入任意原生窗口。
- 内置 Browser 是唯一的可移动、可调整尺寸 core canvas card，而不是 plugin contribution。它使用与其他 canvas card 相同的 `54px` 外层窗口 header，将 identity 与 hide-card action 和下方内部 tab strip 分开。可信 DOM chrome 负责 tab/favicon、address/search、back/forward/reload、download、per-tab provider badge、site dialog 以及明确的 Close tab/Close all。隐藏卡片会保留 tab 与共享的已认证 Chromium profile。低于 `0.5×`、Edit HOME 期间及可信 dialog/popover 后方，native page 会由稳定 semantic surface 替代；卡片或 camera 移动时它保持实时渲染，并跟随按帧合并的 viewport geometry。
- 仅有 authenticated connection 或 heartbeat 不会显示智能体 presence。智能体实际发出 browser command 后才显示品牌 badge，获得真实 pointer position 后才显示 cursor。Claude 使用 `#D97757`，Codex 使用 `#10A37F`，Kimi 使用 `#7C5CFC`，OpenCode 使用 `#5A5858`，Hermes 使用 `#D6A700`，未知 provider 使用 `#7A8291`。Browser Settings 可单独控制 indicator visibility 而不撤销访问；智能体访问 kill switch 会撤销连接本身。
- Window snapping 开启时，drag/resize 使用隐藏 `10px` grid、相邻 edge/center 的 `10px` magnetic threshold，以及一致的 `20px` gap。
- 在空白 canvas 上 drag 始终执行 pan。新配置中，空白 canvas 上的普通 scroll 会沿两个轴移动，pinch 与 `Cmd/Ctrl + scroll` 会以指针为中心缩放。**Use scroll wheel to zoom** 恢复历史 wheel zoom，并在迁移现有配置时自动启用。只有 focused input widget 会中断 canvas wheel/pinch；在 unfocused 或不可聚焦 widget 上，事件仍归 canvas。**Wheel/pinch capture over widgets** 有 Off、On、Key 三种模式：Off 保留 focused-widget ownership，On 始终只交给 canvas，Key 仅在按住绑定键时交给 canvas。因此，focused live Browser page 在 Off 或 Key 未按下时会由普通 scroll 原生滚动；unfocused Browser、On、激活的 Key binding、完整 override、pinch 与 `Cmd/Ctrl + scroll` 都归 canvas。Browser wheel sequence 开始时选定的 owner 会保持到 250 ms 没有 wheel event。Browser summary 与 placeholder 始终归 canvas。新配置默认使用 Key，在 macOS 为 `Command`，其他平台为 `Ctrl`。独立的 **Canvas navigation override**（macOS 默认 `Option`，其他平台默认 `Alt`）接管 wheel/pinch 与 drag，也允许单独 Command/Ctrl。按住完整 override 时所有 canvas surface 显示 `grab`；已开始的 pan 会显示 `grabbing`，并由 canvas 持有到 pointer up/cancel。
- 指针停在空白 canvas 的 viewport edge `56px` 范围内时，canvas 以 RTS 风格 edge-pan；速度线性增加，到边缘达到 `900px/s`。Edge panning 默认关闭，在 Settings 启用。指针位于 interactive surface 或正在 drag-pan 时暂停。
- Dialog close action 留在自己的 header/control row 内，使用一致 inset，不覆盖 field、outline 或 panel boundary。

## 验收检查

- React TSX 中没有自定义 `<svg>` 或 `<path>`。
- Settings 中没有 media picker 或 media-fit selector。
- `AgentLaunchDialog` 中没有 provider picker。
- Canvas card 中没有 maximize/fullscreen action。
- 没有虚假的 count、percentage、reset timer、determinate progress 或 placeholder session。
- Plugin install 在确认前总会显示已校验 manifest 与 requested permission；绝不执行 repository script。
- 新打开 PTY 从 `idle` 开始。只有结构化服务商 lifecycle signal 能设置 `working` 或 `needs_approval`；PTY 是否存在和终端文字都不是 activity signal。
- 只有结构化 provider-adapter signal 才能显示 `needs_approval`；绝不解析 terminal output 来伪造状态。
- Build 后已在隔离的真实 Electron 窗口检查 Home、Focus Card、Settings、至少一个实时终端与内置 Browser。
