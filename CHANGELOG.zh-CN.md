# 更新日志

[English](CHANGELOG.md) · [Русский](CHANGELOG.ru.md) · [简体中文](CHANGELOG.zh-CN.md)

## 1.5.1

- 修复 HOME 的 Terminal 按钮将鼠标事件误当作画布坐标传入、导致 “Session position is invalid” 的问题。
- 支持将本地文件拖入终端卡片。路径按系统默认 shell 规则引用并粘贴，不会自动提交命令；保留空格和 Unicode 文件名。
- 修复终端历史回放与实时输出重叠、画布缩放时的滚动条坐标，以及调整窗口大小时的滚动位置与输出跟随行为。
- 引入 PR #29 的可配置环形快捷菜单。默认关闭，可在 Settings → Agents → Quick launcher 中开启；关闭时保留已选操作。
- 便签新增用于删除的关闭按钮（PR #30）。
- 智能体启动对话框支持粘贴项目路径，并修复 GNOME 剪贴板元数据处理（PR #27、#31）。终端链接可选择使用内置浏览器或系统浏览器打开（PR #28）。
- 恢复 Claude Code 用量追踪，并修复凭据存储选择（PR #25）。

## 1.5.0

- 将相互竞争的画布右键处理器替换为统一的上下文分发器。空白画布、彩色区域和便签分别显示对应操作；可配置的安全智能体/终端启动器也与可搜索的 `Cmd/Ctrl+K` 命令面板共用同一套配置。
- 便签成为一等持久化画布窗口，支持编辑、拖动、八向缩放、吸附、删除、确定性的区域归属以及小地图标记。实现改编自 @TroopJostle 在 PR #23 中提出的便签与快速启动器思路，并保留作者署名。
- 完成彩色区域移动：完全位于区域内的终端、Browser/plugin 窗口和便签会在拖动期间同步移动，并仅在释放时持久化一次。区域 targeting、磁性吸附和边界规则不再错误捕获部分重叠窗口，也不会在手势结束后瞬移。
- 所有画布窗口新增普通点击置顶。原生 Browser 表面现在遵循 renderer 管理的层级；靠近应用右边缘打开启动对话框时，会在首帧前完成边界限制，不再先出现在窗口外再跳回。
- Settings 与全部画布菜单采用新设计：共享应用 token、官方 Lucide/provider 资源，以及统一的 `0.85–1.25` UI chrome 缩放。切换 palette 会自动重绘菜单，但不会改变画布 zoom 或终端字号。
- General 中新增独立的彩色区域与便签退出后保存设置。关闭其中一项不会删除当前运行中的对象，只会从下一次启动的持久化 snapshot 中省略对应集合。
- 小地图交互拆分为明确的 Click 与 Drag 模式。Drag 与空白画布 grab 的方向一致且不会在起始时跳转 camera；Drag 模式下静止按下不会触发 click navigation。

## 1.3.0

- 新增可选的终端窗口恢复。CanvasTTY 仅保存窗口 identity、provider/profile、标题、项目目录、位置与尺寸；智能体通过各自原生的 project-scoped continue mode 继续会话，PTY scrollback 与 capability 不会持久化。
- 新增空白画布右键创建的命名粉彩区域，以及以当前 camera 为中心的 RTS 小地图。HOME 与固定尺寸窗口 marker 在统一投影中移动，不再 auto-fit 或拉伸；只有 HOME 完全离开小地图后才显示边缘指示。
- 画布导航绑定现支持 Mouse3/Mouse4/Mouse5，中键拖动继续作为直接 pan fallback。修复 wheel ownership：会话列表与已聚焦输入面默认本地滚动，只有明确的画布捕获才会接管。
- 修复 Grok Build 首次 TUI 被裁剪：launch、restart 与 restore 都等待 renderer 测得的真实 xterm 网格。终端 resize 与 palette 变化会保留当前 scrollback 位置。
- Appearance 新增整行智能体状态配色：空闲/不可用/完成为灰色，工作中为鼠尾草绿色，等待输入为黄色，并提供单色模式。
- Claude 限额现使用当前运行用户的 OAuth credentials 并在存在 token 时实际请求 provider。缺失本地 credentials 会显示需要登录，不再误报为需要订阅。
- 被拒绝的第二次启动或后台 plugin/browser 活动不再 restore、show 或 focus CanvasTTY 窗口，避免应用擅自切换虚拟桌面。
- Agents 新增简洁的 status hook 开关，About 提供可展开 FAQ；可选 plugin agent hook 必须逐项显式信任。install/update 后 hook 保持关闭，并在移除 CanvasTTY 内部 capability 的隔离进程中运行。

