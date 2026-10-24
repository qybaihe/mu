---
title: 判定器
summary: 谁来回答判定点，怎样选择、串联和比较判定器，以及每个判定器的成本。
---

## 由哪个判定器回答 {#tiers}

`~/.mu/agent/mu.json` 里的 `tiers` 按顺序列出判定器。后一个判定器只看到前面几个拿不准的问题，所以可以让便宜的本地判定器先答，云端的判定器接住剩下的：

```json
{ "tiers": ["laya", "jev"] }
```

`routes` 让一个判定点用自己的判定器：

```json
{ "routes": { "browser.step": ["jev"], "memory.capture": ["llm:anthropic/claude-haiku-4-5"] } }
```

在会话里，`/mu judge <judges>` 和 `/mu route <point> <judges|default>` 做同样的事；`MU_JUDGE=laya,jev mu` 只为一次运行指定判定器。`/status` 显示哪个判定器回答什么，桌面端的「判定器」页也能设置这些。

没有判定器按时回答时，每个判定点就照没有判定时那样做（通常是什么都不变），流水里记下原因。

## mude 1.0（在你的 Mac 上） {#mude}

mude 1.0 是 mu 自己的决策模型，针对编程场景优化：20 亿参数，一次前向计算就答完一个决策的所有问题。在 Apple 芯片的 Mac 上（macOS 14 及以上，内存 8 GB 及以上），它是推荐的判定器：`mu setup` 把它列在第一位，桌面端首次启动引导一开始就选中它。

```bash
mu judge mude install               # 下载（1.8 GB）、逐个校验文件、启动并设为判定器
mu judge mude enable --local-only   # 只用 mude：什么都不发给云端判定器
mu judge mude status
```

