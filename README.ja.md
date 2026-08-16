# AGI BAR — Local AI Gateway Management System

[繁體中文](README.md) ｜ [English](README.en.md) ｜ **日本語**

ブラウザーだけで操作できる**ローカル AI ゲートウェイ管理システム**です。管理者が 1 台の
AI ホストでサービスを起動すれば、同じネットワーク上の利用者は Web チャットから、
あるいは **OpenAI API 互換**の形式で各種 AI 開発ツールやアプリから接続できます。

> バージョン：**V1.2 — GitHub Workflow Edition**
> 規模：管理者 1 名 + 利用者 1〜50 名、各自に個別の API キー。

---

## 特長

| 機能 | 内容 |
|---|---|
| 個別 API キー | 利用者ごとに `agi-bar-xxxxxxxx` を 1 本発行。DB には SHA-256 ハッシュのみ保存 |
| トークンクォータ | 1 回 / 1 時間 / 1 日 / 1 か月の 4 階層。Input + Output の両方を計上 |
| 時間帯権限 | 有効期間、1 日の利用可能時間（日をまたぐ設定も可）、曜日指定 |
| レート制御 | RPM と同時リクエスト数の上限 |
| モデルルーティング | 利用者ごとの優先順位。順位 1 が使えないときは自動で次へフェイルオーバー |
| 優先度キュー | P0 管理者 / P1 高 / P2 通常 / P3 ゲスト＋アンチスタベーション |
| 管理コンソール隔離 | 既定では AI ホスト本体からのみアクセス可。LAN からは一律 404 |
| 完全な監査ログ | 待機時間・推論時間・トークン・フェイルオーバーをリクエストごとに記録 |
| 2 プロトコル対応 | OpenAI `/v1/chat/completions` と Anthropic `/v1/messages` が同一クォータを共有 |

**npm 依存ゼロ。** すべて Node.js 組み込みモジュール（`node:http` + `node:sqlite` +
`node:crypto`）で実装しています。`node_modules` もビルド工程もなく、展開すればそのまま動きます。

---

## クイックスタート

### 必要環境

- Windows 10/11（他のプラットフォームでは `node server/index.mjs` を直接実行）
- Node.js **24 LTS 以上**（`node:sqlite` がフラグなしで使えること）。
  または `runtime/` に `node.exe` を配置

### 起動

```bash
node server/index.mjs
```

Windows では **`啟動 AGI BAR.cmd`** をダブルクリックしてください。Node のバージョン確認、
設定ファイルの作成、ブラウザーの起動まで自動で行います。停止は
**`關閉 AGI BAR.cmd`**（PID で正確に停止するため、他の Node プロセスは巻き込みません）。

初回起動時に初期管理者のアカウントとパスワード（既定は `admin` / `agibar-admin`）が
表示されます。**ログイン後ただちに「設定」ページでパスワードを変更してください。**

| 用途 | アドレス | アクセスできる範囲 |
|---|---|---|
| Web 管理コンソール | `http://localhost:8787` | **AI ホスト本体のみ** |
| Web チャット | `http://<AI ホストの IP>:8787/chat.html` | LAN 上の利用者 |
| API Base URL | `http://<AI ホストの IP>:8787/v1` | LAN 上の利用者 |

管理コンソールは既定でローカルアクセスに限定されています。LAN の利用者がルートパスへ
アクセスするとチャットページへリダイレクトされ、`/app.html` と `/api/*` は一律 404 —— つまり
存在しないように見えます。開放するには `security.adminAccess` を変更してください。詳細は
[docs/安全須知.md](docs/安全須知.md)（セキュリティ注意事項）を参照。

---

## ローカルモデルの設定

`config/config.json` の `models.catalog` を編集し、llama.cpp / Ollama / vLLM などの
OpenAI 互換エンドポイントを指定してから再起動します。

```json
{
  "models": {
    "catalog": [
      {
        "id": "local-primary",
        "displayName": "ローカルのメインモデル",
        "endpoint": "http://127.0.0.1:8080/v1",
        "model": "qwen2.5-7b-instruct",
        "enabled": true,
        "isLocal": true,
        "vramMb": 8000
      }
    ],
    "defaultRoute": ["local-primary"]
  }
}
```

モデルの有効／無効の切り替えとヘルスチェックは「AI モデル」ページから即時に実行できます。
再起動は不要です。

---

## 外部ツールとの接続

Base URL と API キーを自由に設定できる OpenAI 互換クライアントであれば接続できます。
Claude Code のように Anthropic Messages API を使うツールも直接つながります —— ゲートウェイに
`/v1/messages` の変換層が組み込まれているため、**外部プロキシは不要**です。

Cursor、Claude Code、Codex、DeepSeek のフォールバック、自作アプリの設定手順は
**[docs/整合設定.md](docs/整合設定.md)**（統合設定ガイド）にあります。

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer agi-bar-あなたのキー" \
  -H "Content-Type: application/json" \
  -d '{"model":"agi-bar-default","messages":[{"role":"user","content":"こんにちは"}]}'
