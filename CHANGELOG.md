# Changelog

本檔案格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，
版本號採用 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

## [Unreleased]

### 新增

**Anthropic Messages API 相容端點（M16，Issue #1）**

Claude Code 走的是 Anthropic 格式，本地模型幾乎只講 OpenAI 格式。
先前的做法是外掛相容代理，現改為在 Gateway 內建轉譯 —— 走代理會讓用量統計
少一層歸屬，且多一個要維運的元件。

- `POST /v1/messages`，支援 `stream: true`
- `POST /v1/messages/count_tokens`
- `GET /v1/models` 帶 `anthropic-version` 標頭時回 Anthropic 格式清單
- 錯誤改用 `{"type":"error","error":{...}}` 格式，型別依 HTTP 狀態碼對應
- 驗證同時接受 `x-api-key`（Anthropic 慣例）與 `Authorization: Bearer`
- 容忍 `ANTHROPIC_BASE_URL` 誤含 `/v1` 造成的 `/v1/v1/messages`

轉譯涵蓋：`system` 頂層參數 ↔ system 訊息、content block ↔ 字串/part 陣列、
`image` block ↔ `image_url`、`tool_use` ↔ `tool_calls`、`tool_result` ↔ `role: "tool"`、
`input_schema` ↔ `function.parameters`、`stop_reason` ↔ `finish_reason`，
以及完整的 Anthropic SSE 事件狀態機（`message_start` → `content_block_start` →
`content_block_delta`（`text_delta` / `input_json_delta`）→ `content_block_stop` →
`message_delta` → `message_stop`）。

**兩種協定共用同一條管線與同一份配額。** `/v1/messages` 與 `/v1/chat/completions`
都走 `gateway.admit()`，驗證、時段、Token 額度、佇列優先權、Failover 與紀錄完全一致，
沒有任何旁路。

- 測試從 47 項增加到 86 項（新增 23 項轉譯單元測試 + 16 項端對端測試）

**壓力測試與驗收腳本（M14，Issue #2）**

`tests/load/loadtest.mjs`，四個情境：

- `steady` — 封閉迴圈，N 人持續加壓；驗證佇列排隊、優先權排序與 anti-starvation
- `burst` — 開放迴圈灌爆佇列；驗證過載時乾淨回 429/503/504 而非崩潰
- `longrun` — 單筆長回應；驗證不被 `requestTimeoutMs` 切斷
- `quota` — 驗證 RPM、單次上限、每日額度真的擋得住，事後自動還原

驗收判定分致命與觀察兩級。效能類（p50/p95）刻意不列為致命 ——
換一台機器數字就不同，不該讓「這台比較慢」變成驗收失敗。

- 新增 `X-Request-Id` 回應標頭。客戶端得以與 `request_logs` 逐筆對帳，
  這是「無請求遺失」唯一可信的驗證方式，客訴追查也用得上。
- `--self-test` 模式內建 Gateway 與假模型農場，不需 GPU。
  CI 每次都會跑一輪迷你壓測，避免這支平常不執行的腳本在兩次驗收之間爛掉。
- 測試人員一律以 `loadtest-` 開頭並自動清除，中途 Ctrl+C 也會清。

**客戶端串接驗證腳本（M11，Issue #1）**

`tests/integration/client-compat.mjs`。Cursor 與 Codex 是 GUI / CLI 工具無法自動化點擊，
但它們**實際會送出的請求形狀**可以驗 —— 端點、標頭、參數組合、串流格式、
工具呼叫的訊息序列。腳本打完這些之後印出可直接貼上的設定與剩餘的人工清單。

探測過程找出兩個真實問題：

- **Codex 需要 `wire_api = "chat"`。** 新版 Codex CLI 預設走 OpenAI Responses API
  （`POST /v1/responses`），AGI BAR 沒有這個端點。少了這行會連不上，
  錯誤訊息也不會指出原因。產生的 `codex-config.toml` 已帶上。
- **`tokensPerRequest` 預設 8192 太小。** IDE 類客戶端會把整份檔案塞進 prompt，
  動輒上萬 token；8192 會讓小型測試全過、實際使用卻大量 413。
  已改為 32768，與範例主力模型的 `contextWindow` 對齊。

### 修正
- `config.example.json` 的 `limits.defaultUserLimits.tokensPerRequest`：8192 → 32768

- 測試從 86 項增加到 125 項

### 待辦
- M11 各客戶端的實機點擊驗證（API 層面已全數通過，Issue #1）
- M14 對真實 GPU 主機與 LAN 多機的實機驗收（腳本已完成，Issue #2）

---

## [1.2.0] - 2026-08-07

