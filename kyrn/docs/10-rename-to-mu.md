# KYRN 更名为 mu

更新日期：2026-09-22。状态：**第一阶段完成：代码（harness 和桌面端）已提交，数据已迁移到 `~/.mu`，命令行实机冒烟通过。只剩桌面端在真实数据上的确认（第 6 节）。**

新名 **mu**，终端命令 `mu`，视觉标识 **μ**。μ 一律用 U+03BC（希腊字母 mu），不用 U+00B5（微符号，Mac 上 Option+M 打出来的是它）。所有标识符只用 ASCII 的 `mu`。中文标语“见微知著”：μ 在单位前缀里就是“微”。

本轮只改名，没有功能改动。

## 1. 改了什么，没改什么

### 用户看得见的（已改）

| 项目 | 旧 | 新 | 旧名还能用吗 |
| --- | --- | --- | --- |
| 终端命令 | `kyrn` | `mu`（`kyrn/bin/mu`，`mu link` 建 `~/.local/bin/mu`） | 能。`kyrn/bin/kyrn` 和 `kyrn-dev` 转发到 `mu`，`~/.local/bin/kyrn` 旧链接照常工作 |
| 会话内命令 | `/kyrn …` | `/mu …` | 不能，直接换了 |
| 欢迎页 | 方块字 KYRN | 方块画的 μ + “mu · judgment-first coding agent” + “见微知著” | — |
| 终端标题 | `kyrn - <目录>` | `μ - <目录>` | — |
| 模型看到的身份 | “This harness is KYRN …” | “This harness is mu (written μ) …”，系统提示里的段名也由 `kyrn` 改为 `mu` | 旧会话续聊时系统提示会变一次，缓存前缀失效一次，属预期 |
| 上下文里的标记 | `[kyrn: omitted …]` 等 | `[mu: omitted …]` | 旧会话里已写下的标记保持原样；没有代码回读这些标记 |
| 技能 | `kyrn-browser` | `mu-browser` | — |
| 配置文件 | `<agent>/kyrn.json` | `<agent>/mu.json` | 能。没有 `mu.json` 时读 `kyrn.json`。`mu.json` 存在但损坏时报错，不回退，免得悄悄带回旧设置 |
| 环境变量 | `KYRN_*` | `MU_*` | 能。新名未设置或为空时读旧名 |
| 数据目录 | `~/.kyrn` | `~/.mu` | 能。见第 3 节 |
| 经验库 | `<agent>/kyrn/lessons.jsonl` | `<agent>/mu/lessons.jsonl` | 磁盘上本来就没有这个目录，直接改 |

同时认新旧两种拼写的环境变量：`JUDGE`、`JUDGE_MODE`、`WRITER`、`CHROME`、`AGENT_DIR`、`CODING_AGENT_DIR`、`APP_DIR`、`LINK_DIR`、`SESSIONS_DIR`、`LOCAL_JUDGE_URL`、`LOCAL_JUDGE_PORT`、`LOCAL_JUDGE_MODEL`、`LOCAL_JUDGE_RUN_DIR`、`LOCAL_JUDGE_MIN_LENGTH`。实现：TypeScript 里是 `packages/kyrn-judge/src/naming.ts` 的 `muEnv()`，脚本里各自内联同样的规则。仓库根的 `.env` 没有读、没有改，里面的旧变量名继续有效。

### 刻意不改的

