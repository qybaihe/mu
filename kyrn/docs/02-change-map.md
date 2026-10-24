# KYRN 改动地图：决策点挂在 pi 的哪里

> 已于 2026-09-21 更名为 mu（命令 `mu`，标识 μ）。本文是更名前的记录，正文保持原样；新旧名对照见 [10-rename-to-mu.md](10-rename-to-mu.md)。

> 2026-10-24（0.2.5）：Laya 已从 mu 移除。`kyrn/bin/kyrn-judge-local`、`kyrn/local-judge/server.py` 和 `local` 类型的判定器都已删掉，`kyrn/local-judge/` 里只剩 mude 1.0 的 Python 依赖锁。下面的文件地图、启动命令和 provider 列表已按此改过；第 9 节等处仍是当时的记录。

> 2026-09-20 · 基于上游 `earendil-works/pi` 提交 `d1230ea20`（v0.86.0 之后）
> 行号来自对源码的静态阅读（两份测绘 + 我对承重结论的抽查），未逐条运行验证；上游更新后行号会漂移，以函数名为准。
> 决策点编号（A1、B2…）见 [01-jev-integration-brainstorm.md](01-jev-integration-brainstorm.md) §4。

## 1. 现状

### 1.1 分叉布局

```
KYRN/                      = pi 的分叉（git）
  .env                     AI_GATEWAY_API_KEY（上游 .gitignore 已忽略）
  packages/kyrn-judge/     判断内核 + pi 适配扩展        ← 新增
  kyrn/
    bin/kyrn-dev           从源码启动 KYRN                ← 新增
    local-judge/           mude 1.0 的 Python 依赖锁（mude-requirements.lock.txt）
    docs/                  设计文档
    spikes/jev-smoke/      Jev 网关冒烟测试
    spikes/judge-bench/    同一批标注场景上对比任意判断后端
  packages/*               上游原样
```

- 远端 `upstream` = earendil-works/pi；分支 `main` = 上游纯净镜像，`kyrn` = 开发分支。还没有 `origin`（没推到任何地方）。
- **对上游文件的改动面：只有 `package-lock.json` +24 行**（新 workspace 包的条目）。其余全是新增文件。
- 品牌常量暂时不改。pi 官方支持用 `packages/coding-agent/package.json` 的 `piConfig: { name, configDir }` + `bin` 改名（`src/config.ts:480-509`），但会把环境变量前缀一起改成 `KYRN_*`，而上游有 9 个测试文件硬编码 `PI_CODING_AGENT_DIR`。现在用 `PI_CODING_AGENT_DIR=~/.kyrn/agent` 做配置隔离（零源码改动），正式改名留作单独一步。

### 1.2 运行与测试

```bash
kyrn/bin/kyrn-dev                      # 交互模式；自动选 Node ≥22、隔离配置到 ~/.kyrn/agent、加载判断内核扩展
KYRN_JUDGE=mock kyrn/bin/kyrn-dev      # 不联网的假判断后端
KYRN_JUDGE=mude,jev kyrn/bin/kyrn-dev  # 本机的 mude 1.0 先答（mu judge mude install），Jev 兜底
KYRN_JUDGE_MODE=active kyrn/bin/kyrn-dev
```

```bash
cd packages/kyrn-judge && node ../../node_modules/vitest/dist/cli.js --run   # 31 个测试
npm run check                                                                  # 仓库标准关卡，当前全过
```

一次性准备（已做过）：`npm ci --ignore-scripts` → `npm run hydrate:model-data`（模型目录数据被 gitignore，从源码运行前必须生成）。

## 2. pi 运行时主干

主线 CLI 用的是 `Agent` + `agent-loop.ts`。`packages/agent/src/harness/**` 和 `session-backends/sqlite-node` 属于实验性的 pico3 运行时，只被 `coding-agent/src/experimental/{mini,micro}` 引用，**不要往那边挂**。

