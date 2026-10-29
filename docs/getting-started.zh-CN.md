# 快速开始

[English](getting-started.md) · [Русский](getting-started.ru.md) · [简体中文](getting-started.zh-CN.md) · [文档首页](README.zh-CN.md)

## 环境要求

- Node.js 与 npm。
- 当前平台上 `node-pty` 支持的原生编译工具链。
- 能运行 Electron 的图形桌面环境。
- 可选：Go 1.21 或更高版本，用于构建原生智能体 helper（`npm run build:helpers`，`npm run build` 也会调用）。没有 Go 时应用使用 JavaScript helper。
- Linux 可选：bubblewrap（`bwrap`），用于智能体隔离。
- 可选：安装 `codex`、`claude`、`qwen`、`kimi`、`opencode`、`hermes`、`grok`、`omp` 或 `pi` 智能体 CLI 并加入 `PATH`，只装你打算使用的启动器对应的即可。

Agents 设置提供官方安装说明链接和安装后的再次检查。CanvasTTY 不会替你安装或登录智能体 CLI。想让某个服务商的会话或订阅限额可用，请先完成该服务商自己的登录流程。

## 安装与运行

```bash
npm install
npm run dev
```

`npm install` 还会准备 Electron 并重新编译原生的 `node-pty` 模块。开发命令启动的是真正的 Electron 应用，不是只能在浏览器里跑的模拟界面。

## 第一个会话

1. 在 Home 页点击 **Terminal**，立即在上次使用的项目目录里打开一个 shell。
2. 点击 **Codex**、**Claude**、**Kimi**、**OpenCode**、**Hermes** 或 **Grok Build**，为对应的固定服务商选择项目目录和启动模式（默认 Auto）。
3. 在 Home 打开 **Browser**，创建或恢复内置浏览器卡片。启用 **设置 → 浏览器 → 智能体访问** 后，由 CanvasTTY 启动的智能体会话可以使用已打开的标签页。
4. 在同一画布上移动实时终端和浏览器，或调整它们的大小。
5. 缩小画布后借助语义摘要导航；放大后继续使用 xterm 或原生浏览器页面。
6. 回到 Home，查看真实会话、已连接的浏览器智能体以及适配器提供的服务商配额窗口。