| 保留项 | 原因 |
| --- | --- |
| 仓库文件夹 `KYRN`、`KYRN-desktop` | pi 的会话按工作目录归档（`--Users-baihe-Documents-KYRN--`），桌面端的 `KYRN_ROOT` 默认指向 `../KYRN`，git worktree、`~/.local/bin` 的链接和 Claude 的项目记忆都记着这个路径 |
| 会话和桌面事件里已存的类型名：`kyrn.decision`、`kyrn.verdict`、`kyrn.hint`、`kyrn.notice`、`kyrn.steer`、`kyrn.nudge`、`kyrn.monitor`、`kyrn.skills`、`kyrn.lessons`、`kyrn.hive`、`kyrn.swarm`、`kyrn.forgetting.state`、`kyrn.presentation.v1`，以及压缩记录里的 `details.kyrn` | 旧会话必须照常工作：压缩靠 `startsWith("kyrn.")` 把自家消息排除在外（漏进去会被当成 “[User]” 文本），遗忘状态靠类型名恢复，判定行靠类型名渲染，`mu ledger` 和回测脚本靠它读决策，桌面端靠它识别事件。`test/naming.test.ts` 把这些名字钉死了 |
| 两个仓库之间的其他约定：临时目录名 `kyrn-hive-*`、`kyrn-swarm-*`（桌面端用正则校验）、事件类型 `kyrn_rpc_closed`、父子进程之间的 `KYRN_SWARM_*`、`KYRN_HIVE_*` | 只改一边，另一边会不报错地丢数据 |
| 启动器生成的 `<数据目录>/app/package.json` 里的 `name: @earendil-works/pi-coding-agent` | pi 的自更新按这个包名装包，而 npm 上的 `mu` 是别人的包 |
| 包名 `@kyrn/judge`、目录 `packages/kyrn-judge` 和 `kyrn/`、脚本文件名 `kyrn-doctor` 等、类型名 `KyrnRuntime` 等、页面里的 `window.__kyrnBrowser` | 第二阶段（可选）。纯内部名字，用户看不见 |

## 2. 启动器

- `piConfig` 改为 `{ name: "mu", configDir: ".mu" }`。**pi 只读 `<应用名大写>_CODING_AGENT_DIR`**，改名后就是 `MU_CODING_AGENT_DIR`，旧的 `KYRN_CODING_AGENT_DIR` 和 `PI_CODING_AGENT_DIR` 它都不再看。所以启动器必须导出新变量，否则 pi 会悄悄落到 `~/.mu/agent` 的空目录里。现在三个名字一起导出。
- 应用视图（`<数据目录>/app`）原来只在上游 `package.json` 更新（按 mtime）时重建；现在 `piConfig` 对不上也重建。视图仍放在仓库外面：放进仓库，biome 会跳过真实源码。
- `mu link`：`MU_LINK_DIR`（或 `~/.local/bin`）下已有不是自己的 `mu`，或者 PATH 上已有别的 `mu`（Homebrew 的 maildir-utils 就叫 `mu`），都只提示、不链接；`mu link --force` 才会抢在前面。本机目前 PATH 上没有别的 `mu`。

## 3. 数据目录：先能用，再迁移

代码合并和数据迁移是两步，中间不能坏。规则只有一条，各处实现一致（harness 的 `naming.ts` 的 `muHome()`、启动器、`kyrn-judge-local` / `kyrn-doctor` / `kyrn-ledger`，以及桌面端的 `naming.ts`）：

> `~/.mu` 存在就用它；否则 `~/.kyrn` 存在就继续用 `~/.kyrn`；两个都没有（新机器）才用 `~/.mu`。

关键在于：迁移之前，任何代码都不会在 `~/.kyrn` 旁边建出一个 `~/.mu`。两个数据目录并存意味着两份登录、两份会话列表、两个浏览器配置。

迁移由 `mu migrate` 完成（用户已于 2026-09-22 在本机执行，结果见第 4 节）。它只做三件事，全部是目录级操作，不打开、不复制、不改写里面任何文件，`auth.json`、`models-store.json` 的内容和 600 权限原样跟着走：

1. `mv ~/.kyrn ~/.mu`（同一个文件系统内的改名，约 315 MB 也是瞬间完成）。
2. `ln -s ~/.mu ~/.kyrn`：桌面端 11 个会话映射文件里存的是 `…/.kyrn/agent/sessions/…` 的绝对路径，这个软链兜住它们。
3. `~/.mu/agent/kyrn.json` 改名为 `mu.json`（已有 `mu.json` 就不动）。

