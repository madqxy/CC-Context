# CC-Context

Claude Code 的上下文透视工具，对标 [dsh-context](https://github.com/bowenliang123/dsh-context) 的 `Context` 面板与 `/context` 命令。

它回答三个问题：

1. **现在窗口里装了什么** —— 系统提示词 / 工具定义 / 消息 / 记忆文件 / 技能 / MCP / 子 Agent 各占多少；
2. **它怎么长起来的** —— 逐请求的窗口大小、缓存命中、什么时候被压缩、压缩掉了多少；
3. **会话之外的账** —— 跨会话的日用量、成本、工具与文件热度。

## 三个部件

| 部件 | 形态 | 作用 |
|---|---|---|
| `hooks/cc-context.mjs` | Claude Code **mod**（插件） | `/ccx` 打印仪表板；`/ccx panel` 打开侧栏（组成 / 趋势 / 编队 / 浏览）；`/ccx json` 导出探针；提示框上方一行状态条**默认关闭**，`/ccx on` 才画（日常数字建议走底部状态栏，见下） |
| `cli/ccx.mjs` | Node 命令行 | 扫 `~/.claude/projects/**/*.jsonl`，出跨会话报表 / JSON / 单文件 HTML（内联 SVG 图表） |
| `test/engine/ccx.test.ts` | 引擎内测试 | 用 `claude plugin test` 在真实引擎里画条、开侧栏、按键、执行命令 |

实时数字来自宿主上报，不靠猜：窗口、缓存、成本、额度、以及**上下文组成**都由 `$.session.usage({ breakdown: "full" })` 给出，和内置 `/context` 同源。只有宿主没有上报分解时（老版本、没有会话）才退回字符估算，并且明确标出 ≈。

## 安装（mod）

需要 Claude Code **v2.1.287+**（mods 从该版本起可用），并且 mods 未被组织策略关闭。本仓库在 **2.1.322**（macOS/Linux）与 **2.1.327**（Windows 11）上验证过。

从 GitHub 安装（marketplace 需要 2.1.275+；mod 本身仍需上面的 2.1.287+）：

```text
/plugin marketplace add madqxy/CC-Context
/plugin install cc-context@cc-context
```

一步写完也行：`/plugin install cc-context --marketplace madqxy/CC-Context`。装完执行 `/ccx`，看到仪表板就说明生效。

本地开发或试用：

```bash
# 只在本次会话加载，不写入任何配置
claude --plugin-dir /path/to/CC-Context

# 确认加载：会话里执行
/plugin
# 应看到 "1 mod active · cc-context"
```

进入会话后提示框上方会出现一行（宽度不够时自动降级）：

```text
◧ 30%  60.8k / 200k  +1.2k  cache 98%  ██░░░░░░  详情
```

`/ccx` 打开仪表板：

```text
CC-Context · 上下文透视
──────────────────────────────────────────
窗口   60.8k / 200k    30%   剩余 139.2k
请求   14 次 · 缓存命中 100% · 输出累计 5.6k
最近   入 60.8k（读 60.7k / 写 0）· 出 400

组成（宿主精确上报，单位 token）
  ███████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   █ 已用  ▒ 缓冲  ░ 空余
  Messages               ███▊················    38k  19%
  System prompt          █▎··················  12.4k   6%
  System tools           ▉···················   9.2k   5%
  MCP tools              ▏···················   1.2k   1%
  空余 Free space 137k
明细   记忆文件 1 · 技能 12 · MCP 工具 4 · 子 Agent 2   （/ccx panel 展开逐项）

趋势
  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⠤⠔⠒⠉⢆⠀⠀⠀⠀⠀⠀⣀⡠
  ⣀⡠⠤⠤⠤⠒⠒⠉⠉⠁⠀⠀⠀⠀⠀⠈⠢⠤⠒⠒⠉⠉⠀⠀
                  ▲       
  12.1k → 60.8k · 峰值 84.2k · ▲ 压缩

工具
  Read 5 · 12ms   Edit 3 · 9ms   Bash 2 · 1.4s (1 失败)

文件
  app.ts ×5 · app.test.ts ×2

事件   压缩 1
       14:22:07  84.2k → 21k  -75% （推断）
额度   5h 42% · 7d 18%
成本   $3.86（宿主上报）

精度   窗口/成本/额度/上下文分解均取自宿主上报；工具耗时来自本地计时
```

## 侧栏（P2）

`/ccx panel` 在终端里停靠一个侧栏，四个标签页（组成 / 趋势 / 编队 / 浏览）：

```text
▪组成 ▫趋势 ▫编队 ▫浏览                              关闭
组成（宿主精确上报，单位 token）
███████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
■ System prompt                                 12.4k   6%
■ System tools                                   9.2k   5%
■ Messages                                       38k  19%
■ MCP tools                                      1.2k   1%
合计 60.8k / 200k · 已用 30%
空余 Free space 137k
自动压缩阈值 155k · 距阈值 94.2k
▸ 记忆文件 (1)
▸ 技能 (12)
▸ MCP 工具 (4)
▸ 子 Agent 定义 (2)
▸ 斜杠命令 (1)
↑ ↓ 1-4 切换 · j/k 翻页 · 0 关闭 · Esc 回输入框
```

（纯文本里看不出颜色：真实侧栏里每个分类的 `■` 和对应那段条是同一种颜色，合计行按占用率从绿到红变色，接近自动压缩阈值时阈值那行变红。）

**侧栏的按键只在它拿到键盘时生效。** `/ccx panel` 会请求焦点（输入框为空时通常会给）；没拿到、或你按 `Esc` 回到输入框之后，用 `ctrl+x tab` 或鼠标点一下侧栏再操作。侧栏底部那一行会按当前状态告诉你该怎么做（未聚焦时显示"未聚焦：ctrl+x tab 或点击侧栏后…"）。鼠标点击需要终端处于全屏渲染模式。

| 操作 | 作用 |
|---|---|
| `1` `2` `3` `4` | 切到组成 / 趋势 / 编队 / 浏览 |
| 点标题（或 `k` / `j` 上下翻页） | 展开/收起一栏的逐项明细：记忆文件、技能、MCP 工具、子 Agent 定义、斜杠命令、提示词分段、文件、工具 |
| `0` | 关闭侧栏（也可以用 `/ccx close`） |

"逐项展开"是真明细，不是占位：展开"记忆文件"看到路径与 token，展开"技能"看到技能名与所属插件，展开"MCP 工具"看到服务名/工具名，展开"子 Agent 定义"看到类型与来源。

## 会话快照（重载后趋势不丢）

趋势、压缩标记、工具与文件统计是 mod 在运行中从事件里攒的，重载插件或恢复会话时内存会清空。所以每个回合结束后，mod 把它们写进会话工作目录下的 `.claude/cc-context/slot-N.json`，下次启动**同一个会话**时读回，仪表板会注明"其中 N 次从快照恢复"。

- 只认同一个会话：以宿主上报的会话开始时间为准，`/clear` 之后是新会话，不会读到旧的。
- 文件数有上限：固定 8 个槽位，旧的被覆盖，不会越攒越多。
- 里面**没有对话文本**，但有被读写过的文件路径；目录自带 `.gitignore`（内容 `*`），不会进你的仓库。不想要就删掉这个目录。
- `/ccx reset` 会把快照一起清空；`/ccx json` 的 `persist` 字段能看到保存状态。

## 编队（本会话的 agent 树）

主会话里每启动一个 Agent/Task，侧栏的 **编队** 标签页就多一行——**按"谁启动了谁"排成树**，每个节点带它自己的**任务目的**和状态（也可以 `/ccx agents` 直接看）：

```text
CC-Context · 编队 运行 4 · 共 4
  ▾ ● Plan             plan                                      0步 2调 0 29ms ⓘ
  ├─ ▾ ● Explore          dig one                                0步 1调 0 27ms ⓘ
  │  └─   ● Explore          sweep                                 0步 1调 0 26ms
  └─   ● Explore          dig two                                          — 29ms
```

把 `Plan` 那一行折叠起来，就只剩：

```text
  ▸ ● Plan             plan (+3)                                 0步 2调 0 37ms ⓘ
```

（引擎测试里真实渲染的行；耗时是测试墙钟时间，真实会话是秒级。）

- **树线**：`├─` / `│` / `└─`，层级不限；超过 4 层把最左边的干缩成 `…`，保证当前分支仍在屏幕内。
- **折叠子树**：有子节点的行前面是 `▾`，点一下变 `▸` 并藏起整棵子树，行尾标 `(+3)` 说明藏了多少行；再点展开。
- **一键全折叠**：`f`（页脚那颗 `▾全`/`▸全`）——当前有任何折叠就全部展开，否则把每一棵有子节点的树都折叠，只剩根节点；大编队一眼看清有几支。
- **看明细**：`ⓘ` 打开这一行自己的信息——目的全文（自动换行）、步数/调用数/自身窗口、宿主报告（token/次数/耗时）、宿主状态（折叠时也能点）；叶子行没有子节点，点行本身就是看明细。
- **目的列**：来自启动它的那次 Agent/Task 调用（`description` / `prompt`），没有就用宿主 `$.agent.list()` 的 `description`。
- **状态**：`●` 运行、`✓` 完成、`✗` 失败（父调用报错或宿主 `killed`）、`◌` 静默（90 秒无事件且宿主列表也没说在跑）。优先级：宿主列表 > `turn.complete` > 静默推断。
- **归属**：父调用返回的 `agentId` 精确配对；`async_launched` / `remote_launched` 立即返回，子代理自己用 `turn.complete` 收尾；拿不到 id 时才退回"先启动先配对"。
- 子代理的 token 记在它自己名下：**不进**主窗口读数、**不进**趋势、**不摊**进主会话的上下文占比。
- 只有启动记录、没看到它自己事件的行，调用数显示 `—`（它可能跑在另一个进程里）。
- `/ccx agents` 打印**整棵**树（忽略折叠状态），方便复制到别处。
- 状态条在有条目运行时多一段 `⟳2`；快捷键 `3`，`/ccx tab 子代理` 也仍然可用（"编队"是标签名，"子代理"是别名）。

限制说清楚：这套 API 只能**看**，不能**停**——引擎没有暴露"按 agentId 中止"的调用。

> 别和**组成**里的「子 Agent 定义」混了：那个是内置 `/context` 的 Custom agents——**静态**的定义清单（`breakdown.agents`，形如 `agentType · tokens (source)`），只说明有多少定义占着上下文，`source` 是 `user` / `project` / 插件名，插件自带的定义照样算。编队这里是本会话**运行过的实例**，来自事件与 `$.agent.list()`。两个数字互不相干，仪表板也分行写着「编队」和「子 Agent 定义」。

## `/ccx` 的参数

| 参数 | 作用 |
|---|---|
| 无 | 完整仪表板 |
| `panel`（也认 `pane` / `open`） | 打开侧栏 |
| `agents` | 编队树：运行 / 静默 / 完成 / 失败，各自的调用数、步数、token 与任务目的 |
| `close` | 关闭侧栏 |
| `tab <组成\|趋势\|编队\|浏览>` | 切换侧栏标签页（也认 `tab 子代理`；不打开侧栏） |
| `on` / `off` | 开关提示框上方的状态条（**默认关闭**；底部状态栏那套数据由 `scripts/statusline-command.sh` 负责，与之无关） |
| `reset` | 清空本会话统计 |
| `json` | 导出探针：窗口、分解、逐请求、压缩前后、额度、成本、消息结构样例 |

`/ccx` 用 `immediate: true` 注册，Claude 正在生成时也能执行；返回的文字只打印在你的转录里，不额外消耗 Claude 的上下文。

> 注意：`/context` 是 Claude Code 内置命令，不能覆盖，所以这里用 `/ccx`。
## 把上下文数字放进你的状态栏（可选）

状态条（`/ccx on` 才画的那行）在输入框上方。它的数字在**底部状态栏**也能拿到，而且不必改 mod——Claude Code 给 `statusLine` 命令的 stdin 里本来就有这些数（和内置 `/context` 同源）：`context_window.used_percentage` / `total_input_tokens` / `context_window_size` / `prompt_cache.hit_ratio`。

`scripts/statusline-command.sh` 是一个现成模板，输出形如 `目录 (分支) · 模型 · 42% 84.2k/200k · cache 91%`，占用率按 50/75/90 变色（与状态条同一套颜色）。装上：

```bash
cp scripts/statusline-command.sh ~/.claude/statusline-command.sh
# settings.json（用户级）：
# "statusLine": { "type": "command", "command": "bash \"$HOME/.claude/statusline-command.sh\"" }
```

只依赖 `jq` 与 `awk`；没发过请求时自动只显示前两段（`目录 · 模型`）。

**两条边界**：

- 这是**你的脚本**在读宿主给的数据，mod 没有参与；mod 不能往那一行画元素树（引擎可渲染的组件表里没有状态栏组件），`$.ui.status()` 是插件自己的另一行。
- 本会话的**子代理实例数**（`⟳N`）不在这份 stdin 里，所以模板里没有它。要加只能让脚本自己翻 `transcript_path` 的尾部，或让 mod 写一个「最后写者赢」的文件——两条都会引入延迟或串台，默认不做。

## 安装（CLI）

无依赖，Node 18+：

```bash
node cli/ccx.mjs                        # 最近会话总览
node cli/ccx.mjs --days 7               # 近 7 天
node cli/ccx.mjs session a1b2c3d4       # 单会话逐请求明细
node cli/ccx.mjs --project demo      # 按目录过滤
node cli/ccx.mjs --json > usage.json
node cli/ccx.mjs --html report.html     # 单文件网页报表（图表见下）
```

转录目录默认 `~/.claude/projects`；装在别处时设 `CLAUDE_CONFIG_DIR`。Windows 上写的转录在 Linux/macOS 上分析也能正常显示文件名（路径分隔符两种都认）。

### 网页报表里画了什么

`--html` 写出的是**一个自包含文件**（内联 SVG + CSS，无脚本、无外链、无字体下载），图表全部由转录算出来：

| 图 | 内容 |
|---|---|
| 每日用量 | 上下文（入 + 缓存读/写）与输出**堆叠柱**，按窗口补齐没有请求的日子（补 0，不跳过） |
| 每日成本 | 估算成本的柱状图，刻度是美元 |
| 缓存命中率 | 每天的命中率折线（0–100%） |
| 会话表 | 每行一根**逐请求窗口曲线**（长会话均匀采样到 40 点，末点保留），加上请求数、上下文总量、命中率、成本、目录 |
| 工具 / 文件 | 按次数排的横条，长度按占比 |

深色/浅色跟随系统（`prefers-color-scheme`）；每根柱子、每个点都有原生 `<title>` 悬浮提示；窗口默认 30 天，给了 `--days N` 就跟随 N（上限 90）。


### 产物里有什么、没有什么

- 会话快照写在 `.claude/cc-context/`（工作目录下），里面**有被读写过的文件路径**；目录自带 `.gitignore`（内容 `*`），本仓库的 `.gitignore` 也忽略了它，打包时排除。
- `npm run privacy` 是发布前的门：机器路径、Windows 用户目录、邮箱、私钥、云凭据、电话/身份证、IPv4（回环除外）出现即失败。新增文件后先跑它。
**它画不出什么**：分类级分解（系统提示词 / 工具 / 技能 / MCP / 记忆）。那是宿主现场算的 `$.session.usage({ breakdown })`，不落转录——这份离线报告拿不到，别指望它。要精确分解只有实时侧栏。

**CLI 的成本是估算**：单价写在 `cli/pricing.json`，出厂值只是示例，请按你的合同/官网核对。缓存读按输入价 0.1 倍、缓存写按 1.25 倍计算。（mod 里的成本不是估算：那是宿主上报的 `cost.usd`。）

## 精度：哪些数是准的

| 数据 | 来源 | 精度 |
|---|---|---|
| 窗口占用、输入/输出/缓存命中 | `$.session.usage()` | **精确** |
| 上下文组成（分类、记忆文件、技能、MCP、子 Agent、斜杠命令） | 同一个调用的 `breakdown` | **精确**（与内置 `/context` 同源） |
| 成本、额度（5h / 7d） | `cost.usd` / `rateLimits` | **精确**（宿主上报） |
| 请求次数、压缩次数 | `turn.step` / `classic.PreCompact` | **精确**；无钩子时用窗口骤降推断，并标"推断" |
| 工具调用、耗时、失败、文件 | `tool.call` 事件 | **精确** |
| 子代理（启动、调用数、步数、各自窗口、结束） | `tool.call` / `turn.step` / `turn.complete` 的 `agentId` | **精确**；只有"静默"是 90 秒无事件的推断 |
| 分类的 kind（哪些在窗口里、哪些是空余、哪些没加载） | `breakdown.categories[].kind` | **精确**（真机 2.1.322 有 `used` / `deferred` / `free` / `buffer`） |
| 组成（宿主没有上报 breakdown 时） | 字符数 × 估算系数 | **≈ ±10%** |

估算只在拿不到宿主分解时才出现，界面上会写 ≈ 和"按字符估算"。不会把说不清的部分摊进别的分类。

## 结构

```text
CC-Context/
├─ .claude-plugin/
│  ├─ plugin.json               插件清单
│  ├─ marketplace.json          单插件 marketplace（可 /plugin marketplace add）
│  └─ types/                    引擎生成的 mod 类型声明（每次加载重写，已 gitignore）
├─ hooks/
│  ├─ hooks.json                指向 mod 入口
│  └─ cc-context.mjs            采集 + 宿主读数 + 侧栏 + /ccx + 可选状态条（无构建）
├─ src/
│  ├─ estimate.mjs              估算/格式化纯函数（mod、CLI、单测共用）
│  ├─ chart.mjs                 堆叠条、方块柱（趋势）、色阶（mod、单测共用）
│  └─ svg.mjs                   报表几何：坐标、柱、堆叠、迷你曲线（CLI、单测共用）
├─ scripts/
│  ├─ statusline-command.sh      可选的底部状态栏模板（读宿主的 statusLine stdin）
│  ├─ privacy-check.sh           发布前扫描：机器路径 / 邮箱 / 凭据 / 号码
│  └─ typecheck.mjs              tsc 包装：没有引擎类型时用桩声明照常自检
├─ assets/icon.png              插件图标
├─ cli/
│  ├─ ccx.mjs                   离线分析器
│  └─ pricing.json              单价表
├─ test/
│  ├─ estimate.test.mjs         估算器
│  ├─ chart.test.mjs            图表纯函数
│  ├─ svg.test.mjs              报表几何
│  ├─ cli.test.mjs              CLI 端到端（test/fixtures 里的手写转录）
│  ├─ mod.test.mjs              假宿主：hook 链路、PreCompact、快照、仪表板
│  └─ engine/ccx.test.ts        真引擎：画条、开侧栏、按键、命令（claude plugin test）
├─ test/live/run.mjs            真机检查：跑真实 claude 二进制（本地端点）
├─ tsconfig.json                类型检查配置（extends 引擎生成的 types/tsconfig.json）
├─ package.json                 npm test / test:engine / test:live / typecheck
├─ LICENSE                      Apache-2.0
└─ docs/
   ├─ data-model.md             数据模型、宿主合同与字段来源
   └─ spike-checklist.md        2.1.322 实机验证记录
```

`hooks/cc-context.mjs` 没有打包步骤，加载器直接执行它，所以它只 import 两个**纯函数模块**：`../src/estimate.mjs`（`estimateTokens` `human` `humanDuration` `bar` `sparkline` `padRight` `percent`，mod 与 CLI 共用）和 `../src/chart.mjs`（`allocateCells` `blockColumns` `levelColor` `eighthBar`，堆叠条、趋势方块柱与色阶用）。两者都必须保持纯函数、无依赖、不碰 Node API —— 一个失败的 import 会让整个 mod 静默不加载；`npm run test:live` 用真二进制验证它能被加载，`npm test` 覆盖这两个模块的算术。

## 验证状态

- **逻辑层：已跑通**。`npm test` 53 个测试全绿：估算器、图表几何、CLI 端到端（对 fixtures 里一份 Windows 路径的手写转录，含报表结构断言：内联 SVG、逐会话曲线、无外链、无 NaN），以及 `test/mod.test.mjs` —— 假宿主走完注册、`turn.step`、工具调用、`/ccx off/on`、PreCompact 前后快照与仪表板。
- **真机层：已跑通**。`npm run test:live` 直接跑**真实的 `claude` 二进制**：临时配置目录隔离用户设置 + 本地 Anthropic 兼容端点，不需要账号也不花钱。19 项检查全过：hooks 模块被真引擎加载、`/ccx json` 拿到真宿主读数、`/ccx panel` 在无 surface 时给出宿主的原因、一次真实工具调用走到 `tool.call` 钩子、转录里落下真实的 usage。
- **引擎层：已跑通**。`npm run test:engine`（即 `claude plugin test .`）在 Claude Code **2.1.322** 与 **2.1.327**（Windows 11）上 32 个测试全绿：
  - 状态条在 30/44/60/96/160 列下的降级与 **`$.ui.mount` 通过**（mount 会把元素树交给终端的元素表校验，任何它拒绝的属性都会失败——这正是 P1 没能做的检查）；
  - 侧栏在 24/40/60/100 列的 body 宽度下都能挂载；
  - 按钮真的能按：`/ccx panel` 打开、`tab:trend` / `tab:browser` 切换、`section:memory` 展开收起、`scroll-down` 翻页、`close` 关闭；
  - 子代理：启动配对、调用与步数、`turn.complete` 收尾、父调用报错标 `✗`、子代理的窗口不动主会话读数；
  - 真机上报的三种形状：分类的 `kind`、`skills` 的两种命名、`memoryFiles` 等字段"列表或计数"两种形态；
  - 命令返回值、`/ccx json` 的字段、压缩前后快照、额度与成本都按宿主给的数断言。
- **类型层：已跑通**。`npm run typecheck` 走 `scripts/typecheck.mjs`：引擎生成过 `.claude-plugin/types/tsconfig.json` 时直接 `tsc -p .`；干净 clone 上该文件还不存在，脚本会写一份等价的本地配置加 `claude-code` 的桩声明再检查（`$`/`on` 变成 `any`，本仓库自己的代码照常查），跑完即删。编译器来自 devDependencies 里的 `typescript`（`npm install` 即可；也可以设 `TSC` 指定别的）。走了哪条路径默认不打印，`node scripts/typecheck.mjs --verbose` 可以看到。`npm run verify` = privacy + typecheck + npm test + 引擎测试。
- **隐私：已扫过**。`npm run privacy` 扫绝对家目录、Windows 用户目录、邮箱、私钥、云凭据、电话/身份证、IPv4（回环除外）；干净时才退出 0。`npm run verify` 把它排在第一位。
- **还差人眼**：颜色与间距在真实终端里的观感、宽屏下侧栏停靠的舒适度。mount 只证明"终端接受这棵树"，不证明"好看"。

## 路线图

- **P1（已完成）** 状态条、`/ccx` 仪表板、离线分析器、探针。
- **P2（已完成）** 侧栏 pane（组成 / 趋势 / 子代理 / 浏览四标签）、逐项展开到明细、压缩前后快照、精确组成替代估算、引擎内测试。
- **P2.5（已完成）** 子代理进程状态：启动配对、每个代理的调用/步数/窗口/结束、状态条 `⟳N`、`/ccx agents`。
- **P2.6（本次）** 真机验证闭环：`test:live` 跑真实 `claude` 进程；按真机上暴露的三种形状修正分类与明细的读法。
- **暂缓：模型计费**。CLI 的单价表与成本估算留在原地（数字带"示例价格"提示），不再往这个方向投入；mod 里那行"成本"是宿主直接给的 `cost.usd`，不是本工具算的，留着不占维护成本。
- **P2.8（本次）** 编队视图：多级树（`├─│└`，层级不限）、任务目的独立成列、逐节点展开（目的全文 / 宿主报告 / 宿主状态）；终端宽度改按东亚宽度计算。
- **P2.7（已完成）** 会话快照：重载/恢复会话后趋势、压缩标记、工具与文件统计不丢（`.claude/cc-context/`，固定 8 个槽位，见 `docs/data-model.md`）；侧栏请求焦点；组成改为堆叠条 + 色阶，趋势改为**方块柱**（第八格填充，带压缩标记）。
- **P3.2（本次）** 状态栏集成：`scripts/statusline-command.sh` 把上下文占用与缓存命中并入引擎的状态行；提示框上方的状态条改为**默认关闭**（`/ccx on` 打开），不再默认占一行。
- **P3.1（本次）** HTML 报表图表化：每日用量堆叠柱、每日成本、缓存命中率折线、逐会话窗口曲线、工具/文件横条；几何抽成 `src/svg.mjs` 并单测。
- **P3（下一步）** 跨会话的 fleet 视图（编队已是本会话的，跨会话的还没做）。

## 与 dsh-context 的差异

- dsh-context 读 DSH 官方的 token 计量投影；CC-Context 读 Claude Code 的 mod 合同 `$.session.usage({ breakdown: "full" })`。**两者都是精确值**，差别在于落点：DSH 是 Web 侧栏 + 富图表，Claude Code mod 只能画终端元素树。
- Claude Code 多了 dsh-context 没有的：订阅额度（5h / 7d）、宿主上报的会话成本、自动压缩阈值，以及 `prompt_cache` 健康度（命中率、miss 归因）—— 后者目前只在状态行 JSON 里，mod 合同还没暴露，等它出现再接。
- 想要图表，走 CLI 的 `--html` 那条路。

## License

Apache-2.0（与 dsh-context 一致）。

作者：[madqxy](https://github.com/madqxy)。署名以此为准：`plugin.json` 的 `author`、`marketplace.json` 的 `owner`、`package.json` 的 `author` 与 `LICENSE` 的版权行都写同一个身份。
