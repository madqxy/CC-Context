# Changelog

版本号与 `.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`package.json` 三处保持一致。

## 0.7.4 — 2026-11-19

- 修复：编队里的每一行都显示 `general-purpose`。成因是 Agent 调用常常不带 `subagent_type`（引擎默认填 `general-purpose`），而名称列只认类型。现在名称按 `name` → 真正选定的类型 → 任务描述的顺序取值，默认类型不再当作身份；`agent.spawn` 上报的 `subagentType` 按 `tool_use_id` 精确并回启动记录，`ⓘ` 里新增类型、名称与宿主 `kind`。
- 测试：引擎侧新增「未命名子代理显示任务而不是默认类型」「agent.spawn 补上调用里缺的类型」两条，共 34 个。

## 0.7.3 — 2026-11-18

- 工程：`typescript` 进 devDependencies（运行时依旧零依赖），`npm install` 后 `npm run typecheck` 开箱可用；`package-lock.json` 一并提交。typecheck 默认静默，`--verbose` 才说明用的是引擎类型还是 fallback。
- 修复：引擎测试里的快照断言写死了 `/`，在 Windows 上路径是 `\`，真实写入却断言不到；改成平台无关的分隔符，2.1.327 上 32 个引擎测试全绿。
- 修复：`npm run test:live` 在 Windows 上找不到 `claude`——npm 装的是 `.cmd` 垫片，`spawn` 不能直接跑；改为自动定位 `claude.exe`（`CLAUDE_BIN` 仍然优先）。
- 验证：`npm run verify` 在 2.1.327（Windows 11）上通过：privacy、typecheck（fallback）、53 单元、32 引擎；`npm run test:live` 19 项全过。
- 修复：状态栏模板在 git 仓库里把分支名打印成字面量 `\033[2m(...)`（`%s` 不解释转义）；改用 `$'...'` 存真 ESC。
- 修复：干净 clone 上 `npm run typecheck` 直接报 TS5083（`extends` 的引擎类型还没生成）。新增 `scripts/typecheck.mjs`：有引擎类型就照旧，没有就写一份等价配置加 `claude-code` 桩声明，跑完即删。
- 修复：恢复会话后每个回合重复写 `.claude/cc-context/.gitignore`；改为每次进程只写一次，且该文件写入失败不再连带关闭快照。
- 修复：CLI 跨转录去重时在遍历 `session.requests` 的同时 splice，可能漏算一条；改为遍历副本。
- 性能：宿主已上报 `breakdown` 时不再拉取整段会话消息（估算分支才需要）。
- 体验：`jq` 缺失时状态栏输出一行 `statusline: jq not found`，不再拼出空段落；`npm run test:live` 在找不到 `claude` 时单行报错退出，不再级联 13 条 FAIL。
- 测试：新增「恢复会话不重写 ignore 文件」「有 breakdown 不拉消息」两条回归，`npm test` 53 个。

## 0.7.2 — 2026-11-17

- 隐私：清除运行期快照与 fixture 里的本机路径；`./ccx --project` 示例改成中性名字。
- 新增 `scripts/privacy-check.sh` 与 `npm run privacy`：机器路径、邮箱、私钥、云凭据、电话/身份证、IPv4（回环除外）出现即失败；已排进 `npm run verify`。
- 文档补充「产物里有什么、没有什么」。

## 0.7.1 — 2026-11-17

- 趋势页从盲文点线改为**方块柱**：柱子从基线长起，顶部用八分格，宽度够时加粗到 2–3 格；压缩标记按柱子真实列对齐。
- `src/chart.mjs`：`brailleLine` / `markerRow` 由 `blockColumns` 取代。

## 0.7.0 — 2026-11-17

- 输入框上方的状态条改为**默认关闭**（`/ccx on` 打开）：常用数字改由底部状态栏承载。
- 新增 `scripts/statusline-command.sh` 模板：把上下文占用与缓存命中并进 `statusLine` 那一行。

## 0.6.2 — 2026-11-17

- README 增加「把上下文数字放进你的状态栏」一节，说明数据来自宿主 stdin，与 mod 无关。

## 0.6.1 — 2026-11-17

- 措辞区分两个概念：组成里的「子 Agent **定义**」（静态、占上下文）与编队里的「子代理」（本会话运行实例）。
- 仪表板的运行列表标题改为「编队」，事件行改为「子代理请求」。

## 0.6.0 — 2026-11-17

- HTML 报表图表化：每日用量堆叠柱、每日成本、缓存命中率折线、逐会话窗口曲线、工具/文件横条；深/浅色自适应，纯内联 SVG。
- 新增 `src/svg.mjs`（纯几何）与 `test/svg.test.mjs`；`summarize()` 增加 `contextTokens`/`outputTokens`/`cacheHitRate`/`sidechain`/`curve` 字段。

## 0.5.2 — 2026-11-17

- 编队页加 `f`（一键全折叠/全展开）与页脚按钮。

## 0.5.1 — 2026-11-17

- 编队支持折叠整棵子树：`▾`/`▸` + 行尾 `(+N)`；`ⓘ` 展开目的全文、宿主报告与状态。
- 修正终端列宽模型：制表符/方块/盲文记 1 列（之前误记 2 列，导致行被提前裁掉）。
- 子代理页签改名「编队」，保留「子代理」别名。

## 0.5.0 — 2026-11-16

- 编队视图：按「谁启动了谁」排成多级树，每行带任务目的与状态；来源为事件 + `$.agent.list()`。

## 0.4.0 — 2026-11-16

- 真机验证闭环：`npm run test:live` 用真实 `claude` 二进制 + 本地端点，不需要账号。
- 按真机观测修正：分类的 `kind`（used/deferred/free/buffer）、`skills` 两种命名、`memoryFiles` 等字段「列表或计数」。

## 0.3.0 — 2026-11-16

- 子代理进程状态：启动配对、每个代理的调用/步数/窗口/结束；状态条 `⟳N`；`/ccx agents`。
- CLI 标出 `agent-*.jsonl` 子代理转录，跨文件重复只算一次。

## 0.2.0 — 2026-11-16

- 侧栏 pane：组成 / 趋势 / 子代理 / 浏览四页，逐项展开与压缩前后快照。
- 组成改用宿主 `$.session.usage({ breakdown: "full" })` 的精确值，估算只作兜底。
- 引入 `claude plugin test` 引擎内测试（真实元素表、按键、命令）。

## 0.1.0 — 2026-11-16

- P1：状态条、`/ccx` 仪表板、离线分析器、`/ccx json` 探针。