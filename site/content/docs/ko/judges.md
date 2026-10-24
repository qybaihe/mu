---
title: 판정기
summary: 판정 지점에 누가 답하는지, 판정기를 고르고 잇고 비교하는 방법, 그리고 각각의 비용.
---

## 누가 답하는가 {#tiers}

`~/.mu/agent/mu.json`의 `tiers`는 판정기를 순서대로 나열해요. 뒤의 판정기는 앞의 판정기들이 확신하지 못한 질문만 받아요. 그래서 값싼 로컬 판정기가 먼저 답하고, 클라우드 판정기가 나머지를 받을 수 있어요.

```json
{ "tiers": ["laya", "jev"] }
```

`routes`는 판정 지점 하나에 따로 판정기를 지정해요.

```json
{ "routes": { "browser.step": ["jev"], "memory.capture": ["llm:anthropic/claude-haiku-4-5"] } }
```

세션 안에서는 `/mu judge <judges>`와 `/mu route <point> <judges|default>`가 같은 일을 하고, `MU_JUDGE=laya,jev mu`는 한 번 실행에서 쓸 판정기를 정해요. `/status`는 어떤 판정기가 무엇에 답하는지 보여 주고, 앱의 판정기 페이지에서도 같은 것을 설정해요.

판정기가 제시간에 답하지 못하면 판정 지점마다 판정이 없을 때 하던 대로 하고(대개는 아무것도 바뀌지 않아요), 판정 장부에 그 이유가 남아요.

## mude 1.0, 여러분의 Mac에서 {#mude}

mude 1.0은 코딩에 최적화된 mu의 자체 의사결정 모델이에요. 파라미터는 2B이고, 한 결정의 모든 질문에 한 번의 순전파로 답해요. Apple 실리콘 Mac(macOS 14 이상, 메모리 8GB 이상)에서는 추천 판정기예요. `mu setup`은 mude를 맨 앞에 보여 주고, 데스크톱 앱 첫 실행 가이드도 처음부터 mude를 선택해 둬요.

```bash
mu judge mude install               # 내려받기(1.8GB), 모든 파일 검증, 시작하고 판정기로 지정
mu judge mude enable --local-only   # mude만: 클라우드 판정기에는 아무것도 보내지 않음
mu judge mude status
```

