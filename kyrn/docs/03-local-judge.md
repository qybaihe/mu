# 本地判断后端：Laya on Core ML

> 2026-10-24（0.2.5）：Laya 已从 mu 移除；本文是历史测量记录。

> 已于 2026-09-21 更名为 mu（命令 `mu`，标识 μ）。本文是更名前的记录，正文保持原样；新旧名对照见 [10-rename-to-mu.md](10-rename-to-mu.md)。

> 2026-09-20 · 实测记录。机器：M3 Max / macOS 27.0 / Python 3.12.11（uv）。
> 目的：Vercel 账号绑卡之前 Jev 调不通（HTTP 403），先用一个本地开放权重的判断模型把整条链路跑真。
> 数字来自 `kyrn/spikes/judge-bench`（37 条手工标注场景，中英各半）。这是接线和措辞的体检，不是严肃评测。

## 1. 它是什么

- [Laya](https://github.com/NandhaKishorM/laya)（Convai Innovations，Apache-2.0）：跟 Jev 同一范式的开放权重模型——状态 + 类型化问题进，概率出，不生成 token。三种题型 `choice` / `score` / `noul`（=Jev 的 boolean）。
- [laya-coreml](https://github.com/mizorewww/laya-coreml)（Apache-2.0）：第三方做的 Core ML 移植，Apple Silicon 专用，推理不依赖 PyTorch/Transformers。
- 我们用的检查点：`aac6fef/laya-multilingual-coreml`（mmBERT-base，322M，FP16，680 MB，**窗口 1024 token**，问题+选项+状态共用；batch=1，最多 32 个选项）。

安装前我读过 wheel 的全部推理路径源码（`agent/hub/inputs/prompt/result/tokenizer/artifacts`）：没有子进程、没有动态执行、没有 HF 下载之外的网络访问；`subprocess` 只出现在贪吃蛇演示里，我们不用。装好的包与我审过的 wheel 逐字节一致，权重按 bundle 清单校验了 sha256。

## 2. 怎么用

```bash
kyrn/bin/kyrn-judge-local setup     # 建 venv（uv + Python 3.12）、装锁定依赖、下权重并校验；幂等
kyrn/bin/kyrn-judge-local start     # 后台常驻，全机共用一个；状态在 ~/.kyrn/local-judge/
kyrn/bin/kyrn-judge-local status | stop | run

KYRN_JUDGE=laya kyrn/bin/kyrn-dev   # 启动器会顺手把 sidecar 拉起来
KYRN_JUDGE=laya node kyrn/spikes/judge-bench/preflight-bench.ts   # 体检（Node ≥ 23.6）
kyrn/bin/kyrn-ledger [N] [--json]   # 回看最近 N 个会话里，判断模型对你每条真实消息的判定
```

- `pip` 的阿里云镜像还没同步这个新包，所以 `setup` 显式走 `https://pypi.org/simple`。
- 权重和 venv 在 `kyrn/local-judge/{models,.venv}`，已被 `kyrn/.gitignore` 忽略。

## 3. 结构

```
pi 扩展 (kyrn-judge.ts)
  └─ DecisionEngine ─ Judge ─ LocalJudgeProvider ──HTTP──▶ kyrn/local-judge/server.py ─ laya_coreml ─ Core ML (GPU)
                              GatewayJudgeProvider ─HTTPS─▶ Vercel AI Gateway ─ Jev
```

- sidecar 的线协议**与 AI Gateway 的 `evaluation-model` 完全同形**：`POST /evaluate {state, questions}` → `{answers, usage, warnings, providerMetadata}`。内核换后端不需要翻译任何东西，`boolean↔noul` 的映射在 sidecar 里。
- 只绑 `127.0.0.1`，拒绝带 `Origin` 的请求（挡掉网页发起的跨站 POST），请求体上限 1 MiB，日志只记数量和耗时，不记状态和问题文本。
- Core ML 模型不能并发调用，sidecar 用一把锁串行化。
- 为此内核加了三样东西（对 Jev 同样有用）：
  - `ProviderResponse.warnings` → `JudgeResult` → `Decision` → 账本。后端悄悄截断了什么，必须留痕。
  - `Answer` 上可选的 `confidence` / `actProbability`（Laya 的自评信号；Jev 走网关时没有）。
  - 账本记录 `modelId`，以后对比不同判断模型靠它。

## 4. 实测结论

### 4.1 延迟：瓶颈是 Core ML 换形状，不是算力

| 情况 | 一次 preflight（10 题）|
|---|---:|
| 原样调用（每题长度不同 → 每题换一次形状）| p50 783 ms，p90 2105 ms |
| 同一请求内统一补齐到一个长度桶 | p50 102 ms，但请求之间换桶时 ~420 ms |
| 再加 256 token 的补齐下限（现默认）| **p50 128 ms，p90 129 ms，max 146 ms** |

原因：这个导出用的是枚举长度（16…1024 共 11 档），GPU 上每次换档要重新特化，约 350 ms；稳定形状下单题约 12 ms。补齐不改变输出（同一批场景判定完全一致）。sidecar 启动时预热全部 11 档并停在常用档，首个请求也不再吃这一下。

还能再快：重新导出 `--batch-size 10` 的模型，10 题一次前向（需要 `laya-coreml[convert]` + PyTorch 2.7 + 原始权重，暂时没做）。

### 4.2 准确度：措辞决定一切，元判断做不了

同一个模型、同一份状态，只改问题措辞（31 条有标注的消息，"是否要求改代码"）：

| 问法 | 0.5 阈值准确率 |
|---|---:|
| Does \`user_message\` ask for any file to be created, edited, or deleted? | 42%（不如瞎猜）|
| Does the message request a code change? | 68% |
| **Does \`user_message\` request a code change?** | **74%** |

消融结果：
- **状态的形状几乎不影响**（单字段 / 多字段 / 带 null / 嵌套，差别在 ±2 题以内；纯字符串略差）。JSON 状态没问题。
- **问题措辞影响极大**：短、具体、单一谓词的问题有效；带枚举（"created, edited, or deleted"）、量词（"any"）、复合条件（"so under-specified that a wrong assumption would waste…"）的问题直接掉到随机水平。
- 反引号点名状态字段略有帮助，跟 Jev 官方的建议一致——所以目前**一套措辞同时服务两个后端**，不需要"方言"机制。等 Jev 能调了用同一个 bench 对比，分歧大再引入。
- 选项描述同理：把 turn_type 的问题和 7 个选项描述都改短改具体之后，argmax 从 8/18 提到 11/18，高置信（≥0.6 且非 other）的 12 次里对 10 次（原来 7 次里对 5 次）。

据此 `input.preflight` 已升到 v3（措辞规则写在该文件头注释里）。v3 在 37 条场景上（三区间阈值 0.2/0.8，对 / 不确定 / 错）：

| 字段 | 对 | 不确定 | 错 | 评价 |
|---|---:|---:|---:|---|
| needsFilesChanged | 20 | 5 | 6 | 可用 |
| turnType | 10 | 6 | 2 | 可用；分不清规模（"迁移 40 个包"判成 single_edit）|
| planFirst | 6 | 4 | 0 | 可用，且不确定时会弃权 |
| sideQuestion | 3 | 3 | 1 | 勉强；样本少 |
| swarmWorthy | 4 | 7 | 3 | 弱 |
| needsClarification | 2 | 0 | 4 | **不可用**：把"优化一下"判成很明确 |
| 复杂度三个 score | — | — | — | **不可用**：重任务和轻任务的分数挤在 1.5–2.0，AUC 0.46–0.77 |

上游自己也这么说：基础检查点在 typed-decisions 基准上零样本接近随机（0.342，随机 0.318），"Laya is a fast base to specialise, not a zero-shot decision engine"；`score` 是最弱的题型。

我也试了上游微调过的 `laya-typed-decisions`（ModernBERT-large 英文底座，848 MB，在发票/安全事件/客服/agent-trace 四类工作流上训练，该基准上 0.766 > Jev 公布的 0.727）：它带了拟合过的温度，在我们的问题上几乎全部落进"不确定"→ 大量弃权；英文底座对中文也不行。结论：**对 KYRN 的问题它并不比多语言基础版好**。权重还在 `kyrn/local-judge/models/laya-typed-decisions-coreml`，不想留可以直接删。

`actProbability`（Laya 的"该行动还是该上报"头）在这个检查点上恒为 1.0，没有信息量，暂不进策略。

### 4.3 对 KYRN 的意义

1. **现在**：Laya = 真实的链路测试后端。真概率、真延迟、真截断告警、真账本，全程离线免费。它的判定只在 shadow 模式里记录，不驱动行为。
2. **规则先行得到了实证**：首条消息被判成"旁支问题"是因为问题本身不成立（没有主线）。已改成规则：没有 task frame 也没有历史 → `sideQuestion = "no"`，不问判断模型。
3. **fail-open 设计成立**：弱判断模型下，三区间 + 逃生选项 + 弃权把大部分错误变成了"不确定 → 走默认行为"，而不是错误动作。
4. **真正的机会是蒸馏**：上游给了完整的微调流程（RLCD，约 3 万题，2×T4 上 4–5 小时）。KYRN 的决策账本天然就是训练集——状态摘要 + 问题 + 教师判定（Jev，或事后信号：被裁掉的内容有没有被重新读取、路由的模型有没有被迫升级）。路线：Jev 当老师跑一段时间 → 用账本微调一个 KYRN 专用的 Laya → 本地 ~13 ms/题、零成本、数据不出机器；Jev 退到只处理本地模型弃权的那部分。这条路线要求账本在用户同意的前提下保存状态原文（现在默认只存 sha256 摘要，`recordState` 开关已经有了）。

## 5. 窗口限制与状态排序

1024 token 由问题+选项+状态共用；问题前缀预算 256（每个选项最多 48 token，超了会被挤压）。**状态超长时保留开头、截掉结尾**，且上游是静默截断。因此：

- 决策规格的 `buildState` 必须把决定性内容放最前面。preflight 已改为 `user_message` 在首位，`recent_turns` 在末位（v2 起），并有测试锁住这个顺序。
- sidecar 会逐题计算并上报 `state_truncated` / `question_truncated` 告警，`/kyrn` 命令和账本里都能看到。
- 这对 B1（工具输出准入）是硬约束：一段 30K 的输出不可能整体塞给本地模型，必须先切块或取头尾摘要。Jev 的 32K 窗口宽松得多，但"决定性内容在前"仍然是好习惯。

## 6. 端到端验证（2026-09-20）

```bash
KYRN_JUDGE=laya kyrn/bin/kyrn-dev --provider openai-codex --model gpt-5.6-luna --thinking low \
  --tools read,grep,find,ls -p "Which file in packages/coding-agent/src defines the AgentSession class? Reply with the path only."
# → packages/coding-agent/src/agent-session.ts
```

- Codex OAuth 登录有效，可用模型：`gpt-5.5`、`gpt-5.6-luna/terra/sol`、`gpt-6-astra`（`gpt-5.3-codex-spark` 在目录里，但 ChatGPT 账号调用会被拒绝）。
- 会话文件里的条目顺序：`system → user → custom(kyrn.decision) → assistant`。判断记录是 `custom` 条目，不进模型上下文。
- 该条记录：`input.preflight v3 · shadow · local:laya · laya:aac6fef/laya-multilingual-coreml`，判定 `quick_lookup`、`needsFilesChanged=no`（都对），10 题 980 token。

## 7. 待办

- [ ] Vercel 绑卡后：`KYRN_JUDGE=gateway node --env-file=.env kyrn/spikes/judge-bench/preflight-bench.ts`，同一批场景上 Jev 对 Laya，逐字段比较；据此校准阈值、决定要不要"方言"。
- [ ] 把 bench 的标注集扩到 ≥200 条（可以从自己的真实会话里抽），否则措辞搜索会过拟合。
- [ ] 评估 batch=10 重新导出，把一次 preflight 压到 ~30 ms。
- [ ] 蒸馏路线的前置：账本加"事后信号"回填接口（按 `ledgerId` 关联）。

## 补充：2026-09-20 晚的实测与结论

用户报告"猫和狗有什么区别"没被识别成闲聊。原因有两层：题面里没有"闲聊"这一类（已修，见 04 文档 §10），以及基础版 Laya 本身在这类题上接近随机：

- 七/八选一的 `turn_type`：18 条中英文消息答对 5 条（原题面）、6 条（加 `chat` 类）、3 条（换问法）；`other` 选项是个吸引子。
- 六种"是不是关于代码/闲聊/技术性"的是非题：25 条里答对 11–19 条，且有大量高置信的错误答案。
- 让 Laya 驱动浏览器（`laya-all`，放开能力档案）：两步 1.3 s，但选不中目标。

同样的题换 Jev：`猫和狗有什么区别 → chat`、`fix the typo in README → single_edit 0.98`，浏览器任务 6 s 完成。结论：判断层默认用 Jev；Laya 留作可插拔的本地档（`/kyrn judge laya`），真要用它得先做专门化（蒸馏），而不是再调问法。
