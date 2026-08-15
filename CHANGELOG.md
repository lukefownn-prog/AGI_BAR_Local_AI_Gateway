# Changelog

本檔案格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，
版本號採用 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

## [Unreleased]

### 新增

**紀錄保留期同時套用到資料庫（`server/services/retention.mjs`）**

`logging.retentionDays` 原本只清 `data/logs/` 底下的日誌檔，
資料庫裡的 `usage_logs` / `request_logs` / `audit_logs` 則是永久成長 ——
而設定頁寫著「紀錄保留 30 天」，管理員會合理地以為兩者都算。現在那句話對資料庫也成立。

- 啟動時清一次，之後每 24 小時再清一次。**啟動時就清**很重要：這套會被搬到不同場所、
  關機再開，只靠常駐排程的話開機時間不夠長就永遠輪不到
- 清理排在啟動備份**之前** —— 反過來的話備份會把正要刪掉的資料一起收進快照
- `retentionDays` 設 0 或負數視為永久保留，不刪任何資料（唯一的安全閥）
- 只動三張紀錄表；人員、API Key、模型、路由、設定一律不碰
- 三張表都有 `ts` 索引，刪除走索引不會全表掃描
- 設定頁補上說明與「上次清理」時間，三種語言皆有
- 新增 7 項測試（邊界、安全閥、預設值回退、不該被碰的資料表）

### 修正

**在對話框欄位裡拖曳選字會誤關對話框**

在「新增人員」的 Token 欄位裡按住往外拖曳選取數字、放開在對話框外時，
整個對話框會關閉，已填好的欄位全部消失。用鍵盤逐字刪除則不會 ——
因為根本沒碰到滑鼠，所以看起來像「有時候會、有時候不會」。

原因是 `modal()` 只判斷 `click` 事件的 `target` 是否為遮罩。
但 `click` 的 target 是 mousedown 與 mouseup 兩個目標的**最近共同祖先** ——
在輸入框內按下、在對話框外放開時，共同祖先剛好就是遮罩本身。

- 改為 `pointerdown` + `pointerup`，兩者都落在遮罩上才關閉
- 一併修掉 Escape 監聽器的殘留：舊版只有在按 Escape 那條路徑才解除，
  用 ✕／取消／點遮罩關閉都會在 `document` 上留下一個 keydown 監聽器
- 管理台與網頁聊天共用同一個 `modal()`，兩邊都受惠

**初始管理員的顯示名稱不再寫死中文**

`bootstrapAdmin()` 過去會把 `系統管理員` 直接寫進 `users.display_name`。
那是預設值而非管理員填的資料，但一旦落進資料庫，介面只能照實顯示 ——
切到英文／日文時，整個管理台就只剩這一格是中文（右上角、人員清單、紀錄頁）。

- 初始管理員改為不預填顯示名稱，介面回退顯示帳號（`admin`），三種語言一致
- 既有資料庫在啟動時正規化：只清除 `role = 'admin'` 且值完全等於舊預設字串的那筆，
  管理員自己填的姓名（含其他人員）一律不動
- 人員清單的「姓名」欄在未填時改顯示帳號，不再是 `—`

### 移除

**受控上網（Web Search / URL Fetch）整組功能**

管理台的「網路」頁、`/v1/tools/*` 工具端點與相關配額欄位全部移除。
AGI BAR 回歸單純的網關職責：驗證、配額、排隊、路由、紀錄。

- 刪除 `server/services/websafe.mjs` 與 `tests/websafe.test.mjs`
- 刪除 `POST /v1/tools/web_search`、`POST /v1/tools/url_fetch`
- 刪除 `GET/PATCH /api/internet`、`POST /api/internet/test`、`GET /api/logs/web`
- 刪除管理台「網路與安全上網」頁與側邊欄項目、儀表板的「Internet 狀態」卡、
  紀錄頁的「受控上網紀錄」面板
- **新增人員／配額設定的「允許上網」欄位取消**，API Key 總表的「上網」欄一併移除
- 設定檔移除整個 `internet` 區塊與 `limits.defaultUserLimits.internetAllowed`
- schema 移除 `api_key_limits.internet_allowed`、`request_logs.used_internet`
  與 `web_access_logs` 資料表（既有資料庫的欄位都有預設值，不需手動遷移）

