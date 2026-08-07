# AGI BAR — Local AI Gateway Management System

以瀏覽器為主要操作介面的**本地 AI 網關管理系統**。管理員在一台 AI 主機上啟動服務後，
人員只要連上同一網路，即可透過網頁聊天，或以 **OpenAI API 相容** 方式連接各種 AI 開發工具與 App。

> 版本：**V1.2 — GitHub Workflow Edition**
> 規模：1 位 Admin + 1–50 位 User，每人獨立 API Key。

---

## 特色

| 能力 | 說明 |
|---|---|
| 獨立 API Key | 每位人員一把 `agi-bar-xxxxxxxx`，資料庫只存 SHA-256 雜湊 |
| Token 配額 | 單次 / 每小時 / 每日 / 每月四層限制，Input + Output 皆計入 |
| 時間權限 | 有效日期、每日可用時段（支援跨午夜）、可用星期 |
| 速率控制 | RPM 與 Concurrent 同時請求數 |
| 模型路由 | 每人獨立優先順序，順位 1 失效自動 Failover 到下一順位 |
| 優先佇列 | P0 管理員 / P1 高 / P2 一般 / P3 訪客 + anti-starvation |
| 安全上網 | 受控 Web Search / URL Fetch，預設封鎖所有內網位址 |
| 完整稽核 | 每次請求的等待、推理、Token、Failover 與上網行為都留存 |

**零 npm 相依。** 全部以 Node.js 內建模組實作（`node:http` + `node:sqlite` + `node:crypto`），
沒有 `node_modules`、沒有建置流程，解壓即可執行。

---

## 快速開始

### 需求

- Windows 10/11（其他平台可直接 `node server/index.mjs`）
- Node.js **24 LTS 以上**（`node:sqlite` 需免旗標支援），或把 `node.exe` 放進 `runtime/`

### 啟動

```bash
node server/index.mjs
```

Windows 管理員請直接雙擊 **`啟動 AGI BAR.cmd`**，腳本會檢查 Node 版本、建立設定檔並自動開啟瀏覽器。
停止服務請雙擊 **`關閉 AGI BAR.cmd`**（依 PID 精準關閉，不會誤殺其他 Node 程序）。

首次啟動會顯示初始管理員帳密（預設 `admin` / `agibar-admin`），
**請登入後立即於「設定」頁修改密碼。**

| 用途 | 位址 |
|---|---|
| Web 管理介面 | `http://<AI主機IP>:8787` |
| 網頁聊天 | `http://<AI主機IP>:8787/chat.html` |
| API Base URL | `http://<AI主機IP>:8787/v1` |

---

## 設定本地模型

編輯 `config/config.json` 的 `models.catalog`，指向你的 llama.cpp / Ollama / vLLM 等
OpenAI 相容端點，然後重新啟動服務：

```json
{
  "models": {
    "catalog": [
      {
        "id": "local-primary",
        "displayName": "本地主力模型",
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

模型的啟用/停用與健康檢查可在「AI 模型」頁即時操作，不需重啟。

---

## 串接外部工具

任何允許自訂 Base URL 與 API Key 的 OpenAI 相容客戶端都能連接。
Cursor、Claude Code、Codex、DeepSeek 備援與自製 App 的逐項設定，見
**[docs/整合設定.md](docs/整合設定.md)**。

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer agi-bar-你的Key" \
  -H "Content-Type: application/json" \
  -d '{"model":"agi-bar-default","messages":[{"role":"user","content":"你好"}]}'
```

---

## 專案結構

```
agi-bar/
├─ 啟動 AGI BAR.cmd     啟動腳本（透明批次檔，非未簽章 EXE）
├─ 關閉 AGI BAR.cmd     停止腳本
├─ web/                 Web UI（管理台 + 網頁聊天，無建置流程）
├─ server/              Gateway / API / Queue / Router
│  ├─ core/             設定、資料庫、加密、HTTP、日誌
│  ├─ services/         人員、Key、配額、模型、路由、佇列、上網、備份
│  └─ routes/           管理 API、OpenAI 相容 API、靜態檔
├─ scripts/             建置與檢查腳本
├─ config/              config.example.json（config.json 不進 Git）
├─ docs/                架構、部署、整合、安全文件
├─ tests/               單元測試 + 端對端測試
├─ models/              GGUF 模型（不進 Git）
├─ data/                資料庫、紀錄、備份（不進 Git）
└─ runtime/             內嵌 Node / llama.cpp（不進 Git）
```

---

## 開發

```bash
npm test
```

47 項測試涵蓋佇列優先權與 anti-starvation、時間權限、SSRF 防護，
以及一整條端對端管線（登入 → 建人員 → 發 Key → 配額 → 路由 → Failover → 紀錄）。

分支規則、PR 流程與 Release 步驟見 **[docs/開發流程.md](docs/開發流程.md)**。

---

## 安全須知

- 本系統設計為**內部網路**使用，未內建對外網際網路的防護（無 TLS 終結、無 WAF）。
  對外開放前請置於反向代理之後，並啟用 HTTPS。
- `config/config.json`、`data/`、`models/`、`runtime/` 已列入 `.gitignore`，
  **API Key、密碼、使用紀錄與模型檔不會進入版本庫**。
- 外部雲端模型（如 DeepSeek）預設停用。啟用等同同意將 Prompt 送出本機網路，
  請依公司政策評估後再開啟。

完整清單見 **[docs/安全須知.md](docs/安全須知.md)**。

---

## 授權

本專案為內部專用，未開放公開散布。詳見 [LICENSE](LICENSE)。
