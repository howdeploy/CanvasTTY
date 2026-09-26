# 运行时插件

[English](plugins.md) · [Русский](plugins.ru.md) · [简体中文](plugins.zh-CN.md) · [文档首页](README.zh-CN.md)

CanvasTTY 运行时插件从 HTTPS GitHub 仓库安装。插件可以提供 sandboxed web contribution，也可以声明可选的 agent hook 脚本。Web contribution 不具备 Node.js 能力；每个 hook 在用户于 **设置 → Agents → Hooks** 中单独确认信任前始终关闭。

## 信任模型

安装插件等同于允许第三方浏览器代码在本地运行。CanvasTTY 会压缩这一信任面，但无法让未知代码变得可信：

- CanvasTTY 只下载 GitHub 仓库根 URL 对应默认分支的 tar 归档，安装或更新期间绝不运行 `npm install`、构建钩子、原生模块或仓库脚本。
- 包内不得包含符号链接，且限制为 500 个文件或目录 / 25 MB。单个对外提供的资源限制为 8 MB。
- 插件 frame 拥有不透明的 sandbox origin，无法访问父级 DOM，没有 `window.canvasTTY`，也没有 Node.js API。
- 独立窗口的 preload 不暴露任何 Node 原语。它通过一个带身份校验的 IPC handler 转发同样的 SDK 消息。
- 每个特权 SDK 方法都由 manifest 中的权限把关。权限会在用户确认安装之前展示。
- Sandboxed web contribution 不会收到服务商凭据、PTY 缓冲区、工作目录、原始服务商响应或文件系统访问权限。
- 禁用或卸载插件会立即停止提供其资源，并关闭其独立窗口。
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

不包含特权 hook 的 sandboxed web surface 端到端示例见 [`examples/plugins/studio-kit`](../examples/plugins/studio-kit)。
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

host.onStorageChange(listener) 会把 host.storage.set 的写入通知给同一插件的所有活动界面——画布卡片、HOME 小组件和独立窗口——从而避免轮询。

## 权限

| 权限 | SDK 能力 | 数据边界 |
|:--|:--|:--|
| `storage` | `storage.get`、`storage.set` | 隔离的 JSON 存储，每个插件 64 KB |
| `secrets` | `secrets.get`、`secrets.set`、`secrets.delete` | 通过 Electron `safeStorage` 加密的字符串机密；操作系统没有受保护存储时会明确失败 |
| `sessions:read` | `sessions.list` | 仅限 ID、服务商、标题、状态、开始时间、退出码 |
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

## 安装与管理

1. 把静态包发布到公开 GitHub 仓库的根目录。
2. 打开 **Settings → Plugins**。
3. 粘贴 `https://github.com/owner/repository` 并选择 **Inspect**。
4. 查看 manifest 和请求的权限，然后确认 **Install**。
5. 在同一个区块启用、禁用或卸载该包。HOME 小组件在 **外观 → HOME 组成** 中与内置小组件一起添加或移除。如果 manifest 声明了 `settingsContribution`，插件卡片还会显示独立的 **Settings** 操作。
6. 打开 **Settings → Appearance → HOME composition**，然后选择 **Edit HOME**，即可拖动磁贴、调整大小，或拉动 HOME 边界的右下角。Settings 磁贴会保留为恢复入口；其余所有核心磁贴和插件磁贴都是可选的。

当前安装器会刻意拒绝私有仓库、GitHub `/tree/branch/subdirectory` 链接以及需要构建步骤的仓库。请把可直接运行的静态包发布到仓库根目录。

无需账号即可通过 GitHub 公共搜索 API 浏览和搜索展示页。登录是可选的，只会提高 GitHub 搜索限额；达到匿名限额时，CanvasTTY 会显示何时可以重试。可选的展示页登录使用 GitHub OAuth Device Flow。构建维护者可以[注册 OAuth App 并启用 Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)，再将公开的 client ID 保存到 GitHub Actions 仓库变量 `CANVASTTY_GITHUB_CLIENT_ID`。正式构建会在该变量已配置时嵌入其值；本地构建可使用 `GITHUB_OAUTH_CLIENT_ID` 或 `CANVASTTY_GITHUB_CLIENT_ID`，运行时也可以用任一变量覆盖内置值。应用不包含也不需要 client secret。默认情况下，登录会在 CanvasTTY 内置浏览器中打开 GitHub，同时明确提供系统浏览器作为备用选项。未配置 client ID 时，界面会明确显示 OAuth 不可用，但仍可通过仓库链接检查和安装插件。退出登录只删除本机的加密会话；需要时请另行在 [GitHub 应用设置](https://github.com/settings/applications)中撤销授权。

## 作者检查清单

- 只使用结构化的 host 数据和明确的 loading/unavailable/error 状态。
- 请求最小的权限集合。
- 所有脚本保持外部化；不要依赖内联脚本执行。
- 不要指望 Node.js、文件系统路径、PTY 历史、服务商 token 或父级 DOM 访问。
- 在声明的最小网格尺寸和画布缩放状态下测试 HOME 小组件。
- 在低于 `0.5×` 的语义摘要模式下测试画布应用。
- 在嵌入式和独立窗口两种 contribution 中测试相同的 SDK 调用。
- 贡献示例或改动 host 时，运行 CanvasTTY 的 `npm test`、`npm run typecheck` 和 `npm run build`。
