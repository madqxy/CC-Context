# 数据模型

一份状态，三个消费者：mod 的状态条、侧栏 pane、CLI 的离线报表。字段的**来源**决定了它能不能当精确值用，这张表就是这个仓库的契约。以下形状都在 Claude Code **2.1.322** 上核对过（见 `spike-checklist.md`），不是猜的。

## 宿主合同：$.session.usage()

```ts
usage(options?: { breakdown?: "summary" | "full"; columns?: number }): Promise<UsageReading>
```

```ts
type UsageReading = {
  startedAt: number
  context: {
    window: number            // 恒在：当前模型的窗口大小
    tokens?: number           // 还没有请求时缺席
    percent?: number
    breakdown?: Breakdown     // 仅当 breakdown 被请求、且会话已绑定
  }
  rateLimits: { kind: "five_hour" | "seven_day" | "spend_limit"; percentUsed: number; resetsAt: string }[]
  cost: { usd: number }
}
```

`breakdown: "full"` 与内置 `/context` 同源，形状：

```ts
type Breakdown = {
  categories: { name: string; tokens: number; color?: string; kind?: string; isDeferred?: boolean }[]
  totalTokens: number        // 已用（不含 Free space / Autocompact buffer）
  maxTokens: number          // 窗口
  rawMaxTokens: number
  percentage: number
  autocompactThreshold?: number
  isAutoCompactEnabled?: boolean
  model?: string
  gridRows: unknown[][]      // /context 的方格图
  memoryFiles: { path: string; type: string; tokens: number }[]
  mcpTools: { name: string; serverName: string; tokens: number; isLoaded: boolean }[]
  agents: { agentType: string; source: string; tokens: number }[]
  skills?: { totalSkills: number; includedSkills: number; tokens: number; skillFrontmatter: { name: string; source: string; pluginName?: string; tokens: number }[] }
  slashCommands?: { totalCommands: number; includedCommands: number; tokens: number }
  apiUsage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } | null
}
```

分类名由宿主给（英文：`System prompt` / `System tools` / `Messages` / `MCP tools` / `Free space` / `Autocompact buffer`…）。**不要**自己做翻译映射：名字变了就是宿主换了口径，照抄最诚实。

每个分类还带 `kind`，真机（2.1.322）上见过四种：

| kind | 含义 | 怎么画 |
|---|---|---|
| `used` | 真在窗口里 | 正常一行，占比 = `tokens / maxTokens` |
| `free` / `buffer` | 窗口里空着的部分、给自动压缩留的余量 | 单独一行"空余"，**不**参与"装了什么" |
| `deferred` | 声明了但没加载的工具定义 | 单独一行"未加载"，**不**计入 `totalTokens` |

`totalTokens` = 所有 `used` 分类之和（真机上 73890 + 6149 + 2061 + 8210 = 90310），`maxTokens` 是窗口。所以占比的分母永远是 `maxTokens`，不是 `totalTokens`。

真机上还见过三种"同一个字段两种形状"，读的时候要都认：

- `memoryFiles` / `mcpTools` / `agents`：有时是数组，有时是一个数字（数量）；
- `skills`：有时是 `{ total, included, tokens }`，有时是 `{ totalSkills, includedSkills, tokens, skillFrontmatter: [...] }`；
- `breakdown` 在没有消息时也会返回（只有系统提示词那几类），此时 `context` 里没有 `tokens`/`percent`。

## 渲染事件形状

`ui.render` 的 matcher 是 `{ component }`，事件里带 `surface`、`viewport`、`props`：

```ts
// AbovePrompt（状态条）
{
  component: "AbovePrompt", surface: "terminal", requestId: string,
  viewport: { columns: number; rows: number; isFullscreen?: boolean },
  props: { hasSurvey: boolean; isWorking: boolean; maxRows: number; bodyColumns: number; scroll: { offset: number; bodyRows: number }; view: {} }
}

// Pane（侧栏）
{
  component: "Pane", surface: "terminal", requestId: string,   // = ui.open 的 id
  viewport: { columns: number; rows: number; isFullscreen?: boolean },
  props: { title: string; isFocused: boolean; bodyColumns: number; placement: "dock" | "inline"; scroll: { offset: number; bodyRows: number }; view: {} }
}
```

要点：**可用宽度在 `props.bodyColumns`，不在事件顶层**。P1 把 `e.bodyColumns` 当宽度，所以降级逻辑从未生效（测试 2.1.322 时才暴露）。`hasSurvey` 同样在 `props` 里。

宿主的元素工厂（`$.ui.resolve(e)`，逐 site 不同，必须按需探测）：`Box Text Button Input Select Link Code Markdown Client Raster Image Svg`。