启动模式有 **Auto**（默认）、**Manual**、**Accept edits**、**Plan** 与 **Bypass**，只在对应 CLI 支持时提供；它们外面的防护层见[安装与安全](installing-and-security.zh-CN.md#智能体防护层)。在服务商支持的情况下，**Bypass**（YOLO）会关闭其安全确认提示，但仍受已启用的基础防护与智能体隔离约束。对于 OpenCode，CanvasTTY 只在本次启动中添加 inline `permission: "allow"` override，并保留其余合并后的 OpenCode 配置；Hermes 接收原生 `--yolo`，Grok Build 接收原生 `--always-approve`，且都只作用于本次启动。CanvasTTY 会要求你为每个 CLI 确认一次，且不会交给子智能体；只在你愿意让智能体改动的目录中使用它。

Kimi 2.4+ 提供四种启动选择：Auto（Ask When Needed，`--yolo`）、Manual、
Plan（`--plan`）及 Bypass（Never Ask，`--auto`），没有独立的 Accept edits。
另有 Cursor Read only（Ask）、显式审批、OMP 审批缓存、Claude/Grok/Codex
No prompts，以及使用自身沙箱的 Devin Autonomous。
仅能通过配置或插件使用的模式不会伪装成启动参数。
参见[各智能体模式与验证范围](agent-launch-modes.md)，包括 Antigravity 的版本与沙箱要求。

## 终端动画背景

在 **Settings → Appearance → Terminal backgrounds** 中选择背景。要在 OpenCode 中显示动画，必须选择其系统主题：在 OpenCode 中输入 `/theme` 并选择 **system**。该主题使用终端默认背景；普通 OpenCode 主题会在动画上绘制自己的不透明背景。参见 [OpenCode 主题文档](https://docs.opencode.ai/docs/themes/)。

对于会自行填充屏幕背景的其他 TUI 智能体，请在支持的情况下选择对应的系统主题、终端默认背景或透明模式。这是显示动画背景的条件，并非在 CanvasTTY 中正常运行智能体的要求。TUI 的面板、输入框和选中区域仍可能保留各自的背景。

**Terminal backgrounds → Adjust → Text readability** 会在文字后面添加暗色衬底。如果动画上出现暗色条带，可降低 **Darkness behind text**，或关闭可读性选项进行比较。字符本身被截断或缺失并非预期效果。

## 终端输入与控制

- 点击任意实时终端卡片即可选中并聚焦它。Input focus 与 selection 相互独立，因此未来加入 multi-selection 后仍能保持唯一明确的 keyboard 与 wheel 目标。
- 点击所有 widget 之外会清除 input focus。点击装饰性或仅执行 action 的 widget 不会让它成为 wheel 目标。
- **设置 → 控制 → 悬停时聚焦** 会在延迟后转移 input focus：慢速 `500ms`、正常 `250ms`、快速 `80ms`。离开只会取消尚未触发的转移；已分配的 focus 会保留，selection 不变。默认关闭。
- 新配置中，在 canvas、unfocused widget 和不可聚焦 widget 上的普通 scroll 会沿两个轴移动 canvas，pinch 与 `Cmd/Ctrl + scroll` 会以指针为中心缩放。Focused input widget 在 Off 或 Key 未按下时保留普通 wheel/pinch；这也适用于 live Browser page，因此获得 focus 后页面会原生滚动。Unfocused Browser、On、激活的 Key binding、pinch 与 `Cmd/Ctrl + scroll` 会交给 canvas。Browser summary/placeholder 始终交给 canvas。**设置 → 控制 → Use scroll wheel to zoom** 可恢复普通 wheel zoom。新配置默认使用 Key，在 macOS 为 `Command`，其他平台为 `Ctrl`。独立的完整 canvas navigation override 默认使用 `Option`/`Alt`，允许单独 Command/Ctrl，还会接管 drag，并在按住时显示手形 cursor。
- 终端滚动与画布导航的滚轮方向可以独立设置。Canvas inversion 同时作用于两个 pan 轴和普通 wheel zoom。
- `Shift+Enter` 会发送带修饰符的 Enter，在兼容的智能体 prompt 中插入换行而不提交；普通 `Enter` 保持原有 PTY 行为。
- 选中终端文字后，默认使用 Windows 的 `Ctrl+C`、Linux 的 `Ctrl+Shift+C` 或 macOS 的 `Cmd+C` 复制。默认粘贴快捷键为 Windows/Linux 的 `Ctrl+Shift+V` 和 macOS 的 `Cmd+V`，均可在设置中更改。没有选中文字时，普通 `Ctrl+C` 仍是 PTY 中断。

### Codex 编辑器快捷键

**设置 → 通用 → 键盘快捷键 → Codex** 中的发送和换行快捷键适用于新建或重启的 Codex 卡片，也支持普通 CLI。现有卡片保留启动时的绑定。CanvasTTY 将配置的物理组合（包括 Command/Meta 和非拉丁键盘布局）转换为发送或换行动作。终端搜索、复制、粘贴及重启优先于通用修饰 Enter 处理，因此释放的 Enter 组合可以分配给终端命令。

普通 Codex 通过仅本次启动有效的 `-c tui.keymap` 参数，将发送固定为 Enter，并保留包括 Shift+Enter 在内的默认换行组合。本次启动中，这些参数优先于个人的发送和换行绑定；不会修改个人 `~/.codex/config.toml`。若没有 CanvasTTY 命令占用它们，原生 Enter 和 Shift+Enter 仍可使用；Codex 提示可能显示这些按键而非设置中的组合。配置已对照 Codex 0.163.0 源码核实，较旧版本尚未检查。这些设置不影响在普通 shell 卡片中手动启动的 Codex。

普通 Codex 0.163.0 没有可配置的“全选草稿”动作；`Ctrl+A` 通常将光标移到行首。录制快捷键无法添加该动作，全选草稿需要兼容的内置前端。确认、语音输入等其他命令保留各自的 keymap。

## 浏览器控制与活动

- Browser 与 Terminal card 遵循相同且相互独立的 selection 与 input-focus 规则。悬停 native page 会在配置的延迟后转移 focus；离开页面不会清除它。在 Off 或 Key 未按下时，该 focus 也允许普通 wheel 原生滚动 live page。Pinch 与 `Cmd/Ctrl + scroll` 仍会缩放 canvas。页面也可通过 scrollbar drag、键盘或站点控件滚动。
- 使用可信标签栏与导航栏访问 HTTP(S) 页面。隐藏卡片会保留标签页；确认后使用 **全部关闭** 才会移除它们。
- **设置 → 浏览器** 控制智能体访问和标签页恢复，并显示最近下载和命令活动。
- **清除浏览器数据** 会删除标签页、网站数据、cache、auth cache、暂存上传和当前下载列表，但会刻意保留持久化脱敏审计日志。
- 审计日志位于 Electron `userData/browser/audit`，达到 100 MB 时轮转，并在 store 初始化或轮转时清理超过 30 天的轮转文件。手动处理或删除前请阅读[浏览器与审计日志指南](browser.zh-CN.md)。

## 常用命令

| 命令 | 用途 |
|:--|:--|
| `npm run dev` | 启动 Electron 开发构建 |
| `npm test` | 运行 Node 测试套件 |
| `npm run typecheck` | 对 main/preload 和渲染进程项目做类型检查 |
| `npm run build` | 构建原生 helper、类型检查并生成生产环境构建产物 |
| `npm run preview` | 启动构建好的应用，验证生产环境路径 |

提交改动之前，请先跑测试、typecheck 和 build，然后在真实的 Electron 窗口里检查受影响的流程。

## 本地状态的存储位置

设置由主进程中的 `SettingsStore` 校验并持久化。实时终端状态和有上限的滚动缓冲区归 `TerminalManager` 管理；渲染进程并不是 PTY 历史记录的可信来源。浏览器网站数据留在持久化 Chromium partition 中，安全的标签恢复状态位于 `userData/browser-state.json`，脱敏 hash-chain 审计位于 `userData/browser/audit`。服务商凭据只留在已安装的 CLI 和可信的主进程适配器里，绝不通过 IPC 传出。

确切的边界见[架构](ARCHITECTURE.zh-CN.md)文档，交互与视觉规则见 [UI 契约](UI_CONTRACT.zh-CN.md)。

## 故障排查

### `node-pty` 编译失败

安装操作系统所需的编译器、Python 和平台头文件，然后重新运行 `npm install`。不要用假终端替代原生 PTY：真实的本地进程是本产品的核心约束。

### 服务商能启动，但限额不可用

能用的 CLI 会话和可读取的订阅限额 API 是两项独立的能力。先查看 CanvasTTY 给出的原因；只有身份验证失败时才需要重新登录。即使 CLI 正常运行，Claude 的限额 API 也可能返回 HTTP 429。此时 CanvasTTY 会等待服务器指定的重试时间；如果服务器未提供有效时间，则等待五分钟，并将已有的上次读数标为过期。刷新 CLI 列表不会跳过等待。有些账户类型本身不提供订阅配额窗口；此时界面必须显示为不可用，而不是 `0%`。

### 终端已打开，却没有标记为“工作中”

CanvasTTY 根据 provider lifecycle hook，为 Codex、Claude Code、Qwen Code、Kimi Code、OpenCode、Hermes 与 Grok Build 显示实时 `idle`、`working`、`needs_approval`。智能体在首个机器可读 signal 前保持 `unavailable`；PTY 存在和终端文本本身都不构成活动遥测。

下一步：阅读[浏览器与审计日志](browser.zh-CN.md)、[编写小组件](widget-authoring.zh-CN.md)，或查看[指标与遥测](metrics-and-telemetry.zh-CN.md)。
