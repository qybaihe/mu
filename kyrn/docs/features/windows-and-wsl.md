# Windows 与 WSL：跨平台启动器、浏览器发现、POSIX 假设清单

更新日期：2026-09-25。状态：**代码和单元测试完成，macOS 上实跑通过；Windows 上由 CI（`windows-tests.yml`，windows-2022）跑通全部单元测试，经 cmd.exe 实跑了 `mu.cmd`，经 Windows PowerShell 5.1 和 PowerShell 7 实跑了 `mu.ps1`；交互控制台和 WSL 仍没有在真机上运行过。** 正文里“未在真机验证”的标记写于 CI 之前，以第 7 节的两张清单为准；第 8 节是还要查的。

## 1. 做了什么

| 部分 | 文件 | 说明 |
| --- | --- | --- |
| 启动器 | `kyrn/bin/mu.mjs`（新）、`mu.d.mts`（类型，给测试用） | 原 bash 启动器的全部分支搬到纯 Node（ESM、无依赖、不用 TypeScript：它在找到能跑 TypeScript 的东西之前就要跑）。每个决定都是导出的纯函数，平台、环境变量、文件系统都是参数 |
| 转发器 | `kyrn/bin/mu`（bash，重写）、`mu.cmd`、`mu.ps1`（新） | 只剩一件事：确认有 Node >= 22.19，然后交给 `mu.mjs`。`kyrn`、`kyrn-dev` 照旧转发到 `mu` |
| 平台判断 | `packages/kyrn-judge/src/platform.ts`（新） | WSL 识别、`wslpath` 式路径互转、`/etc/wsl.conf` 的挂载根、进程树终止方案 |
| 浏览器 | `src/browser/chrome.ts`（重写发现部分） | Windows、Linux（含 snap / flatpak）、WSL 的发现与启动命令行 |
| 体检 | `kyrn/bin/kyrn-doctor` | 报告平台；非 macOS 上解释本地判定服务的限制而不是报失败；Windows 上能 import |
| 测试 | `test/launcher-platforms.test.ts`（30 个）、`test/browser-discovery.test.ts`（16 个） | 见第 7 节 |

## 2. 启动器

```
macOS / Linux / WSL：  kyrn/bin/mu（bash：选 Node）→ exec node mu.mjs → execve 成 node（自带类型擦除）→ pi
Windows：             kyrn\bin\mu.cmd（查 Node 版本）→ node mu.mjs → spawn node（自带类型擦除）→ pi
```

- **检出直接用 Node 自带的类型擦除跑源码（2026-09-26）。** Node 22.18 起默认能擦除 TypeScript 类型，`mu.mjs` 的 `sourceRuntime` 就用 `node --import compile-cache.mjs --import <pi 的 source-resolver.ts> cli.ts` 启动：pi 自己的 `packages/coding-agent/src/experimental/source-resolver.ts` 按根 `tsconfig.json` 的 paths 把各工作区包解析到源码，`compile-cache.mjs` 打开 Node 的编译缓存（npm 包的 bundle 入口也这么做）。原来经 tsx：tsx 的加载器在单独线程上，每个文件都要从那边转一手。M 系列 Mac 上 pi 加判断层从 2.0 s 降到约 0.85 s（有负载时 2.1–2.6 s 对 1.0–1.35 s），`mu auth status` 从 1.65 s 降到 0.85 s；桌面端每开一个对话都要启动一次 mu，开发版的第一条回复因此快一秒多。`--import` 给的是 file URL：Windows 路径 `C:\...` 会被当成协议为 `c:` 的 URL。2026-10-05 合并 pi 1.0 时 pi 自己也去掉了 tsx（`pi-test.sh` 同样是 `node --import source-resolver.ts`），启动器随之不再经 tsx：Node 不擦除类型（`process.features.typescript` 为假；桌面端用的 Electron 37 和 44 都能擦除）或检出里没有这个解析器时，直接报错说明原因。能这么跑的前提是源码只用可擦除语法、类型导入都写了 `type`：根配置加 `--verbatimModuleSyntax` 跑 tsgo，1908 个文件 0 错。

