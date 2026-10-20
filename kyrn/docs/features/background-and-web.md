# 后台命令、网页读取、国内可用的搜索

日期：2026-09-22。对应路线图第 1 节的“后台命令”和“网页读取 + 国内能用的搜索”两包。代码在 `packages/kyrn-judge/src/background/`、`src/web/`，功能入口是 `src/extension/features/background.ts` 和 `web.ts`。五个工具都是底线能力（能力目录 `exposure: "always"`，id 为 `tool:background`、`tool:web`），所以工具定义写得很短：每个字都要在每次请求里付一遍。

## 1. 后台命令

pi 故意不做后台 shell，mu 补上。三个工具：

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `bg_start` | `command`，可选 `name`、`cwd`、`watch` | 立即返回任务 id（`bg-1`…），不占用回合 |
| `bg_output` | 可选 `id`、`since`、`wait_for`、`timeout` | 只返回上次读取之后的新输出和状态；不给 `id` 就列出全部任务；给 `wait_for`（正则）或 `timeout` 时阻塞到“出现匹配行 / 任务结束 / 超时 / 被中断”，模型不用循环轮询 |
| `bg_stop` | `id` | 结束任务以及它启动的所有进程 |

另有 `/jobs`、`/jobs stop <id|all>`，终端状态栏显示运行中的任务数。

做法和理由：

- **同一个 shell。** 复用 pi 的 `getShellConfig` / `getPowerShellConfig`（`/bin/bash`、Windows 上的 Git Bash、从 stdin 取命令的旧版 WSL 启动器），并读取 `settings.json` 的 `shellPath`、`shellCommandPrefix`（项目级设置只在项目受信任时生效：仓库不能指定要运行的二进制）。Windows 上只有当 `powershell` 是唯一启用的 shell 工具时才用 PowerShell，并带上 pi 的 UTF-8 前缀。环境变量与前台一致（agent 的 `bin` 目录排在 PATH 最前）。
- **输出两份。** 环形缓冲（默认 262144 字符，只留最新，去掉颜色码，回车换成换行）给模型读；日志文件留全部原始字节，默认在 `~/.mu/jobs/<会话 id>/bg-N.log`，单个日志 50 MB 封顶，7 天前的会话目录在下次启动任务时清掉。`since` 早于缓冲起点时，结果里写明丢了多少字符、日志在哪。
- **杀的是进程树。** POSIX 上 shell 以 `detached` 启动，自成进程组：先向整组发 SIGTERM，`killGraceMs`（默认 3 秒）后还活着就 SIGKILL。Windows 上是 `taskkill /T /PID`，之后 `taskkill /T /F /PID`，用 `System32` 下的绝对路径。命令里自己写了 `&` 的情况（`server & echo ok`：shell 退出了，子进程还在组里）会标成 `lingering`，`bg_stop` 和会话结束时照样清理。
- **不会悄悄活过会话。** `session_shutdown`（退出、reload、新建、恢复、分叉）时全部终止；不是退出的情况下会告诉用户停了几个。进程不经 `session_shutdown` 直接退出时，`process.on("exit")` 里同步 SIGKILL 兜底。
- **风险闸门一视同仁。** `guard.ts` 现在检查 `bash` 和 `bg_start` 两个工具的 `command`：危险命令不会因为放到后台就变安全。约束闸门（`constraints.ts`）的 `MUTATING` 里本来就有 `bg_start`，工具名保持不变。
- **准入控制一视同仁。** `bg_output` 的结果在 `details.command` 里带着任务的命令，`admission.ts` 用它来描述这次调用。于是后台跑的 `vitest` 长日志同样走测试日志策略（`testLog: "rules" | "jev"`），其他长输出走分块分类。输出前有一行“不可信数据”的标注。
- **并发上限** `maxJobs`（默认 8）。超过时报错并列出正在运行的任务。

### 决策点：沿用 `notify.routing`，没有新增

