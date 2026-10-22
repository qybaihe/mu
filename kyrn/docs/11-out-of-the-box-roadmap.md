# 开箱即用路线图

更新日期：2026-09-22（上午更新）。来源：用户当天给出的目标（内置浏览器与 UltraFast 深度融合、Windows/WSL、设置与模型提供商、粉紫主题与界面打磨、本地 Laya 一键挂载、开箱即用的底线能力、按任务披露的能力包）。本文把目标拆成工作包，写明每一包的做法、先后和现状。状态随提交更新。

## 0. 一条总原则：装得多，露得少

集成多不等于臃肿，前提是模型的上下文不跟着涨。做法是**能力目录**（`packages/kyrn-judge/src/catalog/catalog.ts`，已完成）：

- 工具、MCP 服务器、语言服务器、能力包都登记到同一个目录。
- `always` 的每个会话都有；`judged` 的装着但不进模型的工具列表，判定器认定任务需要（`capability.disclosure`，只有确信“是”才打开）才露出来，背后的进程也到那时才启动。
- 藏起来不等于没有：模型随时能用 `find_capability` 查到并打开。模型不得不自己开口要的，记一条 `kyrn.capability`（`by: "requested"`），这就是以后评估披露判断的“漏判”标签。
- 用户用 `/capabilities` 看装了什么、开了什么，也能手动打开。
- 判断关闭（`off`）时什么都不藏；`shadow` 时只记录判断、不自动打开。

判定器管得住上下文，管不住安装体积、维护量、故障面和安全面。所以每一包都要：懒启动、失败不挡主流程、不引入能避免的依赖、项目级配置里能执行命令的东西一律先过信任确认。

## 1. 必做：开箱即用的底线

