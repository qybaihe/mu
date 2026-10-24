---
title: コマンドライン
summary: mu のコマンド、セッション内のスラッシュコマンド、そして pi からそのまま引き継いだもの。
---

```bash
npm i -g mu-agent      # Node.js 22.19 以降が必要
mu                     # 現在のディレクトリで対話セッションを始める
```

## mu を起動する {#starting}

| コマンド | 内容 |
| --- | --- |
| `mu` | 現在のディレクトリで対話セッションを始める |
| `mu "prompt"` | このプロンプトから始まる対話セッション |
| `mu -p "prompt"` | 1 回だけ実行：答えを出力して終了する |
| `mu -c` | 前回のセッションを続ける |
| `mu -r` | 再開するセッションを選ぶ |
| `mu --help` | エージェントのすべてのフラグ |

`mu install`、`remove`、`update`、`list`、`config` は、pi と同じく pi のパッケージを管理します。

## mu 独自のコマンド {#commands}

| コマンド | 内容 |
| --- | --- |
| `mu setup` | モデルを接続し（API キー、または一覧からサービスを選ぶ）、判定器を選ぶ。`mu setup --help` でスクリプト向けの書き方を表示する。 |
| `mu doctor` | インストール、モデル、判定器、各接続を確認し、何を直せばよいかを示す |
| `mu ledger [n] [--json]` | 直近 n 回のセッションで判定器が下した判定。`--json` で、すべての記録を確率と所要時間付きで出力する。 |
| `mu import --list` | Claude Code、Codex、ZCode の会話を探す |
| `mu import <file>…` | それらを履歴ごと mu に取り込み、そこで続ける。あとでもう一度実行すると新しい内容が加わる |
| `mu judge mude install \| enable \| disable \| start \| stop \| status \| uninstall` | Apple シリコンの Mac で動く、mu 独自の意思決定モデル [mude 1.0](@docs/judges#mude)。ダウンロードが途中で止まっても、`install` は中断したところから続ける。 |
| `mu judge model add \| list \| use \| start \| stop \| status \| disable \| remove` | Hugging Face の[ほかの意思決定モデル](@docs/judges#models)を mude 1.0 と同じように動かす。`add` はリンクか `owner/name` を受け取り、止まったダウンロードを再開する。 |
| `mu link` / `mu unlink` | `mu` コマンドを PATH（`~/.local/bin`）に置く、または取り除く |
| `mu auth status \| login <provider> \| logout <provider>` | デスクトップアプリが使うサブスクリプションのサインイン |
| `mu migrate [--dry-run]` | 一度だけ実行：名前変更前のホーム `~/.kyrn` を `~/.mu` に移す |

## セッション内のコマンド {#slash-commands}

| コマンド | 内容 |
| --- | --- |
| `/status` | 判定器、各判定ポイントのモード、コンテキストに入れなかったもの、最新の判定 |
| `/mu judge <judges>` | どの判定器がどの順で答えるか：`jev`、`mude,jev`、`jev-opencode-free`、`classifier:<provider>/<model>`、`llm:<provider>/<model>` |
| `/mu route <point> <judges>` | 一つの判定ポイントに専用の判定器を割り当てる |
| `/mu mode <point> <off\|shadow\|active>` | このセッションで、一つの判定ポイント（`default` ならすべて）を切り替える |
| `/frame` | タスクフレーム：目標、あなたの制約とその出どころ、受け入れ条件 |
| `/goal <condition>` | 条件が満たされるまで作業を続ける。`/goal clear` で終了 |
| `/permissions` | フルアクセス、判定モード、最小権限 |
| `/board` | このプロジェクトでわかりやすいボードをオン・オフする。`/board model` でそのモデルを選ぶ |
| `/remember <text>`、`/lessons`、`/forget <id>` | 教訓を一つ残す、一覧する、一つを廃止する |
| `/review`、`/commit` | 変更をレビューし、指摘を P0〜P3 で並べる。変更を複数のコミットに分ける |
| `/checkpoints`、`/rewind` | チェックポイントを一覧する。そのどれかに戻る（`/rewind undo` で元に戻す） |
| `/agents`、`/swarm` | サブエージェントに委任する。それぞれが何をしているかを見る |
| `/hive <question>` | 難しい問いについてハイブを始める |
| `/browse`、`/jobs` | 内蔵ブラウザ。バックグラウンドコマンド |
| `/capabilities`、`/ledger` | インストール済みのケイパビリティとそのうち開いているもの。最新の判定 |
| `/inherit` | Claude Code、Cursor、Codex から引き継いだものと、引き継がなかったもの |
| `/import-chat` | Claude Code、Codex または ZCode の会話をインポートする |
| `/doctor` | 設定と接続を確認する |

pi 自身のコマンド（`/model`、`/thinking`、`/login`、`/resume`、`/tree`、`/fork`、`/compact`、`/export`、`/mcp` など）はそのままです。違いは 1 つだけで、`/login` には Claude サブスクリプションのサインインがありません。Anthropic が他のアプリによる提供を認めていないためです。Anthropic の API キーを使ってください。

## 判定の行 {#verdict-line}

ターンが始まる前に、mu はあなたのメッセージに対する判定器の読みを少しだけ待ち、エディタの上に表示します。たとえば *◆ jev-1.13-free  multi-step task · full effort · 699 ms* です。<kbd>Esc</kbd> を押すと、待たずに始めます。ステータスラインには権限モードが表示され、目標の実行中はその目標も表示されます。

## 1 回の実行だけに効く環境変数 {#env}

| 変数 | 効果 |
| --- | --- |
| `MU_JUDGE=mude,jev mu` | この実行だけの判定器。`MU_JUDGE=off` でカーネルをオフにする。 |
| `MU_JUDGE_MODE=shadow mu` | この実行では、すべての判定ポイントをシャドーにする |
| `MU_PERMISSIONS=ask mu` | この実行の権限モード：`full`、`judge`、`ask` |
| `MU_LANG=zh-CN mu` | mu 自身のメッセージを中国語（`zh`）か英語（それ以外）にする |

完全な一覧は[設定](@docs/configuration#env)にあります。
