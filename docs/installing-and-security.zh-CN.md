# 安装、发布与本地数据

[English](installing-and-security.md) · [Русский](installing-and-security.ru.md) · [简体中文](installing-and-security.zh-CN.md) · [文档首页](README.zh-CN.md)

## 面向用户的软件包

每个 `v*` tag 都会在 GitHub 托管的对应系统 runner 上触发三大平台的原生构建：

| 平台 | 产物 | 说明 |
|:--|:--|:--|
| Linux x86_64 | AppImage、deb | AppImage 是单文件包，需要 FUSE 2 兼容库（Ubuntu 24.04 上为 `libfuse2t64`）；deb 可集成到 Debian 系桌面环境 |
| Windows x64 | NSIS 安装程序、便携版可执行文件 | 安装程序支持自定义安装目录，并会创建开始菜单/桌面快捷方式 |
| macOS arm64（Apple Silicon） | dmg、zip | 两者都包含图形化的 `.app` bundle；不包含 Intel/x64 构建 |

请只从本仓库的 [GitHub Releases](https://github.com/howdeploy/CanvasTTY/releases) 页面下载产物。从 `1.2.4` 起，macOS bundle 会进行 ad-hoc 签名，并在上传前通过严格的 `codesign` 验证。这可以验证 bundle 完整性，但不提供 Developer ID 身份，也没有 Apple notarization，因此 Gatekeeper 仍可能要求通过 Finder → Open 或 Privacy & Security → Open Anyway 手动允许。Windows 软件包仍未签名，可能触发 SmartScreen。`1.2.2` 与 `1.2.3` 的 macOS 产物早于此签名修复；请使用 `1.2.4` 或更高版本。在确认任何警告之前，请先核对 release tag 和产物名称。

## 分发包包含什么

`electron-builder.yml` 采用显式的白名单（allowlist）：只打包 `out/` 下的 production bundle、`package.json`、MIT `LICENSE` 和必需的 production dependencies。文档源文件、`.env`、本地的智能体/planning 目录、日志、设置、凭据以及发布工作目录中的文件都不会被复制进应用包。

`node-pty` 会在对应平台的 GitHub runner 上重新构建，因此 Linux、Windows 和 macOS 的包使用的都是各自平台的原生模块。一个系统的包绝不会被换个名字冒充另一个系统的构建。

## 仅保存在本地的用户数据

| 数据 | 位置与生命周期 |
|:--|:--|
| CanvasTTY 设置 | Electron 的每用户 `userData` 目录（典型 Linux 桌面为 `~/.config/canvastty`，Windows 为 `%APPDATA%\canvastty`，macOS 为 `~/Library/Application Support/canvastty`） |
| 服务商凭据 | 由已安装的 Codex、Claude、Qwen Code、Kimi、OpenCode、Hermes 或 Grok Build CLI 自己管理的本地凭据存储，CanvasTTY 不会复制它 |
| 临时服务商浏览器桥接 | Kimi fallback 与 Hermes MCP 配置项带有 journal，只属于活动的 CanvasTTY 会话，并在最后一个 PTY 退出时恢复，或在启动中断后进行修复；capability 机密绝不会以字面值写入 |
| PTY 滚动缓冲区 | 应用会话存续期间主进程中的有界内存，不会写入仓库 |
| Home 媒体 | 用户磁盘上的原始本地文件，设置中只保存它的本地路径 |
| Runtime 插件 | `userData/plugins` 下的静态包和启用状态；`userData/plugin-storage` 下的隔离 JSON 存储限制为每个插件 64 KB，并在卸载时删除 |
| 插件机密 | `userData/plugin-secrets` 下的加密数据；明文仅通过权限控制的调用提供给所属且已启用的插件；没有操作系统保护加密时写入会明确失败，卸载插件时删除对应文件 |
| 插件媒体目录授权 | `userData/plugin-media-libraries.json`；保存用户明确选择的绝对目录路径，并在卸载插件时删除其授权 |
| 插件播放列表 | 获得写权限的插件只能在所选媒体库的 `Playlists/` 目录中创建受大小限制的文件 |
| 内置浏览器 profile | 持久化 Electron partition `canvastty-browser` 中的 cookie、cache 与网站存储；`1.0.2` 已从 HOME 提供浏览器 |
| 浏览器恢复状态 | `userData/browser-state.json` 中的安全 HTTP(S) 标签 URL、顺序和活动标签 ID；关闭标签恢复时禁用/清除 |
| 浏览器审计日志 | `userData/browser/audit` 下的脱敏 hash-chain JSONL；活动文件达到 100 MB 时轮转，超过 30 天的轮转文件会在 store 初始化或下一次轮转时清理 |
| 其他日志 | 仅本地 stdout/stderr；CanvasTTY 没有远程日志收集器，也没有项目自营遥测端点 |

`userData` 的具体路径可能随系统配置而不同。CanvasTTY 会向 Electron 请求正确的每用户目录，绝不会把源码 checkout 当作运行时存储使用。

## 凭据边界

只有当基于数据源的配额请求需要凭据时，可信的主进程才会读取它们。凭据只会发送到对应服务商的端点，不写入日志，不由 CanvasTTY 持久化，也绝不经过类型化的 preload 桥接。Kimi 的 loopback 用量令牌（token）只保留在进程内存中，其子进程的 stderr 会被丢弃。

脱敏后的百分比、窗口元数据、时间戳以及明确的不可用原因可以通过 IPC 传递。原始的服务商响应、bearer 请求头、cookie 和凭据文件则不允许。Runtime 插件机密属于独立的可选边界：只有 manifest 声明 `secrets` 时，机密才会通过所属 sandbox 的请求路径传递，并通过 Electron `safeStorage` 加密保存。

## 仓库防护

```bash
npm run audit:secrets
npm test
```

审计会检查高置信度的服务商/云服务令牌格式、私钥块、硬编码的密钥赋值、敏感文件名以及个人 home 目录的绝对路径。repository metadata 名称会在判断 entry 类型之前排除，因此普通 clone 的 `.git/` 目录和 linked worktree 的 `.git` 文件都会被忽略，同时可发布文件中的个人路径仍会被发现。`.gitignore` 排除了本地智能体上下文、planning 数据、env 文件、凭据、日志、设置、dependencies 和生成的软件包。CI 会在构建前运行审计，每个 release job 在打包前也会再运行一次。

没有扫描器是万无一失的。永远不要“临时”提交真实密钥。如果密钥已经进入了 Git 历史，先吊销它，再清理历史记录，然后才公开仓库。

## 本地构建软件包

```bash
npm install
npm run package
```

`npm run package` 会为当前操作系统生成未打包的应用目录。各平台的脚本用于生成安装包：

```bash
npm run package:linux
npm run package:win
npm run package:mac
```

每个脚本都应在对应的操作系统上运行。由于 `node-pty` 是原生模块，交叉编译不能作为兼容性的证明。

## 发布检查清单

1. 确认 `package.json` 与 tag 使用同一个语义化版本号。
2. 运行密钥审计、测试、typecheck、production build 以及当前系统的 package 构建。
3. 检查真实打包出来的应用，并核对包内容白名单。
4. 推送 `vX.Y.Z`，等待三个 GitHub Actions package job 全部完成。
5. 在真实 Linux、Windows 和 macOS 设备上验证通过之前，将自动创建的 release 保持为预发布（prerelease）状态。

浏览器存储、智能体访问与日志保留策略见[内置浏览器与审计日志](browser.zh-CN.md)。安全问题请按照仓库的[安全策略](../SECURITY.zh-CN.md)进行报告。