任务结束，或者打印了一行匹配 `watch` 的输出，而模型此刻并没有在 `bg_output` 里等它——这是一条“对话之外的事件”，交给已有的 `notify.routing`（问题原文未改，版本仍是 1）：

> When does the agent working on `goal` need to hear about `event`?（now / next_turn / drop / other）

- `now`：作为 steer 消息插进当前回合；`next_turn`：随下一条用户消息送达；`drop`：不说。
- 送给判定器的 `event` 只有一行事实（任务 id、命令、退出码、时长），不含输出。送给模型的消息同样只有事实加“用 `bg_output` 读”；`watch` 命中时附上那一行（截到 300 字符，标明不可信）。
- 两种情况不通知：任务是模型或用户自己停的；任务结束时模型正阻塞在这个任务的 `bg_output` 里。
- `watch` 命中一次后解除，模型读过输出再重新生效，所以一个 `error` 正则不会刷屏。

为此对路由器做了最小扩展（`notify.ts`，通过 `runtime.notify` 暴露）：调用方可以给出 `content`（模型读到的文字）、`unjudged`（没有判定时怎么办）、`wake`。预算提醒保持原样：没有判定就不说。后台任务传 `unjudged: "next_turn"`：判定关闭、shadow 或判定器不可用时，下一回合告诉模型，永不打断。这是“没有判定器时的确定性行为”。

### 选项（`features.background`）

`maxJobs` 8 · `bufferChars` 262144 · `maxOutputChars` 20000（单次 `bg_output` 返回上限，留最新）· `killGraceMs` 3000 · `logDir` 空 · `inheritShell` true · `wakeWhenIdle` false。

`wakeWhenIdle`：代理空闲时任务结束，默认只把通知追加到对话里，不开新回合；打开后，判定为 `now` 时会唤醒代理继续干活（Claude Code 的做法）。默认关，是因为用户不在场时自动花 token 需要用户自己点头。

## 2. `web_fetch`

`web_fetch(url, max_length?)`：一次 GET，读成文字。

- 只接受 http/https；URL 里带 `user:password@` 的拒绝；不发 cookie；浏览器样式的 User-Agent。
- 手动跟随重定向（默认最多 5 次），整个过程一个总时限（20 秒），响应体流式读取，到 `maxBytes`（2 MB）就停；gzip / deflate / br 自己解。不是文本的类型（图片、压缩包）只描述、不下载。
- **SSRF。** 每一跳都解析地址并分类，检查放在连接实际使用的 `lookup` 里，所以不存在“检查时一个地址、连接时另一个地址”的空档；一个域名只要有一条记录落在内网就整体拒绝。私网（10/8、172.16/12、192.168/16、100.64/10、fc00::/7）、链路本地（含 169.254.169.254）、保留地址、`0.0.0.0` 默认拒绝；`::ffff:a.b.c.d`、NAT64 按里面的 IPv4 判断。
- **localhost 的取舍。** 默认允许，但必须“指名道姓”：起始 URL 和每一跳都得是 `localhost`、`*.localhost` 或回环地址字面量。理由：编码代理读 `http://localhost:3000` 是正当需求（后台命令起了开发服务器，下一步就是读它），而且模型本来就能用 `bash curl` 做到；真正的攻击路径是“外部网页把读取器引到本机”，所以从外部地址重定向到本机、以及解析到 127.0.0.1 的公共域名，一律拒绝。`allowLoopback: false` 可以整个关掉，`allowPrivate: true` 才放行内网。
- **198.18.0.0/15 视为公网。** 这是 Clash / mihomo / Surge 的 fake-IP 默认网段。国内很多用户开着这类隧道，此时所有域名都解析到这个网段，拒绝它等于拒绝整个互联网。这个网段不指向任何内部服务。
- **编码。** 依次看响应头、BOM、`<meta charset>` / `http-equiv`、XML 声明，用 `TextDecoder` 解码（GBK、GB2312、GB18030、Big5 都在 WHATWG 标签里），认不出就按 UTF-8。
- **HTML 转文字，零依赖。** 容错的标签扫描器建一棵轻量树；丢掉 script、style、noscript、template、svg、nav、footer、aside、form、iframe、button、select 和隐藏元素（`hidden`、`aria-hidden`、`display:none`：隐藏文字是提示注入最常见的藏身处）；保留标题、`#` 级标题、段落、列表（含嵌套）、代码块、表格（每行 `| a | b |`）、引用、图片的 alt。有 `<main>` / `role=main` / `<article>` 且占正文四成以上就只取它。链接只在正文里写成 `文字 (网址)`；`<header>` 和“几乎全是链接的盒子”（≥5 个链接且链接文字占七成：侧边栏、菜单，很多站点并不写 `<nav>`）只留文字。JSON 和纯文本原样返回。
- 页面文字很少而脚本很多时，明说“这个页面要跑脚本，请用 `browse`”。
- 结果第一行是标题，第二行是最终地址和事实（状态码、类型、编码、字节数、重定向次数），然后是与 `browse` **同一句**不可信标注（从 `browser.ts` 导出的 `UNTRUSTED`），再是正文，超出 `max_length` 时写明截到哪。

