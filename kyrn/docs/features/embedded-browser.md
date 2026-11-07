# 应用内浏览器 × UltraFast 判定循环

更新日期：2026-09-22（第二版）。状态：harness 一侧已完成并测试；桌面端的桥已在分支 `claude/mu-browser` 上完成，并用 harness 自己的 `CdpConnection` / `BrowserSession` / `runBrowserTask` / `EmbeddedBrowser` 在真实 Electron 里端到端跑通（35 项检查），尚未合入桌面端主干。第二版按联调结果补了：对话归属、逐标签页寻址、`Mu.run`、键盘被拒的处理、确认等待时长、桥会拒绝的方法。

## 1. 要解决什么

mu 的 `browse` 工具移植自 browser-use/jev-ultrafast：主模型只说一次目标，之后每一步都是“观察页面 → 判定器一次判断（选操作 + 选目标）→ 执行 → 再观察”，中间过程不经过主模型的上下文。原来的 Skill 和 mu 在终端里的做法，都是另起一个无界面 Chrome，用户看不见过程。

桌面端里要做得更好：**同一个循环，直接驱动应用内对话旁边的浏览器面板**。比原 Skill 多出来的：

- 看得见：每一步点了什么、判定器有多大把握，实时显示在页面上方；每步判断同时进判定器面板。
- 管得住：随时暂停、继续、停止；暂停时可以自己操作页面（接管），继续后循环会重新观察页面再判断。
- 不可逆操作（付款、删除、发送）用应用内的确认框问正在看页面的人，而不是被桥接层直接取消。
- 登录态留在应用自己的浏览器分区里，既不碰用户的浏览器，也不用每次重新登录。
- 应用没开（纯终端）时一切照旧：mu 启动自己的 Chrome。

## 2. harness 一侧（已完成）

- `packages/kyrn-judge/src/browser/embedded.ts`：发现端点、握手、控制、确认、逐步通知。
- 发现顺序：环境变量 `MU_BROWSER_ENDPOINT`（旧名 `KYRN_BROWSER_ENDPOINT` 也认）→ 数据目录里的 `desktop-browser.json`（内容 `{ "url": "ws://127.0.0.1:<端口>/<令牌>", "pid": <应用主进程号> }`）。只接受回环地址的 `ws://`；`pid` 对应的进程不在了就当没有。
- 连上后先发 `Mu.hello`，带上 `session`：应用的适配器启动 harness 时设置的 `MU_DESKTOP_SESSION`（应用里这个对话的标识），桥据此把标签页开在对应对话旁边。终端里直接运行的 mu 没有这个变量，就不带。对方不认识这个方法（普通 Chrome）、版本不符、或回答 `embedded: false`（应用开着但没有可以放页面的对话），都退回 mu 自己的浏览器。
- 一次运行里所有 `Mu.` 调用都带上该标签页的 DevTools `sessionId`：同一条连接上可以有多次运行，桥靠它区分。
- 运行开始和结束各发一次 `Mu.run`，应用因此能显示目标，结束时能显示真实的结局与原因，而不只是“已结束”。
- 键盘类命令（`Input.dispatchKeyEvent`、`Input.insertText`）被桥以“页面没有拿到键盘”拒绝时，当作页面已变（`StalePage`）：重新观察、重新判断，而不是让整次运行失败。次数受判断预算约束。
- 子代理（`KYRN_SWARM_DEPTH`）不用应用内浏览器：几个子代理抢一个面板没有意义。
- 功能开关：`features.browser.embedded`（默认开）。
- 展示事件：`browser.run`（开始 / 结束及状态）和 `browser.step`（步号、操作类型、目标标签、URL、概率、页面是否变化）。标签来自网页，是不可信文本，只能当文字显示。

## 3. 桥的协议（桌面端要实现的）

桥是主进程里的一个回环 WebSocket 服务：随机端口，路径是随机令牌（路径不对直接拒绝），只在应用运行期间存在；启动时把地址和主进程 pid 写进 `<数据目录>/desktop-browser.json`（权限 600），退出时删掉。**不要**给整个应用开 `--remote-debugging-port`：那会把有特权的主窗口也暴露给本机任何进程。桥只对“浏览页面”的 `webContents` 调 `webContents.debugger.attach()`。

消息格式与 DevTools 协议相同：请求 `{ id, method, params, sessionId? }`，应答 `{ id, result }` 或 `{ id, error: { message } }`，事件 `{ method, params, sessionId }`。

### 3.1 需要支持的浏览器级方法

| 方法 | 桥要做的事 |
| --- | --- |
| `Target.createTarget { url }` | 在当前对话的浏览器面板里新开一个标签页（面板没打开就打开它），返回 `{ targetId }`。此时页面是 `about:blank`，随后 harness 会用 `Page.navigate` 导航 |
| `Target.attachToTarget { targetId, flatten: true }` | 对该标签页的 `webContents` 执行 `debugger.attach('1.3')`，返回 `{ sessionId }` |
| `Target.closeTarget { targetId }` | 运行结束时 harness 会调用。桥**不关闭**标签页（用户要看最终页面），只解除调试器并把该页标记为“已结束”；返回 `{ success: true }` |

### 3.2 页面级方法（带 `sessionId`）

原样转给 `webContents.debugger.sendCommand(method, params)`，结果原样返回。两个例外：

