# 安装、发布与本地数据

[English](installing-and-security.md) · [Русский](installing-and-security.ru.md) · [简体中文](installing-and-security.zh-CN.md) · [文档首页](README.zh-CN.md)

## 应用更新

首个包含内置更新机制的版本需要手动安装。后续更新来自 `howdeploy/CanvasTTY` 的稳定版发布。macOS 保留应用的 ad-hoc 签名，并使用 Sparkle 独立的 Ed25519 归档签名。发布更新需要已签名的 appcast 和发布者持有的私钥。

发布负责人须在 `howdeploy/CanvasTTY` 的 GitHub Actions 中设置变量 `SPARKLE_PUBLIC_ED_KEY` 和密钥 `SPARKLE_EDDSA_PRIVATE_KEY`。两者分别是同一 Sparkle Ed25519 密钥对中 32 字节公钥和私钥种子的 base64 编码。私钥不得存入仓库。CI 会核对密钥对，将公钥写入 macOS 应用，签署 `appcast.xml` 和 ZIP，并在发布前检查稳定版 tag 与完整产物。

在 pull request 的 macOS CI 构建中，如无法读取发布负责人的变量，则使用测试公钥；这些构建不会作为正式发布产物上传。发布稳定版前，发布 job 还会核对更新元数据中的文件名、大小及 SHA-512 校验值是否与实际产物一致。

### 维护者一次性配置 Sparkle 签名

在可信的 Mac 上使用固定版本 Sparkle 2.10.0 的工具，以及已安装并完成登录的 GitHub CLI（`gh`）。`generate_keys` 将私钥保存在登录钥匙串中；`--account` 将 CanvasTTY 的密钥与其他组织的密钥分开。请安全备份此密钥。后续发布继续使用同一密钥对：已内置公钥的应用无法验证另一密钥对签署的更新，除非预先安排密钥轮换或让用户手动重新安装。

```bash
npm ci
npm run build:mac-updater
gh auth status
artifacts/sparkle/distribution/bin/generate_keys --account howdeploy.CanvasTTY
gh variable set SPARKLE_PUBLIC_ED_KEY --repo howdeploy/CanvasTTY \
  --body "$(artifacts/sparkle/distribution/bin/generate_keys --account howdeploy.CanvasTTY -p)"
(
  umask 077
  key_dir="$(mktemp -d)"
  trap 'rm -f "$key_dir/private.key"; rmdir "$key_dir"' EXIT
  artifacts/sparkle/distribution/bin/generate_keys --account howdeploy.CanvasTTY -x "$key_dir/private.key"
  gh secret set SPARKLE_EDDSA_PRIVATE_KEY --app actions --repo howdeploy/CanvasTTY < "$key_dir/private.key"
)
```

合并更新 PR 后、创建首个发布 tag 前，请使用有权管理 `howdeploy/CanvasTTY` 中 Actions variables 和 secrets 的 GitHub 账户执行一次这些命令。导出的种子仅在上传期间保存在临时文件中；不要提交它，也不要将测试公钥用于正式发布。在 **Settings → Secrets and variables → Actions** 中确认两个名称均已存在。发布 job 会在签署 Mac 更新前验证密钥对。仅合并 PR 不会发布 release；推送 `vX.Y.Z` tag 才会触发发布。手动 `workflow_dispatch` 只构建安装包。

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

原生智能体 helper `canvastty-helper`（Go，仅标准库，无 cgo）由 `npm run build:helpers` 为目标平台构建，并以 `resources/helpers` 打包。它在 macOS 和 Linux 上运行智能体的 MCP 服务器与 hook；Windows 默认仍使用内置的 JavaScript helper，`CANVASTTY_HELPERS=node` 可在任何系统上强制使用它们。

## 本地用户数据

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
| 应用诊断 | `userData/logs` 中四个最大 1 MiB 的 JSONL 文件；用户可明确操作，将近期事件及选定系统信息随问题描述发送至配置的 HTTPS 服务。没有自动上传；内容和配置见 [diagnostics](diagnostics.md) |

`userData` 的具体路径可能随系统配置而不同。CanvasTTY 会向 Electron 请求正确的每用户目录，绝不会把源码 checkout 当作运行时存储使用。

## 凭据边界

只有当基于数据源的配额请求需要凭据时，可信的主进程才会读取它们。凭据只会发送到对应服务商的端点，不写入日志，不由 CanvasTTY 持久化，也绝不经过类型化的 preload 桥接。Kimi 的 loopback 用量令牌（token）只保留在进程内存中，其子进程的 stderr 会被丢弃。

脱敏后的百分比、窗口元数据、时间戳以及明确的不可用原因可以通过 IPC 传递。原始的服务商响应、bearer 请求头、cookie 和凭据文件则不允许。Runtime 插件机密属于独立的可选边界：只有 manifest 声明 `secrets` 时，机密才会通过所属 sandbox 的请求路径传递，并通过 Electron `safeStorage` 加密保存。

