# 架构

[English](ARCHITECTURE.md) · [Русский](ARCHITECTURE.ru.md) · [简体中文](ARCHITECTURE.zh-CN.md)

## 进程边界

CanvasTTY 遵循 Electron 的三层模型：

```text
React renderer
    │ 类型化 window.canvasTTY API
    ▼
preload bridge (contextBridge)
    │ 白名单 IPC channel
    ▼
Electron main process
    ├── SettingsStore  → 已校验的原子 JSON 持久化
    ├── TerminalManager → node-pty lifecycle、有界 scrollback 与输出 batching
    ├── LimitsService  → 脱敏后的服务商限额 adapter 与 cache
    ├── PluginManager  → GitHub 安装、manifest、assets、permissions、storage
    ├── PluginSecretsService → 操作系统保护的插件凭据加密与 fail-closed 可用性
    ├── PluginMediaService → 用户授权媒体目录、ranged audio stream、playlist
    ├── BrowserService → 内置 tab 与隔离 WebContentsView lifecycle
    ├── canvastty-plugin:// → 受 CSP 限制的静态 plugin resource
    ├── canvastty-media:// → 权限检查后的本地音频流
    └── 原生 dialog/window control
```

- `src/shared/contracts.ts` 是进程之间唯一的公共契约。跨进程数据的新增或修改必须先在这里声明。
- `src/preload/index.ts` 只暴露 renderer 需要的类型化能力。Node integration 保持关闭，context isolation 与 sandbox 保持开启。
- `src/main/ipc/registerIpc.ts` 负责原生 side effect，并校验对持久化媒体的访问。
- `src/main/services/TerminalManager.ts` 是实时会话状态与 PTY buffer 的事实来源。它用有界分块缓冲区保存 scrollback，并将 PTY data 合并为 16ms IPC batch，使 clear/redraw sequence 尽量一起到达 xterm。新 PTY 状态为 `idle`；进程退出只产生 `done` 或 `failed`。`working` 和 `needs_approval` 只接受类型化的服务商 lifecycle signal，绝不根据 PTY 是否存在或终端文字推断。
- `src/main/services/LimitsService.ts` 通过已安装 CLI 的 app-server protocol 读取 Codex，并通过服务商 usage/billing endpoint 读取 Claude、Kimi、OpenCode Go 与 Grok Build。凭据只在可信主进程读取，只通过 HTTPS 发往匹配的服务商，不记录也不通过 IPC 暴露。该服务负责 timeout、structural normalization、cache、stale fallback 与子进程 cleanup；原始服务商响应不会跨越 IPC。
- `src/main/services/SettingsStore.ts` 会规范化每次更新，并通过串行原子写入持久化。
- `src/main/services/PluginManager.ts` 安装已构建的静态仓库，不执行 package script；拒绝 symlink 与超大包；持久化启用 registry；只提供包内文件，并执行每插件 permissions/storage quota。
- `src/main/services/PluginSecretsService.ts` 串行化每个插件的机密写入，通过 Electron `safeStorage` 加密完整的有界 payload，拒绝 plaintext-only backend，并在卸载时删除加密文件。
- `src/main/services/PluginMediaService.ts` 仅在原生目录选择后保存授权，隐藏绝对路径，跳过 symlink，并以 HTTP Range 提供音频。Playlist 读取限制在授权媒体库内；写入受大小限制，并且只能原子写入 `Playlists/`。
- `src/main/services/BrowserService.ts` 管理内置浏览器的 `WebContentsView` tab。远程页面使用独立 persistent partition，禁用 Node，启用 context isolation/sandbox，并默认拒绝网站权限。这是 core service，不是 runtime 插件能力。
- `TerminalManager` 注入 MCP helper 时不会留下永久的服务商配置变更。Claude Code 与 Codex 使用 CLI 参数；OpenCode 使用合并后的、仅本次启动有效的 `OPENCODE_CONFIG_CONTENT` 和一条 scoped browser-tool 权限；Kimi 使用 per-run MCP 配置，旧版本则使用带 compare-and-swap 与 recovery journal 的临时配置。Hermes 会在 `HERMES_HOME/config.yaml` 中获得临时 `mcp_servers.canvastty_browser` 配置项（POSIX 默认路径为 `~/.hermes/config.yaml`，Windows 默认路径为 `%LOCALAPPDATA%\hermes\config.yaml`），敏感 capability 值仍以子进程环境变量占位符保存。Kimi 与 Hermes 的临时配置会保留到最后一个所属 PTY 会话结束；若文件未被并发修改，则精确恢复原始字节。若 Hermes 启动意外中断，journal 会在 CanvasTTY 下次启动时修复配置，compare-and-swap 则保留用户的并发修改。其他 MCP 配置项、凭据和文件/shell 权限不会受影响。OpenCode YOLO 仅使用本次启动的 inline override，Hermes 则使用原生 `--yolo` 参数；两者都不修改持久权限设置。
- `src/main/services/providerCliRegistry.ts` 是服务商 CLI 发现的唯一职责边界。main 进程启动时，它按 smoke-only override、继承的 `PATH`、平台默认目录、已知用户/服务商目录的顺序，为 Codex、Claude、Kimi、OpenCode、Hermes 与 Grok Build 创建一个不可变快照。可用条目保存绝对 executable、launcher 类型以及补充后的子进程 `PATH`；POSIX 候选必须是可执行文件，Windows 候选必须是受支持的 native 或 batch launcher。`TerminalManager`、`LimitsService`、agent-browser probe 与 provider smoke 共用该快照，不再各自查找命令。CLI 不可用时，系统会在创建 PTY 或临时 browser 配置之前生成 failed session，并提供可复制的已检查路径诊断；对应的 HOME limit 同样保持 `cli-not-found`。CanvasTTY 不读取 shell startup script；安装或移动 CLI 后必须重启应用。

