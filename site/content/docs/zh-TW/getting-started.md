---
title: 快速開始
summary: 安裝桌面版或命令列，接上一個模型，跑第一個任務。
---

mu 有兩種用法：內建所需一切的**桌面版**，和 **`mu` 命令列**。兩者共用帳號、設定、工作階段和經驗，在一邊開始的任務可以到另一邊接著做。

## 桌面版 {#desktop-app}

1. 從 [Releases](https://github.com/qybaihe/mu/releases/latest) 下載適合你系統的安裝檔，或者到[首頁](@home#install)，它會替你選好系統。

   | 系統 | 檔案 |
   | --- | --- |
   | macOS，Apple 晶片 | `mu-<version>-mac-arm64.dmg` |
   | macOS，Intel | `mu-<version>-mac-x64.dmg` |
   | Windows x64 / Arm | `mu-<version>-win-x64.exe` / `mu-<version>-win-arm64.exe` |
   | Linux x64 / Arm（Debian、Ubuntu） | `mu-<version>-linux-amd64.deb` / `mu-<version>-linux-arm64.deb` |

   發行頁面上的 `SHA256SUMS` 列出每個檔案的總和檢查碼。macOS 版已簽署，並經過 Apple 公證。Windows 版還沒有程式碼簽署，所以第一次執行時 SmartScreen 會警告：選**其他資訊**，再選**仍要執行**。
2. 開啟它。新手引導分四步：模型、權限模式、判定器、開始。
   - **模型。** 貼上一組 API 金鑰，mu 會從格式認出是哪家服務（DeepSeek、Kimi、Qwen、GLM、SiliconFlow、OpenRouter、OpenAI、Anthropic、Google Gemini、xAI 等），並用一次請求檢查它。也可以用 ChatGPT、Grok 或 Google 訂閱登入。金鑰不對、餘額為零、地區不支援或連不上網路，每一種都會說明該怎麼辦。
   - **權限。** 預設選取「判定模式」；請見[權限與安全](@docs/permissions)。
   - **判定器。** 沒有金鑰時，由免費的 Jev 回答（TypeSafe 託管的判定模型，透過 OpenCode Zen 提供）。之後隨時可以回來修改。
   - **開始。** 如果 mu 找到 Claude Code、Codex 或 ZCode 的對話，會提議幫你匯入（引導的第一個畫面也會提議）。
3. 選一個資料夾，開始對話。

其他什麼都不用裝：不用 Node.js，第一次啟動也不下載任何東西。有新版本時，桌面版會告訴你版本號和大小，你同意後才下載，重新啟動時安裝。

## 命令列 {#command-line}

```bash
npm i -g mu-agent      # Node.js 22.19 或更新版本
mu setup               # 接上一個模型，選擇判定器
mu                     # 在目前目錄開啟一個工作階段
```

`mu setup` 會一步步問你，中文或英文都行。如果跳過它，第一次在沒有模型的情況下執行 `mu` 時，會問一次要不要現在設定。寫指令碼時，`mu setup --help` 列出非互動式的用法；金鑰從標準輸入讀取，從不寫在命令列上。

可以試試這些：

| 指令 | 做什麼 |
| --- | --- |
| `mu "fix the failing test in src/pager.test.ts"` | 帶著一則提示開始 |
| `mu -p "summarize this repository"` | 回答一次就結束 |
| `mu -c` / `mu -r` | 接著上一個工作階段 / 選一個工作階段來恢復 |
| `mu import --list` | 找出可以匯入的 Claude Code、Codex 和 ZCode 對話 |
| `mu doctor` | 檢查安裝、判定器和各項連線 |
| `mu ledger 3` | 最近三個工作階段裡判定器做了哪些決定 |

在工作階段裡，`/status` 顯示判定器、各判定點的模式和最近的判定，`/help` 列出所有指令。完整清單請見[命令列](@docs/cli)頁。

## 你的第一個任務 {#first-task}

開啟一個專案資料夾，用你自己的話說要做什麼。接下來會這樣：

1. **判定器先讀你的訊息**，顯示一行判定，例如「多步任務 · 全力投入」。耗時遠不到一秒；按 <kbd>Esc</kbd> 跳過。
2. **模型開始做事。** 長工具輸出先過濾再交給模型；在「判定模式」下，專案之外的指令要等核准。
3. **它說做完時**，mu 會檢查有沒有東西驗證過這份工作，沒有就提醒一次。

想讓它一直做到某個條件成立，用[目標模式](@docs/goal)：`/goal all tests in packages/api pass`。

## 判定器 {#judge}

mu 把一次工作階段裡的例行問題交給一個小而快的判定模型。你不需要特別設定：沒有 Jev 金鑰時，由 OpenCode Zen 上免費的 Jev 回答，mu 每天提示一次。要用自己的金鑰、本機判定器或別的模型，請見[判定器](@docs/judges)。

{points} 個判定點裡有 {points_active} 個從一開始就依判定結果行事（`context.compact`、`output.drift` 和 `swarm.patch` 預設關閉，`notify.routing` 和 `input.interjection` 預設是影子模式），每次判定都會記錄下來：`/status`、`mu ledger`，或桌面版的「判定」頁。想先觀察判定器、再決定信不信任它，就把判定點設成影子模式：照常提問並記錄，但不改變任何東西。

```json
{ "modes": { "default": "shadow" } }
```

這一行寫在 `~/.mu/agent/mu.json` 裡；`/mu mode default shadow` 效果相同，但只對目前的工作階段有效。

## 檔案放在哪裡 {#files}

| 路徑 | 內容 |
| --- | --- |
| `~/.mu/agent/mu.json` | mu 的設定：判定器、模式、功能 |
| `~/.mu/agent/auth.json`、`models.json`、`settings.json` | pi 的登入、供應商和偏好設定 |
| `~/.mu/agent/sessions/` | 工作階段，桌面版和命令列共用 |
| `~/.mu/agent/mu/lessons.jsonl` | 經驗庫 |
| `~/.mu/agent/mu/permissions.json` | 你上次選的權限模式 |
| `~/.mu/backups/` | `mu setup` 改動檔案之前做的備份 |

在 Windows 上，`~` 是你的使用者資料夾（`%USERPROFILE%`）。
