# 用 Google 账号登录（`googleLogin`，实验）

更新日期：2026-09-22。状态：harness 一侧已完成并测试（19 个用例）。**没有用真实的 Google 账号登录过，也没有对 Google 的真实接口发过请求。** 桌面端的登录界面还没做（见第 7 节）。

## 1. 为什么做，风险是什么

- 用户希望用 Google 账号直接用 Gemini（比如 Gemini 3.8 Flash，人话看板写字用得上），也要把 Antigravity 的登录写好。
- 上游 pi 在 2026-04-30（提交 `fe66edd94`）删掉了 Gemini CLI 和 Antigravity 的 OAuth。这两个登录用的是 Google 给自家工具注册的客户端；别的程序借来用，Google 可能认为违反条款，账号可能被限制或封禁。
- 用户 2026-09-22 同意支持。mu 把它们作为**实验**功能加回来：名字里都带 “(experimental)”；**登录前先显示风险说明**，选 “I understand the risk, sign in” 才继续，选 Cancel 就结束，不开浏览器、不起本地回调服务、不发任何请求。

## 2. 用 Google 模型的四种方式

| 方式 | 提供商 | mu 要做什么 |
| --- | --- | --- |
| Gemini API key（AI Studio） | `google` | 不用做：pi 自带。设 `GEMINI_API_KEY`，或 `/login` 里填 key |
| Vertex AI（gcloud 登录） | `google-vertex` | 不用做：pi 自带。`gcloud auth application-default login`，再在 `/login` 里填项目和区域（或设 `GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`） |
| Gemini CLI 的登录（实验） | `google-gemini-cli` | 本功能 |
| Antigravity 的登录（实验） | `google-antigravity` | 本功能 |

前两种是官方方式，没有封号风险，推荐优先用。

Grok 的登录（SuperGrok / X Premium，提供商 `xai`）是 pi 自带的，终端里 `/login` 就有 “Sign in with SuperGrok or X Premium”，用设备码登录，mu 这边不用写代码。

## 3. 怎么用

1. `/login`，选 “Google Gemini CLI (experimental)” 或 “Google Antigravity (experimental)”。
2. 读风险说明，同意后浏览器打开 Google 登录页。
3. 登录完浏览器跳回本机（Gemini CLI 用端口 8085，Antigravity 用 51121，这是 Google 登记这两个客户端时定死的）。浏览器在另一台机器上时，把浏览器最后停在的地址整个粘贴回 mu 就行。
4. `/model` 选模型。

端口被占用（比如 Gemini CLI 自己正在登录）时会直接说明，关掉占用的程序再试。

**项目**：请求记在一个 Google Cloud 项目上。

- Gemini CLI：账号已有 Code Assist 项目就用它；个人账号第一次用，走免费档，由 Google 自动开一个；工作区账号或付费档要自己设 `GOOGLE_CLOUD_PROJECT`，没设时登录会说明。
- Antigravity：用账号已有的项目，没有时用 Antigravity 客户端自己的默认项目。

项目和令牌一起存在凭据里；令牌过期前自动刷新，刷新不会丢项目。

## 4. 有哪些模型

