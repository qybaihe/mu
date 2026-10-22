# 用 git worktree 隔离、能改文件的子代理

更新日期：2026-09-22。代码：`packages/kyrn-judge/src/swarm/worktree.ts`、`src/swarm/patches.ts`、`src/decisions/swarm-patch.ts`、`src/extension/features/swarm-isolation.ts`，接线在 `src/extension/features/swarm.ts`。

## 问题

以前会改文件的子代理（`worker`）直接在主代理的工作目录里改。例子：主代理一次委派两个 worker，都要动 `src/a.ts`，后写的覆盖先写的；其中一个跑偏了，留下的半截改动和主代理自己的未提交改动混在一起，分不开也撤不掉。

## 做法

1. **谁被隔离**。`delegate` 的每个任务多了一个可选参数 `isolation`（`worktree` / `none`）。不写时按角色决定：角色的工具清单为空（全部工具，内置 `worker` 就是）或含 `edit` / `write` 的，默认 `worktree`；只读角色（scout、planner、reviewer、investigator、browser）默认 `none`，行为和以前完全一样。
2. **检出放在哪**。`git worktree add -b mu/agent-<运行id>-<序号> <临时目录>/kyrn-swarm-<运行id>/w<序号> HEAD`。目录在系统临时目录下、仓库之外，所以不会出现在用户的 `git status` 里；沿用桌面端用正则校验的 `kyrn-swarm-*` 前缀，路径也短（Windows 上约 60 个字符的开销）。运行目录会被 `chmod 700`：共享 `/tmp` 的机器上源码不该被别人读到。
3. **带上未提交的状态**。子代理应该看到主代理看到的文件：已跟踪文件的改动用 `git diff HEAD --binary` 在新检出里 `git apply`，未跟踪且未被忽略的文件逐个复制（单个超过 10 MiB 的跳过，并在结果里说明）。选这条路而不是 `git stash create`，因为后者带不了未跟踪文件。被忽略的文件（`node_modules`、`.env`）不带。
4. **起点是一棵树，不是一次提交**。带完状态后 `git add -A` + `git write-tree` 记下起点，再 `git reset -q` 把索引还原，于是子代理眼里这些改动仍是“未提交”，和主代理一致；不产生提交，也就不触发钩子、不需要身份和签名。
5. **结果是一个补丁**。子代理结束后 `git add -A`，再 `git diff --cached --binary -M <起点树>`：新增、删除、重命名、二进制文件都在内，被忽略的文件不在内，主代理自己的未提交改动也不在内。子代理在自己的分支上提交过与否不影响结果。补丁按字节处理，不经过 UTF-8 转换。
6. **一定清理**。子代理正常结束、报错、被看门狗或用户终止，都在 `finally` 里收补丁、`git worktree remove --force`、删分支。会话关闭（`session_shutdown`）时拆掉还活着的检出。进程被直接杀掉时靠标记文件：每个检出旁边先写一个 `w<序号>.json`（进程号、仓库、目录、分支），下次会话启动时扫描临时目录，属主进程已不存在、已标记为释放、或超过 24 小时的，一律清掉。扫描只认标记文件，且标记必须紧挨着它指向的目录，所以不会碰用户自己的 worktree。
7. **拿回改动是单独的一步**。`delegate` 的结果里有：补丁编号（如 `p-3f9a2c`）、文件清单和增删行数、补丁开头若干行、判定器的范围检查。要不要用由主代理决定，用新工具 `apply_patch_from`：
   - `action: "stat"` 列文件，`action: "diff"` 看某一个文件的改动（二进制内容不显示）；
   - 默认 `apply`：`git apply --3way`，**要么全部应用，要么什么都不动**。有冲突时逐个文件报告，补丁保留；
   - `conflicts: "markers"` 是显式选择：能合并的先应用，冲突的文件里留下冲突标记，并准确列出是哪些。
   - 从不提交，从不暂存。
8. **不碰用户的索引**。`--3way` 要经过索引：它要求被改的文件与索引一致，还会把结果暂存。用户的索引里可能正放着下一次提交的一半，所以合并在一个临时索引（`GIT_INDEX_FILE`）上做：先只把补丁涉及的路径按工作区现状同步进去，再应用。带 `--cached` 时它不改任何文件，这就是真正的“试运行”（`git apply --check` 做不到：对它来说三方合并出冲突不算失败）。
9. **路径**。主模型写的指令里常带仓库的绝对路径，照着做会直接改到原仓库，隔离就白做了。所以交给子代理的指令里，仓库路径（两种写法：git 解析后的和会话实际所在的）都换成检出的路径，并附一句说明。
10. **信任**。临时目录是一个从未被信任过的路径。它就是用户那个项目的副本，所以把主会话的信任结论原样传给子进程（`--approve` / `--no-approve`），不多给也不少给。用户的硬约束（`KYRN_SWARM_CONSTRAINTS`）照常传下去，子进程里的约束闸门照常生效。

## 什么时候不隔离

没装 git、不在仓库里、裸仓库、还没有任何提交、正在 rebase / merge / cherry-pick / revert / bisect、`mu.json` 里关掉了、或者建检出失败：都退回原地修改，并在结果里写明原因（例如 `Not isolated (this directory is not in a git repository)`）。主会话本身在一个 detached 的 linked worktree 里（mu 自己的开发环境就是这样）是支持的，有测试。

