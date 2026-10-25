<p align="center">
  <img src="../../desktop/resources/app.png" width="96" alt="mu">
</p>
<h1 align="center">mu</h1>
<p align="center">编码代理做的决定，大多不是代码，而是一道道是非题。mu 把其中 40 类交给一个小模型。基于 <a href="https://github.com/earendil-works/pi">pi</a>。</p>

<p align="center">
  <a href="https://github.com/qybaihe/mu/actions/workflows/ci.yml"><img src="https://github.com/qybaihe/mu/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/qybaihe/mu/actions/workflows/desktop.yml"><img src="https://github.com/qybaihe/mu/actions/workflows/desktop.yml/badge.svg" alt="Desktop app"></a>
  <a href="https://www.npmjs.com/package/mu-agent"><img src="https://img.shields.io/npm/v/mu-agent?label=mu-agent" alt="npm"></a>
  <a href="https://github.com/qybaihe/mu/releases"><img src="https://img.shields.io/github/v/release/qybaihe/mu?include_prereleases&label=desktop" alt="Desktop release"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <a href="https://github.com/qybaihe/mu/discussions"><img src="https://img.shields.io/github/discussions/qybaihe/mu?label=discussions" alt="Discussions"></a>
</p>

<p align="center">
  <a href="../../README.md">English</a> · <b>简体中文</b> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="run-dark.gif">
    <img src="run-light.gif" alt="桌面端里的一次运行，项目是任务队列 relay。消息：relay.config.json 里 timeout 设为 1h30m 的任务，跑一个小时左右就被杀掉，查原因、修好，并确认测试都能通过。判定器把消息判为多步任务（input.preflight）。模型跑测试，判定器放行（tool.approval）：13 个里挂了 1 个。模型读时长解析器，发现一分钟被定义成 1,000 毫秒，说要改成 60,000 再跑一遍测试，然后没做就停了。判定器判定这次运行半途而止（turn.continue），mu 提醒模型这一轮还没完，模型改好单位、再跑测试：13 个全部通过。右侧判定页逐条列出每次判定、判定点和耗时。">
  </picture>
</p>

这段输出要不要看？这条命令在这个任务里该不该放行？活真的干完了吗？编码代理每次会话要回答几百个这样的问题。交给大模型或死规则，代价落在你身上：