## 智能体防护层

智能体按自己的模式工作；CanvasTTY 的各层位于其外部，作为安静的安全网：项目内的常规工作不会增加提问，只拦截危险操作并给出简短原因。

- **启动模式**：自动（默认）、手动、接受编辑、计划、绕过，仅在 CLI 支持时提供。绕过由用户按 CLI 确认，在主进程中检查，绝不交给子智能体，并且仍处于下列各层之内。
- **基础保护**（hooks）为有 hooks 的智能体拒绝提权、`curl | sh`、磁盘命令以及项目外的写入；它检查命令，不是沙箱。
- **委派规则**：子智能体的权限不超过其编排者（绝不为 YOLO），只在项目文件夹内工作，并受用户设定的深度和数量限制；智能体无法更改设置、防护、配置档或隔离。
- **智能体隔离**（macOS 使用 sandbox-exec，Linux 使用 bubblewrap）：只能写入项目、自身临时目录和其 CLI 的目录；密钥和令牌不可读；其他进程、应用和守护进程不可达；无法建立时拒绝启动。未设置网络策略时网络不受限制；Windows 暂无此层，子智能体在那里以手动模式运行。详见 [agent-orchestration.md](agent-orchestration.md)。
- **网络策略**按项目设置：开放、仅允许的域名（可选包括提供方 API 和软件包仓库）或离线；在下次启动智能体时生效，并显示在卡片上。策略保存在 CanvasTTY 的私有数据中，项目文件或插件无法放宽它。严格模式需要 macOS 沙箱，或在 Linux 上需要随附的 helper 和 Landlock ABI 9；否则严格启动会被拒绝。普通 SSH 会话不在此范围内。
- **按需使用密钥**：智能体通过 `request_secret` 请求一个已配置的提供方密钥，用户授权 10 分钟、一轮或整个会话，随后 `run_secret_request` 用它发送类型化 HTTPS 请求。密钥本身不会交给智能体；授权可在卡片详情中撤销。

**Git 审计。** 隔离的智能体会话结束、被关闭或在退出后恢复时，CanvasTTY 会检查其文件夹下 git 目录发生变化的仓库。如果 git 现在会在隔离外运行某些东西（`core.hooksPath`、filter 或 diff 驱动、`fsmonitor`、hook 文件、`info/attributes`），会出现一条列出具体变化的通知；**Neutralize** 删除这些键并停用这些文件，**Keep as is** 保持不变。它不会撤销项目内的其他文件改动。

### Linux：bubblewrap 无法启动时

Ubuntu 24.04 及更新版本（以及其他设置了 `kernel.apparmor_restrict_unprivileged_userns=1` 的发行版）只允许带 AppArmor 配置文件的程序创建非特权用户命名空间，而 bubblewrap 需要它。CanvasTTY 会检查一次（失败后一分钟再查），如果 `bwrap` 已安装却无法启动，就按没有隔离层的电脑处理：子智能体和插件启动的智能体以手动模式运行，卡片会说明原因。要允许它，可以为 bubblewrap 单独添加配置文件（推荐，只影响 `bwrap`）：

```sh
sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

或者对所有程序解除限制：`sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`（写入 `/etc/sysctl.d/60-userns.conf` 可在重启后保留）。新的启动会在一分钟内用上隔离层，无需重启。

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

构建原生 helper 需要 Go 1.21 或更高版本；没有 Go 时构建会打印警告，包中只含 JavaScript helper（`CANVASTTY_REQUIRE_NATIVE_HELPERS=1` 会把这种情况变成错误，发布构建即如此）。

`npm run package` 会为当前操作系统生成未打包的应用目录。各平台的脚本用于生成安装包：

```bash
npm run package:linux
npm run package:win
npm run package:mac
```

每个脚本都应在对应的操作系统上运行。由于 `node-pty` 是原生模块，交叉编译不能作为兼容性的证明。

## 发布检查清单

1. 确认已在 `howdeploy/CanvasTTY` 配置 Sparkle 的变量和密钥；不要为每次发布重新生成密钥对。确认 `package.json` 与 tag 使用同一个语义化版本号。
2. 运行密钥审计、测试、typecheck、production build 以及当前系统的 package 构建。
3. 检查真实打包出来的应用，并核对包内容白名单。
4. 使用候选安装包在真实 Linux、Windows 和 macOS 设备上完成更新验证。
5. 推送 `vX.Y.Z`，等待三个 GitHub Actions package job 全部完成。产物检查通过后，workflow 会立即将该 tag 发布为稳定版 release。

浏览器存储、智能体访问与日志保留策略见[内置浏览器与审计日志](browser.zh-CN.md)。安全问题请按照仓库的[安全策略](../SECURITY.zh-CN.md)进行报告。
