---
title: 功能與選項
summary: 判定核心的每個功能：是否預設開啟、它的判定點，以及每個選項的預設值和取值範圍。
---

每個功能在 `~/.mu/agent/mu.json` 的 `features.<name>` 下設定。`false` 關掉一個功能，`true` 用預設值開啟它，一個物件則覆寫單個選項：

```json
{
  "features": {
    "injection": { "tools": ["web_fetch", "mcp__*"] },
    "board": { "defaultOn": true },
    "ttsr": false
  }
}
```

桌面版的設定寫的是同一個檔案，名稱和說明也和這一頁相同。兩者都來自儲存庫裡的同一份清單。
