---
title: 判定器
summary: 由誰回答判定點，怎樣選擇、串接和比較判定器，以及每個判定器的成本。
---

## 由哪個判定器回答 {#tiers}

`~/.mu/agent/mu.json` 裡的 `tiers` 依序列出判定器。後一個判定器只看到前面幾個拿不準的問題，所以可以讓便宜的本機判定器先答，雲端的判定器接住剩下的：

```json
{ "tiers": ["mude", "jev"] }
```

`routes` 讓一個判定點用自己的判定器：

```json
{ "routes": { "browser.step": ["jev"], "memory.capture": ["llm:anthropic/claude-haiku-4-5"] } }
```

在工作階段裡，`/mu judge <judges>` 和 `/mu route <point> <judges|default>` 做同樣的事；`MU_JUDGE=mude,jev mu` 只為一次執行指定判定器。`/status` 顯示哪個判定器回答什麼，桌面版的「判定器」頁也能設定這些。

沒有判定器按時回答時，每個判定點就照沒有判定時那樣做（通常是什麼都不變），帳本裡記下原因。

## mude 1.0（在你的 Mac 上） {#mude}

mude 1.0 是 mu 自己的決策模型，針對程式設計場景最佳化：20 億參數，一次前向計算就答完一個決策的所有問題。在 Apple 晶片的 Mac 上（macOS 14 以上，記憶體 8 GB 以上），它是推薦的判定器：`mu setup` 把它列在第一位，桌面版首次啟動引導一開始就選中它。

```bash
mu judge mude install               # 下載（1.8 GB）、逐一校驗檔案、啟動並設為判定器
mu judge mude enable --local-only   # 只用 mude：什麼都不傳給雲端判定器
mu judge mude status
```