| 包 | 做法 | 状态 |
| --- | --- | --- |
| 能力目录 | 见第 0 节 | 已完成，6 个测试 |
| 任务帧（PRD FR-02，P0，后面多数功能的前提） | 目标、用户硬约束（原文 + 出处）、当前子目标、验收条件、未决问题、版本。每个版本存成 `kyrn.` 前缀的会话条目，跟着会话树回退。判定器只判断“要不要更新”（新任务 / 约束 / 纠正 / 子目标 / 无），变了才让 writer 产出新帧。版本号写进决策台账的 `origin`。唯一接缝是 `runtime.taskFrame()`，六个现有消费者一起升级 | **已完成**：真实任务帧、`/frame`、`kyrn.frame` 条目随会话树回退、台账 `origin` 带帧版本；**硬约束把关** `tool.constraint`（改动前逐条对照，确信违反才拦，用用户原话说明）；子代理继承父会话的约束。设计见 `features/task-frame.md`。未做：真实 Jev/writer 下的阈值校准 |
| 沿用已有配置 | 首次运行自动读 Claude / Cursor / Codex 的规则、技能、MCP 配置（用户级直接用；项目级里能执行命令的 MCP 先过 pi 的项目信任）。Cursor 的 `alwaysApply` 规则常驻，按 glob 的规则在碰到匹配文件时才给 | **已完成**（功能 `inherit`，设计见 `features/inherit-and-mcp.md`）：Claude Code / Cursor / Codex 的规则、技能、MCP 定义都读（含 Codex 的 TOML）；常驻规则有总量上限，超出的改为按描述提供。待你定：沿用的技能要不要设上限（这台机器上有 59 个 Claude Code 技能；判定不生效时它们的描述会全部进提示词，这与 Claude Code 自己的做法一致） |
| MCP 客户端 + 判定器披露 | 自写最小 stdio JSON-RPC 客户端（后补 HTTP），每个服务器是目录里一个 `judged` 能力，打开时才启动并注册工具；工具清单缓存到磁盘，这样服务器还没跑过，判定器也有描述可判 | **已完成**（功能 `mcp`）：stdio + Streamable HTTP，新旧两版协议都说（2026-07-28 修订版取消了 `initialize`）；每个服务器是目录里的 `judged` 能力，打开才启动；工具清单缓存在磁盘。安全上比原计划多一道：pi 的项目信任对“只有一个 `.mcp.json` 的克隆仓库”会直接返回可信，所以项目级服务器首次启动前 mu 另外确认一次，确认绑定定义的 SHA-256；没有界面可问时不启动。未做：OAuth、旧 HTTP+SSE。未对任何真实 MCP 服务器跑过 |
| LSP 诊断 | 接用户机器上已装的语言服务器，懒启动。改完文件后取诊断，与改之前的基线相减，只留“这次改动新引入的”。`diagnostics.delivery` 由判定器决定现在说、回合末说还是不说；规则兜底：带着新错误宣称完成时一定说 | **已完成**（功能 `lsp`，判定点 `diagnostics.delivery`，设计见 `features/lsp-diagnostics.md`）：自写最小 LSP 客户端，发现 typescript-language-server / pyright / gopls / rust-analyzer / clangd，懒启动；改之前先用旧文本打开文件取基线，只留这次改动新引入的；子代理默认不启动语言服务器。项目自带的服务器定义要过真正的信任确认。**对真实的 gopls 0.20 跑通了**（临时 Go 模块：改动前就有的错误不报，改动新引入的那一条报出来，约 1.5 秒；`MU_LSP_REAL=1` 的可选测试）。本机其它服务器跑不了：没装 typescript-language-server；`clangd` 被“未同意 Xcode 许可”挡住；`rust-analyzer` 只是 rustup 的空壳。待你定：内置服务器是否也要等项目信任（rust-analyzer 会执行 `build.rs`） |
| 后台命令 | `bg_start` / `bg_output` / `bg_stop`，输出环形缓冲加日志文件，结束时是否打断当前工作交给已有的 `notify.routing` | **已完成**（功能 `background`，设计见 `features/background-and-web.md`）：整棵进程树一起杀（POSIX 进程组，Windows `taskkill /T`），会话结束全部清理，`bg_output` 只给上次之后的新输出，可等一个正则出现；`bg_start` 与 `bash` 走同一套风险把关；日志在 `~/.mu/jobs`。Windows 未在真机验证 |
| 网页读取 + 国内能用的搜索 | `web_fetch`（限时限量，HTML 转可读文本，页面文字标为不可信）+ `web_search`（来源可换） | **已完成**（功能 `web`）。默认搜索源改成了 **360（`so`）**：实测必应中国对脚本请求返回的是不相关结果（约 25 次请求，换头、换协议、带 cookie 都一样），百度直接跳验证码，搜狗和 360 正常；结果与查询对不上时自动换下一个源并说明原因。`web_fetch` 拒绝内网 / 链路本地地址（检查做在连接自己用的 DNS 解析里），每一跳重定向重新检查，能解 GBK / Big5；URL 明写 localhost 时放行（调试本机服务要用），从外网跳到 localhost 一律拒绝。没在纯大陆直连网络上验证过 |
| worktree 隔离、能改文件的子代理 | `delegate` 增加 `isolation: "worktree"`：子代理在临时 worktree 和分支里改，结束后把 diff 交回，由父代理决定应用；冲突交给冲突解决包 | **已完成**（并入已有的 `swarm` 功能，设计见 `features/worktree-subagents.md`）：能改文件的角色默认进 worktree（建在仓库外的临时目录，分支 `mu/agent-*`，用完连分支一起删）；父代理没提交的改动（含未跟踪文件）会带过去；结果是一个二进制安全的补丁，父代理用 `apply_patch_from` 查看或应用，应用走临时 index，**要么全成要么不动**，你的 index 和 stash 从不触碰；判定点 `swarm.patch` 给补丁的范围把一句关。子代理照样受你的硬约束限制。不是 git 仓库、正在 rebase/merge 等状态时退回原地工作并说明原因。未验证：Windows、真实子进程与真实模型、子模块 / LFS。待你定：worktree 里没有 `node_modules`，子代理跑不了依赖它的测试，要不要加一个把被忽略目录链接进去的选项（代价是子代理能改到你的 `node_modules`） |
| checkpoint + 判断回退 | 每个用户回合用影子 git 目录给工作区拍快照（不碰用户仓库的 index）。回退 = 文件回到快照 + 会话树回到对应条目。`turn.rewind`：monitor 发现反复失败时由判定器判断是不是死路，再向用户提议 | **已完成**（功能 `checkpoint`，判定点 `turn.rewind`，设计见 `features/checkpoints.md`）：每个项目一个影子仓库（`~/.mu/agent/mu/checkpoints/<项目哈希>`，自己的 `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`），用户的 index、stash、钩子从不触碰，非 git 目录也能用；快照只拍在回合第一次会改文件的调用之前，记成 `kyrn.checkpoint` 条目跟着会话树走。`/checkpoints` 列出，`/rewind [#] [both\|files\|conversation]` 先展示会放回/删除/找回哪些文件、单独问手改过的文件，对话用 pi 自己的 `navigateTree` 移回请求之前并留一句 `kyrn.rewind` 教训，`/rewind undo` 撤销。同一命令失败 3 次或 monitor 第二次开口时问判定器（`dead_end` / `progress` 两个是非题），确信是死路才**提议**，用户同意才回退，没界面时只提醒模型。未验证：Windows、真实 Jev 的阈值、真实终端里的提议流程。待你定：要不要加模型自己请求回退的 `rewind` 工具（本包未做） |
| to-do | 直接用任务帧里的验收条件，模型用 `todo` 勾选和补充，完成检查读它 | **已完成**：`todo` 工具读写任务帧的验收条件，完成核对会点名未完成项 |

