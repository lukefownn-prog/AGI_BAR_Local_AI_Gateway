# M11 クライアント接続検証

[繁體中文](README.md) ｜ [English](README.en.md) ｜ **日本語**

> 企画書の第 10 節および
> [Issue #1](https://github.com/lukefownn-prog/AGI_BAR_Local_AI_Gateway/issues/1) に対応します。

## このスクリプトにできること・できないこと

Cursor と Codex は GUI / CLI ツールで、**自動クリックはできません**。

自動で検証できるのは、それらが**実際に送信するリクエストの形**です —— エンドポイント、
ヘッダー、パラメーターの組み合わせ、ストリーミング形式、ツール呼び出しのメッセージ列。
スクリプトはこれらを一通り送信し、設定作業に取りかかる前に詰まる箇所を洗い出したうえで、
そのまま貼り付けられる設定と残りの手動チェックリストを出力します。

実際に Cursor を開いて Verify を押す作業は、やはり人間が行う必要があります。

## 使い方

```bash
node tests/integration/client-compat.mjs --self-test          # スクリプト自体の検証
node tests/integration/client-compat.mjs --url http://192.168.1.100:8787 --key agi-bar-xxxxxxxx
node tests/integration/client-compat.mjs --url http://… --admin-pass "パスワード" --client codex
```

既存のキーが無い場合は `--admin-pass` を使います。スクリプトが `compat-probe` という利用者を
作成し、終了時に自動削除します。設定ファイルの**既定クォータ**を意図的にそのまま使う
（時間帯だけ広げる）ため、「大きなコンテキスト」の探針は実際の利用者が直面する制限を
反映します。

| オプション | 説明 |
|---|---|
| `--url` | ゲートウェイのアドレス |
| `--key` | 既存の API キーで探索 |
| `--admin-pass` | キーが無い場合に探索用の利用者を自動作成 |
| `--client` | `all` / `cursor` / `codex` / `claude-code` / `app` / `deepseek` |
| `--emit <ディレクトリ>` | 設定ファイルを生成（config.toml、env.sh、env.ps1、smoke.sh） |
| `--show-secrets` | 生成した設定に API キーを完全表示（**既定はマスク**） |
| `--json <ファイル>` | 生の結果を出力 |

終了コード：0 合格／1 必須項目が不合格／2 実行エラー。

## 既知の落とし穴 2 点

スクリプトが直接指摘しますが、理由をここで説明しておきます。

### Codex：`wire_api = "chat"` が必須

新しい Codex CLI は**既定で OpenAI Responses API**（`POST /v1/responses`）を使いますが、
AGI BAR が提供するのは `/v1/chat/completions` だけです。この行が無いと接続できず、
エラーメッセージも通常その理由を教えてくれません。

```toml
# ~/.codex/config.toml
model = "agi-bar-default"
model_provider = "agibar"

[model_providers.agibar]
name = "AGI BAR"
base_url = "http://192.168.1.100:8787/v1"
env_key = "OPENAI_API_KEY"
wire_api = "chat"        # ← 重要
```

`--emit` が生成する `codex-config.toml` には既に含まれています。

### 1 回あたりのトークン上限は十分に大きく

IDE 系クライアントはファイル全体をプロンプトに詰め込み、容易に数万トークンに達します。
`tokensPerRequest` が 8192 だと、**小さなテストリクエストはすべて通るのに実運用では
413 が多発します** —— 大きなペイロードでしか見えない問題のため、探針は意図的に
約 10,000 トークンという現実的なサイズを使っています。

設定ファイルの既定値はサンプルのメインモデルの `contextWindow` に合わせて 32768 へ
引き上げ済みです。モデルを変更する際は両方を確認してください。

## Base URL の違い

3 つのクライアントで異なり、最もよくある手違いの原因です。

| クライアント | 環境変数 | `/v1` を付けるか |
|---|---|---|
| Cursor | Override OpenAI Base URL | **付ける** |
| Codex | `OPENAI_BASE_URL` | **付ける** |
| Claude Code | `ANTHROPIC_BASE_URL` | **付けない**（SDK が `/v1/messages` を補う） |

Claude Code で誤って `/v1` を付けると `/v1/v1/messages` になります。ゲートウェイは両方の
パスを受けますが、正しい書き方は付けないことです。

## 探針のカバー範囲

**共通** —— Bearer 認証、無効キーの拒否、`/v1/models` の構造、エラー形式、`X-Request-Id`

**Cursor** —— Verify の探索リクエスト、任意のモデル名のルーティング（一覧に `gpt-4o` が
残っていても動くこと）、ストリーミング、`stream_options.include_usage`、
サンプリングパラメーターの透過、大きなコンテキスト、`/v1/embeddings` の現状

**Codex** —— モデル一覧、`/v1/responses` の検出、`wire_api="chat"` の経路、ツール定義、
**ツール結果の返送**（エージェント 2 巡目の `role=tool` メッセージ。ここが通らないと
Codex は最初のツール呼び出し直後に止まります）、ストリーミング、未知パラメーターの許容度

**Claude Code** —— `/v1/messages`、`x-api-key` ヘッダー

**自作アプリ** —— CORS プリフライトの現状

**DeepSeek** —— 外部クラウドモデルの認可ゲート（誤って有効化されていないことの確認）

## 手動での手順

レポートの最後に列挙されます。要約：

- **Cursor**：Verify を押す → Chat を開いてメッセージを送信 → 管理コンソールの「ログ」ページに
  該当リクエストがあることを確認。タブ補完と Composer の一部機能は Cursor 自社サーバーを
  経由し、AGI BAR を通らない点に注意。
- **Codex**：`~/.codex/config.toml` を作成 → `OPENAI_API_KEY` を設定 → 簡単なタスクを 1 回実行。
- **Claude Code**：3 つの `ANTHROPIC_` 環境変数を設定 → `claude` を実行。
  エージェント機能はバックエンドモデルのツール呼び出し対応状況に依存します。

## CI による保護

`tests/client-compat.test.mjs` を CI が毎回実行します。理由は負荷テストスクリプトと同じで、
これは普段実行されないため、2 回の受け入れの間にコード変更で壊れるのが最も多いからです。

うち 1 項目は**`/v1/responses` が未実装であること**を意図的に断言しています ——
実装された日にはそのテストが失敗し、「wire_api を設定する必要がある」という説明を
削除するよう促してくれます。

## 注意事項

- **1 プロセスにつき `--self-test` 環境は 1 つだけです。** `core/paths.mjs` はモジュール読み込み時に
  データディレクトリを確定し、`core/config.mjs` も設定をキャッシュするため、2 回目は
  1 回目の（既に閉じた）環境を使い回してしまいます。複数シナリオはプロセスを分けてください。
- 生成される設定ファイルは既定で API キーをマスクします。`--show-secrets` で生成した
  ファイルには完全なキーが含まれるため、**リポジトリにコミットしないでください**。