动手之前它先检查，任何一条不满足就什么都不动、退出码 1：

- `~/.mu` 已经存在：拒绝。两个数据目录从不合并、不覆盖，由人来判断哪个是真的。
- 还有东西在用旧目录：本地判定服务（看 `local-judge/judge.pid` 里的进程是否活着；残留的旧 pid 不算）、mu 会话（终端里的，或桌面端对话背后的）、mu 的浏览器、桌面端的后端进程。原因：改名和建软链之间有一个极短的空档，这时有进程往旧路径写，就会凭空再造出一个 `~/.kyrn`，数据目录一分为二。提示里会写明是谁、怎么停。
- `~/.kyrn` 已经是软链（迁移过了）或不存在：说明情况，退出码 0。

`mu migrate --dry-run` 只做检查并说出将要做什么，不改任何东西。`mu doctor` 在还没迁移的机器上会提示这条命令。

应用视图 `~/.mu/app` 不需要删：启动器发现里面的 `piConfig` 名字不是 `mu` 就会重建（第 2 节）。

2026-09-22 在真实机器上跑过一次 `mu migrate --dry-run`：因为本地判定服务（pid 17459）在运行而拒绝，没有误报其他进程，没有改动任何东西。所以真正迁移前要先 `mu judge stop`，并退出桌面端和所有 mu 会话。

## 4. 验证

已验证（在隔离工作树分支上，Node 24）：

- `npm run check` 通过。
- `packages/kyrn-judge` 全部 24 个测试文件、211 个用例通过，其中为改名新增 18 个：
  - `test/naming.test.ts`：`MU_*` 优先、`KYRN_*` 兜底、空值不遮蔽；`mu.json` 优先、`kyrn.json` 兜底、损坏的 `mu.json` 报错不回退；数据目录三种情况；`MU_CHROME` / `KYRN_CHROME`；已存类型名不变。
  - `test/launcher.test.ts`（真实执行启动器，临时 HOME）：旧命令名转发；`link` 遇到别的 `mu` 不覆盖、不遮蔽；`piConfig` 对不上时重建视图且包名不变；未迁移的机器留在 `~/.kyrn` 且不创建 `~/.mu`。`mu migrate`：一步搬完、登录文件内容和 600 权限不变且不出现在输出里、旧路径变成软链且经由它仍能读到会话映射、配置文件改名、重复运行无害；`--dry-run` 什么都不改；`~/.mu` 已存在时拒绝且两边原样；判定服务、会话、浏览器、桌面端后端任一在运行都拒绝（测试里用一个假的 `pgrep` 顶替，免得跑测试的机器上真有会话开着）。
- 旧的 `kyrn.*` 条目照常被压缩过滤、遗忘状态能恢复、判定行能渲染：这些行为的既有测试（`compaction.test.ts`、`forgetting.test.ts`、`preflight-view.test.ts`）原样通过，因为类型名没动。
- 欢迎页在 20～140 列宽度下不超宽、边框闭合（既有宽度测试）。μ 用方块字符画出来而不是直接打字：U+03BC 属于 East Asian Ambiguous 宽度，终端把它渲染成两格时会把右边框顶出去。字母本身只出现在终端标题里，那里没有边框要对齐。

### 迁移之后的实机冒烟（2026-09-22，本机）

用户执行了 `mu judge stop && mu migrate`。之后逐项检查，全部通过：

