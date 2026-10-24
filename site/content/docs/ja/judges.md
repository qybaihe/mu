---
title: 判定器
summary: 誰が判定ポイントに答えるか、判定器の選び方、つなげ方、比べ方、そしてそれぞれのコスト。
---

## どの判定器が答えるか {#tiers}

`~/.mu/agent/mu.json` の `tiers` は、判定器を順に並べたものです。後ろの判定器には、前の判定器が確信を持てなかった問いだけが渡るので、安いローカルの判定器を先に置き、残りをクラウドの判定器に拾わせることができます：

```json
{ "tiers": ["laya", "jev"] }
```

`routes` は、一つの判定ポイントに専用の判定器を割り当てます：

```json
{ "routes": { "browser.step": ["jev"], "memory.capture": ["llm:anthropic/claude-haiku-4-5"] } }
```

セッションの中では、`/mu judge <judges>` と `/mu route <point> <judges|default>` で同じことができます。`MU_JUDGE=laya,jev mu` は 1 回の実行だけ判定器を設定します。`/status` で、どの判定器が何に答えるかがわかります。アプリの「判定器」ページでも同じ設定ができます。

時間内に答える判定器がなければ、各判定ポイントは判定がないときと同じように動き（たいていは何も変わりません）、台帳にその理由が残ります。

## mude 1.0（あなたの Mac で） {#mude}

mude 1.0 は、コーディング向けに最適化された mu 独自の意思決定モデルです。パラメータは 2B で、1 つの判断のすべての問いに 1 回の順伝播で答えます。Apple シリコンの Mac（macOS 14 以降、メモリ 8 GB 以上）では、これがおすすめの判定器です。`mu setup` は最初に mude を挙げ、デスクトップアプリの初回ガイドも最初から mude を選んでいます。

```bash
mu judge mude install               # ダウンロード（1.8 GB）、全ファイルを検証、起動して判定器にする
mu judge mude enable --local-only   # mude だけ：クラウドの判定器には何も送らない
mu judge mude status
```