預設情況下，你之前的判定器留在 `tiers` 裡 mude 的後面：mude 答不了的問題（它的服務沒在執行，或者它拿不準），以及 mude 還不被信任的兩項注入檢查，都交給它們。加上 `--local-only`，mude 就是唯一的判定器，它答不了的決策按備援規則處理。mude 每次回答約 0.1 秒，它讀到的內容不離開你的 Mac。它的服務執行時約占用 4 GB 記憶體；設定裡有 mude 時，mu 會在工作階段開始前啟動它。安裝中途停下（Ctrl-C、斷網、斷電），下次會從中斷的地方接著裝。在其他平台上，可以用[完整模型](https://huggingface.co/qybaihe/mude-1.0)附帶的 System One 服務部署它，再依模型卡的說明把它作為 `typesafe` 判定器加進來。

### 其他決策模型 {#models}

`mu judge model` 用同樣的方式新增 Hugging Face 上的其他決策模型：貼上連結或 `owner/name` 即可。mu 會固定提交版本和每個檔案的雜湊，帶進度、可續傳地下載模型，在 mude 的 Python 環境裡執行它，並把它設為判定器。模型須以 mude 1.0 MLX 版的方式打包，自帶 `d3_server_mac.py`，這段程式碼會在你的 Mac 上執行，所以只新增你信任的模型。

```bash
mu judge model add https://huggingface.co/owner/name   # 也可以寫 owner/name@revision；再執行一次即可續傳
mu judge model list                                    # mude 1.0 和你新增的模型
mu judge model use mude                                # 切回 mude 1.0，或切到另一個模型
mu judge model remove name
```

同一時間只執行一個決策模型：切換時會停掉另一個的伺服器。桌面 App 的「設定 → 判定器」裡，mude 1.0 下面有同樣的功能。

## Jev（雲端） {#jev}

Jev 是 TypeSafe 做的判定模型，專門回答這類問題。內建的 `jev` 判定器透過第一個設定了金鑰的服務呼叫它：

| 順序 | 服務 | 金鑰 | 內建名稱 |
| --- | --- | --- | --- |
| 1 | TypeSafe | `TYPESAFE_API_KEY` | `jev-direct` |
| 2 | OpenRouter（只給 Jev 用的金鑰） | `MU_JUDGE_OPENROUTER_API_KEY` | `jev-openrouter` |
| 3 | Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `jev-gateway` |
| 4 | OpenCode Zen | `OPENCODE_API_KEY` | `jev-opencode` |
| 5 | Cloudflare Workers AI | `CLOUDFLARE_API_KEY` 和 `CLOUDFLARE_ACCOUNT_ID` | `jev-cloudflare` |
| 都沒設定 | OpenCode Zen，限時免費 | 不需要金鑰 | `jev-opencode-free` |

金鑰只會送給它所屬的服務。直接指定一條線路，例如 `"tiers": ["jev-openrouter"]`，就會跳過這個順序。`mu setup` 或桌面版的「判定器」頁會替你寫好金鑰。

**免費的 Jev。** 一組金鑰都沒有時，由 OpenCode Zen 上的 Jev 1.13 回答。它判定的內容會送給 OpenCode，OpenCode 不拿這些內容訓練模型；mu 每天提示一次。這是 OpenCode 的限時活動：活動結束時 mu 會告訴你，各判定點退回沒有判定器時的做法，直到你設定一組金鑰。`mu setup --judge free` 明確選用它。

**速度和成本。** 在作者自己的工作階段裡實測：熱連線上一個問題約 0.3 秒；16 塊工具輸出在一個請求裡判完用 0.44 秒，狀態只計費一次。工作階段使用中時，每 50 秒問一個很小的問題讓連線保持熱的，所以一輪開始前的提問能省掉 1 到 3 秒的連線建立時間。

## OpenAI 的決策模型 {#openai}

內建的 `openai` 判定器透過 OpenAI 的 [Decisions API](https://developers.openai.com/api/docs/guides/decisions)（`POST /v1/decisions`）向 `gpt-6-luna` 提問，使用 OpenAI 的 API 金鑰。它的金鑰是 `MU_JUDGE_OPENAI_KEY`；沒有設定時，使用 mu 已經為 `openai` 提供者保存的 OpenAI API 金鑰（來自 `mu setup`、`/login` 或 `OPENAI_API_KEY`），用 ChatGPT 登入的不算。`mu setup --judge openai` 或桌面端的「判定器」頁可以設定它，也可以寫進 `mu.json`：

```json
{ "tiers": ["openai"] }
```

OpenAI 依未命中快取的輸入 token 收費，每百萬 0.10 美元，輸出不收費。還沒有在 mu 的問題上測過。

要透過提供同一 Decisions 端點的中繼服務或代理存取它，給它一個 `baseUrl` 和它自己的金鑰。mu 的 `openai` 提供者的金鑰只會送到 `api.openai.com`：

```json
{ "judges": { "relay": { "type": "openai", "baseUrl": "https://relay.example.com/v1", "apiKeyEnv": "MU_JUDGE_RELAY_KEY" } } }
```

## 設定裡還寫著 Laya {#laya}

Laya 是 mu 在 0.2.4 及以前內建的第三方本機判定器，現在已不再內建。`mu.json` 裡還寫著它（在 `tiers` 裡、某個 `routes` 裡，或是一個 `local` 類型的判定器）也照常能用：這台 Mac 上裝好了 mude 1.0，就由 mude 1.0 取代它；否則由清單裡剩下的判定器回答，一個都不剩就用 Jev。mu 只改一次 `mu.json`，只動這幾項，舊檔案在 `~/.mu/backups` 裡留一份，並告訴你換成了哪個判定器。`MU_JUDGE=laya` 會被略過。想在本機用別的決策模型，可以[從 Hugging Face 新增](@docs/judges#models)。

## 分類模型和大模型 {#other-judges}

- **`classifier:<provider>/<model>`**：pi 模型目錄裡的任何分類模型，用你已有的該供應商的登入或金鑰存取。Cloudflare 的 Clef 內建為 `clef` 和 `clef-flash`；OpenRouter 和 Vercel AI Gateway 上的 System One 模型，以及 llama.cpp 的分類模型，也都能用。
- **`llm:<provider>/<model>`**：任何聊天模型，要求它以 JSON 回答。比較慢，每次判定都花 token，但除了你已經在用的模型之外什麼都不需要。`mu setup --judge model` 把工作階段的模型設為判定器。
- **`clm`**：跑在 `clm-serve` 後面的 CLM-8B（預設 `http://127.0.0.1:8700`）。還沒有在 mu 的問題上測過。

## 你自己的判定器 {#custom}

在 `mu.json` 的 `judges` 下，給一個名稱和一個類型：

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

| 類型 | 連接到什麼 |
| --- | --- |
| `typesafe` | 任何在 `baseUrl` 上使用 TypeSafe System One 協定的服務 |
| `http` | 任何接收 `{ state, questions }`、回傳 `{ answers }` 的端點 |
| `llm` | pi 模型註冊表裡的一個聊天模型 |
| `classifier` | pi 模型目錄裡的一個分類模型 |
| `clm` | 一個 `clm-serve` |
| `openai` | `baseUrl` 處的 OpenAI Decisions API，預設是 OpenAI 自己的 |

金鑰從不寫進檔案：`apiKeyEnv` 寫的是存放金鑰的環境變數名稱，這個變數設在你的環境裡，或 mu 的 `.env` 裡。

## 模式：生效、影子、關閉 {#modes}

每個判定點都有一個模式：

- **active**（生效，預設）：判定結果起作用。
- **shadow**（影子）：照常問判定器並記錄判定，但不改變任何東西。
- **off**（關閉）：不問這個判定點。

可以在 `mu.json` 的 `modes` 下設定（一個 `default`，加上每個判定點一項），用 `/mu mode` 只對一個工作階段設定，或者在桌面版的設定裡設定，那裡處於影子模式的判定點顯示為關閉。有兩樣東西不管模式如何都起作用：你選的權限模式（選「判定模式」本身就是對 `tool.approval` 的同意），以及模型主動呼叫的 `judge_items` 工具。

## 比較判定器 {#compare}

1. 把判定點設成影子模式，並把它路由到你想試的判定器；或者讓所有判定點都以影子模式執行。
2. 照常工作一段時間。
3. 讀判定結果：`mu ledger [n]` 印出最近 n 個工作階段，`mu ledger --json` 給出每筆紀錄及其機率和耗時，桌面版的「判定」頁顯示每次判定和它的問題。
4. 判定結果看起來對了，就把這個判定點切回生效。

`"recordState": true` 還會把被判定的狀態存進帳本，訓練你自己的判定器時需要它。預設關閉，因為這些狀態裡有你的內容。