- **数据目录**：`~/.mu` 是真目录，`~/.kyrn` 是指向它的软链；里面还是 `acp-sessions`、`agent`、`app`、`browser-profile`（160 MB，内置浏览器配置仍在）、`local-judge`。`auth.json`、`models-store.json` 权限仍是 600，全程没有打开。`kyrn.json` 已改名为 `mu.json`，内容能解析，`features.admission.testLog: "rules"` 等设置原样。
- **旧的绝对路径**：桌面端 11 个会话映射全部存的是 `…/.kyrn/…` 路径，经软链能解析 5 个、悬空 6 个，与迁移前的数字完全一致（那 6 个在迁移前就指向已不存在的会话文件）。
- **命令**：`mu version` 和旧命令 `kyrn version`（经 `~/.local/bin/kyrn`）都输出 `mu 0.1.0 (pi 0.86.0)`。`mu doctor`：home 为 `~/.mu/agent`，登录、模型、判定器、Jev 密钥、浏览器各项正常，迁移提示不再出现。`mu judge status`：启动器按配置自动拉起了本地判定服务，运行目录在 `~/.mu/local-judge`，状态 ok。
- **旧决策可读**：`mu ledger 5 --json` 读出最近 5 个会话的 137 条 `kyrn.decision` 记录，全部解析成功（125 条判定、12 条回退）。
- **真实运行**：在一个临时目录里 `mu -p "…" --model openai-codex/gpt-5.6-luna < /dev/null`，退出码 0，回答正确，约 20 秒。会话写在 `~/.mu/agent/sessions/` 下；里面有 2 条 `kyrn.decision`（来源 judge、模式 active），说明判定层照常参与，存盘类型名也没变。随后 `mu -c -p "…"` 接上了同一个会话（答对了上一轮的内容，会话目录里仍只有 1 个文件）。这个测试会话留在 `~/.mu/agent/sessions/` 里名字带 `mu-smoke` 的目录下，可以删。
- **TUI 首屏**（伪终端 100 列抓屏）：欢迎框里是方块 μ、“mu · judgment-first coding agent”、“v0.1.0 · built on pi 0.86.0”、“见微知著”，边框闭合对齐；判定器一行显示 Jev 实时应答（912 ms）。终端标题先是 pi 自己设的 `mu - <目录>`，随后被扩展改成 `μ - <目录>`。屏幕上唯一的 “KYRN” 是工作目录路径里的文件夹名（刻意保留）。

没有逐项点过的：TUI 里的 `/mu`、`/help` 输出（有单元测试，没有在真实终端里看）；`mu link`（用户还没执行，`mu doctor` 会提示）。

## 5. 桌面端（KYRN-desktop）

- **注册按 command 找，不按显示名找。** 原来 `product.ts` 和 `scripts/kyrn/register.mjs` 都用 `name === 'KYRN'` 找后端里的代理：直接改显示名会另注册出一个 “mu”，旧对话还挂在旧代理上，“只启用自己”的逻辑还会把旧代理停掉。现在：command 相同的那一行就是自己的注册，不管它叫什么；名字不是 `mu` 就原地改名。后端 v0.2.2 的 `PUT /api/agents/custom/{id}` 是**整体替换**（漏传的图标、描述、参数、环境变量会被清空），所以把整条记录原样带回去，只换名字；描述只有还是我们自己写的旧文案时才换，用户改过的保留。

  **整条记录从哪里读（用真实后端测出来的，模拟后端测不出）：** 代理列表 `GET /api/agents/management` 不返回记录里的环境变量 `env`，后端也没有读取单条记录的接口。拿列表里的那一行回传，`PUT` 会把用户配的环境变量（比如指向别处的 `KYRN_ROOT`）悄悄清空。能拿到整条记录的只有 `PATCH /api/agents/{id}/enabled`：把 `enabled` 设成它现在的值，状态不变，返回值就是完整记录。完整记录里空列表不出现在 JSON 中，所以“没有 `env` 键”在完整记录里表示“没有变量”，在列表里什么都不表示；区分两者靠 `available` 字段（只有完整记录有，且一定有）。读不到完整记录就**不改名**：留一个旧名字，比清掉用户的变量代价小。后端保存前会探活，探活失败返回 400：改名失败**不挡启动**，注册照旧名工作，下次启动再试。同名（新旧名都算）但 command 不同的行仍然拒绝，绝不重复注册。两处代码规则一致。