기본적으로 전에 쓰던 판정기는 `tiers`에서 mude 뒤에 남아요. mude가 답하지 못하는 질문(서버가 멈춰 있거나 확신이 없을 때)과, 아직 mude에 맡기지 않는 두 가지 인젝션 검사는 그 판정기가 답해요. `--local-only`면 mude가 유일한 판정기가 되고, 답하지 못하는 결정은 폴백을 따라요. mude는 한 번 답하는 데 약 0.1초 걸리고, mude가 읽은 내용은 Mac 밖으로 나가지 않아요. 서버는 실행 중에 메모리를 약 4GB 쓰고, 설정에 mude가 있으면 mu가 세션 전에 시작해요. 중간에 멈춘 설치(Ctrl-C, 연결 끊김, 정전)는 다음에 멈춘 곳부터 이어져요. 다른 플랫폼에서는 [전체 모델](https://huggingface.co/qybaihe/mude-1.0)을 함께 제공되는 System One 서버로 띄우고, 모델 카드대로 `typesafe` 판정기로 추가하세요.

## Jev, 클라우드 {#jev}

Jev는 TypeSafe가 만든 판정 모델로, 바로 이런 질문을 위해 만들어졌어요. 내장 `jev` 판정기는 키가 설정된 첫 번째 서비스를 통해 Jev에 닿아요.

| 순서 | 서비스 | 키 | 내장 이름 |
| --- | --- | --- | --- |
| 1 | TypeSafe | `TYPESAFE_API_KEY` | `jev-direct` |
| 2 | OpenRouter(Jev 전용 키) | `MU_JUDGE_OPENROUTER_API_KEY` | `jev-openrouter` |
| 3 | Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `jev-gateway` |
| 4 | OpenCode Zen | `OPENCODE_API_KEY` | `jev-opencode` |
| 5 | Cloudflare Workers AI | `CLOUDFLARE_API_KEY`와 `CLOUDFLARE_ACCOUNT_ID` | `jev-cloudflare` |
| 설정 없음 | OpenCode Zen, 기간 한정 무료 | 키 없음 | `jev-opencode-free` |

키는 그 키의 서비스로만 보내져요. 순서를 건너뛰려면 `"tiers": ["jev-openrouter"]`처럼 경로를 직접 지정하세요. `mu setup`이나 앱의 판정기 페이지가 키를 대신 써 줘요.

**무료 Jev.** 키가 하나도 없으면 OpenCode Zen의 Jev 1.13이 답해요. 판정하는 내용은 OpenCode로 가지만 모델 학습에는 쓰이지 않고, mu가 하루에 한 번 그 사실을 알려 줘요. 이건 OpenCode의 기간 한정 제공이에요. 제공이 끝나면 mu가 알려 주고, 키를 설정할 때까지 판정 지점들은 폴백으로 동작해요. `mu setup --judge free`로 명시적으로 고를 수 있어요.

**속도와 비용.** 만든 사람들의 실제 세션에서 잰 값이에요. 웜 연결에서 질문 하나에 약 0.3초, 도구 출력 16청크를 요청 하나로 판정하는 데 0.44초가 걸렸고, 상태는 한 번만 과금됐어요. 세션을 쓰는 동안에는 50초마다 아주 작은 질문 하나로 연결을 웜 상태로 유지해서, 턴 전의 질문들이 연결에 드는 1~3초를 건너뛰어요.

## Laya, 여러분의 컴퓨터에서 {#laya}

로컬에서 돌아가고 네트워크에는 전혀 닿지 않는 322M 파라미터 판정기예요.

```bash
mu judge setup     # 모델을 내려받기 전에 물어봄
mu judge start     # 판정기 시작
mu judge status
```

Laya는 단순한 술어(이 글이 오류를 설명하는가?)에는 믿을 만하지만, 관계나 요청 자체에 대한 질문에는 약해요. mu는 이걸 알기 때문에 Laya가 잘 답하지 못할 질문은 절대 보내지 않아요. 그래서 `["laya", "jev"]` 같은 체인에서는 그런 질문이 바로 다음 판정기로 가요. *판정 모드*의 승인은 Laya에게 맡기지 않아요. Laya에게 판정 지점을 따로 맡기기 전에 섀도 모드로 지금 쓰는 판정기와 나란히 돌려 보고 판정 장부를 읽어 보세요.

## 분류 모델과 LLM {#other-judges}

- **`classifier:<provider>/<model>`**: pi 모델 카탈로그의 어떤 분류 모델이든, 그 프로바이더에 이미 가진 로그인이나 키로 불러요. Cloudflare의 Clef가 `clef`와 `clef-flash`로 내장되어 있고, OpenRouter와 Vercel AI Gateway의 System One 모델, llama.cpp 분류 모델도 돼요.
- **`llm:<provider>/<model>`**: 어떤 채팅 모델이든 JSON으로 답하게 해요. 더 느리고 판정마다 토큰이 들지만, 이미 쓰는 모델 말고는 아무것도 필요 없어요. `mu setup --judge model`은 세션의 모델을 판정기로 삼아요.
- **`clm`**: `clm-serve`(기본값 `http://127.0.0.1:8700`) 뒤의 CLM-8B. mu의 질문으로는 아직 재지 않았어요.

## 직접 만든 판정기 {#custom}

`mu.json`의 `judges` 아래에 이름과 타입을 적어요.

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

| 타입 | 연결 대상 |
| --- | --- |
| `typesafe` | `baseUrl`에서 TypeSafe의 System One 프로토콜을 쓰는 모든 서비스 |
| `http` | `{ state, questions }`를 받아 `{ answers }`를 돌려주는 모든 엔드포인트 |
| `llm` | pi 레지스트리의 채팅 모델 |
| `classifier` | pi 카탈로그의 분류 모델 |
| `local` | Laya와 호환되는 로컬 서버 |
| `clm` | `clm-serve` |

키는 절대 파일에 넣지 않아요. `apiKeyEnv`는 키를 담은 환경 변수의 이름이고, 그 변수는 여러분의 환경이나 mu의 `.env`에 설정해요.

## 모드: active, shadow, off {#modes}

판정 지점마다 모드가 있어요.

- **active**(기본값): 판정이 적용돼요.
- **shadow**: 판정기에게 묻고 판정을 기록하지만, 아무것도 바뀌지 않아요.
- **off**: 그 판정 지점은 묻지 않아요.

모드는 `mu.json`의 `modes`(`default` 하나와 판정 지점별 항목)에서, 한 세션에서는 `/mu mode`로, 또는 앱의 설정에서 정해요. 앱 설정에서는 섀도 모드인 판정 지점이 꺼짐으로 보여요. 모드와 상관없이 동작하는 것이 두 가지 있어요. 여러분이 고른 권한 모드(*판정 모드*를 고른 것 자체가 `tool.approval`을 켜는 선택이에요)와, 모델이 직접 부를 때의 `judge_items` 도구예요.

## 판정기 비교하기 {#compare}

1. 판정 지점을 섀도 모드로 두고 시험할 판정기로 경로를 지정하거나, 모든 판정 지점을 섀도로 돌려요.
2. 한동안 평소처럼 일해요.
3. 판정을 읽어요. `mu ledger [n]`은 최근 n개 세션을 출력하고, `mu ledger --json`은 모든 기록을 확률, 소요 시간과 함께 내보내고, 앱의 판정 탭은 판정마다 그 질문을 함께 보여 줘요.
4. 판정이 맞아 보이면 그 판정 지점을 다시 active로 바꿔요.

`"recordState": true`로 하면 판정한 상태도 판정 장부에 남아요. 직접 판정기를 학습시키려면 이게 필요해요. 상태에는 여러분의 내용이 들어 있어서 기본값은 꺼짐이에요.