- **Gemini CLI**：就是 Google 自己的 Gemini 目录（API key 看到的那份），去掉不是对话用的（图像、实时语音、电脑操作、研究代理、`latest` 别名、Gemma）。现在是 12 个：2.5 Flash / Flash-Lite / Pro，3 Flash Preview，3.1 Flash Lite（含 Preview），3.1 Pro Preview，3.5 Flash / Flash Lite，3.6 Flash，3.7 Flash，3.8 Flash。思考等级沿用目录里的设置。费用显示为 0（免费档或许可）。
- **Antigravity**：先有 pi 删掉时它提供的 9 个（Claude Opus 4.5 / 4.6 Thinking，Claude Sonnet 4.5（含 Thinking）/ 4.6，Gemini 3 Flash，Gemini 3.1 Pro High / Low，GPT-OSS 120B Medium），费用是同一模型的 API 价格，只作参考。**登录后**会问 Antigravity 这个账号现在能用哪些（`v1internal:fetchAvailableModels`），新出现的模型按家族给默认上限：Claude 20 万上下文、Gemini 约 105 万、GPT-OSS 13 万；它说了上下文（`maxTokens`）、输出上限、是否支持图片 / 思考的，按它说的。标成 `disabled` 的、或 id 以 `-disabled` 结尾的占位条目不列（这个账号用不了）。问不到时保留上一次的列表。已经登录的账号，终端和桌面端每次开会话时会在后台再问一次（每个进程一次，20 秒超时，失败不提示；print / JSON 模式和设了 `PI_OFFLINE` 时不问），所以不用重新登录就能拿到新模型。

  **客户端身份决定能看到哪些模型（2026-10-24 用真实付费账号核实）。** 同一个账号、同一个令牌，只改 `User-Agent`：

  | User-Agent | 列出的模型 | `gemini-4-argon-medium` 生成 |
  | --- | --- | --- |
  | `antigravity/1.107.0 darwin/arm64`（以前用的，IDE） | 20 个，没有 Gemini 4 Argon，也没有 Gemini 3.8 Flash 的分档 | 404 |
  | `antigravity/3.0.0 darwin/arm64` 到 `99.0.0`（IDE） | 多出 `gemini-3.8-flash-low/medium/high`，仍没有 Argon | — |
  | `antigravity/cli/1.2.4`（命令行） | 同上，没有 Argon | — |
  | `antigravity/cli/1.4.0`（命令行，现在用的） | 26 个，多出 `gemini-4-argon-low/medium/high`（显示名 “Gemini 4 Argon (Low/Medium/High)”，上下文 1,048,576，输出 65,536） | 200，`modelVersion: gemini-4-argon` |

  这和 Google 的文档一致：Gemini 4 Argon 不在 Antigravity IDE 里，只在 Antigravity 应用、命令行和 IDE 扩展里，而且只给直接付费的 Google AI Pro（非试用）、Ultra 和 Enterprise。用命令行的身份时，Claude Sonnet / Opus 5.5、Gemini 3 Flash、GPT-OSS 120B 照常可用（同一天逐个验证过）。Gemini 4 只按等级思考（low / medium / high），不能关，没有 minimal。

## 5. 实现

代码在 `packages/kyrn-judge/src/google-login/`：

| 文件 | 内容 |
| --- | --- |
| `oauth.ts` | 两个登录：风险确认 → PKCE → 本地回调（或粘贴地址）→ 换令牌（必须拿到 refresh token）→ 邮箱 → 项目。按 pi 现在的 `OAuthAuth` 接口写，取消统一报 “Login cancelled”（pi 的界面对这句不报错） |
| `cloud-code.ts` | Cloud Code Assist 的流式调用，从 pi 删掉前的实现移植到今天的 transcript 和共用的 Google 消息转换上。**第一次请求时才加载**（Google 的消息转换会带上 Google SDK） |
| `providers.ts` | 两个提供商、模型目录、Antigravity 的模型列表查询 |
| `endpoints.ts` | 地址和常量，让提供商不必加载流式调用的代码 |

功能 `googleLogin`（`src/extension/features/google-login.ts`）用 `pi.registerProvider` 注册这两个提供商，`/login` 自然就列出它们。

请求：`POST {endpoint}/v1internal:streamGenerateContent?alt=sse`，内容是 `{ project, model, request, userAgent, requestId }`，回来的每个事件是 `{ response: {...} }`。