## 3. `web_search`

`web_search(query, count?)`：返回标题、网址（拆掉跟踪跳转）、摘要，整体标为不可信。

### 搜索源调查（2026-09-22，本机，实测）

测试网络经过一层 fake-IP 代理，Google、DuckDuckGo 在这里是通的，所以这些结果不能代表国内直连的情况。以下都是脚本请求（curl 和 Node），浏览器 UA，无 cookie：

| 源 | 结果 |
| --- | --- |
| 必应中国 `cn.bing.com/search?q=`（带和不带 `ensearch=1`，HTML 和 `format=rss`，带 cookie、换请求头、IPv4、HTTP/1.1、直连 202.89.233.101 都试过，20 多次） | **每次都是 200，结构完好，但结果与查询无关**：“vitest mock fetch example”得到 Subway、UPS；“TextDecoder gbk nodejs”得到苏黎世动物园、韩剧；同一查询两次结果不同。不带 `ensearch` 时有时只按第一个词返回。SearXNG 的 bing 引擎源码里有同样的记录（`cc` 为 cn/us/ru 时 “bing just sends junk”） |
| 百度 `www.baidu.com/s?wd=` | 立即 302 到 `wappass.baidu.com/static/captcha`（“百度安全验证”） |
| 搜狗 `www.sogou.com/web?query=` | 结果切题（博客园、CSDN、掘金）；链接是 `/link?url=` 跳转，但真实地址在条目内的 `data-url` 属性里，可以离线还原 |
| 360 `www.so.com/s?q=` | 结果切题；真实地址直接在 `data-mdurl` 属性里；约 1 秒 |

结论：预期的赢家（必应中国）没有通过验证。**默认源定为 360（`so`）**，备选 `sogou`、`bing-cn`，以及 `searxng:<地址>` 或任意带 `{query}` 的网址（先按 SearXNG 的 JSON 读，不是 JSON 就按“带链接的 h2/h3 标题 + 后面的文字”读）。用户自己配置的源允许在本机或内网。

因为必应返回的是“看起来正常的无关结果”而不是验证页，加了一道**相关性检查**：把查询拆成词（去停用词，中文按二字组），结果的标题、摘要、网址里命中的不同词少于 2 个（查询只有一个词时 1 个）就视为诱饵结果。验证页（按最终地址和页面文字识别）、空页、HTTP 错误、诱饵结果都会让下一个内置源接手（`searchFallback`，默认开），并把原因写进结果；全部失败时给出可读的错误，建议换源或用 `browse`。

360 的结果偏中文社区（CSDN、掘金、博客园），英文技术查询很少出现 Stack Overflow、MDN、GitHub。这是现在的真实质量，不是解析问题。

