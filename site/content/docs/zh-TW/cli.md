---
title: 命令列
summary: mu 的指令、工作階段裡的斜線指令，以及原樣來自 pi 的部分。
---

`mu` 指令就是載入了 mu 判定核心的 pi（一個程式設計代理）。pi 能做的一切照常可用；mu 在此之上加了自己的指令和判定點。

```bash
npm i -g mu-agent      # 需要 Node.js 22.19 或更新版本
mu                     # 在目前目錄開啟一個互動式工作階段
```

## 啟動 mu {#starting}

| 指令 | 做什麼 |
| --- | --- |
| `mu` | 在目前目錄開啟一個互動式工作階段 |
| `mu "prompt"` | 互動式工作階段，以這則提示開始 |
| `mu -p "prompt"` | 一次性：印出回答後結束 |
| `mu -c` | 接著上一個工作階段 |
| `mu -r` | 選一個工作階段來恢復 |
| `mu --help` | 代理的所有參數 |

`mu install`、`remove`、`update`、`list` 和 `config` 管理 pi 的套件，和 pi 裡一樣。

## mu 自己的指令 {#commands}

| 指令 | 做什麼 |
| --- | --- |
| `mu setup` | 接上一個模型（一組 API 金鑰，或從清單裡選一個服務），並選擇判定器。`mu setup --help` 列出指令碼用的形式。 |
| `mu doctor` | 檢查安裝、模型、判定器和各項連線，並告訴你要修什麼 |
| `mu ledger [n] [--json]` | 最近 n 個工作階段裡判定器做了哪些決定。`--json` 給出每筆紀錄及其機率和耗時。 |
| `mu import --list` | 找出你的 Claude Code 和 Codex 對話 |
| `mu import <file>…` | 把它們匯入 mu，在這裡接著聊 |
| `mu judge setup \| start \| stop \| status` | 本機判定器 Laya。`setup` 下載模型前會先問你。 |
| `mu link` / `mu unlink` | 把 `mu` 指令放進 PATH（`~/.local/bin`），或移除 |
| `mu auth status \| login <provider> \| logout <provider>` | 訂閱登入，和桌面版用的一樣 |
| `mu migrate [--dry-run]` | 一次性：把改名前的主目錄 `~/.kyrn` 搬到 `~/.mu` |

## 工作階段裡的指令 {#slash-commands}

| 指令 | 做什麼 |
| --- | --- |
| `/status` | 判定器、各判定點的模式、沒放進上下文的內容、最近的判定 |
| `/mu judge <judges>` | 由哪些判定器回答、依什麼順序：`laya`、`laya,jev`、`jev-opencode-free`、`classifier:<provider>/<model>`、`llm:<provider>/<model>` |
| `/mu route <point> <judges>` | 讓某一個判定點用自己的判定器 |
| `/mu mode <point> <off\|shadow\|active>` | 在這個工作階段裡切換某一個判定點，或用 `default` 切換全部 |
| `/frame` | 任務框架：目標、你的約束及你在哪裡說的、驗收項目 |
| `/goal <condition>` | 一直做到條件成立；`/goal clear` 結束 |
| `/permissions` | 完全存取、判定模式或最小權限 |
| `/board` | 為這個專案開啟或關閉人話看板；`/board model` 選擇寫看板的模型 |
| `/remember <text>`、`/lessons`、`/forget <id>` | 記一條經驗、列出經驗、讓一條退役 |
| `/review`、`/commit` | 審查改動，發現依 P0 到 P3 分級；把改動拆成多個提交 |
| `/checkpoints`、`/rewind` | 列出檢查點；退回到某一個（`/rewind undo` 撤銷這次回退） |
| `/agents`、`/swarm` | 委派給子代理；看每一個在做什麼 |
| `/hive <question>` | 針對一個難題發起蜂群 |
| `/browse`、`/jobs` | 內建瀏覽器；背景指令 |
| `/capabilities`、`/ledger` | 裝了哪些能力、開啟了哪些；最近的判定 |
| `/inherit` | 從 Claude Code、Cursor 和 Codex 沿用了什麼，沒沿用什麼 |
| `/import-chat` | 匯入 Claude Code 或 Codex 的對話 |
| `/doctor` | 檢查設定和連線 |

pi 自己的指令原樣保留：`/model`、`/thinking`、`/login`、`/resume`、`/tree`、`/fork`、`/compact`、`/export`、`/mcp` 等等。

## 判定行 {#verdict-line}

一輪開始之前，mu 會稍等一下判定器對你這則訊息的判斷，並把它顯示在輸入框上方，例如「◆ jev-1.13-free  multi-step task · full effort · 699 ms」。按 <kbd>Esc</kbd> 可以不等它直接開始。狀態列顯示權限模式；有目標在執行時，也會顯示這個目標。

## 只對一次執行有效的環境變數 {#env}

| 變數 | 效果 |
| --- | --- |
| `MU_JUDGE=laya,jev mu` | 只為這次執行指定判定器。`MU_JUDGE=off` 關掉判定核心。 |
| `MU_JUDGE_MODE=shadow mu` | 這次執行裡所有判定點都用影子模式 |
| `MU_PERMISSIONS=ask mu` | 這次執行的權限模式：`full`、`judge` 或 `ask` |
| `MU_LANG=zh-CN mu` | mu 自己的訊息用中文（`zh`）或英文（其他任何值） |

完整清單請見[設定](@docs/configuration#env)。
