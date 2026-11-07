---
title: Features and options
summary: Every feature of the judgment kernel, whether it is on by default, its decision points and each option with its default and range.
---

Each feature is configured under `features.<name>` in `~/.mu/agent/mu.json`. `false` turns a feature off, `true` turns it on with its defaults, and an object overrides single options:

```json
{
  "features": {
    "injection": { "tools": ["web_fetch", "mcp__*"] },
    "board": { "defaultOn": true },
    "ttsr": false
  }
}
```