デフォルトでは、それまでの判定器が `tiers` で mude の後ろに残ります。mude が答えられない問い（サーバーが止まっている、または確信がない）と、mude にまだ任せていない 2 つのインジェクション検査は、そちらが答えます。`--local-only` では mude が唯一の判定器になり、答えられない判断はフォールバックに従います。mude の回答は 1 回あたり約 0.1 秒で、mude が読んだ内容は Mac の外に出ません。サーバーは動作中に約 4 GB のメモリを使い、設定に mude があれば mu がセッションの前に起動します。途中で止まったインストール（Ctrl-C、回線切れ、停電）は、次回、中断したところから続きます。ほかのプラットフォームでは、[フルモデル](https://huggingface.co/qybaihe/mude-1.0)を付属の System One サーバーで動かし、モデルカードのとおり `typesafe` の判定器として追加します。

## Jev（クラウド） {#jev}

Jev は TypeSafe による判定モデルで、この種の問いのために作られています。組み込みの `jev` 判定器は、キーが設定されている最初のサービスを通して Jev に接続します：

| 順番 | サービス | キー | 組み込みの名前 |
| --- | --- | --- | --- |
| 1 | TypeSafe | `TYPESAFE_API_KEY` | `jev-direct` |
| 2 | OpenRouter（Jev 専用のキー） | `MU_JUDGE_OPENROUTER_API_KEY` | `jev-openrouter` |
| 3 | Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `jev-gateway` |
| 4 | OpenCode Zen | `OPENCODE_API_KEY` | `jev-opencode` |
| 5 | Cloudflare Workers AI | `CLOUDFLARE_API_KEY` と `CLOUDFLARE_ACCOUNT_ID` | `jev-cloudflare` |
| 設定なし | OpenCode Zen（期間限定で無料） | キーなし | `jev-opencode-free` |

キーは、そのキーが属するサービスにしか送られません。順番を飛ばすには、`"tiers": ["jev-openrouter"]` のようにルートを直接指定します。キーは `mu setup` かアプリの「判定器」ページが書き込みます。

**無料の Jev。** キーが一つもなければ、OpenCode Zen 上の Jev 1.13 が答えます。判定する内容は OpenCode に送られますが、モデルの学習には使われません。mu はそのことを 1 日 1 回知らせます。これは OpenCode の期間限定の提供で、終了すると mu がそのことを知らせ、キーを設定するまで判定ポイントはフォールバックします。`mu setup --judge free` で明示的に選べます。

**速度とコスト。** 作者たち自身のセッションでの実測では、ウォームな接続で 1 問あたり約 0.3 秒、ツール出力 16 チャンクを 1 リクエストで判定して 0.44 秒で、状態の課金は 1 回だけでした。セッションの使用中は、50 秒ごとに小さな問いを 1 つ送って接続をウォームに保つので、ターン前の問いは接続にかかる 1〜3 秒を省けます。

## Laya（ローカル） {#laya}

322M パラメータの判定器で、ローカルで動き、ネットワークには一切触れません。

```bash
mu judge setup     # モデルをダウンロードする前に確認する
mu judge start     # 起動する
mu judge status
```

Laya は単純な述語（このテキストはエラーを説明しているか？）では信頼できますが、関係を問う質問や依頼そのものについての質問には弱めです。mu はこのことを把握していて、Laya がうまく答えられない問いは送らないので、`["laya", "jev"]` のようなチェーンでは、そうした問いは直接次の判定器に渡ります。判定モードの承認は、Laya には任せません。Laya に判定ポイントを任せる前に、シャドーモードで今の判定器と並べて動かし、台帳を読んでください。

## 分類モデルと LLM {#other-judges}

- **`classifier:<provider>/<model>`**：pi のモデルカタログにある任意の分類モデル。そのプロバイダーですでに持っているサインインやキーで接続します。Cloudflare の Clef は `clef` と `clef-flash` として組み込まれています。OpenRouter と Vercel AI Gateway の System One モデルや、llama.cpp の分類モデルも使えます。
- **`llm:<provider>/<model>`**：任意のチャットモデルに、JSON で答えさせます。遅く、判定のたびにトークンがかかりますが、すでに使っているモデル以外に何も要りません。`mu setup --judge model` で、セッションのモデルを判定器にします。
- **`clm`**：`clm-serve`（既定は `http://127.0.0.1:8700`）の背後にある CLM-8B。mu の問いではまだ測っていません。

## 自分の判定器 {#custom}

`mu.json` の `judges` に、名前と種類を書きます：

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

| 種類 | 接続先 |
| --- | --- |
| `typesafe` | `baseUrl` で TypeSafe の System One プロトコルを話す任意のサービス |
| `http` | `{ state, questions }` を受け取り `{ answers }` を返す任意のエンドポイント |
| `llm` | pi のレジストリにあるチャットモデル |
| `classifier` | pi のカタログにある分類モデル |
| `local` | Laya 互換のローカルサーバー |
| `clm` | `clm-serve` |

キーはファイルに書きません。`apiKeyEnv` には、キーを持つ環境変数の名前を書きます。その変数は、自分の環境か mu の `.env` で設定します。

## モード：active、shadow、off {#modes}

各判定ポイントにはモードがあります：

- **active**（既定）：判定が反映されます。
- **shadow**：判定器に問い合わせて判定を記録しますが、何も変わりません。
- **off**：その判定ポイントには問い合わせません。

モードは `mu.json` の `modes`（`default` と、判定ポイントごとのエントリ）で設定するか、1 回のセッションだけなら `/mu mode` で、またはアプリの設定で指定します。アプリの設定では、シャドーの判定ポイントはオフとして表示されます。モードにかかわらず動くものが 2 つあります。あなたが選んだ権限モード（判定モードを選ぶこと自体が `tool.approval` をオンにする操作です）と、モデルが呼び出したときの `judge_items` ツールです。

## 判定器を比べる {#compare}

1. 判定ポイントをシャドーにして、試したい判定器にルーティングします。または、すべての判定ポイントをシャドーにします。
2. しばらく普段どおりに作業します。
3. 判定を読みます。`mu ledger [n]` は直近 n 回のセッションを出力し、`mu ledger --json` はすべての記録を確率と所要時間付きで出力します。アプリの判定タブでは、各判定がその問いとともに表示されます。
4. 判定が正しそうに見えたら、その判定ポイントを active に戻します。

`"recordState": true` にすると、判定した状態も台帳に残ります。自分の判定器を学習させるには、これが必要です。状態にはあなたのコンテンツが含まれるため、既定ではオフです。