### Tavily（有密钥时）

设置了环境变量 `TAVILY_API_KEY`（也可以写在 `.env` 里）时，`web_search` 先问 Tavily（`POST https://api.tavily.com/search`，`Authorization: Bearer <key>`，`search_depth: "basic"`），上面这些源作为后备：401（密钥无效）、429（限流）、432（套餐额度用完）、5xx 都记为 HTTP 错误，接着问下一个源。`features.web.search` 设为 `tavily` 而没有密钥时，记一条“TAVILY_API_KEY is not set”并改用内置源；设为 `tavily` 且 `searchFallback: false` 时只问 Tavily。Tavily 的结果不做诱饵检查（有密钥的 API 不会给机器人返回诱饵，而且中文查询可能得到切题的英文结果）。

`web_fetch` 在本机读不到（超时、连接被重置等网络错误）或读不出（403、429、451、5xx，或页面要跑脚本才有文字）时，若有密钥，改用 Tavily 的 `/extract`（`extract_depth: "basic"`，`format: "markdown"`）读同一个网址，结果第一行写明“read through Tavily”。被地址策略拒绝的网址、localhost、内网字面地址、用户中断，以及开了 `allowPrivate` 时，一律不交给 Tavily。

密钥每次调用时从环境读取，只放在请求头里，不出现在结果、展示事件或错误信息中（传输错误里若带了密钥会先替换掉）。

### 选项（`features.web`）

`search` "so" · `searchFallback` true · `maxChars` 20000 · `timeoutMs` 20000 · `maxBytes` 2000000 · `maxRedirects` 5 · `allowLoopback` true · `allowPrivate` false。

## 4. 展示事件

`background.start` / `background.exit`（退出码、时长、谁停的、是否有残留进程）/ `background.stop` / `background.match`，供桌面端做任务条；`web.fetch`（地址、主机、状态、类型、字节数、字符数，或拒绝原因）/ `web.search`（查询、应答的源、结果数、被跳过的源及原因）。载荷里没有命令输出，也没有网页内容；命令本身（截到 200 字符）会出现，因为任务条要显示它。

## 5. 验证情况

已验证（macOS，Node 24，全部离线，不依赖网络）：

- `test/background.test.ts` 26 个：环形缓冲边界；颜色码和 `\r\n` 被分块切断；按平台参数化的 shell 选择、命令传递（argv / stdin）、PATH、kill 步骤（POSIX 信号到负 pid，Windows 的 `taskkill` 参数）；`shellPath` 只在受信任项目里取项目级设置；真实子进程的启动、游标、退出码、等待匹配 / 超时 / 中断、**含子进程的进程树被杀干净**、忽略 SIGTERM 的进程先礼后兵（SIGTERM → SIGKILL，退出码 137）、Windows 顺序（用注入的 kill 记录 `/T /PID` → `/T /F /PID`）、`lingering`、并发上限、shell 启动失败（127）、缓冲溢出后日志完整、`watch` 每次读取只报一次、`shutdown` 和兜底清理、旧日志清理；经完整会话：`bg_start` 被风险闸门拦下（命令没有执行）、`notify.routing` 的三种结果（now 插进当前回合、next_turn 随下一条消息、drop 不说）加 shadow 模式（下一回合）、后台 vitest 长日志走测试日志规则（省 30% 以上）、`session_shutdown` 后进程消失、展示事件不含输出。
- `test/web-fetch.test.ts` 16 个：地址分类表（含映射地址、NAT64、fake-IP 段）；scheme / 凭据 / 字面地址（含十进制、十六进制写法）拒绝；解析器的每个答案都被检查（混合记录拒绝）；localhost 规则；本地 `http.createServer`：重定向跟随与上限、重定向到私网 / 元数据地址 / 解析到内网的域名 / `file:` 均拒绝、体积上限、总时限、中断、GBK 页面（手写内容、真实 GBK 字节的 fixture，靠 `<meta>` 识别）、GBK / Big5 响应头、gzip JSON、图片只描述不下载、404、UA 且无 cookie、需要脚本的页面；HTML 转文字的各项保留与丢弃、隐藏的注入文字被丢弃、坏标记、链接盒子。
- `test/web-search.test.ts` 14 个：必应（HTML 与 RSS）、360、搜狗、通用 / SearXNG 解析器，跟踪跳转还原，验证页，相关性检查（用实测到的诱饵结果），源的回退顺序和原因；经完整会话：读本机开发服务器、截断、重定向到内网被拒、`allowLoopback: false`、用本地假 SearXNG 搜索、全部失败时的报错。
- `test/manifest.test.ts`、`extension.test.ts`、`features.test.ts`、`admission*.test.ts`、`browser.test.ts`、`catalog.test.ts` 通过；`npm run check` 通过。
- **一次真实联网检查**（经由上述代理网络）：`web_fetch` 的读取器读 `https://www.runoob.com/nodejs/nodejs-process.html`：200，132908 字节，187 毫秒，标题“Node.js 多进程 | 菜鸟教程”，24922 字符文字；`web_search` 默认链查 “vitest mock fetch example”：360 应答，941 毫秒，6 条结果，5 条切题（CSDN 的 Vitest mock 文章），1 条是 360 翻译的小组件（之后已在解析器里过滤 `*.so.com` 小组件，并给链接盒子去掉网址；这两处修改只有离线测试，没有再联网）。

