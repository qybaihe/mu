# 经验库（`memory`）第二版：判定器深度融合

更新日期：2026-09-23。状态：已实现（harness 分支 `claude/mu-experience-library`，mock 判官测试 `packages/kyrn-judge/test/memory.test.ts`；真实 Jev 的验证脚本还没跑，见 §10）。实现和设计的出入、设计没说时的决定见 §11。第一版（只记用户纠正、按触发条件召回）见 `04-injection-points.md` A5 / D2。

## 1. 要解决什么

第一版的经验库是一个只增不减的 `lessons.jsonl`：用户纠正一次，判定器判断"这是不是纠正或长期规则"，写作模型把它写成"触发条件 + 该怎么做"一行；下次消息到来时，判定器逐条问"这条适不适用"，适用的以一行注入。它有三个缺口：

- **只从用户嘴里学**。代理自己踩坑再爬出来（同一个命令失败三次、换个办法就过了）、子代理报告里的发现、目标模式最终怎么达成的，都没记下来。
- **不整理**。同一件事说两遍就存两条；用户改口了，旧的还在，而且两条都可能被召回、互相打架。
- **不知道有没有用**。一条经验被召回了几十次，模型从没照做，也一直占着召回名额。

用户的话（2026-09-23）："经验库也是一个核心打造的事情，要有一个 Jev 的深度与融合。"

## 2. 原则

- **判定器只做判断，从不生成**：值不值得记、和已有的是不是同一条、这次适不适用、模型照做了没有。写成一行字的活交给 writer 模型；没有 writer 就留用户原话。
- **一行进上下文**：召回的经验仍然一条一行，最多 `maxInjected` 条；经验库再大也不涨提示词。
- **用户的最新说法赢**：新经验与旧经验矛盾时，旧的退役，不问用户。
- **只增不改的文件**：每次变化追加一行（同一 `id` 以最后一行为准），和决策台账一个做法；损坏一行不伤其余。

## 3. 存什么

`<agentDir>/mu/lessons.jsonl`，每行一条：

| 字段 | 说明 |
| --- | --- |
| `id` | 不变 |
| `kind` | `correction`（纠正）/ `preference`（长期规则）/ `pitfall`（踩过的坑）/ `workaround`（绕过办法）/ `fact`（项目事实） |
| `trigger` | 什么情况下适用，一句话；召回时判定器拿它去对新消息 |
| `lesson` | 该怎么做，一句祈使句；注入的就是它 |
| `scope` | `{ cwd }` 只在这个项目；`{}` 到处适用 |
| `source` | `{ origin: "user" \| "outcome" \| "model" \| "subagent" \| "command", session?, turn? }` |
| `status` | `active` / `retired` / `superseded` |
| `supersedes` | 被这条替代的旧 `id` |
| `uses` | `{ recalled, applied, lastRecalled }` |
| `created`, `updated` | ISO 时间 |

读取时按 `id` 折叠，`status !== "active"` 的不进候选。第一版的旧行（没有 `kind`/`status`）按 `correction` / `active` 读，不用迁移。

## 4. 从哪里学（写入侧）

| 来源 | 触发 | 判定器判断 | 谁写成一行 |
| --- | --- | --- | --- |
| 用户纠正 / 规则 | 用户消息到达（第一版已有） | `memory.capture`：纠正？规则？ | writer |
| **代理自己的坑** | 监视器报过原地打转或死路（`runtime.onTrouble`），随后这一轮以通过的检查或达成的目标结束 | `memory.outcome`：`way_out` 布尔：从这一轮的摘要看，最后奏效的办法和一开始的办法不同吗？ | writer：坑（trigger）+ 绕过办法（lesson），`kind: workaround` |
| **模型主动记** | 新工具 `remember({ trigger, lesson })` | `memory.worth`（选择题）：这是 `reusable`（以后还会用上）/ `one_off`（只关这一次）/ `already_known`（提示词或项目文件里就有）；只有 `reusable` 才存 | 模型自己写的，writer 不再改 |
| **子代理的发现** | 子代理报告里以 `Lesson:` 开头的行（角色提示里教它这样写） | 同 `memory.worth` | 原句 |
| `/remember <文字>` | 用户命令（第一版已有） | 不判断，直接存 | 原句 |

