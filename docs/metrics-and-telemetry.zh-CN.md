# 指标与遥测

[English](metrics-and-telemetry.md) · [Русский](metrics-and-telemetry.ru.md) · [简体中文](metrics-and-telemetry.zh-CN.md) · [文档首页](README.zh-CN.md)

CanvasTTY 把遥测首先看作真实性问题，其次才是可视化问题。如果数据源无法证明数值，再漂亮的进度条也是错的。

## 不要混淆不同的度量

| 度量 | 含义 | 示例来源 |
|:--|:--|:--|
| 订阅配额 | 服务商定义的时间窗口内的用量及其重置时间 | 官方账户用量端点或结构化 CLI 协议 |
| 会话 token | 归属于单个会话的 input、output 和 cache token | 结构化的服务商生命周期或用量事件 |
| 成本 | 在已知模型与价格来源下实际计费的金额 | 官方计费/用量记录，而不是用猜测的价格去乘 token 数 |
| 已用时间 | 从已知会话时间戳起算的墙钟时长 | 本地单调时钟/墙钟，加上真实的生命周期时间戳 |
| 活动状态 | 智能体是正在工作还是需要批准 | 结构化的服务商生命周期信号 |

订阅百分比无法从会话 token 推导；token 数量本身不能证明成本；PTY 输出也不能证明活动状态。

## 目前已实现的功能

[`LimitsService`](../src/main/services/LimitsService.ts) 通过结构化适配器读取服务商的订阅窗口：

- Codex 通过已安装 CLI 的 app-server 协议。
- Claude 和 Kimi 在已安装 CLI 的凭据与账户类型支持的情况下，通过各自的只读用量端点读取。
- 60 秒缓存；在曾经成功读取的前提下回退到 stale 数据。
- 只返回经过脱敏处理的 `available`、`stale` 或 `unavailable` snapshot；原始凭据和服务商 payload 绝不跨越 IPC。

CanvasTTY 绝不会通过解析服务商的终端 UI 来还原限额。不支持的订阅类型会明确保持 unavailable。

## 用量历史

打开 **Usage history**，选择报告时段，查看配额实测变化、按应用 → 配置 → 会话
分组的条件估算，以及本地 token 计数。报告时段不是配额窗口；主窗口与周窗口分别展示。

- CanvasTTY 运行期间，每分钟采集一次 Codex/Claude 配额观察值。
- Codex、Claude Code 的本地日志及 Hermes 数据库仅以只读方式访问。
  Hermes 需要 `PATH` 中支持 `-safe` 的 SQLite CLI；缺少来源会明确报告，不记为零。
- 历史与读取游标一起原子保存至 Electron 标准 `userData` 目录中的
  `usage-history.json`，最多保留 30 天、500,000 条事件。
- 自动估算按会话 token 权重分配可比较区间的实测变化，条件是**本地记录的活动解释了该变化**。
  这不是服务商的计费公式，也不能证明费用来自某个账户。外部活动的贡献仍未知。
- 未完成的采集、尚未稳定的事件、重置、账户切换和观察缺口会明确标注。
  不能根据 token 总数还原过去的配额百分比。
- 只有记账元数据传给主渲染进程，历史中不包含提示词、回答或凭据；插件不能访问此历史 API。

下面的会话 token API 仍是建议的扩展契约。内置历史使用
[`UsageHistory`](../src/shared/usageHistory.ts)，而不是该公开契约。
Electron 验证命令：`node scripts/smoke-usage-ui-packaged.mjs --app <package>`。

## 数据源优先级

使用可获得的最高等级来源；没有可信来源时就停下来：

1. 与 session ID 绑定的结构化服务商事件或本地协议。
2. 带稳定标识符的官方服务商用量 API。
3. 有文档、面向自动化的 CLI JSON 输出。
4. 带具体原因的 `unavailable`。

不要抓取 ANSI 输出，不要根据终端文本推断工作状态，不要按字符数估算 token 还标成实际值，也不要向渲染进程暴露认证数据。估算值只能以单独命名的 estimate 形式存在，并清楚标明计算方法与不确定性；它绝不能替代真实的用量字段。

## 建议的会话 token 契约

可辨识联合（discriminated union）可以防止不可用数据伪装成零：

