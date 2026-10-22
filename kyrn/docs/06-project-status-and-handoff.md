# mu（原 KYRN）项目现状与交接

更新日期：2026-09-22。依据本地代码、配置、此前实际测试和桌面观察整理。

> **更名**：项目于 2026-09-21 由 KYRN 更名为 **mu**，终端命令 `mu`，视觉标识 μ（U+03BC）。第一阶段只改用户看得见的名字和数据路径：命令、`/mu`、欢迎页、`mu.json`、`MU_*` 环境变量、`~/.mu`。仓库文件夹名、包名 `@kyrn/judge`、目录 `packages/kyrn-judge` 和 `kyrn/`、会话里已存的 `kyrn.*` 类型名都没有改。旧的命令名、`kyrn.json`、`KYRN_*` 变量继续有效。对照表、保留项的原因和迁移步骤见 [10-rename-to-mu.md](10-rename-to-mu.md)。下文正文里的 "KYRN" 指同一个项目。

## 1. 项目要做什么

**mu（原名 KYRN）是以 pi 为执行底座、深度融合判定模型的编程 Harness，同时提供 CLI 和桌面入口。**

用户的目标是：用尽可能小、尽可能相关的上下文，完成正确的事情，最大程度发挥主模型能力。不是单纯把提示词剪短，也不是给聊天界面多接几个模型。

分工：

- **主模型**：复杂推理、代码实现、文本生成、最终判断与报告。
- **判断模型**：高频、小状态、类型化决策，例如任务归类、技能披露、子代理路由、工具结果准入、旧上下文取舍、蜂群信息传播。
- **确定性代码**：协议、状态机、预算、执行、超时、取消、存储、权限约束与可视化。
- **桌面和 CLI**：同一套 Harness 的入口，不各自维护一套代理调度器。

Jev 是当前主用判断模型，但不是不可替换的基础设施。保留 Laya、普通 LLM、HTTP 服务、Mock 的可插拔接口。

核心体验应是：

```text
用户输入
  → 可见的归类等待与结果
  → 选择主模型思考档位、相关技能与经验
  → 简单任务直接执行；复杂任务选择 delegate / hive
  → 工具输出和蜂群发现按价值进入对应上下文
  → 接近预算时压缩，始终显示状态与实际效果
  → 验证结果，保留有价值的经验
```

优化指标应同时包括任务成功率、关键约束保留率、总输入量、缓存命中、延迟、成本、人工干预次数。少一些 tokens 不自动等于更好。

## 2. 总体完成状态

**已经是可本地使用、主要链路已接通的开发版；尚不是完成稳定性验证和发布工程的产品。**

框架覆盖面较完整，真正缺的是复杂任务下的可靠性、决策质量评估、能力之间的协同，以及桌面产品化。不给整体完成百分比：一条路径跑通和长期稳定使用不是同一件事。

### 当前工程位置

| 内容 | 位置 / 状态 |
| --- | --- |
| Harness | `/Users/baihe/Documents/KYRN`，分支 `kyrn` |
| 判断内核与扩展 | `/Users/baihe/Documents/KYRN/packages/kyrn-judge` |
| 桌面端二开 | `/Users/baihe/Documents/KYRN-desktop`，分支 `codex/kyrn-desktop` |
| 正式桌面开发入口 | `/Users/baihe/Documents/KYRN-desktop/scripts/kyrn/start` |
| 早期独立桌面壳 | `/Users/baihe/Documents/KYRN-desktop/kyrn`，已暂停；不要误当产品入口 |
| CLI | `/Users/baihe/Documents/KYRN/kyrn/bin/mu`（`mu link` 后即 `mu`）；`kyrn/bin/kyrn` 是转发到它的兼容脚本，桌面适配器仍调用这个旧路径 |
| 数据目录 | `~/.mu`；机器上只有 `~/.kyrn`、还没有 `~/.mu` 时继续用 `~/.kyrn`，绝不在旧目录旁边另建新目录。迁移是手工的一步，见 10 号文档 |
| 判断配置 | `<数据目录>/agent/mu.json`；没有时读同目录的 `kyrn.json` |
| pi 模型与上下文配置 | `<数据目录>/agent/settings.json` |
| ACP 会话映射与桌面事件 | `<数据目录>/acp-sessions` |