缩写：`AL` = `packages/agent/src/agent-loop.ts` · `AS` = `packages/coding-agent/src/core/agent-session.ts` · `RUN` = `…/core/extensions/runner.ts` · `ET` = `…/core/extensions/types.ts` · `SM` = `…/core/session-manager.ts` · `IM` = `…/modes/interactive/interactive-mode.ts`

```
用户输入
  IM:3029 编辑器提交 ──► AS:1296 prompt()
     ├─ 扩展命令（AS:1304）
     ├─ input 事件（AS:1267-1285 → RUN:1274）            ◄── A1–A8 预检
     ├─ 技能 / 模板展开（AS:1481）
     └─ before_agent_start（AS:1408 → RUN:1174）          ◄── A5 经验注入、A6 技能披露
循环  AL:162 runLoop
     ├─ prepareNextTurn（AS:582-616）每轮读取实时 model / thinkingLevel   ◄── A3、B7
     ├─ transformContext = context 事件（sdk.ts:391 → RUN:1086）         ◄── B2 遗忘
     ├─ LLM 流（AL:339-425）
     ├─ 工具预检 beforeToolCall = tool_call 事件（AS:508 → RUN:1035）     ◄── B3 风险闸门
     ├─ 执行（AL:732-773；并行模式下预检串行、执行并发）
     ├─ afterToolCall = tool_result 事件（AS:529 → RUN:983）             ◄── B1 准入、B4、B6
     ├─ 结果成为消息（AL:839-852），进上下文（AL:243-246）
     └─ turn_end（AL:249）                                               ◄── B5 漂移监测
收尾  agent_end → agent_settled（AS:662，重试和压缩续跑都结束之后）        ◄── D1–D4
```

## 3. 决策点 → 挂载位置

"够" = 现有扩展 API 足够，零内核补丁。