```

---

## プロジェクト構成

```
agi-bar/
├─ 啟動 AGI BAR.cmd     起動スクリプト（素のバッチファイル。未署名 EXE ではありません）
├─ 關閉 AGI BAR.cmd     停止スクリプト
├─ web/                 Web UI（管理コンソール + Web チャット。ビルド工程なし）
├─ server/              Gateway / API / Queue / Router
│  ├─ core/             設定、データベース、暗号、HTTP、ログ
│  ├─ services/         利用者、キー、クォータ、モデル、ルーティング、キュー、バックアップ
│  └─ routes/           管理 API、OpenAI 互換 API、静的ファイル
├─ scripts/             ビルドと検査のスクリプト
├─ config/              config.example.json（config.json はコミットしない）
├─ docs/                アーキテクチャ、デプロイ、統合、セキュリティ
├─ tests/               ユニットテスト + エンドツーエンドテスト
├─ models/              GGUF モデル（コミットしない）
├─ data/                データベース、ログ、バックアップ（コミットしない）
└─ runtime/             同梱の Node / llama.cpp（コミットしない）
```

---

## 開発

```bash
npm test
```

163 項目のテストが、キューの優先度とアンチスタベーション、時間帯権限、管理コンソールの
アクセス隔離、Anthropic ↔ OpenAI 変換、および 2 本のエンドツーエンドパイプライン
（ログイン → 利用者作成 → キー発行 → クォータ → ルーティング → フェイルオーバー → ログ）を
カバーしています。

負荷テストと本番受け入れ：

```bash
npm run loadtest:self                      # スクリプト自体の検証（GPU 不要）
npm run loadtest -- --url http://<IP>:8787 --admin-pass "…" --users 10
```

クライアント互換性の検証：

```bash
npm run compat:self                        # スクリプト自体の検証
npm run compat -- --url http://<IP>:8787 --key agi-bar-xxxxxxxx
```

詳細は **[tests/load/README.md](tests/load/README.md)** と
**[tests/integration/README.md](tests/integration/README.md)** を参照してください。

ブランチ運用、PR フロー、リリース手順は
**[docs/開發流程.md](docs/開發流程.md)**（開発フロー）にあります。

---

## セキュリティ注意事項

- 本システムは**社内ネットワーク**での利用を前提に設計されています。インターネットに対する
  防御機構（TLS 終端、WAF）は内蔵していません。外部公開する場合はリバースプロキシの背後に
  置き、HTTPS を有効にしてください。
- `config/config.json`、`data/`、`models/`、`runtime/` は `.gitignore` に登録済みです。
  **API キー、パスワード、利用ログ、モデルファイルはリポジトリに入りません。**
- 外部クラウドモデル（DeepSeek など）は既定で無効です。有効化することは、そのルートの
  プロンプトがローカルネットワークの外へ送信されることへの同意を意味します。組織のポリシーを
  確認のうえで判断してください。

完全な一覧は **[docs/安全須知.md](docs/安全須知.md)**（セキュリティ注意事項）にあります。

---

## ライセンス

[MIT License](LICENSE)。著作権表示を保持する限り、自由に使用・改変・再配布・商用利用が
できます。

運用者は引き続き、デプロイ環境のネットワークセキュリティとアクセス制御、接続する AI モデルの
ライセンス遵守、および本システムで処理されるデータの適法性と守秘義務について責任を負います。

---

## ドキュメント

詳細ドキュメントは繁体字中国語で書かれています。この README は英語版・日本語版を用意しており、
`docs/` 配下にも `.en.md` / `.ja.md` の翻訳があります。

| ドキュメント | 繁體中文 | English | 日本語 |
|---|---|---|---|
| アーキテクチャ | [架構.md](docs/架構.md) | [架構.en.md](docs/架構.en.md) | [架構.ja.md](docs/架構.ja.md) |
| デプロイ | [部署.md](docs/部署.md) | [部署.en.md](docs/部署.en.md) | [部署.ja.md](docs/部署.ja.md) |
| 統合設定 | [整合設定.md](docs/整合設定.md) | [整合設定.en.md](docs/整合設定.en.md) | [整合設定.ja.md](docs/整合設定.ja.md) |
| セキュリティ | [安全須知.md](docs/安全須知.md) | [安全須知.en.md](docs/安全須知.en.md) | [安全須知.ja.md](docs/安全須知.ja.md) |
| 開発フロー | [開發流程.md](docs/開發流程.md) | [開發流程.en.md](docs/開發流程.en.md) | [開發流程.ja.md](docs/開發流程.ja.md) |
| 変更履歴 | [CHANGELOG.md](CHANGELOG.md) | [CHANGELOG.en.md](CHANGELOG.en.md) | [CHANGELOG.ja.md](CHANGELOG.ja.md) |