## 1.2.8

- Qwen Code 现已成为 HOME、Settings、CLI 发现、Normal/YOLO 配置、plugin SDK 与受限内置浏览器 MCP 桥接中的一等 launcher；使用官方 Qwen mark，所有配置仅作用于本次启动。
- HOME 限额显示及其设置新增 Qwen 行。由于 Qwen Code 可连接不同云端或本地 model provider，且没有通用 quota-read protocol，CanvasTTY 会显示明确的不可用原因，不会伪造 usage data。
- 智能体会话不再统一显示为已打开，而是使用受保护的本地 lifecycle gateway。Codex、Claude Code、Qwen Code、Kimi Code、OpenCode、Hermes 与 Grok Build 通过 provider hook 报告空闲、工作中和等待输入，且不转发 prompt/response 内容；Claude/Qwen terminal-title marker 保留为兼容 fallback。
- 修复延迟 bootstrap snapshot 将已确认的智能体 lifecycle 重新覆盖为“状态不可用”的竞态。会话元数据现在携带由 main 进程维护的单调 revision，renderer 会拒绝陈旧状态，同时保留初始终端输出。
- 调整卡片或应用窗口大小时会保留当前 terminal scrollback 位置，不再跳到会话开头。
- 分段设置的键盘焦点现在保持在所选按钮内部，并恢复 wheel/pinch 捕获选择器与条件按键编辑器之间的正确间距。

## 1.2.7

- 新增受权限控制的 Hermes Desktop HUD 插件桥接。主机仅通过 `hermes:hud` 提供状态查询、HUD 模式启动和关闭操作；插件无法选择可执行文件、参数或 PID。

## 1.2.6

- Provider CLI 可执行文件现在会在启动时统一解析一次，随后由终端、用量限额和 agent-browser 流程复用同一个绝对路径 launcher；缺失或不可执行的命令会返回结构化诊断。
- 失败的 HOME 会话现在可在鼠标悬停或键盘聚焦时显示完整且已清理的诊断信息，支持一键复制，并用退出代码说明无输出的异常结束。顶层详情浮层不会破坏三行滚动视口，同时保留失败会话的红色 danger rail。
- 打包后的 macOS 应用现在即使从 Finder 启动且仅有最小 `PATH`，也能发现 Homebrew CLI 和位于 `~/.opencode/bin` 的官方用户级 OpenCode 安装。
- CI 现在会在每个 pull request 和 `main` 更新中打包 macOS 应用并执行真实的最小 `PATH` CLI 解析测试，而不再只在发布阶段运行该 smoke。

## 1.2.5

- OpenCode、Hermes 与 Grok Build 现已成为 Linux、macOS 和 Windows 上的一等 launcher：包含官方 provider mark、仅作用于本次启动的原生 YOLO 行为、Windows CLI 发现、plugin SDK 覆盖，以及在服务商支持时提供的受限内置浏览器 MCP 集成。
- Settings 新增独立的 **智能体** 分区：launcher 可见性与 HOME 限额行可见性分别持久化；隐藏 launcher 不影响现有会话，HOME dock 会自动重新分配可见按钮的宽度。
- 在 Codex、Claude、Kimi 的真实限额之外，新增有真实来源的 OpenCode Go 与 Grok Build usage adapter。五行 HOME 限额 tile 会按实际高度切换到紧凑密度，确保每个倒计时与 usage rail 都位于默认边界内。
- Appearance 新增相互独立的 HOME accent preset/自定义颜色与 Canvas 背景颜色，并加入对角线和圆环图案。Canvas 颜色不再重绘 HOME widget，Settings 顶部条也会与滚动内容保持清晰分层。
- 修复原生 Browser viewport 裁剪：嵌入页面始终留在可用 workspace 内，不会覆盖应用 chrome；同时加入可见的 DEV/release build 标识并规范 provider mark 的显示。

## 1.2.4

- macOS bundle 现在会为免费分发路径显式进行 ad-hoc 签名，并关闭 hardened runtime 与 notarization；发布 workflow 会在上传产物前执行严格的 `codesign` 验证。
- 安装说明现已明确：ad-hoc 签名只能验证 bundle 完整性，并不提供 Developer ID 或 notarization。macOS 用户应使用 `1.2.4` 或更高版本替换修复前的 `1.2.2` 和 `1.2.3` 产物。

