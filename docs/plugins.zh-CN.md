# 运行时插件

[English](plugins.md) · [Русский](plugins.ru.md) · [简体中文](plugins.zh-CN.md) · [文档首页](README.zh-CN.md)

CanvasTTY 运行时插件从 HTTPS GitHub 仓库安装。插件可以提供 sandboxed web contribution，也可以声明可选的 agent hook 脚本和长期运行的服务。Web contribution 不具备 Node.js 能力。Hook 和服务属于原生代码：每个 hook 在用户于 **设置 → Agents → Hooks** 中单独确认信任前始终关闭，插件的服务在 **设置 → Agents → Extension native code** 中确认前不会运行。

## 信任模型

安装插件等同于允许第三方浏览器代码在本地运行。CanvasTTY 会压缩这一信任面，但无法让未知代码变得可信：

- CanvasTTY 只下载 GitHub 仓库根 URL 对应默认分支的 tar 归档，安装或更新期间绝不运行 `npm install`、构建钩子、原生模块或仓库脚本。
- 包内不得包含符号链接，且限制为 500 个文件或目录 / 25 MB。单个对外提供的资源限制为 8 MB。
- 插件 frame 拥有不透明的 sandbox origin，无法访问父级 DOM，没有 `window.canvasTTY`，也没有 Node.js API。
- 独立窗口的 preload 不暴露任何 Node 原语。它通过一个带身份校验的 IPC handler 转发同样的 SDK 消息。
- 每个特权 SDK 方法都由 manifest 中的权限把关。权限会在用户确认安装之前展示。
- Sandboxed web contribution 不会收到服务商凭据、PTY 缓冲区、工作目录、原始服务商响应或文件系统访问权限。
- 禁用或卸载插件会立即停止提供其资源，并关闭其独立窗口。
- 服务按插件整体遵循与 hook 相同的规则：安装不会启动服务，更新、更换 module、禁用插件或 entry 文件被修改都会撤销确认。服务在进程外运行；插件代码不会在 CanvasTTY 主进程中执行。
- Agent hook 不会随安装自动启用。启用后，该脚本等同于原生应用：它会接收 agent 事件 payload、以当前用户权限运行，并可能访问该用户可读的配置或凭据；更新插件、更换 module 或禁用插件都会撤销全部 hook 信任。

CanvasTTY 不嵌入任意的原生操作系统窗口。`window` 贡献是一个由 CanvasTTY 持有的 sandboxed `BrowserWindow`。原生 reparenting 在 Wayland、macOS、Windows、不同 DPI 模式、弹窗和 GPU surface 之间既不可移植也不可靠。

## 包结构

仓库根目录必须包含 `canvastty.plugin.json`。Entry 是相对的静态 HTML 文件；内联脚本会被插件的 Content Security Policy 拦截。

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

不包含特权 hook 的 sandboxed web surface 端到端示例见 [`examples/plugins/studio-kit`](../examples/plugins/studio-kit)。调用自身服务的最小 canvas 应用示例见 [`examples/plugins/service-echo`](../examples/plugins/service-echo)。启动贡献者示例见 [`examples/plugins/launch-env`](../examples/plugins/launch-env)，启动策略示例见 [`examples/plugins/yolo-guard`](../examples/plugins/yolo-guard)。会话环境（git worktree）示例见 [`examples/plugins/env-worktree`](../examples/plugins/env-worktree)。决策服务示例见 [`examples/plugins/deny-rm`](../examples/plugins/deny-rm)。agent 工具、卡片动作和会话事件示例见 [`examples/plugins/collect-demo`](../examples/plugins/collect-demo)。
编辑器工具可以使用 [manifest JSON Schema](canvastty-plugin.schema.json) 和 [SDK TypeScript 声明](plugin-api.d.ts)。

## Manifest v1