`memory.outcome` 一轮最多问一次，且只在这一轮真的出过麻烦时问：不给正常的一轮增加任何调用。

## 5. 整理（写入前）

新经验落盘前，先取同作用域里最像的 K 条（`K = 6`，按 trigger/lesson 的词面重合排序，不调判官），一次请求问判定器 `memory.merge`，每条一个选择题：

> 和 `candidate` 相比，`existing_N` 是 `same`（同一条经验）/ `refines`（新的说得更准或更具体）/ `contradicts`（两者不能同时成立）/ `unrelated`。

- `same`：不存新的，旧的 `uses.recalled` 不动、`updated` 更新。
- `refines`：存新的，旧的记 `superseded`，新的 `supersedes` 指向它。
- `contradicts`：存新的，旧的 `retired`（用户的最新说法赢；模型主动记的不能让用户纠正的退役——只有 `source.origin` 为 `user` 或 `command` 的新经验才能让旧经验退役）。
- `unrelated`：正常存。

## 6. 召回（读取侧）

第一版的做法不变：消息一到就和预检并行问 `memory.recall`（每条一个布尔题），确信适用的注入，最多 `maxInjected` 条。第二版加三件事：

- **候选排序**：同作用域的活跃经验按 `uses.applied` 降序、`updated` 降序取前 `maxCandidates` 条，而不是文件末尾的 24 条。
- **记账**：每条被注入的经验 `uses.recalled + 1`、`lastRecalled`。
- **有没有用**：一轮结束（`agent_end`）时，对这一轮注入过的经验批量问一次 `memory.applied`（每条一个布尔题："从 `turn_digest` 看，助手照 `lesson_N` 做了吗？"），确信是的记 `uses.applied + 1`。召回 ≥ `retireAfter`（默认 8）次而从未 `applied` 的经验自动 `retired`，并展示一条 `memory.retired`。这是规则，不再问判官。

## 7. 子代理

`delegate` / `hive` 给每个任务做简报时，用任务文字再跑一次 `memory.recall`（候选是父会话同作用域的经验），命中的写进简报的"已知经验"一段。蜜蜂不写经验库，只在报告里写 `Lesson:` 行，由父会话按第 4 节处理。

## 8. 界面

命令：

| 命令 | 作用 |
| --- | --- |
| `/remember <文字>` | 存一条（已有） |
| `/lessons` | 列出这个项目能用上的经验：`id 前 8 位 · kind · 召回/照做次数 · lesson` |
| `/lessons all` | 含到处适用的和已退役的 |
| `/forget <id 前缀>` | 退役一条 |

展示事件（桌面端画面板用）：`memory.stored`（已有，载荷是整条记录）、`memory.recalled`（`{ ids, turn }`）、`memory.applied`（`{ ids }`）、`memory.retired`（`{ id, reason }`）、`memory.merged`（`{ id, into, how }`）。桌面端的经验面板直接读 `lessons.jsonl`（按 `id` 折叠），编辑和删除通过追加行完成：改 `lesson` 就追加一行同 `id` 的记录，删除就追加 `status: "retired"`。

## 9. 没做、待定

- `memory.applied` 和 `memory.outcome` 读的轮摘要是经验库自己记的：请求、开头 6 步、最后 14 步、结束语（一轮最多记 48 步，多出来的从中间丢）。中间的步骤看不见；先接受。
- 文件只增不减，记账行（`{ id, uses }`）会让它慢慢变长；读取是增量的（只解析新追加的部分），还没做压实。
- 桌面端：`DECISIONS` 表和各语言文案还不认识四个新决策 id（`memory.outcome` / `memory.worth` / `memory.merge` / `memory.applied`）和四个新展示事件，需要在桌面仓库补。
- 经验按语言 / 工具分作用域（比如"pytest 相关"）：等有真实数据再说。
- 蒸馏成 Laya 可用的分类：召回题是布尔题，本地判官偏软（见 `03-local-judge.md`），先只在 Jev 上开。

## 10. 验证