## 1.2.3

- 新增基于 GitHub 的插件展示页，支持完整分页、元数据优先 manifest、平台与主机版本提示、更新发现及 OAuth Device Flow 登录。
- 加固插件安装与更新：强制平台检查、原子回滚、严格 manifest 校验、受限的元数据批处理、可信归档重定向，以及受保护的 OAuth 持久化与 IPC。
- 插件 SDK 新增受权限控制的 `browser.open`，仅接受规范化 HTTP(S) 地址，并通过单一可等待 broker 创建或复用一个内嵌 Browser 卡片，持久化成功后才返回成功。

## 1.2.2

- 重绘画布导航:双轴滚动默认平移画布,捏合与 `Cmd/Ctrl+滚轮` 以焦点为中心缩放;旧的滚轮缩放配置仍可在设置中使用,并保留其方向与灵敏度。
- 引入逻辑控件输入所有权:控件在显式点击或可配置的悬停延迟后接管滚轮,直到点击空白处才释放焦点,捕获模式为 `Off / On / Key`;单独的按住绑定可临时接管完整画布导航(含拖拽)。
- 在原生 Browser 表面间保持手势连续:「页面/画布」所有权在滚轮静止 250 毫秒内锁定,捏合与 `Cmd/Ctrl+滚轮` 始终缩放画布,关闭捕获时聚焦的 Browser 页面继续原生滚动。

## 1.2.1

- 插件 canvas 应用现在以原生 `1.0` 比例打开和重新聚焦，避免小数缩放造成的模糊；透明 iframe 背景也消除了圆角插件窗口周围的亮色接缝。
- Terminal 与 Browser 的语义摘要现在会在反向缩放前预留宽度并保持内容居中，因此在画布大幅缩小时，图标和文本不再被裁切。

## 1.2.0

- macOS 新增原生窗口 chrome：隐藏式 title bar 配 traffic-light 按钮、紧凑 brand bar，并正确处理原生 fullscreen；Linux 和 Windows 保持现有自定义边框。
- 通过 Electron safeStorage 提供操作系统级加密的插件 secrets（无系统 keyring 时 fail-closed）：逐次调用权限检查、配额、变更事件，以及卸载时的清理。
- 插件现在可以提供在 sandboxed frame 中打开的设置入口、声明 canvas 最小尺寸，并在当前 canvas 旁打开同一插件的另一个 canvas。
- 插件 HOME 小组件在 Appearance → HOME composition 中与内置小组件并列显示，可像内置组件一样添加或移除——这弥补了 1.1.0 的已知不足；Settings → Plugins 仅保留安装/卸载。
- 新增插件可选模块：安装时勾选、逐文件 SHA-256 与字节数校验、带 rollback 的原子重配置，模块派生权限统一应用于 SDK 授权与插件资源 CSP。
- 插件 storage 变更事件现在由主进程广播：同一插件的 canvas、HOME 小组件和独立窗口可以互相看到对方的写入。
- 加固插件下载：重定向仅限 `api.github.com` 与 `raw.githubusercontent.com`，模块下载复用 1.1.0 的 retry/backoff。
- 文档补充了可选模块的信任模型：文件完整性锚定在经 TLS 从 GitHub 获取的插件 manifest 上，manifest 本身没有独立签名。

已知不足：已安装的插件暂时无法就地更新——请先卸载再重新安装以获取新版本。更新操作已在计划中。

## 1.1.0

- 浏览器原生页面通过 Chromium zoom factor 跟随画布缩放（限制在 0.5–3），任意画布缩放级别下浏览器内容都与画布比例一致。
- 浏览器 viewport bounds 改为同步上报，画布平移、拖拽和调整大小期间 native view 保持可见；这修复了 1.0.2 中主窗口未最大化时 native browser view 可能覆盖整个窗口、导致画布控件不可用的问题。
- 在画布上 pointer-down 时聚焦浏览器标签页的 web contents，无需额外点击即可输入。
- 设置中新增浏览器智能体 presence 指示器开关（默认开启）：badge/cursor 不再在认证时出现，光标显示为无名称的圆点，且仅显示真正使用过浏览器的智能体。
- GitHub 插件下载在临时失败（超时、连接错误、HTTP 408/429/5xx、流中断）时最多重试三次并带 backoff。
- 新增终端会话重启：已退出卡片上的重启按钮和 `Ctrl+D` 快捷键；PageUp/PageDown 现在在普通缓冲区中翻页 scrollback，终端光标改为块状。
- 应用上方的滚轮缩放现在默认开启。
- 文档已同步英语、俄语和简体中文。

