# 内置浏览器与审计日志

[English](browser.md) · [Русский](browser.ru.md) · [简体中文](browser.zh-CN.md) · [文档首页](README.zh-CN.md)

CanvasTTY `1.0.2` 已从 HOME 提供内置浏览器，它是可信的画布应用。浏览器使用 sandboxed Electron `WebContentsView` 标签页和一个持久化 Chromium profile；它不是运行时插件权限。

## 打开并使用浏览器

1. 在 HOME 打开 **Browser**。CanvasTTY 会在画布上创建或恢复浏览器卡片。
2. 使用可信标签栏和地址栏进行 HTTP(S) 导航或搜索。后退、前进、刷新、新建标签页、关闭标签页和全部关闭控件都位于远程页面之外。
3. 像终端一样移动卡片或调整其大小。低于 semantic scale 时原生页面会替换为稳定摘要；在 live scale 下，camera 或卡片移动时页面继续渲染。
4. 点击 live page 会选中浏览器并恢复 keyboard focus。单击/双击配置只控制 camera focus。**设置 → 控制 → 悬停时聚焦** 对终端和浏览器使用同一延迟。点击空白画布会清除活动应用。
5. 下载面板显示最近的进度。JavaScript alert/confirm/prompt 会暂停，直到可信 CanvasTTY dialog 给出答复。

隐藏浏览器卡片不会关闭标签页。确认后使用 **全部关闭** 才会移除标签页。**设置 → 浏览器 → 恢复标签页** 决定安全 URL 是否在重启后返回。

## 浏览器设置

| 设置 | 行为 |
|:--|:--|
| **智能体访问** | 允许由 CanvasTTY 启动的 Claude Code、Codex、Kimi、OpenCode 和 Hermes 会话使用类型化浏览器工具；默认开启 |
| **智能体指示器** | 智能体实际执行 browser command 后显示 badge，获得真实 pointer position 后才显示 cursor；默认开启 |
| **恢复标签页** | 保存标签顺序、活动标签和安全的恢复 URL；默认开启 |
| **下载** | 显示最近六项下载及其本地进度/状态 |
| **浏览器活动** | 显示最近十条内存中的人类/智能体命令结果；运行时缓冲区最多 1000 条，应用重启后清空 |
| **清除浏览器数据** | 关闭标签页并删除恢复状态、网站存储、cache、HTTP auth cache、暂存上传和当前下载列表 |

清除浏览器数据**不会删除**下文的持久化审计日志。

## 智能体访问

只有 CanvasTTY 启动的智能体会话会获得本次启动专属的浏览器连接。主进程通过子进程环境把一次性 bootstrap capability 交给内置 stdio MCP helper。Claude 与 Codex 使用 per-run CLI 参数，OpenCode 使用仅本次启动有效的 `OPENCODE_CONFIG_CONTENT` MCP 配置，Kimi 使用 per-run 文件或可恢复的临时配置，Hermes 则获得可恢复的临时 `mcp_servers.canvastty_browser` 配置项，其中 capability 字段引用子进程环境变量。认证成功后，capability 会轮换为仅保存在 helper 内存中的 session-scoped reconnect capability；只有同一次启动仍存在活动连接时才允许重复 bootstrap 认证，PTY 结束时会撤销全部访问。Linux/macOS 使用当前用户的 Unix socket；Windows 使用内置 native named-pipe host，其 DACL 仅包含当前用户的准确 SID。连接与 heartbeat 本身不会把智能体标记为浏览器活跃；presence 从第一次 browser command 开始。

工具面覆盖标签页、导航、observe/read、截图、click/hover/type/select/press、scroll/drag、等待、dialog、下载以及调用智能体自己的活动。它不会暴露 cookie、保存的密码、authorization header、local/session storage、任意 JavaScript、文件系统/shell、raw CDP、TCP listener 或 remote-debugging port。

智能体 mutation 在每个标签页内按 FIFO 执行，按 request ID 去重，在产生副作用前检查 document revision，并受 rate limit 与 timeout 限制；若必需的审计 attempt 无法写入，该 mutation 会被阻止。read 可以并行执行，不同标签页使用独立 mutation lane。

## 网站与文件边界

- 远程页面运行在 sandbox 中，启用 context isolation，不含 Node.js 或 CanvasTTY preload。
- 顶层导航仅接受规范 HTTP(S) URL。HTTP(S) popup 会成为内部标签页；privileged/external scheme 会被拒绝。
- Hardware、geolocation、notification、clipboard read、不安全证书绕过、webview、client certificate 和 HTTP-auth prompt 均被拒绝。
- 下载保存到用户 Downloads 目录下由 CanvasTTY 管理的位置。上传必须通过路径、文件数量和总大小检查，并在交给 Chromium 前通过 no-follow descriptor 复制到私有暂存区。
- 访问的网站本身仍可把用户提交给它的数据发送到网络。CanvasTTY 的本地边界不能替网站作出隐私承诺。

## 活动列表与持久化审计日志

Settings 中的活动列表是短期运行视图。主进程还会把 JSONL 审计记录追加到：

```text
<Electron userData>/browser/audit/browser-audit.jsonl
```

活动文件以 `0600` 模式创建。记录包括 actor/provider/session 标识、operation、attempt/result phase、tab ID、去除 query/fragment 的 origin、document revision、duration、outcome/error code，以及连接 hash chain 的哈希。日志会主动脱敏输入值、页面文本、截图/base64、凭据、authorization/cookie 字段、密码、secret、token 和 API key。

活动文件达到 100 MB 时轮转。轮转文件继续保持 hash chain；超过 30 天的文件会在 store 初始化或轮转时清理。store 打开时会验证现有链，链无效后将拒绝继续追加。若智能体 mutation 的 pre-action audit 无法保存，智能体会收到 `AUDIT_UNAVAILABLE`，且不会执行 mutation 副作用。

CanvasTTY 没有远程日志收集器或项目自营 telemetry endpoint。**清除浏览器数据**会保留审计证据。如需手动删除，请先完全退出 CanvasTTY，再删除整个 `userData/browser/audit` 目录；这会永久丢弃本地审计历史。

实现职责见[架构](ARCHITECTURE.zh-CN.md)，画布与交互约束见 [UI 契约](UI_CONTRACT.zh-CN.md)，其他本地数据路径见[安装、发布与本地数据](installing-and-security.zh-CN.md)。
