---
title: 設定
summary: mu.json、環境変数、プロキシ、そして機能ごとのオプションの場所。
---

mu は、pi の設定（モデル、サインイン、環境設定）と、`~/.mu/agent/mu.json` にある自身の設定を読み込みます。デスクトップアプリの設定も同じファイルに書き込みます。アプリで行える変更はすべて手でも行え、その逆も同じです。

読み込むのはあなた自身の `mu.json` だけです。判定器はあなたのメッセージを読むので、プロジェクトが判定器、その接続先、モードを変えることはできません。

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

| キー | 意味 | 既定値 |
| --- | --- | --- |
| `tiers` | 答える判定器を順に並べたもの。後ろの判定器には、前の判定器が確信を持てなかったものだけが渡る。 | `["jev"]` |
| `modes` | `default` と、判定ポイントごとのエントリ：`active`、`shadow`、`off` | `{ "default": "active" }` |
| `routes` | `tiers` の代わりに、判定ポイントに専用の判定器を割り当てる | なし |
| `judges` | 名前を付けた自分の判定器。[判定器](@docs/judges#custom)を参照 | なし |
| `features` | 機能ごとのスイッチとオプション。`false` で機能をオフにし、オブジェクトでオプションを上書きする。すべてのオプションは[機能とオプション](@docs/options)にある。 | 各機能の既定値 |
| `writer` | 判定器にできないこと（タスクフレームや教訓を書くこと）に使う小さなモデル。`provider/model` の形式。空ならセッションのモデルを使う。 | なし |
| `recordState` | 判定だけでなく、判定した状態も台帳に残す。自分の判定器を学習させるのに必要。状態にはあなたのコンテンツが含まれるため、オフ。 | `false` |
| `mcp` | mu 独自の MCP サーバー：`{ "servers": { "<name>": { "command": … } } }`。Claude Code、Cursor、Codex のサーバーも見つけられる。 | なし |

mu が理解できない部分は、mu を止めずにその既定値に戻ります。まったく解析できないファイルは、セッションの開始時に報告され、既定値が使われます。

## モードの使い方 {#modes}

- {points} の判定ポイントのうち {points_active} は最初から判定を反映します（`context.compact`、`output.drift`、`swarm.patch` は既定でオフ、`notify.routing`、`input.interjection`、`turn.drift` は既定でシャドーです）。判定器や、確信の持てない判定ポイントを試すには、シャドーにして台帳を読み（`mu ledger`、`/status`、アプリの判定タブ）、それから active に戻します。
- `/mu mode <point> <off|shadow|active>` は現在のセッションで一つの判定ポイントを切り替え、`/mu mode default shadow` はすべてを切り替えます。モードを残しておくには、`mu.json` に書きます。
- `MU_JUDGE_MODE=shadow mu` は、1 回の実行の既定値を設定します。

## 環境変数 {#env}

判定器とモード：

| 変数 | 効果 |
| --- | --- |
| `MU_JUDGE` | この実行の判定器（カンマ区切り）：`laya`、`laya,jev`、`jev-opencode-free`、`classifier:<provider>/<model>`、`llm:<provider>/<model>`。`off` でカーネルをオフにする。 |
| `MU_JUDGE_MODE` | この実行の既定のモード：`off`、`shadow`、`active` |
| `MU_WRITER` | 書き手のモデルの `provider/model` |
| `MU_PERMISSIONS` | この実行の権限モード：`full`、`judge`、`ask` |
| `MU_LOCAL_JUDGE_URL` | `mu judge start` が起動するもの以外の、ローカル判定器サーバーのアドレス |

ホストされた判定器のキー（それぞれ自分のサービスにだけ送られます）：`TYPESAFE_API_KEY`、`MU_JUDGE_OPENROUTER_API_KEY`、`AI_GATEWAY_API_KEY`、`OPENCODE_API_KEY`、`CLOUDFLARE_API_KEY` と `CLOUDFLARE_ACCOUNT_ID`、`MU_JUDGE_CLM_API_KEY`。

ランチャー：

| 変数 | 効果 |
| --- | --- |
| `MU_AGENT_DIR` | `~/.mu/agent` の代わりに使うエージェントフォルダ |
| `MU_NO_SETUP=1` | 初回起動時にモデルの設定を尋ねない |
| `MU_LANG` | セッション内の mu 自身のメッセージの言語：`zh…` なら中国語、それ以外は英語。デスクトップアプリはアプリの言語に設定し、`mu setup` はロケールに従う。 |
| `MU_LINK_DIR` | `~/.local/bin` の代わりに、`mu link` が `mu` コマンドを置く場所 |
| `MU_CHROME` | コマンドラインで内蔵ブラウザが使う Chrome または Chromium |

`MU_` で始まる変数は、どれも古い `KYRN_` の綴りでも読み込まれます。

mu は `.env` ファイルも読み込みます。npm パッケージでは `~/.mu/.env` です。各行は `KEY=VALUE` の形で、その中の何も実行されません。`mu setup` は Jev のキーをここに書き込みます。環境ですでに設定されている変数が優先されます。

## プロキシ {#proxies}

mu は `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY` に従います。デスクトップアプリは、`HTTPS_PROXY` が設定されていなければ、システムのプロキシ（macOS のネットワーク設定、Windows のインターネット設定）にも従います。pi の `httpProxy` 設定も使えます。

## よく変更されるオプション {#common}

| 設定 | 内容 |
| --- | --- |
| `features.admission.testLog` | `"rules"` でテストログの完全な繰り返しを折りたたむ。`"jev"` で目標に応じた選択を加える。既定ではオフ。 |
| `features.board.defaultOn` | すべてのプロジェクトで、わかりやすいボードをオンにして始める |
| `features.permissions.mode` | あなたが選ぶ前の、新しい会話の権限モード |
| `features.injection.tools` | どのツールの結果を、プロンプトインジェクションについて検査するか |
| `features.continuation.maxNudges` | 手前で止まった実行を、1 メッセージにつき何回まで差し戻すか |
| `features.swarm.models` | サブエージェントの振り分け先にできるモデルの階層。安いものから順に |
| `features.goal.checkModel` | 目標が満たされたかをチェックするモデル |

すべての機能とオプション、その既定値と範囲：[機能とオプション](@docs/options)。