- 单元测试（mock 判官）：写入折叠、五种来源各一条、`merge` 四种结果、召回排序与记账、`applied` 与退役、`/lessons` / `/forget`、子代理简报里的经验段。
- 真实 Jev：一次脚本跑通"纠正 → 存 → 改口 → 旧的退役 → 召回只给新的"，记录延迟与 token。

## 11. 实现记录：和设计的出入、设计没说时的决定

代码：`src/decisions/memory.ts`（五个决策）、`src/memory/store.ts`（文件、折叠、排序、近邻）、`src/memory/phrasing.ts`（`Lesson:` 行、轮摘要）、`src/extension/features/memory.ts`（接线、工具、命令）。

**判官的题面**（准确措辞在代码里，这里是要点）：

| 决策 | 题 | 选项 / 读法 |
| --- | --- | --- |
| `memory.outcome` v1 | `way_out`（布尔）："Judging by `turn_digest`, is the approach that finally worked different from the one the agent started with, which ran into `trouble`?" | 确信是 → 学；状态字段 `trouble`、`turn_digest`（长的放最后） |
| `memory.worth` v1 | `worth_N`（选择）："What is `lesson_N` to a coding agent that works in this project later?" | `reusable` / `one_off` / `already_known` / `unclear`；状态 `lesson_1…`、最后是 `project_instructions` |
| `memory.merge` v1 | `merge_N`（选择）："Compared with `candidate`, what is `existing_N`?" | `same` / `refines` / `contradicts` / `unrelated` / `unclear` |
| `memory.applied` v1 | `applied_N`（布尔）："Judging by `turn_digest`, did the assistant do what `lesson_N` says?" | 确信是 → 照做；确信否 → 退役规则读它；不确定两边都不算 |
| `memory.recall` v2 | 同 v1 的每条布尔题，只是对着 `task`（子代理的任务）而不是 `user_message` | 两个版本同一个 id、同一个模式开关，账本里分得开 |
| `memory.capture` v2 | 题面不变 | 结果从"记 / 不记"变成 `correction` / `preference` / `skip`，决定 `kind` |

**出入**：

- `memory.worth`、`memory.merge` 各多一个 `unclear` 选项。判定器的规矩：选择题必须有逃生选项，否则无关输入也会被高置信地塞进某个真选项。`unclear` 读作"不存"（worth）和"无关"（merge）。
- 一条 `way_out` 由 writer 写；没配 writer 时用会话自己的模型（thinking 关）写，因为这里没有用户原话可以兜底。两个都没有时，`memory.outcome` 干脆不问。
- 轮摘要不用 `recentTurnDigests`，见 §9。

**设计没说时的决定**：

