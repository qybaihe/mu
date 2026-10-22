---
title: 功能与选项
summary: 判定内核的每个功能：是否默认开启、它的判定点，以及每个选项的默认值和取值范围。
---

每个功能在 `~/.mu/agent/mu.json` 的 `features.<name>` 下配置。`false` 关掉一个功能，`true` 用默认值打开它，一个对象则覆盖单个选项：

```json
{
  "features": {
    "injection": { "tools": ["web_fetch", "mcp__*"] },
    "board": { "defaultOn": true },
    "ttsr": false
  }
}
```

桌面端的设置写的是同一个文件，名称和说明也和这一页相同。两者都来自仓库里的同一份清单。
