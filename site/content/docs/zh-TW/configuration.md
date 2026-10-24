---
title: 設定
summary: mu.json、環境變數、網路代理，以及各功能的選項在哪裡。
---

mu 讀取 pi 的設定（模型、登入、偏好）和它自己的設定，後者在 `~/.mu/agent/mu.json` 裡。

只讀取你自己的 `mu.json`。專案不能更改判定器、它的位址或模式，因為判定器會讀你的訊息。

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
    "memory.capture": ["mude", "jev"]
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

| 鍵 | 意義 | 預設 |
| --- | --- | --- |
| `tiers` | 依序回答的判定器。後一個判定器只看到前面幾個拿不準的問題。 | `["jev"]` |
| `modes` | `default` 加上每個判定點一項：`active`、`shadow` 或 `off` | `{ "default": "active" }` |
| `routes` | 讓一個判定點用自己的判定器，取代 `tiers` | 無 |
| `judges` | 你自己命名的判定器；請見[判定器](@docs/judges#custom) | 無 |
| `features` | 各功能的開關和選項：`false` 關掉一個功能，一個物件覆寫其中的選項。所有選項都列在[功能與選項](@docs/options)裡。 | 各功能自己的預設值 |
| `writer` | 一個小模型，格式為 `provider/model`，做判定器做不了的事：寫任務框架和經驗。留空就用工作階段的模型。 | 無 |
| `recordState` | 在帳本裡保存被判定的狀態，而不只是判定結果。訓練你自己的判定器時需要；預設關閉，因為狀態裡有你的內容。 | `false` |
| `mcp` | mu 自己的 MCP 伺服器：`{ "servers": { "<name>": { "command": … } } }`。來自 Claude Code、Cursor 和 Codex 的伺服器也會被找到。 | 無 |

mu 看不懂的部分會退回預設值，而不是讓 mu 停下。完全無法解析的檔案會在工作階段開始時回報，並使用預設值。

## 實際使用中的模式 {#modes}

- {points} 個判定點裡有 {points_active} 個從一開始就生效（`context.compact` 和 `output.drift` 要你自己開啟，`capability.disclosure` 和 `swarm.patch` 預設關閉，`notify.routing` 和 `turn.drift` 預設是影子模式，只記錄判定）。想試一個判定器，或者對某個判定點沒把握，就把它設成影子模式，讀帳本（`mu ledger`、`/status` 或桌面版的「判定」頁），再把它設回生效。
- `/mu mode <point> <off|shadow|active>` 在目前的工作階段裡切換一個判定點；`/mu mode default shadow` 切換全部。想保留一個模式，就寫進 `mu.json`。
- `MU_JUDGE_MODE=shadow mu` 為一次執行設定預設模式。
- `"modes": { "default": "off" }` 完全不問判定器：預設是影子模式的那幾個判定點也一起關閉，除非 `mu.json` 單獨給它設了模式。`mu setup` 裡判定器選「暫時不要」，寫的就是這一項。

## 環境變數 {#env}

判定器和模式：

| 變數 | 效果 |
| --- | --- |
| `MU_JUDGE` | 這次執行用的判定器，以逗號分隔：`jev`、`mude,jev`、`jev-opencode-free`、`classifier:<provider>/<model>`、`llm:<provider>/<model>`。`off` 關掉判定核心。 |
| `MU_JUDGE_MODE` | 這次執行的預設模式：`off`、`shadow` 或 `active` |
| `MU_WRITER` | writer 模型的 `provider/model` |
| `MU_PERMISSIONS` | 這次執行的權限模式：`full`、`judge` 或 `ask` |

雲端判定器的金鑰，每個只送給它自己的服務：`TYPESAFE_API_KEY`、`MU_JUDGE_OPENROUTER_API_KEY`、`AI_GATEWAY_API_KEY`、`OPENCODE_API_KEY`、`CLOUDFLARE_API_KEY` 加 `CLOUDFLARE_ACCOUNT_ID`、`MU_JUDGE_CLM_API_KEY`。

時間：

| 變數 | 效果 |
| --- | --- |
| `MU_TIME_BUDGET_S` | 這次執行的時間預算，單位秒，從 mu 啟動時算起。設了它，只思考的回覆會及時打斷、留出重試的時間，時間用掉 50% 和 80% 時模型會知道還剩幾分鐘（`features.deadline`）。不設就什麼都不變。 |

啟動器：

| 變數 | 效果 |
| --- | --- |
| `MU_AGENT_DIR` | 代理資料夾，取代 `~/.mu/agent` |
| `MU_NO_SETUP=1` | 第一次啟動時從不詢問是否設定模型 |
| `MU_LANG` | 工作階段裡 mu 自己的訊息：`zh…` 用中文，其他用英文。桌面版把它設成應用程式的語言；`mu setup` 跟隨你的系統語言。 |
| `MU_LINK_DIR` | `mu link` 把 `mu` 指令放在哪裡，取代 `~/.local/bin` |
| `MU_CHROME` | 命令列裡內建瀏覽器使用的 Chrome 或 Chromium |

mu 還會讀一個 `.env` 檔案：npm 套件用的是 `~/.mu/.env`。每行是 `KEY=VALUE`；裡面的任何內容都不會被執行。`mu setup` 把 Jev 金鑰寫在那裡。環境裡已經設定的變數優先。

## 網路代理 {#proxies}

mu 遵循 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY`。沒有設定 `HTTPS_PROXY` 時，桌面版還會跟隨系統代理（macOS 的網路設定、Windows 的網際網路設定）。pi 的 `httpProxy` 設定也有效。

## 常改的選項 {#common}

| 設定 | 做什麼 |
| --- | --- |
| `features.admission.testLog` | `"rules"` 摺疊測試日誌裡完全相同的重複；`"jev"` 再加上依目標挑選。預設關閉。 |
| `features.board.defaultOn` | 每個專案一開始就開啟人話看板 |
| `features.permissions.mode` | 你還沒選時，新對話的權限模式 |
| `features.injection.tools` | 哪些工具的結果要做提示注入篩查 |
| `features.continuation.maxNudges` | 每則訊息裡，半路停下的執行最多被送回去幾次 |
| `features.swarm.models` | 子代理可以被分派到的模型梯隊，便宜的在前 |
| `features.goal.checkModel` | 檢查目標是否成立的模型 |

所有功能和選項，以及預設值和取值範圍：[功能與選項](@docs/options)。