当前桌面架构：

```text
桌面端原有 UI
  → 后端的 ACP 管理
  → KYRN ACP Adapter
  → mu --mode rpc（经 kyrn/bin/kyrn 转发）
  → pi + @kyrn/judge
```

两边都有大量尚未提交、尚未跟踪的工作；本次整理没有提交或推送。

### 当前本机配置（不是产品默认值）

- 判断模型：`tiers: ["jev"]`，有直连凭据时走 TypeSafe。
- 判断模式：`active`。包自身默认仍是 `shadow`。
- Beta 压缩：开启；pi 自动压缩开启。
- 自定义阈值：`maxContextTokens = 0`，跟随模型窗口减预留量。
- 默认主模型：`openai-codex/gpt-5.6-sol`，`medium`；具体桌面会话可单独选 Astra 等其他模型。
- Writer：`openai-codex/gpt-5.6-luna`。
- 子代理模型梯队：Luna → Terra → Sol。
- Preflight 等待预算：6000 ms。

此前桌面观察中，272,000 tokens 窗口对应自动阈值 255,616；这是当时模型与配置的结果，不是写死的产品阈值。没有为演示压缩而降低用户设置。

## 3. 已实现的能力

### 3.1 判断内核

- 类型化问题：boolean、choice、score；类型化决策定义与结果校验。
- Jev 直连 / Vercel Gateway、Laya 本地服务、普通 LLM、HTTP、Mock Provider。
- 级联判断、按能力分流、按决策点指定判断模型。
- `off / shadow / active`，置信区间、弃权、超时与错误回退。
- 决策账本：模型、问题版本、结果、耗时、告警、级联经过。
- 展示事件与模型上下文分离，界面信息不额外占主模型上下文。

注意：回退按决策性质区分。普通建议可退回原行为；风险确认与蜂群信息发布采取更保守的处理。不要概括成所有失败都自动放行。

### 3.2 CLI 与输入阶段

- KYRN 启动器、欢迎页、状态和诊断命令。
- 复用 pi 的模型切换、思考强度、会话恢复、工具、扩展和技能机制。
- OpenAI Codex 登录态已接通。
- 输入分类、任务档位、澄清 / 计划 / 并行提示，以及本轮思考强度选择。
- 提交后显示归类等待，归类结果可展开；超时、晚到、规则兜底有区分。
- 中途插话的 steer / followUp 路由。
- `/help`、`/status`、`/doctor`、`/ledger`、`/agents`、`/remember`、`/browse`、`/swarm` 等入口。

判定器显示的是实际问题、概率、判定与采取的动作，不是虚构的思维链。

### 3.3 上下文与经验

- 技能说明按相关性披露，被隐藏技能可通过 `find_skill` 找回。
- 经验捕获、可选 Writer 提炼、按项目筛选和相关性召回。
- 工具长输出分块准入：裁掉低价值块，并留下完整输出入口。
- 旧工具输出的主动缩减，出站请求裁剪与会话原文分开。
- 漂移 / 循环提示、完成前验证提醒、通知路由、缓存保温判断。
- `locate`：路径预筛后由判断模型排序，减少盲目搜索。

### 3.4 子代理与困难任务蜂群

- `delegate`：独立子任务并行执行。
- `hive`：同一困难目标，从不同角度调查，共享白板。
- 六个内置角色：scout、planner、worker、reviewer、browser、investigator；支持用户角色覆盖。
- 按子任务选择角色、模型档位和思考强度。
- 判定器发布闸：决定哪些发现值得进入白板。
- 判定器投递闸：决定哪些发现对哪只蜂有用。
- 传播记录保留来源、接收者、通过与未通过的判断。
- 共享运行时：排队、思考、执行工具、重试、收尾、完成、失败、停止、超时状态。
- 每蜂时间预算、无事件超时、请求交报告、强制结束、部分报告回收。
- 修复晚到消息重复唤醒已结束子代理、短回应覆盖长报告等问题。
- 每蜂转录、最近步骤、当前工具、模型与计数可见。

