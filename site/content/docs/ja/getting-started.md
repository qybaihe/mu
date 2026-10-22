---
title: 使い始める
summary: デスクトップアプリかコマンドラインをインストールし、モデルを接続して、最初のタスクを実行します。
---

mu には 2 つの形があります。必要なものをすべて内蔵した**デスクトップアプリ**と、**`mu` コマンドライン**です。どちらもアカウント、設定、セッション、教訓を共有するので、片方で始めたタスクをもう片方で続けられます。

## デスクトップアプリ {#desktop-app}

1. [Releases](https://github.com/qybaihe/mu/releases/latest) から、または[ホームページ](@home#install)から、お使いのシステム用のビルドをダウンロードします。ホームページではシステムが自動で選ばれます。

   | システム | ファイル |
   | --- | --- |
   | macOS、Apple シリコン | `mu-<version>-mac-arm64.dmg` |
   | macOS、Intel | `mu-<version>-mac-x64.dmg` |
   | Windows x64 / Arm | `mu-<version>-win-x64.exe` / `mu-<version>-win-arm64.exe` |
   | Linux x64 / Arm（Debian、Ubuntu） | `mu-<version>-linux-amd64.deb` / `mu-<version>-linux-arm64.deb` |

   リリースページの `SHA256SUMS` に、すべてのファイルのチェックサムが載っています。macOS 版は Apple の署名と公証を受けています。Windows 版はまだコード署名がないため、初回は SmartScreen が警告します。**詳細情報**を選び、**実行**を選んでください。
2. アプリを開きます。初回ガイドが 4 つのステップを案内します。モデル、権限モード、判定器、開始です。
   - **モデル。** API キーを貼り付けると、mu はキーの形からサービスを見分け（DeepSeek、Kimi、Qwen、GLM、SiliconFlow、OpenRouter、OpenAI、Anthropic、Google Gemini、xAI など）、1 回のリクエストで確かめます。または ChatGPT、Grok、Google のサブスクリプションでサインインします。キーの誤り、残高不足、対応していない地域、接続できない場合には、それぞれどうすればよいかを説明します。
   - **権限。** 最初から判定モードが選ばれています。[権限と安全性](@docs/permissions)を参照してください。
   - **判定器。** キーがなければ、無料の Jev（TypeSafe がホストする判定モデル。OpenCode Zen 経由）が答えます。この設定にはいつでも戻れます。
   - **開始。** Claude Code、Codex、ZCode の会話が見つかると、インポートを提案します（ガイドの最初の画面でも提案します）。
3. フォルダを選んで会話を始めます。

ほかにインストールするものはありません。Node.js は不要で、初回起動時にも何もダウンロードしません。新しいリリースが出ると、アプリはそのバージョンとサイズを知らせ、あなたが同意してからダウンロードし、再起動時にインストールします。

## コマンドライン {#command-line}

```bash
npm i -g mu-agent      # Node.js 22.19 以降
mu setup               # モデルを接続し、判定器を選ぶ
mu                     # 現在のディレクトリでセッションを始める
```

`mu setup` は、中国語か英語で一つずつ尋ねます。スキップした場合は、モデルがない状態で初めて `mu` を実行したときに、いま設定するかどうかを一度だけ尋ねます。スクリプトでは、`mu setup --help` で対話なしの書き方を確認できます。キーは標準入力から読み込み、コマンドラインから読むことはありません。

試してみるとよいこと：

| コマンド | 内容 |
| --- | --- |
| `mu "fix the failing test in src/pager.test.ts"` | プロンプトを指定して始める |
| `mu -p "summarize this repository"` | 1 回だけ答えて終了する |
| `mu -c` / `mu -r` | 前回のセッションを続ける / 再開するセッションを選ぶ |
| `mu import --list` | 取り込める Claude Code、Codex、ZCode の会話を探す |
| `mu doctor` | インストール、判定器、各接続を確認する |
| `mu ledger 3` | 直近 3 回のセッションで判定器が下した判定 |

セッションの中では、`/status` で判定器、各判定ポイントのモード、最新の判定が表示され、`/help` ですべてのコマンドが一覧できます。全体の一覧は[コマンドラインのページ](@docs/cli)にあります。

## 最初のタスク {#first-task}

プロジェクトのフォルダを開き、やってほしいことを自分の言葉で伝えます。そのあとの流れ：

1. **まず判定器があなたのメッセージを読み**、*複数ステップのタスク · 全力* のような 1 行の判定を表示します。1 秒もかかりません。<kbd>Esc</kbd> を押すとスキップできます。
2. **モデルが作業します。** 長いツール出力は、モデルに届く前に絞り込まれます。判定モードでは、プロジェクトの外に及ぶコマンドは承認を待ちます。
3. **終わったと言ったとき**、mu は何かでその作業を確かめたかを確認し、確かめていなければ一度だけ促します。

条件が満たされるまで作業を続けさせるには、[目標モード](@docs/goal)を使います：`/goal all tests in packages/api pass`。

## 判定器 {#judge}

mu は、セッション中の定型の問いを、小さくて速い判定モデルに尋ねます。自分で設定する必要はありません。Jev のキーがなければ OpenCode Zen の無料の Jev が答え、mu はそのことを 1 日 1 回知らせます。自分のキー、ローカルの判定器、別のモデルを使うには、[判定器](@docs/judges)を参照してください。

{points} の判定ポイントのうち {points_active} は最初から判定を反映し（`context.compact` と `output.drift` は既定でオフ）、判定はすべて記録されます（`/status`、`mu ledger`、アプリの判定タブ）。判定器を信頼する前に様子を見たい場合は、判定ポイントをシャドーモードにします。問い合わせと記録は続きますが、何も変わりません。

```json
{ "modes": { "default": "shadow" } }
```

これは `~/.mu/agent/mu.json` に書きます。`/mu mode default shadow` は、同じことを現在のセッションだけに適用します。

## ファイルの場所 {#files}

| パス | 内容 |
| --- | --- |
| `~/.mu/agent/mu.json` | mu の設定：判定器、モード、機能 |
| `~/.mu/agent/auth.json`、`models.json`、`settings.json` | pi のサインイン、プロバイダー、環境設定 |
| `~/.mu/agent/sessions/` | セッション。アプリとコマンドラインで共有 |
| `~/.mu/agent/mu/lessons.jsonl` | 教訓ライブラリ |
| `~/.mu/agent/mu/permissions.json` | 最後に選んだ権限モード |
| `~/.mu/backups/` | `mu setup` がファイルを変更する前に作るコピー |

Windows では、`~` はユーザーフォルダ（`%USERPROFILE%`）です。