- **选 Node 留在 bash 里。** 默认 Node 比 22.19 旧的机器（本机默认就是 20）不能指望它跑得动启动器本身，所以在任何 JavaScript 运行之前先从 PATH、再从 nvm 里挑。现在精确到 22.19（原来只看主版本 >= 22）。用 `node --version`（约 15 ms）代替 `node -p`（约 29 ms）。`mu.mjs` 自己还会再查一次，给出同样清楚的提示。
- **不经过 `.cmd` 垫片。** Windows 上 `node_modules/.bin/*` 是 `.cmd`，只能经 shell 启动，带引号或 `&` 的 prompt 会被二次解析。所有平台都用 `process.execPath` 加参数数组直接启动 Node，从不拼命令行字符串（经 tsx 的年代要读 tsx 的 `bin` 拿到真正的 `dist/cli.mjs`；2026-10-05 起不经 tsx）。依赖装没装好看 `node_modules/undici`（pi 和判断层都依赖它），按 Node 解析 import 的规则找：先看仓库根，再逐级往上看父目录。放在主检出下面的 git worktree（本仓库的代理 worktree 都是）自己没有 `node_modules`，靠主检出的跑，和它里面的 import 一样（两个平台都有用例）。
- **POSIX 用 `process.execve` 顶替自身，Windows 用 spawn。** 启动耗时两者一样（见下表），选 execve 不是为了快，而是为了进程树和 bash 的 `exec` 完全一致：桌面端按进程组发 SIGTERM，中间多一层常驻 Node 就会出现信号重复投递，还多占一个进程。`process.execve` 在 Node 22.15+ 才有，文档标为实验性；不可用或抛错时自动退回 spawn。`MU_LAUNCH=spawn` 可强制走 Windows 那条路，测试用它在 macOS 上实跑了这条路径（含非零退出码透传）。spawn 路径在 POSIX 上转发 SIGINT / SIGTERM / SIGHUP；Windows 上 `kill` 不是信号而是直接结束进程，控制台的 Ctrl+C 本来就会送到子进程，所以父进程只是活着等子进程退出。
- **`mu.ps1` 不进 PATH。** 它的价值是 PowerShell 用户不经 cmd.exe，参数原样传递。但 PowerShell 在同一目录里优先选 `.ps1`，而 Windows 客户端默认执行策略是 Restricted：`.ps1` 一旦和 `mu.cmd` 一起放进 PATH 目录，`mu` 在 PowerShell 里会直接报错而不是退回 `.cmd`（npm 的老问题）。所以 `mu link` 只写 `mu.cmd`，`mu.ps1` 留在仓库里按路径调用。
- **`mu.ps1` 自己转义引号。** Windows PowerShell 5.1（以及 7.3 之前的 PowerShell 7，或手动设成 `Legacy` 的传参方式）把参数交给程序时不转义里面的引号：`mu.ps1 'fix the "login" bug'` 到了 node 那里成了 `fix the login bug`。它还会丢掉空参数；参数里有空格时它会加引号，却不把末尾的反斜杠加倍，这些反斜杠会把收尾的引号转义掉。所以在这种传参方式下，`mu.ps1` 按 node 读回参数的规则自己转义：引号写成 `\"`，引号前的反斜杠加倍，空参数写成 `""`，有空格的参数末尾的反斜杠加倍。PowerShell 7.3 以后默认的传参方式本来就原样，不再动。

macOS 实测（Node 24.16，临时 HOME，9 次取中位数）：

| 命令 | 原 bash 启动器 | 新启动器（execve） | 新启动器（`MU_LAUNCH=spawn`） |
| --- | --- | --- | --- |
| `mu help` | 10 ms | 71 ms | — |
| `mu version` | 103 ms | 70 ms | — |
| `mu --version`（完整启动 pi） | 2364 ms | 2124 ms | 2122 ms |

`mu help` 变慢是因为它现在也需要 Node（原来是纯 bash 的 sed）；其余持平或更快。

### 各平台的差异（都由带 `platform` 参数的函数决定）