默认情况下，你之前的判定器留在 `tiers` 里 mude 的后面：mude 答不了的问题（它的服务没在运行，或者它拿不准），以及 mude 还不被信任的两项注入检查，都交给它们。加上 `--local-only`，mude 就是唯一的判定器，它答不了的决策按兜底规则处理。mude 每次回答约 0.1 秒，它读到的内容不出你的 Mac。它的服务运行时约占 4 GB 内存；配置里有 mude 时，mu 会在会话开始前启动它。安装中途停下（Ctrl-C、断网、断电），下次会从中断的地方接着装。在其他平台上，可以用[完整模型](https://huggingface.co/qybaihe/mude-1.0)自带的 System One 服务部署它，再按模型卡的说明把它作为 `typesafe` 判定器加进来。

### 其他决策模型 {#models}

`mu judge model` 用同样的方式添加 Hugging Face 上的其他决策模型：粘贴链接或 `owner/name` 即可。mu 会固定提交版本和每个文件的哈希，带进度、可续传地下载模型，在 mude 的 Python 环境里运行它，并把它设为判定器。模型须按 mude 1.0 MLX 版的方式打包，自带 `d3_server_mac.py`，这段代码会在你的 Mac 上运行，所以只添加你信任的模型。

```bash
mu judge model add https://huggingface.co/owner/name   # 也可以写 owner/name@revision；再运行一次即可续传
mu judge model list                                    # mude 1.0 和你添加的模型
mu judge model use mude                                # 切回 mude 1.0，或切到另一个模型
mu judge model remove name
```

同一时间只运行一个决策模型：切换时会停掉另一个的服务器。桌面 App 的「设置 → 判定器」里，mude 1.0 下面有同样的功能。

## Jev（云端） {#jev}

Jev 是 TypeSafe 做的判定模型，专门回答这类问题。内置的 `jev` 判定器通过第一个设置了密钥的服务调用它：

| 顺序 | 服务 | 密钥 | 内置名称 |
| --- | --- | --- | --- |
| 1 | TypeSafe | `TYPESAFE_API_KEY` | `jev-direct` |
| 2 | OpenRouter（只给 Jev 用的密钥） | `MU_JUDGE_OPENROUTER_API_KEY` | `jev-openrouter` |
| 3 | Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `jev-gateway` |
| 4 | OpenCode Zen | `OPENCODE_API_KEY` | `jev-opencode` |
| 5 | Cloudflare Workers AI | `CLOUDFLARE_API_KEY` 和 `CLOUDFLARE_ACCOUNT_ID` | `jev-cloudflare` |
| 都没设置 | OpenCode Zen，限时免费 | 不需要密钥 | `jev-opencode-free` |

密钥只会发给它所属的服务。直接指定一条线路，比如 `"tiers": ["jev-openrouter"]`，就会跳过这个顺序。`mu setup` 或桌面端的「判定器」页会替你写好密钥。

**免费的 Jev。** 一个密钥都没有时，由 OpenCode Zen 上的 Jev 1.13 回答。它判定的内容会发给 OpenCode，OpenCode 不拿这些内容训练模型；mu 每天提示一次。这是 OpenCode 的限时活动：活动结束时 mu 会告诉你，各判定点退回没有判定器时的做法，直到你设置一个密钥。`mu setup --judge free` 明确选用它。

**速度和成本。** 在作者自己的会话里实测：热连接上一个问题约 0.3 秒；16 块工具输出在一个请求里判完用 0.44 秒，状态只计费一次。会话在用时，每 50 秒问一个很小的问题让连接保持热的，所以一轮开始前的提问能省掉 1 到 3 秒的建连。

## OpenAI 的决策模型 {#openai}

内置的 `openai` 判定器通过 OpenAI 的 [Decisions API](https://developers.openai.com/api/docs/guides/decisions)（`POST /v1/decisions`）向 `gpt-6-luna` 提问，用 OpenAI 的 API 密钥。它的密钥是 `MU_JUDGE_OPENAI_KEY`；没有设置时，用 mu 已经为 `openai` 提供商保存的 OpenAI API 密钥（来自 `mu setup`、`/login` 或 `OPENAI_API_KEY`），用 ChatGPT 登录的不算。`mu setup --judge openai` 或桌面端的「判定器」页可以设置它，也可以写进 `mu.json`：

```json
{ "tiers": ["openai"] }
```

OpenAI 按未命中缓存的输入 token 收费，每百万 0.10 美元，输出不收费。还没有在 mu 的问题上测过。

要通过 Azure 资源或中转服务访问它，给它一个 `baseUrl` 和它自己的密钥。mu 的 `openai` 提供商的密钥只会发给 `api.openai.com`：

```json
{ "judges": { "azure": { "type": "openai", "baseUrl": "https://example.openai.azure.com/openai/v1", "apiKeyEnv": "MU_JUDGE_AZURE_KEY" } } }
```

## Laya（本地） {#laya}

一个 3.22 亿参数的判定器，在你的机器上运行，从不连网。

```bash
mu judge setup     # 下载模型前会先问你
mu judge start     # 启动它
mu judge status
```

Laya 在简单谓词上可靠（这段文字是不是在描述一个错误？），在关于关系或关于请求本身的问题上偏弱。mu 知道这一点，从不把它答不好的问题交给它，所以在 `["laya", "jev"]` 这样的链里，这些问题直接交给下一个判定器。在「判定模式」下，审批不交给 Laya。先让它以影子模式和你当前的判定器并行跑，看过流水，再把某个判定点单独交给它。

## 分类模型和大模型 {#other-judges}

- **`classifier:<provider>/<model>`**：pi 模型目录里的任何分类模型，用你已有的该提供商的登录或密钥访问。Cloudflare 的 Clef 内置为 `clef` 和 `clef-flash`；OpenRouter 和 Vercel AI Gateway 上的 System One 模型，以及 llama.cpp 的分类模型，也都能用。
- **`llm:<provider>/<model>`**：任何聊天模型，要求它以 JSON 回答。更慢，每次判定都花 token，但除了你已经在用的模型之外什么都不需要。`mu setup --judge model` 把会话的模型设为判定器。
- **`clm`**：跑在 `clm-serve` 后面的 CLM-8B（默认 `http://127.0.0.1:8700`）。还没有在 mu 的问题上测过。

## 你自己的判定器 {#custom}

在 `mu.json` 的 `judges` 下，给一个名字和一个类型：

```json
{
  "judges": {
    "relay": { "type": "typesafe", "baseUrl": "https://relay.example.com/v1/systemone", "apiKeyEnv": "RELAY_KEY" },
    "lab": { "type": "http", "baseUrl": "http://10.0.0.5:9000", "path": "/evaluate", "apiKeyEnv": "LAB_KEY" },
    "fast": { "type": "llm", "model": "anthropic/claude-haiku-4-5", "thinking": "off", "timeoutMs": 4000 }
  },
  "tiers": ["relay", "jev"]
}
```

| 类型 | 连接的对象 |
| --- | --- |
| `typesafe` | 任何在 `baseUrl` 上讲 TypeSafe System One 协议的服务 |
| `http` | 任何接收 `{ state, questions }`、返回 `{ answers }` 的端点 |
| `llm` | pi 模型注册表里的一个聊天模型 |
| `classifier` | pi 模型目录里的一个分类模型 |
| `local` | 一个兼容 Laya 的本地服务器 |
| `clm` | 一个 `clm-serve` |
| `openai` | `baseUrl` 处的 OpenAI Decisions API，默认是 OpenAI 自己的 |

密钥从不写进文件：`apiKeyEnv` 写的是存放密钥的环境变量名，这个变量设在你的环境里，或 mu 的 `.env` 里。

## 模式：生效、影子、关闭 {#modes}

每个判定点都有一个模式：

- **active**（生效，默认）：判定结果起作用。
- **shadow**（影子）：照常问判定器并记录判定，但不改变任何东西。
- **off**（关闭）：不问这个判定点。

可以在 `mu.json` 的 `modes` 下设置（一个 `default`，加上每个判定点一项），用 `/mu mode` 只对一个会话设置，或者在桌面端的设置里设置，那里处于影子模式的判定点显示为关闭。有两样东西不管模式如何都起作用：你选的权限模式（选「判定模式」本身就是对 `tool.approval` 的同意），以及模型主动调用的 `judge_items` 工具。

## 比较判定器 {#compare}

1. 把判定点设成影子模式，并把它路由到你想试的判定器；或者让所有判定点都以影子模式运行。
2. 照常工作一段时间。
3. 读判定结果：`mu ledger [n]` 打印最近 n 个会话，`mu ledger --json` 给出每条记录及其概率和耗时，桌面端的「判定」页显示每次判定和它的问题。
4. 判定结果看起来对了，就把这个判定点切回生效。

`"recordState": true` 还会把被判定的状态存进流水，训练你自己的判定器时需要它。默认关闭，因为这些状态里有你的内容。