首個完整實作版本，對應《AGI BAR V1.2 規畫書 — GitHub Workflow Edition》。

### 新增

**專案骨架（規畫書 11）**
- Portable 目錄結構，零 npm 相依（`node:http` + `node:sqlite` + `node:crypto`）
- `啟動 AGI BAR.cmd` / `關閉 AGI BAR.cmd` 透明批次腳本，含 Node 版本檢查與 PID 精準關閉
- 首次啟動自動由 `config.example.json` 產生 `config/config.json`

**Web 管理台（規畫書 4）**
- 管理員登入：scrypt 密碼雜湊、HMAC 簽章 Session Cookie、登入速率限制
- 儀表板：人員數、在線人數、API 請求數、今日 Token、Queue、GPU/VRAM、主要模型、Internet 狀態
- 七項左側選單：儀表板 / 人員 / API / AI 模型 / 網路 / 紀錄 / 設定
- 網頁聊天頁（`/chat.html`），人員以自己的 API Key 連線

**人員與 API Key（規畫書 5）**
- 人員 CRUD，上限 50 位，狀態 啟用/暫停/停用
- API Key `agi-bar-xxxxxxxx`，明文僅建立當下顯示一次，DB 只存 SHA-256 雜湊與識別前綴
- Key 換發、暫停、撤銷；換發後舊 Key 立即失效

**配額與時間權限（規畫書 5、6）**
- 四層 Token 限制：單次 → 每小時 → 每日 → 每月，Input + Output 皆計入
- 有效日期起訖、每日時段（支援跨午夜）、可用星期
- RPM 滑動視窗、Concurrent 同時請求數
- 超額政策：Hard 拒絕 / Soft 自動降級至鏈上最小模型

**OpenAI 相容 API（規畫書 10）**
- `/v1/models`、`/v1/models/:id`、`/v1/chat/completions`（含 SSE 串流）、`/v1/completions`
- `/v1/me` 供客戶端查詢自身額度
- 一般人員只看得到模型別名，不揭露後端真實模型名稱

**模型與路由（規畫書 7、8）**
- 模型註冊由 `config.models.catalog` 同步，設定檔移除時停用而非刪除，保留歷史紀錄
- Health Check 記錄 Online/Offline、平均首 Token 延遲、Token/s、Queue、錯誤率、VRAM
- 每人獨立 Model Routing Chain，順位 1 離線/壅塞/健康檢查失敗時自動 Failover
- Priority Queue（P0–P3）含 anti-starvation 權重提升，避免低優先請求飢餓

**受控上網（規畫書 9）**
- Web Search / URL Fetch 安全代理
- 先 DNS 解析再對**解析後的 IP** 判斷內網範圍，防 DNS rebinding 與內網主機名繞過
- 每一次重導向都重新驗證政策
- 預設封鎖 `127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、
  `169.254.0.0/16`、`::1`、`fc00::/7`、`fe80::/10`
- 限制 scheme、Content-Type 白名單、最大下載大小與逾時，全程寫入 `web_access_logs`
- 管理台提供政策測試工具

**紀錄與備份（規畫書 12、13）**
- `usage_logs` / `request_logs` / `web_access_logs` / `audit_logs`
- 用量報表：依人員、依日期、依模型
- 預設只記錄 Prompt 雜湊，不記錄內容
- SQLite `VACUUM INTO` 一致性備份，啟動時與排程自動執行，保留份數可設定
- 設定匯出排除 `admin` 與 `security` 區段

**測試**
- 47 項測試：佇列優先權與 anti-starvation、時間權限、SSRF/CIDR 防護，
  以及端對端管線（登入 → 建人員 → 發 Key → 配額 → 路由 → Failover → 紀錄）

**GitHub 工作流（規畫書 15、16）**
- `.gitignore` 涵蓋規畫書 16.1「絕對不可上傳的資料」全部項目
- Issue / PR 範本、分支規則文件
- GitHub Actions：語法檢查 → 單元測試 → API 測試 → 安全掃描 → Portable 結構檢查
- Release 建置腳本，產生 ZIP 與 SHA-256

### 安全性
- 管理台 CSP 限定 `'self'`，不引用任何外部資源
- 靜態檔服務限制在 `web/` 目錄內，防路徑穿越
- 登入失敗時帳號錯誤與密碼錯誤回傳相同訊息，避免帳號列舉
- 外部雲端模型需 `requiresExplicitConsent` 明確授權，未授權拒絕送出內容
- `PATCH /api/settings` 採白名單，無法透過該端點竄改管理員帳密或祕鑰

[Unreleased]: https://github.com/lukefownn-prog/agi-bar/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/lukefownn-prog/agi-bar/releases/tag/v1.2.0