| 事项 | macOS / Linux / WSL | Windows（未在真机验证） |
| --- | --- | --- |
| 数据目录 | `~/.mu`；有 `~/.kyrn` 而没有 `~/.mu` 时继续用 `~/.kyrn`，绝不在旁边新建 `~/.mu` | 同一条规则，路径是 `%USERPROFILE%\.mu` |
| 应用视图 `<home>/app` | `src`、`docs`、`examples`、`README.md`、`CHANGELOG.md` 都是软链 | 目录用 junction（不需要特权），两个文件用复制，源文件更新（mtime 或大小变化）时重新复制。junction 读回来带尾部反斜杠、大小写不同也算同一个目标。**从不递归删除**：视图里是真目录就原样留着，因为穿过 junction 递归删会删到真正的源码 |
| 视图的 `package.json` | 不变：上游更新或 `piConfig` 名字不是 `mu` 时重建，包名保持 pi 的 | 同左 |
| 导出的变量 | `PI_PACKAGE_DIR`、`MU_CODING_AGENT_DIR` 及两个旧拼写、`PI_SKIP_VERSION_CHECK` | 同左 |
| `mu link` | 软链到 `~/.local/bin/mu`（或 `MU_LINK_DIR`） | 写一个 `mu.cmd` 垫片。同盘时用 `%~dp0` 加相对路径指向仓库里的 `mu.cmd`：cmd 按控制台代码页读批处理文件，绝对路径里有中文用户名就会乱码，而相对路径通常把用户名消掉了；跨盘只能写绝对路径，含非 ASCII 字符时给出提示。不在 PATH 上时打印一条只读写**用户级** PATH 的 PowerShell 命令（不用 `setx`：它会把系统 PATH 并进用户 PATH 并在 1024 字符处截断），不自动改 PATH |
| `mu link` 的两条拒绝 | 目标位置已有不是自己的 `mu`：不覆盖；PATH 上已有别的 `mu`：不遮蔽，除非 `--force` | 同左；“是不是自己”靠垫片内容判断，按 PATHEXT 搜 PATH，仓库的 `kyrn\bin` 自己在 PATH 上不算“别的 mu” |
| `mu unlink` | 只删软链 | 只删带自己标记行的垫片 |
| `mu migrate` | 行为与原 bash 版一致，仍用 `pgrep`（既有 7 个测试原样通过） | `tasklist /FO CSV` 取进程名 + 一次 PowerShell `Get-CimInstance Win32_Process` 取命令行，由带测试的解析函数处理；旧路径留 junction。**读不到进程列表就拒绝迁移。** 实际上只有这台 Mac 有过 `~/.kyrn`，Windows 上永远是“Nothing to move” |
| `mu judge …` | macOS：照旧调 `kyrn-judge-local` | 见第 5 节 |

### `.env`

原来是 bash `source`，现在由 Node 解析成子进程的环境变量：空行、`#` 注释、`export ` 前缀、单引号（原样）、双引号（`\"` `\\` `\$` `` \` `` 转义，可跨行）、无引号值后的 ` # 注释`。**文件是数据，不是脚本**：不展开 `$VAR`，不执行任何东西（这一点比原来更安全，也是与 bash 行为的有意差别）。解析不了的行只报**行号**，从不回显内容。真实环境里已有的变量优先（包括空值：`AI_GATEWAY_API_KEY= mu` 就是不带密钥跑一次；原来 source 是文件覆盖环境，这是第二个有意差别）；Windows 上变量名不分大小写。启动器自己导出的变量不受 `.env` 影响。测试只用夹具，没有打开过真实的 `.env`。

## 3. 浏览器发现

`MU_CHROME` / `KYRN_CHROME` 始终优先。所有判断都在接受 `BrowserHost`（平台、环境、home、`exists`、WSL 信息）的纯函数里。