## 决策点 `swarm.patch`

延续蜂群的思路（判定器把关蜂与蜂之间传什么）：补丁回来时问判定器，只给任务文字、改动的路径和行数，**不给 diff**。

- `within_task`（boolean）：Does `change` stay within what `task` asks for?
- 每个文件一问，最多 12 个（boolean）：Does `task` call for changing this file? `<路径>` (`<状态> +x -y`)

只有高置信的“否”才把文件标为无关；拿不准就不说。结果是给主代理看的一句话（`2 files in scope, 1 looks unrelated to the task: package-lock.json`），从不拦截。`shadow` 只记录不显示，`off` 不问，判定器不可用时兜底是什么都不说。能力类别 `relate`。

## 选项（`mu.json` 的 `features.swarm`）

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `isolation` | `"worktree"` | `"none"` 表示所有子代理都原地修改 |
| `carryUncommitted` | `true` | 子代理从主代理当前的文件状态开始 |
| `patchPreviewLines` | `30` | 随报告给主代理看的补丁行数 |

## 展示事件

`swarm.worktree.created`、`swarm.patch.ready`、`swarm.patch.applied`、`swarm.worktree.removed`。只有任务名、分支、相对路径和计数，没有文件内容。补丁旁边另有一个同名 `.json`，`/swarm` 会列出本会话的补丁及其状态。

## 行尾（CRLF）

实测结论：**不要**强行 `-c core.autocrlf=false`。补丁的两端在同一个仓库里运行，用仓库自己的设置两边才一致；只在一端关掉反而会弄坏行尾。真正会出事的是 `core.safecrlf=true`：它让对 CRLF 文件做哈希直接报致命错误，`git add -A` 和临时索引都会失败，所以每条 git 命令都带 `-c core.safecrlf=false`。另外带 `core.quotepath=false`（中文路径原样返回）、`core.hooksPath` 指向不存在的目录（不为用户没做的检出跑他的 post-checkout 钩子）、Windows 上带 `core.longpaths=true`；语言固定为 `LC_ALL=C`，因为报错要给模型看、也要在测试里比较（这台机器的 git 是中文的）。

已知的 git 自身行为：`core.autocrlf=input` 下，磁盘上是 CRLF 的文件被 `git apply` 重写后变成 LF，这与 `git checkout` 在该设置下的结果一致。

## 已验证

27 个新测试（`test/swarm-worktree.test.ts` 11 个、`test/swarm-patches.test.ts` 7 个、`test/swarm-isolation.test.ts` 9 个），git 本身不做任何模拟，全部用测试里现建的真实仓库（git 2.49，macOS），路径里带空格和中文：

- 建 / 拆检出与分支；用户的 `git status` 不变；带上已跟踪（暂存和未暂存）与未跟踪的改动，被忽略的不带；
- 补丁含新增、删除、重命名、二进制、CRLF 文件；子代理自己提交过也一样；
- 应用后用户的暂存区逐字节不变；重复应用报“已应用”；冲突时什么都不动（连本可干净应用的文件也不动）；`markers` 模式；主代理在子代理启动后又改了同一文件的其他行，三方合并保留双方；补丁涉及的文件被删，报出文件名且不改动任何东西；
- 两个并行 worker 同时存在于各自的检出，补丁编号不同，第二个补丁的冲突被正确报告；
- 崩溃的 worker 仍留下补丁、检出被清理；会话关闭时拆掉运行中的检出；陈旧检出清扫（死进程、活进程、已释放、目录被手工删掉、进程号被复用、指向别处的恶意标记）；
- 无 git、非仓库、裸仓库、无提交、合并进行中的回退；`isolation: "none"`；
- `autocrlf=true` 往返保持 CRLF；`autocrlf=input` + `safecrlf=true` 不再致命；Windows 的 `core.longpaths` 参数拼装；
- `swarm.patch` 的问题措辞、状态、上限、active / shadow / off / 判定器报错；展示事件的顺序且不含内容。
- 原有的 swarm、hive、features、extension、manifest 测试仍然通过。

## 未验证

- **没有在 Windows 或 WSL 真机上跑过。** 只对参数拼装做了按平台参数化的单元测试。风险最大的一点：子进程还没退出时 Windows 不让删它的当前目录，现在靠带重试的删除加“已释放”标记留给下次清扫，未实测。
- **没有用真实的 pi 子进程和真实模型跑过隔离的委派。** 测试注入的是 `SwarmRunner`；`spawnRunner` 把 `cwd` 和 `--approve` 传给子进程这段只有参数层面的断言。
- 子模块、Git LFS、sparse checkout 的仓库没有测；diff 时忽略了子模块的变化。
- 检出里没有 `node_modules` 等被忽略的目录，所以子代理在里面跑不了依赖它们的测试。这是 worktree 隔离的固有代价，目前没有处理（可以考虑以后加一个“链接这些目录”的选项）。
- `/swarm` 列出补丁只测了那一行文字的生成，没有在界面上看过。
- 会话恢复（resume）之后补丁记录不在内存里：补丁文件还在临时目录，但 `apply_patch_from` 找不到它。