- **白白浪费 token。** 两千行的测试日志整段塞进上下文，之后每一次请求都再为它付一次钱。mu 的判定器把长输出分块读，只放进任务需要的部分，其余存档、留一个指针。过期的结果直接丢掉、不做摘要；你多半还会回来时，赶在提示缓存过期前续上。测试日志精简默认关闭，开启后折叠完全重复的内容，一个字节都不丢：在 71 份真实的失败测试日志里省下 19.5% 的字符，Jest 的日志省下 40%（见[实测](#实测)）。
- **命令被随手批准。** 代理每一步都来问，你就不看内容一路点允许，或者干脆关掉询问。默认的*判定模式*下，任务明显需要的由判定器放行，其余的才来问你。危险命令先过规则；网页和 MCP 返回的内容在模型读到之前，先筛掉写给 AI 的指令。
- **做到一半就停。** 「接下来我跑一遍测试」，然后这一轮就结束了。判定器会发现这种半途而止，或者没有任何验证的「做完了」，把代理送回去做完，就像上面录屏里那样。

这些问题每一个都去问大模型，花的是 token 和它的注意力；交给死规则，又错得太多。mu 把它们交给一个**判定器**：一个小而快的模型，每次只回答一个有边界的问题。代理循环里一共 40 个判定点，开箱就有 34 个直接生效。每次判定连同概率和耗时都记进本地流水（`mu ledger`、`/status` 或桌面端的判定页）；任何判定点都可以先跑影子模式，只问、只记、不改变任何行为，先比较判定器，再决定用哪个。

- **mu**：命令行。pi 的全部能力，加上判定内核。
- **mu 桌面端**：自带 mu 和运行时的桌面应用。下载，接一个模型，开始。
- **判定模型**：默认是 TypeSafe 托管的 Jev。是非题、选择题、打分题，每个答案带概率，每一次判定都进流水。任何判定模型都可以替代它：在你 Mac 上跑的 mu 自有模型 [mude 1.0](#mude-10针对编程场景优化的决策模型)、Hugging Face 上的其他决策模型、你自己的 System One 服务或任意 LLM。

**目录：**[快速开始](#快速开始) · [一轮是怎么走的](#一轮是怎么走的) · [判定点](#判定点) · [判定器](#判定器) · [实测](#实测) · [蜂群](#蜂群) · [人话看板](#人话看板) · [桌面端](#桌面端) · [命令行](#命令行) · [文档](#文档) · [参与贡献](#参与贡献)

## 快速开始

**桌面端。** 从 [Releases](https://github.com/qybaihe/mu/releases/latest) 下载 macOS、Windows 或 Linux 安装包，打开后粘贴一个 API key，或用 ChatGPT、Grok、Google 订阅登录。不用再装别的。

**命令行。**

```bash
npm i -g mu-agent   # Node.js 22.19 或更新
mu setup            # 接入一个模型
mu                  # 在当前目录开一个会话
```

开始用不需要判定器的 key：没设置之前，由 OpenCode Zen 上免费的 Jev 回答。40 个判定点里有 34 个一开始就生效，每次判定都会记录下来（`/status`、`mu ledger`、桌面端的判定页）。如果只想记录判定器会怎么做、不改变行为，在 `~/.mu/agent/mu.json` 里写 `{"modes": {"default": "shadow"}}`。更多见 [Getting started](../getting-started.md)（英文）。

## 一轮是怎么走的

```
 你 ──▶ input.preflight · task.frame · input.interjection
          │
          ▼
        模型 ──▶ 工具调用 ──▶ tool.risk · tool.constraint · tool.approval ──▶ 执行
          ▲                                                                  │
          │    tool.injection   网页和 MCP 输出：冲着 AI 来的指令被拦下
          │    tool.admission   逐块判：进上下文，还是归档、留一个指针
          │    context.forget · context.compact   上下文变长时                  │
          └──────────────────────────────────────────────────────────────────┘

 一轮结束 ──▶ turn.completion · turn.continue · turn.drift · turn.rewind · memory.applied · board.read · cache.warming
```

## 判定点

每个判定点可以是 `active`（生效，默认）、`shadow`（照常提问并记录，但不改变任何行为，用来在切换前比较判定器）或 `off`（关闭），并且可以指定自己的判定器：`jev`、`mude`（本地）、`classifier:<提供商>/<模型>`、`llm:<提供商>/<模型>`，或 `mude,jev` 这样的级联。

**输入**

| 判定点 | 问题 | 效果 |
| --- | --- | --- |
| `input.preflight` | 这条消息是什么类型，需要多深的思考？ | 给模型一行提示；可选地设定这一轮的思考级别 |
| `task.frame` | 新任务、硬约束、纠正、子目标，还是没有变化？ | 只有变化才重写任务帧：目标、你的约束原话及其出处、验收条件 |
| `input.interjection` | 代理正在干活时来了一条消息：现在打断，还是这一步之后？ | 这一轮被截断，或消息等一等 |

**上下文**

| 判定点 | 问题 | 效果 |
| --- | --- | --- |
| `skills.disclosure` | 哪些技能和这个任务有关？ | 只有它们进提示词；其余仍可查到 |
| `capability.disclosure` | 这个任务需要某个已安装的能力包或 MCP 服务器吗？ | 需要时才打开、才启动它的进程 |
| `tool.admission` | 一段长工具输出的每一块：现在重要吗？ | 重要的进上下文；其余归档，留一个指针 |
| `tool.admission.test-log` | 测试日志里哪些是重复？ | 完全相同的重复只留一份，无损；可选地由判定器从剩下的里挑 |
| `context.forget` | 上下文超过阈值后，哪些工具结果已经过期？ | 每一条在外发请求里变成一行墓碑 |
| `context.compact` | 这一段留还是删？ | 默认关闭。按判定压缩；不写摘要 |
| `memory.recall` | 哪些经验适用于这个任务？ | 带进这一轮 |
| `memory.capture` | 这条消息是在纠正代理，还是在立一条规矩？ | 变成一条经验 |
| `memory.outcome` | 绕了圈子之后，最后走通的那条路值得记吗？ | 从运行里学来的经验，不是你教的 |
| `memory.worth` | 模型或子代理提出的一条经验：以后还用得上、一次性的，还是早就知道？ | 留下或丢掉 |
| `memory.merge` | 和已有的经验是同一条、更精确，还是矛盾？ | 不重复记；更精确的替换旧的 |
| `memory.applied` | 这一轮召回的经验照做了吗？ | 常被召回却从不照做的经验自动退役 |
| `skill.capture` | 一次长运行成功收尾：它是不是一套做法，同样的步骤能做下一件同类的事？ | 起草成技能，等你决定：`/skills accept` 安装 |
| `cache.warming` | 提示缓存过期之前你会回来吗？ | 续一次缓存，或任它过期 |

**工具与安全**

| 判定点 | 问题 | 效果 |
| --- | --- | --- |
| `tool.risk` | 一条被规则标记的命令：是你要的吗？ | 拿不准就问你 |
| `tool.approval` | 在「判定模式」下：这条命令、这个项目外的改动、这个对外动作、这个子代理，任务明确需要吗？ | 判定器确定需要的直接过；其余问你 |
| `tool.constraint` | 在一个会改变东西的调用之前：它越过了你定下的约束吗？ | 调用被拦下 |
| `tool.injection` | 网页、搜索结果、MCP 服务器的输出，或命令从别的机器取回的内容（`curl`、`gh issue view`），一段一段看：里面有没有冲着 AI 来的指令？ | 这些段落不会到达模型，原处留一条说明。读到过这种段落的子代理，报告交回时前面带一句警告 |
| `tool.description` | MCP 工具自己的说明，第一次出现或变了时：是不是要 AI 做调用这个工具以外的事（读密钥、把数据发到别处、瞒着你）？ | 这个工具从模型的工具列表里拿掉，调用也被拒绝，并告诉你 |
| `files.locate` | 哪些文件符合你的描述？ | 给候选文件排序，代替一串 grep |
| `judge.items` | 模型自己提的一个是非题，对很多项逐项问：文件、日志行、审查发现 | 通过 `judge_items` 工具，每项得到一个概率，不用一项项读 |
| `browser.step` | 观察、判一次、动手：下一步操作是什么，作用在哪个元素上？ | 内置浏览器走一步 |
| `review.triage` | `/review` 的每条发现：会改变程序行为吗，是关于这次改动的吗？ | 按 P0 到 P3 分级 |
| `diagnostics.delivery` | 一次编辑后新的语言服务器诊断：现在说，下次停顿时说，还是不说？ | 错误送到模型；风格警告不送 |

**回合**

| 判定点 | 问题 | 效果 |
| --- | --- | --- |
| `turn.drift` | 每隔几步：工作还在为目标服务吗？ | 规则抓绕圈子，判定器抓跑偏 |
| `turn.rewind` | 同一个失败一次又一次：这条路是死路吗？ | 退回到某个检查点 |
| `turn.completion` | 模型说做完了：有什么东西验证过吗？ | 没有就提醒一次 |
| `turn.continue` | 一轮停在「接下来我跑一下测试」，或者在你已经要它做的事上问「要我动手吗」：是不是没做完就停了？ | 让它接着做，每条消息最多两次；难以撤销的一步不会推它去做 |
| `output.drift` | 模型正在写的时候：输出的末尾越过了你的约束吗？ | 默认关闭；边写边纠正 |
| `goal.met` | 目标模式下大模型给不出答案时：条件成立了吗？ | `/goal` 的兜底 |
| `board.read` | 事情做到哪了，选择题？ | 供人话看板使用 |
| `notify.routing` | 上下文预算之类的事件：现在告诉模型，晚点，还是不说？ | 模型在合适的时候被告知 |

**协作**

| 判定点 | 问题 | 效果 |
| --- | --- | --- |
| `swarm.routing` | 这个委派出去的任务，用哪个角色、哪一档模型、多深的思考？ | 合适的子代理 |
| `swarm.patch` | 子代理交回的补丁留在任务范围内吗？ | 从任务、路径和行数来判 |
| `hive.publish` | 一只 bee 的发现值得上共享板吗？ | 发布，或自己留着 |
| `hive.deliver` | 板上的一条笔记和这只 bee 的工作有关吗？ | 有关才投递 |
| `hive.relate` | 一条新发现推翻、矛盾还是支持了早先的某一条？ | 纠正和争议送到拿着旧笔记的 bee 那里 |

每个判定点对应的功能开关和选项：[docs/reference/decision-points.md](../reference/decision-points.md)（英文）。

## 判定器

- **Jev**：TypeSafe 托管的判定模型。有边界的问题，答案带概率。可以经 TypeSafe、OpenRouter、Vercel AI Gateway、OpenCode Zen、Cloudflare Workers AI，或任何支持同一协议的服务调用，每个服务有自己的密钥（`TYPESAFE_API_KEY`、`MU_JUDGE_OPENROUTER_API_KEY`、`AI_GATEWAY_API_KEY`、`OPENCODE_API_KEY`、`CLOUDFLARE_API_KEY` 加 `CLOUDFLARE_ACCOUNT_ID`）：在桌面端的「判定器」页选一个，默认用第一个设置了密钥的。一个密钥都没有时，默认由 OpenCode Zen 上限时免费的 Jev 1.13 回答：判定要读的内容会发给 OpenCode，它不拿来训练模型，mu 每天提示一次。配上密钥（`mu setup`，或「判定器」页）后，下一个问题起就用你的密钥。在作者自己的会话里实测：HTTP/2 上一个热连接的问题约 0.3 秒；16 块工具输出并成一个请求判完 0.44 秒，状态只计费一次。
- **mude 1.0**（本地，Apple 芯片的 Mac）：mu 自己的决策模型，针对编程场景优化，见[下文](#mude-10针对编程场景优化的决策模型)。
- **OpenAI 的决策模型** `gpt-6-luna`。通过 OpenAI 的 [Decisions API](https://developers.openai.com/api/docs/guides/decisions) 回答，用 OpenAI 的 API 密钥（`MU_JUDGE_OPENAI_KEY`，或 mu 已有的 OpenAI 密钥）。用 `mu setup --judge openai` 或在设置 → 判定器里选它。
- **Hugging Face 上的其他决策模型**（本地，Apple 芯片的 Mac）：`mu judge model add <链接>`（或桌面端设置的「判定器」页）添加一个和 mude 1.0 同样打包的模型，并让它当判定器。mu 不再内置 Laya：`mu.json` 里还写着它的，mude 1.0 装好了就由 mude 1.0 顶替，否则用剩下的判定器或 Jev，mu 会提示一次。
- **pi 模型目录里的任何分类模型**，作为一级：`classifier:<提供商>/<模型>`。比如 Cloudflare 的 Clef（`clef`、`clef-flash`）、OpenRouter 和 Vercel AI Gateway 上的 System One 模型、llama.cpp 的分类模型。
- **任何大模型**，作为一级：`llm:<提供商>/<模型>`。

这换来什么，以作者自己的会话为准：上下文很少填满，因为工具输出逐块进入、过期结果不写摘要直接放下；测试日志精简默认关闭，开启后折叠完全相同的重复，在 71 份真实的失败测试日志里省下 19.5% 的字符，一个字符也没丢（见[实测](#实测)）；提示缓存过期之前，内核会判断你会不会回来，会回来就提前续上。

### mude 1.0：针对编程场景优化的决策模型

mude 1.0 是 mu 自己的决策模型，针对编程场景特别优化：经过微调和训练，在编程场景的决策上达到 SOTA 级。它有 2B 参数，一次前向就答完一个判定的所有问题，每个答案带概率；它在你的机器上跑，判定的内容不离开本机。[完整版](https://huggingface.co/qybaihe/mude-1.0)和 [MLX 8-bit 版](https://huggingface.co/qybaihe/mude-1.0-mlx-8bit)（1.8 GB）都采用 MIT 许可证。目前一键安装支持 Apple 芯片的 Mac（macOS 14 及以上，内存 8 GB 及以上），用的是 MLX 版：

```bash
mu judge mude install               # 下载、逐个校验文件、在 127.0.0.1 上启动，并设为判定器
mu judge mude status                # 装了什么、在不在跑、有没有启用
mu judge mude enable --local-only   # 只用 mude：什么都不发给托管的判定器
mu judge mude disable               # 换回原来的判定器，并停掉它的服务
mu judge mude uninstall             # 删除模型和它的 Python 环境
```

在能跑 mude 1.0 的 Mac 上，它是推荐的判定器：`mu setup` 把它列在第一位；桌面 App 首次启动的引导里，「判定器」这一步一开始就选中它，点一下就能安装。之后在设置的「判定器」页可以安装、启动、停止和卸载 mude，「仅本地」开关等同于 `--local-only`。安装中途停下（Ctrl-C、断网、断电、退出 App）后，会从中断的地方接着装：再运行一次 `mu judge mude install`，或者点「继续安装」。

默认情况下，原来的判定器排在 mude 后面：mude 答不了的（服务没在跑，或者它拿不准），以及它暂时还不被信任的两项注入检查，交给那个判定器。如果那个判定器是托管的（默认的 Jev 就是），它看到的内容会离开本机。mude 的服务运行时占用约 4 GB 内存，`mu judge mude stop` 可以停掉。其他平台上，可以用[完整版](https://huggingface.co/qybaihe/mude-1.0)（bf16、PyTorch，建议有 CUDA 显卡）自带的 System One 服务跑起来，再按模型卡的写法在 `mu.json` 里把它加成 `typesafe` 判定器。

### mubench 1.0：决策模型怎么比

mubench 是 mu 给决策模型做的评测。主榜的每一道题，都是 mu 在开源仓库上的真实编程会话里发给决策模型的请求，一字未改。每个答案按它带来的后果的代价计分，每个模型都和不用决策模型的 mu 相比：0 分是一样，100 分是把这部分代价全部消除。完整榜单（含构造场景的副榜）在 [usemu.dev/mubench](https://usemu.dev/mubench/)。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../images/mubench/composite-zh-dark.svg">
    <img src="../images/mubench/composite-zh-light.svg" width="880" alt="mubench 1.0 主榜：开源仓库上真实编程会话里 3,193 道请求上的综合分，含 95% 区间。mude 1.0 64.9 (59.1–72.3)；Jev 1.14 63.1 (55.6–70.5)；Jev 1.13 61.5 (53.8–69.1)；d3-nano 原版 32.0 (21.3–39.0)；不用决策模型：0。">
  </picture>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../images/mubench/capabilities-zh-dark.svg">
    <img src="../images/mubench/capabilities-zh-light.svg" width="880" alt="mubench 1.0 主榜：每项能力的分数，依次是 mude 1.0、Jev 1.14、Jev 1.13、d3-nano 原版。权限放行：52.6、53.7、52.7、5.9；恶意指令识别：目前还不出分；上下文压缩：64.6、76.7、70.7、−19.1；按需加载与提醒：−2.7、16.8、25.1、−118.4；归类与路由：83.6、87.5、85.8、51.7；进度与完成判断：86.6、61.6、61.6、70.1；记忆与经验：58.7、75.1、72.2、40.5；多智能体协作：19.8、4.6、−0.8、26.0。">
  </picture>
</p>

决策正确率是另一个更直白的指标：模型答对的检查项占比，每个检查项分量相同，不管答错的代价多大。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../images/mubench/accuracy-zh-dark.svg">
    <img src="../images/mubench/accuracy-zh-light.svg" width="880" alt="mubench 1.0 决策正确率，含 95% 区间。主榜，开源仓库上真实编程会话里的 3,193 道请求：不用决策模型 78.0% (75.9–80.2)；mude 1.0 91.5% (89.6–93.3)；Jev 1.14 90.1% (88.9–91.3)；Jev 1.13 89.4% (87.7–91.1)；d3-nano 原版 83.5% (82.1–84.9)。副榜，1,655 个构造场景：不用决策模型 44.5% (42.8–46.2)；mude 1.0 92.1% (91.1–93.1)；Jev 1.14 91.8% (90.8–92.8)；Jev 1.13 91.1% (90.0–92.0)；d3-nano 原版 80.1% (78.6–81.7)。">
  </picture>
</p>

## 实测

把小决定交给判定器，代理是能多做完活，还是只是更省？目前有两项测量：一项看端到端的完整任务，一项看一次失败的测试运行有哪些内容进了模型。两项都写明了它们不能说明什么。

### 完整任务：Terminal-Bench 2.1

同一个模型、同一批任务、同样的时限，每题跑三次。在 Terminal-Bench 2.1 上，mu 的尝试有 68.2% 通过；mu 所基于的 pi 是 58.7%。两种失败 mu 都更少：到了时限还没做完的尝试更少，做完了但结果不对的也更少。

| 88 题 × 3 次，MiMo v2.6 Pro | mu · Jev | mu · mude 预发布版 | pi |
| --- | --- | --- | --- |
| 通过的尝试 | **264 次中 180 次（68.2%）** | 264 次中 174 次（65.9%） | 264 次中 155 次（58.7%） |
| 与 pi 的差值，95% 区间 | +9.5 个百分点（+3.8 到 +15.2） | +7.2 个百分点（+1.5 到 +13.3） | |
| mu 通过得比 pi 多 / 少的题 | 25 / 8 | 25 / 10 | |
| 失败的尝试：到时限没做完 / 做完但不对 | 65 / 19 | 71 / 19 | 81 / 28 |
| 每通过一次的 agent 时间 | 23.6 分钟 | 22.2 分钟 | 27.4 分钟 |
| 每通过一次的成本 | $0.067 | $0.063 | $0.069 |

这次测试是什么、不是什么：

- Terminal-Bench 2.1，经 Harbor 0.24.0 运行，每题用它自己的时限。agent 到了时限，Harbor 仍会对它留下的结果跑测试，所以一次尝试可能超时却通过。pytorch-model-recovery 不计入总数，因为最初几轮里测试框架没有把它的题面传给 pi 和 mu。有记录的三次里每个配置都通过了它，所以去掉它不影响对比。
- 全部用 MiMo v2.6 Pro，推理档位 high。对照组是 pi 1.4.0。mu 是 mu-agent 0.1.12（基于 pi 1.3.0），默认设置；Jev 是 1.14 版。mude 一列是 24 层的预发布版，和测试跑在同一台 Mac 上。mude 1.0 是由它做出的 20 层模型，还没有在 Terminal-Bench 上跑过；mu 0.2.x 也没有。
- 每题三次，2026-10-22 到 2026-10-24，在一台 16 GB 的 Apple 芯片 Mac 上。只有基础设施故障才重跑，规则事先定好。Rosetta 让每个配置都有四道题做不成，所以绝对通过率比 x86_64 上低约 4.5 个百分点，不能和公开榜单比较。

每次尝试的结果见 [docs/benchmarks/terminal-bench-2.1.csv](../benchmarks/terminal-bench-2.1.csv)，方法见 [docs/benchmarks/terminal-bench-2.1.md](../benchmarks/terminal-bench-2.1.md)（英文）。运行 mu 和 pi 的 Harbor 适配器，以及用 CSV 重算这张表的脚本，在 [bench/harbor/](../../bench/harbor/)。

### 什么进了模型：失败的测试日志

下面的数字来自仓库自带的脚本。折叠完全重复用 [`test-log-repeats.ts`](../../kyrn/spikes/judge-bench/test-log-repeats.ts) 测于 2026-10-25；按目标挑选用 [`test-log-replay.ts`](../../kyrn/spikes/judge-bench/test-log-replay.ts) 测于 2026-09-21，它的离线对照在今天的代码上结果相同。方法和完整表格见 [kyrn/docs/09-test-log-admission.md](../../kyrn/docs/09-test-log-admission.md)。

**完全重复。** 一次失败的运行，常常为每个失败的测试各打印一遍同样的 diff、DOM dump 或堆栈。mu 保留第一份，之后的每一份换成一行，写明它重复的是哪几行。不调用任何模型。标记展开后逐字节等于原文；完整日志留在磁盘上，输出末尾有一行指向它。能省多少取决于运行器：Jest 和 pytest 会把每个失败的 diff 和堆栈完整打一遍，Vitest 的默认 reporter 重复得少。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="bench-test-log-repeats-dark.svg">
    <img src="bench-test-log-repeats-light.svg" width="880" alt="71 份真实的失败测试日志，共 2,453,384 字符，折叠完全重复后少了 19.5%。4 个开源项目的 Jest 日志：40%；2 个项目的 pytest：27%；6 个项目的 Vitest：9%；mu 自己 CI 里的 Vitest：6%；作者 9 月 21 日会话里的 Vitest：51%。">
  </picture>
</p>

<p align="center"><img src="test-log-folding.gif" width="960" alt="一次 338 行的 Vitest 失败运行滚动而过，重复的 diff 段被标出。然后是模型读到的同一次运行：135 行，每段折叠的重复只剩一行标记。7,686 字符变成 4,262 字符，没有调用模型。"></p>

**按目标挑选。** 用详细 reporter 时，该留什么取决于你问的是什么：调试失败时，通过的测试是噪音；问哪些测试跑过时，它们就是证据。判定器在一个请求里，对每一块通过记录、每一块测试输出各问一次：目标还需要它吗？汇总和每一个失败从不参与提问。只有判定器给"不需要"的概率达到 0.9 或以上，这一块才会省掉。这些测量里的判定器是 Jev 1.13，当时的默认版本；之后没有用 Jev 1.14 重跑。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="bench-test-log-judge-dark.svg">
    <img src="bench-test-log-judge-light.svg" width="880" alt="调整用的 29 个目标上，Jev 省 40.2%，72 条必要证据一条没丢；完美判定器省 52.5%；只留失败省 61.9%，丢了 9 条。留出的 9 个目标上，Jev 省 46.4%，19 条一条没丢；完美判定器省 46.5%；只留失败省 59.4%，丢了 6 条。">
  </picture>
</p>

*完美判定器*（Perfect judge）直接读标注，代表一个全对的判定器最多能省多少。*只留失败*（Keep failures only）是一个永远回答"省掉"的判定器，也就是不看目标的过滤器会做的事。这次研究的全部 282 次真实 Jev 请求，按标价约 $0.017；用默认问法，单次请求的中位耗时 345 毫秒。

两者默认都关闭。在 `~/.mu/agent/mu.json` 里写 `"features": { "admission": { "testLog": "rules" } }`，或在桌面端设置里打开「测试日志精简」，就会折叠重复。`"jev"` 再让判定器挑出剩下的部分里当前目标用得上的；执行 `/mu mode tool.admission.test-log shadow` 则只记录挑选结果。

这些数字不代表什么：

- 挑选用的样本是合成项目上真实的 Vitest、node:test、pytest 输出，加 13 个手写的边界用例；目标和标注都是作者写的。留出集先标注、只跑一次，之后没有改任何东西。
- 它们度量的是什么进了模型、丢了什么，不是模型之后能不能把任务做完。
- 折叠的样本大多是 CI 日志：12 个开源项目（按测试运行器选定，选在测量之前）各取最近 6 次失败的运行，加上 mu 自己 CI 自 2026-09-22 以来失败的测试运行；每次运行取一份失败日志，并按 mu 的 bash 工具交给模型的样子截取（最后 2,000 行或 50 KB）。作者会话里的 7 份是之前的样本。作者最近的会话里，代理大多把测试输出接到 `tail` 后面，很少有日志达到 admission 起算的 4,000 字符。
- Go 和 Cargo 的输出不会被识别为测试日志，所以不折叠。

<details>
<summary>图中的数据</summary>

| 按目标挑选 | 调整用目标（29）：省下 | 丢失的必要证据 | 留出目标（9）：省下 | 丢失的必要证据 |
| --- | --- | --- | --- | --- |
| mu · Jev | 40.2% | 72 条中 0 条 | 46.4% | 19 条中 0 条 |
| 完美判定器 | 52.5% | 72 条中 0 条 | 46.5% | 19 条中 0 条 |
| 只留失败 | 61.9% | 72 条中 9 条 | 59.4% | 19 条中 6 条 |

| 失败的测试日志，每次运行一份 | 份数 | 字符 | 折叠 |
| --- | --- | --- | --- |
| Jest，4 个开源项目 | 14 | 584,229 | 40.1% |
| pytest，2 个开源项目 | 5 | 255,721 | 26.7% |
| Vitest，6 个开源项目 | 18 | 530,853 | 9.2% |
| Vitest，mu 自己的 CI | 27 | 942,761 | 6.0% |
| Vitest，作者的会话（2026-09-21） | 7 | 139,820 | 51.0% |
| 合计 | 71 | 2,453,384 | 19.5% |

</details>

## 蜂群

一个蜂群是 2 到 6 只 bee，各有自己的关注点。bee 读代码、跑命令、开浏览器；从不改代码，改动由主模型来做。每只 bee 每说完一段，`hive.publish` 问一次：这里有没有值得共享的发现、死路、决定或阻塞？值得的上一块只增不删的共享板。板上每来一条新笔记，`hive.deliver` 对每一只别的 bee 各问一次：这和它的关注点有关吗？有关就投递过去，标明「这是发现，不是指令」。

因为板只增不删，后来的结论会推翻早先的：一只 bee 报告测试跑不起来，后来清掉一个环境变量就跑通了。`hive.relate` 读两条笔记之间的关系：*推翻*、*矛盾*或*支持*。被推翻的结论变成一条纠正，送给每一只拿着旧结论的 bee。互相矛盾的两条都留着，标成争议；一分钟内没人解决，就派一只核实 bee 去查。

<p align="center"><img src="swarm.zh-CN.png" width="960" alt="桌面端的蜂群页，/hive 提问之后：config、repro、tests 三只 bee 都已完成；它们之间送达发现的连接图；对话里是回答，指出出问题的那一行、数字和失败的测试"></p>

桌面端的「蜂群」页就是这一切的现场。每只 bee 一行：角色、模型、此刻在做什么或刚说了什么。连接图画出谁把发现送给了谁：线越粗送达越多，纠正和争议各有自己的画法，一条发现送到的那一刻会沿着线亮一下。信息流里是每一条送达的原文，判定记录里是每一次裁决。对话里的蜂群卡片带一张缩略图，点开就是这一页。

`/swarm` 看每一只在做什么；`/swarm stop` 让它们现在交报告；`/swarm kill` 立刻结束。到时间的 bee 会被要求交报告，不交的会被结束；卡住的模型或工具由看门狗处理。蜂群永远会返回。

## 人话看板

打开看板（`/board`，或桌面端看板页上的开关）后，代理每做完一步，看板上立刻多一行人话：改了哪个文件、检查过没过、运行了什么命令，连着读文件就折成一行「看了 N 个文件」。代理干活中途每说一段话，`board.read` 都请判定器判一次这是不是新消息；是，就由一个只因为说人话而选出来的模型（`/board model` 可换）当场重讲给人听，并同时更新看板的现状：现在在做什么，清单上几件事做完了几件，有什么在等你。一次运行结束时的总结是流水的最后一行，过程留在上面，所以你看到的不只是「做完了」，还有它到底做了什么。

<p align="center"><img src="board.zh-CN.png" width="960" alt="桌面端的人话看板，蜂群回答之后：在等你决定要不要修，唯一需要你确认的问题，以及之前发生了什么；顶上是上下文占用和缓存命中率"></p>

看板跟着权限模式、目标和子代理走，代理换了做法，看板也换一种说法。顶上两个数是上下文占用和缓存命中率。

## 桌面端

桌面应用，自带 mu 和运行时：不用装 Node，第一次启动不下载任何东西。命令行有的它都有，另加一块对话旁边的工作面板：

**看板** · **判定**（实时的流水：每一次判定和它的问题） · **蜂群** · **经验** · **文件** · **预览** · **源码** · **浏览器**（代理逐步操作的内置浏览器，带目标、暂停和停止）

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="app-dark.zh-CN.png">
    <img src="app-light.zh-CN.png" width="880" alt="mu 桌面端在任务队列项目 relay 里修好一个 bug 之后：timeout 为 1h30m 的任务一小时就被杀掉，因为一分钟被定义成了 1,000 毫秒。判定器把消息判为多步任务（input.preflight），两次跑测试都放行（tool.approval），并判定这一轮已经做完（turn.continue）。右侧判定页列出每次判定的判定点和耗时，约 70 到 120 毫秒。侧栏里是三个项目里之前的对话，底部的栏显示判定器（Jev，经 TypeSafe）、40 个判定点里启用了 38 个、5 次判定和上下文占用。">
  </picture>
</p>

底部的一条栏让内核一直在视线里：哪个判定器在回答、跑在哪里，启用了多少个判定点；在对话里，还有到目前为止的判定数、最近一次判定的耗时和上下文占用。权限模式和目标在发送框里；`⌘K` 打开命令面板。模型登录在应用内完成：ChatGPT、Grok 和 Google（Gemini CLI / Antigravity）订阅，或任何 pi 支持的提供商的 API 密钥。Claude Code、Codex CLI 和 ZCode 的对话可以导入并接着聊。

macOS（Apple 芯片 / Intel）、Windows（x64 / Arm）、Linux（x64 / Arm）的安装包由 GitHub Actions 构建，发布在 [Releases](https://github.com/qybaihe/mu/releases)。

## 命令行

```bash
npm i -g mu-agent
mu            # 在当前目录开一个交互会话
mu doctor     # 检查安装、判定器和各项连接
```

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="cli-dark.png">
    <img src="cli-light.png" width="720" alt="终端里 mu 的欢迎界面：μ 标记，“mu v0.1.10, judgment-first coding agent, built on pi 1.3.0”，然后是判定器（Jev，137 毫秒回答，判定点已启用）、模型和工作目录，以及值得记住的几个按键。">
  </picture>
</p>

需要 Node 22.19 或更新。`mu -p "提示"` 跑一次并打印；`mu -c` 接着上一个会话。`mu import --list` 找出你的 Claude Code、Codex 和 ZCode 对话，`mu import <文件>` 连同完整历史一起导入；之后再导入一次，会把新增的内容带过来。`mu ledger [n]` 打印最近 n 个会话里判定器的决定。命令行和桌面端共用账号、设置和经验。

| 命令 | 做什么 |
| --- | --- |
| `/status` | 判定器、各判定点的模式、没放进上下文的内容、最近的判定 |
| `/mu judge <判定器>` | 由哪些判定器回答、按什么顺序：`jev`、`mude,jev`、`jev-opencode-free`、`openai`、`classifier:<提供商>/<模型>`、`llm:<提供商>/<模型>` |
| `/mu route <判定点> <判定器>` | 让某一个判定点用自己的判定器 |
| `/mu mode <判定点> <off\|shadow\|active>` | 切换某一个判定点 |
| `/frame` | 任务帧：目标、你的约束及其出处、验收条件 |
| `/goal <条件>` | 一直干到条件成立；`/goal clear` 结束 |
| `/permissions` | 全部放行 / 判定模式 / 最小权限 |
| `/board` | 打开或关闭人话看板 |
| `/remember`、`/lessons`、`/forget` | 记一条经验、列出经验、让一条退役 |
| `/skills` | mu 从运行里起草的技能：查看、安装或丢掉 |
| `/review`、`/commit` | 评审改动，发现按 P0 到 P3 分级；写提交 |
| `/checkpoints`、`/rewind` | 列出检查点；退回到某一个 |
| `/agents`、`/swarm` | 派子代理；看正在干活的每一只 |
| `/browse`、`/jobs` | 内置浏览器；后台命令 |
| `/capabilities`、`/ledger` | 装了哪些能力、打开了哪些；最近的判定 |
| `/import-chat` | 导入 Claude Code、Codex 或 ZCode 的对话 |
| `/doctor` | 检查配置和连接 |

pi 自己的命令（`/model`、`/thinking`、`/login`、`/resume`、`/tree`、`/fork`、`/compact`、`/export` 等）原样保留，只有一处不同：`/login` 不提供 Claude 订阅登录（Anthropic 不允许其他应用提供），请改用 Anthropic API key。`MU_JUDGE=mude,jev mu` 只为这一次运行改判定器。

## 隐私

密钥只在本机。mu 不会自己下载任何模型或运行时；需要下载的东西都会先问你。判定器只看到一个问题所需的字段（没配密钥时，这些字段发给 OpenCode Zen 上免费的 Jev；用带 `--local-only` 的 mude 1.0、`mu setup --judge off`（不问判定器，mu 的功能照常按规则工作）或 `MU_JUDGE=off` 就全部留在本机）；每一次判定都记录在本机，你都能翻到。

## 文档

- [Getting started](../getting-started.md) · [配置](../configuration.md) · [判定器](../judges.md) · [排错](../troubleshooting.md)（英文）
- 参考：[全部判定点](../reference/decision-points.md) · [全部功能和选项](../reference/features.md) · [更新日志](../../CHANGELOG.md)
- 给贡献者：[mu 是怎么工作的](../architecture.md) · [新增一个判定点](../adding-a-decision-point.md) · [翻译](../translations.md)

## 参与贡献

欢迎报 bug、修 bug、提新判定点、测判定器、做翻译，中文英文都可以。先看 [CONTRIBUTING.md](../../CONTRIBUTING.md)；标了 [`good first issue`](https://github.com/qybaihe/mu/labels/good%20first%20issue) 的 issue 适合上手。

```bash
npm install --ignore-scripts   # 安装依赖，不跑生命周期脚本
npm run hydrate:model-catalog  # 按仓库里固定的目录生成模型列表（不联网）
node kyrn/bin/mu.mjs           # 从这份代码启动 mu
npm run check                  # 格式、静态检查、类型
./test.sh                      # 测试（没有密钥时跳过依赖模型的测试）
```

桌面端在 `desktop/`：`bun install`，然后 `KYRN_ROOT="$(cd .. && pwd)" bun run start` 起开发版，它从仓库里的 mu 启动（先在根目录 `npm install`）。

所有参与者遵守[行为准则](../../CODE_OF_CONDUCT.md)。安全问题请按 [SECURITY.md](../../SECURITY.md) 私下报告。

## 引用

如果你在工作中用到 mude，请引用：

```bibtex
@misc{mude2026,
  title        = {mude 1.0: a decision model optimized for coding},
  author       = {qybaihe},
  year         = {2026},
  howpublished = {Hugging Face},
  url          = {https://huggingface.co/qybaihe/mude-1.0},
  note         = {MIT License. MLX 8-bit edition for Apple silicon: https://huggingface.co/qybaihe/mude-1.0-mlx-8bit}
}
```

## 来源与协议

mu 采用 MIT 许可证（[LICENSE](../../LICENSE)；桌面端见 [desktop/LICENSE](../../desktop/LICENSE)）。它基于 [pi](https://github.com/earendil-works/pi)（编码代理，MIT）构建，感谢 pi 的作者。有几个判定点借鉴了别的项目：提示注入筛查的问法来自 [hermes-jev-skills](https://github.com/kerpopule/hermes-jev-skills)，续跑检查和批量判定工具参考了 [oh-my-pi](https://github.com/can1357/oh-my-pi)。判定内核用到的第三方代码列在 [THIRD_PARTY_NOTICES.md](../../packages/kyrn-judge/THIRD_PARTY_NOTICES.md)。

mude 1.0 由 [d3-nano](https://huggingface.co/vllm-sr/d3-nano)（Decision 3.0，vLLM Semantic Router Team）微调而来，后者基于 Qwen3.5-2B；两者都是 Apache-2.0 许可证，模型仓库里保留了它们的声明。

桌面端最初 fork 自 [AionUi](https://github.com/iOfficeAI/AionUi)，从 AionUi 带来的文件列在 [desktop/APACHE-FILES.txt](../../desktop/APACHE-FILES.txt)，仍按 Apache License 2.0 授权（见 [desktop/NOTICE](../../desktop/NOTICE)）。

## 社区支持

- 提问和想法：[Discussions](https://github.com/qybaihe/mu/discussions)；中文讨论也可以去 [linux.do](https://linux.do)。
- bug 和需求：[Issues](https://github.com/qybaihe/mu/issues/new/choose)。
- 更多：[SUPPORT.md](../../SUPPORT.md)。