- **Windows（未在真机验证）**：`%ProgramFiles%`、`%ProgramFiles(x86)%`、`%ProgramW6432%`、`%LOCALAPPDATA%` 下的 Chrome、Chromium、Edge、Brave（变量名不分大小写）。Windows 自带 Edge，所以基本总能找到。
- **Linux（未在真机验证）**：先包管理器装的（google-chrome-stable、google-chrome、chromium、chromium-browser、microsoft-edge、brave），再沿 PATH 找同名命令，最后 snap 和 flatpak。snap 看不到家目录下的隐藏目录（`~/.mu`）也看不到系统 `/tmp`，flatpak 只能写自己的数据目录，所以这两种的 profile 会被改放到 `~/snap/<名>/common/mu-…` 或 `~/.var/app/<id>/data/mu-…`；`LaunchedChrome.profileDir` 报告实际位置，子代理的一次性 profile 按实际位置清理。
- **WSL（未在真机验证）**：
  - **WSL 里装了浏览器就用它**，与网络模式无关：它和 mu 共用 Linux 的回环，而且 mu 默认无头运行，不需要 WSLg。
  - **Windows 侧的浏览器只在 mirrored 网络模式下使用**（`wslinfo --networking-mode` 返回 `mirrored`）。依据是微软文档：mirrored 模式下 Windows 与 WSL 可以互相用 `127.0.0.1` 连接（只支持 IPv4，所以代码里固定用 `127.0.0.1` 而不是 `localhost`）。此时经 interop 直接启动 `/mnt/c/.../msedge.exe`，profile 目录用 `wslpath -w` 式的纯函数换成 Windows 写法（`/mnt/c/...` → `C:\...`；WSL 内的路径 → `\\wsl.localhost\<发行版>\...`），`DevToolsActivePort` 仍从 Linux 侧路径读，工作目录设成浏览器所在的 `/mnt/c/...` 目录。
  - **NAT 模式（默认）下明确拒绝 Windows 侧浏览器。** NAT 下 WSL 的 `localhost` 是 WSL 自己，连 Windows 只能用宿主地址（`ip route` 的默认网关），而 Chrome 的调试端口只监听 Windows 的回环、没有任何鉴权。要让 WSL 连得上，就得让它监听局域网也够得着的地址（而且新版 Chrome 在非旧式 headless 下本来就忽略 `--remote-debugging-address`）。这等于把一个能完全控制浏览器的端口开给网络，**不做**。此时给出确切指引：在 WSL 里装浏览器的命令（Debian/Ubuntu、Fedora、Arch），或在 `%USERPROFILE%\.wslconfig` 写 `[wsl2]` / `networkingMode=mirrored` 后 `wsl --shutdown`（需要 Windows 11 22H2+）。旧版 WSL 没有 `wslinfo`：当作不可用。
  - 已知风险：profile 放在 WSL 文件系统里时，Windows 的 Chrome 经 `\\wsl.localhost`（9P）读写它，锁和 SQLite 在这种路径上是否可靠**没有验证**。退路已经留好：把 `features.browser.profileDir` 设成 `/mnt/c/...` 下的目录，就会被换成普通的 `C:\...` 路径。Windows 侧浏览器被 `kill` 时是否真的退出也没有验证（没退的话下次会按既有逻辑复用）。

## 4. 平台识别

`/proc/version` 含 “microsoft” 或有 `WSL_DISTRO_NAME`，且平台是 linux，才算 WSL。对启动器来说 WSL 就是 Linux；区别只在浏览器和 `mu doctor` 的平台一行（macOS / Linux / WSL / Windows）。规则有两份（`mu.mjs` 的 `detectWsl`、`platform.ts` 的 `isWsl`，因为启动器不能 import TypeScript，包也不能依赖 `kyrn/bin`），有一个测试把两份在同一张输入表上逐项比对。

## 5. 本地判定服务（Laya）

sidecar 是 Core ML，只能在 Apple Silicon 的 macOS 上跑。非 macOS 上：

- `mu judge setup|start|stop|run`：打印说明并以 1 退出，不会出现堆栈。说明里写明：只支持 macOS；可以用 Jev 或 `mu.json` 里的 llm 判定器；桌面端自己的本地判定服务在做；任何实现了同一契约（`GET /health`、`POST /evaluate`）的服务器都可以通过 `MU_LOCAL_JUDGE_URL` 接进来。
- `mu judge status` 在设置了 `MU_LOCAL_JUDGE_URL` 时会真的去问那台服务器的 `/health`。
- 配置里要了 laya 而平台跑不了：启动时一行提示（设置了 `MU_LOCAL_JUDGE_URL` 就不提示），决策照常回退到下一层判定器或 pi 的原生行为。`mu doctor` 把它显示成说明行而不是 `fix`。
- macOS 上行为不变（配置里有 laya 就自动拉起）。

