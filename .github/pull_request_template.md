## 這個 PR 做了什麼

<!-- 一兩句話說明。對應哪個規畫書章節？ -->

Closes #

## 變更類型

- [ ] feat — 新功能
- [ ] fix — Bug 修正
- [ ] docs — 文件
- [ ] refactor — 重構（行為不變）
- [ ] test — 測試
- [ ] chore — 建置/工具

## 檢查清單

- [ ] 只修改了該 Issue 範圍內的檔案
- [ ] `node scripts/lint.mjs` 通過
- [ ] `node --test tests/` 全數通過
- [ ] `node scripts/security-scan.mjs` 通過
- [ ] 新增或修改的行為有對應測試
- [ ] 有變更行為時已更新 `CHANGELOG.md`
- [ ] 有新增設定欄位時已更新 `config/config.example.json` 與文件

## 安全確認（規畫書 16.1）

- [ ] 沒有提交 API Key、密碼、`.env`、真實 `config.json`
- [ ] 沒有提交 `*.db`、使用紀錄、員工資料
- [ ] 沒有提交模型檔（`*.gguf` 等）或憑證
- [ ] 沒有把內網 IP、NAS/路由器位址寫進程式或文件（範例位址除外）
- [ ] 沒有引入 npm 相依（Portable 零安裝原則）

## 資料庫

- [ ] 沒有變更 `server/core/schema.sql`
- [ ] 有變更，且已在 `CHANGELOG.md` 標示、`docs/部署.md` 補上遷移步驟

## 手動驗證

<!-- 實際跑過什麼？例如：以兩台 mock 模型驗證 Failover、用 Cursor 實測串接 -->
