---
title: 疑難排解
summary: mu 啟動不了、連不上模型，或者判定器好像什麼都沒做時，該檢查什麼。
---

先執行 `mu doctor`，或在工作階段裡用 `/doctor`：它檢查安裝、模型、判定器和各項連線，並告訴你要修什麼。在桌面版，日誌在「設定 → 關於」裡，點一下就能開啟。

如果這些都沒用，請[開一個 issue](https://github.com/qybaihe/mu/issues/new/choose)，附上版本、平台和 `mu doctor` 的輸出。

## 安裝和啟動 {#install}

**`mu needs Node >= 22.19 (found v20…)`。** 命令列需要 Node.js 22.19 或更新版本：`nvm install 24`，或者用你系統的套件。桌面版內建 Node.js，什麼都不需要裝。

**Windows 顯示 SmartScreen 警告。** Windows 版還沒有程式碼簽署。選**其他資訊**，再選**仍要執行**。每個下載檔案的總和檢查碼都在發行頁面的 `SHA256SUMS` 裡。

**Windows：對話裡說缺少 Git for Windows。** mu 在 Windows 上用 POSIX shell 執行指令。裝上 [Git for Windows](https://git-scm.com/download/win)，再開一個新對話。

**裝在 `C:\Program Files\mu` 裡的應用程式啟動不了 mu。** 已在 0.1.5 修正：把最新版本裝在舊版本上面即可；你的資料會保留。

**`mu install`、`mu list` 或 `mu config` 反而開了一個工作階段。** 已在 mu-agent 0.1.8 和桌面版 0.1.7 修正，更新到最新版本即可。

## 模型和網路 {#models}

**沒有設定模型。** 執行 `mu setup`，或者用桌面版的新手引導：貼上一組 API 金鑰，或者用訂閱登入。

**桌面版裡出現「User location is not supported」或請求逾時，終端機裡卻正常。** 模型的服務拒絕了你所在網路的地區，或者桌面版沒看到你的網路代理。從 0.1.5 起，沒有設定 `HTTPS_PROXY` 時，桌面版會跟隨系統代理；檢查代理是否開啟，或者為 mu 設定 `HTTPS_PROXY`。

## 判定器 {#judge}

**判定器好像什麼都沒做。** 處於影子模式的判定點只記錄判定，不改變任何東西；關閉的判定點根本不問。`/status` 顯示每個判定點的模式；看看 `~/.mu/agent/mu.json` 裡有沒有 `"default": "shadow"` 或 `"off"`，或者你的環境裡有沒有 `MU_JUDGE_MODE`。

**「還沒有可用的判定器，所以每一步都先問你。」** 在「判定模式」下，沒有判定器能回答時，mu 會對每一個需要審批的步驟都問你：沒有金鑰且免費的 Jev 無法使用、帳戶額度用完，或者只有本機判定器 Laya，而 Laya 不被信任來審批。設定一組 Jev 金鑰（`mu setup`），或者用 `/permissions` 切換模式。

**免費的 Jev 不再回答了。** 它是 OpenCode Zen 的限時活動，結束時 mu 會告訴你。為某個 [Jev 服務](@docs/judges#jev)設定金鑰，或者選另一個判定器。

**判定很慢。** 每個判定點都有時限，逾時後 mu 不等判定繼續往下；不會有什麼卡很久。`mu ledger --json` 顯示每次判定的延遲。慢的或遠的判定器可以用 `routes` 依判定點替換。

**本機判定器要下載模型。** Laya 的模型約 930 MB；只有你同意後，mu 才會在 `mu judge setup` 裡或桌面版裡下載它。

**mude 1.0 沒有回答。** `mu judge mude status` 會顯示它的服務是否在執行，`mu judge mude start` 會啟動它；`mu doctor` 會檢查服務和它的金鑰。在它能回答之前，由排在它後面的判定器回答；如果用了 `--local-only`，每個決策按備援規則處理。

**mude 1.0 安裝中途停了。** 再執行一次 `mu judge mude install`，或在桌面版點**繼續安裝**：會從已經下載的部分接著裝。

## 終端機 {#terminal}

**子代理啟動時，終端機介面崩潰並回報「Rendered line … exceeds terminal width」。** 已在 mu-agent 0.1.8 和桌面版 0.1.7 修正，更新到最新版本即可。

## 從頭開始 {#reset}

`mu setup` 會先把它要改的每個檔案複製到 `~/.mu/backups/<time>/`。要重設 mu 自己的設定，把 `~/.mu/agent/mu.json` 移走；mu 會用預設值啟動。工作階段、登入和經驗是單獨的檔案，都會保留。