主 `BrowserWindow` 在 settings、plugins、media 和 IPC 服务初始化之前创建并显示轻量本地启动页。初始化成功后替换为可信 renderer；bootstrap 失败后替换为可见错误页，并保留原生对话框 fallback。主进程持有 Electron single-instance lock；再次启动时恢复并聚焦已有窗口。

Runtime 插件代码绝不会导入主进程或可信 renderer bundle。HOME widget 与 canvas app 在 opaque origin 的 sandbox iframe 中运行。独立插件窗口使用职责狭窄的 preload，通过 IPC handler 转发同一 message SDK；handler 根据实际 sender URL `canvastty-plugin://<id>/<entry>` 校验 plugin/contribution。任意原生系统窗口不会被嵌入。

插件音乐访问基于 capability，而不是通用文件系统权限。媒体扫描返回 library ID、相对路径、metadata 与 `canvastty-media://` stream URL；原始 playlist 文本是唯一暴露的 format-neutral 文件内容。媒体 URL 只为对应且已启用的插件解析，并且必须位于用户此前选择的 library root 下。卸载插件会撤销其持久化目录授权。

内置浏览器跨两个界面分工：`BrowserCard` 渲染可信的外层 window chrome、tab、navigation、agent badge、download、dialog 与 canvas geometry；`BrowserService` 把活动 native view 定位到卡片测量出的 viewport 上。卡片或 camera 移动时 native view 保持实时渲染，并按帧合并 geometry 更新；仅在 semantic summary、编辑 HOME 或可信 modal 后方隐藏。Fractional renderer bounds 扩展到完整覆盖的 device-independent pixel；只有活动 tab 实际变化时才重新挂接 view。Typed pointer bridge 把 native page 的 click/hover activity 返回 canvas selection，并显式恢复页面焦点而不阻止页面输入。仅连接或 heartbeat 不会创建 presence：实际 browser command 后才显示 badge，获得真实 pointer position 后才显示 cursor。

## Renderer 边界

`App.tsx` 是编排边界。它加载 settings/session，订阅主进程事件，并协调 dialog 与持久化。Feature component 不调用无关 feature 的 API。

```text
App
├── WorkspaceCanvas        camera、pan、zoom、空间组合
│   ├── HomeZone           持久化网格、边界与编辑手势
│   │   ├── homeModel      纯函数派生限额/活动会话行
│   │   └── HomeMediaWidget 独立的 pick/replace/remove control
│   ├── TerminalCard       xterm、selection、rename、drag、resize、snap
│   ├── PluginCanvasCard   带 bounds 与 summary 的 sandbox plugin app
│   └── BrowserCard        可信 browser chrome 与 native view geometry
├── AgentLaunchDialog      固定 provider + folder + profile + launch
└── SettingsPanel          General、Appearance、Controls、Plugins
    └── PluginSettingsSection preview、permissions、registry、contribution
```

领域决策放在 `homeModel.ts` 等纯 selector 中，编排放在 `App.tsx`，渲染/本地交互放在 feature component。IPC call 属于 `App.tsx` 或唯一拥有该 capability 的 feature。

## 会话流程

1. Home 请求终端，或打开某个服务商专属的 launch card。
2. `App` 发送类型化 `terminal:create` 请求。
3. `TerminalManager` 校验请求、启动 PTY、保存 metadata 和有界分块 scrollback，然后发送 lifecycle event 与 16ms batch data event。
4. `App` 按 session ID 协调 lifecycle snapshot。
5. `TerminalCard` 订阅 PTY stream，发送 PTY input/grid resize，并在 drag 或 edge resize 完成后提交类型化 canvas bounds。

