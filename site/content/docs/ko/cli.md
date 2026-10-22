---
title: 명령줄
summary: mu의 명령어, 세션 안의 슬래시 명령어, 그리고 pi에서 그대로 가져온 것.
---

`mu` 명령은 코딩 에이전트 pi에 mu의 판정 커널을 얹은 거예요. pi가 하는 모든 것은 전과 같이 동작하고, mu는 자체 명령어와 판정 지점을 더해요.

```bash
npm i -g mu-agent      # Node.js 22.19 이상 필요
mu                     # 현재 디렉터리에서 대화형 세션 시작
```

## mu 시작하기 {#starting}

| 명령어 | 하는 일 |
| --- | --- |
| `mu` | 현재 디렉터리에서 대화형 세션 |
| `mu "prompt"` | 이 프롬프트로 시작하는 대화형 세션 |
| `mu -p "prompt"` | 한 번 실행: 답을 출력하고 종료 |
| `mu -c` | 마지막 세션 이어 가기 |
| `mu -r` | 이어 갈 세션 고르기 |
| `mu --help` | 에이전트의 모든 플래그 |

`mu install`, `remove`, `update`, `list`, `config`는 pi에서와 같이 pi 패키지를 관리해요.

## mu 자체 명령어 {#commands}

| 명령어 | 하는 일 |
| --- | --- |
| `mu setup` | 모델 연결(API 키, 또는 목록에서 고른 서비스)과 판정기 선택. `mu setup --help`는 스크립트용 형식을 보여 줘요. |
| `mu doctor` | 설치, 모델, 판정기, 연결 상태를 점검하고 무엇을 고칠지 알려 줌 |
| `mu ledger [n] [--json]` | 최근 n개 세션에서 판정기가 내린 판정. `--json`은 모든 기록을 확률, 소요 시간과 함께 내보내요. |
| `mu import --list` | Claude Code, Codex, ZCode 대화 찾기 |
| `mu import <file>…` | 그 대화를 기록 전체와 함께 mu로 가져와 이어 가기. 나중에 다시 하면 새로 생긴 내용이 더해져요 |
| `mu judge setup \| start \| stop \| status` | 로컬 판정기 Laya. `setup`은 모델을 내려받기 전에 물어요. |
| `mu link` / `mu unlink` | `mu` 명령을 PATH(`~/.local/bin`)에 넣거나 빼기 |
| `mu auth status \| login <provider> \| logout <provider>` | 데스크톱 앱이 쓰는 구독 로그인 |
| `mu migrate [--dry-run]` | 한 번만: 이름을 바꾸기 전의 홈 `~/.kyrn`을 `~/.mu`로 옮기기 |

## 세션 안의 명령어 {#slash-commands}

| 명령어 | 하는 일 |
| --- | --- |
| `/status` | 판정기, 판정 지점별 모드, 컨텍스트에서 뺀 것, 최근 판정 |
| `/mu judge <judges>` | 어떤 판정기가 어떤 순서로 답할지: `laya`, `laya,jev`, `jev-opencode-free`, `classifier:<provider>/<model>`, `llm:<provider>/<model>` |
| `/mu route <point> <judges>` | 판정 지점 하나에 따로 판정기 지정하기 |
| `/mu mode <point> <off\|shadow\|active>` | 이 세션에서 판정 지점 하나, 또는 `default`로 전부를 전환하기 |
| `/frame` | 작업 프레임: 목표, 여러분의 제약과 그 출처, 인수 조건 |
| `/goal <condition>` | 조건이 충족될 때까지 계속 작업하기. `/goal clear`로 끝내기 |
| `/permissions` | 전체 접근, *판정 모드*, 최소 권한 |
| `/board` | 이 프로젝트에서 쉬운 말 보드 켜고 끄기. `/board model`로 보드의 모델 고르기 |
| `/remember <text>`, `/lessons`, `/forget <id>` | 교훈 하나 남기기, 교훈 목록 보기, 하나 사용 중지하기 |
| `/review`, `/commit` | 변경 사항을 리뷰하고 지적 사항을 P0부터 P3까지 나누기, 변경 사항을 커밋으로 나누기 |
| `/checkpoints`, `/rewind` | 체크포인트 목록 보기, 그중 하나로 되돌아가기(`/rewind undo`로 취소) |
| `/agents`, `/swarm` | 서브 에이전트에게 위임하기, 각자 무엇을 하는지 보기 |
| `/hive <question>` | 어려운 질문으로 하이브 시작하기 |
| `/browse`, `/jobs` | 내장 브라우저, 백그라운드 명령 |
| `/capabilities`, `/ledger` | 설치된 기능 확장과 그중 열린 것, 최근 판정 |
| `/inherit` | Claude Code, Cursor, Codex에서 물려받은 것과 물려받지 않은 것 |
| `/import-chat` | Claude Code, Codex 또는 ZCode 대화 가져오기 |
| `/doctor` | 설정과 연결 점검하기 |

pi의 자체 명령어는 그대로예요: `/model`, `/thinking`, `/login`, `/resume`, `/tree`, `/fork`, `/compact`, `/export`, `/mcp` 등.

## 판정 줄 {#verdict-line}

턴이 시작되기 전에 mu는 판정기가 여러분의 메시지를 어떻게 읽었는지 잠깐 기다렸다가 입력창 위에 보여 줘요. 예: *◆ jev-1.13-free  multi-step task · full effort · 699 ms*. 기다리지 않고 시작하려면 <kbd>Esc</kbd>를 누르세요. 상태 표시줄에는 권한 모드가 나오고, 목표가 진행 중일 때는 그 목표도 나와요.

## 한 번 실행에만 쓰는 환경 변수 {#env}

| 변수 | 효과 |
| --- | --- |
| `MU_JUDGE=laya,jev mu` | 이번 실행에서만 쓸 판정기. `MU_JUDGE=off`는 커널을 꺼요. |
| `MU_JUDGE_MODE=shadow mu` | 이번 실행에서 모든 판정 지점을 섀도로 |
| `MU_PERMISSIONS=ask mu` | 이번 실행의 권한 모드: `full`, `judge`, `ask` |
| `MU_LANG=zh-CN mu` | mu 자체 메시지를 중국어(`zh`)나 영어(그 밖의 값)로 |

전체 목록은 [설정](@docs/configuration#env)에 있어요.
