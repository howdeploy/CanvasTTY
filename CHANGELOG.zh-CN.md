# 更新日志

[English](CHANGELOG.md) · [Русский](CHANGELOG.ru.md) · [简体中文](CHANGELOG.zh-CN.md)

## 未发布

智能体团队、任务预算和每张卡片的历史。accounts、assistant、context 和 environments 插件分别发布各自的部分。

- **流程。** 四个内置编排流程（拆分并汇总、执行者与审查者、三个方案与评判、查找并验证缺陷），以及 `.canvastty/flows/*.yaml` 中的项目流程。项目流程只有在用户批准其当前指令后才会使用。启动器提供这些流程，也可以把正在运行的任务树保存为流程。
- **画布上的任务树。** 编排者与子智能体卡片相互关联，编排者卡片显示汇总，**Gather task** 把它们集中到一起；画布可按树、状态、项目或网格排列，并可撤销。
- **任务看板。** 智能体使用 `list_tasks`、`claim_task`（原子操作，先满足依赖）、`update_task` 和 `complete_task`；用户在卡片详情中添加、分配和关闭任务。
- **审查、worktree 与重试。** `spawn_agent` 支持 `review: true`（在 Plan 模式下的独立审查者，其结论附加到结果中）和 `isolate: "worktree"`。`retry_agent` 用原始请求和经过遮蔽的失败输出末尾重新启动失败或无响应的子智能体，最多两次。
- **预算。** 每个任务树的时间、token 和费用上限，达到 80% 时提醒。达到上限后，该任务树不再接收新输入或新子智能体，其进程会暂停，直到用户修改上限。CLI 未报告的用量显示为无数据。
- **模型路由。** 拥有 `model:route` 的受信任插件可以为未指定模型的子智能体选择模型和推理强度，但只能从 `list_providers` 列出的选项中选择；卡片会显示选择及原因。
- **卡片详情。** 带筛选的遮蔽钩子事件时间线和 Markdown 报告；按模型、账户和任务统计的用量，支持时间段、CSV 导出和手动价格；每轮之前的 git 检查点，可预览差异并经确认后恢复；macOS、手机和眼镜通知，支持免打扰。
- **按需使用密钥。** `request_secret` 请用户为一个已配置的提供方密钥授权 10 分钟、一轮或整个会话；随后 `run_secret_request` 用它发送类型化的 HTTPS API 请求，密钥本身不会交给智能体。授权可以撤销。
- **网络策略。** 按项目设置：开放、仅允许的域名或离线，在智能体启动时生效。macOS 使用沙箱配置文件；Linux 使用带本地代理的 bubblewrap，严格模式另用 Landlock（ABI 9 或更新）。无法执行严格模式的系统会拒绝启动。
- **工作区。** 带输出搜索的命令面板、向多个智能体同时输入的显式广播模式、文件/链接/文本交给智能体前的预览（项目外路径需要同意），以及不含密钥的版本化工作区快照和预设；导入 Bypass 卡片需要确认。
- **提问。** `ask_user` 显示智能体的有界问题；符合条件的问题也会发送到已配对的手机。
- **更快的首帧。** 终端代码在首帧之后立即加载。期间输入的按键按顺序到达 shell；加载失败只影响终端卡片，卡片上提供 **重试**。

