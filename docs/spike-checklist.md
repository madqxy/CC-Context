# 实机验证记录（Claude Code 2.1.322）

这份文件代替了 P0 时期的"待确认清单"。清单里的三个未知点已经用真实引擎回答完了，下面是答案和怎么复现。

前置：Claude Code **2.1.322**（`claude --version`），mods 未被组织策略关闭。

## 怎么验证的：claude plugin test

Claude Code 自带一套 mod 测试运行器：

```bash
cd CC-Context
claude plugin test .
```

它把 `hooks/hooks.json` 里的模块按真实宿主的方式加载，提供 `$.` 调用与 `on` 注册，跑目录下所有 `*.test.ts` / `*.test.tsx`。测试直接从 `claude-code/testing` 取 `describe / test / expect / mock`：

```ts
import { describe, expect, test } from 'claude-code/testing'

test('...', async ($, on) => {
  on('session.start', (_h, e) => ({ cwd: e.cwd }))   // 宿主层：被测模块之下的那一层
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const tree = await $.ui.render({ component: 'AbovePrompt', /* … */ })
})
```

两条关键能力：

- **`$.ui.mount(input)`**：把插件画出来的元素树交给终端的**元素表**校验。宿主拒绝的某个 prop 或元素，在真实会话里表现为"这棵树静默不画"，在这里表现为 `surface` 不是 `terminal`。这是 P1 缺的那个检查。
- **`$.ui.press({ plugin, key })`**：按插件画的 `Button` 的 `key` 触发它的 `onPress`，用来验证交互（切标签、展开、翻页、关闭）。

```bash
# 输出（2026-11-16，2.1.322）
# 24 pass
# 0 fail
```

## 三个未知点的答案

### 1. 事件与用量形状

| 检查项 | 结果 |
|---|---|
| `turn.step` 的结果带 `usage` | ✅ `{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }`；流式 chunk 是 `{ kind: "text" \| "thinking" \| "tool" \| "input" \| "stop" \| "engine", index, … }`，结果还要回 `turnId` / `index` / `answer` / `toolUses` |
| 窗口与组成 | ✅ `$.session.usage({ breakdown: "full" })` 直接给精确分解（分类、记忆文件、技能、MCP、子 Agent、斜杠命令、自动压缩阈值），形状见 `data-model.md` |
| 额度与成本 | ✅ 同一个调用带 `rateLimits`（5h / 7d）与 `cost.usd` |
| 子 Agent 请求 | ✅ `e.agentId` 存在时只计数 |
| 会话消息 | ✅ `$.session.messages()` 返回 `{ role, text, toolUses }` |

**P1 的错误**：以为 Claude Code 没有上下文分解 API，于是整条组成路线按字符估算做。实际上 mod 合同里就有，和内置 `/context` 同源。P2 已改为"精确优先，估算兜底"。

### 2. 系统提示词能否抓到

`prompt.section` 仍然保留，但它只服务于**估算兜底**路径（没有 breakdown 时）。有 breakdown 时，"系统提示词"就是宿主给的一个分类，不需要抓事件。

### 3. 状态条能不能画

| 检查项 | 结果 |
|---|---|
| 元素树被终端接受 | ✅ 30 / 44 / 60 / 96 / 160 列全部 `mount → terminal` |
| 宽度降级 | ✅ 40 列以下只留百分比；40+ 出大小；58+ 出增量；76+ 出缓存与条；96+ 出"详情"按钮 |
| `Box` / `Text` 的属性 | ✅ `flexDirection / paddingX / columnGap / justifyContent / flexWrap`、`bold / dimColor / color / children` 都被接受 |
| `props.bodyColumns` | ✅ 宽度在 `e.props.bodyColumns`，**不在** `e.bodyColumns`。P1 读错了位置，降级从未生效 |
| 侧栏 | ✅ `$.ui.open({ id, title })` 返回 `{ isPlaced, reason }`；`ui.render` 的 `Pane` 事件带 `props.{ title, isFocused, bodyColumns, placement, scroll.bodyRows }`；`ui.close({ id })` 关闭并回调 `ui.close` 钩子 |
| 按键 | ✅ `Button({ key, hotkey, plain, onPress, children })`；`$.ui.press({ plugin, key })` 能触发 |

### 4. 子代理能不能看见

| 检查项 | 结果 |
|---|---|
| `tool.call` 带 `e.agentId` | ✅ 子代理发起的调用带；主会话自己的调用没有 |
| `turn.step` 带 `e.agentId` | ✅ 带；它那次请求的 usage 就是子代理自己的窗口 |
| `turn.complete` 带 `e.agentId` | ✅ 到达，可以据此收尾 |
| 运行中的 agent 列表 API | ✅ `$.agent.list()` 列子代理与 teammate（含 `status` / `parentId`），真机返回数组；❌ 工作流里的 agent 不在其中，仍靠事件（此前"只列定义"的结论是错的，已更正） |
| 按 agent 中止 | ❌ 没有这种调用；只能看不能停 |