```ts
type SessionMetricSource =
  | "provider-event"
  | "provider-usage-api"
  | "cli-json";

type SessionMetricUnavailableReason =
  | "unsupported-provider"
  | "not-authenticated"
  | "not-reported"
  | "timeout"
  | "protocol-error";

interface SessionTokenValues {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number;
}

type SessionTokenUsage =
  | {
      sessionId: string;
      provider: AgentProviderId;
      state: "available";
      source: SessionMetricSource;
      fetchedAt: number;
      values: SessionTokenValues;
    }
  | {
      sessionId: string;
      provider: AgentProviderId;
      state: "stale";
      source: SessionMetricSource;
      fetchedAt: number;
      failedAt: number;
      reason: SessionMetricUnavailableReason;
      values: SessionTokenValues;
    }
  | {
      sessionId: string;
      provider: AgentProviderId;
      state: "unavailable";
      checkedAt: number;
      reason: SessionMetricUnavailableReason;
    };
```

如果来源只能可靠地报告 total，子字段就保留为 nullable；绝不要去推算不存在的 input/output 拆分。创建 snapshot 之前，必须校验每个计数都是有限、非负且在安全范围内的值。

## Token 小组件的数据流

```text
结构化服务商来源
        ↓
主进程适配器
  validate · normalize · cache · bind to session ID
        ↓
经过脱敏的 SessionTokenUsage snapshot
        ↓ 白名单 IPC + 类型化的 preload
渲染进程中的纯选择器
        ↓
Home 小组件或终端卡片摘要
```

主进程适配器负责认证、超时、服务商各自的 schema、并发去重和清理；渲染进程只负责展示和本地选择。如果服务商无法将用量绑定到具体的 CanvasTTY 会话，就不要把账户级 token 归入该会话。

## 小组件行为

- 仅在状态为 `available` 或 `stale` 时显示紧凑的总数数字。
- stale 数据要有明确标记，不能用零代替；来源时间戳要保留给辅助文本或详情展示。
- 使用本地化的 unavailable 原因文案，而不是一条空进度条。
- 只有存在真实的分母时，才使用确定进度的进度条。单纯的 token 用量通常没有分母。
- 累计与会话总量要同服务商配额窗口分开。
- 被动的 Home 指标不应捕获鼠标滚轮。
- 历史记录必须按数量或时间设上限；聚合不得无限占用渲染进程内存或持久化状态。

## 隐私与安全

- 只返回计数和最少的来源元数据，不返回 prompt、response、终端缓冲区、账户 token、cookie 或原始服务商 payload。
- 服务商凭据只能由可信的主进程读取，也只能发送到对应的官方端点。
- 记录日志前对子进程 stderr 脱敏；服务商工具可能输出敏感路径或标识符。
- 避免逐按键的遥测，优先使用服务商上报的聚合值或粗粒度的生命周期事件。
- 让网络超时与子进程终止行为明确，避免失效的适配器阻塞应用退出。

## 缓存与新鲜度

刷新频率应由数据语义决定，而不是动画需要。订阅配额可以容忍一分钟的缓存；会话 token 可以在结构化的 completion/message 事件到达时更新。对并发刷新去重。短暂失败后可以把最后一个有效 snapshot 保留为 `stale`，但不能在没有显示数据年龄或过期策略的情况下无限期保留。

## 测试矩阵

至少覆盖以下范围：

| 范围 | 用例 |
|:--|:--|
| 规范化 | 完整 payload、仅含 total 的 payload、零 token、格式错误/负值/非有限值 |
| 标识 | 正确的会话绑定、未知会话、服务商不匹配、不含 session key 的账户级响应 |
| 状态 | loading、available、stale fallback、unavailable 原因、首次读取错误 |
| 生命周期 | 并发刷新去重、超时、子进程清理、会话销毁 |
| 安全 | snapshot 和日志中不含凭据/原始 payload，只走白名单 IPC |
| 展示 | 不虚构分母、保留 stale 标签、unavailable 文案已本地化、滚轮保持被动行为 |

先针对适配器和纯选择器运行聚焦的单元测试，然后运行 `npm test`、`npm run typecheck` 和 `npm run build`。最后在真实的 Electron 窗口中，以正常缩放和缩小状态检查小组件。

关于实现位置与视觉规则，见[小组件编写](widget-authoring.zh-CN.md)。