自动检查未覆盖的内容列在[验证说明](docs/post-1.7-verification.md#not-covered-by-automated-checks)中（英文）。

## 1.7.1

- 新增应用内稳定版本更新：由用户下载和安装，停止活动会话前确认，macOS 使用 Sparkle 签名更新。首个支持更新的版本需要手动安装；后续兼容版本可在应用内安装。
- 新增轮转诊断日志及用户主动发送的问题报告，可附加一张 PNG/JPEG 图片，并显示预览和报告编号。不采集终端输出或按键，也不会自动上传。
- 当前键盘预设的快捷键说明改为画布上的独立浮层，Linux 预设恢复使用 `Ctrl+Shift+C` 复制终端选中文本。
- 修复缩小至极限时小地图的镜头边框。眼镜、本地网络设置及 Web companion 移至「控制」下方「外部集成」中的紧凑卡片。

### 更新后你会注意到

在同一台 Apple Silicon Mac 上与 1.7.0 做初始整栈 A/B 对比：交替运行，每侧 3 次，取中位数，智能体 CLI 使用桩程序（真实 CLI 会在此之上增加自身开销）。

| | 1.7.0 | 初始测量 | 变化 |
|:--|--:|--:|--:|
| 内存：10 个 OpenCode 智能体 + 编排者（RSS） | 1,762 MB | 1,103 MB | −37 % |
| 每张智能体卡片的 helper（RSS） | 60 MB | 6 MB | −90 % |
| Claude Code 每次工具调用的权限检查 | 165 ms | 23 ms | −86 % |
| 5 个终端以 256 KB/s 输出 30 秒时渲染进程的 CPU 时间 | 3.16 s | 1.92 s | −39 % |
| 每次平移/缩放渲染的 React 组件数 | 73 | 2 | −97 % |
| 首个可交互帧（恢复 3 个终端） | 511 ms | 434 ms | −15 % |
| 应用 / zip（macOS arm64） | 376 / 195 MB | 259 / 121 MB | −31 % / −38 % |

报告中的隐藏终端测试夹具对比了隐藏时仍用 `visibility:hidden` 绘制与用 `display:none` 暂停屏幕绘制：改动前 renderer CPU 为 1.880710 秒，改动后为 1.773396 秒，五张卡片总计减少约 5.7%，包括最后一次恢复。两种情况处理相同的完整输出并保留终端状态；完整流解析仍然开启，不能把丢弃输出的有损环形缓冲区重放所节省的 CPU 作为优化目标。测试在 Apple Silicon Mac 上使用已安装的 xterm 6 和 Electron 运行：5 张卡片，10 秒，每张卡片每秒 1,024 Ki 个 UTF-16 单元；3 组交错配对运行的中位数。结果只计 renderer CPU，不包括应用主进程、PTY/IPC 或 WebGL，也不能证明整个应用、实时 provider 或 Linux/Windows 上的性能提升。评审期间没有独立重新测量该结果。

无人可见的插件卡片会暂停并保留状态，隐藏的浏览器标签页会被降频；编排者以 Auto 运行时，子智能体不再每个操作都询问用户。

### 变更

- **用于 agent 后台标签页的浏览器引擎。** 插件可以提供更轻量的浏览器引擎（`browser:engine`，见[插件](docs/plugins.zh-CN.md)）；`browser_new_tab` 接受 `engine`（默认 `auto`、`chromium` 或引擎 id）。安装并运行引擎后，agent 的新标签页在后台用它打开，用户的活动标签页保持不变；用户自己的标签页始终使用 Chromium。没有真实布局的引擎通过 DOM 点击。在截图、拖拽、下载、机器人验证墙、文字相对页面过少、缺少 CDP 方法、引擎崩溃或标签页被显示时，标签页以相同 id 转到 Chromium，并给 agent 一个 `notice`；该网站在本次会话中被记住。没有标签页 id 的命令发往 agent 最后打开的标签页。引擎不会得到 cookie 或配置文件。示例引擎：独立的 `canvastty-plugin-lightpanda`。 浏览器卡片在屏幕外时，后台标签页的截图也能正常工作。
- **启动模式。** 现在默认是 Auto。Manual、Accept edits、Plan 与 Bypass（YOLO）只在 CLI 支持时提供：Accept edits 与 Plan 适用于 Claude Code、Codex、Grok 和 OpenCode，Plan 还适用于 Cursor；没有自带自动模式的 CLI，其 Auto 就是跳过审批，且只在智能体隔离内存在。Bypass 需要用户为每个 CLI 确认一次，由主进程检查，且绝不交给子智能体。
- **委派规则。** 子智能体的权限不超过其编排者（plan < manual < accept edits < auto，绝不为 Bypass），只在编排者的项目文件夹内工作，并受用户在 Settings → Agents 中设定的深度（2）与存活子智能体数（8）限制。对于无法询问的 CLI，决策插件的「ask」会变成附带原因的拒绝。
- **智能体隔离。** 操作系统层（macOS 用 `sandbox-exec`，Linux 用 bubblewrap）包裹子智能体、插件启动的智能体以及所有非 Manual 模式的智能体：只能写入项目、本次启动的临时目录和其 CLI 自己的目录；密钥、其他 CLI 的凭据和 CanvasTTY 的 token 不可读；无法建立时拒绝启动。Windows 暂无隔离层，子智能体在那里以 Manual 运行；在 bubblewrap 无法创建用户命名空间的 Linux 上（Ubuntu 24.04 的 AppArmor 限制）也是如此，卡片会显示原因，并说明[如何允许](docs/installing-and-security.zh-CN.md#linuxbubblewrap-无法启动时)。关闭隔离需由用户主动选择。
- **Git 审计。** 隔离会话结束后，CanvasTTY 会检查它触及的仓库中是否有会在隔离外运行程序的 git 设置和文件，并提供 **Neutralize** 或 **Keep as is**。
- **原生智能体 helper。** `canvastty-helper`（Go）在 macOS 和 Linux 上运行 MCP 服务器、权限检查和生命周期 hook；Windows 默认仍使用 JavaScript helper，`CANVASTTY_HELPERS=node` 可在任何系统上强制使用它们。从源码构建需要 Go 1.21 或更高版本（`npm run build:helpers`）；没有 Go 时使用 JavaScript helper。
- **性能。** 只打包主进程和 preload 实际加载的内容，内置皮肤改用 AVIF；画布镜头放在 React 之外；屏幕外的 DOM 终端不再在滚动时重建；摘要模式和 HOME 编辑中隐藏的终端停止绘制并推迟选区重绘，解析器仍按有界批次接收完整输出以保留终端状态和历史；窗口在服务启动的同时加载，Settings 按需加载；隐藏的浏览器标签页、无人可见的插件帧以及关闭的 Settings 停止轮询。
- **修复。** 两轮缺陷排查：编排工具在早期 gateway 竞争后可恢复，浏览器操作在重连后不再重复，重启的智能体不再返回上一段对话的答案，保存所有打开的卡片（而不只是前 64 张），并发创建时 32 个会话的上限依然有效，过大的截图替换为说明，`git worktree add` 指向其他仓库时被判定为写入。
- `get_agent_result` 和 `wait_for_agent` 现在以 `answer` 返回 OpenCode 或 Codex 子 agent 的最终回复，而不是只给编排者全屏 TUI 的原始末尾输出。OpenCode 的回复由 CanvasTTY 插件在回合结束（`session.idle`）时从会话最后一条 assistant 消息读取，Codex 的来自其 Stop hook；最多 4,096 个字符并保留结尾，与其他 agent 输出一样遮蔽，只保存在内存中，下一回合开始时清除。只有子 agent 会捕获，普通卡片不会。`get_agent_result` 还会报告 `status`（回合结束后为 idle；CLI 打开期间 `state` 保持 running）。
- 当编排者以「自动」运行时，子 agent 不再每一步都询问人。`spawn_agent` 支持可选的 `profile`（`auto`、`normal`、`acceptEdits` 或 `plan`）；不传时子 agent 继承编排者的配置（其 CLI 没有自动模式时为「普通」，YOLO 编排者的子 agent 以「自动」或「普通」运行：YOLO 需要 `spawn_agent` 无法选择的隔离环境）。回答（`profile`、`profileInherited`）、`list_agents` 和卡片会显示实际得到的配置。control CLI 的 `create --profile` 仍是其 worker 的对应方式。
- OpenCode 新增 **自动** 启动配置。OpenCode 没有自动模式参数，因此它是本次运行在 OpenCode 默认 agent `agent.build` 下的 `OPENCODE_CONFIG_CONTENT`（追加在人自己的规则之后，不写入 `~/.config/opencode`）：项目内的读取、搜索和编辑无需询问（`.env` 文件仍会询问），shell 命令也一样，但仅在基础保护开启且其守卫在该 OpenCode 中运行时（否则照旧询问），项目外的路径照旧询问。卡片像其他 agent 一样显示 **自动**。
- `spawn_agent` 和 control CLI 的 `create` 支持可选的 `model`（本次运行 CLI 自己的 `--model`：OpenCode 为 `provider/model`，以及 Codex、Claude、Qwen、Kimi 别名、Grok、OMP、Pi、Cursor）和 `effort`（Codex、Claude、Grok）。两者按 provider 校验并在拒绝时说明原因，重启和恢复时保留，且从不写入 CLI 的配置；被指定模型的编排者现在会用该模型运行子 agent，而不是 CLI 的默认模型。`list_providers` 显示每个 provider 的模型格式和 effort 级别，OpenCode 还会显示 `opencode models` 列出的模型（后台读取，超时 5 秒并缓存；工具不会等待它）。不在该列表中的 OpenCode 模型会在启动前被拒绝，并给出最多五个最接近的 id，否则 OpenCode 只会报「Unexpected server error」后停止；若子 agent 仍然退出，其屏幕最后几行会以 `exitLines` 出现在 `wait_for_agent`、`observe_agent` 和 `get_agent_result` 中。
- 名称含有两种 Unicode 写法字符（西里尔字母「й」、带重音的字母；Finder 保存分解形式）的项目文件夹，现在无论 `spawn_agent`、control CLI 或插件传入哪种写法，都会以磁盘上的写法启动，CLI 不再把自己的项目当作外部文件夹（OpenCode 曾对每个文件询问「Access external directory …」）。agent 的 `PWD` 也设为其文件夹而不是应用的，OpenCode 在本次运行中被允许访问该文件夹的另一种写法；其他权限不变，ASCII 路径照旧启动。
- 编排者新增两个 `canvastty_agents` 工具。`list_providers` 列出 CanvasTTY 可作为子 agent 启动的 agent：`spawn_agent.provider` 的确切 id、名称、CLI 是否已安装、上次额度检查得到的登录状态（`ok`、`signed_out`、`expired` 或 `unknown`；不会为此读取或请求任何内容）、子 agent 与编排者支持，以及插件提供的启动选项和挑选它们的插件工具（如 `list_routes`）；control CLI 中对应命令为 `providers`。`wait_for_agent`（`timeoutSeconds` 最多 600）等待子 agent 空闲、需要人处理、退出或安静下来，或超时，并返回状态和已遮蔽的输出末尾；只能等待自己的子 agent，调用被取消时立即停止。`spawn_agent` 现在列出已知的 provider id，未知 id 会被拒绝并提示调用 `list_providers`，而不是笼统的失败。工具说明、MCP 指令、编排者技能和拒绝消息都给出 `list_providers` → `spawn_agent` → `wait_for_agent` → `get_agent_result` 的流程，并要求 agent 不要在文件系统中搜索 agent CLI 或其配置。
- 平移和缩放画布不再重新渲染整个应用：镜头保存在 React state 之外并直接移动场景，因此平移时只重新渲染小地图（以及页面跟随其移动的浏览器卡片），而不是每个指针或滚轮事件重新渲染 50–110 个组件；卡片只在跨越摘要模式或 WebGL 缩放阈值时重新渲染。使用 DOM 绘制的终端卡片（屏幕外或超出 WebGL 池的卡片）不再在每次输出滚动时逐行重建；在早期的屏幕外输出测试夹具中，renderer CPU 占用减半。屏幕显示不变。

## 1.7.0

- Windows 编排启动改用现有的仅限当前用户访问的管道服务，并修复私有数据保护对展开后的 Windows 路径的识别。完整 Windows 测试现在会在 PR 合并前运行，而不再仅在发布打包时运行。

- 集成 PR #98 的像素终端皮肤及智能体生成的主题包，画布背景与终端边框可以独立选择。主题创建界面新增简短说明、上传槽位标签、示例和预览提示；画布图案位于背景选择之前，并说明背景图片何时会覆盖图案。
- 恢复缩小时可读的终端摘要卡片，为编排者自动使用 Master 皮肤，并恢复像素窗口的边缘和角落缩放，不再重置手动调整或恢复的尺寸。
- 集成 PR #100，修复启动导航竞态、API 密钥粘贴及未捕获界面错误后的恢复，并保护 CanvasTTY 的私有控制数据。该 PR 汇总了 #96、#97 和 #99 的修复。
- 更新 SAGE 应用图标、单色标题栏标识及文档图片，修复 Normal、Auto、YOLO 启动配置的布局，并允许在 stdout/stderr 已关闭时正常退出。

- 基础保护现在还会拒绝智能体的 shell 或文件工具使用 CanvasTTY 自己的私有数据：读取、复制或编码 agent-control 令牌与描述文件、各网关的连接记录、提供商与插件的密钥存储、账户主目录、GitHub 登录信息和已准备的启动运行（任何程序，包括解释器单行命令和 heredoc），以及连接 CanvasTTY 的控制或运行时套接字（`curl --unix-socket`、`nc -U`、`socat`、Python 套接字）。模型会平静地得知智能体不能以这种方式控制 CanvasTTY，并被建议请用户以 **Orchestrator** 角色启动它，从而获得 `canvastty_agents` 工具。路径来自应用自己的 userData 文件夹；项目、应用设置、其他套接字和内置控制 CLI 不受影响。控制端点现在对未认证或格式错误的请求，以及 HTTP 请求（最小的 403），都以相同的指引代替简单错误作答，并关闭连接。
- 为 CLI 自带自动模式的智能体新增 **Auto** 启动配置档，与 Normal（仍为默认）和 YOLO 并列：Codex `--approve-for-me`（其自身审查，位于 `workspace-write` 沙箱），Claude Code `--permission-mode auto` 及其沙箱（`sandbox.enabled`、`autoAllowBashIfSandboxed: false`，合并进唯一的 `--settings`），Grok `--permission-mode auto`；控制 CLI 的 `create --profile auto` 和插件的 `sessions.create` 也支持。启动贡献者可回答 `thirdPartyModel: true`（API 或 Ollama 账户）：此时 Auto 以同一沙箱中 CLI 的“仅接受编辑”模式运行，卡片显示 **auto · edits**。Codex 不再因 CanvasTTY 自己添加的 hook 停在 “Hooks need review”（本次运行的 `-c hooks.state`，不写入 `~/.codex`；插件不能传递 `-c hooks…`），位于用户为其编排者所选文件夹（或其子目录）中的 Codex 子智能体不再被再次询问是否信任（本次运行的 `-c projects`）；插件以 `trustedFolder` 获得该文件夹。Claude Code 的 «✳» 标题现在表示空闲：带 hook 的 Claude 卡片仅通过 hook 离开 `needs_approval`，或在用户拒绝其提示后稍候离开。示例：`examples/plugins/launch-env`（Local model 配置档）。
- 新增两个供账户插件使用的启动扩展点。启动选项中的 `select` 可以声明 `"optionsFrom": "service"`：启动器向服务发送 `canvastty.launch.options`（3 秒），并在声明的选项之后列出最多 64 个额外选项，例如插件自己的账户；保存的值由服务在准备启动时检查。编排器可以把插件启动选项作为 `launchOptions` 传给 `spawn_agent`，校验方式与启动器相同。插件为 Claude 提供的内联 `--settings` 会合并进 CanvasTTY 自己的 JSON（Claude Code 只保留最后一个，此前会丢失生命周期和决策 hook）；其中的审批和 hook 键会被拒绝。示例：`examples/plugins/launch-env`（Profile）。
- 新增插件服务（manifest apiVersion 2，`services`）：打包为单文件的 JavaScript，仅在 设置 → Agents 中为该插件单独确认 **Extension native code** 后才作为受监管的子进程运行（默认关闭，安装不会授予；更新、更换模块、禁用或 entry 文件被修改都会撤销）。服务获得不含密钥和 CanvasTTY 内部变量的最小环境，通过 stdio 使用 JSON-RPC（消息上限 1 MB，超时 15 秒），退避重启，在禁用、卸载、更新和退出时停止，并写入有界的插件日志。插件界面通过 `host.service.request` 调用自身插件的服务，并通过 `host.service.onEvent` 接收事件；服务可回调 `log`、自身插件的 `storage` 和 `event`，并可用 `secrets.get` 读取自身插件的机密（需要 `secrets`）。示例：`examples/plugins/service-echo`（其服务还会读取页面保存的令牌）。
- 新增启动贡献者（`launch:contribute`）：受信任的插件服务可以声明启动选项（布尔、选择、文本），显示在智能体启动对话框的 **Advanced（高级）** 部分。对于用户选择了该插件的启动及其重启和恢复，CanvasTTY 请服务准备启动，并加入其环境变量、从插件自身机密解析的机密变量（在其他智能体和控制 CLI 读取的文本中被遮蔽）、参数和本次运行的文件。贡献按插件 id 顺序合并；拒绝、5 秒超时、冲突、保留名称或审批/会话参数都会拒绝启动并在卡片上显示原因，插件不可用的恢复卡片以停止状态返回。所选值随会话保存。贡献者还可以声明 `launch.policy`：此后在其智能体的每次启动中，只要用户没有选择它，也会询问它（`chosen: false`）；它只能拒绝，无回答同样视为拒绝。示例：`examples/plugins/launch-env`、`examples/plugins/yolo-guard`（启动策略）。
- 新增会话环境（`environment:provide`）：受信任的插件服务可以提供卡片的运行位置（git worktree、容器、远程主机），在启动器 Advanced 部分的 **Where** 中选择；只要此类环境适用于终端，终端也会使用同一启动器。服务只准备一次运行位置，之后包装每次启动（经过校验：程序的绝对路径或在 PATH 中解析的纯程序名，绝不接受 shell 字符串；遵循启动贡献者的环境变量规则；插件机密被遮蔽），PTY 仍由 CanvasTTY 创建。不透明引用随卡片保存；恢复时先恢复环境，再先父后子启动卡片；插件缺失、被禁用或不受信任、环境已停止或超时时，卡片以停止状态返回并显示原因，绝不在本地运行。关闭此类卡片时只询问一次“Keep environment data?”并据此释放环境。启动贡献者和启动策略会收到卡片的环境（`canvastty.launch.prepare` 中的 `environment`）。示例：`examples/plugins/env-worktree`（每张卡片一个 git worktree）。
- 新增基础保护和决策 hook。基础保护（设置 → Agents，默认开启，用户可以关闭）在本地 Claude Code、Codex、Qwen Code 或 OpenCode 的工具调用运行之前（包括 YOLO）拒绝 sudo 及其他提权、curl | sh 和下载后运行、磁盘与格式化命令、fork 炸弹，以及在工作文件夹之外写入或删除（包括 `/tmp`、主目录和删除文件夹本身；agent 自己的计划和记忆文件夹除外），并告诉模型应当改做什么。受信任的插件服务可以声明 `decide`（`decision:provide`），以拒绝、询问或允许回答 `canvastty.decide`：基础保护最先运行，任何拒绝优先，超时或错误会询问用户，允许只有在单独确认 **May allow agent actions** 之后才算数。服务可以声明 `decide.timeoutMs`（1–60 秒，默认 3 秒）：CanvasTTY 会等待这么久，把 `budgetMs` 告知服务，并在启动时按适用的最长预算设置每张卡片的 hook、helper 和网关期限（默认保持现有期限）。示例：`examples/plugins/deny-rm`。一个 agent 从另一个 agent 读取的所有文本（`observe_agent`、`get_agent_result`、control CLI 的屏幕、结果和失败详情）现在都会遮蔽：密钥库中的密钥、启动机密、服务注册（`redaction.register`）或读取（`secrets.get`）的值、被折行拆开的密钥以及常见密钥形式。
- 决策 hook 现在在失败时拒绝执行。只要基础保护开启或有决策插件适用，Claude Code、Codex、Qwen Code 或 OpenCode 的 shell 或写文件调用如果 CanvasTTY 无法检查（socket 不存在或连接被拒绝、未及时回答、回答无法解析、CLI 无法询问时网关自身出错、hook 输入无法读取），就会以 “CanvasTTY safety check unavailable” 拒绝，而不是未经检查就运行。基础保护关闭且没有决策插件时行为不变，已得到回答的调用也不会变慢。
- 基础保护能识别更多命令形式：`do`、`then`、`else`、`if`、`while`、`until` 或 `!` 之后的命令；`env -i`/`-u`/`-C`/`-S`、`stdbuf`、`busybox`/`toybox` applet 以及 `script -c` / `script 文件 命令`；`perl -i` 和 `ruby -i` 原地编辑；`find -L`/`-H`/`-P`/`-O2`/`-f`；`cp`/`mv`/`install`/`ln -t 目录`；`tar -C 目录 -x…` 和 `--directory=`；`unzip -o … -d 目录`；合并写法的 `curl -fsSLo 文件`、`--output=`、位于 `-O`/`-o` 之前或之后的 `--output-dir`（相对的 `-o` 落在其中）、任意写法的 cookie、响应头、跟踪、`--stderr`、`--libcurl`、`--etag-save`、`--hsts`、`--alt-svc` 和 `-w '%output{文件}'` 文件，`wget -qO`/`-qP`、其日志（`-o`/`-a`/`--output-file`/`--append-output`）、`--save-cookies`、`--rejected-log` 和 `--warc-file`；`-o /dev/null` 和 `-D -` 不写文件，不再被拒绝。这些形式在项目外与普通命令一样被拒绝；同一命令中下载后运行，无论输出参数如何书写都算作 download-and-run；项目内的相同形式仍然允许（项目内的 `find -L dir -exec rm {} +` 不再被拒绝）。
- 新增插件 agent 工具、会话事件以及卡片标记和动作。受信任的服务可以提供 `tools`（`tools:agents`），它们以 `<pluginId>__<tool>` 的名字（id 中的点写作 `_`，这是 Anthropic 和 OpenAI 接受的工具名形式）出现在 `canvastty_agents` 中，面向其列出的会话角色（编排器、agent、子 agent；Claude Code、Codex、Qwen Code、OpenCode）；调用携带调用方会话 id，回答经过遮蔽，并限制为 32K 字符和 15 s。服务可以订阅卡片事件（`sessions:events`：created、restored、status、exited、closed，包含文件夹和环境 ref；只有具有 `sessions:read-screen` 时才附带经过遮蔽的输出末尾），通过常规启动流程启动卡片（`sessions:launch`），并且只能向自己启动的卡片输入文本或关闭它们（`sessions:control`；所有权随卡片保存，恢复后依然有效）。具有 `cards:decorate` 时，它可以在卡片上设置纯文本标记，并向匹配卡片（服务商、环境类型、角色）的菜单添加动作；回答以提示形式显示在卡片上。示例：`examples/plugins/collect-demo`（worktree 卡片上的 **Show changes** 和供编排器使用的 `collect-demo__diffstat`）。
- 将“重启后的窗口”改为统一的“重启后的智能体会话”模型：**不保存**、**重新打开窗口**（新会话）或 **继续会话**（原先的“开启”迁移到此项）。Claude Code 和 OpenCode 现在与 Codex 一样，按其 lifecycle hook 报告的 id 继续自己的会话（`claude --resume`、`opencode --session`）；同一文件夹中同一 CLI 的两张卡片不再继续同一个会话。已结束的智能体恢复为停止状态，提供“重启”/“继续”，卡片选项菜单提供 **不恢复此卡片**，会话记录（v2，可读取 v1）不保存 scrollback、提示词或密钥。
- 将代理编排端点改为显式设置（设置 → 代理 → “代理编排端点”，`agentControlEnabled`，默认关闭；`--agent-control` / `CANVASTTY_AGENT_CONTROL=1` 仍可为单次启动强制开启），并在运行时按设置启动和停止端点；启动对话框在 normal/YOLO 配置旁新增 **Orchestrator（编排器）** 角色：会话保留打开对话框时的提供方，环境中携带 `CANVASTTY_CONTROL_CONNECTION` 和 `CANVASTTY_CONTROL_CLI`，使内置 CLI 无需配置即可工作，卡片显示 “Orchestrator” 徽标，恢复会话时保留角色；端点关闭时对话框会先提示并提供开启按钮，而不会静默开启任何内容。端点的 `create` 现在接受所有代理提供方（`codex, claude, qwen, kimi, opencode, hermes, grok, omp, pi`），并在 `create` 和 `list` 响应中为每个工作会话报告 `capabilities { result, menus }`：仅 Codex 两者都为 `true`；其他提供方的 `screen` 没有菜单交互，`choose`/`dismiss` 返回 `NOT_SUPPORTED`，`send` 仅依据 idle 状态，`result` 以 `no_result` 结束。
- 新增原生 Codex 编排 CLI（`agent-control/canvastty-control.mjs`，文档见 `agent/orchestrator/SKILL.md`），通过 `--agent-control` 或 `CANVASTTY_AGENT_CONTROL=1` 启用：本地控制器在项目目录中创建 Codex 会话、发送任务、按屏幕修订号观察有界的终端输出并收集最终回答。每个控制器只能看到自己创建的会话，授权绑定到会话代次，变更 ID 去重，且只有受控会话会启用经过认证的 Stop-hook 结果捕获。不包含自动批准或删除终端的端点。
- 新增可选的 Even G2 伴侣（设置 → 控制 → Even G2，伴侣应用位于 `integrations/even-g2`）：Bonjour 发现、带六位码和显式设备批准的短期 SRP-6a 配对、加密的本地请求与音频、按会话授权、眼镜 HUD 上的有界终端展示、通过固定版本的 transcribe.cpp helper 进行本地语音识别（仅 macOS 随包提供），以及通过现有桌面启动器创建会话。Codex 一轮的最终回答只会送达在伴侣启用期间启动的会话：runtime hook 以单独的会话授权上报，限制为 4000 个字符，gateway 会拒绝任何其他会话的该字段。

- 默认 session 现在拒绝浏览器与设备权限：权限请求、权限检查与设备处理器一律拒绝，因此 plugin 窗口和 shell 无法获得摄像头、麦克风、定位或通知权限。内置浏览器仍保留自身独立的 partition 策略。
- 打包构建新增 Electron fuses 加固：关闭 `NODE_OPTIONS` 环境变量与 CLI inspect 参数，并启用 embedded asar 完整性校验。`runAsNode` 刻意保持启用，因为 provider CLI 与 agent runtime 会通过 `ELECTRON_RUN_AS_NODE` 启动随包分发的 helper 进程；cookie 加密未启用，因为该切换是单向的。
- 新增 renderer 崩溃恢复：renderer 进程丢失时，main 进程记录原因与退出码并重新加载应用界面，而不是留下空白窗口；终端服务与实时会话在恢复过程中继续存活。utility/GPU 子进程丢失也会被记录。
- 新增 scrollback 搜索：聚焦终端卡片后按 `Ctrl+Shift+F` 会在卡片内打开搜索行（输入框、匹配计数、上一个/下一个、关闭）。`Enter` 跳到下一个匹配，`Shift+Enter` 跳到上一个，`Escape` 关闭并把焦点交回终端，因此按键不会泄漏到 PTY。语义摘要模式下该行隐藏。
- 卡片标题未被用户自定义时，标题栏会显示 provider 通过 OSC 0/2 设置的标题；provider 未设置时沿用原有的路径显示。重命名永久优先，而 provider 标题仅用于显示：绝不回写，也绝不持久化。
- 新增画布控件 “Fit to content”：在现有 `0.2–1.35` 缩放范围内为 HOME 区域和每个窗口留出边距并将它们框入视野；空画布则回到 HOME。该命令也可从画布命令面板调用，且没有键盘快捷键。
- 新增方向性聚焦：`Alt+方向键`（macOS 上为 `Option`）把焦点移到该方向上最近的窗口，覆盖终端卡片、内置浏览器与 plugin canvas；目标必须严格位于前方，并以垂直距离打破平局。重命名或捕获快捷键时该手势不会执行，也不影响 `Ctrl+K` 与 `Ctrl+,`。
- 新增框选：在空白画布上 `Shift+drag` 会选中与其相交的所有终端卡片（plugin canvas、内置浏览器与便签不会被检查），拖动任意已选中的终端会以相同位移移动整个选择集；没有位移的按下仍是普通点击。空白画布拖动依旧只做平移。
- 画布命令面板的搜索文本新增 session 路径（cwd），与标签和 provider 并列，因此可以按工作目录找到 session。没有第二个命令面板，也没有新的按键绑定。
- 新增 HOME 关注队列：列出需要确认或已失败的会话，仅由 session snapshot 推导；标题行与显式空状态始终渲染，点击某一行会聚焦该会话。失败详情（触发入口、浮层、复制）已抽出一份共享实现，队列与既有会话行共用。
- 新增关注环：需要确认或已失败的会话所在卡片会显示持续的关注环；General 新增设置 “Notify when attention is needed”（默认开启），只在会话真正转入需要确认或失败状态时发出一次系统通知（绝不用于 done/idle/working/unavailable）：重复 snapshot 与恢复时已看过的失败保持安静，而用户通过重启触发的失败同样会通知。切换该设置会持久化。
- 卡片现在会上报是否渲染实时输出：处于语义摘要模式（缩放低于 0.5）的卡片停止接收流式输出，而其 scrollback 在有界历史范围内保持完整且为准；卡片重新可见时，缺失的输出会被重放一次；如果隐藏期间产生的输出超过有界历史的容量，该段最早的部分已经丢失，重放会如实说明，而不会假装输出是连续的。
- 屏幕上的终端卡片从一个 10 个 context 的池中使用 WebGL 绘制（Chromium 每个 renderer 进程最多允许 16 个）：先是聚焦的卡片，其次是占屏幕面积最大的卡片，再次是最近使用的卡片。离开屏幕、缩放超过 1× 或进入摘要模式的卡片会释放 context；平移或缩放时，池会等镜头停下再调整，因此移动画布不会反复重建 context。其余卡片继续使用 DOM renderer；context 丢失的卡片会回退到 DOM renderer，内容不丢失，并在一段时间内保持该状态。调色板与透明度渲染保持不变。
- 使用滚轮或触控板平移画布时，现在与拖动画布一样由合成器移动已绘制的场景，而不是每一帧都重绘所有卡片；手势停止后场景会重新光栅化。
- Settings → Updates 新增一行自更新，状态如实呈现：idle、checking、update available（含版本号）、downloading（已知时显示百分比）、ready to install 以及 unavailable（dev、offline 或 error）。下载与安装都是显式操作，只有在更新下载完成后才提供 install-and-restart；开发模式下该行报告 unavailable 而不会抛错。
- 仓库密钥审计不再把标识符内部的密钥前缀当作命中，因此 `disk-…`、`task-…` 这类名称不再产生误报，而真实密钥仍会被检出。
- 新增 Cursor、MiniMax Code、Devin 和 Antigravity 智能体（PR #63）。
- 新增提供商 API 密钥、API 配置文件，以及通过编排 MCP 在智能体之间委派任务（PR #64）。
- 插件展示页无需 GitHub 账号即可使用；登录是可选的，只会提高 GitHub 限额（issue #22）。HOME 时钟显示日期（issue #53）。
- 默认会话拒绝网页权限，渲染进程崩溃后会重新加载，较长的智能体回答会保留其轮次，密钥审计也会检查构建产物（来自 PR #35 和 #51）。
## 1.5.2

- 修复调整卡片大小后，Codex 清空并重新绘制历史时终端跳到历史开头的问题。阅读时保留相对滚动位置，位于底部的终端继续跟随新输出。
- 修复不可见卡片中的备用屏幕调整大小后，终端尺寸更新被延迟的问题；卡片回到可见区域时保持输出跟随状态。
- 包含 PR #33、#47 中已合并的 OMP/Pi 提供商，以及智能体通信、启动、插件安装、画布手势和浏览器修复。
- 包含 PR #50 的 Even G2 集成，支持本地配对和语音控制。
- 包含 PR #48、#49 的架构决策文档、`js-yaml 4.3.2` 版本固定和构建依赖更新。

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