已做真实运行验证，但这不是“任何情况下都不会卡住”的保证。

### 3.5 内置浏览器

- 借鉴并移植 jev-ultrafast 的操作 / 目标多头判断方式。
- 主模型给目标，判断模型选下一步操作与目标，代码通过 CDP 执行。
- 浏览器工具、browser 子代理角色、技能入口已经接通。
- 独立浏览器配置目录；子代理隔离浏览器实例；支持 open shadow root。
- 动作前检查页面与元素新鲜度，设置步骤 / 无进展 / CDP 时间预算。
- 文本输入由 Writer 或主模型生成；判定器不负责生成文字。

历史 MDN 任务有真实完成记录；这不代表所有网站都能通用、稳定或保持相同速度。

### 3.6 Beta 无摘要压缩

- 接入 pi 的原生压缩事件，不另起一套会话历史系统。
- 先识别过时输出，再结合词法相关度与判断模型打分，按预算裁剪。
- Beta 路径保留用户 / 助手文字，裁剪工具结果；预算仍不满足时回退摘要。
- 压缩结果保存结构化历史，下次可重新评估。
- 自动阈值接入下一次模型请求前的原生边界，而不是从工具回调里强行中断任务。
- 支持 `compaction.maxContextTokens`；小预算时相应限制最近历史保留量。
- 记录实际压缩前后估算 tokens、字符数、保留 / 裁剪 / 删除数量、失败或取消。

阈值是提前触发点，不是硬截断上限。单次大工具返回仍可能先越过阈值。开启 Beta 与实际发生压缩是两回事。

### 3.7 原生桌面

- 最大程度复用桌面端原有的项目、会话、编辑 / 文件展示、模型选择、工具卡片和审批 UI。
- KYRN 是唯一启用的代理入口；其他代理在后端禁用并从产品入口移除，原始源码和依赖未全面裁掉。
- 模型和思考强度来自真实运行时，可切换并得到确认。
- 模型公开的 thinking 增量及历史展示已接通。
- 支持文字、文本资源和常见栅格图片输入。
- 原生设置：Beta 开关、自动压缩、tokens 阈值、Jev / 判断模型配置、级联与只写凭据。
- 右侧协作面板：每蜂执行、判定器的判定、白板信息流、经验流转、实际图片产物。
- 上下文用量、自动压缩阈值、压缩状态与效果记录。
- 绿色缓存圆环：`cacheRead / (input + cacheRead + cacheWrite)`；显示会话累计、token 加权的命中率，排除输出；压缩后不清零。
- 会话事件持久化、增量读取与会话隔离；界面失败不应影响模型任务。
- ACP 等待 `agent_settled`，修复把 prompt 提前 ACK 误当整个任务结束的问题。

图片面板展示工具实际返回的图片；并不意味着文本判断模型已经拥有图像理解能力。

## 4. 已做了，但还没有做得足够好