```json
{
  "apiVersion": 1,
  "id": "com.example.studio-kit",
  "name": "Studio Kit",
  "version": "1.0.0",
  "description": "Small CanvasTTY surfaces backed by real host state.",
  "permissions": ["storage", "secrets", "sessions:read", "launcher:open"],
  "hooks": [
    {
      "id": "audit",
      "title": "本地审计日志",
      "description": "将选定的 agent 生命周期事件写入用户管理的日志。",
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

插件和 contribution 的 ID 是稳定的持久化键，发布后不要重命名。插件版本使用语义化版本文本。可选的 `settingsContribution` 引用一个 `canvas-app`，CanvasTTY 会在扩展菜单中为它显示独立的 **Settings** 操作。每个已安装的 `home-widget` 也会与内置小组件一起显示在 **设置 → 外观 → HOME 组成** 中，并在那里添加或移除。`canvas-app` 和 `window` 可以声明可选的 `minSize`；它不能大于 `defaultSize`，最小可设为 240 × 140 px。旧 manifest 继续使用宿主的 320 × 220 px 最小值。HOME 以宽敞的 16 × 12 逻辑网格起步，同时保留原有的 12 × 8 构图。编辑器可以把可见边界扩展到 48 × 36，且不缩小单元格尺寸；需要时添加小组件会自动扩展边界。画布应用使用世界坐标像素，并参与与终端卡片相同的吸附系统。

`platforms` 为可选字段；一旦声明，就必须包含 `"canvastty"`，否则直接安装或更新会被拒绝。`minHostVersion` 仅用于提示：展示页会标记需要更高宿主版本的插件，但不会阻止安装；较旧的最低版本不会被视为不兼容。

### 可选模块

模块化 manifest 可声明经过完整性校验的 coreFiles 和最多 16 个可选 modules。每个文件都包含 path、精确的 bytes 大小和 SHA-256。CanvasTTY 在预览时只下载 manifest，显示模块复选框、大小和权限，然后仅下载核心文件与用户选择的模块。之后更改选择时会原子替换插件包，并删除已取消模块的文件。Contribution 可以通过 module 字段在模块未安装时隐藏。

模块文件的完整性（精确字节数和 SHA-256 摘要）会根据插件 manifest 中声明的哈希进行校验，而 manifest 本身通过 TLS 从 GitHub 获取，没有单独的签名。因此信任锚点是插件的 GitHub 仓库：被入侵的仓库可以发布带有匹配哈希的新 manifest。

### 可选 Agent Hooks

`hooks` 可声明最多 16 个 `.js`、`.mjs` 或 `.cjs` entry。每个 hook 包含稳定的 `id`、`title`、`entry`、`providers` 与语义 `events`（`session-start`、`prompt-submit`、`permission-request`、`permission-result`、`after-tool`、`stop`、`session-end`）。不支持某个语义事件的 provider 会跳过该事件。在 modular plugin 中，hook entry 必须由对应的可选 module 完整性清单声明；没有 module 时则由 `coreFiles` 声明。Non-modular 包只需在经过校验的 entry path 上包含该文件。

Hook-only 插件使用空的 `contributions` 与非空的 `hooks`。安装只复制并验证文件；用户检查源码和仓库后，仍须在 **设置 → Agents → Hooks** 中单独确认信任。CanvasTTY 在每次调用前都会检查 host-owned registry，因此关闭 hook 会立即阻止后续调用。Provider 自带的 hook review 仍然有效；例如 Codex 可能还会要求用户通过其 `/hooks` 检查 CanvasTTY bridge，CanvasTTY 不会使用全局 trust-bypass 参数绕过该保护。

脚本在独立进程中运行，并通过 stdin 接收包含 `apiVersion`、`pluginId`、`hookId`、`terminalSessionId`、`provider`、`event`、`providerEvent` 与 `payload` 的 JSON。Stdout/stderr 会被丢弃，执行时间受限，CanvasTTY 内部 capability token 会从子进程环境中移除。这不是 sandbox：脚本仍以当前用户权限读写文件或启动进程。

### 服务（apiVersion 2）

`"apiVersion": 2` 的 manifest 最多可声明 8 个 `services`。版本 1 的 manifest 仍然有效；只有 `services` 需要版本 2。

```json
"services": [
  { "id": "echo", "title": "Echo", "description": "回显请求。", "entry": "services/echo.mjs" }
]
```

服务包含稳定的 `id`、`title`、可选的 `description` 和 `module`，以及以 `.js`、`.mjs` 或 `.cjs` 结尾的 `entry`。entry 必须是打包好的单文件（例如用 esbuild 构建）：安装器不执行构建也不运行 `npm install`，服务无法使用 Electron 和 node-pty。在模块化插件中，entry 必须像 hook entry 一样由其 `module`（或 `coreFiles`）声明完整性。用户信任插件的原生代码时，CanvasTTY 记录 entry 的 SHA-256，并在每次启动前重新校验；被修改的文件不会运行，信任会在下次启动时撤销。

生命周期：已启用且受信任插件的每个服务都作为独立进程运行（`process.execPath` 加 `ELECTRON_RUN_AS_NODE=1`），工作目录为插件目录。环境变量最小化：`PATH`、`HOME`、用户、shell、语言区域、临时目录与 XDG 目录、`SSH_AUTH_SOCK` 以及 Windows 系统目录；provider 密钥、令牌、`NODE_OPTIONS` 和所有 `CANVASTTY_*` 变量都会被移除。意外退出的服务会在 1、2、4、8、16 秒后重启；10 分钟内意外退出超过 5 次后保持失败状态，直到重新确认信任。禁用、卸载、更新、更换模块、撤销信任或退出 CanvasTTY 都会停止服务：先发送 `canvastty.shutdown` 通知并关闭 stdin，然后 `SIGTERM`，最后 `SIGKILL`。服务会获得 `<userData>/plugin-data/<pluginId>` 目录，卸载时删除。stderr、协议之外的 stdout、`log` 调用和生命周期事件写入每个插件的有界日志（最近 300 条），显示在 **设置 → Agents → Extension native code**。

协议：通过 stdin/stdout 的逐行 JSON-RPC 2.0，每个方向单条消息最多 1 MB。更大的宿主请求会被拒绝，服务输出的超长行会被丢弃并记录。宿主首先发送 `canvastty.initialize` 通知，参数为 `{ apiVersion: 2, pluginId, serviceId, dataDir, locale, hostVersion }`。

应用启动时，只有在服务可能调用的所有宿主 API（`sessions.*`、`cards.setBadge`、`secrets.get` 等）就绪之后、恢复已保存卡片之前，才会启动服务：服务收到 `canvastty.initialize` 后即可调用它们，订阅会话事件的服务会以事件或 `sessions.subscribe` 快照的形式收到恢复的卡片。

来自插件自身界面的请求使用界面选择的方法和参数；以 `canvastty.` 开头的方法名保留给宿主。用 `{"jsonrpc":"2.0","id":…,"result":…}` 或 `{"jsonrpc":"2.0","id":…,"error":{"code":-32000,"message":"…"}}` 应答。15 秒内未应答的请求以超时错误结束；服务已停止、正在重启或失败时的请求同样返回错误；每个服务同时最多等待 64 个请求。

服务可以回调以下宿主 API（后续扩展点在此基础上扩展；其他方法返回错误 `-32601`）：

| 方法 | 类型 | 条件 | 结果 |
|:--|:--|:--|:--|
| `log` `{ level?: "info" \| "warn" \| "error", message }` | 请求或通知 | 无 | 写入插件日志 |
| `storage.get` `{ key }` | 请求 | `storage` 权限 | 与 `host.storage.get` 相同的隔离 64 KB 存储 |
| `storage.set` `{ key, value }` | 请求 | `storage` 权限 | 写入并通知插件界面 |
| `event` `{ event, data }` | 通知 | 无 | 通过 `host.service.onEvent` 发送给该插件的活动界面 |
| `redaction.register` `{ values }` | 请求 | 无 | 最多 32 个字符串（每个最多 4096 字符，8 字符以上才生效），CanvasTTY 会在一个 agent 读取另一个 agent 的所有文本中遮蔽它们；只保存在内存中 |
| `secrets.get` `{ key }` | 请求 | `secrets` 权限 | 插件自己的机密（与 `host.secrets` 同一存储），或 `null`。之后该值会像 `redaction.register` 的值一样被遮蔽。用于服务自身需要的密钥（例如它调用的模型的 API 密钥）；绝不要把它发回界面 |
| `sessions.subscribe` / `sessions.list` / `sessions.unsubscribe` | 请求 | `sessions:events` | 卡片事件和当前打开的卡片（见“会话事件”） |
| `sessions.create` | 请求 | `sessions:launch` | 启动一张归插件所有的卡片 |
| `sessions.send` / `sessions.stop` | 请求 | `sessions:control` | 仅限该插件启动的卡片 |
| `cards.setBadge` `{ sessionId, badge }` | 请求 | `cards:decorate` | 在任意卡片上显示简短的纯文本标记（见“卡片标记与动作”） |

宿主把每次调用绑定到服务自身的插件：服务无法指定其他插件或读取其他插件的机密，只能通过下面的 `sessions:*` 权限访问会话。示例 [`service-echo`](../examples/plugins/service-echo) 在其页面用 `host.secrets.set` 保存令牌，其服务用 `secrets.get` 读取，只回答是否已设置。

UI 通道：sandboxed 界面只能调用自身插件的服务：

```js
const reply = await host.service.request("echo", "echo", { text: "hi" });
host.service.onEvent(({ serviceId, event, data }) => { /* … */ });
```

插件声明服务即隐含该权限。宿主只转发不透明的 JSON，从不附加凭据。对未运行（尚未信任、已禁用、重启中、失败）的服务的请求或超时请求会返回错误。

### 启动贡献者（`launch:contribute`）

每个插件最多一个服务可以声明 `launch` 块。插件的原生代码被信任后，其字段出现在智能体启动对话框的 **Advanced（高级）** 部分；用户通过 **Use _插件名_** 为一次启动启用该插件并填写字段。只有选择了该插件的启动，以及这些卡片的重启和恢复，才会询问插件。

```json
"permissions": ["launch:contribute"],
"services": [{
  "id": "launcher", "title": "Launch env", "entry": "services/launcher.mjs",
  "launch": {
    "appliesTo": ["claude"],
    "fields": [
      { "key": "enabled", "label": "Add the variable", "kind": "boolean", "default": true },
      { "key": "greeting", "label": "Value", "kind": "text", "default": "hello", "maxLength": 60 },
      { "key": "mode", "label": "Mode", "kind": "select", "default": "plain",
        "options": [{ "value": "plain", "label": "Plain" }, { "value": "loud", "label": "Loud" }] }
    ]
  }
}]
```

最多 8 个字段；`kind` 为 `boolean`、`select`（1–16 个选项）或 `text`（最多 200 个字符或 `maxLength`）。`appliesTo` 列出适用的智能体服务商，省略表示所有智能体。所选值按字段校验，保存在卡片的会话记录中（每个插件最多 4 KB），并在重启和恢复时复用。它们不是机密：密钥应放在插件的 `secrets` 中，而不是字段里。

带 `"optionsFrom": "service"` 的 `select` 还会列出服务提供的选项，例如插件自己的账户。启动器打开时，CanvasTTY 向服务发送 `canvastty.launch.options` `{ provider, fields: [键] }`，最多等待 3 秒；回答 `{ "<键>": [{ value, label }] }` 在声明的选项之后为每个字段追加最多 64 个选项（声明的选项仍然必需，服务未回答时启动器只显示它们）。由于此类列表可能在卡片保存后变化，其值接受为不含控制字符、最多 200 个字符的任意文本，`canvastty.launch.prepare` 必须检查该值，并拒绝已不存在的选项。

编排器可以把同样的值作为 `launchOptions`（`{ "<pluginId>": { "<键>": 值 } }`）传给 `spawn_agent`，校验方式与启动器相同；插件工具可以给出这些值（例如它选定的账户）。当子智能体的启动在等待插件（启动选项、启动策略、环境）时，`spawn_agent` 只在其 `prompt` 送达已启动的智能体后才应答，`send_to_agent` 同样等待。启动被拒绝、失败或取消时，调用以原因和会话 id 失败（卡片保留）；文本被丢弃，不会留给之后的重启。对这样的卡片，控制 CLI 应答 `NOT_READY`。

智能体启动前，宿主向服务发送 `canvastty.launch.prepare` 请求（界面无法发送）：

```json
{"sessionId":"…","provider":"claude","profile":"normal","role":"agent","cwd":"/project","restoring":false,"resume":false,"options":{"enabled":true,"greeting":"hello","mode":"plain"},"chosen":true,"environment":null}
```

应答为 `null`（不添加任何内容）或包含以下任意键的对象：

| 键 | 限制 | 作用 |
|:--|:--|:--|
| `env` `{ NAME: value }` | 32 个名称，每个值 8 KB | 加入智能体的环境变量 |
| `secretEnv` `{ NAME: secretKey }` | 16 个名称；需要 `secrets` | 宿主在主进程中读取插件自身的机密并设置。该值不会到达服务或任何 UI，并在其他智能体和控制 CLI 从该卡片读取的文本中（observe、result、screen、失败详情）显示为 `<redacted:secret>` |
| `args` `[string]` | 32 个，每个 1024 字符，无控制字符 | 追加在 CanvasTTY 自身参数之后、会话选择之前 |
| `files` `[{ relPath, content }]` | 16 个文件，256 KB，普通相对路径 | 写入本次运行的私有文件夹，进程退出时删除；`env` 值和 `args` 中的 `{launchFiles}` 替换为该文件夹 |
| `thirdPartyModel` `true` | — | 智能体运行在非其供应商的模型上（API 或 Ollama 账户）。此次启动中 `auto` 配置档改为“仅接受编辑”，卡片会显示这一点。启动策略也可以设置它：该标记只会让启动更严格 |
| `refuse` `{ reason }` | 240 字符 | 卡片不启动并显示原因 |

宿主强制执行、从不跳过的规则：

- 多个被选插件并行询问，并按插件 id 顺序合并。两个插件设置同一名称，或插件设置 CanvasTTY 为此次启动设置的名称，会拒绝启动并指明它们。以 `CANVASTTY_`、`ELECTRON_`、`DYLD_`、`LD_` 开头的名称以及 `NODE_OPTIONS`、`PATH`、`TERM`、`COLORTERM` 为保留名称。
- 绕过审批或选择会话的参数（各服务商的 YOLO 标志、`--permission-mode`、`--sandbox`、`--resume`、`--continue`、`--session` 等）会被拒绝：配置档由用户决定，恢复规则由核心决定。这不是沙箱：受信任的原生代码本来就以你的身份运行。
- Claude Code 只应用最后一个 `--settings`，因此插件的内联 `--settings` JSON 会合并进 CanvasTTY 自己的 JSON（`env` 等对象按键合并，hook 列表追加）；若其中设置了 `permissions`、`hooks`、`disableAllHooks`、`sandbox`、`defaultMode` 或 `apiKeyHelper`，启动会被拒绝。`--settings <json>` 与 `--settings=<json>` 两种形式都会检查；设置文件只接受贡献自身的启动文件（`{launchFiles}/…`），CanvasTTY 读取并以同样方式检查后以内联 JSON 传递；其他文件路径一律拒绝。`--bare`、`--safe-mode`、`--allowedTools`、`--permission-prompt-tool` 和 `--permission-prompts` 也只由 CanvasTTY 传递。
- 5 秒内无应答、出错、应答无效、缺少机密，或插件被禁用、删除或不再受信任，都会拒绝启动并在卡片上显示原因。智能体绝不会在缺少用户所选贡献的情况下启动。插件不可用的恢复卡片以停止状态返回并显示该原因，记录保留到插件恢复或卡片被关闭。
- 普通终端不接受启动选项。

**启动配置档。** `profile` 为 `normal`（默认）、`yolo` 或 `auto`。`auto` 仅适用于 CLI 自带自动模式的智能体，均按各 CLI 的 `--help` 核实：Codex `--approve-for-me`（其自身审查，运行于 `workspace-write` 沙箱），Claude Code `--permission-mode auto` 及其沙箱（`{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":false}}` 合并进唯一的 `--settings`），以及 Grok `--permission-mode auto`（不依赖 Grok 沙箱）。基础保护和决策服务仍在其前面作答（Codex、Claude Code）。只要任一贡献者回答 `thirdPartyModel: true`，`auto` 就改为同一沙箱中 CLI 的“仅接受编辑”模式（Codex `--sandbox workspace-write --ask-for-approval on-request`，Claude Code 和 Grok `--permission-mode acceptEdits`）：原生审查者将是同一个模型，而弱模型自己的分类器不是安全边界。

**受信任文件夹。** 在本机运行、其文件夹是用户为其顶层智能体选择的文件夹（或位于其中）的子智能体，会收到 `"trustedFolder"`：该文件夹的真实路径。CanvasTTY 会以仅限此次运行的 `-c projects=…` 覆盖替它回答 Codex 的 “Trust this folder?”（不会写入 `~/.codex`）；自行保存智能体配置目录的插件（例如账户的 `CLAUDE_CONFIG_DIR`）可以在那里将该文件夹标记为受信任。Codex 还会获得对 CanvasTTY 自己添加的 hook 的本次运行信任（`-c hooks.state=…`），因此不会停在 “Hooks need review”；项目或用户自己的 hook 仍会询问。插件不能传递 `-c hooks…`。

**启动策略。** 设置 `"policy": true` 后，在该服务适用的智能体每次启动（创建、重启、恢复）而用户没有选择它时，也会以 `"chosen": false` 和空的 `options` 询问它。这样的回答只能是 `null` 或 `refuse`；其他任何回答、5 秒内无回答或出错都会拒绝启动，因此策略绝不会因失败而放行。每个 `canvastty.launch.prepare` 还带有 `"environment"`：卡片环境的 `{ pluginId, kind }`，在本机运行时为 `null`。没有 `fields` 的策略不会显示在启动器中。撤销插件的原生代码信任即移除其策略。

```json
"launch": { "policy": true, "fields": [] }
```

完整示例见 [`examples/plugins/launch-env`](../examples/plugins/launch-env)（选项）和 [`examples/plugins/yolo-guard`](../examples/plugins/yolo-guard)（拒绝环境之外的 YOLO 的策略）。

### 会话环境（`environment:provide`）

环境是卡片运行的位置：git worktree、容器或远程主机。每个插件最多可以在 `environments` 中列出 8 种类型，可以放在一个服务中，也可以分布在多个服务中（例如每个模块一个服务）；每种类型在插件内唯一，由列出它的服务应答。信任插件原生代码后，启动器的 **Advanced** 部分会显示 **Where**（默认 **This computer**），列出适用于该服务商的类型及其可选 `fields`（种类和限制与启动字段相同）。只要有类型适用于终端，**Open terminal** 就会打开同一个启动器（文件夹和 Where），而不是立即打开终端。

```json
"permissions": ["environment:provide"],
"services": [{
  "id": "worktree", "title": "Git worktree", "entry": "services/worktree.mjs",
  "environments": [{
    "kind": "worktree", "label": "Git worktree",
    "description": "A branch in its own folder",
    "appliesTo": ["terminal", "claude"],
    "fields": [{ "key": "branch", "label": "Branch", "kind": "text", "default": "", "maxLength": 80 }]
  }]
}]
```

CanvasTTY 负责卡片、PTY、保存的记录和恢复顺序；服务回答五个只有宿主能发送的请求：

| 请求 | 参数 | 应答 | 时限 |
|:--|:--|:--|:--|
| `canvastty.environment.prepare` | `sessionId, kind, provider, cwd, options` | `{ ref, label, cwd? }` 或 `{ refuse: { reason } }`。`ref` 是不超过 4 KB 的不透明 JSON，随卡片保存；`label`（80 字符）是徽标；`cwd`（已存在的绝对路径文件夹）成为卡片的文件夹 | 15 秒 |
| `canvastty.environment.wrap` | `sessionId, kind, ref, provider, command, args, env, secretEnvNames, cwd` | `{ command, args, env?, secretEnv?, cwd? }` 或 `{ refuse }` | 5 秒 |
| `canvastty.environment.resume` | `sessionId, kind, ref` | `{ ok: true }` 或 `{ stopped: { reason } }` | 10 秒 |
| `canvastty.environment.release` | `sessionId, kind, ref, keepData, reason`（`closed` 或 `quit`） | 忽略 | 10 秒 |
| `canvastty.environment.describe` | `sessionId, kind, ref` | `{ label, detail? }`，用于卡片徽标及其提示 | 3 秒 |

- `prepare` 只在卡片首次启动时调用一次。`wrap` 在每次启动（创建、重启、恢复）前调用，把宿主原本要启动的命令变成在环境中运行的命令，例如 `ssh -tt host …`、`docker exec -it …`，或在另一个文件夹中运行同一程序。PTY 仍由宿主通过 node-pty 创建，因此回滚、状态和编排照常工作。
- `wrap` 的输出会被检查：`command` 必须是可执行文件的绝对路径，或由宿主在 `PATH` 中解析的纯程序名；命令行、相对路径或 shell 语法会被拒绝，任何内容都不经过 shell 运行。`args` 是数组（256 项，每项 8 KB，不含 NUL）。`env` 和 `secretEnv` 遵循启动贡献者的规则：保留名称以及 CanvasTTY 或启动选项已为此次启动设置的名称会被拒绝。`secretEnv` 的值来自插件自己的机密（需要 `secrets`），并像启动机密一样被遮蔽。
- `wrap` 收到此次启动自身的变量（来自 CanvasTTY 和所选启动选项），不含保留的 `CANVASTTY_*` 名称，也不含机密值；`secretEnvNames` 列出进程将从宿主获得值的名称，包装器可以按名称转发它们（`docker exec -e NAME`）。
- 恢复时先恢复所有保存的环境，再先启动父卡片、后启动子卡片。如果插件被禁用、删除或不受信任，或 `resume` 应答 `stopped`，卡片以停止状态返回并显示原因，记录保留；重启会再次调用 `resume`。卡片绝不会改为在本地启动，超时或错误会拒绝启动，不会回退。
- 在 `prepare` 成功之前，卡片的保存记录保留启动器中的选择（插件、种类、选项），而不是 ref。如果应用在 `prepare` 进行时退出，卡片以停止状态返回并显示该原因，在用户重启它之前不会准备或启动任何东西；重启会用相同的选项重新准备。`prepare` 失败时同样保留选择。在卡片关闭或重启之后、或应用开始退出之后才到达的 `prepare` 回答不会被使用或保存：只要宿主仍在运行，就立即以 `keepData: false` 和 `reason: "closed"` 调用 `release`。
- 关闭环境中的卡片时只询问一次“Keep environment data?”，然后带着答案调用 `release`。退出应用不会释放任何环境（环境随卡片一起恢复）；关闭保存时，退出会以 `keepData: true` 和 `reason: "quit"` 调用 `release`，以便停止计算。插件不保存自己的会话列表，也没有恢复逻辑。

完整示例见 [`examples/plugins/env-worktree`](../examples/plugins/env-worktree)：`prepare` 在插件数据目录下的文件夹中运行 `git worktree add`，`wrap` 设置文件夹，`resume` 检查它仍然存在，`describe` 显示当前分支，`release` 删除该 worktree（以及它创建的分支），除非你选择保留。

### 决策 hook（`decision:provide`）

在本地 agent 运行 shell 命令或写入文件之前，CanvasTTY 可以询问插件：拒绝、询问用户或允许。每个插件最多一个服务可以声明 `decide`：

```json
"permissions": ["decision:provide"],
"services": [{
  "id": "guard", "title": "rm -rf guard", "entry": "services/guard.mjs",
  "decide": { "events": ["pre-tool"], "appliesTo": ["claude", "codex"], "timeoutMs": 3000 }
}]
```

`pre-tool` 指每一次 shell 和写文件的工具调用，在运行之前，并且适用于所有权限模式（包括 YOLO）：Claude Code、Codex 和 Qwen Code 通过它们的 `PreToolUse` hook，OpenCode 通过 CanvasTTY 的 OpenCode 插件（`tool.execute.before`）。`appliesTo` 限定 agent；省略时为全部四个。主机发送 `canvastty.decide`（仅主机可发），最多等待 `timeoutMs`（1000 到 60000；省略时 3000）。agent 的调用会等待同样长的时间，所以只有在回答确实需要时才申请更长时间（例如让本地模型阅读命令）；CanvasTTY 在卡片启动时按适用服务中最长的预算设置该卡片的 hook，之后才被信任的服务所得时间不超过卡片允许的范围。请求以 `budgetMs` 携带该预算：

```ts
interface DecisionRequest {
  event: "pre-tool";
  sessionId: string; provider: string; role: "agent" | "orchestrator" | "subagent";
  cwd: string;                 // 卡片的工作文件夹
  agentCwd: string | null;     // agent 当前所在文件夹（CLI 报告时）
  tool: { name: string; kind: "shell" | "edit" | "other"; command: string | null; paths: string[] };
  input: unknown;              // agent 发送的原始工具输入；超过 40 KB 时为 null（truncated）
  truncated: boolean;
  budgetMs: number;            // CanvasTTY 等待这个回答的时长
}
// 回答：{ verdict: "deny" | "ask" | "allow", reason?: string }，或 null 表示没有意见
```

回答按以下顺序合并：

1. 先运行**基础保护**（见下文）；它的拒绝是最终结果，不再询问插件。
2. 任何插件的 `deny` 优先。模型读到 `CanvasTTY plugin "<name>" blocked this tool call (<reason>)`，所以请在原因中写明应当改做什么。
3. 否则任何 `ask`：无论权限模式如何，Claude Code 都会就此调用询问用户。超时、错误、服务已停止或无法读取的回答都算 `ask`，绝不算允许。
4. 否则只有用户授权可以允许的插件，其 `allow` 才算数：在**设置 → Agents → Extension native code**中该插件下的第二个确认**May allow agent actions**，随原生代码信任一起撤销。之后 Claude Code 不经自身提示直接运行该调用；OpenCode 对该调用的询问以 `once` 回答。输入过大、无法完整发送时，允许永不生效。
5. 否则什么都不做：agent 照常继续，就像没有 CanvasTTY 一样。

Codex 和 Qwen Code 只接受此 hook 的拒绝：对它们来说，`ask` 和 `allow` 把决定留给 CLI 自身的权限模式。远程和容器会话不在覆盖范围内（它们的 hook 无法连回本机）。只有在基础保护开启或有决策插件适用时启动的 agent 才会安装此 hook，因此之后才信任的插件只对新卡片生效。hook 崩溃时 CLI 会照常运行该调用，所以这是一道防护，而不是沙箱。

完整示例见 [`examples/plugins/deny-rm`](../examples/plugins/deny-rm)：它拒绝对工作文件夹顶层任何内容执行 `rm -rf`（`rm -rf *`、`rm -rf src`），对其他一切不表态。它声明了 `timeoutMs: 5000` 以展示该字段；它会立即回答。

### Agent 工具（`tools:agents`）

服务最多可以向 agent 提供 16 个 `tools`。它们以 `<pluginId>__<name>` 的名字（插件 id 中的点写作 `_`，例如 `com.example.tools` + `lookup` 即 `com_example_tools__lookup`；Anthropic 和 OpenAI 的工具名只允许字母、数字、`_` 和 `-`，最多 64 个字符，更长的名字保留 id 开头并加上一个短哈希）出现在 `canvastty_agents` MCP 服务器中，与 CanvasTTY 自身的编排工具并列，并被视为 CanvasTTY 自己的工具：基础保护不检查它们（它只检查 shell 和文件写入）。

```json
"permissions": ["tools:agents"],
"services": [{
  "id": "collect", "title": "Diff stat", "entry": "services/collect.mjs",
  "tools": [{
    "name": "diffstat",
    "description": "你自己文件夹或某个子 agent 文件夹的 git diff --stat。",
    "inputSchema": { "type": "object", "properties": { "sessionId": { "type": "string" } }, "additionalProperties": false },
    "roles": ["orchestrator"]
  }]
}]
```

- `name` 为 `[a-z][a-z0-9_]{0,39}`，在插件内唯一；`inputSchema` 是顶层为 `type: "object"` 的 JSON Schema（最多 8 KB）；`roles` 列出 `orchestrator`、`agent` 和/或 `subagent`。
- 只有角色被列出的会话能看到工具，而且仅在插件原生代码受信任且服务运行时。列表在 agent 启动时读取，因此之后才信任的插件只出现在新卡片中。编排器照常获得桥接；`agent` 或 `subagent` 卡片只有在某个插件工具列出其角色时才获得桥接，此时只看到插件工具，永远看不到核心编排工具。插件工具可用于 Claude Code、Codex、Qwen Code 和 OpenCode；Kimi 和 Hermes 在所有卡片间共用一个配置文件，只保留核心工具。
- 调用以 `canvastty.tools.call`（仅宿主可发）到达服务，参数为 `{ tool, callerSessionId, caller, input }`，其中 `caller` 是调用方卡片的摘要（与会话事件相同的结构）。宿主先检查 `input`：必须是对象、必需键存在、顶层属性类型正确，`additionalProperties` 为 `false` 时不允许多余键；更深的检查由插件负责。
- 回答 `{ content, isError? }`：`content` 是文本或任意 JSON（以 JSON 文本发送）。回答经过密钥遮蔽注册表处理并截断到 32K 字符；15 s 内未回答、出错或服务已停止时，agent 得到错误结果，仅此而已。宿主只担保调用方 id：操作其他会话的工具必须自己检查（示例只接受调用方自己的子 agent）。

### 会话事件与插件拥有的卡片（`sessions:*`）

具有 `sessions:events` 的服务调用 `sessions.subscribe` `{ ownedOnly? }`（每次启动后都要重新调用）。回答列出当前打开的卡片；之后宿主发送 `canvastty.sessions.event` 通知：

```ts
interface PluginSessionEvent {
  type: "created" | "restored" | "status" | "exited" | "closed";
  owned: boolean;              // 该卡片由本插件启动
  session: {
    id: string; provider: string; role: "agent" | "orchestrator" | "subagent"; parentSessionId?: string;
    title: string; status: string; exitCode: number | null; startedAt: number;
    cwd: string;               // 用户选择的文件夹
    workingDirectory: string;  // 实际运行的位置（worktree 环境会移动它）
    environment?: { pluginId: string; kind: string; label: string; ref: unknown };
  };
  screen?: string;             // 仅在具有 sessions:read-screen 时，出现在 status 和 exited 中
}
```

事件只包含元数据。具有 `sessions:read-screen`（同意文本说明这是私人数据）时，`status` 和 `exited` 事件会附带卡片输出的最后 4000 个字符，为纯文本并经过密钥遮蔽。`sessions.list` 按需返回同样的摘要。

控制方式与 agent-control 网关相同：服务是一个控制者，只拥有它创建的卡片。所有权随卡片的会话记录保存，因此恢复后的卡片仍属于启动它的插件。

| 请求 | 条件 | 效果 |
|:--|:--|:--|
| `sessions.create` `{ provider, cwd, profile?, title?, launchOptions?, environment? }` | `sessions:launch` | 通过常规启动流程启动一张 `agent` 卡片（包括启动选项和环境；拒绝原因显示在卡片上）。卡片可见且从不抢占焦点。每个插件最多 16 张。回答 `{ sessionId }` |
| `sessions.send` `{ sessionId, text, submit? }` | `sessions:control` | 向本插件启动的卡片输入文本（除非 `submit: false`，否则带回车）。启动仍由插件准备中的卡片在启动开始后收到文本；启动未成功时 `sent` 为 false（文本被丢弃） |
| `sessions.stop` `{ sessionId }` | `sessions:control` | 关闭本插件启动的卡片；保留其环境数据 |

他人的或未知的 id 得到相同的错误，因此插件无法探测其他卡片。没有删除操作，也没有读取屏幕的控制调用。

### 卡片标记与动作（`cards:decorate`）

具有 `cards:decorate` 的服务可以在任意卡片上设置标记，并声明最多 16 个 `cardActions`：

```json
"permissions": ["cards:decorate"],
"services": [{
  "id": "collect", "title": "Diff stat", "entry": "services/collect.mjs",
  "cardActions": [{ "id": "show-changes", "title": "Show changes", "when": { "environmentKinds": ["worktree"] } }]
}]
```

- `cards.setBadge` `{ sessionId, badge: { text, tone?, tooltip? } | null }`：`text` 最多 24 个字符，`tone` 为 `neutral`（默认）、`info`、`warn` 或 `error`，`tooltip` 最多 200 个字符；`null` 移除该插件的标记。每张卡片最多 4 个插件标记。标记是纯文本，像 agent 文本一样被遮蔽，并随卡片关闭或插件信任撤销而消失。
- 动作出现在所有匹配 `when` 的卡片的选项菜单中：`providers`、`environmentKinds`（任意插件的环境；不在环境中的卡片永远不匹配）和 `roles`，均为可选；列出的每一项都必须匹配。选择动作会发送 `canvastty.cards.invoke` `{ actionId, sessionId, session }`（仅宿主可发；`session` 为上面的摘要），最多等待 15 s。回答 `{ message?, tone? }`：消息（纯文本，最多 2000 个字符，经过遮蔽）以提示的形式显示在卡片上。超时或出错时显示错误提示。
- 任何地方都没有 HTML：标记、标题和消息都按文本渲染。

完整示例见 [`examples/plugins/collect-demo`](../examples/plugins/collect-demo)：在 `worktree` 环境（来自 `env-worktree`）的卡片上，动作 **Show changes** 显示 worktree 的 `git diff --stat` 并设置“N changed”标记；工具 `collect-demo__diffstat` 为编排器提供同样的信息，针对它自己的文件夹或某个子 agent 的文件夹（插件通过会话事件得知子 agent）。

### 模型路由（`model:route`）

具有 `model:route` 并设置 `"modelRouter": true` 的服务，可以为编排者未指定 `model` 而启动的子智能体选择模型和推理强度。宿主调用 `canvastty.model.route`，传入经过遮蔽的任务文本（最多 8,000 个字符）、提供方、配置档、文件夹、请求的推理强度、任务预算，以及根据 `list_providers` 构建的 `candidates` 列表（`id`、`model`、`reasoningEffort`、`default`）。服务须在两秒内返回 `{ candidateId, reason }`。宿主只接受列表中且保留显式请求的推理强度的候选；若回答无效、出错或超时，则使用提供方默认模型，卡片会显示原因。显式指定的 `model` 不会被路由。

### 浏览器引擎（`browser:engine`）

服务可以为 agent 的后台标签页运行另一种浏览器引擎，例如以远低于 Chromium 的 CPU 和内存读取页面的无头引擎。它声明一个 `browserEngine`：

```json
"permissions": ["browser:engine"],
"services": [{
  "id": "engine", "title": "Engine", "entry": "services/engine.mjs",
  "browserEngine": { "id": "lightpanda", "title": "Lightpanda", "layout": false }
}]
```

- `id` 是 agent 传给 `browser_new_tab` 的 `engine`（`[a-z0-9][a-z0-9._-]*`，最多 64 个字符，不能是 `auto` 或 `chromium`，插件内唯一）。`layout` 表示引擎真正进行页面布局；省略时（默认）观察不使用元素几何信息，点击和悬停通过 DOM（`element.click()`）完成，因此坐标不真实的引擎也能工作。
- 对每个标签页，宿主调用 `canvastty.browserEngine.openTab` `{ engineId, tabId }`（仅宿主，20 s），并期望得到 `{ webSocketUrl }`：`127.0.0.1`、`[::1]` 或 `localhost` 上带端口的 `ws://` CDP 地址，其他地址会被拒绝。核心自己连接该地址，用 `Target.createTarget` 创建页面并通过扁平会话驱动它，每个标签页一个连接。`canvastty.browserEngine.closeTab` `{ engineId, tabId }`（通知）表示标签页已关闭，服务可在空闲时停止进程。引擎进程由服务自己启动、监管和停止。
- 策略由核心决定。只有 agent 新建的标签页可以使用引擎：`engine: "auto"`（默认）使用第一个运行中的引擎，或使用指定的引擎。用户打开的标签页和 `engine: "chromium"` 始终使用 Chromium。引擎标签页从不显示：用户或 agent 显示它时，它会先转到 Chromium。引擎不会得到 cookie、浏览器配置文件或凭据，只得到 URL；标签页从空白页开始。
- 回退：在请求截图、拖拽或下载，页面像机器人验证墙（验证标题或文字、`/cdn-cgi/challenge-platform/` 请求、403/429/503 文档），文字相对页面大小过少，引擎缺少 CDP 方法（`-32601`）或引擎断开时，标签页以相同 id 转到 Chromium（文档版本递增，旧 ref 失效）。agent 的结果带有 `notice`；针对元素 ref 的操作返回带 `details.movedToChromium` 的 `STALE_REF`。以这种方式失败的网站在本次会话剩余时间内直接使用 Chromium。如果 `openTab` 失败，标签页在 Chromium 中打开，`auto` 在一分钟内跳过该引擎。

### 基础保护与密钥遮蔽（核心）

两项安全功能内置，无需插件：

- **基础保护**（设置 → Agents → Base protection，默认开启；用户可以关闭）通过同一个 hook 拒绝：sudo 及其他提权、把下载或生成的文本管道给 shell、下载后直接运行、磁盘和格式化命令、fork 炸弹，以及在工作文件夹之外写入或删除（包括主目录、其他项目和 `/tmp`），以及删除工作文件夹本身。agent 自己的计划和记忆文件夹（`~/.claude/plans`、`~/.claude/projects/<project>/memory`，以及本次运行 `CLAUDE_CONFIG_DIR` 中的相同位置）不算"外部"。它还会拒绝任何程序（包括解释器单行命令和套接字客户端）使用 CanvasTTY 自己的私有数据（来自应用的 userData 文件夹：agent-control 令牌与描述文件、各网关的连接记录与套接字、密钥存储、账户主目录；以及临时文件夹下的控制/运行时套接字文件夹）；拒绝原因会引导模型改用 **Orchestrator** 启动和 `canvastty_agents` 工具。内置控制 CLI 可以引用它的描述文件。它只会拒绝；每条原因都告诉模型应当改做什么（写入 `/tmp` 时建议在项目内建立临时文件夹）。
- **密钥遮蔽**：CanvasTTY 从一个 agent 交给另一个 agent 的所有文本（`observe_agent`、`wait_for_agent`、`get_agent_result`，以及 control CLI 的 `screen`、`result` 和失败详情）都会被遮蔽：CanvasTTY 保存的服务商密钥、启动时的 `secretEnv` 值、服务通过 `redaction.register` 注册的值（包括被终端折行拆开的情况），以及常见密钥形式（`sk-…`、GitHub、Slack、AWS、Google、JWT、`Bearer …`、`"apiKey": "…"`、PEM 私钥、长随机串）。插件工具的回答、会话事件中的 `screen`、卡片标记和卡片动作消息也以同样方式遮蔽。

host.onStorageChange(listener) 会把 host.storage.set 的写入通知给同一插件的所有活动界面——画布卡片、HOME 小组件和独立窗口——从而避免轮询。

## 权限

| 权限 | SDK 能力 | 数据边界 |
|:--|:--|:--|
| `storage` | `storage.get`、`storage.set` | 隔离的 JSON 存储，每个插件 64 KB |
| `secrets` | `secrets.get`、`secrets.set`、`secrets.delete`；服务的 `secrets.get` | 通过 Electron `safeStorage` 加密的字符串机密；操作系统没有受保护存储时会明确失败。受信任的服务只能读取自身插件的机密 |
| `sessions:read` | `sessions.list` | 仅限 ID、服务商、标题、状态、开始时间、退出码 |
| `launch:contribute` | 服务的 `launch` 块和 `canvastty.launch.prepare` | 可以为用户以其选项启动的智能体添加环境变量、参数和文件；设置 `policy` 后可以拒绝任何智能体启动 |
| `environment:provide` | 服务的 `environments` 和 `canvastty.environment.*` | 可以为用户在其环境中启动的卡片创建运行位置，并更改它们在那里运行的命令、参数、变量和文件夹 |
| `decision:provide` | 服务的 `decide` 和 `canvastty.decide` | 在 agent 的命令和文件写入运行之前看到它们（含输入），可以拒绝或询问用户；允许需要第二次确认 |
| `tools:agents` | 服务的 `tools` 和 `canvastty.tools.call` | 向所列角色的 agent 提供工具；接收其参数和调用方卡片的摘要 |
| `sessions:events` | `sessions.subscribe`、`sessions.list` | 卡片元数据：服务商、角色、父级、标题、状态、文件夹、环境 ref；不含屏幕文本 |
| `sessions:read-screen` | status 和 exited 事件中的 `screen` | 每张卡片输出的末尾（已遮蔽）：私人数据 |
| `sessions:launch` | `sessions.create` | 通过常规启动流程启动可见的 agent 卡片 |
| `sessions:control` | `sessions.send`、`sessions.stop` | 只能向本插件启动的卡片输入文本并关闭它们 |
| `cards:decorate` | `cards.setBadge`、服务的 `cardActions`、`canvastty.cards.invoke` | 卡片上的纯文本标记及其菜单中的动作 |
| `model:route` | 服务的 `modelRouter` 与 `canvastty.model.route` | 接收未指定模型的子智能体的遮蔽任务文本和预算；只能从提供的候选中选择一个 |
| `browser:engine` | 服务的 `browserEngine` 和 `canvastty.browserEngine.*` | 接收 agent 后台标签页的 URL 并用自己的引擎打开；没有 cookie、配置文件或凭据 |
| `limits:read` | `limits.get` | 与 HOME 使用的同一个脱敏 `LimitsSnapshot` |
| `launcher:open` | `launcher.open` | 打开内置服务商的 Focus Card 或终端动作；不会绕过用户的启动选择 |
| `external:open` | `external.open` | 仅通过操作系统打开明确的 HTTP(S) URL |
| `browser:open` | `browser.open` | 仅在 CanvasTTY 内置 Browser 卡片及其共享浏览器会话中打开明确的 HTTP(S) URL，包括 localhost |
| `media:library` | `media.*` | 仅限用户选择的音乐文件夹；绝不暴露绝对路径，音频通过可 seek 的 `canvastty-media://` 流提供 |
| `playlists:read` | `playlists.list`、`playlists.read` | 读取已授权音乐文件夹中的 `.m3u`、`.m3u8` 和 `.pls`，以及其 `Playlists/` 目录下的 `.json`，每个文件最大 4 MB |
| `playlists:write` | `playlists.write` | 原子地写入一个命名播放列表到已授权文件夹的 `Playlists/` 目录，最大 4 MB |
| `network` | 浏览器 `fetch` | 在插件 CSP 中允许 HTTPS 和 loopback 请求；不附带任何 CanvasTTY 凭据 |

声明权限并不会暴露一个通用的 IPC 通道。未知的方法和权限会被拒绝。

## SDK

以外部脚本方式加载 host SDK：

```html
<script src='canvastty-plugin://host/sdk.js'></script>
<script src='./index.js'></script>
```

SDK 会创建 `window.CanvasTTYPlugin`：

```js
const host = window.CanvasTTYPlugin;

host.onContext(({ appearance, contribution }) => {
  document.documentElement.dataset.palette = appearance.palette;
  document.title = contribution.title;
});

const sessions = await host.request("sessions.list");
await host.storage.set("draft", { text: "Local to this plugin" });
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

支持的方法有 `host.getContext`、`storage.*`、`secrets.*`、`sessions.list`、`limits.get`、`launcher.open`、`canvas.open`、`external.open`、`browser.open`、`window.open`、`media.*` 和 `playlists.*`。`canvas.open` 会打开或聚焦同一插件的 `canvas-app`，并尽可能放在发起请求的画布卡片旁边。`browser.open` 仅在 workspace 创建或聚焦 Browser 卡片并完成一次导航后才会完成；它只接受规范化的 HTTP(S) URL，不接受自由文本搜索、`file:`、`data:`、`javascript:`、`about:` 或带凭据的 URL。`window.open` 只能以同一个插件声明的 `window` 贡献为目标。

非敏感 JSON 偏好应使用 `storage`；OAuth 令牌、API 密钥等凭据应使用 `secrets`。每个插件最多保存 32 个字符串键，每个值最大 16 KB，总计最大 64 KB。卸载插件时会删除这些机密，并且绝不会退回明文存储；如果操作系统无法提供受保护的加密，调用会明确失败。

音乐库授权会跨重启持久化，并且只能由拥有它的插件列出或撤销。扫描会跳过符号链接，返回相对路径、元数据和不透明的流 URL，而不是库根目录的绝对路径。卸载插件会撤销其全部授权。播放列表内容按原始写法返回，刻意保持格式中立，因此播放器可以使用标准的 M3U/PLS 或自己的 JSON schema；导入的播放列表本身可能包含绝对路径。

### 编写完整的播放器插件

本地音乐库播放器通常声明：

```json
"permissions": ["storage", "media:library", "playlists:read", "playlists:write"]
```

仅在需要远程目录、电台、封面或流媒体时添加 `network`；仅在需要于系统浏览器中打开明确链接时添加 `external:open`；仅在需要于 CanvasTTY 的共享内置浏览器中打开明确 HTTP(S) 页面时添加 `browser:open`。`storage` 用于播放器偏好、收藏、队列状态和其他小型 JSON 元数据；音频文件保留在用户选择的文件夹中。

| SDK 调用 | 结果与预期用途 |
|:--|:--|
| `host.media.pickLibrary()` | 打开原生目录选择器并持久化授权；返回 `{ id, name }`，取消时返回 `null` |
| `host.media.listLibraries()` | 重启后恢复此插件已授权的音乐库，不暴露绝对路径 |
| `host.media.scanLibrary(libraryId)` | 递归返回最多 20,000 个受支持的曲目，包含 `id`、显示名、相对路径、大小、MIME 类型和 `streamUrl` |
| `host.media.revokeLibrary(libraryId)` | 移除此插件对所选文件夹的授权 |
| `host.playlists.list(libraryId)` | 列出已授权音乐库中最多 2,000 个可读取的播放列表文件 |
| `host.playlists.read(libraryId, playlistId)` | 返回原始 UTF-8 播放列表文本，最大 4 MB |
| `host.playlists.write(libraryId, name, content)` | 原子地写入 `.m3u`、`.m3u8`、`.pls` 或 `.json` 到音乐库的 `Playlists/` 目录，最大 4 MB |

扫描的音频扩展名为 `.aac`、`.flac`、`.m4a`、`.mp3`、`.oga`、`.ogg`、`.opus`、`.wav` 和 `.webm`。可以把 `track.streamUrl` 直接赋给 `<audio>` 元素；host 支持 byte-range 响应，因此时长探测和 seek 都能正常工作。拥有 `media:library` 的插件在需要字节数据做浏览器端元数据解析时，也可以 `fetch(track.streamUrl)`。完整的方法重载和结果接口见 [`plugin-api.d.ts`](plugin-api.d.ts)。

推荐的启动流程：调用 `listLibraries()`；仅在没有已授权文件夹时才通过 `pickLibrary()` 请求选择文件夹；扫描所选音乐库；从 `storage` 恢复队列和偏好；然后列出并解析播放列表。把已撤销或已移动的文件夹当作明确的不可用状态处理，并让用户重新选择。

上下文更新包含当前 CanvasTTY 的语言环境和配色方案。插件自行负责其内部本地化和样式；应在 contribution 的预期尺寸下保持可读，且不得虚构加载进度、会话、状态、限额或遥测。

### 可见性

当卡片未被绘制时（缩小为摘要、编辑 HOME 时隐藏、平移到屏幕外或窗口最小化），画布应用会继续存在。宿主不会重新加载 frame，而是像浏览器挂起后台标签页一样挂起它：`document.visibilityState` 为 `"hidden"`（每次变化都会触发 `visibilitychange`），计时器（`setTimeout`、`setInterval`）每秒最多唤醒一次，`requestAnimationFrame` 回调会等到卡片再次显示。DOM、JavaScript 状态、网络请求、音频和 workers 不受影响。订阅：`host.onVisibilityChange((state) => …)`，当前值：`host.visibility()`；不使用 SDK 时可直接监听 `visibilitychange`。宿主消息：`{ source: "canvastty-host", type: "visibility", state: "visible" | "hidden" }`。

## 安装与管理

1. 把静态包发布到公开 GitHub 仓库的根目录。
2. 打开 **Settings → Plugins**。
3. 粘贴 `https://github.com/owner/repository` 并选择 **Inspect**。
4. 查看 manifest 和请求的权限，然后确认 **Install**。
5. 在同一个区块启用、禁用或卸载该包。HOME 小组件在 **外观 → HOME 组成** 中与内置小组件一起添加或移除。如果 manifest 声明了 `settingsContribution`，插件卡片还会显示独立的 **Settings** 操作。
6. 打开 **Settings → Appearance → HOME composition**，然后选择 **Edit HOME**，即可拖动磁贴、调整大小，或拉动 HOME 边界的右下角。Settings 磁贴会保留为恢复入口；其余所有核心磁贴和插件磁贴都是可选的。

当前安装器会刻意拒绝私有仓库、GitHub `/tree/branch/subdirectory` 链接以及需要构建步骤的仓库。请把可直接运行的静态包发布到仓库根目录。

无需账号即可通过 GitHub 公共搜索 API 浏览和搜索展示页。登录是可选的，只会提高 GitHub 搜索限额；达到匿名限额时，CanvasTTY 会显示何时可以重试。可选的展示页登录使用 GitHub OAuth Device Flow。构建维护者可以[注册 OAuth App 并启用 Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)，再将公开的 client ID 保存到 GitHub Actions 仓库变量 `CANVASTTY_GITHUB_CLIENT_ID`。正式构建会在该变量已配置时嵌入其值；本地构建可使用 `GITHUB_OAUTH_CLIENT_ID` 或 `CANVASTTY_GITHUB_CLIENT_ID`，运行时也可以用任一变量覆盖内置值。应用不包含也不需要 client secret。默认情况下，登录会在 CanvasTTY 内置浏览器中打开 GitHub，同时明确提供系统浏览器作为备用选项。未配置 client ID 时，界面会明确显示 OAuth 不可用，但仍可通过仓库链接检查和安装插件。退出登录只删除本机的加密会话；需要时请另行在 [GitHub 应用设置](https://github.com/settings/applications)中撤销授权。

登录进行中时可以取消。拒绝授权、验证码过期、提供方错误或取消操作都会清除旧验证码，显示结果，并允许重新登录。取消等待中的登录流程会保留已有的本地账号；如果授权先完成，则保留已完成的登录。

## 作者检查清单

- 只使用结构化的 host 数据和明确的 loading/unavailable/error 状态。
- 请求最小的权限集合。
- 所有脚本保持外部化；不要依赖内联脚本执行。
- 不要指望 Node.js、文件系统路径、PTY 历史、服务商 token 或父级 DOM 访问。
- 在声明的最小网格尺寸和画布缩放状态下测试 HOME 小组件。
- 在低于 `0.5×` 的语义摘要模式下测试画布应用。
- 在嵌入式和独立窗口两种 contribution 中测试相同的 SDK 调用。
- 贡献示例或改动 host 时，运行 CanvasTTY 的 `npm test`、`npm run typecheck` 和 `npm run build`。
