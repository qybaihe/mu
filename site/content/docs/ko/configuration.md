---
title: 설정
summary: mu.json, 환경 변수, 프록시, 그리고 기능별 옵션이 있는 곳.
---

mu는 pi의 설정(모델, 로그인, 환경설정)과 자체 설정 `~/.mu/agent/mu.json`을 읽어요. 데스크톱 앱의 설정도 같은 파일에 써요. 거기서 바꿀 수 있는 것은 모두 손으로도 바꿀 수 있고, 반대도 마찬가지예요.

여러분 자신의 `mu.json`만 읽어요. 판정기는 여러분의 메시지를 읽기 때문에, 프로젝트가 판정기나 그 주소, 모드를 바꿀 수는 없어요.

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

| 키 | 의미 | 기본값 |
| --- | --- | --- |
| `tiers` | 답하는 판정기, 순서대로. 뒤의 판정기는 앞의 판정기들이 확신하지 못한 것만 받아요. | `["jev"]` |
| `modes` | `default`와 판정 지점별 항목: `active`, `shadow`, `off` | `{ "default": "active" }` |
| `routes` | `tiers` 대신 따로 판정기를 쓰는 판정 지점 | 없음 |
| `judges` | 직접 이름 붙인 판정기. [판정기](@docs/judges#custom)를 보세요 | 없음 |
| `features` | 기능별 스위치와 옵션: `false`는 기능을 끄고, 객체는 옵션을 덮어써요. 모든 옵션은 [기능과 옵션](@docs/options)에 있어요. | 기능마다의 기본값 |
| `writer` | 판정기가 할 수 없는 일, 즉 작업 프레임과 교훈을 글로 쓰는 작은 모델, `provider/model` 형식. 비우면 세션의 모델을 써요. | 없음 |
| `recordState` | 판정만이 아니라 판정한 상태도 판정 장부에 남기기. 직접 판정기를 학습시키려면 필요해요. 상태에는 여러분의 내용이 들어 있어서 꺼져 있어요. | `false` |
| `mcp` | mu 자체의 MCP 서버: `{ "servers": { "<name>": { "command": … } } }`. Claude Code, Cursor, Codex의 서버도 찾아요. | 없음 |

mu가 이해하지 못하는 부분은 mu를 멈추지 않고 기본값으로 돌아가요. 아예 파싱할 수 없는 파일은 세션이 시작될 때 알려 주고, 기본값을 써요.

## 모드 실제로 쓰기 {#modes}

- 판정 지점 {points}개 중 {points_active}개는 처음부터 판정을 반영해요(`context.compact`와 `output.drift`는 기본으로 꺼져 있고, `swarm.patch`도 꺼져 있으며, `notify.routing`, `input.interjection`, `turn.drift`는 섀도라서 판정을 기록만 해요). 판정기나 확신이 없는 판정 지점을 시험하려면 섀도로 두고, 판정 장부(`mu ledger`, `/status`, 앱의 판정 탭)를 읽은 다음, 다시 active로 돌려요.
- `/mu mode <point> <off|shadow|active>`는 현재 세션에서 판정 지점 하나를 바꾸고, `/mu mode default shadow`는 전부를 바꿔요. 모드를 계속 유지하려면 `mu.json`에 넣으세요.
- `MU_JUDGE_MODE=shadow mu`는 한 번 실행의 기본 모드를 정해요.

## 환경 변수 {#env}

판정기와 모드:

| 변수 | 효과 |
| --- | --- |
| `MU_JUDGE` | 이번 실행의 판정기, 쉼표로 구분: `laya`, `laya,jev`, `jev-opencode-free`, `classifier:<provider>/<model>`, `llm:<provider>/<model>`. `off`는 커널을 꺼요. |
| `MU_JUDGE_MODE` | 이번 실행의 기본 모드: `off`, `shadow`, `active` |
| `MU_WRITER` | 글쓰기 모델의 `provider/model` |
| `MU_PERMISSIONS` | 이번 실행의 권한 모드: `full`, `judge`, `ask` |
| `MU_LOCAL_JUDGE_URL` | `mu judge start`가 띄우는 서버가 아닌 다른 로컬 판정기 서버의 주소 |

호스팅 판정기의 키(각각 자기 서비스로만 보내져요): `TYPESAFE_API_KEY`, `MU_JUDGE_OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, `OPENCODE_API_KEY`, `CLOUDFLARE_API_KEY`와 `CLOUDFLARE_ACCOUNT_ID`, `MU_JUDGE_CLM_API_KEY`.

런처:

| 변수 | 효과 |
| --- | --- |
| `MU_AGENT_DIR` | `~/.mu/agent` 대신 쓸 에이전트 폴더 |
| `MU_NO_SETUP=1` | 처음 시작할 때 모델 설정을 절대 묻지 않기 |
| `MU_LANG` | 세션 안에서 mu 자체 메시지의 언어: `zh…`면 중국어, 그 밖에는 영어. 데스크톱 앱은 앱의 언어로 설정하고, `mu setup`은 여러분의 로캘을 따라요. |
| `MU_LINK_DIR` | `~/.local/bin` 대신 `mu link`가 `mu` 명령을 둘 곳 |
| `MU_CHROME` | 명령줄에서 내장 브라우저가 쓸 Chrome이나 Chromium |

`MU_` 변수는 모두 예전 철자인 `KYRN_`으로도 읽어요.

mu는 `.env` 파일도 읽어요. npm 패키지는 `~/.mu/.env`예요. 줄은 `KEY=VALUE` 형식이고, 그 안의 어떤 것도 실행하지 않아요. `mu setup`은 Jev 키를 여기에 써요. 여러분의 환경에 이미 설정된 변수가 우선해요.

## 프록시 {#proxies}

mu는 `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`를 따라요. 데스크톱 앱은 `HTTPS_PROXY`가 설정되어 있지 않으면 시스템 프록시(macOS 네트워크 설정, Windows 인터넷 설정)도 따라요. pi의 `httpProxy` 설정도 동작해요.

## 자주 바꾸는 옵션 {#common}

| 설정 | 하는 일 |
| --- | --- |
| `features.admission.testLog` | `"rules"`는 테스트 로그의 완전히 같은 반복을 접고, `"jev"`는 목표에 따른 선별을 더해요. 기본값은 꺼짐이에요. |
| `features.board.defaultOn` | 모든 프로젝트를 쉬운 말 보드가 켜진 상태로 시작 |
| `features.permissions.mode` | 여러분이 고르기 전, 새 대화의 권한 모드 |
| `features.injection.tools` | 결과를 프롬프트 인젝션 검사에 거칠 도구 |
| `features.continuation.maxNudges` | 중간에 멈춘 실행을 메시지마다 몇 번 돌려보낼지 |
| `features.swarm.models` | 서브 에이전트를 배정할 수 있는 모델 등급, 값싼 것부터 |
| `features.goal.checkModel` | 목표가 충족됐는지 확인하는 모델 |

모든 기능과 옵션, 기본값과 범위: [기능과 옵션](@docs/options).