| 领域 | 具体缺口与影响 | 后续验收重点 |
| --- | --- | --- |
| 判断准确性 | 真实使用仍会出现 `unknown`、兜底或晚到；更换 Jev 不自动解决题目设计和阈值校准 | 固定任务集，观察误判、弃权、误过滤及任务成功率，不只看延迟 |
| 蜂群稳定性 | 有看门狗和收尾，但复杂网络 / 浏览器 / 多进程组合仍需长时间回归；失败后没有完整的持久化恢复调度器 | 一蜂卡住不拖死全体，停止后有报告，无残留进程，完成状态真实 |
| 蜂群信息质量 | 工具结果候选目前主要看开头约 600 字符，深处证据可能漏掉；不是每个步骤都得到完整语义评估 | 分块候选、证据来源、误过滤复查，避免传播过量与重复 |
| 并行修改 | 尚无完整 worktree 隔离、冲突检测与合并验收 | 调查型蜂群和编辑型蜂群分清；prompt 中的“只读”不等于操作系统沙箱 |
| Beta 压缩 | 长会话连续多次压缩、关键约束保留、与 forgetting 的重复裁剪未充分验证；归档在临时目录，长期可恢复性仍有缺口 | 多轮真实任务回放、原文找回、缓存损失与任务质量一起衡量 |
| 文件定位 | `locate` 只用 `git ls-files`，漏掉未跟踪的新文件；当前 KYRN 自身恰有大量未跟踪代码 | 纳入非忽略的未跟踪文件，明确无 Git 工作区行为，限制扫描范围 |
| 经验 | JSONL 与相关性召回已工作，缺少完善的去重、冲突消解、过期、修订和管理界面 | 错经验可撤回；旧偏好不覆盖新约束；项目边界清晰 |
| 权限层 | 风险检查主要覆盖部分 bash 模式；“是否用户要求”仍会影响放行，不是覆盖所有工具的确定性权限系统 | 把硬规则与模型建议分开；不能把现有 guard 宣称为完整沙箱 |
| 桌面交互 | 事件能看见，但部分内容仍是原始 JSON；原生每蜂停止 / 收尾按钮、统一时间线、执行阶段解释仍待完善 | 用户能判断是在归类、等模型、跑工具、等其他蜂还是在压缩 |
| 桌面适配 | ACP 会话映射依赖后端 v0.2.2 的只读数据库表；客户端 MCP 未导入，自由文本扩展对话框尚未完整映射 | 升级兼容性测试、协议边界、恢复与错误提示 |
| 性能与统计 | 有缓存 / 用量显示，但没有完整的主模型、判断层、Writer、各蜂成本归因和统一效果报告 | 区分当前上下文、累计输入、缓存命中和经济成本，避免混为一个数字 |
| 工程发布 | 启动依赖本机路径；判断包仍为 private；根 build 顺序尚未包含新判断包，干净安装 / 打包分发未验收 | 从全新目录可安装、构建、启动；再做签名、升级和分发 |

此外，旧文档包含阶段性描述。遇到“零上游修改”“五个角色”“不会卡死”“仍在等待 Vercel 绑卡”等表述，必须结合当前代码和日期核对。

### 4.1 缓存诊断专项：开发中、待验收

2026-09-21 用户同步：以下四项正在开发，本次仅记录进度，不代表已实现、已部署或测试通过。

1. 保留累计缓存圆环，另显示最近主模型请求的缓存读取量、上一请求与当前请求的输入总量、请求间隔及 provider/model。
2. 对出站系统提示、工具、历史前缀和推理参数分别记录指纹；不保存正文、凭据或认证头。
3. 区分缓存未命中、正常新增输入、模型切换和 WebSocket 增量续传回退；证据不足时标为未知，不直接归因于判定器。
4. 技能披露状态跨 reload/resume 持久化，并保持会话分支隔离和隐藏技能找回入口。

以上与已完成的主动遗忘阈值合并、裁剪状态持久化修复分开跟踪。调查证据、具体范围和验收标准见 [07-cache-investigation.md](07-cache-investigation.md)。累计缓存输入占比不等于旧前缀复用率，不以圆环数字上涨代替任务质量和实际成本验证。

## 5. 尚未完成的关键能力

1. **持久的 Task Frame**：后台维护目标、约束、当前子目标、验收条件；当前仍以首条 / 最新消息代替。
2. **工具 intent**：给结果准入、相关性和漂移判断提供明确的调用目的。
3. **瞬时工具失败自动重试**：识别临时故障，在不重复副作用的前提下重试，不先消耗一轮主模型。
4. **逐步骤思考强度自适应**：已有输入级和子代理级路由，尚不是完整的执行中动态调整。
5. **子代理最终结果准入**：判断结果是否充分、哪些证据值得进入主上下文。
6. **旁支自动分支隔离**：插话投递已做，但不等于自动利用 pi 会话树隔离旁支再合并结论。
7. **统一能力激活层**：已有 skill 披露，但还不是按任务协调工具、MCP、LSP、AST、后台服务的能力目录。
8. **蜂群竞速 / 提前收敛**：已有停止手段，尚缺可靠的“足够解决问题了”判定与统一策略。
9. **CLI / App 共同控制同一个活动会话**：目前是共享配置、同一执行引擎和持久历史，不是实时双端接管。
10. **发布与质量闭环**：固定基准任务、长期回放、故障注入、干净安装、打包和发布流程。