## 2. 能力包：装上，默认不露，判定器按任务披露

DAP 调试器 · ast-grep 结构化搜索和改写 · 带优先级的 `/review` · 把改动拆成多个提交的 `/commit` · GitHub（`gh` 加一个技能，不另做一堆工具）· 冲突解决。全部以 `pack:*` 登记到能力目录，外部二进制（`sg`、`gh`、调试适配器）缺失时给出安装提示而不是报错。

**状态**（设计见 `features/capability-packs.md`）：ast-grep、GitHub、`/commit`、`/review` 的 P0–P3 分级（判定点 `review.triage`）、冲突解决**已完成**。ast-grep 对本机真实的 ast-grep 0.44.0 跑通；`/commit` 与冲突解决都在真实临时仓库里测过，`/commit` 要么全部提交成功、要么逐字节恢复，冲突解决从不提交、从不 `--continue`。DAP 调试器（`pack:debugger`，`features/debugger.md`）**已完成**：debugpy / delve / lldb-dap 加用户自己的适配器，停在断点和未捕获异常处，对本机真实 debugpy 1.6.7 跑通；delve、lldb-dap 没在真机跑。能力包一节到此全部完成。

实验：**语义版 TTSR**。OMP 用正则发现模型写偏，就中断输出、插入规则、从原处重来；mu 把“发现写偏”换成判定器判断（流式输出按段送判，确信偏了才中断）。默认关，先在 shadow 里攒数据。**代码已完成**（功能 `ttsr`，判定点 `output.drift`，设计与限制见 `features/semantic-ttsr.md`）：规则用平常的话写，任务帧里的硬约束自动算进去；判断与输出流并行，只有确信违规才掐断，随后点名规则让模型从断点继续。未在真实模型和真实 Jev 上跑过。

pi 自带的示例扩展里已有 plan-mode、subagent、todo、git-checkpoint、git-merge-and-resolve、handoff，这些是现成的参照；上游没有目标模式。

**目标模式：已完成，第二版**（`/goal <条件>`，只输入 `/goal` 会问条件；设计见 `features/goal-mode.md`）。用户反馈“Jev 判断结束不准”，所以第二版改成**由大模型判断**（默认当前会话的模型，可另指定）：它读目标、这一轮的步骤、最近一次测试 / 检查的结果和结束语，给出达成 / 继续 / 需要你，外加理由和具体的下一步，续跑消息带上这两样；判断为原地打转时要它换思路，连续两次就停下来问用户。事实（没勾的验收条件、改完没跑）照样压过任何结论；判定器的 `goal.met` 退为兜底。模型需要用户、被打断、调用失败、连续空转、额度用完时自己停下，用户的下一条消息就是“接着干”。

**人话看板：harness 已完成**（用户 2026-09-22 追加，`/board on|off` 按项目开关，设计见 `features/plain-language-board.md`）。判定器用选择题读出阶段、在做哪条验收条件、是否在等用户、有没有新情况；只有出现新情况，才请会说人话的模型（`board.model`，比如 Gemini Flash）写“进展 / 正在做 / 需要你确认”。只给人看，不进模型的上下文；展示事件 `board.update`。桌面端右侧面板（和经验栏放在一起）待做。

**用 Google 账号登录：harness 已完成，实验**（用户 2026-09-22 同意，功能 `googleLogin`，设计见 `features/google-login.md`）。上游 4 月删掉的 Gemini CLI 和 Antigravity 的 OAuth 加回来了，登录前先说明封号风险、用户同意才继续；Gemini CLI 用 Google 自己的 Gemini 目录（含 3.8 Flash），Antigravity 登录后按账号实际能用的模型更新列表。官方方式（Gemini API key、Vertex 的 gcloud 登录）和 Grok 的登录（`xai`）都是 pi 自带的。没有用真实账号登录过；桌面端的登录界面待做（pi 的 RPC 没有登录命令，要在进程内调 `ModelRuntime.login`）。

