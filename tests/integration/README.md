# M11 客戶端串接驗證

**繁體中文** ｜ [English](README.en.md) ｜ [日本語](README.ja.md)

> 對應規畫書第 10 節與 [Issue #1](https://github.com/lukefownn-prog/AGI_BAR_Local_AI_Gateway/issues/1)。

## 這支腳本能做什麼、不能做什麼

Cursor 與 Codex 是 GUI / CLI 工具，**沒辦法自動化點擊**。

能自動驗的是它們**實際會送出的請求形狀** —— 端點、標頭、參數組合、串流格式、
工具呼叫的訊息序列。腳本把這些全打一遍，在你動手設定之前先找出會卡住的地方，
然後印出可直接貼上的設定與剩餘的人工清單。

真正的「開啟 Cursor 按下 Verify」還是得有人做。

## 用法

```bash
node tests/integration/client-compat.mjs --self-test          # 驗證腳本本身
node tests/integration/client-compat.mjs --url http://192.168.1.100:8787 --key agi-bar-xxxxxxxx
node tests/integration/client-compat.mjs --url http://… --admin-pass "密碼" --client codex
```

沒有現成 Key 時用 `--admin-pass`，腳本會建一位 `compat-probe` 人員、跑完自動刪除。
它刻意沿用設定檔的**預設配額**（只放寬時間窗），這樣「大型上下文」那項探針
反映的才是真實人員會遇到的限制。

| 參數 | 說明 |
|---|---|
| `--url` | Gateway 位址 |
| `--key` | 用既有的 API Key 探測 |
| `--admin-pass` | 沒有 Key 時自動建立探測人員 |
| `--client` | `all` / `cursor` / `codex` / `claude-code` / `app` / `deepseek` |
| `--emit <目錄>` | 產生設定檔（config.toml、env.sh、env.ps1、smoke.sh） |
| `--show-secrets` | 設定中顯示完整 API Key（**預設遮蔽**） |
| `--json <檔案>` | 輸出原始結果 |

離開碼：0 通過 / 1 有必要條件未通過 / 2 執行錯誤。

## 兩個已知的坑

腳本會直接標出來，這裡先講清楚為什麼：

### Codex：必須設 `wire_api = "chat"`

新版 Codex CLI **預設走 OpenAI Responses API**（`POST /v1/responses`），
AGI BAR 只提供 `/v1/chat/completions`。不加這行會連不上，而且錯誤訊息通常
不會直接告訴你原因。

```toml
# ~/.codex/config.toml
model = "agi-bar-default"
model_provider = "agibar"

[model_providers.agibar]
name = "AGI BAR"
base_url = "http://192.168.1.100:8787/v1"
env_key = "OPENAI_API_KEY"
wire_api = "chat"        # ← 關鍵
```

`--emit` 產生的 `codex-config.toml` 已經帶上這行。

### 單次 Token 上限要夠大

IDE 類客戶端會把整份檔案塞進 prompt，動輒上萬 token。
`tokensPerRequest` 設 8192 的話，**小型測試請求全部會過、實際使用卻大量 413** ——
這種問題只有壓大 payload 才看得出來，所以探針刻意用約 10000 tokens 的寫實尺寸。

設定檔預設值已調為 32768，與範例主力模型的 `contextWindow` 對齊。
換模型時記得一起檢查。

## Base URL 的差異

三家客戶端不一樣，是最常見的手滑來源：

| 客戶端 | 環境變數 | 要不要加 `/v1` |
|---|---|---|
| Cursor | Override OpenAI Base URL | **要** |
| Codex | `OPENAI_BASE_URL` | **要** |
| Claude Code | `ANTHROPIC_BASE_URL` | **不要**（SDK 自己補 `/v1/messages`） |

Claude Code 誤加 `/v1` 會變成 `/v1/v1/messages`。Gateway 兩種路徑都收，
但正確寫法是不加。

## 探針涵蓋範圍

**共通** — Bearer 驗證、無效 Key 拒絕、`/v1/models` 結構、錯誤格式、`X-Request-Id`

**Cursor** — Verify 探測請求、任意模型名稱路由（清單裡留著 `gpt-4o` 也要能用）、
串流、`stream_options.include_usage`、取樣參數透傳、大型上下文、`/v1/embeddings` 現況

**Codex** — 模型清單、`/v1/responses` 檢測、`wire_api="chat"` 路徑、
工具定義、**工具結果回填**（agent 第二輪的 `role=tool` 訊息，這關不過 Codex 會在
第一次呼叫工具後就卡住）、串流、未知參數容忍度

**Claude Code** — `/v1/messages`、`x-api-key` 標頭

**自製 App** — CORS 預檢現況

**DeepSeek** — 外部雲端模型的授權閘門（確認沒有意外啟用）

## 人工步驟

報表最後會列出。摘要：

- **Cursor**：按 Verify → 開 Chat 送訊息 → 確認管理台「紀錄」頁有對應請求。
  注意 Tab 補全與 Composer 部分功能走 Cursor 自家伺服器，不會經過 AGI BAR。
- **Codex**：寫入 `~/.codex/config.toml` → 設 `OPENAI_API_KEY` → 跑一次簡單任務。
- **Claude Code**：設三個 `ANTHROPIC_` 環境變數 → 執行 `claude`。
  Agent 功能取決於後端模型是否支援 tool calling。

## CI 保護

`tests/client-compat.test.mjs` 每次 CI 都跑一輪。理由與壓測腳本相同：
這支平常不會執行，最容易在兩次驗收之間隨程式改動而爛掉。

其中一項測試刻意斷言 **`/v1/responses` 仍未實作** —— 哪天真的實作了，
測試會失敗並提醒回頭移除「必須加 wire_api」的說明。

## 注意事項

- **一個行程只能有一套 `--self-test` 環境。** `core/paths.mjs` 在模組載入時就固定
  資料目錄，`core/config.mjs` 也會快取設定，第二次會沿用第一次的（已關閉的）環境。
  需要多組情境請分行程執行。
- 產生的設定檔預設遮蔽 API Key。用 `--show-secrets` 產出的檔案含完整金鑰，
  **不要提交到版本庫**。