## 子代理事件

| 事件 | 字段 | 用来做什么 |
|---|---|---|
| `tool.call` | `e.agentId`（只有子代理的调用带）、`e.tool`、`e.tool_use_id`；工具参数平铺在事件上 | 子代理的一次调用；**没有** `agentId` 的 Agent/Task 调用是"启动" |
| `turn.step` | `e.agentId` | 子代理的一次模型请求，结果里的 usage 是它自己的窗口 |
| `turn.complete` | `e.agentId` | 这个子代理的回合结束 |

`$.agent.list()` 列的是本会话**正在被引擎追踪的 agent**（子代理与 teammate，模型起的和插件起的都在），每项有 `id / type / description / status / parentId / spawnedBy`，`status` 为 `pending|running|waiting|idle|completed|failed|killed`。**工作流（Workflow）里的 agent 不在其中**。所以事件仍是主线（它给调用数、步数、窗口），列表只做两件事：给出真实状态（取代 90 秒静默推断；`killed` 归入 ✗），以及补出事件从未点名的 agent（如 teammate）。真机 2.1.322 上已验证它可调用并返回数组；列表不可用时（调用失败/非数组）退回事件推断，探针里 `agentList.state` 标 `unavailable`。

`breakdown.agents` 是**定义**，不是运行实例：它是内置 `/context` 的 Custom agents 清单（`{ agentType, source, tokens }`），静态、占上下文；`source` 取 `user` / `project` / 插件名，插件自带的 agent 定义同样计入。运行实例见下面的 AgentRow，两者不要混着读。

## AgentRow

| 字段 | 来源 |
|---|---|
| `id` | `e.agentId` |
| `firstAt` / `lastAt` / `doneAt` | 第一次事件 / 最近一次事件 / `turn.complete` |
| `calls` / `errors` | 该 agent 的 `tool.call` 次数与失败数 |
| `steps` / `input` / `output` / `cacheRead` / `cacheCreate` / `tokens` | 该 agent 的 `turn.step` usage 累加；`tokens` 是它自己的窗口大小 |
| `lastTool` / `lastSubject` | 最近一次调用，以及它的目标（文件名、命令头、pattern…） |
| `launch` | 配对到的启动记录 `{ at, tool, type, description, agentId, doneAt, isError }` |
| `isDone` | `turn.complete` 到了 |

启动配对：`Agent` / `Task` / `Workflow` 且事件**没有** `agentId` 的，是主会话的一次启动。**精确配对**：Agent 工具的返回值里有 `agentId`，以它为准（并校正先前的猜测）。**回退配对**：同步调用在子代理运行期间不返回，返回前出现的第一个 `agentId` 归最早的未配对启动。`async_launched` / `remote_launched` 的调用立刻返回，启动记录不会被记为完成，子代理由自己的 `turn.complete` 收尾。父调用返回 `isError` 即该子代理记为失败。

状态：`failed`（启动报错）> `done`（收到 `turn.complete`）> 宿主列表给的状态（`killed`→`failed`、`completed`→`done`、`idle`/`waiting`→`idle`、`running`/`pending`→`running`）> `idle`（列表里没有它、且 90 秒没有事件）> `running`。

### 编队树

编队视图只是把这些行摆成树，没有第二套数据：

| 字段 | 怎么来 |
|---|---|
| `depth` / `prefix` / `isLast` | 由 `parentId`（宿主列表）或启动记录的 `parentAgentId`（事件）算出的树形；`prefix` 是 `├─` / `│  ` / `└─` 组成的干，超过 4 层只留最近 3 段并在前面加 `…` |
| `kidCount` | 直接子节点数，展开时显示"下辖 N" |
| `totalKids` | 整棵子树的节点数（折叠时行尾的 `(+N)` 就是它） |
| `parentKey` | 父节点的**条目键**（`agent:<id>`），与折叠表同一套键，展开/折叠才能对得上 |
| `folded` | `pane.folded`：被折叠的条目键 → `true`；画之前用 `visibleAgentEntries()` 把折叠节点的子树整段跳过 |
| 全部折叠 | `toggleFoldAll()`：`folded` 非空就清空（全部展开），否则把每个 `kidCount > 0` 的条目键都置 `true`（只剩根） |
| 目的 | `launch.description`（启动它的 Agent/Task 的原话）> 宿主 `agent.list()` 的 `description`；名字（`type`/模型）与目的分两列，不再互相顶替 |
| 宿主报告 | 同步启动的结果里带 `totalTokens` / `totalToolUseCount` / `totalDurationMs`，只在宿主给了的时候显示 |

