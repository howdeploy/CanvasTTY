https://github.com/user-attachments/assets/444612f7-cda1-4fd6-8514-2f4fac9cc520

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.zh-CN.md"><strong>简体中文</strong></a>
</p>

<table>
  <tr>
    <td>
      <strong>终端是场所，而不是标签页。</strong><br>
      CanvasTTY 是一个基于 Electron 的空间桌面，承载真实的本地 PTY 与 AI 智能体 CLI 会话。固定的 Home 区域、无限画布上自由摆放的实时终端，以及来自真实数据源的服务商限额。
    </td>
  </tr>
</table>

## 技术栈

| 桌面端 | 界面 | 终端 | 服务商 |
|:--|:--|:--|:--|
| **Electron**<br>electron-vite | **React**<br>TypeScript | **xterm.js**<br>node-pty | **Codex**<br>Claude · Kimi · OpenCode · Hermes · Grok Build |

应用界面目前支持英语和俄语；本文档另提供简体中文版本。

## 一张画布，真实会话

在项目目录中启动 shell 或智能体，随意移动并调整实时终端的大小；缩小视图，以语义化的方式纵览全局；回到 Home，查看会话、限额、媒体与启动入口。CanvasTTY 在可信的主进程中维护 PTY 状态，只向渲染进程暴露类型化且经白名单放行的能力。

## 智能体、编排与防护

智能体默认以 **Auto** 模式启动：使用 CLI 自带的自动模式（Claude Code、Codex、Grok）、CanvasTTY 为 OpenCode 提供的单次启动规则；对于没有自动模式的 CLI，则是跳过审批，且只在智能体隔离内可用。Manual、Accept edits、Plan 与 Bypass 只在 CLI 支持时提供；Bypass 需要用户为每个 CLI 确认一次，且不会交给子智能体。所有模式外面都有用户在 Settings → Agents 中控制的防护层：基础防护（hook 在工具调用运行前拒绝提权、`curl | sh`、磁盘命令以及项目外的写入）、委派规则（子智能体的权限不超过其编排者，只在其项目内工作；默认最多 2 层、8 个存活子智能体），以及操作系统隔离层（macOS 用 `sandbox-exec`，Linux 用 bubblewrap；Windows 暂无隔离层，子智能体在那里以 Manual 运行）。隔离会话结束后，CanvasTTY 会检查它触及的仓库中是否有会在隔离外运行程序的 git 设置，并提供一键消除。