- 界面文字：13 种语言各 3 句（设置、正在启动、启动失败）、窗口标题、侧栏品牌字、注册描述、ACP 的 `agentInfo.title`、适配器报错文案。i18n 键名 `kyrn.*`、IPC 通道、目录名、`agentInfo.name`、事件类型都没动。
- 配置：读 `mu.json`，没有再读 `kyrn.json`；**保存写回读到的那个文件**，不会在 `kyrn.json` 旁边再造一个 `mu.json` 把它遮住。迁移把文件改名后，同一个进程不用重启就跟过去。凭据变量名白名单同时接受 `MU_JUDGE_*` 和 `KYRN_JUDGE_*`。
- 路径：`agent` 和 `acp-sessions` 用第 3 节同一条数据目录规则（`process/agent/kyrn/naming.ts`，与 harness 的 `naming.ts` 对应），`MU_AGENT_DIR` 优先、`KYRN_AGENT_DIR` 兜底。适配器仍调用 `kyrn/bin/kyrn`：它转发到 `mu`，而且改名前的检出里也有这个文件，所以两个仓库谁先合并都不会坏。
- 顺带修了一个早就坏着的上游测试：`documentTitle.dom.test.tsx` 还在断言标题是上游的旧名。

验证：`tests/unit/kyrn`、侧栏品牌、窗口标题共 13 个测试文件 119 个用例通过，其中为改名新增 12 个（原地改名且整条记录带回、禁用的注册先按原样读再启用、保留用户自己写的描述、读不到完整记录就不改名、更新或读取被拒都不挡启动、已是新名不读不写、未注册时只注册一次、同名异 command 拒绝；`kyrn.json`/`mu.json` 的读写跟随；凭据变量两种前缀；数据目录规则）。模拟后端按真实后端的行为写（列表不给 `env`）；做过变异检查：改回“拿列表行回传”，测试报 `env: []` 失败。

**真实后端检查：** `node scripts/kyrn/registration-check/check.mjs`（桌面仓库）在临时目录里起一个真的后端 v0.2.2（独立的 HOME、数据目录、端口，PATH 上没有别的代理 CLI），19 项全过：全新机器只注册一次且名为 `mu`；旧名注册被 `register.mjs` 和应用启动代码（`product.ts` 原样通过 tsx 运行）原地改名，id 不变、没有第二个代理、生成的助手 id 不变且名字跟着变；图标、环境变量、技能目录、行为策略、yolo id 全部保留；禁用的注册改名后仍是禁用；重复运行无变化；用户自己写的描述保留；同名但 command 不同被拒绝且不新增记录；真实 HOME 下没有生成 `~/.mu`。这些行为都不是后端的书面约定，**后端每次升级后都要重跑一遍**。`tsc --noEmit` 0 错，改动文件的 Oxlint 0 警告、Oxfmt 通过，i18n 类型已是最新、13 种语言校验通过。冒烟：用临时 HOME 直接启动 ACP 适配器并发 `initialize`，返回 `title: "mu"`，真实的 `~/.mu` 没有被创建。

没验证：在用户真实数据上的原地改名（上面的检查用的是空的临时数据目录）、旧对话能否打开、Jev 面板和蜂群事件。这几项要等用户下一次启动桌面端；启动后可以只读地核对：后端里 command 为 `scripts/kyrn/acp` 的记录仍只有一条（迁移前的 id 是 `46714d71`）、名字变成 `mu`、旧对话还挂在它上面。

## 6. 还没做的

1. **桌面端在真实数据上的确认**（第 5 节的“没验证”）：等用户下一次启动桌面端。
2. `mu link`：把 `mu` 放上 PATH（用户执行）。
3. **第二阶段**（可选）：包名、目录名、类型名、脚本文件名、桌面端模块名、IPC 通道、git 分支名。第一阶段验收后再定。
