# 能力包：装上，默认不露，判定器按任务披露

更新日期：2026-09-22。状态：ast-grep、GitHub、`/commit`、`/review` 分级、冲突解决、DAP 调试器全部完成并测试；调试器另见 `features/debugger.md`。

## 1. 原则

每个能力包是能力目录里的一项 `pack:<名字>`，`exposure: "judged"`：

- 装在 mu 里，但工具**不注册**，模型看不到，也不占上下文。
- 判定器读用户这条消息，确信任务需要时（`capability.disclosure`）才打开；模型也能用 `find_capability` 自己要，用户能用 `/capabilities` 手动开。
- 打开的那一刻才去找外部程序（`ast-grep`、`git`、`gh`）。找不到就给出这个平台的安装提示，包保持关闭；启动时从不报错。Mac 上的 git 先查一遍是不是没装开发者工具的系统桩、有没有被 Xcode 许可拦住（见 checkpoints.md），是的话一次也不运行。
- 用户的命令（`/commit`、`/review`）一直都在，自己打开需要的包。
- 判定关闭、或目录功能关闭时，什么都不藏：所有能用的包在会话开始时就打开。

代码：`src/extension/features/packs.ts`（登记与打开），`src/extension/features/packs/*.ts`（各包），`src/packs/*.ts`（与 pi 无关的纯逻辑：进程、git、diff、冲突）。设置：`features.packs.*`，桌面端设置页由清单自动生成。

## 2. 各包

| 包 | 给模型的 | 给用户的 | 要点 |
| --- | --- | --- | --- |
| `pack:ast-grep` | `sg_search`、`sg_rewrite` | — | 按语法找代码、改代码。改写默认是预演，只返回 diff；`apply: true` 才写文件，写入走 pi 的文件修改队列。改写超过 2000 处直接拒绝（多半是模式写错了）。`sg_rewrite` 在硬约束把关的检查范围内 |
| `pack:github` | 没有工具 | — | `gh` 在 shell 里已经什么都能做，缺的是用法：包里带一个技能 `mu-github`（PR、issue、CI 日志、评审、发布；不在参数里放 token；用户没说就不 push、不 merge）。打开时只检查 `gh` 在不在 |
| `/commit` | — | `/commit [要注意的]` | 见第 3 节 |
| `pack:review` | `review_triage` | `/review [评审什么]` | 见第 4 节 |
| `pack:conflicts` | `conflicts_list`、`conflicts_show`、`conflicts_resolve` | — | 见第 5 节 |
| `pack:debugger` | `debug_start`、`debug_step`、`debug_inspect`、`debug_stop` | — | 在调试器里运行程序：断点、未捕获异常处停下、单步、调用栈与变量。debugpy / delve / lldb-dap，也可自己加。见 `features/debugger.md` |

## 3. `/commit`：把改动拆成多个提交

1. 读取相对 HEAD 的全部改动（已暂存和未暂存一起；**从不包含未跟踪文件**，只列出来提醒）。按 hunk 切成单元；没有文本 diff 的文件（二进制、纯改名、改权限）整个算一个单元。
2. 写作模型（`writer`，没配就用当前模型）按目的分组、按仓库最近提交的风格写说明（仓库用 Conventional Commits 就跟着用）。用户在 `/commit` 后面写的话一并交给它。
3. 严格校验：每个单元恰好出现在一个提交里、编号都存在、每个提交都有说明。不合格就把问题原样退回模型**一次**；还不行就退回规则：每个文件一个提交。
4. 把计划给用户看，**用户确认后**才动手。没有界面可问时只显示计划，不提交。
5. 只通过 index 提交，**从不碰工作区**：先把 index 设成 HEAD，每个提交用 `git apply --cached` 放入它的补丁，再 `git commit`。用户自己的 hook 照常运行。任何一步失败（补丁放不进、hook 拒绝），HEAD 和 index 文件**逐字节恢复**原样，已经做出的提交只留在 reflog 里。
6. 从不推送。

细节：同一个文件的几个 hunk 可以分到不同提交、任意顺序。部分补丁的行号是**重新算出来的**，而不是交给 `git apply` 的偏移搜索：在有重复行的文件里，偏了几行的 hunk 也能匹配上下文，会被悄悄放到错误的位置（测试里用 40 行完全相同的文件验证了这一点）。

## 4. `/review` 与 P0–P3 分级

