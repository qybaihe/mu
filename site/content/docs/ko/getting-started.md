---
title: 시작하기
summary: 데스크톱 앱이나 명령줄을 설치하고, 모델을 연결하고, 첫 작업을 실행해요.
---

## 데스크톱 앱 {#desktop-app}

1. [Releases](https://github.com/qybaihe/mu/releases/latest)에서 여러분의 시스템에 맞는 빌드를 내려받거나, 시스템을 알아서 골라 주는 [홈 페이지](@home#install)에서 내려받으세요.

   | 시스템 | 파일 |
   | --- | --- |
   | macOS, Apple 실리콘 | `mu-<version>-mac-arm64.dmg` |
   | macOS, Intel | `mu-<version>-mac-x64.dmg` |
   | Windows x64 / Arm | `mu-<version>-win-x64.exe` / `mu-<version>-win-arm64.exe` |
   | Linux x64 / Arm (Debian, Ubuntu) | `mu-<version>-linux-amd64.deb` / `mu-<version>-linux-arm64.deb` |

   Windows 빌드는 아직 코드 서명이 없어서 처음 실행할 때 SmartScreen이 경고를 띄워요. **추가 정보**를 누른 다음 **실행**을 누르세요.
2. 앱을 여세요. 처음 실행하면 설정 가이드가 모델, 권한 모드, 판정기, 시작의 네 단계를 안내해요.
   - **모델.** API 키를 붙여 넣으면 mu가 키의 형식으로 서비스를 알아보고(OpenAI, Anthropic, Google Gemini, xAI, OpenRouter, DeepSeek, Kimi, Qwen, GLM, SiliconFlow 등) 요청 하나로 확인해요. ChatGPT, Grok, Google 구독으로 로그인할 수도 있어요.
   - **권한.** *판정 모드*가 미리 선택되어 있어요. [권한과 안전](@docs/permissions)을 보세요.
   - **판정기.** [mude 1.0](@docs/judges#mude)(mu의 자체 의사결정 모델)을 돌릴 수 있는 Mac에서는 처음부터 mude가 선택되어 있고, 한 번 누르면 설치돼요. 그 밖에는 키가 없으면 OpenCode Zen을 통해 무료 Jev(TypeSafe가 호스팅하는 판정 모델)가 답해요. 판정기에 아무것도 보내고 싶지 않으면 **판정기 없음**을 고르세요.
   - **시작.** mu가 Claude Code, Codex, ZCode 대화를 찾으면 가져오기를 제안해요.
3. 폴더를 고르고 대화를 시작하세요.

## 명령줄 {#command-line}

```bash
npm i -g mu-agent      # Node.js 22.19 이상
mu setup               # 모델 연결, 판정기 선택
mu                     # 현재 디렉터리에서 세션 시작
```

키 대신 ChatGPT, Grok, Google 구독을 쓰려면 `mu setup`에서 구독 로그인을 고르세요. mu가 `/login`을 연 채로 시작하고, 로그인은 브라우저에서 마무리해요. 스크립트용으로는 `mu setup --help`가 대화형이 아닌 형식을 보여 줘요. 키는 표준 입력에서 읽고, 명령줄 인수로는 절대 받지 않아요.

해 볼 만한 것:

| 명령어 | 하는 일 |
| --- | --- |
| `mu "fix the failing test in src/pager.test.ts"` | 프롬프트와 함께 시작 |
| `mu -p "summarize this repository"` | 한 번 답하고 종료 |
| `mu -c` / `mu -r` | 마지막 세션 이어 가기 / 이어 갈 세션 고르기 |
| `mu import --list` | 가져올 Claude Code, Codex, ZCode 대화 찾기 |
| `mu doctor` | 설치, 판정기, 연결 상태 점검 |
| `mu ledger 3` | 최근 세션 3개에서 판정기가 내린 판정 |

## 첫 작업 {#first-task}

프로젝트 폴더를 열고, 하고 싶은 일을 평소 말투로 말하세요. 그다음에 일어나는 일:

1. **판정기가 먼저 메시지를 읽고** *여러 단계 작업 · 전력 투입* 같은 한 줄 판정을 보여 줘요. 1초도 채 걸리지 않아요. 건너뛰려면 <kbd>Esc</kbd>를 누르세요.
2. **모델이 일해요.** 긴 도구 출력은 모델에 닿기 전에 걸러져요. *판정 모드*에서는 프로젝트 밖의 명령이 승인을 기다려요.
3. **다 했다고 하면** mu는 그 작업을 검증한 것이 있는지 확인하고, 없으면 한 번 짚어 줘요.

조건이 충족될 때까지 계속하게 하려면 [목표 모드](@docs/goal)를 쓰세요: `/goal all tests in packages/api pass`.

## 판정기 {#judge}

판정기는 따로 설정할 필요가 없어요. Jev 키가 없으면 OpenCode Zen의 무료 Jev가 답하고, mu가 하루에 한 번 그 사실을 알려 줘요. Apple 실리콘 Mac에서는 `mu setup`과 앱이 Mac에서 돌아가는 mu의 자체 의사결정 모델 [mude 1.0](@docs/judges#mude)을 추천해요. 직접 가진 키, 로컬 판정기, 다른 모델을 쓰려면 [판정기](@docs/judges)를 보세요.

판정 지점 {points}개 중 {points_active}개는 처음부터 판정을 반영하고, 판정은 모두 기록돼요. `/status`, `mu ledger`, 앱의 판정 탭에서 볼 수 있어요. 판정기를 믿기 전에 지켜보고 싶다면 판정 지점들을 섀도 모드로 두세요. 질문과 기록은 그대로 하지만, 아무것도 바꾸지 않아요.

```json
{ "modes": { "default": "shadow" } }
```

이 내용은 `~/.mu/agent/mu.json`에 넣어요. `/mu mode default shadow`는 현재 세션에서만 같은 일을 해요.

## 파일 위치 {#files}

| 경로 | 내용 |
| --- | --- |
| `~/.mu/agent/mu.json` | mu의 설정: 판정기, 모드, 기능 |
| `~/.mu/agent/auth.json`, `models.json`, `settings.json` | pi의 로그인, 프로바이더, 환경설정 |
| `~/.mu/agent/sessions/` | 세션. 앱과 명령줄이 함께 써요 |
| `~/.mu/agent/mu/lessons.jsonl` | 교훈 라이브러리 |
| `~/.mu/agent/mu/permissions.json` | 마지막으로 고른 권한 모드 |
| `~/.mu/backups/` | `mu setup`이 파일을 바꾸기 전에 만드는 사본 |

Windows에서 `~`는 사용자 폴더(`%USERPROFILE%`)예요.
