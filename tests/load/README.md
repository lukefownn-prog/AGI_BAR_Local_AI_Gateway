# M14 壓力測試與驗收

> 對應規畫書第 14 節「V1 驗收標準」與 [Issue #2](https://github.com/lukefownn-prog/AGI_BAR_Local_AI_Gateway/issues/2)。

## 兩種模式

| 模式 | 用途 | 需要 GPU |
|---|---|---|
| `--self-test` | 驗證**腳本本身**沒壞。內建 Gateway + 假模型農場 | ✗ |
| 一般模式 | 對真實部署加壓，這才是 M14 的**正式驗收** | ✓ |

自我測試模式由 CI 每次執行（`tests/loadtest.test.mjs`），確保驗收當天腳本是能用的。
壓測腳本平常不會跑，最容易在兩次驗收之間隨程式改動而爛掉。

## 快速開始

先確認腳本本身正常：

```bash
node tests/load/loadtest.mjs --self-test
```

對真實部署加壓：

```bash
node tests/load/loadtest.mjs --url http://192.168.1.100:8787 --admin-pass "你的管理員密碼" --users 10 --duration 60
```

## 參數

| 參數 | 預設 | 說明 |
|---|---|---|
| `--url` | `http://127.0.0.1:8787` | Gateway 位址 |
| `--admin-user` | `admin` | 管理員帳號 |
| `--admin-pass` | — | 管理員密碼（建立測試人員用） |
| `--scenario` | `all` | `all` / `steady` / `burst` / `longrun` / `quota` |
| `--users` | `10` | 虛擬人員數，依 P0/P1/P2/P3 輪流分配 |
| `--duration` | `30` | `steady` 情境的持續秒數 |
| `--max-tokens` | `64` | 每次請求的輸出上限 |
| `--prompt-chars` | `400` | 輸入長度 |
| `--stream` | 關 | 改用 SSE 串流 |
| `--protocol` | `openai` | `openai` 或 `anthropic`（測 Claude Code 路徑） |
| `--json <檔案>` | — | 輸出原始資料供後續分析 |
| `--keep-users` | 關 | 結束後保留測試人員 |

離開碼：**0** 通過、**1** 未通過、**2** 執行錯誤。可直接串進部署腳本。

## 四個情境

**`steady`** — 封閉迴圈，N 位虛擬人員持續加壓。對應驗收項目「10 人同時送出請求，
Queue 正常排隊、無請求遺失」與「低優先請求不會餓死」。

**`burst`** — 開放迴圈，瞬間灌入遠超佇列容量的請求量。確認過載時是**乾淨地回
429/503/504**，而不是崩潰、逾時或請求無聲消失。

**`longrun`** — 單筆長回應。確認不會被 `server.requestTimeoutMs` 中途切斷。

**`quota`** — 把 RPM、單次上限、每日額度調到極小，確認真的擋得住，事後自動還原。

## 驗收判定

報表最後會逐項列出。`✗` 是必須修正，`!` 只是觀察值。

| 判定 | 意義 | 致命 |
|---|---|---|
| 無請求遺失 | 每筆請求都有終局狀態 | ✓ |
| 請求皆寫入 request_logs | 客戶端的 `X-Request-Id` 都能在伺服器紀錄中找到 | ✓ |
| 無非預期錯誤 | 錯誤只能是佇列/配額類，不能有 500 或連線中斷 | ✓ |
| Token 計量相符 | 伺服器與客戶端統計的 Token 差異在容許範圍 | ✓ |
| 低優先權未被餓死 | P3 至少要有請求完成 | ✓ |
| 結束時佇列已排空 | 輪詢等待後仍未排空 = 佇列名額洩漏 | ✓ |
| 高優先權等待較短 | P0 中位等待 ≤ P3 | ✗ |
| 低優先權最久等待 | P3 最久等待在上限內 | ✗ |

效能類判定刻意**不列為致命** —— 換一台機器數字就不同，不該讓「這台比較慢」變成驗收失敗。

### 兩個容易誤判的地方

**佇列排空要用輪詢，不能立刻判定。** Gateway 是先把回應寫出去、才在 `finally`
釋放佇列名額（這順序是對的：提早釋放會讓下一筆在本筆還在寫入時就被放行，造成超額併發）。
因此客戶端的 fetch 完成時，伺服器可能還算它在執行中。腳本會輪詢等待 8 秒，
等過還是排不空才判定失敗。

**`request_too_large` 是預期內錯誤。** `quota` 情境會刻意觸發它。

## 正式驗收的建議流程

```bash
# 1. 基準：確認 10 人常態負載下一切正常
node tests/load/loadtest.mjs --url http://<AI主機IP>:8787 --admin-pass "…" \
  --users 10 --duration 120 --json baseline.json

# 2. 串流：真實客戶端多半用串流，延遲特性不同
node tests/load/loadtest.mjs --url http://<AI主機IP>:8787 --admin-pass "…" \
  --users 10 --duration 120 --stream --json stream.json

# 3. Anthropic 路徑（Claude Code）
node tests/load/loadtest.mjs --url http://<AI主機IP>:8787 --admin-pass "…" \
  --users 6 --duration 60 --protocol anthropic --json anthropic.json

# 4. 滿載：逼近規畫書的 50 人上限
node tests/load/loadtest.mjs --url http://<AI主機IP>:8787 --admin-pass "…" \
  --users 40 --duration 180 --json full.json
```

每一輪都要同時盯著：

- 管理台儀表板的 **VRAM 使用率**（`queue.maxGlobalConcurrent` 設太高會 OOM）
- AI 主機的 `nvidia-smi`
- `data/logs/agibar-YYYY-MM-DD.log` 有無 error

依觀察到的「平均等待」與 VRAM 餘裕調整 `queue.maxGlobalConcurrent`，再重跑。

## Failover 驗證（需人工介入）

腳本不會自己去關模型。跑 `steady` 的過程中，手動停掉順位 1 的模型伺服器，
應觀察到：

- 請求持續成功，不中斷
- 管理台「AI 模型」頁順位 1 轉為離線
- 「紀錄」頁出現 Failover 標記
- 報表中 `steady` 情境的 p95 上升但成功率維持

## 注意事項

- 測試人員一律以 `loadtest-` 開頭，結束時自動刪除；中途 Ctrl+C 也會清。
  上一輪若有殘留，下次執行會先清掉。
- 人員上限 50 位是硬限制。若既有人員已接近上限，`--users` 要調低，
  腳本會先算剩餘名額並明確報錯。
- 測試人員的配額刻意開得很大，避免壓測撞到額度而不是撞到佇列 ——
  那是 `quota` 情境要驗的事。
- **不要對正式營運中的主機跑滿載測試。** 會排擠真實使用者。