以 **Orchestrator** 角色启动的会话会获得 `canvastty_agents` 工具：`list_providers`（已安装的智能体、登录状态、模型、effort、profile）、带可选 `model`、`effort` 与 `profile` 的 `spawn_agent`、`wait_for_agent`（最长 600 秒），以及 `get_agent_result`——它以 `answer` 返回 Codex 或 OpenCode 子智能体的最终回复（最多 4,096 个字符，已脱敏）。详见[智能体编排与隔离](docs/agent-orchestration.md)（英文）和[防护层](docs/installing-and-security.zh-CN.md#智能体防护层)。

除了单个子智能体，编排者还可以遵循内置流程或经用户批准的项目流程，与子智能体共享任务看板（`list_tasks`、`claim_task`、`update_task`、`complete_task`），请求审查者或独立的 git worktree，重试失败的子智能体（`retry_agent`），向用户提问（`ask_user`），并在用户批准后使用提供方密钥发送类型化 API 请求而看不到密钥本身（`request_secret`）。用户可为每个任务树设置时间、token 和费用预算，为每个项目设置网络策略；每张卡片的详情中有时间线、用量、报告和 git 检查点。

## Windows 终端与服务商 CLI

在 Windows 上，Terminal 启动器会以干净的 `-NoLogo -NoProfile` 会话打开系统自带的 Windows PowerShell；如果不可用，则回退到 `pwsh` 或 `cmd.exe`。在交给 `node-pty`/ConPTY 之前，CanvasTTY 会先从用户 `PATH`、再从标准的用户级 CLI 目录中，为 Codex、Claude、Kimi、OpenCode、Hermes 与 Grok Build 解析出具体的 `.exe`、`.com`、`.cmd` 或 `.bat` 启动文件。

CanvasTTY 不会安装服务商 CLI。若某个 CLI 缺失，启动对话框会明确说明未找到的服务商以及已检查的目录。安装所需 CLI 后，请重启 CanvasTTY，让桌面进程读取更新后的环境。

## 安装

从 [GitHub Releases](https://github.com/howdeploy/CanvasTTY/releases) 下载最新版本：Linux x86_64 提供 AppImage/deb，Windows x64 提供安装程序/便携版，Apple Silicon macOS 提供 dmg/zip。macOS bundle 已进行 ad-hoc 签名并通过完整性验证，但没有 Developer ID 签名或 Apple notarization；Windows 软件包仍未签名。目前也不包含 Intel Mac 构建；请先阅读[安装与本地数据安全](docs/installing-and-security.zh-CN.md)。

也可以从源码运行：

```bash
npm install
npm run dev
```

`npm run build` 与打包还会构建原生智能体 helper（`canvastty-helper`，需要 Go ≥ 1.21，`npm run build:helpers`），在 macOS 和 Linux 上运行 MCP 服务器与 hook；没有 Go 时应用继续使用 JavaScript helper，Windows 默认也使用它们。

## 文档

| 从这里开始 | 扩展 CanvasTTY |
|:--|:--|
| [文档中心](docs/README.zh-CN.md) | [编写小组件](docs/widget-authoring.zh-CN.md) |
| [快速开始](docs/getting-started.zh-CN.md) | [指标与遥测](docs/metrics-and-telemetry.zh-CN.md) |
| [内置浏览器与审计日志](docs/browser.zh-CN.md) | [内置智能体浏览器 skill](agent/browser/SKILL.md) |
| [智能体编排与隔离（英文）](docs/agent-orchestration.md) | [内置编排 skill](agent/orchestrator/SKILL.md) |
| [安装、发布与本地数据](docs/installing-and-security.zh-CN.md) | [安全策略](SECURITY.zh-CN.md) |
| [架构](docs/ARCHITECTURE.zh-CN.md) | [UI 契约](docs/UI_CONTRACT.zh-CN.md) |
| [运行时插件开发](docs/plugins.zh-CN.md) | [插件 SDK 类型](docs/plugin-api.d.ts) |
| [更新日志](CHANGELOG.zh-CN.md) | [MIT 许可证](LICENSE) |

## 运行时插件

CanvasTTY 已提供带权限模型的静态 GitHub 运行时插件，可扩展 HOME 小组件、画布应用和独立 sandbox 窗口。Host SDK 支持持久化的用户音乐目录授权、可 seek 的本地音频流，以及受限的播放列表导入与导出，可用于实现完整的播放器插件。参见[插件开发与安全指南](docs/plugins.zh-CN.md)、[manifest schema](docs/canvastty-plugin.schema.json)和[TypeScript SDK 类型](docs/plugin-api.d.ts)。

插件示例：

- [canvastty-plugin-hermes-hud](https://github.com/howdeploy/canvastty-plugin-hermes-hud) — 来自 CanvasTTY 作者：一个 HOME 小组件，用于以 HUD 模式启动和退出已安装的 Hermes Desktop，并显示经过确认的实时进程状态；仅使用最小化的 `hermes:hud` 权限。
- [canvastty-music](https://github.com/Alitryel/canvastty-music) — 由 [@Alitryel](https://github.com/Alitryel) 开发：一款紧凑的本地音频文件夹与 Yandex Music 播放器，附带独立的全尺寸曲库工作区、播放列表、播放队列和可选的动画宠物。
- [canvastty-plugin-hermes-dashboard](https://github.com/4444cjtr/canvastty-plugin-hermes-dashboard) — 由 [@4444cjtr](https://github.com/4444cjtr) 开发：一个 HOME 小组件，用于检测本地 Hermes Agent dashboard 是否在运行，通过一个小型 loopback 辅助服务将其启动，并在 CanvasTTY 内以嵌入式浏览器卡片打开。

## 面向智能体的内置浏览器

CanvasTTY 已提供核心内置浏览器，而不是插件权限：可信 React 外壳配合 sandboxed Electron `WebContentsView` 标签页，并使用一个持久化 Chromium profile。浏览器可从 HOME 打开，能够恢复安全的 HTTP(S) 标签页，把网站凭据留在 Chromium 内部，管理下载/上传，并向由 CanvasTTY 启动的 Claude Code、Codex、Kimi、OpenCode 与 Hermes 会话提供类型化 browser action。

浏览器卡片与终端共享画布的选中、悬停聚焦、拖动、调整大小和语义缩放模型。Settings 提供智能体访问、标签页恢复、最近下载/活动和浏览器数据清理。智能体通过经过认证的本地 socket 或 named pipe 以及内置 stdio MCP helper（macOS 与 Linux 上为原生版本）接入；不会开放 TCP 或 remote-debugging port，也不会导出 cookie、密码、认证 header、local storage、任意 JavaScript 或 raw CDP。

每条浏览器命令都会生成脱敏的本地活动记录。持久化 JSONL 审计文件位于 Electron `userData/browser/audit`，组成 hash chain，达到 100 MB 时轮转，并在 store 初始化或轮转时清理超过 30 天的轮转文件。日志不会保存输入/页面文本、截图、凭据、URL query/fragment、header、cookie 或 token。详见[浏览器与审计日志指南](docs/browser.zh-CN.md)和[架构文档](docs/ARCHITECTURE.zh-CN.md)。

## 快速检查

```bash
npm test
npm run typecheck
npm run build
```

## 许可证

CanvasTTY 基于 [MIT 许可证](LICENSE)发布。