## 6. 验证到什么程度

最近一轮已执行并通过：

- Harness 完整 `npm run check`：格式 / lint、依赖、导入、入口图、锁文件、类型与浏览器 smoke 检查。
- KYRN 四个专项文件：15 个测试（上下文预算、Beta 压缩、展示事件、扩展接入）。
- pi 两个压缩回归文件：37 个测试（含模型覆盖和自动压缩时序）。
- 桌面五个专项文件：29 个测试（ACP、事件、设置、上下文 / 缓存、持久化活动）。
- 桌面 TypeScript、专项 lint、格式校验和全部语言的 i18n 校验。
- 原生桌面观察：上下文用量、Beta 状态和绿色缓存环真实更新；曾观察到 44.1%，随后随请求变化，不是固定演示数字。

这些是具体范围内的验证，不是全产品 E2E 通过声明。本次状态整理没有重新跑全量测试，也没有执行发布构建。

历史还有浏览器、真实 hive、CLI 和手动 Beta 压缩的运行记录，见 04 文档。当前桌面“压缩效果”只展示实际记录，不制造一条压缩成功用于展示。

## 7. 建议推进顺序

### P0：让当前体验可靠

- 固化蜂群开始 → 执行 → 传播 → 收尾 → 停止 / 失败的真实回归。
- 验证桌面取消、重连、会话恢复、运行中保存配置和前端重载。
- 修复 `locate` 对未跟踪代码的遗漏。
- 核对上下文与缓存统计口径，避免压缩后复用旧用量。
- 完成 Beta 多次自动压缩和关键约束保留测试；暂不把更多判断点盲目切成 active。

### P1：让信息流有统一依据

- Task Frame + 工具 intent。
- 统一 admission / forgetting / compaction 的证据与评分，减少重复判断。
- 细化 hive 的候选分块、来源和子代理报告准入。
- 经验去重、纠错与过期。

### P2：补齐编程能力选择

- 统一能力目录与发现入口。
- 评估 MCP adapter、只读 LSP / 符号查询、AST 搜索、轻量搜索 / 抓取。
- 优先复用 pi 和桌面端现有的能力，不整体迁移底座，也不再造重复浏览器和蜂群。

### P3：形成可交付产品

- 干净安装、构建与桌面打包。
- 配置迁移、升级兼容、运行日志和诊断。
- 按用户确认做 Git 提交、远端备份与发布。
- 若继续要求双端实时同步，再设计单会话写入者和共享运行服务。

## 8. 代码交接索引

### Harness

- `/Users/baihe/Documents/KYRN/packages/kyrn-judge/src/decision.ts`：决策引擎。
- `/Users/baihe/Documents/KYRN/packages/kyrn-judge/src/cascade.ts`：级联与能力路由。
- `/Users/baihe/Documents/KYRN/packages/kyrn-judge/src/config.ts`：配置。
- `/Users/baihe/Documents/KYRN/packages/kyrn-judge/src/extension/kyrn-judge.ts`：扩展装配。
- `/Users/baihe/Documents/KYRN/packages/kyrn-judge/src/extension/runtime.ts`：共享运行状态和展示。
- `/Users/baihe/Documents/KYRN/packages/kyrn-judge/src/extension/features`：各注入点。
- `/Users/baihe/Documents/KYRN/packages/kyrn-judge/src/swarm`：蜂群状态机、运行时和展示。
- `/Users/baihe/Documents/KYRN/packages/kyrn-judge/src/hive`：白板与投递。
- `/Users/baihe/Documents/KYRN/packages/kyrn-judge/src/browser`：浏览器循环与 CDP。
- `/Users/baihe/Documents/KYRN/packages/kyrn-judge/src/compaction`：压缩历史与裁剪。