| 决策点 | 挂在哪 | 现有 API | 缺什么 |
| --- | --- | --- | --- |
| A1–A7 输入预检 | `input` 事件 | 够 | —（**已实现，影子模式**） |
| A3 会话开始选主模型 | `session_start` / 首个 `input` 里 `pi.setModel` | 够 | — |
| A5 经验注入 | `before_agent_start` 返回 `message` | 够 | 经验库本身（新包） |
| A6 技能披露 | `before_agent_start` 里改 `event.systemPromptOptions.skills` | 够 | 每个 prompt 都要重新应用（`AS:1221` 会复位）；被滤掉的技能仍可 `/skill:name` 调用，逃生门现成 |
| A8 插话路由 | `input` 事件 | **不够** | steer / followUp 由按键写死（Enter = `IM:3211` steer，Alt+Enter = `IM:4252` followUp），`InputEventResult`（`ET:881`）没有路由字段。变通：返回 `handled` 再 `pi.sendUserMessage(text, {deliverAs})`，要防递归 |
| B1 工具输出准入 | `tool_result` 事件改写 `content` | 够 | bash 截断时已把完整输出存到 `os.tmpdir()/pi-bash-*.log` 并把路径写进文本（`tools/output-accumulator.ts:19`、`tools/bash.ts:321`），read / grep / find / ls 没有。要做统一的"归档 + 召回句柄" |
| B2 主动遗忘 | `context` 事件 | 部分 | 事件里**没有条目 id**（`ET:689`），返回值不持久，每次 LLM 调用都拿到原始列表。粘性决策要靠扩展按 `message.timestamp` + `toolCallId` 确定性重放。列表里含 `role:"system"` 的提示状态消息，**不能删** |
| B3 风险闸门 | `tool_call` 事件 | 够 | 处理器抛异常 = 工具被拦（`RUN:1035` 无 try/catch）。**判断失败必须自己吞掉** |
| B4 注入筛查 | `tool_result` 事件 | 够 | — |
| B5 漂移监测 | `turn_end` 事件 + `pi.sendMessage` 注入提醒 | 够 | 想"停下来"只有 `ctx.abort()`；`shouldStopAfterTurn`（`AL:258`）在 coding-agent 里没接线 |
| B6 失败自动重试 | `tool_result` 事件替换结果 | **不够** | 替换能做（消息生成前），但扩展**没有"重新执行已注册工具"的 API**（`pi.getAllTools()` 只有元数据）。自己 `createBashTool()` 会绕过用户的 shell 设置和别的扩展的沙箱覆盖 |
| B7 逐轮思考强度 | `turn_end` / `tool_result` 里 `pi.setThinkingLevel` | 够 | 同一次运行的下一个请求就生效；但每次切换都写会话条目并刷 UI（`AS:1809`、`AS:1951`）。`setModel` 会复位思考强度，要先 setModel 再 setThinkingLevel |
| B8 通知路由 | `pi.sendMessage` / `sendUserMessage({deliverAs})` | 够 | 事件源（文件监视、后台任务）要自己建 |
| B9 占位留痕 | 同 B2 | 部分 | 同 B2 |
| C1–C5 蜂群 | 自定义工具 + 子进程 | 够 | 编排器本身（新包）。先例：`examples/extensions/subagent/`。动手前看 `packages/durable`（任务运行时）是否重叠 |
| D1 完成核验 | `agent_end` + `pi.sendUserMessage({deliverAs:"followUp"})` | 够 | — |
| D2–D4 经验写入 / 遗忘 / 反馈 | `agent_settled`、下一个 `input` | 够 | 经验库本身 |
| E1 压缩方式 | `session_before_compact` | 够 | 处理器完全控制摘要和 `firstKeptEntryId`（不校验）；但保留区间只能是**一段连续后缀**，不能挖洞 |
| E2 旁支隔离 | `navigateTree(anchor, {summarize:true})` | 部分 | 只在命令上下文可用（`ET:356-390`），流式输出时会抛错。从事件处理器触发要绕：`agent_settled` 里 `pi.sendUserMessage("/cmd", {expandPromptTemplates:true})` |
| E3 缓存保温 | `cache_warming_decision` 事件 | 够 | 空闲时的续聊概率是**写死的常数 0.15**（`cache-warmer.ts:26,372`），直接用判定器的估计覆盖 |
| E4 代码定位 | `pi.registerTool("locate")` | 够 | — |
| E5 / E6 测试选择、提交检查 | 自定义工具 / `tool_call` 拦 `git commit` | 够 | — |
| F `judge` 工具 | `pi.registerTool` | 够 | — |
| 工具 `intent` 参数 | 逐个覆盖内置工具，或内核一处改 | 部分 | 没有公共基础 schema，7 个工具各有各的（`tools/*.ts`）。一处改的位置：`tools/tool-definition-wrapper.ts:5-20`。注意 bash / read / edit / write 开了严格约束采样：schema 里有 `intent`，模型就**总会**输出它（可能是 null） |

## 4. 需要的内核补丁

按"收益 / 冲突风险"排序。全部是**新增钩子或新增字段**，不改现有行为。