没有验证：

- **没有在 Windows 和 WSL 上运行过。** `taskkill` 的参数拼装、PowerShell 前缀、Git Bash / 旧版 WSL 启动器的命令传递只有按平台参数化的单元测试。Windows 没有进程组，shell 退出后遗留的孙进程 `taskkill /T` 找不到（`lingering` 只在 POSIX 上能发现）；旧版 WSL 的 `bash.exe` 被杀后 Linux 侧子进程是否跟着退出，未知。
- **没有在“不开隧道的国内直连网络”上测过任何搜索源**，包括必应。上表只说明这台机器上的情况。必应的诱饵结果是它对脚本客户端的反应还是对隧道出口 IP 的反应，没有分清。
- 解析器的 fixture 是照着观察到的标记手写的，不是保存的真实页面（不提交抓取的页面）。搜索引擎改版会让对应解析器失效；失效时表现为“没有结果”，自动换下一个源。
- `wait_for` / `watch` 的正则来自模型，限制了长度（300）和被匹配的行长（2000），但没有超时：病态正则仍可能卡住事件循环。
- 没有用真实模型跑过这五个工具，不知道模型会不会按预期用 `wait_for` 而不是轮询（`monitor` 的重复调用提醒会兜一层）。
- `bg_output` 截断按字符数留最新，不保证从行首开始。
- 桌面端还没有消费这些展示事件。

## 6. 需要你拍板的事

1. **默认搜索源用 360 而不是必应中国。** 依据是上面的实测。如果你在不开隧道的网络上确认必应正常，把 `features.web.search` 改成 `bing-cn` 即可（相关性检查会在它再次返回诱饵时自动换源）。长期看，质量最好的方案是自建 SearXNG（`searxng:http://localhost:8888`）或者让 `browse` 用真实浏览器去搜。
2. **localhost 默认允许。** 协调者后来的指示是“回环地址默认拒绝、用选项放开”，原始需求是“localhost 默认允许并说明理由”。现在的实现取了更严的中间方案（必须指名 localhost，外部重定向一律拒绝）。要改成默认拒绝，只需把 `web.ts` 里的 `allowLoopback: true` 改成 `false`（同时改 `manifest.ts` 的默认值）。
3. **`wakeWhenIdle` 默认关。** 打开后，后台任务结束可以唤醒空闲的代理继续工作。
4. 日志放在 `~/.mu/jobs`（协调者的指示），不是系统临时目录（原始需求）。7 天清理。