- `kind`：`/remember` 记成 `preference`（用户立的规则）；`remember` 工具和子代理的 `Lesson:` 行记成 `fact`（判官只判值不值得，不分坑和事实）；`memory.outcome` 记成 `workaround`；第一版的旧行读作 `correction`。
- 逐字相同（忽略大小写和空白）的新经验按规则算 `same`，不问判官；`/remember` 的原话也走这条规则和 merge，但不问 `memory.worth`。
- 近邻（merge 的 K 条）：只取同作用域（本项目或到处适用）的活跃经验，按共同词数 ÷ 两者中较短的词数排序，至少共一个词。词 = 三个字母以上、去掉少量虚词；中日韩文字按相邻两字切。
- 一条用户的新经验同时和一条旧的 `same`、和另一条 `contradicts`：矛盾的退役，然后按 `same` 处理（新的不存）。模型或子代理的新经验遇到 `contradicts`：新的不存，展示 `memory.merged`（`how: "contradicts"`，`into` 是站得住的那条），工具结果写明原因。
- 退役规则只读判官在 active 模式下的确信"否"：shadow、off、判官失败都不会让经验退役；照做过一次（`applied > 0`）的永不自动退役。`retireAfter: 0` 关掉退役，`applied: false` 连问题一起关。
- 记账只追加 `{ id, uses }`，不动 `updated`（`updated` 只表示写入、确认或改状态），并且按记账那一刻的文件读，另一个会话刚记过的不会被覆盖。
- 子代理简报的召回（§7）不记账：简报不是父会话的一轮，父会话也看不见子代理照没照做。展示仍是 `memory.recalled`，载荷多一个 `task`。它和路由并行问，最多等 `waitMs`。
- 子代理进程里（`KYRN_SWARM_DEPTH`）经验库整个不启用：不写文件，也没有 `remember` 工具。角色文件教它写 `Lesson: <什么时候> -> <该怎么做>`；父会话从 `delegate` / `hive` 结果的 `details.reports` 里读，每个结果最多 8 行，一次 `memory.worth` 请求判完，再逐条过 merge（两只蜂学到同一件事只存一次）。
- `memory.worth` 的 `project_instructions` 是这一轮交给代理的上下文文件（AGENTS.md 等），最多 6000 字符。
- 展示事件：`memory.retired.reason` 是 `unused` / `contradicted` / `forgotten`；`memory.merged` 在 `same` 时的 `id` 是新经验本来会有的 id（它没有被存）。
- `/forget` 只认本项目和到处适用的经验；前缀对上多条时列出来让用户多给几位；已退役的会说明。`/remember` 不带文字时等同 `/lessons`。`/lessons all` 把已退役、已替代的也列上，活跃的在前。
- 注入了 `config` 或 `provider`、又没给 `roots` 和 `memory.path` 的调用方（测试、嵌入），经验只存在内存里，随会话结束。
- 文件读取是增量的：记住读到的偏移、inode 和 mtime，只解析新追加的部分；文件被替换或变短就从头读；最后一行没有换行也算，等换行来了再读一次结果不变。追加时如果文件末尾没有换行，先补一个。

## 12. 真实 Jev 验证记录（2026-09-23）

§10 的第二条：用 `packages/kyrn-judge` 的 `DecisionEngine` 加内置 `jev` 判定器（active 模式），把 §4–§6 的每种问题各问一遍，脚本只在会话草稿区，不入库。15 次调用全部与预期一致，合计 5.2 s、6412 输入 token；前两次 600–720 ms 含建连，之后每次 250–300 ms。

| 判定 | 输入 | 结果 | 用时 / token |
| --- | --- | --- | --- |
| `memory.capture` v2 | "别用 npm test，这个仓库要用 ./test.sh 跑测试"（上一句助手说它跑了 npm test） | `correction` | 722 ms / 349 |
| | "好的，继续" | `skip` | 607 / 329 |
| `memory.merge` | 同一条换个说法 | `same` | 300 / 466 |
| | 更具体的说法（多了"跳过需要凭证的 e2e"） | `refines` | 292 / 473 |
| | 改口："用 npm test，test.sh 删了" | `contradicts` | 267 / 460 |
| | 装依赖的经验 | `unrelated` | 307 / 459 |
| | 改口 vs [旧经验, 装依赖] | `contradicts`, `unrelated` | 553 / 632 |
| `memory.recall` v1 | "跑一下测试，看看有没有挂的" vs [新经验, 装依赖] | 新经验 | 247 / 316 |
| | "装一下依赖再跑" | 装依赖 | 266 / 310 |
| | "把 Button 组件改名成 ActionButton" | 无 | 269 / 315 |
| `memory.worth` | vitest 找不到测试要在包根目录跑 / 登录测试挂在第 42 行 / 只暂存明确路径（AGENTS.md 已写） | `reusable`, `one_off`, `already_known` | 281 / 828 |
| `memory.applied` | 摘要里 `npm test -> ok` vs "用 npm test" | 照做 | 274 / 341 |
| | 摘要里 `./test.sh -> ok` | 没照做 | 270 / 342 |
| `memory.outcome` | 三次 npm test 失败后换 ./test.sh 通过 | `learn` | 249 / 399 |
| | 三次失败靠改代码通过，办法没变 | `skip` | 254 / 393 |

结论：题面不用改。§10 第一条的单元测试在 `test/memory.test.ts`（28 个）。还没跑的是整条链在真实会话里的样子（纠正 → 存 → 改口 → 退役 → 召回），等用户用新内核跑几轮后看台账。