## 3. 桌面端

| 包 | 做法 | 状态 |
| --- | --- | --- |
| 图标与主题 | 用户给的图标（玻璃质感，粉 → 薰衣草紫 → 长春花蓝的柔和渐变，白色发光 μ）定调。主题色淡粉 + 淡紫，亮暗两套令牌，圆角、柔和阴影、细渐变 | **已完成**，在桌面端分支 `claude/mu-ui`（现在是合并后的主干）：图标由脚本从原图重建（全套尺寸，32 px 以下用简化版）；粉紫是第二套配色 `data-color-scheme='mu'`，切回 `default` 即上游原样；亮暗两套 66 组文字对比度全部过线。未在真实应用窗口里看过 |
| 设置 | 我们支持的每项控制都能在设置里看到：判定器与层级、每个决策点的模式、各功能开关与参数、能力目录、沿用来源、MCP 服务器、语言服务器。模型提供商：选择提供商、思考等级、**端点类型（OpenAI 兼容 / Anthropic 兼容）**、自定义地址 | **已完成**，已并入 `claude/mu-ui`：判定器、判定点、功能（由 harness 的 `manifest.json` 生成）、模型与提供商（端点类型四选一、思考等级、测试连接；密钥只写进 harness 的 `.env`，`models.json` 里只留引用）、上下文、本地判定（只读）。未做：能力目录 / 沿用来源 / MCP / 语言服务器这几页（等 harness 对应的包落地）。未对真实提供商接口验证 |
| 界面打磨 | 中文优先的文案（不再是英文占位），侧边栏与对话区细致化，加入自己的元素（μ 标记、判定脉冲、任务帧条） | 第一轮已完成（`claude/mu-ui`）：13 种语言的 mu 文案、上游的旧名统一显示为 mu、μ 标记、判定脉冲、空会话的三个起点、侧边栏选中条、发送键与输入焦点环、代码块配色。待做：任务帧条、目标状态、浏览器步骤条与整体的第二轮细化；打包名（`productName` / `appId` / 协议）仍是上游的 |
| 内置浏览器 × UltraFast | 应用内已有预览浏览器（`Preview/browser`，Electron `<webview>`）。让 `browse` 的“观察 → 一次判断 → 动作”循环直接驱动这个可见的页面：主进程用 `webContents.debugger` 只对该页面开一条带令牌的本地 CDP 通道（不给整个应用开远程调试口），harness 的 CDP 客户端连它；没有桌面端时照旧启动自己的 Chrome。比原 Skill 多出来的：用户看得见每一步、每步判断进判定器面板、可随时接管或暂停、不可逆操作用应用内确认框、登录态留在应用自己的分区 | **两侧都已完成**：harness 一侧在本分支；桌面端的桥在分支 `claude/mu-browser`（97 个测试 + 真实 Electron 里 35 项端到端检查，用的是 harness 的原代码），已与主题、设置合并成一个主干 `claude/mu-ui`（`91c0dba`），合并后在真实 Electron 里对着本分支最新的 harness 代码重跑，35 项全过。协议第二版与留给用户拍板的四件事见 `features/embedded-browser.md` |
| 本地 Laya 一键挂载 | 设置里一个按钮完成安装（运行时 + 权重，带进度），装好后把判定层级切到 `laya` 并如实标注它的能力边界（分类可用，关联/打分不可信）。没有 Jev 的用户因此也能用 | 待做。用户 2026-09-22 批准做，条件是**一定要用户同意才下载**：模型（约 930 MB）只在用户在界面里明确点了下载之后才开始下，下载前说清大小和来源 |
| 原生宿主 | 宿主进程验证已通过（`scripts/kyrn/host-spike`）。浏览器融合、任务帧条、判断回退都依赖同一条有序事件流，按“先 reducer，后原生对话面”的顺序推进 | 待做 |

## 4. Windows 与 WSL

原来是 POSIX 专用：启动器和桌面端的 `scripts/kyrn/*` 是 bash，`mu migrate` 用 `pgrep`，本地判定服务是 Core ML（只有 macOS）。设计、审计表和真机首查清单见 `kyrn/docs/features/windows-and-wsl.md`。**以下“已完成”都指代码加按平台参数化的单元测试，macOS 上实跑通过；没有一项在真实的 Windows 或 WSL 机器上运行过。**