树形由 `nestRows()` 建：先按 `parentAgentId` / `parentId` 归父，父不在表里的当根，防成环（走不到的行平铺兜底）。

终端宽度按**东亚宽度**算（`charWidth`）：汉字 2 列，制表符 `├─│└`、方块 `█░`、盲文都算 1 列。之前的"非 ASCII 即 2 列"会把每条树线算宽一列，导致右侧被提前裁掉。

子代理的 usage **不进**主会话：不进 `steps`、不进趋势、不进 `breakdown` 的上下文占比。状态条只多一个 `⟳N`。

一个宿主差异：引擎把工具结果**直接**交给 hook（`{ isError, text }`），而测试里的替身会多包一层 `{ result }`。`callResultOf` 两种形状都认，判据是外层有没有自己的 `isError`。

## StepSnapshot（一次模型请求）

| 字段 | 类型 | 来源 | 精度 |
|---|---|---|---|
| `at` | epoch ms | 本地时钟 | — |
| `model` | string | `turn.step` 的 `e.model` | 精确 |
| `input` | number | `usage.input_tokens` | 精确 |
| `cacheRead` | number | `usage.cache_read_input_tokens` | 精确 |
| `cacheCreate` | number | `usage.cache_creation_input_tokens` | 精确 |
| `output` | number | `usage.output_tokens` | 精确 |
| `total` | number | `input + cacheRead + cacheCreate` | 精确（= 这次请求的窗口占用） |

`total` 是那次请求的上下文窗口大小，不是累计消耗。**不要**求和当总用量看。

窗口读数优先级：`usage.context.tokens`（宿主上报，覆盖整个窗口）> 最后一条 `StepSnapshot.total`（请求自己带的量）。状态条用前者，两者都没有时显示 0。

子 Agent 的请求（`e.agentId` 存在）只计数、不进趋势：它们的窗口和主会话不是一个，混在一起画图会误导。计数落在 `state.agentSteps`。

## SessionState（mod 内存）

| 字段 | 说明 | 上限 |
|---|---|---|
| `steps` | StepSnapshot 队列 | 240（超出丢最旧） |
| `agentSteps` | 子 Agent 请求数 | — |
| `tools[name]` | `{ n, ms, errors }`，来自 `tool.call` 前后计时 | 事件名天然有限 |
| `files[path]` | 被读/写/搜的次数 | 不设上限，路径截断到 300 字符 |
| `sections[name]` | 系统提示词分段 → 估算 Token | 40 段 |
| `compactions` | `{ at, before, after, source }` | 40 条 |
| `pendingCompaction` | `{ at, before }`，等下一次请求补 `after` | 1 条 |
| `tokens` / `window` / `percent` | 宿主最近一次上报 | — |
| `usage` / `breakdown` | 宿主原样返回的读数与分解 | — |
| `costUsd` / `rateLimits` | 宿主上报的成本与额度 | — |
| `messages` | `$.session.messages()` 的缓存，仅在估算路径与探针用 | — |
| `pane` | `{ isOpen, isWaiting, tab, offset, bodyRows, expanded }` | — |

生命周期：`session.start` 清空内存，随后尝试从快照恢复（见下）；进程退出即丢弃内存。

### 快照（会话落盘）

重载插件或恢复会话时内存会清空，趋势、压缩标记、工具与文件统计就没了。所以每个**主循环回合结束**（`turn.complete`，有改动时）把这些写成快照，`session.start` 时读回。

| 项 | 做法 |
|---|---|
| 位置 | 会话工作目录下的 `.claude/cc-context/`（相对路径，由引擎按工作目录解析）；目录里自带 `.gitignore`（内容 `*`），不会被提交 |
| 身份 | `$.session.usage().startedAt`：宿主文档写明"恢复的会话取它第一次启动的时间，`/clear` 重新开始"。真机 `claude -p --continue` 已验证恢复前后一致 |
| 文件数 | **固定 8 个槽位** `slot-0..7.json`，按 `startedAt` 取模选槽。引擎没有删除接口，所以靠固定名字限制数量；两个会话撞槽就轮流覆盖，读回时 `startedAt` 不匹配就当没有 |
| 内容 | `steps`（≤240）、`stepCount`、`agentSteps`、`compactions`、`tools`、`files`（≤300 个路径）、`sections`。**不含**对话文本；窗口、组成、成本由宿主重新给；子代理行不存（它们的循环不会跨进程存活） |
| 读回的校验 | `version`、`startedAt` 必须匹配；每个字段按类型过滤，坏数据逐项丢弃；本次运行已有请求时不覆盖 |
| 失败 | 写失败 → 本会话关闭保存（`persist.status = "failed"`），不重试、不影响实时视图；读失败 → 当作没有快照 |
| 隐私 | 文件路径会落盘（权限 0600）；这是唯一敏感项，所以目录自忽略。不想要就删掉 `.claude/cc-context/` |
| 探针 | `/ccx json` 的 `persist`：`status`（`off` 宿主没给开始时间 / `ready` / `restored` / `saved` / `failed`）、`path`、`restored`、`savedAt` |
| 清除 | `/ccx reset` 同时把快照改写成空的，重载不会把它带回来 |