当前对 pi 核心的已跟踪改动主要是四个文件：

- `/Users/baihe/Documents/KYRN/packages/coding-agent/src/core/settings-manager.ts`
- `/Users/baihe/Documents/KYRN/packages/coding-agent/src/core/compaction/compaction.ts`
- `/Users/baihe/Documents/KYRN/packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `/Users/baihe/Documents/KYRN/packages/coding-agent/src/modes/rpc/rpc-types.ts`

它们分别接入上下文阈值和 RPC 用量 / 有效配置；不是“上游完全零改动”了。

### 桌面

- `/Users/baihe/Documents/KYRN-desktop/packages/desktop/src/process/agent/kyrn/KyrnAgent.ts`：ACP 适配。
- `/Users/baihe/Documents/KYRN-desktop/packages/desktop/src/process/agent/kyrn/piRpc.ts`：pi 子进程协议。
- `/Users/baihe/Documents/KYRN-desktop/packages/desktop/src/process/agent/kyrn/telemetry.ts`：事件落盘与上下文统计。
- `/Users/baihe/Documents/KYRN-desktop/packages/desktop/src/process/agent/kyrn/settings.ts`：共享配置、只写凭据。
- `/Users/baihe/Documents/KYRN-desktop/packages/desktop/src/process/bridge/kyrnBridge.ts`：原生 IPC。
- `/Users/baihe/Documents/KYRN-desktop/packages/desktop/src/renderer/pages/conversation/KyrnPanel`：右侧面板。
- `/Users/baihe/Documents/KYRN-desktop/packages/desktop/src/renderer/pages/settings/KyrnSettings`：设置页。

## 9. 可直接复制的交接提示词

```text
你接手的是 KYRN，不是从零写一个聊天客户端。

目标：基于 pi 深度二开，主模型负责复杂思考与实现，判定模型（如 Jev，可替换）负责高频类型化决策，确定性代码负责执行和约束。用更少、更相关的上下文完成正确任务，同时保住缓存收益和任务质量。提供 CLI 与原生桌面体验。

先读并核对：
1. /Users/baihe/Documents/KYRN/AGENTS.md
2. /Users/baihe/Documents/KYRN-desktop/AGENTS.md
3. /Users/baihe/Documents/KYRN/kyrn/docs/06-project-status-and-handoff.md
4. /Users/baihe/Documents/KYRN/kyrn/docs/04-injection-points.md
5. /Users/baihe/Documents/KYRN/kyrn/docs/05-desktop-integration.md
6. /Users/baihe/Documents/KYRN-desktop/scripts/kyrn/README.md
7. /Users/baihe/Documents/KYRN/kyrn/docs/07-cache-investigation.md
缓存诊断专项（最近请求用量、出站指纹、未命中归因、技能披露状态持久化）由用户同步为开发中、待验收；不要把它与已完成的主动遗忘修复混为一谈，也不要把累计圆环偏低直接判成判定器破坏缓存。
以当前代码、配置和验证结果为准；旧文档里的历史测试数量、零上游改动、蜂群绝不卡住等表述不应直接沿用。

两个工作区：
- /Users/baihe/Documents/KYRN，分支 kyrn：pi fork，核心新增包 packages/kyrn-judge。
- /Users/baihe/Documents/KYRN-desktop，分支 codex/kyrn-desktop：桌面端二开。

桌面方向已经确定：最大程度复用桌面端原有的项目、会话、模型/思考选择、工具和文件组件，通过 ACP → mu --mode rpc 原生接入。不要继续 /Users/baihe/Documents/KYRN-desktop/kyrn 中已暂停的独立桌面壳。其他代理入口已禁用，但源码没有彻底删除；不要把禁用写成物理裁剪完成。