**保留管理台的存取隔離。** `security.adminAccess` 維持原樣 ——
預設只有 AI 主機本機能開管理台，區網人員連 `/app.html` 與 `/api/*` 一律回 404，
管理台看起來就像不存在。這項判定所需的 `ipInCidr` 已從 `services/websafe.mjs`
搬到 `core/net.mjs`，對應的 CIDR 測試也移入 `tests/net.test.mjs`。

### 新增

**網頁介面多語系與語言切換下拉選單**

管理台、登入頁與網頁聊天三個頁面都加上語言下拉選單，
支援**繁體中文 / English / 日本語**。

- 新增 `web/assets/i18n.js` —— 字典、`t()` 取詞、`{變數}` 代入、語言偵測與切換事件，
  零相依、無建置流程，與專案其他部分一致
- 首次進站以瀏覽器語言自動判斷（`ja` / `zh` / `en`），選過之後記在 localStorage，
  重新整理與換頁都會沿用，同時同步 `<html lang>`
- 靜態 HTML 以 `data-i18n` / `data-i18n-html` / `data-i18n-placeholder` /
  `data-i18n-title` 標記；動態渲染的內容改走 `t()`
- 切換語言不重新載入頁面：管理台重跑目前分頁的渲染函式，
  聊天頁只換介面文字，**已送出的對話內容會保留**
- 涵蓋全部介面文字，包含表格標題、對話框、Toast、確認訊息、
  狀態與優先級標籤、星期名稱，以及「怎麼新增模型」整段說明
- 數字格式（`toLocaleString`）與星期分隔符號跟著語言走

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

**管理介面存取隔離（M17）**

預設只有 AI 主機本機能開管理台；區網人員只看得到 `/v1` 與網頁聊天。

- `/app.html`、`/api/*`、管理台專用的 JS 對區網一律回 **404**
  （403 等於承認「這裡有東西」，404 讓管理台看起來不存在）
- 區網打根路徑導向 `/chat.html`，而不是丟一個死路
- `/api/health` 維持開放供監控與部署腳本使用
- 新增 `security.adminAccess`（`loopback` / `lan`）與 `security.adminAllowedCidrs`

判定依據是 **TCP 連線的對端位址**，不是 `X-Forwarded-For` ——
後者是請求標頭，任何人都能自填，拿來做存取控制等於沒有控制。
測試中有一項專門確認偽造 `X-Forwarded-For` 不影響授權判定。

啟動橫幅改為分別列出「管理介面（僅限本機）」與「給人員的位址」。

**管理台可直接新增本地模型（M18）**

原本要新增模型得手動編輯 `config/config.json` 再重啟 —— 這違反規畫書 §4
「一般網店後台模式，避免做成工程師伺服器控制台」。

「AI 模型」頁新增 **＋ 新增模型**：填端點 → 探索 → 勾選 → 加入，立即生效不需重啟。

- `POST /api/models/discover` 列出端點上已安裝的模型
- `GET /api/models/presets` 提供 Ollama / LM Studio / llama.cpp / vLLM 的預設端點
- `POST /api/models`、`DELETE /api/models/:id`
- 模型代號由上游名稱自動產生（`hf.co/Qwen/Qwen3-8B-GGUF:Q5_0` →
  `hf-co-qwen-qwen3-8b-gguf-q5-0`），可再修改
- 新增的模型會自動排進預設路由 —— 沒進路由的話模型雖然存在卻不會被任何請求選到
- 移除時一併從設定檔、預設路由與各人員路由中清掉

寫回 `config.json` 再重新同步，設定檔仍是唯一來源；只寫資料庫的話下次重啟會被覆蓋。

已對真實 Ollama 實測：探索兩個模型、加入、健康檢查 online、實際對話成功。

### 修正
- `config.example.json` 的 `limits.defaultUserLimits.tokensPerRequest`：8192 → 32768
- **測試環境隔離**。`tests/access.test.mjs` 靜態 import 了 server 模組，
  而 ESM 會先求值所有 import 才執行頂層敘述，導致 `core/paths.mjs` 在
  `AGIBAR_DATA_DIR` 設定前就固定路徑 —— 測試其實是跑在**正式資料庫**上，
  而且不會變紅，只會在某天弄髒或鎖住正式資料時才被發現。
  新增 `tests/helpers/isolate.mjs`（必須是第一個 import）與 `assertIsolated()`，
  讓這類錯誤變成明確的失敗。已驗證跑完整套測試後正式資料庫的 mtime 未變。

- 測試從 86 項增加到 154 項

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