| # | 补丁 | 服务于 | 动哪些文件 | 冲突风险 |
| --- | --- | --- | --- | --- |
| P1 | `tool_result` 结果里加 `retry?: boolean`，`finalizeExecutedToolCall` 回到 `executePreparedToolCall`（保留 UI 流式输出） | B6 | `agent/src/types.ts:89-100`、`AL:775-820`、`ET:1153`、`RUN:983`、`AS:529` | 中（碰 agent-loop） |
| P2 | `InputEventResult` 加 `deliverAs?: "steer" \| "followUp"` | A8 | `ET:881`、`RUN:1274`、`AS:1267-1285`、`AS:1346`、`AS:1528` | 低 |
| P3 | `context` 事件带上条目 id；或在 `buildContextEntries` 里认墓碑条目 | B2、B9 | `SM:405-478`、`core/messages.ts`、`compaction/compaction.ts`（`estimateTokens`、`findCutPoint` 目前看不到占位）、`AS`（状态重建、`getContextUsage`）、`ET`、`RUN`、`docs/session-format.md` | 高（碰会话格式）——**先用纯扩展方案，确认有效再下沉** |
| P4 | 静默切换模型 / 思考强度（不写条目、不刷 UI） | B7、A3 | `AS:1801`、`AS:1936` | 低 |
| P5 | 把缓存状态暴露给扩展：上次请求时间、TTL（`getPromptCacheTtlMs` 没从包入口导出） | §6 缓存感知调度 | `cache-warmer.ts:39-46,141-152`、`sdk.ts:376-395`、`ET`、`RUN` | 低 |
| P6 | 工具 schema 统一加 `intent` | B1 的判断标准 | `tools/tool-definition-wrapper.ts:5-20`、`ET:890` | 低 |
| P7 | `navigateTree` 向事件处理器开放，或加显式的"开旁支 / 回主线"原语 | E2 | `AS:3255-3452`、`ET:310-390`、`RUN:841-878` | 中 |
| P8 | 默认加载内置扩展（现在靠启动脚本的 `-e`） | 产品化 | 启动路径 / `resource-loader.ts` | 低 |
| P9 | `piConfig` 改名 + 同时兼容 `PI_*` 环境变量 | 品牌 | `coding-agent/package.json`、`src/config.ts:500-509` | 低，但要跑全量测试 |

**P3 是唯一的高风险补丁**，而且它有纯扩展的替代方案，所以顺序是：先扩展、拿到回放数据、再决定要不要下沉。

## 5. 影响设计的已验证事实

1. **Codex 模型支持会话中途的 system 消息**（`compat.supportsMidConvoSystemMessages`：gpt-5.4 系、gpt-5.5、gpt-5.6-sol / terra / luna、gpt-6-astra；Anthropic 的 opus-4.8 / opus-5 / fable-5 系；Kimi K3 / K2.6 / K2.7、deepseek-v4-pro）。pi 对这些模型把提示分段的变化作为**原地补丁**追加，不丢缓存；其他模型是整段替换 = 一次缓存未命中。→ A6 技能披露、工具集变化在 Codex 上是便宜的。
2. **OpenAI / Codex 的提示缓存保留 24 小时**（`openai-responses.ts:58-100`，`prompt_cache_key` = sessionId）。缓存几乎不会自然变冷，中段删除永远要付重写后缀的代价。→ "入口准入优先于事后遗忘"在 Codex 上更成立；B2 只在压缩时或经济上划算时执行。
3. Anthropic 只有**一个滚动的会话断点**（`anthropic-messages.ts:1399-1425`）：改动任何早先的消息，后面全部失效。
4. token 估算用的是 provider 上报的 usage，所以在 `context` 里修剪后估算会自动变小；但 `findCutPoint` 看到的仍是未修剪的消息。
5. 会话是只追加的（`SM:1372-1379`）；`CustomEntry` 不进上下文、随分支走、fork 时会被复制——适合放账本和墓碑标记。决策账本现在就是这么存的（`customType: "kyrn.decision"`）。
6. `ctx.modelRegistry.getApiKeyForProvider("vercel-ai-gateway")` 能取到网关 key（`/login`、auth.json 或环境变量）。Jev 的凭据走 pi 自己的凭据体系，不另起一套。

## 6. 脚手架：`packages/kyrn-judge`

零运行时依赖（浏览器层也是：Node 自带 WebSocket 直连 Chrome DevTools）。它同时是一个标准的 pi package（`package.json` 里有 `pi` manifest）。全貌和每个注入点的细节见 [04-injection-points.md](04-injection-points.md)。

