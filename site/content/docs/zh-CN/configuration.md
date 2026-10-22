---
title: 配置
summary: mu.json、环境变量、网络代理，以及各功能的选项在哪里。
---

mu 读取 pi 的设置（模型、登录、偏好）和它自己的设置，后者在 `~/.mu/agent/mu.json` 里。桌面端的设置写的也是这个文件：在那里做的每一处改动都可以手动做，反过来也一样。

只读取你自己的 `mu.json`。项目不能更改判定器、它的地址或模式，因为判定器会读你的消息。

## mu.json {#mu-json}

```json
{
  "tiers": ["jev"],
  "modes": {
    "default": "active",
    "turn.continue": "shadow",
    "output.drift": "off"
  },
  "routes": {
    "browser.step": ["jev"],
    "memory.capture": ["laya", "jev"]
  },
  "features": {
    "admission": { "testLog": "rules" },
    "board": { "defaultOn": true },
    "ttsr": false
  },
  "writer": "anthropic/claude-haiku-4-5",
  "recordState": false
}
```

| 键 | 含义 | 默认 |
| --- | --- | --- |
| `tiers` | 按顺序回答的判定器。后一个判定器只看到前面几个拿不准的问题。 | `["jev"]` |
| `modes` | `default` 加上每个判定点一项：`active`、`shadow` 或 `off` | `{ "default": "active" }` |
| `routes` | 让一个判定点用自己的判定器，代替 `tiers` | 无 |
| `judges` | 你自己命名的判定器；见[判定器](@docs/judges#custom) | 无 |
| `features` | 各功能的开关和选项：`false` 关掉一个功能，一个对象覆盖其中的选项。所有选项都列在[功能与选项](@docs/options)里。 | 各功能自己的默认值 |
| `writer` | 一个小模型，写作 `provider/model`，做判定器做不了的事：写任务帧和经验。留空就用会话的模型。 | 无 |
| `recordState` | 在流水里保存被判定的状态，而不只是判定结果。训练你自己的判定器时需要；默认关闭，因为状态里有你的内容。 | `false` |
| `mcp` | mu 自己的 MCP 服务器：`{ "servers": { "<name>": { "command": … } } }`。来自 Claude Code、Cursor 和 Codex 的服务器也会被找到。 | 无 |

mu 看不懂的部分会退回默认值，而不是让 mu 停下。完全无法解析的文件会在会话开始时报告，并使用默认值。

## 实际使用中的模式 {#modes}

- {points} 个判定点里有 {points_active} 个从一开始就生效（`context.compact` 和 `output.drift` 要你自己打开，`swarm.patch` 默认关闭，`notify.routing`、`input.interjection` 和 `turn.drift` 默认是影子模式）。想试一个判定器，或者对某个判定点没把握，就把它设成影子模式，读流水（`mu ledger`、`/status` 或桌面端的「判定」页），再把它设回生效。
- `/mu mode <point> <off|shadow|active>` 在当前会话里切换一个判定点；`/mu mode default shadow` 切换全部。想保留一个模式，就写进 `mu.json`。
- `MU_JUDGE_MODE=shadow mu` 为一次运行设置默认模式。

## 环境变量 {#env}

判定器和模式：

| 变量 | 效果 |
| --- | --- |
| `MU_JUDGE` | 这次运行用的判定器，用逗号分隔：`laya`、`laya,jev`、`jev-opencode-free`、`classifier:<provider>/<model>`、`llm:<provider>/<model>`。`off` 关掉判定内核。 |
| `MU_JUDGE_MODE` | 这次运行的默认模式：`off`、`shadow` 或 `active` |
| `MU_WRITER` | 写作模型的 `provider/model` |
| `MU_PERMISSIONS` | 这次运行的权限模式：`full`、`judge` 或 `ask` |
| `MU_LOCAL_JUDGE_URL` | 本地判定器服务器的地址，用于 `mu judge start` 启动的那个之外的服务器 |

托管判定器的密钥，每个只发给它自己的服务：`TYPESAFE_API_KEY`、`MU_JUDGE_OPENROUTER_API_KEY`、`AI_GATEWAY_API_KEY`、`OPENCODE_API_KEY`、`CLOUDFLARE_API_KEY` 加 `CLOUDFLARE_ACCOUNT_ID`、`MU_JUDGE_CLM_API_KEY`。

启动器：

| 变量 | 效果 |
| --- | --- |
| `MU_AGENT_DIR` | 代理文件夹，代替 `~/.mu/agent` |
| `MU_NO_SETUP=1` | 第一次启动时从不询问设置模型 |
| `MU_LANG` | 会话里 mu 自己的消息：`zh…` 用中文，其他用英文。桌面端把它设成应用的语言；`mu setup` 跟随你的系统语言。 |
| `MU_LINK_DIR` | `mu link` 把 `mu` 命令放在哪里，代替 `~/.local/bin` |
| `MU_CHROME` | 命令行里内置浏览器使用的 Chrome 或 Chromium |

每个 `MU_` 变量也认它以前的 `KYRN_` 写法。

mu 还会读一个 `.env` 文件：npm 包用的是 `~/.mu/.env`。每行是 `KEY=VALUE`；里面的任何内容都不会被执行。`mu setup` 把 Jev 密钥写在那里。环境里已经设置的变量优先。

## 网络代理 {#proxies}

mu 遵循 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY`。没有设置 `HTTPS_PROXY` 时，桌面端还会跟随系统代理（macOS 的网络设置、Windows 的 Internet 设置）。pi 的 `httpProxy` 设置也有效。

## 常改的选项 {#common}

| 设置 | 做什么 |
| --- | --- |
| `features.admission.testLog` | `"rules"` 折叠测试日志里完全相同的重复；`"jev"` 再加上按目标挑选。默认关闭。 |
| `features.board.defaultOn` | 每个项目一开始就打开人话看板 |
| `features.permissions.mode` | 你还没选时，新对话的权限模式 |
| `features.injection.tools` | 哪些工具的结果要做提示注入筛查 |
| `features.continuation.maxNudges` | 每条消息里，半路停下的运行最多被送回去几次 |
| `features.swarm.models` | 子代理可以被分派到的模型档位，便宜的在前 |
| `features.goal.checkModel` | 检查目标是否成立的模型 |

所有功能和选项，以及默认值和取值范围：[功能与选项](@docs/options)。