`/review` 打开 `pack:review`，把评审交给 `reviewer` 子代理（与原来一样），要求每条发现标 must / should / nit。报告回来后，模型把**每一条**发现原话交给 `review_triage`。

判定点 `review.triage` 对每条发现问两个是非题：

- `is_bug_i`：这条发现是不是会改变程序行为的缺陷？
- `in_scope_i`：它是不是这次改动引起的？

再结合评审自己标的轻重：

| 缺陷？ | 这次改动？ | 评审说 | 级别 |
| --- | --- | --- | --- |
| 是 | 是 | must | P0：合入前必须改 |
| 是 | 是 / 拿不准 | 其它 | P1：这次改动里的缺陷 |
| 是 | 否 | 任意 | P2：值得知道，但不在这次改动里 |
| 拿不准 | 任意 | must | P1 |
| 拿不准 | 任意 | 其它 | P2 |
| 否 | 任意 | must | P2 |
| 否 | 任意 | 其它 | P3：风格与小问题（折叠显示） |

一条都不丢；评审坚持必须改的永远不会落到 P3。判定器不可用或只在影子模式时，按评审自己的轻重排，并且整体降一级（must → P1），因为没人确认过。模型被要求在复述 P0、P1 之前自己对照代码核实。

## 5. 冲突解决

合并、变基、拣选、还原停在冲突上时：

- `conflicts_list`：什么操作停了、对方是哪个提交，每个文件怎么冲突的（双方都改、一方删除……）、有几块冲突。
- `conflicts_show`：一个文件的每一块冲突，列出 ours、theirs 和**两边共同的基线**。基线是把 index 里的三个版本用 `git merge-file --diff3` 重新合一遍得到的，所以不管用户设的是哪种冲突样式都有，也不碰工作区。
- `conflicts_resolve`：按块写入解决结果（其它块原样保留），或整个文件取 ours / theirs / 删除。一个块都不剩时 `git add` 标记为已解决。
- **从不提交，也从不执行 `--continue`**；每个结果都提醒模型：这一步交给用户。
- `conflicts_resolve` 在硬约束把关的检查范围内；checkpoint 也会在它之前拍快照。

## 6. 验证情况

| 包 | 测试 | 真实环境 |
| --- | --- | --- |
| ast-grep | `test/packs-ast-grep.test.ts`：替身程序 + 目录里的开合 | **本机真实 ast-grep 0.44.0 跑通**（装了才跑的用例） |
| GitHub | `test/packs-github.test.ts`：技能文件、缺 `gh` 时的提示 | 没有调用 `gh` 访问网络 |
| `/commit` | `test/packs-commit.test.ts` 9 个用例，全部在真实临时仓库里：倒序拆 hunk、改名加修改、二进制、暂存的新文件、仓库的第一个提交、hook 中途拒绝时逐字节恢复、全是相同行的文件；命令本身：确认后提交、带上用户的话、计划漏单元时退回一次再用规则、用户拒绝或无界面时不提交。做过变异检查：行号偏移两处、index 恢复一处，改坏都会被抓到 | — |
| `/review` | `test/packs-review.test.ts`：分级表每一格、判定器没答的题算拿不准、命令打开包并交出评审、真实工具调用的排序、影子模式下按评审自己的轻重 | 真实 Jev 对这两个问题的校准未测 |
| 冲突解决 | `test/packs-conflicts.test.ts`：两种冲突样式、CRLF、损坏的标记；一次真实的停住的合并（一块的文件、两块分两次解决的文件、一方删除的文件），全程 HEAD 不动、MERGE_HEAD 还在 | 变基、拣选只靠同一套代码，没有单独的用例 |
| 调试器 | `test/dap.test.ts` 13 个用例：适配器表、替身适配器上的完整协议（两种启动顺序、TCP、条件断点、异常、死循环与暂停、中止）、通过 harness 的整个包 | **本机真实 debugpy 1.6.7 跑通**；delve、lldb-dap 未在真机跑 |

未验证：Windows（`git` 走不经 shell 的进程，路径用 `node:path`，但没在真机跑过）；`/commit` 在带 gpg 签名要求、会改文件的格式化 hook（比如本仓库的 pre-commit 会 `biome --write`）的仓库里的表现；真实模型的分组质量。

## 7. 留给用户拍板的

- `/commit` 的规则兜底是“每个文件一个提交”。要不要改成“全部一个提交”？前者更细，后者更安全。
- `/review` 的判定器不可用时整体降一级，这是保守的选择；也可以完全照评审的轻重。