`SessionMetadata` 同时拥有 world-space position 与卡片尺寸。`App` 协调 bounds；`TerminalCard` 可以在 pointer-up 前暂存 pointer-move geometry。主进程在发送 session snapshot 前校验并限制已提交尺寸。Camera wheel 只处理空白 canvas；交互界面保留自己的 native scroll/input ownership。

一个实时 `TerminalCard` 在对应 session ID 的整个生命周期内拥有同一个 xterm instance。切换 palette 时就地更新 `terminal.options.theme`；title/settings 变化不得销毁 terminal 或 renderer scrollback。窗口标题通过 `terminal:rename` 作为 session metadata 更新。与进程退出竞态的 PTY input/resize event 在主进程边界内处理，不会形成未捕获 Electron error。

输出 batching 是 IPC/rendering 边界，而不是历史边界：每个 PTY chunk 都立即追加到有界 scrollback；待发送的 renderer 输出在 16ms timer、exit 前和 dispose 前 flush。Scrollback trimming 通过推进 chunk 完成，不会每次写入都重建整个 buffer；snapshot 只 join 保留的后缀。

终端指针坐标在 selection/wheel handling 前，从画布视觉变换后的矩形转换回 xterm layout 坐标。终端与画布滚轮方向从持久化设置中独立规范化。选中文字通过类型化 clipboard bridge 使用 `Ctrl+C`、`Ctrl+Shift+C` 或 `Cmd+C` 复制；使用 `Ctrl+Shift+V`、`Cmd+V` 或 `Shift+Insert` 粘贴，并通过 `Terminal.paste` 而非 synthetic keystroke 进入 xterm。`Shift+Enter` 直接向 PTY 发送 CSI-u modified Enter。

Application shortcut 在 `SettingsStore` 中规范化，在 `App` 中匹配，并从同一持久化 binding 渲染到 canvas hint。`App` 拥有排他的 canvas application selection，以及窗口 rename 等操作使用的 selected terminal session；`TerminalCard` 拥有 xterm focus 与 inline editor，`BrowserService` 拥有 native page focus。点击空白 canvas 会清除任一 selection。可选 hover focus 对终端与内置 Browser 使用相同的进入/离开配置延迟；终端程序化切换产生的 focus-in/focus-out sequence 会在进入 PTY input 前被抑制，避免智能体 TUI 重置历史位置。

Session counter、progress bar 与 status 必须来自真实 `SessionSnapshot`，UI 不得合成 telemetry。

## 服务商限额流程

1. `App` 在 bootstrap 时以及每 60 秒请求脱敏后的 `LimitsSnapshot`。
2. `LimitsService` 对 refresh 去重，并维护 60 秒 cache。
3. Codex 通过 `codex app-server` 的 `account/rateLimits/read` 查询；Claude、Kimi、OpenCode Go 与 Grok Build 使用只读 usage/billing endpoint 和对应 CLI 已有凭据。OpenCode Go 提供真实 rolling、weekly、monthly window；Grok Build 提供真实共享 billing period。响应经过结构校验，只保留 percentage、window 与 reset time。
4. 一次成功后刷新失败时，最后的有效 snapshot 以 stale 返回。缺失或不支持的 adapter 返回明确 unavailable reason，而不是 `0%`。
5. Claude weekly window 只适用于 Claude.ai subscription session。API Usage Billing 返回 `subscription-required`，而不是虚假 quota。CanvasTTY 不解析服务商 TUI screen。

## 扩展点

- 新增 provider 时，在 `ProviderId`、`providers.ts`、`TerminalManager.resolveLaunch`、官方 provider asset map 和可选的安全 limit adapter 中添加。
- 新增持久化 setting 时，在 `AppSettings`、`SettingsStore` defaults/normalization 与唯一归属 feature 中添加。Settings 负责面向用户的 canvas control 与 shortcut；camera math 和 snapping geometry 保持为纯 renderer concern。
- 新增 canvas entity 时，使用独立 feature component，声明明确 position 与 callback；camera ownership 保留在 `WorkspaceCanvas`。
- 发布 runtime extension 时，使用 `canvastty.plugin.json` API v1 与静态 HTML/CSS/JS entry。Contribution kind 为 `home-widget`、`canvas-app`、`window`；capability access 受 manifest permission 限制。参见[运行时插件](plugins.zh-CN.md)。

每项扩展都应通过 `npm run typecheck`、`npm run build`，并在真实 Electron 中完成交互检查。