```
src/
  types.ts  errors.ts  policy.ts     线上契约（与网关同形）、错误分类、三区间/逃生选项/中性答案
  judge.ts                           单个判断模型：超时、>32 题分片、答案校验；JudgeLike 抽象
  cascade.ts                         多档级联：按"能力档案"路由，逐题升级，不可信的答案中性化
  registry.ts  config.ts             判断模型注册表（jev / typesafe / clm / gateway / http / llm / classifier / mock）+ ~/.kyrn/agent/kyrn.json
  decision.ts  ledger.ts             DecisionSpec（静态或按输入生成题目）+ 引擎（off/shadow/active、decideMany、fail-open）+ 账本
  providers/                         gateway（Jev）· typesafe（System One：TypeSafe、mude 1.0、CLM）· http-judge（任意同协议 HTTP）· llm（任意生成式模型）· mock
  decisions/                         15 个决策规格：input-preflight · skill-disclosure · memory · interjection ·
                                     tool-admission · tool-risk · context-forget · turn-drift · turn-completion ·
                                     notify-routing · swarm-routing · cache-warming · file-locate · browser-step
  hive/board.ts                      蜂群共享白板（只追加 JSONL：消息 / 投递 / 闸门日志）
  compaction/                        无总结压缩（beta）：history（逐字历史模型与序列化）· prune（规则 / 相关度 / 打分 / 预算）
  providers/typesafe.ts              System One 协议：Jev 直连 TypeSafe（`jev` 档在有 TYPESAFE_API_KEY 时走它）、OpenRouter、自建中转，以及 CLM（`clm` 档）
  browser/                           内置浏览器（移植自 browser-use/jev-ultrafast，MIT）：cdp（裸 CDP）· chrome（独立 profile 启动/复用）·
                                     snapshot（页内快照，穿透 open shadow root）· session（观察 / 新鲜度校验 / 执行）· agent（观察→判断→执行循环）
  extension/kyrn-judge.ts            pi 扩展入口 + /kyrn 命令（状态、切换判断模型、切换模式）；`only` 选项可只注册部分功能
  extension/kyrn-browser.ts          只要浏览器的独立入口（给原版 pi 用）
  extension/kyrn-swarm.ts            只要子代理路由的独立入口
  extension/agents.ts                子代理角色加载：内置 agents/*.md + 用户 <agentDir>/agents/*.md（pi subagent 示例的文件格式）
  extension/runtime.ts               共享运行时：引擎、配置、当前轮状态、任务帧替身、writer 模型、节省量统计
  extension/features/                每个注入点一个文件：preflight · skills · memory · interjection · guard ·
                                     admission · forgetting · monitor · completion · notify · warming · swarm · tools · browser ·
                                     hive（困难任务蜂群：女王工具 + 蜂体内的发布/投递闸）· welcome（欢迎页 + 身份 section）· commands（/help /status /doctor /ledger /clear /kyrn）· compaction（beta）
agents/                              内置角色：scout · planner · worker · reviewer · browser · investigator
prompts/init.md · prompts/review.md   pi 提示模板：/init、/review（由扩展通过 resources_discover 注册）
skills/kyrn-browser/SKILL.md         浏览器用法 skill，由扩展通过 resources_discover 自动注册
THIRD_PARTY_NOTICES.md               jev-ultrafast 的 MIT 声明
test/                                105 个测试；features/admission/extension/browser 用 pi 的 faux provider harness 跑真实 AgentSession，
                                     browser.test.ts 还会起真实的 headless Chrome 对本地夹具页面做端到端（没装 Chrome 时自动跳过）
```

规则已经编码进代码的：

- 定义决策时，Choice 题没有逃生选项会直接抛错（除非显式声明选项集是封闭的）。
- 题面版本号必填，改问法必须 +1，账本记录才可比。
- 账本默认只存 state 的 SHA-256，不存原文；要做回放校准或蒸馏时显式打开 `recordState`。
- 发给判定器的 state 和题面先去掉凭据（`src/redact.ts`，在 `DecisionEngine` 里统一做）：只有凭据才有的形状（`sk-…`、`ghp_…`、`AKIA…`、私钥块、JWT、Bearer 令牌、URL 里的密码），名字说明是凭据的赋值（`DB_PASSWORD=…`、`"password": "…"`，值至少 8 个字符），以及本进程里名字像凭据的环境变量的值。看板写手的请求也一样。判定器只回答布尔、选项和分数，不回文本，所以去掉的内容不会让任何映射失效。
- 后端截断或忽略了什么（`warnings`）、实际用的模型（`modelId`）、级联各档答了几题（`tiers`）都进账本。
- 状态里决定性内容放最前；问题要短、具体、单一谓词；小模型优先用"这是什么"的分类式问法而不是"相关吗"的关系式问法（03 文档 §4.2、04 文档 §3）。
- 每个扩展 handler 都包在 `failOpen` 里：功能里的 bug 不能拦住工具或提示。

