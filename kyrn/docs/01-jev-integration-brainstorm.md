# KYRN × Jev 深度整合构思（v0.1）

> 已于 2026-09-21 更名为 mu（命令 `mu`，标识 μ）。本文是更名前的记录，正文保持原样；新旧名对照见 [10-rename-to-mu.md](10-rename-to-mu.md)。

> 2026-10-21：判定器已不止 Jev 一个（还有本地的 Laya、自托管的 System One 服务、LLM 判定器等）。正文里泛指判定器的地方已改称"判定器"/"判定模型"；Jev 只指 TypeSafe 托管的那个模型，事实卡、实测和生态项目名保持原样。

> 2026-09-20 · 构思稿，待讨论
> 基座：[earendil-works/pi](https://github.com/earendil-works/pi)（MIT，原 badlogic/pi-mono）
> 判断模型：`typesafe-ai/jev`，经 Vercel AI Gateway 调用
> 写法说明：判断模型的名字统一写 Jev（大写 J，小写 e 和 v）。

## 0. 一句话

KYRN 是 pi 的深度二开：把 harness 里所有的"选择题"从主模型和死规则手里拿出来，交给一个统一的判断内核；主模型只负责思考和写作。目标是**用最小的上下文做最正确的事**。

awesome-jev-projects 首页的一句话可以直接当 KYRN 的设计信条：**把思考留给大模型，把选择题交给 Jev。**

---

## 1. Jev 事实卡

| 项 | 内容 | 来源可信度 |
| --- | --- | --- |
| 出品 | TypeSafe AI，"System One" 系列第一个模型，当前 `jev-1.13.0`，2026-09-15 前后发布 | 多处社区帖一致 |
| 本质 | 状态进、带类型的概率出。**不生成任何文本** | 官方说明 |
| 三种题型 | **Noul**（经 AI SDK 调用时类型名是 `boolean`）：是非题，返回 0–1 概率 · **Choice**：闭集单选，返回选中项 + 每个选项概率 · **Score**：有序量表，返回从 0 开始的小数位置 + 概率。精确契约见 §15.2 | **已核实**（`ai@7.0.107` 类型定义） |
| 批量 | 单请求 ≤32 题、≤64 KiB JSON；同一请求内各题**并行且互相隔离**，多问几题几乎不加延迟和费用 | pi-typesafe README |
| 价格 | $0.042 / 百万输入 token，输出免费 | **已核实**（AI Gateway 模型目录） |
| 上下文窗口 | 32000 | **已核实**（AI Gateway 模型目录） |
| 数据政策 | 零数据留存、不用于训练（目录标注 `zdr: all`、`no_training: all`） | **已核实**（同上） |
| 延迟 | 社区实测 100–500ms；有人报告 5 题一次约 800ms | 社区帖 |
| 调用通道 | ① Vercel AI Gateway：AI SDK `experimental_evaluate({ model: 'typesafe-ai/jev', state, questions })`，鉴权 `AI_GATEWAY_API_KEY`（**KYRN 当前用这条**）② 直连 `api.typesafe.ai`，官方 SDK `typesafe-sdk-js` ③ OpenRouter `typesafe/jev-1.13` | 官方/目录站 |
| 官方资源 | docs.typesafe.ai/primitives · `typesafe-ai/skills`（★810，出题技能）· `system-one-adapter-python`（用 LLM 模拟同一接口的替身，可做降级） | GitHub |

**已知失败模式**（设计时必须绕开）：

1. Choice 没有"以上都不是"选项时，会以 1.00 的置信度选一个错的。→ 每个 Choice 必带 `none/other`。
2. 问法敏感：同一件事用 Noul 问和用 Choice 问，概率不同；"结论式"问法比"状态里写了什么"式问法差。→ 题面要版本化、要做回归评测。
3. 不擅长多步前瞻（社区对比：眼前风险规避很好，后果延伸到几步之后就不如 LLM）。→ 规划永远留给主模型。
4. confidence 描述的是分布集中度，不是正确性。→ 阈值要在自己的数据上校准。
5. 32K 窗口。→ 只给它看摘要和元数据，不给原文大段。

### 1.1 调用方式验证结果

见 [§15 Spike 记录](#15-spike-记录vercel-ai-gateway-调用验证)。

---

## 2. 核心论点

### 2.1 harness 里的判断今天是怎么做的

| 方式 | 问题 |
| --- | --- |
| 死规则（阈值、正则、固定流程） | 便宜但不懂语义：上下文到 90% 才压缩、所有技能描述永远塞在 system prompt 里、所有提醒无差别注入 |
| 问主模型自己 | 懂语义，但每问一次都要重读全部上下文、判断过程本身又污染上下文、而且是"自己给自己打分" |
| **判定模型**（如 Jev） | 懂语义、约 0.3 秒、几乎免费、在主上下文之外、是独立于主模型的第二双眼 |

第三条路打开之后，harness 可以负担得起**每一轮做几十个微判断**，而这些判断一个 token 都不进主上下文。

### 2.2 双系统

```
                ┌──────────────────────────────────────────────┐
                │  主模型（System 2）：思考 · 规划 · 写作        │
                │  上下文 = 最稀缺的资源                         │
                └───────────────▲──────────────────────────────┘
                                │ 只有通过闸门的内容才进来
   ┌────────────────────────────┴─────────────────────────────┐
   │  KYRN harness（丘脑）：组装上下文 · 执行工具 · 调度蜂群     │
   │     规则层（免费、确定）→ 灰区交给 ↓                        │
   │  ┌────────────────────────────────────────────────────┐  │
   │  │ 判断内核（System 1 = 判定模型）                     │  │
   │  │ 准入 · 遗忘 · 路由 · 披露 · 风险 · 通知 · 核验        │  │
   │  │ 每个判断：类型化题面 → 概率 → 本地阈值策略 → 入账     │  │
   │  └────────────────────────────────────────────────────┘  │
   └──────────────────────────────────────────────────────────┘
```

### 2.3 五条设计铁律

1. **判定器判断，代码执行，主模型思考。** 判定器的输出只是本地策略的输入，它从不直接改动任何东西。
2. **规则优先，判定器管灰区，拿不准就升级。** 能用确定性规则定的不调用判定器；判定器给的概率落在中间区间就弃权，走保守默认或交给主模型/用户。
3. **判定器的错误必须便宜且可逆。** 上下文侧：拿不准就保留，每次修剪都留可召回的占位。安全侧：判定器只能加闸（多确认、拒绝），不能拆闸（替用户放行）。判定器不可用时整体退回 pi 原生行为。
4. **入口准入优先于事后遗忘。**（原因见 §6）
5. **每个判断都入账。** 题面版本、状态哈希、概率、采取的动作、事后结果，全部记录，可回放、可校准。

---

## 3. 两个基石

### 3.1 任务帧（Task Frame）

判定器的判断只和标准一样好。"这段输出相关吗？"——相对什么相关？

KYRN 需要一份始终最新、约 200 token 的**任务帧**：目标、约束、当前子目标、完成标准。它是几乎所有判定调用共用的 state 头部，也是压缩时的锚点、子代理任务书的头部。

- 谁来写：判定器不做生成性的活。由小模型在后台从用户消息推导，子目标切换时更新；不占主模型上下文。
- 再配一个**逐调用意图**：要求主模型每次调用工具时附一句 `intent`（约 10–20 token）。它是工具输出准入（B1）的判断标准。

没有任务帧，每次判断都得把大段对话塞给判定器去猜目标：又贵、又吵、还会撞 Jev 的 32K 上限。

### 3.2 决策账本（Decision Ledger）

每次判断记一条，存为 pi 会话里的 `CustomEntry`（`pi.appendEntry`）。事后信号都是**免费标注**：

- 被删的内容后来被召回了 → 这次修剪是误删
- 注入的经验主模型确实用上了 / 完全没用
- 路由到小模型后又被迫升级
- 用户下一句是纠正还是认可

有了它，可以：按用户/按项目调阈值；对题面做 A/B；题面改版后重放历史做回归（"retag everything" 模式用在自己身上）。这是 **harness 自己的经验**，和代理的经验库（§4 D2/D3）是两层。

---

## 4. 决策点全景

题型缩写：N = Noul，C = Choice（均含 `none/other`），S = Score。

### A. 输入阶段 —— 钩子 `input` → `before_agent_start`，**一次请求批量提问**

输出免费、各题并行，所以每条用户消息可以做一次"十问齐发"的预检，成本约 $0.00002。

| # | 判断 | 题型 | 给判定器看什么 | 本地策略 | 先例 |
| --- | --- | --- | --- | --- | --- |
| A1 | 本轮类型（**是否 chat**） | C：闲聊问答 · 快查 · 单点修改 · 多步任务 · 调研探索 · 方案讨论 | 任务帧 + 用户消息 + 最近两轮摘要 | 决定档位。闲聊档：不注入经验和技能、不武装蜂群、低思考、跳过完成闸门 | openchamber |
| A2 | 是否需要先澄清 | N | 同上 | 高 → 给主模型一个"先问一个问题"的标记 | — |
| A3 | 复杂度 | S×3：任务 / 推理 / 工具 | 同上 | 会话开始时选主模型；会话中只调思考强度，难轮次升级给子代理（§6） | jev-router, jev-codex-router, loki |
| A4 | **是否调用蜂群** | N：可拆成互不依赖的子任务？N：父会话不需要中间过程？C：形态（单侦察 / 并行扇出 / 流水线+验证者） | 同上 | 判定器判断值不值、用哪种形态；任务书由主模型写 | opencode-jev-orchestrator, firstmate |
| A5 | **是否融入经验**（读取侧） | 先 N：本轮需要经验吗；再对每条候选 N×3：相关？仍有效？会改变做法？ | 任务帧 + 候选经验的"触发条件"字段 | 两段式：廉价检索 → 判定器逐条判定 → 每条只注入一行 | Noema, bwmem |
| A6 | **技能/工具披露** | 每个技能一个 N | 项目指纹 + 任务帧 + 技能描述 | 高 → 直接预载正文（省一个来回）；中 → 只露描述；低 → 隐藏，但可经 `find_skill` 找回 | jev-skill-gate, skillbox, jev-eval-agent（百个工具两级筛选） |
| A7 | 是否先出计划 | N | 同 A1 | 高 → 先计划后动手 | — |
| A8 | **用户中途插话的路由** | C：纠偏（立即打断）· 追加任务（排队）· 旁支提问（分支回答） | 任务帧 + 代理当前动作 + 插话内容 | 映射到 pi 的 `steer` / `followUp` / 会话分支 | pi `input.streamingBehavior` |

### B. 循环内 —— 钩子 `context`、`tool_call`、`tool_result`、`turn_end`

| # | 判断 | 题型 | 给判定器看什么 | 本地策略 | 先例 |
| --- | --- | --- | --- | --- | --- |
| B1 | **工具输出准入** | 分块，每块 N：与本次调用意图相关？ | 意图 + 任务帧 + 该块 | 相关或不确定 → 保留；高置信无关 → 归档原文，留一行带召回句柄的占位。短输出、报错、源码直接放行 | Winnow, jev-pruner, BorisLeMeec/jev |
| B2 | **主动上下文遗忘** | 每个"调用+结果"对两个 N：调用本身还要留吗？完整结果还要留吗？ | 任务帧 + 调用名、参数、结果长度、错误标记（**不含结果正文**） | 保留 / 截短 / 占位 / 删除。决策有粘性且单调，批量放在缓存边界执行（§6）。确定性规则先行：同一文件的新读取取代旧读取，编辑使更早的读取过期 | fast-jev-compaction（1M→86K 约 1 秒）, fast-jev-compaction-pi, omp-jev-compaction |
| B3 | 执行前风险闸门 | S：破坏性 / 不可逆 / 越界；N：是用户要求的吗 | 命令 + 任务帧 | 规则先行；判定器只能加闸。还可以路由**执行场所**：高风险命令送进 pi 的 Gondolin 微型虚拟机 | pi-jev, pi-warden, pi-jev-auto-mode |
| B4 | 工具输出注入筛查 | N：含有写给代理的、用户没要求的指令？ | 该块 | 隔离并标记（本次调研里 magicteams 页面就是活例子） | jev-cli `screen`, pi-jev-sentinel, jev-guard |
| B5 | 意图漂移 / 卡死监测 | C：在轨 · 必要的绕路 · 漂移 · 循环卡死 | 任务帧 + 最近 N 步动作摘要 | 漂移 → 注入一行定向纠偏（取代无差别的周期性提醒）；卡死 → 升思考强度 / 换强模型 / 派新上下文的子代理 / 问用户 | pi-warden, foreman-jev |
| B6 | **工具失败分类** | C：瞬时可重试 · 参数可修 · 环境缺失 · 权限 · 逻辑错误 | 错误输出 + 调用 | 瞬时 → **不经过主模型直接重试**，失败的那次根本不进上下文 | PiJ, jev-judgment |
| B7 | 逐轮思考强度 | S | 任务帧 + 上一步结果摘要 | 机械步骤用低档，困惑的报错之后用高档。部分 provider 上改 thinking 参数会影响消息段缓存，需逐家实测 | jev-codex-router |
| B8 | **通知路由**（context 是否应该通知你 · 第一层） | N：现在就需要知道？C：立即打断 · 挂到下一个工具结果 · 排到本轮结束 · 丢弃 | 任务帧 + 当前动作 + 事件 | 映射 `steer` / 附注 / `followUp` / 仅记账。事件例：文件被外部改动、后台任务完成、上下文预算、诊断报错、子代理消息 | — |
| B9 | **占位是否留痕**（第二层） | N：之后可能回看？ | 任务帧 + 被删项摘要 | 是 → 一行占位 + 召回句柄；否 → 静默删除 | pi-jev-context |

### C. 蜂群 / 子代理

| # | 判断 | 题型 | 本地策略 | 先例 |
| --- | --- | --- | --- | --- |
| C1 | **逐任务书选模型和思考强度** | C 模型档（快 / 均衡 / 强 / 长上下文）· C 思考强度 · C 工具集（只读 / 可写）· 上下文切片 | 子代理本来就是冷启动，任何选择都没有缓存代价 —— 这是判定器路由的**无副作用区** | jev-model-router, JevRouter, WrongStack |
| C2 | 回传闸门 | S 完整度 · N 有无缺证据的断言 · N 体量格式合要求 | 接受 / 打回收紧 / 派验证者。只有提炼后的结论进入主上下文 | — |
| C3 | 蜂群健康 | C：推进中 · 停滞 · 循环 · 做完了没汇报 | 终止 / 重启 / 改派 | foreman-jev |
| C4 | 结果去重合并 | 两两 N：是同一个发现吗 | 去重排序；有冲突的升级给主模型 | — |
| C5 | 自动侦察 | N：探索量大而答案很小的问题？ | 直接派侦察子代理，主会话只看到答案 | — |

推荐形态：**主会话用中档模型并保持缓存温热 + 判定器配置的一次性专家子代理**。蜂群、模型选择、最小上下文，在这里是同一个设计。

### D. 收尾 —— 钩子 `turn_end`、`agent_end`

| # | 判断 | 题型 | 本地策略 | 先例 |
| --- | --- | --- | --- | --- |
| D1 | 完成声明核验 | N 声称完成了？N 声称检查通过了？N 这个任务值得跑检查？C 完成 / 部分 / 受阻 | 本地事实先行（最后一次编辑之后有没有通过的检查）。声称完成却没证据 → 阻止结束，用 `followUp` 要求跑检查 | jev-belay, Canny |
| D2 | **是否融入经验**（写入侧） | N 产生了可复用的教训？C 类型（用户偏好 / 项目事实 / 做法 / 坑）· S 通用性 | 是 → 小模型后台写一行教训 → 判定器查重、查矛盾 → 入库 | — |
| D3 | **是否遗忘**（经验库侧） | N 注入后真的被用上了？N 和新事实矛盾？ | 用上 → 强化；没用 → 衰减；矛盾 → 退役。判定器足够便宜，可以随时用新问题重标全部历史 | Prebrief / Engram |
| D4 | 用户反馈信号 | C：认可 · 纠正 · 改方向 · 不满 · 新任务 | 给上一轮的所有决策打标签；纠正 → 触发经验捕获（用户的纠正是最值钱的经验） | — |

经验的存储形态要为"最小注入"设计：`{触发条件, 一行教训, 证据指针, 作用域, 命中计数}`。判定器拿触发条件对任务帧做 Noul，命中的每条只注入一行。

### E. 会话级

| # | 判断 | 本地策略 | 先例 |
| --- | --- | --- | --- |
| E1 | 压缩方式：只做 GC · 抽取式压缩 · 摘要 · 开新会话带交接 | 先让判定器做抽取式（保留路径、命令、报错的原文），不够再走 pi 原生摘要 | pi-fast-jev-compaction |
| E2 | **旁支隔离**：这是与主线无关的旁支吗 | 自动开分支，结束后带分支摘要回到主线。结构性遗忘，pi 的会话树是别家没有的原语 | — |
| E3 | 缓存保温：用户很快会继续吗 | 覆盖 pi `cache_warming_decision` 里的 `continuationProbability` | — |
| E4 | **代码定位**：目录项与问题的相关概率 + 是否到达目标 | 内置 `locate` 工具：判定器引导的目录树束搜索，主模型只看到 3–5 个候选，取代反复 grep | Blink, neo4jev, jev-context |
| E5 | 测试选择：每个测试与本次改动相关吗 | 不确定就运行 | leanest |
| E6 | 编辑 / 提交语义检查：遗留调试代码、疑似密钥、未提及的改动、违反项目规则 | 警告或阻止 | jev-experiments Commit Sentry, Reaper, jev-commit |

### F. 把判定器交给主模型当工具

`judge` 工具：主模型写问题，判定器读大批量材料，只有结论回到上下文（给 30 个 issue 分诊、给 50 个文件排序）。先例：pi-typesafe 的 `typesafe_evaluate`、azdaja。

### 贯穿原则：免主模型回合

主模型每多一个来回，就要重读一遍全部上下文。凡是判定器能直接闭合的环节（B6 重试、B3 授权、E4 选文件、E5 选测试、技能里的闭集流程）都不再回到主模型。先例：pi-fabric 的"观察—判断—执行"预算循环、jev-predict-skill。

---

## 5. 你提的八个点逐条对应

| 你的点 | 对应 |
| --- | --- |
| 是否 chat | A1 |
| 是否调用蜂群 | A4、C5 |
| 是否融入经验 | A5（读）、D2（写） |
| 是否遗忘 | B2（上下文）、D3（经验库）、E2（结构性） |
| 子代理选用模型和思考强度 | C1；主会话见 A3、B7 |
| skill 上下文披露 | A6 |
| 主动上下文遗忘 | B1（入口）、B2（事后）、E1 |
| context 是否应该通知你 | B8（事件要不要告诉模型）、B9（删掉之后要不要留痕）—— 我的两层理解，待你确认 |

我补充、你已认可的四点：A8 插话路由、B6 瞬时失败自动重试、E2 旁支隔离、E4 判定器代码定位。

---

## 6. 缓存经济学："最小上下文"的隐藏陷阱

从上下文**中间**删内容，会让它后面的所有内容的提示缓存失效。

示意（按 Anthropic 式定价：缓存读 0.1×，缓存写 1.25×）：上下文 100K，删掉位于 40K–70K 的 30K。

- 一次性代价：后面 30K 要重新写缓存，多付 30K × (1.25 − 0.1) ≈ 34.5K token 当量
- 每轮收益：少读 30K 缓存 = 3K token 当量
- 回本：约 **12 轮**

结论：

1. **入口准入比事后遗忘划算得多。** 从没进来的 token 最便宜。判定器的预算优先花在 B1、A5、A6、B8。
2. 事后遗忘分工：**判定器判断什么已经没用，代码计算什么时候删划算**。划算的时机：缓存本来就冷了（空闲超过 TTL，pi 的保温机制知道）；快撞上下文上限（避免更贵的摘要压缩）；预期剩余轮数足够多。
3. 决策要有粘性：判过的不重判，避免前缀被反复改写（omp-jev-compaction 的做法）。
4. 账不只是钱：上下文越短，主模型注意力越集中。可以给一个策略开关：成本优先 / 质量优先。
5. 改动前缀的决策（换工具集、换技能目录、换主模型）只在缓存边界做：会话开始、压缩之后、长空闲之后。会话中途只追加，不改写。pi 已有的"system prompt 分段 diff 补丁"正好配合。

---

## 7. 判定器不该做的事

- 任何要写字的活：任务书、摘要、教训、澄清问题 → 主模型或小模型
- 多步前瞻和规划 → 主模型
- 没有逃生门的开放集选择
- 超过 32K 的状态 → 先摘要或分块
- 单独充当安全边界 → 硬规则和沙箱才是边界，判定器只是风险顾问
- 类型化的升级契约（借鉴 jev-use）：`writing` · `open_ended` · `oversized` · `unsure` · `unreachable` → 退回主模型或规则，而不是让判定器猜

---

## 8. 架构：判断内核

```
packages/
  judge/          判断内核：client · batcher · registry · policy · ledger · calibrate
  swarm/          子代理 / 蜂群编排（pi 内核没有）
  memory/         经验库（pi 内核没有）
  kyrn-builtin/   自带扩展：把各决策点接到 pi 的扩展 API 上
  coding-agent/   pi 原包 + 少量"新增钩子"补丁
```

每个决策点是一份声明式规格：

```ts
interface DecisionSpec<In, Out> {
  id: string;                        // "tool_result.admission"
  version: number;                   // 题面版本，改问法必须 +1
  buildState(input: In): JevState;   // 摘要函数，自带 token 预算
  questions: Record<string, Question>;
  policy(answers: Answers): Out | Abstain;  // 三区间阈值 → 动作
  fallback(input: In): Out;          // 弃权或判定器不可用时的确定性默认 = pi 原生行为
  cacheImpact: "none" | "append-only" | "prefix-mutating";
  latency: "inline" | "parallel" | "background";
}
```

内核职责：

1. **批处理**：同一 state 上的题合并成一次请求（≤32 题）。
2. **策略层**：三区间阈值、粘性、每日预算上限。
3. **账本 + 影子模式**：新决策点先只记账不生效，和结果对照之后再放权。
4. **校准**：带标注的案例 → 阈值（AUC、扫描、重放）。先例：pi-typesafe/calibrate、tenbin、Jevcal。
5. **判断提供方可替换**：Vercel AI Gateway（当前）/ TypeSafe 直连 / OpenRouter / LLM 模拟替身。Jev 才发布几天、接口还叫 `experimental_`，这层抽象是必须的。
6. **隐私**：发出前脱敏；能发元数据就不发正文；可按项目关闭。
7. **并行预判**：Jev 约 0.3 秒而主模型要几秒，GC 候选等判断可以在主模型流式输出期间并行跑完。

---

## 9. 分叉策略：深能力，浅分叉

pi 迭代极快（107K★、每天有提交、CHANGELOG 567KB，`chord` / `durable` / `protocol` / `server` 等新包还在变动）。到处改的硬分叉几个月就合不动上游了。

建议：

- 判断内核、蜂群、记忆**各做成新包**，不碰上游文件。
- 绝大多数决策点写成**随 KYRN 打包的自带扩展**，走 pi 现有扩展 API（`input`、`before_agent_start`、`context`、`tool_call`、`tool_result`、`session_before_compact`、`cache_warming_decision`、`setModel`、`setThinkingLevel`、`setActiveTools` 已经够用）。
- 内核只打少量补丁，且都是**新增钩子**：工具输出准入、通知候选、子代理生成、工具失败拦截（B6 需要在结果进上下文之前截住）、会话里的占位/召回条目。这类补丁小、冲突少，有机会回馈上游。
- 动手前读一遍 pi 的 [RFC](https://rfc.earendil.com/keyword/pi/)，避免做上游马上要发的东西（`pi-durable` 的任务运行时可能和蜂群重叠）。

扩展做不到、必须进内核的：跨决策点的统一批处理和账本；缓存感知的调度；会话格式里的占位/召回；一等公民的蜂群和记忆；工具 schema 加 `intent`；TUI 里的判断面板。

---

## 10. 值得吸收的生态先例

按 KYRN 模块归类。**吸收设计为主；要拷代码的，先逐个核对 license**（目录里不少项目没有声明 license）。

| 模块 | 项目 | 吸收什么 |
| --- | --- | --- |
| 内核 / 客户端 | DevMortimer/pi-typesafe | 共享客户端、key 存储、每日花费上限、`calibrate` |
| | shitianfang/jev-use | `judge()` / `toVerdict()` / `gate()` 三件套、类型化升级契约 |
| | typesafe-ai/skills（官方） | 出题规范 |
| | typesafe-ai/system-one-adapter-python | LLM 模拟替身 → 降级通道 |
| | monotykamary/pi-fabric | 带预算的可编程决策循环 |
| | simota/tenbin | 阈值校准流程 |
| 准入 | GhalebDweikat/Winnow | 分块判定 + 可完整召回 |
| | tamaratran/jev-pruner | 短输出、报错、源码直接放行的规则 |
| 遗忘 | tamaratran/fast-jev-compaction | 原型：删减而不改写 |
| | joslynSmall/fast-jev-compaction-pi | 每个调用两个概率；只发元数据不发正文；失败回退原生摘要 |
| | jerryfane/omp-jev-compaction | 粘性决策，减少前缀反复改写 |
| | kevinpita/pi-jev-context | 可逆筛选 |
| | compozy/yoshi | 保持工具调用协议结构完整 |
| 路由 | aaronshaf/opencode-jev-orchestrator | 廉价父会话 + 难轮次才拉强子代理 |
| | gargpratyush/jev-router | 三个 Score + 一个 Choice；置信不足就保持现状 |
| | wundercorp/loki | 只在会话开始选模型 |
| | BillionsBobby/JevRouter | 模型、子代理、技能、MCP 放进同一个候选集 |
| 披露 | ShivamPansuriya/jev-skill-gate | 按项目调整技能可见度 |
| | vinilana/jev-eval-agent | 百级工具的两级筛选 + 基准 |
| | tonyzdev/PiJ | 基于 pi 的整体参考：技能推荐、候选重排、失败分类 |
| 闸门 | y0usaf/pi-jev · DevMortimer/pi-warden · jomatsu/pi-jev-auto-mode · harshwasan/pi-jev-sentinel | 风险打分、项目规则、重复失败、发送前脱敏 |
| 核验 | valentynkit/jev-belay · qkal/Canny | 本地事实先行，只在必要时问判定器 |
| 记忆 | Noema 的 Jev 分诊旁路 | 并行 Noul（relevant_* / preference_*），判定器从不写记忆 |
| | Prebrief / Engram | 不用则衰减、有用则强化 |
| 定位 | ellipsis-dev/Blink · jexp/neo4jev | 判定器引导的树搜索和束搜索 |
| | baronunread/leanest | 测试选择 |
| 设计辅助 | altryne/jevify | 在一个项目里找适合 Jev 的判断环节 —— 可以直接对 pi 代码库跑一遍 |

数据来源：jevable.com（359 个项目）、jev.magicteams.ai（50 个评测 + 1328 个社区案例，有 MCP 端点）、logicrw.github.io/awesome-jev-projects（314 个经源码审查的项目，页面内嵌完整 JSON，含每个项目的"Jev 决策点"字段）。

---

## 11. 风险

1. **Jev 太新**：发布不到一周，接口带 `experimental_` 前缀，单一供应商。→ 判断提供方抽象 + 全程 fail-open。
2. **延迟**：你的判断是后续一定会降，所以不为当前延迟做结构性妥协。工程上仍保留超时 + 默认值，保证网络抖动时 harness 不卡。
3. **隐私**：代码和上下文片段会发给第三方。→ 脱敏、元数据优先、可按项目关闭。
4. **过度修剪 → 代理失忆 → 做错事**。→ 可召回占位、保守阈值、影子模式、`recall` 工具。
5. **缓存失效导致成本反升**。→ §6。
6. **问法敏感**。→ 题面版本化 + 回放回归。
7. **分叉维护成本**。→ §9。

---

## 12. 验证：先离线回放，再写内核

pi 作者在 Hugging Face 公开了真实工作会话（`badlogicgames/pi-mono`）。

1. 拉一批真实会话。
2. 离线模拟 B1 / B2：让 Jev 对每个工具调用对、每块输出打分。
3. 量两件事：**能省多少 token**；**误删率**（被判为可删的内容后来是否又被引用，用字符串重合 + LLM 复核）。
4. 副产品：第一批阈值校准数据。

一个周末就能拿到硬数字，判断整个论点成不成立。

---

## 13. 路线图

| 阶段 | 内容 |
| --- | --- |
| P0 | 调用通道验证（§15）→ 离线回放实验 → 判断内核（client、batcher、registry、ledger、fail-open） |
| P1 | 任务帧 + 工具 `intent` · B1 准入 · B2 缓存感知的遗忘 · A6 技能披露 |
| P2 | A1/A3 预检与档位 · B6 失败自动重试 · D1 完成闸门 · B3/B4 风险与注入闸门 |
| P3 | 蜂群：C1–C5 · A8 插话路由 · E2 旁支隔离 · E4 `locate` |
| P4 | 经验库：A5 / D2 / D3 / D4 · B8 通知路由 |
| P5 | TUI 判断面板 · 回放评测 · 阈值自动校准 |

北极星指标：**每个解决的任务消耗的 token** 和 **一次做对率**。对照组是原版 pi，同一批任务。

---

## 14. 待定问题

1. 分叉策略：接受"深能力、浅分叉"，还是彻底硬分叉？
2. 主模型准备支持哪些 provider？各家缓存语义不同，直接影响 §6 的调度。
3. "context 是否应该通知你"——B8 / B9 两层理解对吗？
4. 同意先做离线回放（§12）再写内核吗？
5. 产品形态：只做 CLI/TUI，还是也要桌面或网页？
6. 自动化程度：各处判断默认全自动，还是某些（比如派蜂群、换模型）先提示用户？

---

## 15. Spike 记录：Vercel AI Gateway 调用验证

2026-09-20，代码在 `kyrn/spikes/jev-smoke/`。

### 15.1 状态

| 项 | 结果 |
| --- | --- |
| Key 存放 | 项目根 `.env`（已 gitignore，权限 600），变量名 `AI_GATEWAY_API_KEY` |
| 鉴权 | **通过**（网关识别了 key 和团队，不是 401） |
| 实际调用 | **被拦：HTTP 403** —— "AI Gateway requires a valid credit card on file to service requests"。需要账户所有者在 Vercel 控制台绑卡后才放行 |
| 真实应答 | 尚未拿到。绑卡后执行 `npm run smoke` 即可补齐 §15.4 |

### 15.2 已从源码和网关目录核实的事实

来源：`ai@7.0.107`、`@ai-sdk/gateway@4.0.87` 的类型定义与实现；`GET https://ai-gateway.vercel.sh/v1/models`（公开、免费）。

- 模型 id `typesafe-ai/jev`，目录类型 `evaluation`，**上下文窗口 32000**，输入 $0.042 / 百万 token，输出 0，仅文本输入，发布于 2026-09-15。
- 目录标注 `zdr: all`、`no_training: all`：零数据留存、不用于训练。对 §11 的隐私风险是好消息。
- SDK 入口：`import { experimental_evaluate } from 'ai'`，传字符串模型 id 时默认走 AI Gateway，从环境变量读 `AI_GATEWAY_API_KEY`。`maxRetries` 默认 2。契约标注为"实验性，补丁版本里也可能变"。
- SDK 要求 Node ≥ 22（本机 v20.20.1 能跑但有警告；pi 本身也要求 ≥ 22.19，后面需要升级）。

题目类型（经 AI SDK 调用时的写法）：

```ts
{ type: 'boolean', instructions, criteria?: { true?, false? } }   // 社区叫 Noul；经 AI SDK 时类型名是 'boolean'
{ type: 'choice',  instructions, criteria: { 选项名: 描述 | null } } // 非空
{ type: 'score',   instructions, criteria: [描述 | null, ...] }      // 至少两级，从 0 开始编号
```

`state` 和 `instructions` 都可以是字符串、JSON 对象或 JSON 数组。

返回结构：

```ts
result.answers[id] =
  | { type: 'boolean', probability }                 // P(true)，0–1。不是"对任一结果的置信度"
  | { type: 'choice',  choice, probabilities? }      // 每个选项的完整分布
  | { type: 'score',   score, probabilities? }       // score 是 [0, 级数-1] 上的小数位置 = 概率加权均值
result.usage = { inputTokens, outputTokens, totalTokens }
result.rounding / result.warnings / result.providerMetadata / result.response
```

**对先前理解的三处修正**：

1. 目录站示例里的 `{ amount_disclosed: true, empathy: 3 }` 是简化写法。真实返回在 `result.answers` 下，boolean 题给的是**概率数值**，不是 true/false —— 阈值由我们自己定，这正是 §2.3 铁律 2 需要的。
2. 经 AI SDK 调用时，Score 是**从 0 开始**的小数位置；目录站评测清单写的"1 = 第一级"是它自己的换算。
3. 经 AI SDK 调用时没有 confidence 字段（直连 TypeSafe API 的 pi-typesafe 有）。需要的话从分布自己算（最大概率、熵）。

### 15.3 原始 HTTP 契约

KYRN 内核可以不依赖 AI SDK，直接发请求：

```
POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model
Authorization: Bearer $AI_GATEWAY_API_KEY
ai-gateway-protocol-version: <SDK 常量>
ai-evaluation-model-specification-version: 4
ai-model-id: typesafe-ai/jev
Content-Type: application/json

{ "state": ..., "questions": { ... }, "providerOptions"?: ... }

→ { "answers": {...}, "rounding"?: {...}, "usage"?: {...}, "warnings"?: [...], "providerMetadata"?: {...} }
```

### 15.4 绑卡后要用真实应答回答的问题

冒烟脚本已经写好对应用例：

1. 三种题型的真实返回（含 `probabilities`、`rounding`、`providerMetadata` 里有什么）。
2. **计费方式**：同一 state 下 1 题和 10 题的 `usage.inputTokens` 对比 —— state 是算一次还是每题算一次。
3. **中文**：同一组预检题，用户消息换成中文，概率是否稳定。不稳的话，任务帧要由小模型先归一化成英文。
4. B1 准入的可行性：四块测试输出，Jev 能否留下失败用例、丢掉 npm 警告。
5. 逃生门失败模式复现：同一个离题输入，Choice 带和不带 `none` 选项的对比。
6. 延迟样本。参考：被 403 拒绝的请求往返约 270–350ms，这是你的网络到网关的往返下限。