## 6. 仍然假设 POSIX 的地方（grep 审计，范围：`kyrn/` 与 `packages/kyrn-judge/src`）

检索词：`/tmp`、`process.kill(-`、`detached`、`SIGTERM|SIGKILL|SIGINT`、`chmod|mode: 0o`、`which|command -v|bash -c|shell: true`、`env.HOME|~/`、`split("/")` 等路径分隔符写法、`.pathname`、`import(join`、`pgrep|nohup|lsof|curl`。

| 位置 | 假设 | 状态 |
| --- | --- | --- |
| `kyrn/bin/mu`（原 bash 启动器全部逻辑） | bash、`ln -s`、`source .env`、`pgrep`、`.bin/tsx` | **本包已修**：搬到 `mu.mjs` |
| `kyrn/bin/kyrn-doctor` | `import(join(root, …))`（Windows 不能 import 盘符路径）、查 `.bin/tsx`、`readlink` 判断是否已 link | **本包已修**：file URL、真正的 tsx 入口、识别 `mu.cmd` 垫片 |
| `src/browser/chrome.ts` | 只有 macOS 和三个 Linux 路径 | **本包已修** |
| `src/extension/features/swarm.ts` 停止子代理 | `child.kill("SIGTERM")`：Windows 上只结束这一个进程，它启动的东西成了孤儿 | **本包已修**：win32 用 `taskkill /T /F`（`platform.ts` 的 `stopPlan`，有测试） |
| `src/extension/features/welcome.ts` 终端标题 | `cwd.split("/")` | **本包已修**：`basename` |
| `src/mcp/stdio.ts`、`src/mcp/spawn.ts`、`src/inherit/mcp-config.ts` | `.cmd` 垫片、进程树 | **别的包已修**：已处理 win32（`taskkill /T`、垫片解析） |
| `src/inherit/glob.ts` | glob 里的路径分隔符 | **别的包已修**：模式和路径都先把 `\` 换成 `/` |
| 后台命令（`bg_*`） | 进程树 | **别的包已修**（协调者确认已用 `taskkill /T`；本包没有复核） |
| `compaction.ts`、`swarm.ts` 的 `mode: 0o600` | 靠权限位保护临时文件 | **无害，保持**：Windows 忽略权限位，但 `%TEMP%` 本来就在用户配置目录下，按用户隔离 |
| `guard.ts`、`constraints.ts`、`completion.ts`、`compaction/prune.ts`、`swarm/state.ts` | 只认 `bash` 工具；`guard.ts` 的危险命令规则全是 POSIX 写法（`rm -rf`、`sudo`、`curl … \| sh`） | **未解决**：Windows 上 pi 还有 `powershell` 工具，这五处都看不到它的命令，危险命令复核（B3）对 `Remove-Item -Recurse -Force`、`rd /s /q`、`iex (iwr …)` 无效。涉及判断点措辞，应单独做一包 |
| `kyrn/bin/kyrn`、`kyrn-dev` | bash 转发器 | **未解决（有意）**：Windows 上入口是 `mu.cmd`。桌面端适配器现在调用 `kyrn/bin/kyrn`，它的 Windows 版应直接 `spawn(node, [mu.mjs, …])`（不要经 `.cmd`），并且用 `taskkill /T` 或关闭 stdin 来结束会话：Windows 上杀掉启动器不会带走 pi。属于桌面端的包 |
| `kyrn/bin/kyrn-judge-local`、`kyrn/local-judge/server.py` | bash、`curl`、`nohup`、`kill -0`、Core ML | **未解决（有意）**：运行时本身只有 macOS 版。路线图第 4 节第 4 条（ONNX / CPU 运行时）另做 |
| 桌面仓库的 `scripts/kyrn/*` | bash | **未解决**：不在本仓库 |

## 7. 验证

已验证（macOS，Node 24.16，隔离工作树）：

- `npm run check` 通过（每次提交前）。
- 既有 `test/launcher.test.ts` **一行未改**，11 个用例全部通过，其中 2 个需要依赖的用例也实跑了（旧命令名转发、`link` 的两条拒绝、视图重建、留在 `~/.kyrn`、`mu migrate` 的 7 个用例含假 `pgrep`）。
- `test/launcher-platforms.test.ts` 30 个，其中 27 个用 win32 / linux / WSL 参数调用纯函数：Node 版本门槛；数据目录规则（win32 路径）；WSL 识别及两份规则一致；应用视图（POSIX 真实文件系统实跑；win32 用内存文件系统验证 junction 类型、复制、过期刷新、不删目录）；tsx 入口解析；Windows 上的启动命令（参数数组、无 `.cmd`、含 `"`、`&`、`%`、`|` 的 prompt 原样）；exec / spawn 策略；`.env` 解析与优先级、任何输出里都不出现值；本地判定服务在各平台的说明；Windows 的 link 垫片内容与两条拒绝、PATH 提示、非 ASCII 提示、unlink；`tasklist` / PowerShell CSV 解析、忙碌检测、junction、读不到进程列表时拒绝。其余 3 个在本机实跑启动器：Node 太旧时在任何 JavaScript 之前拒绝并能从 nvm 里挑到新的；`link` 后经软链调用再 `unlink`；`MU_LAUNCH=spawn` 完整启动 pi 并透传 `mu doctor` 的退出码 1。
- `test/browser-discovery.test.ts` 16 个：三个平台的候选表与顺序、`MU_CHROME`、snap / flatpak 的 profile 位置、WSL 下 Linux 优先、mirrored 才用 Windows 侧、NAT 拒绝及指引文本、Windows 写法的 profile、路径互转、挂载根、进程树终止方案。
- 真实 Chrome：`test/browser.test.ts` 在本机用真 Chrome 通过（`launchChrome` 改动后 macOS 行为不变）；`extension`、`features`、`manifest`、`naming`、`agents`、`swarm-run`、`cli` 测试通过。
- 手工实跑（临时 HOME）：`mu help`、`mu version`、`mu --version`、`mu doctor`（多了 platform 一行，临时 HOME 没被写入）、`mu judge status`、`mu ledger`。没有对真实的 `~/.mu` 运行过 `mu link` 或 `mu migrate`。

已验证（Windows，GitHub Actions 的 windows-2022，2026-09-25，run 36108731023）：

- 判断层全部单元测试（859 通过，38 跳过）和桌面端 mu 的单元测试（996 通过，104 跳过）。Windows 上跳过的是那里没有意义的用例：文件权限位、chmod 造成的读写失败、WSL 启动脚本、用 shell 脚本写的替身程序。
- `mu.cmd` 经 cmd.exe 实跑：help、link、unlink、migrate、`--version`、doctor、import，退出码原样传出；PATH 上没有 node 和 node 太旧时的拒绝；用户目录名含非 ASCII 字符时，`mu link` 写出的垫片仍能调到 `mu.cmd`。经 tsx 启动 pi 也在其中。
- NTFS 上应用视图的 junction 与复制、过期后重建；真实的 `tasklist` + `Get-CimInstance` 找到正在运行的会话。
- 由此发现并修掉两个产品问题：Windows 上 bash 工具的命令被按 PowerShell 的规则读，`rg 'useState\(' src` 这样的只读搜索也要批准（pi 在 Windows 上用 Git Bash 跑 bash 工具）；子代理从仓库的子目录启动时，路径没有搬进它的工作树（git 给的前缀用 `/`，会话目录用 `\`）。

已验证（`mu.ps1`，同一台 windows-2022，2026-09-25，公开仓库 main 的 run 36124913954）：

- `test/launcher.test.ts` 像人在 PowerShell 提示符里那样调用 `mu.ps1`（`& mu.ps1 '…'`，参数放在变量里传，不经 `-File` 的命令行），分别用 Windows PowerShell 5.1、PowerShell 7，以及把 PowerShell 7 设成 `Legacy`（7.3 之前的传参方式）。三个参数：`--say "hi" & 100% done`、`--dir=C:\my dir\`、`--quote=a\"b`。`mu import` 会把不认识的选项原样说出来，所以测试逐字比对 node 收到的内容，并检查退出码 2 原样传出。
- 修复前，这个测试在 5.1 上失败（临时分支 `ci/ps1-before`，run 36115360299）：传入 `--say "hi" & 100% done`，mu 说出来的只有 `--say`。由此修了 `mu.ps1`（见第 2 节）；修复后 5.1 的三个参数都原样通过，剩下的失败出在测试自己用 `-File` 传参（PowerShell 7 会先把 `--dir=C:\my dir\` 当成 `-名字:值` 拆开），测试随后改成经变量传参。

**没有验证**（没有 Windows / WSL 真机）：

- Windows 控制台里交互运行 pi、Ctrl+C（经 `mu.cmd` 或 `mu.ps1` 都没有；CI 只跑了一次性的命令）。
- 非英文 Windows 上 `tasklist` 的输出（CI 是英文系统；因为表头不同，用了 `/NH` 不读表头）。
- Windows、Linux、WSL 上真实的浏览器发现与启动；snap / flatpak 的 profile 位置；mirrored 模式下经回环连接 Windows 侧 Chrome；`\\wsl.localhost` 上的 profile。
- Git Bash 里运行 `kyrn/bin/mu`。
- `process.execve` 只在 Node 24.16 上试过（22.19 未装）。

## 8. 拿到 Windows 机器后先查什么

第 1、2、5 项已由 CI 验证（见第 7 节）；第 3 项里 `mu.ps1` 那一半也已验证，剩下的是 cmd 这一层；第 6 项验证了 doctor 能跑、退出码对，找到的是哪个浏览器还没看过。

1. `kyrn\bin\mu.cmd help`、`version`：能跑、退出码为 0；把 PATH 里的 node 换成旧版，看到“needs Node.js 22.19 or newer”而不是语法错误。
2. `mu.cmd --version`：`%USERPROFILE%\.mu\app` 下 `src`、`docs`、`examples` 是 junction（`dir /AL`），两个 `.md` 是文件，`package.json` 里 `piConfig.name` 是 `mu`；再跑一次不应重建任何东西。
3. `mu.cmd -p "say ""hi"" & echo %USERNAME%"`：prompt 原样到达模型（cmd 这一层的引号规则是 npm 垫片同级的已知限制；`mu.ps1` 经 CI 验证是完全原样的）。
4. 交互模式下 Ctrl+C、`/quit`，以及关掉控制台窗口后 `tasklist` 里没有残留的 node。
5. `mu.cmd link`：垫片内容、`where mu`、PATH 提示那条 PowerShell 命令确实只改用户 PATH；用户名含中文的账户下再试一次。
6. `mu.cmd doctor`：platform 行是 Windows，browser 行找到 Edge 或 Chrome，local judge 是说明行。
7. 会话里 `/browse https://example.com`：Chrome 以 `%USERPROFILE%\.mu\browser-profile` 启动，结束后进程退出。
8. WSL（NAT）：`mu doctor` 的 browser 行给出安装指引；装上 Linux 版 Chrome 后 `/browse` 可用。
9. WSL（mirrored）且 WSL 内不装浏览器：`/browse` 能否连上 Windows 侧 Edge；不行就把 `features.browser.profileDir` 设到 `/mnt/c/...` 下再试，并记录是哪一步失败。
10. 子代理（`delegate`）被中止后，`tasklist` 里它和它的子进程都不在了。

## 9. 合并时要知道的

- 可能冲突的文件：`kyrn/bin/mu`（整体重写成转发器，冲突时以本分支为准，别人加在 bash 里的新分支要搬进 `mu.mjs` 的 `main`）、`kyrn/bin/kyrn-doctor`、`src/browser/chrome.ts`（发现部分重写；`launchChrome` 的返回值多了 `profileDir`）、`src/extension/features/browser.ts`（只动了 shutdown 里清理 profile 的三行）、`commands.ts`（`/doctor` 的 browser 一行）、`swarm.ts`（`terminate` 里五行）、`welcome.ts`（标题一行）、`src/index.ts`（导出）、路线图第 4 节。
- 工作树里未跟踪的 `node_modules` 和 `packages/ai/src/providers/data` 是为了实跑启动器临时建的软链，没有提交，可删。
- 新的启动器开关：`MU_LAUNCH=spawn|exec`（仅用于测试和排障）。