快照的压缩标记靠**请求序号**（`stepNo`）定位，不靠时间戳，所以读回后标记仍在原位。

## 估算规则

```
tokens ≈ asciiChars / 4 + wideChars * 0.75
```

- `wideChars` = 码点 ≥ 128 的字符，中文、全角标点都算。
- 系数来自经验值：英文/代码约 4 字符/token，中文约 1.3 字符/token（即 0.75 token/字）。
- 误差主要来自 JSON、长数字、base64 图片和大量空白，实测 ±10% 量级。**任何 UI 上出现这个数都必须带 ≈**。
- 只在**没有 breakdown** 时使用；有分解就用分解。

## 组成分组

| 分组 | 怎么得到 |
|---|---|
| 窗口内各分类 | `breakdown.categories` 里除 `Free space` / `Autocompact buffer` 之外的项，名字与 token 原样照抄 |
| 空余 | 上面两类单独一行，不参与"窗口里装了什么" |
| 百分比 | `tokens / maxTokens`（窗口为分母，和内置 `/context` 一致） |
| 系统提示词 / 用户消息 / 助手回复 / 工具结果 | 仅在没有 breakdown 时：`prompt.section` + `$.session.messages()` 的字符估算 |
| 未归因 | 估算路径下 `窗口总量 − 估算之和`，下限 0 |

`未归因` 不是错误项，它是"字符估算解释不了的部分"，通常是工具定义的 JSON Schema 和框架注入。**不要**把它按比例摊进其他分组：那样每个数字都变成假的。

## 压缩

有两条证据链，优先级从上到下：

1. `classic.PreCompact` 记下 `before`（当时的窗口读数）；下一次非子 Agent 请求给出 `after`，合成一条 `before → after`；
2. 没有钩子时，相邻两次请求 `total` 下降超过 25% 记一条，标 `source: "inferred"`。

第 2 条会把 `/clear`、切模型、删消息也算成压缩。宁可多报也不要漏报，但 UI 上带"（推断）"。

## CLI 聚合口径

- 请求去重键：`message.id || requestId || uuid`；同一键保留 token 最多的一条（流式写入会重复落行）。
- 日桶按**请求时间**归因，不按会话最后活动时间——否则一个跨天会话会把前一天的量算到今天。
- 成本 = `input × in价 + cacheRead × in价 × 0.1 + cacheCreate × in价 × 1.25 + output × out价`，单价取 `pricing.json`，按模型名子串匹配。
- 子 Agent 请求计入总量与成本（它们真的花钱），但 `sidechain` 单独计数，便于对照。
- 文件名取最后一段路径，`/` 与 `\` 都认：Windows 上写的转录在任何机器上分析都能正确显示。
- 每个日桶额外记 `contextTokens`（每次请求 `total` 之和）、`outputTokens`、`sidechain` 与缓存三项，用来算当天的 `cacheHitRate`；`tokens` 仍保留（上下文 + 输出），报表用拆分后的两项画堆叠柱。
- 每个会话行额外带 `curve`（逐请求窗口，最多 40 点，末点保留）、`cacheHitRate`、`sidechain` 与 `startAt`：报表的迷你曲线和会话级缓存率都从这几个字段来。
- 报表横轴是**日历**：`denseDays()` 从最新一天往前补齐窗口内的每一天，没有请求的日子补 0、不跳列；窗口 = `--days N`（上限 90），未给则 30 天。

## 模块约束（加载器会拒绝的写法）

这些是 2.1.322 的加载器实际执行的规则，踩中任意一条整个模块不加载：

- **`$` 不能赋值、传递、返回、spread 或读取**；只能在调用点写成 `$.noun.event(...)`。所以宿主经 `hostOf($)` 绑成一个对象存起来，`$` 本身不留。
- `on("ui.close")` 等事件名只能注册一次；重复注册直接报错。
- `$.command.register` 只收 `{ name, description, argumentHint?, immediate? }`，`name` 匹配 `[A-Za-z0-9_-]{1,64}`，`description` 必填。
- 渲染钩子只画：`ui.open` / `ui.close` / `ui.invalidate` 一律用 `session.start` 绑定的 host 发起，不在渲染里回调宿主。