顺带一个测试环境的差异：引擎把工具结果**直接**交给 hook（`{ isError, text }`），而测试替身返回的 `{ result }` 会原样透传。`callResultOf` 两种都认，所以同一份代码在两边都对。

## 真机进程验证（2026-11-16）

除引擎内测试外，还有一条**跑真实 `claude` 二进制**的检查：

```bash
npm run test:live
```

它做三件事：起一个本地 Anthropic 兼容端点（只回文本 + usage，可要求一次 Read 调用）、用 `CLAUDE_CONFIG_DIR` 指向临时目录隔离用户设置、然后在里面跑 `claude -p ... --plugin-dir .`。不需要账号，也不花钱。

一次通过的实际输出：

```text
  ok   the probe answered with JSON
  ok   the host reported a window (1000000)
  ok   the host reported a breakdown
  ok   the breakdown has categories (7)
  ok   every category carries the host kind (used/deferred/free/buffer)
  ok   free space is its own kind, not counted as content
  ok   the binary ran /ccx panel (exit 0)
  ok   /ccx panel answered
  ok   the binary ran a turn with a tool call (exit 0)
  ok   the model answer came back
  ok   the transcript holds the real usage blocks (2)
```

真机跑 `/ccx` 的样子（1M 窗口、未发请求时）：

```text
窗口   90.3k / 1M     9%   剩余 909.7k
组成（宿主精确上报，单位 token）
  System prompt   ██████████████████  73.9k   7%
  System tools    █░░░░░░░░░░░░░░░░░   6.1k   1%
  Skills          █░░░░░░░░░░░░░░░░░   2.1k   0%
  Messages        ██░░░░░░░░░░░░░░░░   8.2k   1%
  空余 Autocompact buffer 33k · Free space 876.7k
  未加载 System tools (deferred) 84.8k
明细   技能 13   （/ccx panel 展开逐项）
```

真机暴露、而引擎内测试给不出的三件事（都已修）：

1. 分类带 `kind`（`used` / `deferred` / `free` / `buffer`），`deferred` 不计入 `totalTokens` —— 之前只按名字猜"空余"，会把没加载的工具算进窗口；
2. `skills` 在不同调用下返回 `{total, included}` 或 `{totalSkills, includedSkills, skillFrontmatter}` 两种形状；
3. `memoryFiles` / `mcpTools` / `agents` 可能是数组，也可能是一个数字。

另外两条行为在真机上确认：头less（`-p`）里 `$.ui.open` 会回 `{ isPlaced: false, reason: "no-surface: …" }`，插件的提示语按 reason 原样带出；`/ccx tab 子代理` 这种中文标签也能切换。

## 没做到的：真实交互会话

这台机器上的 `claude` 没有登录（`claude -p …` 回 `Not logged in · Please run /login`），所以**没有跑过一次带界面的真实会话**。引擎内测试已经覆盖了模块加载、每个宿主调用的形状、元素树被终端接受、按钮按下后的行为；它覆盖不到的是"人在真终端里看到什么"。

第一次有账号的机器上，按下面的"还需要人眼"走一遍即可。

## 还需要人眼的部分

自动化能证明"终端接受这棵树""按钮真的能按"，证明不了"看起来舒服"。这些留给人：

| 项 | 期望 |
|---|---|
| 深色/浅色终端 | `green / cyan / blue / magenta / red` 都可辨 |
| 全屏渲染模式 | 状态条不被通知行覆盖；侧栏停靠宽度合适 |
| `/ccx` 不污染上下文 | 按 `Ctrl+O` 看转录：只有会话记录，没有 `/ccx` 文本 |
| 压缩 | 手动 `/compact`，再 `/ccx` 看"事件 压缩"是否 +1 且带 `before → after` |

## P1 到 P2 修掉的四个实际缺陷

1. `e.bodyColumns` → `e.props.bodyColumns`（宽度降级从来没生效过）；
2. `e.hasSurvey` → `e.props.hasSurvey`（有问卷时状态条该让位）；
3. "没有分解 API"的结论错误（见上），组成改为宿主精确值；
4. Windows 转录在 POSIX 上 `path.basename` 切不掉反斜杠，文件名显示成整条路径。

另外一条不是缺陷、但会致命：加载器**不允许把 `$` 存起来**（`state.host = $` 会让整个模块不加载）。宿主必须经 `hostOf($)` 绑成对象，见 `hooks/cc-context.mjs`。