- 403 / 404：马上换下一个地址（Antigravity 有三个：daily、autopush、正式）。
- 429 / 5xx：按服务器说的时间等（`retry-after`、“reset after 1m2s”、“Please retry in 2s”、`retryDelay`），最多重试 3 次；服务器要等的比 `maxRetryDelayMs`（默认 60 秒）还久，就直接报出来，不干等。
- 其它错误（比如 400）不重试。
- 回答是空的：再问两次。
- Antigravity 特有：以 Antigravity 命令行的身份请求，`User-Agent: antigravity/cli/1.4.0`（Google 提高最低版本时用 `MU_ANTIGRAVITY_VERSION` 改）、`requestType: "agent"`、它要求的系统提示放在最前、Claude 的工具用旧的 `parameters` 写法、Claude 思考模型带 `anthropic-beta: interleaved-thinking-2025-05-14`。
- 思考：Gemini 3 及以后按等级（`thinkingLevel`），Gemini 2.5 和 Claude 按预算（1024 / 2048 / 8192 / 16384，塞在输出上限里）；关掉思考时，Gemini 3 Pro 这类关不掉的用最低等级，且不显示思考内容。

## 6. 设置（`features.googleLogin.*`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `geminiCli` | `true` | `/login` 里有 Gemini CLI 的登录 |
| `antigravity` | `true` | `/login` 里有 Antigravity 的登录 |

`features.googleLogin: false` 两个都去掉。注册提供商本身不发请求；只有你登录、或登录后刷新模型列表时才会联系 Google。

## 7. 给桌面端

pi 的 RPC 模式**没有登录命令**，扩展拿到的 `modelRegistry` 也不能登录。桌面端要登录，得在进程内调用 pi 的 `ModelRuntime.login(providerId, "oauth", interaction)`（原生宿主），或者另加一条桥。`interaction` 要处理：

- `prompt({ type: "select" })`：风险确认，选项 id 是 `continue` / `cancel`，返回选中的 id；
- `notify({ type: "auth_url", url })`：用系统浏览器打开；
- `prompt({ type: "manual_code" })`：粘贴地址的输入框（浏览器回调成功时它会被取消，`signal` 会触发）；
- `notify({ type: "progress" })`：进度文字。

Grok（`xai`）用设备码：`notify({ type: "device_code", userCode, verificationUri })`，显示验证码并打开验证页即可。

## 8. 验证

`test/google-login.test.ts`，19 个用例，全部在本机假服务器上跑，不连 Google：

- 登录：拒绝风险说明时不开浏览器、不起回调、不发请求、端口仍空着；浏览器回调登录（别的页面先打到回调端口、state 不对时被拒掉，登录照常继续；授权地址的 client_id / 回调地址 / S256 / offline / scope，PKCE 的 challenge 与 verifier 对得上，换令牌的每个字段，凭据带项目和邮箱，过期时间提前 5 分钟，粘贴框被取消，回调服务关掉）；粘贴地址登录；伪造 state 被拒；Gemini CLI 免费档自动开项目、付费档没设项目时报错；Antigravity 找不到项目时用默认项目；刷新保留项目和没轮换的 refresh token；请求用的 key 带令牌和项目。
- 流式：思考、正文、工具调用和用量都读对；Gemini CLI 与 Antigravity 的请求格式（头、系统提示、`requestType`、Claude 的 `parameters`、`anthropic-beta`）；403 换地址；400 不重试；要等太久时直接报；空回答再问；没登录或凭据不全时不发请求；四种思考设置；地址顺序和等待时间的解析。
- 提供商：Gemini CLI 的模型筛选；Antigravity 模型列表的解析（已知模型保留已知的，新的按家族，非对话模型去掉，格式不对时为空）；只有登录后才去问，第一个地址失败换下一个。
- 通过 pi：两个登录出现在 pi 的提供商里，`ModelRuntime.login` 在风险确认选 cancel 时结束；存好的凭据经过 pi 的鉴权变成请求里的令牌和项目；关掉一项后它不再出现。

做过变异检查：去掉风险确认、去掉回调和粘贴时的 state 检查、刷新时丢项目、去掉 403 换地址、不重试空回答、Claude 不用 `parameters`、不筛模型，都有用例失败。另外在 tsx 加根 `tsconfig.json`（`mu` 的真实启动方式）下加载过这些模块，路径都能解析。

未验证：真实的 Google 登录和接口（特别是 `fetchAvailableModels` 的回答格式，是按 CLIProxyAPI 的读法写的，并做了防御）；Windows；桌面端。