| 项 | 做法 | 状态 |
| --- | --- | --- |
| 1. 启动器 | Node 实现（`kyrn/bin/mu.mjs`，无依赖），每个决定是带 `platform` / `env` / 文件系统参数的纯函数；`kyrn/bin/mu`（bash）只负责选 Node >= 22.19，`mu.cmd` / `mu.ps1` 是 Windows 的转发器；应用视图在 Windows 上用 junction 加复制；`.env` 由 Node 解析，不再 source；`mu link` 在 Windows 上写 `mu.cmd` 垫片；`mu migrate` 在 Windows 上用 `tasklist` + PowerShell 代替 `pgrep`、留 junction | 已完成，未在真机验证。既有启动器测试原样通过 |
| 2. 新代码跨平台 | 进程用 `spawn` 加参数数组、不经 shell；tsx 走真正的 JS 入口而不是 `.cmd` 垫片；子代理在 Windows 上用 `taskkill /T` 整树结束（MCP 客户端、后台命令已各自处理） | 已完成，未在真机验证。合并时补上：风险把关、硬约束把关、完成核对、checkpoint、蜂群视图都认 pi 在 Windows 上的 `powershell` 工具（`src/extension/shell-tools.ts`），风险规则加了 PowerShell / cmd 的同类写法（`Remove-Item -Recurse -Force`、`rd /s /q`、`iex (iwr …)`、`-Verb RunAs`、`Format-Volume`），只读命令表加了 `Get-ChildItem` / `Get-Content` / `Select-String` 等 |
| 3. 浏览器发现 | Windows：Program Files、Program Files (x86)、LOCALAPPDATA 下的 Chrome / Chromium / Edge / Brave。Linux：包、PATH、snap、flatpak（受限环境的 profile 换位置）。WSL：**先用 WSL 里的浏览器**；Windows 侧浏览器只在 mirrored 网络模式下用（回环可达），NAT 模式下拒绝并给出安装与 `.wslconfig` 指引，因为调试端口没有鉴权、不能开给网络。（原计划“WSL 里优先用 Windows 侧浏览器”据此改了） | 已完成，未在真机验证 |
| 4. 本地判定服务 | 非 macOS 上 `mu judge …` 和 `mu doctor` 如实说明 Core ML 只有 macOS，指向 Jev、llm 判定器、桌面端在做的本地判定服务，并保留 `MU_LOCAL_JUDGE_URL` 接缝。Windows 上换运行时（ONNX / CPU）、接口不变 | 说明与接缝已完成；换运行时待做 |
| 5. 桌面端 | 适配器在 Windows 上应直接 `spawn(node, [mu.mjs, …])`，结束会话用 `taskkill /T` 或关闭 stdin；`scripts/kyrn/*` 仍是 bash | 待做（桌面仓库） |
| 6. 真机验证 | 按设计说明第 8 节的清单在 Windows 和 WSL（NAT、mirrored 各一次）上过一遍 | 待做：需要一台 Windows 机器 |

## 4.5 调度教训

2026-09-22 凌晨一次并行放出 14 个子代理，约四十分钟耗尽会话额度，全部在读资料阶段被中断、几乎没有提交。此后同时最多 3 个工作包，按优先级做完一个放下一个，每个包做完一步就提交。

## 5. 约定（所有工作包通用）

- 先读仓库根的 `AGENTS.md`。Tab 缩进，相对导入带 `.ts`，只用可擦除的 TS 语法，依赖写精确版本，能不加依赖就不加。
- Node 24：`/Users/baihe/.nvm/versions/node/v24.16.0/bin` 放在 PATH 最前。
- 验证只跑相关测试和 `npm run check`，不跑全量 `npm test` / `npm run build`。测试用 `MockJudgeProvider` 和 faux 模型，不调真实模型，不碰用户真实的 `~/.mu`。
- 每个决策点是一个 `DecisionSpec`：问题短、具体、单一谓词；标明能力类别；处理函数包 `failOpen`；默认模式跟随配置。
- 存进会话的自定义类型保持 `kyrn.` 前缀（压缩靠它过滤）；给人看的名字用 mu。
- 不读、不打印凭据（仓库根 `.env`、`~/.mu/agent/auth.json`、`models-store.json`）。不改 `~/.claude/settings.json`。
- 新功能默认开启（目标是开箱即用），但都要能在 `mu.json` 的 `features.<name>` 里关掉，并在桌面端设置里可见。
