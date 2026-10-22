---
title: 기능과 옵션
summary: 판정 커널의 모든 기능, 기본으로 켜져 있는지, 해당 판정 지점, 그리고 옵션마다의 기본값과 범위.
---

기능은 각각 `~/.mu/agent/mu.json`의 `features.<name>` 아래에서 설정해요. `false`는 기능을 끄고, `true`는 기본값으로 켜고, 객체는 개별 옵션을 덮어써요.

```json
{
  "features": {
    "injection": { "tools": ["web_fetch", "mcp__*"] },
    "board": { "defaultOn": true },
    "ttsr": false
  }
}
```

데스크톱 앱의 설정도 같은 파일에 쓰고, 이 페이지와 같은 이름과 설명을 써요. 둘 다 저장소의 매니페스트 하나에서 나와요.