已知不足：HOME 布局对外部插件的自定义尚未完成——插件磁贴暂时无法在 HOME 布局编辑器中放置和移动。该工作已向社区开放，欢迎贡献。

## 1.0.2

- 内置浏览器现已从 HOME 提供，作为可移动、可调整大小的画布应用，包含可信标签/导航、下载、网站 dialog、安全标签恢复、浏览器数据清理、语义摘要，以及画布/卡片移动时稳定的 native-view geometry。
- 为 CanvasTTY 启动的 Claude Code、Codex 与 Kimi 会话新增 scoped 浏览器自动化，通过内置 stdio MCP helper 和经过认证的当前用户 Unix socket 或受保护 Windows named pipe 接入；不会暴露 TCP listener、remote-debugging port、任意 JavaScript、cookie/storage API 或 raw CDP。
- 新增已连接智能体 badge/cursor、按智能体隔离的活动、绑定 document revision 的 element ref、每标签页 FIFO mutation、request 去重、有上限的 concurrency/rate limit/timeout、dialog/download 处理，以及在无法可靠遮挡敏感区域时 fail closed 的脱敏截图。
- 新增 Electron `userData/browser/audit` 下的持久化脱敏浏览器 hash-chain 审计：100 MB 轮转、轮转文件保留 30 天、integrity check，以及必需的 pre-action audit 无法写入时 fail-closed 的智能体 mutation。
- 浏览器卡片现与终端共享画布选中、click/hover focus、点击空白画布取消选中、window action、应用上方滚轮缩放，以及 native view 重定位时的稳定 renderer surface。
- Windows 智能体传输新增内置 native named-pipe host，仅允许当前用户准确 SID；release pipeline 新增真实 Electron/provider smoke 覆盖。
- 修复 linked Git worktree 的仓库 secret audit：在判断 entry 类型之前忽略 repository metadata 名称，同时继续检测可发布文件中的个人路径。
- 英语、俄语和简体中文的浏览器、安全、本地数据、审计日志与发布文档已同步。

已知问题：如果 CanvasTTY 主窗口启动时没有 maximized，打开 Browser 可能会让 native browser view 覆盖整个窗口，导致画布控件无法使用。本 prerelease 请先 maximized 启动 CanvasTTY，再打开 Browser；修复计划在下一个 patch 中提供。

## 1.0.1

- 新增终端 `Shift+Enter` 换行，不提交当前 prompt。
- 修复终端选择与键盘焦点：选中实时卡片后，输入立即进入 xterm；点击空白画布会清除选择和高亮边框。
- 新增可选的悬停聚焦，进入和离开均可选择慢速（`500ms`）、正常（`250ms`）或快速（`80ms`）延迟。程序触发的 hover focus 不再把 focus-report sequence 发送给智能体 TUI，也不会把历史位置跳回开头。
- 新增终端滚动与画布缩放相互独立的滚轮方向设置。默认滚轮向下会让终端向下滚动，画布缩放保留原有方向。
- PTY 输出以 16ms 为窗口合并后发送给渲染进程；反复复制 scrollback 字符串改为有界分块缓冲区，从而消除大量输出时的闪烁并减少历史重置。
- 设置、插件注册表和媒体目录授权的写入队列现在可在临时文件系统错误后恢复，服务商客户端元数据也与打包应用版本保持一致。
- 新增完整的简体中文 runtime 插件文档，同步英语、俄语和中文终端控制说明，并记录插件、媒体目录与浏览器的本地数据。
- 新增 MIT 许可证，以及 Security、Changelog、Architecture 和 UI Contract 的本地化版本。

## 1.0.0