当前已经有：可插拔判断引擎、能力级联、决策账本、输入归类与可见等待、技能披露、经验捕获/召回、工具结果准入、主动遗忘、Beta 压缩、delegate/hive、蜂群运行状态/预算/收尾/停止、判定器发布与投递闸、内置浏览器、原生 thinking、右侧协作面板、上下文占用/阈值/压缩效果、绿色缓存命中圆环。优先完善已有实现，不另起重复系统。

当前本机判断档 jev、默认模式 active、Beta 与自动压缩开启；自定义 cap 为0，跟随模型预算。Codex 登录已完成。Jev 直连可用，Vercel 绑卡不再是整个项目的前置阻塞。Laya 保留为实验可选后端，不按“所有语义任务都可靠”处理。判断模型与主模型配置分开。

上下文阈值是下一次模型请求前的自动触发点，不是硬截断。只把 compaction_end 的实际结果统计成效果；压缩计划、shadow 判定与失败不得算成功。压缩后的 tokens 标明估算，新的模型用量回来前不复用旧值。缓存命中率按 session cacheRead/(input+cacheRead+cacheWrite) 计算，排除输出，无数据用“—”，压缩不清零累计。

近期优先：
1. 复现并完善长任务蜂群、取消/重连/收尾/失败回收，状态要真实；不要宣称超时机制等于永不卡死。
2. 核对 locate 只读 git ls-files 的遗漏，纳入非忽略的未跟踪文件并补测试。
3. 测试多次自动 Beta 压缩、关键约束保留和原文找回，理顺与 forgetting/admission 的重复判断。
4. 再做 Task Frame、工具 intent、工具临时失败重试、蜂群分块传播/结果准入、旁支会话树隔离与统一能力目录。
5. 后续完成 worktree 编辑隔离、发布构建和真正的 CLI/App 活动会话同步。

已知边界：investigator 的“只读”主要是角色约定，含 bash，不是硬沙箱；guard 也不是全工具权限系统。桌面与 CLI 共享配置不等于共同控制同一个活动进程。客户端 MCP 和自由文本扩展对话框尚未完整适配。浏览器不覆盖 closed shadow root/iframe/canvas。模型效果、压缩质量与总成本优势尚未形成系统评估。

开始先看两个仓库的 git status，确认是否有其他会话在修改或运行。大量代码仍未跟踪，不能清理、覆盖、stash 或重置别人的工作；不要触碰无关 fairy-tale.html、.codex 等文件。没有用户要求不提交、不推送；运行中的桌面任务不随意重启或中断。

凭据只在 /Users/baihe/Documents/KYRN/.env，由启动器加载。不得打印、复制到文档/日志/代码或把它们放进命令参数；不要读取 OAuth auth.json，不修改全局 ~/.claude/settings.json，不代填付款资料。判断配置来自用户 agent 目录，不从项目仓库自动信任外部端点。保留浏览器独立 profile。

Node 可用路径：/Users/baihe/.nvm/versions/node/v24.16.0/bin。
CLI：/Users/baihe/Documents/KYRN/kyrn/bin/mu（旧路径 kyrn/bin/kyrn 转发到它）
桌面：/Users/baihe/Documents/KYRN-desktop/scripts/kyrn/start
配置：~/.mu/agent/mu.json 和 settings.json（未迁移的机器上是 ~/.kyrn/agent/kyrn.json，两种都读）。

先完整阅读要改的文件，再做小范围实现。Harness 修改后跑 npm run check；只跑相关测试文件，不直接运行全量 npm test 或 npm run build。pi 会话测试用 faux harness，不花真实模型 tokens。桌面做类型、专项 lint、测试、i18n 类型生成与校验。测试用户设置时使用隔离目录，别为演示伪造事件或篡改真实会话。

最近已通过的范围：Harness check；15个 KYRN 相关测试；37个 pi 压缩回归；29个桌面专项测试；桌面类型/lint/i18n。它们不是发布验收或全量E2E证明。每轮交付写清：实际改了什么、验证了什么、哪些还没验证、下一步最重要的问题。

本轮先给出简短的现状核对与最高优先问题，再按用户本轮具体要求推进，不重新做整套框架规划，不擅自扩展任务范围。
```