- `Emulation.setDeviceMetricsOverride`：**不转发**，直接返回 `{}`。页面应保持面板的真实尺寸。
- `Emulation.setFocusEmulationEnabled`：转发（面板没有焦点时菜单和动画仍要渲染）。

harness 实际用到的方法以 `packages/kyrn-judge/src/browser/session.ts` 为准（`Page.navigate`、`Runtime.evaluate`、`Input.*`、`DOM.*` 等），桥不需要逐个认识它们，整体透传即可。调试器的事件（`debugger.on('message')`）带上对应的 `sessionId` 发回去。

### 3.3 `Mu.` 方法（桥自己应答，不转发）

| 方法 | 应答 | 说明 |
| --- | --- | --- |
| `Mu.hello { version, session? }` | `{ embedded: boolean, version: 1 }` | 握手。`session` 是应用里的对话标识（只含字母、数字、`_`、`-`，最长 80）。没有可放页面的对话时 `embedded: false` |
| `Mu.run { state: "started", goal, url }` / `{ state: "finished", status, reason? }` | `{}` | 目标与结局。`status` 取 `done` / `blocked` / `budget` / `needs_confirmation` / `aborted` / `read` / `failed`。可选：不发的话桥只能如实显示“已结束”（用户按了停止或拒绝了确认这两种它自己看得见） |
| `Mu.control {}` | `{ paused: boolean, stop: boolean }` | harness 每一步之前都会问。`paused` 期间 harness 每 400 ms 再问一次；`stop` 为真则本次运行以“已中止”结束。新一次运行开始时（下一个 `Target.createTarget`）两者复位 |
| `Mu.confirm { label, url }` | `{ allowed: boolean }` | 弹出应用内确认框：“mu 想执行：<label>”，显示页面地址。120 秒内没人回答视为拒绝；harness 等 125 秒，好让这个“拒绝”先到。`label` 是网页文本，只能当纯文本显示 |
| `Mu.step { step, kind, action, url, probability, pageChanged }` | `{}` | 给页面上方的实时步骤条用，不需要等待 |

### 3.4 安全要求

- 只监听 `127.0.0.1`；令牌至少 128 位随机数；令牌不写日志；广告文件权限 600。
- 每个 WebSocket 连接只能操作它自己创建的标签页。
- 浏览页面用独立的 session 分区（例如 `persist:mu-browser`），与应用自身的渲染进程、与用户的系统浏览器都隔离；不给页面任何 Node 能力。
- 只允许 `http:` / `https:` 导航；下载、权限请求（摄像头、定位等）默认拒绝。
- 用户正在手动操作同一个页面时（接管），桥把 `paused` 置真，避免人与循环同时点。
- 页面会话里桥会拒绝：`Target.*`、`Browser.*`、`Page.setDownloadBehavior`、`DOM.setFileInputFiles`，以及非 `http(s)` 的 `Page.navigate`。
- Chromium 把协议发来的按键和文字送给“窗口里拿着键盘焦点的东西”，而不是命令指名的页面。桥在发键盘类命令之前先把焦点放到该页面上；放不上去就拒绝（错误文本含 `does not hold the keyboard`），宁可不输入，也不输入到应用自己的消息框里。
- 页面丢失之后（崩溃、被 DevTools 抢走、连接断开），`Mu.control` 回答 `stop: true`，循环在下一步之前结束。

## 4. 验证情况

已验证（harness）：回环地址校验；环境变量与广告文件两种发现方式、已退出应用的广告被忽略；与普通 Chrome、与更高协议版本的对端握手失败后退回；暂停时等待、停止时结束、`AbortSignal`；确认框的放行与拒绝、面板消失时一律拒绝；逐步通知不阻塞；`beforeStep` 返回假时循环在下一步之前结束且不再提问判定器。测试用一个手写的最小 WebSocket 服务充当桥（`test/browser-embedded.test.ts`，6 个用例）。

第二版新增（harness，`test/browser-embedded.test.ts` 现为 9 个用例）：握手带对话标识、终端里不带；`embedded: false` 时退回；`forTab` 之后的控制、确认、步骤、运行通知都带该标签页的 `sessionId`；键盘被拒变成 `StalePage`，其它 `Input.*` 失败仍是失败（已用变异检查确认测试能抓到）。

桌面端的桥（分支 `claude/mu-browser`）：97 个单元 / DOM 测试；`scripts/kyrn/browser-bridge-check/run.mjs` 在真实 Electron 44.4.3 里用 harness 的原代码跑通 35 项（开页、点击、输入、暂停、停止、确认、令牌错误被拒、广告文件权限）。

未验证：真实应用窗口里、真实判定器驱动下的整次运行（要等桥合入并启动应用）；多标签、多对话并行只有单元测试；Windows 上的 `webContents.debugger` 行为未在真机验证。

## 5. 留给用户拍板的四件事（桥的实现者提出）

1. 同一对话再次运行时复用已有标签页，还是每次新开。现状：新开。
2. 收起浏览器面板是否等于结束运行。现状：是，收起即停止。
3. 循环点击页面会把键盘焦点移进页面（否则无法输入），此时用户在消息框里打字会被打断。现状：接受，运行期间步骤条会提示。
4. 浏览页面用独立分区 `persist:mu-browser`，应用里“清除浏览数据”目前不覆盖它。现状：未覆盖，需要在设置里单独给一个清除入口。