## 7. 首个接入：OpenAI OAuth（Codex）

pi 自带 `openai-codex` provider，走 ChatGPT Plus / Pro 订阅。登录只能在交互界面里做，需要你本人在浏览器里完成授权：

1. `kyrn/bin/kyrn-dev`
2. 输入 `/login`，选 **ChatGPT Plus/Pro (Codex)**，按提示在浏览器里登录授权。
3. 凭据存到 `~/.kyrn/agent/auth.json`，过期自动刷新。（你机器上已有的 `~/.pi/agent/auth.json` 我没有读也没有动。）
4. `/model` 选模型。当前目录里的 Codex 模型：`gpt-5.5`、`gpt-5.6-luna`、`gpt-5.6-terra`、`gpt-5.6-sol`、`gpt-6-astra`（按价格从低到高是 luna < terra < sol < 5.5 < astra）。目录里还列着 `gpt-5.3-codex-spark`，但 ChatGPT 账号调用它会被 Codex 拒绝（"not supported when using Codex with a ChatGPT account"），不要用它当判断模型或梯队。
5. 随便发一句话，然后 `/kyrn` 看判断内核状态。绑卡之前会显示 `last error: payment_required`，这是预期的；提示本身不受影响。

之后也可以直接：`kyrn/bin/kyrn-dev --provider openai-codex --model gpt-5.6-sol`

## 8. 跟上游同步

```bash
git fetch upstream
git switch main && git merge --ff-only upstream/main
git switch kyrn && git rebase main        # 或 merge
npm ci --ignore-scripts && npm run hydrate:model-data
npm install --package-lock-only --ignore-scripts   # lockfile 冲突时重新生成
npm run check
```

目前唯一会冲突的是 `package-lock.json`，机械可解。动手做蜂群之前读一遍 pi 的 [RFC](https://rfc.earendil.com/keyword/pi/)。

## 9. 下一步

日常入口现在是 `kyrn`（见 04 文档 §10）；`kyrn/bin/kyrn-dev` 只是它的别名。当前 `~/.kyrn/agent/kyrn.json`：`tiers: ["jev"]`（直连）、`modes.default: active`、`features.compaction: true`、`features.preflight.waitMs: 2500`。

0. 浏览器要一个能做 `relate` 题的判断档：现在用 `KYRN_JUDGE=laya,luna kyrn/bin/kyrn-dev …`（`luna` 已在 `~/.kyrn/agent/kyrn.json` 的 `judges` 里），绑卡后换成 `laya,jev`，每步延迟从约 4 s 降到百毫秒级。

1. 你绑卡 → `cd kyrn/spikes/jev-smoke && npm run smoke` → 把真实应答填进 01 文档 §15.4；再把 `kyrn.json` 的 `tiers` 改成 `["laya","jev"]`，同一套决策点直接换成 Jev 兜底。
2. 日常使用：`kyrn/bin/kyrn-dev --provider openai-codex --model gpt-5.6-sol`，默认全 shadow；`/kyrn` 看状态，`kyrn/bin/kyrn-ledger` 回看判定；想让某个点生效就 `/kyrn mode tool.admission active`。
3. 还没接的注入点见 04 文档 §9：任务帧更新器 → `intent`（P6）→ B6 重试（P1）→ B7 → C4 → E1 → E3（P7）。
4. 离线回放（01 文档 §12）和蒸馏路线（03 文档 §4.3）：账本加事后信号回填。
