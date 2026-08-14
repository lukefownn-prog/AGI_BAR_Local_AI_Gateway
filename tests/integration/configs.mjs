/**
 * 產生各客戶端可直接貼上的設定。
 *
 * 探針只能告訴你「能不能連」，設定還是得人工填。這裡把正確的值組好，
 * 減少手打錯 Base URL 或漏掉關鍵設定的機會 —— 這兩件事佔了串接失敗的大宗。
 */

/** Key 一律遮蔽，避免報表被貼進 Issue 時外洩。 */
export function maskKey(key) {
  if (!key) return '<你的 API Key>';
  return `${key.slice(0, 14)}…${key.slice(-4)}`;
}

export function codexConfigToml(base, { masked = true, key } = {}) {
  return `# ~/.codex/config.toml
# 由 tests/integration/client-compat.mjs 產生

model = "agi-bar-default"
model_provider = "agibar"

[model_providers.agibar]
name = "AGI BAR"
base_url = "${base}/v1"
env_key = "OPENAI_API_KEY"

# 關鍵：新版 Codex 預設走 OpenAI Responses API（/v1/responses），
# AGI BAR 只提供 /v1/chat/completions，不加這行會連不上。
wire_api = "chat"
`;
}

export function codexEnv(base, key, { masked = true } = {}) {
  const k = masked ? maskKey(key) : key;
  return {
    bash: `export OPENAI_BASE_URL="${base}/v1"\nexport OPENAI_API_KEY="${k}"`,
    powershell: `$env:OPENAI_BASE_URL = "${base}/v1"\n$env:OPENAI_API_KEY = "${k}"`,
  };
}

export function cursorSteps(base, key, { masked = true } = {}) {
  const k = masked ? maskKey(key) : key;
  return [
    '開啟 Settings → Models',
    '在 OpenAI API Key 欄位填入：' + k,
    '勾選 Override OpenAI Base URL',
    `Base URL 填入：${base}/v1`,
    '在自訂模型清單新增：agi-bar-default',
    '停用其他雲端模型（否則 Cursor 可能仍走原本的服務）',
    '按 Verify 確認連線',
  ];
}

export function claudeCodeEnv(base, key, { masked = true } = {}) {
  const k = masked ? maskKey(key) : key;
  return {
    bash: `export ANTHROPIC_BASE_URL="${base}"\n`
      + `export ANTHROPIC_AUTH_TOKEN="${k}"\n`
      + 'export ANTHROPIC_MODEL="agi-bar-default"',
    powershell: `$env:ANTHROPIC_BASE_URL = "${base}"\n`
      + `$env:ANTHROPIC_AUTH_TOKEN = "${k}"\n`
      + '$env:ANTHROPIC_MODEL = "agi-bar-default"',
    note: 'ANTHROPIC_BASE_URL 不加 /v1 —— SDK 會自己補上 /v1/messages。',
  };
}

export function curlChecks(base, key, { masked = true } = {}) {
  const k = masked ? maskKey(key) : key;
  return {
    models: `curl ${base}/v1/models -H "Authorization: Bearer ${k}"`,
    chat: `curl ${base}/v1/chat/completions \\\n`
      + `  -H "Authorization: Bearer ${k}" \\\n`
      + '  -H "Content-Type: application/json" \\\n'
      + '  -d \'{"model":"agi-bar-default","messages":[{"role":"user","content":"你好"}]}\'',
    messages: `curl ${base}/v1/messages \\\n`
      + `  -H "x-api-key: ${k}" \\\n`
      + '  -H "anthropic-version: 2023-06-01" \\\n'
      + '  -H "Content-Type: application/json" \\\n'
      + '  -d \'{"model":"agi-bar-default","max_tokens":256,"messages":[{"role":"user","content":"你好"}]}\'',
  };
}

/** 人工才能完成的步驟。探針跑完之後，這些還是得有人去點。 */
export const MANUAL_STEPS = {
  cursor: [
    '在 Cursor 中按 Verify，確認顯示成功',
    '開一個新 Chat 送出訊息，確認有回應且是串流逐字出現',
    '確認管理台「紀錄」頁出現對應的請求',
    '注意：Tab 補全與 Composer 的部分功能走 Cursor 自家伺服器，不會經過 AGI BAR。'
      + '需要完全本地化時只使用 Chat，並確認 Base URL 覆寫已生效',
  ],
  codex: [
    '寫入 ~/.codex/config.toml（內容見上方）',
    '設定 OPENAI_API_KEY 環境變數',
    '執行一次簡單任務，例如 codex "說明這個專案在做什麼"',
    '確認輸出是串流的，且管理台「紀錄」頁有對應請求',
    '若 Codex 版本較新且仍嘗試連 /v1/responses，確認 wire_api = "chat" 有生效',
  ],
  'claude-code': [
    '設定三個 ANTHROPIC_ 環境變數（注意 BASE_URL 不加 /v1）',
    '執行 claude 並送出一則訊息',
    '若要用 Agent 功能，確認後端本地模型支援 tool calling —— '
      + '不支援的話 Agent 會受限，那是模型的限制不是 Gateway 的問題',
  ],
  deepseek: [
    '在 AI 主機設定 DEEPSEEK_API_KEY 環境變數（不要寫進 config.json）',
    '把 config.json 的 cloud-deepseek 改為 enabled: true 並重啟',
    '只把它加入特定人員的 Model Route 末位，作為本地模型全離線時的備援',
    '確認這是刻意的決定 —— 啟用等同同意該路由的 Prompt 送出本機網路',
  ],
  app: [
    '把網頁前端的來源加入 config.json 的 security.allowedOrigins',
    '重啟服務後確認瀏覽器 CORS 預檢通過',
    '確認 API Key 沒有硬編在前端程式碼中',
  ],
};