- 新增轻量本地启动页，在设置、插件、媒体和 IPC 服务初始化之前显示；bootstrap 失败时会显示可见错误页，并以原生对话框作为 fallback，不再留下空白窗口。
- 新增 Electron 单实例锁：再次启动会恢复并聚焦现有窗口。
- 将终端指针坐标从画布的 CSS 变换矩形映射回 xterm layout 坐标，使文字选择、vim/tmux mouse reporting 和滚轮滚动在任意画布缩放下都能工作。
- 重做终端剪贴板快捷键：有选择时用 `Ctrl+C`、`Ctrl+Shift+C` 或 `Cmd+C` 复制；用 `Ctrl+Shift+V`、`Cmd+V` 或 `Shift+Insert` 通过 `Terminal.paste` 粘贴。快捷键按物理按键匹配，可在非拉丁键盘布局下工作。
- 新增打包应用 smoke harness（`CANVASTTY_SMOKE_TEST=1` 在首次绘制后输出 `CANVASTTY_SMOKE_READY`），并在 Linux release pipeline 中通过带 FUSE2 的 `xvfb-run` 执行。

## 0.9.99 — 公开预览版

- 新增带权限模型的 runtime 插件 registry，可安装已构建好的静态 GitHub 仓库。
- 新增 manifest v1 contribution：sandbox HOME 小组件、可移动画布应用和 CanvasTTY 管理的独立窗口。
- 新增插件预览/权限审查、启用/禁用/卸载、隔离存储、受 CSP 约束的资源和共享 host SDK。
- 新增持久化的用户音乐目录授权、可 seek 的本地音频流，以及受限的播放列表读写 API。
- 新增 sandbox 内置浏览器核心框架，包含标签页、导航、持久化隔离 profile 和画布卡片几何；目前有意不从 HOME 暴露。
- 将固定 HOME 布局替换为可持久化的 `16 × 12` 宽松网格和可视化拖拽/缩放编辑器，同时保留批准的默认布局。
- 新增任意边缘窗口/HOME 小组件缩放、仅编辑时显示的 HOME 边界、越界 draft 摆放、保存校验和编辑模式隔离。
- 新增 runtime 插件架构/开发文档以及完整的 Studio Kit 示例包。

## 0.9.2 — 公开预览版

- 服务商 CLI 查找支持跨平台：Linux 和 Windows 都会解析用户 CLI 目录，因此 AppImage 与 Windows 构建可以找到已有的 `codex`、`claude` 和 `kimi`。

## 0.9.1 — 公开预览版

- 修复图形化 AppImage 启动时的 CLI 查找：使用现有用户 CLI 目录补充桌面会话 `PATH`，包括 `~/.kimi-code/bin`。
- PTY 退出与延迟的终端输入/尺寸事件发生竞态时，不再以 `EBADFD` 崩溃 Electron 主进程。

## 0.9.0 — 公开预览版

- 修复 renderer 在 `loadURL` 完成前绘制时主窗口无法出现的问题；`ready-to-show` listener 现在会提前注册。
- 新增 RTS 风格的边缘平移，默认关闭；指针位于交互界面上时暂停。
- Settings 新增边缘平移开关/速度和滚轮缩放灵敏度。
- Settings 重组为 General、Appearance 和 Controls。
- 新增 Off、Single click 和 Double click 终端聚焦/缩放模式；自动点击聚焦默认关闭。
- 新增可重映射快捷键：`Home` 聚焦 Home 区域，`F2` 行内重命名终端窗口，并提供可隐藏的实时快捷键提示。
- 切换配色、图案、设置和自定义窗口标题时保留 PTY 状态与 scrollback。
- 改进终端剪贴板快捷键、边缘缩放、语义缩放交互和多语言文档。

## 0.8.2 — 公开预览版

- Release job 只发布面向用户的安装包，不包含解包后的构建目录。
- Windows NSIS 与 portable 可执行文件使用不同的 artifact 名称。

## 0.8.1 — 公开预览版

- 仓库和文档安全检查兼容 LF/CRLF checkout 与 Windows drive path。
- 应用行为与 `0.8.0` preview candidate 相同。

## 0.8.0 — 公开预览版

- 面向真实本地 PTY 与 AI 智能体 CLI 会话的空间画布。
- 固定 Home 区域，包含 launcher、sessions、clock、media 和基于真实来源的服务商限额。
- 可移动、可调整尺寸、带 snapping 和 semantic zoom navigation 的终端卡片。
- Electron 进程隔离、类型化白名单 IPC 和仅本地设置。
- 英语、俄语与简体中文仓库入口和文档。
- 通过 GitHub Actions 可复现地打包 Linux、Windows 和 macOS。
- 仓库秘密审计和严格的包内容 allowlist。

已知预览限制：runtime widget 插件尚未实现；Windows 与 macOS 仍需要更广泛的真实设备验证；发布包尚未代码签名或 notarized。
