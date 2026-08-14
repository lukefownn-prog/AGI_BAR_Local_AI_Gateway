/**
 * 客戶端相容性探針（M11、Issue #1）。
 *
 * Cursor 與 Codex 是 GUI / CLI 工具，沒辦法自動化點擊。能自動驗的是
 * 「它們實際會送出的請求形狀」—— 端點、標頭、參數組合、串流格式。
 * 探針打的就是這些，把人工步驟縮到最小，並在真的動手設定之前先找出會卡住的地方。
 *
 * 每個探針要說明 why：驗收時看到失敗，才知道那一項為什麼重要。
 *
 * severity：
 *   required     不過就是不能用
 *   recommended  不過會少功能或踩雷，但主要用途仍可運作
 *   info         只是回報現況，不算失敗
 */

const CHAT = '/v1/chat/completions';

/** 送出一筆最小可用的 chat completion，回傳 { status, body }。 */
async function chat(ctx, body, headers = {}) {
  return ctx.api(CHAT, { method: 'POST', body, headers });
}

/** 讀取並丟棄 SSE，回傳觀察到的事件統計。 */
async function drainSse(res) {
  const stat = { chunks: 0, contentChars: 0, sawDone: false, sawUsage: false, toolCallDeltas: 0, parseErrors: 0 };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { stat.sawDone = true; continue; }
      stat.chunks++;
      try {
        const obj = JSON.parse(payload);
        const delta = obj?.choices?.[0]?.delta;
        if (delta?.content) stat.contentChars += delta.content.length;
        if (delta?.tool_calls?.length) stat.toolCallDeltas += delta.tool_calls.length;
        if (obj?.usage) stat.sawUsage = true;
      } catch { stat.parseErrors++; }
    }
  }
  return stat;
}

const SMALL = { model: 'agi-bar-default', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] };

// ==================================================================== 共通

const common = [
  {
    id: 'common.auth-bearer',
    client: 'common',
    name: 'Authorization: Bearer 驗證',
    why: 'Cursor、Codex 與絕大多數 OpenAI 相容客戶端都用這個標頭',
    severity: 'required',
    async run(ctx) {
      const r = await ctx.api('/v1/models');
      return { ok: r.status === 200, detail: `HTTP ${r.status}` };
    },
  },
  {
    id: 'common.auth-rejects-bad-key',
    client: 'common',
    name: '錯誤的 Key 會被拒絕',
    why: '若無效 Key 也能通過，代表驗證有漏洞',
    severity: 'required',
    async run(ctx) {
      const r = await ctx.api('/v1/models', { key: 'agi-bar-definitely-invalid' });
      return { ok: r.status === 401, detail: `HTTP ${r.status}（預期 401）` };
    },
  },
  {
    id: 'common.models-shape',
    client: 'common',
    name: '/v1/models 回應結構符合 OpenAI 規格',
    why: '客戶端用 object=list 與 data[].id 來填模型下拉選單，結構不對會顯示空清單',
    severity: 'required',
    async run(ctx) {
      const r = await ctx.api('/v1/models');
      const b = r.body;
      const ok = b?.object === 'list' && Array.isArray(b?.data)
        && b.data.length > 0 && b.data.every((m) => typeof m.id === 'string' && m.object === 'model');
      return { ok, detail: ok ? `${b.data.length} 個模型：${b.data.map((m) => m.id).join(', ')}` : JSON.stringify(b).slice(0, 120) };
    },
  },
  {
    id: 'common.error-shape',
    client: 'common',
    name: '錯誤格式符合 OpenAI 規格',
    why: '客戶端靠 error.message 顯示原因；格式不對使用者只會看到「未知錯誤」',
    severity: 'required',
    async run(ctx) {
      const r = await ctx.api(CHAT, { method: 'POST', body: { model: 'x', messages: [] } });
      const e = r.body?.error;
      const ok = r.status >= 400 && typeof e?.message === 'string' && 'type' in e && 'code' in e;
      return { ok, detail: ok ? `HTTP ${r.status}：${e.message}` : JSON.stringify(r.body).slice(0, 120) };
    },
  },
  {
    id: 'common.request-id',
    client: 'common',
    name: '回應帶 X-Request-Id',
    why: '客訴追查時要能把使用者回報的請求對到 request_logs',
    severity: 'recommended',
    async run(ctx) {
      const r = await chat(ctx, SMALL);
      const id = r.headers.get('x-request-id');
      return { ok: !!id, detail: id ? id : '缺少標頭' };
    },
  },
];

// ==================================================================== Cursor

const cursor = [
  {
    id: 'cursor.verify-probe',
    client: 'cursor',
    name: 'Verify 按鈕的探測請求',
    why: 'Cursor 按下 Verify 會送一筆極小的 chat completion；這筆失敗就存不了設定',
    severity: 'required',
    async run(ctx) {
      const r = await chat(ctx, SMALL);
      return {
        ok: r.status === 200 && typeof r.body?.choices?.[0]?.message?.content === 'string',
        detail: r.status === 200 ? '可正常回應' : `HTTP ${r.status}：${r.body?.error?.message ?? ''}`,
      };
    },
  },
  {
    id: 'cursor.arbitrary-model-name',
    client: 'cursor',
    name: '自訂模型清單中的任意名稱都能路由',
    why: 'Cursor 的模型清單常留著 gpt-4o 這類名稱；Gateway 必須忽略它並走管理員設定的路由',
    severity: 'required',
    async run(ctx) {
      const results = [];
      for (const model of ['gpt-4o', 'gpt-4.1', 'agi-bar-default']) {
        const r = await chat(ctx, { ...SMALL, model });
        results.push(`${model}=${r.status}`);
      }
      const ok = results.every((s) => s.endsWith('=200'));
      return { ok, detail: results.join('  ') };
    },
  },
  {
    id: 'cursor.streaming',
    client: 'cursor',
    name: '串流對話',
    why: 'Cursor 的 Chat 一律走串流；不通就只有 Verify 會過、實際對話卻沒反應',
    severity: 'required',
    async run(ctx) {
      const res = await ctx.raw(CHAT, {
        method: 'POST',
        body: { ...SMALL, max_tokens: 32, stream: true },
      });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      const ct = res.headers.get('content-type') ?? '';
      const stat = await drainSse(res);
      const ok = ct.includes('text/event-stream') && stat.contentChars > 0 && stat.sawDone;
      return {
        ok,
        detail: `${stat.chunks} chunks / ${stat.contentChars} 字 / [DONE]=${stat.sawDone}`
          + (stat.parseErrors ? ` / 解析失敗 ${stat.parseErrors}` : ''),
      };
    },
  },
  {
    id: 'cursor.stream-options-usage',
    client: 'cursor',
    name: 'stream_options.include_usage 不會導致錯誤',
    why: '新版客戶端會帶這個參數要求串流末尾回報 usage；Gateway 至少不能因此拒絕請求',
    severity: 'recommended',
    async run(ctx) {
      const res = await ctx.raw(CHAT, {
        method: 'POST',
        body: { ...SMALL, stream: true, stream_options: { include_usage: true } },
      });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      const stat = await drainSse(res);
      return {
        ok: stat.contentChars > 0,
        detail: stat.sawUsage ? '串流中有回報 usage' : '串流正常，但上游未回報 usage（Gateway 會改用估算值）',
      };
    },
  },
  {
    id: 'cursor.sampling-params',
    client: 'cursor',
    name: '取樣參數透傳',
    why: 'Cursor 會帶 temperature / top_p / presence_penalty 等；上游若不接受會整筆失敗',
    severity: 'recommended',
    async run(ctx) {
      const r = await chat(ctx, {
        ...SMALL,
        temperature: 0.2, top_p: 0.95, presence_penalty: 0, frequency_penalty: 0,
        n: 1, stop: ['\n\n\n'], user: 'cursor-probe',
      });
      return { ok: r.status === 200, detail: `HTTP ${r.status}：${r.body?.error?.message ?? '接受'}` };
    },
  },
  {
    id: 'cursor.large-context',
    client: 'cursor',
    name: '大型上下文不會撞到單次 Token 上限',
    why: 'Cursor 會把整份檔案塞進 prompt。tokensPerRequest 設太小會讓實際使用時大量失敗，'
      + '但小型測試請求卻都會過 —— 這種問題只有壓大 payload 才看得出來',
    severity: 'recommended',
    async run(ctx) {
      const me = (await ctx.api('/v1/me')).body;
      const limit = me?.limits?.tokensPerRequest ?? 0;

      // Cursor 開著一個檔案送出時，動輒上萬 token。用寫實尺寸才測得出真正的邊界 ——
      // 小型探測請求即使全過，實際使用仍可能大量 413。
      // ASCII 約 4 字元 1 token，40000 字元 ≈ 10000 tokens。
      const codeLine = 'export function handleRequest(req, res, next) { return next(req, res); }\n';
      const filler = codeLine.repeat(Math.ceil(40000 / codeLine.length));
      const approxTokens = Math.round(filler.length / 4);

      const r = await chat(ctx, {
        model: 'agi-bar-default', max_tokens: 512,
        messages: [
          { role: 'system', content: 'You are an AI programming assistant.' },
          { role: 'user', content: filler },
        ],
      });

      if (r.status === 413) {
        return {
          ok: false,
          detail: `約 ${approxTokens} tokens 的請求被拒，目前單次上限 ${limit}`,
          hint: '把該人員的「單次最大 Token」調到 32768 以上（管理台 → 人員 → 配額），'
            + '或改 config 的 limits.defaultUserLimits.tokensPerRequest。'
            + '同時確認後端模型的 contextWindow 撐得住',
        };
      }
      return {
        ok: r.status === 200,
        detail: `約 ${approxTokens} tokens 通過（單次上限 ${limit}）`,
      };
    },
  },
  {
    id: 'cursor.embeddings',
    client: 'cursor',
    name: '/v1/embeddings 是否可用',
    why: '部分工具的本機索引/RAG 會呼叫 embeddings。Cursor 的程式碼索引走自家服務，'
      + '所以缺這個端點通常不影響 Cursor，但會影響其他 RAG 類客戶端',
    severity: 'info',
    async run(ctx) {
      const r = await ctx.api('/v1/embeddings', {
        method: 'POST', body: { model: 'agi-bar-default', input: 'hello' },
      });
      return {
        ok: true,
        detail: r.status === 200 ? '已實作' : `未實作（HTTP ${r.status}）— Cursor 主要功能不受影響`,
      };
    },
  },
];

// ==================================================================== Codex

const codex = [
  {
    id: 'codex.models-list',
    client: 'codex',
    name: 'GET /v1/models',
    why: 'Codex 啟動時會列模型確認 provider 可用',
    severity: 'required',
    async run(ctx) {
      const r = await ctx.api('/v1/models');
      return { ok: r.status === 200, detail: `HTTP ${r.status}` };
    },
  },
  {
    id: 'codex.responses-api',
    client: 'codex',
    name: '/v1/responses（Codex 預設協定）',
    why: '新版 Codex CLI 預設走 OpenAI Responses API 而非 chat/completions。'
      + 'AGI BAR 沒有實作這個端點，必須在設定裡指定 wire_api = "chat" 才連得上 —— '
      + '這是 Codex 串接最容易卡住的一點',
    severity: 'required',
    async run(ctx) {
      const r = await ctx.api('/v1/responses', {
        method: 'POST', body: { model: 'agi-bar-default', input: 'ping' },
      });
      if (r.status === 200) return { ok: true, detail: '已實作，Codex 可用預設設定' };
      return {
        ok: false,
        detail: `未實作（HTTP ${r.status}）`,
        hint: '在 ~/.codex/config.toml 的 provider 區段加上 wire_api = "chat"，改走 /v1/chat/completions',
        // 這一項不算致命：加了設定就能用，且 config.toml 產生器已經帶上該行
        downgrade: true,
      };
    },
  },
  {
    id: 'codex.chat-completions',
    client: 'codex',
    name: 'wire_api="chat" 時的對話',
    why: '設定 wire_api = "chat" 之後，Codex 走的就是這條路徑',
    severity: 'required',
    async run(ctx) {
      const r = await chat(ctx, {
        model: 'agi-bar-default', max_tokens: 32,
        messages: [
          { role: 'system', content: 'You are a coding agent.' },
          { role: 'user', content: '列出目前目錄的檔案' },
        ],
      });
      return { ok: r.status === 200, detail: `HTTP ${r.status}：${r.body?.error?.message ?? '正常'}` };
    },
  },
  {
    id: 'codex.tools',
    client: 'codex',
    name: '工具定義（function calling）不被拒絕',
    why: 'Codex 是 agent，會帶 tools 陣列。Gateway 必須原樣透傳給上游；'
      + '實際能不能呼叫工具取決於後端模型，但 Gateway 這關不能擋',
    severity: 'required',
    async run(ctx) {
      const r = await chat(ctx, {
        model: 'agi-bar-default', max_tokens: 64,
        messages: [{ role: 'user', content: '讀取 README.md' }],
        tools: [{
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file from disk',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          },
        }],
        tool_choice: 'auto',
      });
      return { ok: r.status === 200, detail: `HTTP ${r.status}：${r.body?.error?.message ?? '接受工具定義'}` };
    },
  },
  {
    id: 'codex.tool-result-roundtrip',
    client: 'codex',
    name: '工具結果回填（role=tool 訊息）',
    why: 'Agent 的第二輪會帶 role=tool 的訊息回來。這種訊息序列若被 Gateway 或上游拒絕，'
      + 'Codex 會在第一次呼叫工具之後就卡住',
    severity: 'required',
    async run(ctx) {
      const r = await chat(ctx, {
        model: 'agi-bar-default', max_tokens: 64,
        messages: [
          { role: 'user', content: '讀取 README.md' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '# AGI BAR' },
        ],
      });
      return { ok: r.status === 200, detail: `HTTP ${r.status}：${r.body?.error?.message ?? '正常'}` };
    },
  },
  {
    id: 'codex.streaming',
    client: 'codex',
    name: '串流對話',
    why: 'Codex 以串流顯示輸出',
    severity: 'required',
    async run(ctx) {
      const res = await ctx.raw(CHAT, { method: 'POST', body: { ...SMALL, max_tokens: 32, stream: true } });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      const stat = await drainSse(res);
      return { ok: stat.contentChars > 0 && stat.sawDone, detail: `${stat.chunks} chunks / ${stat.contentChars} 字` };
    },
  },
  {
    id: 'codex.unknown-params',
    client: 'codex',
    name: '未知參數不會讓請求失敗',
    why: 'Codex 版本更新時常加新參數（reasoning_effort 之類）。Gateway 是透傳，'
      + '這一項實際上在測後端模型伺服器對未知欄位的寬容度',
    severity: 'recommended',
    async run(ctx) {
      const r = await chat(ctx, {
        ...SMALL,
        reasoning_effort: 'medium',
        parallel_tool_calls: true,
        metadata: { source: 'codex-probe' },
      });
      return {
        ok: r.status === 200,
        detail: r.status === 200 ? '上游可容忍未知欄位' : `HTTP ${r.status}：${r.body?.error?.message ?? ''}`,
        hint: r.status === 200 ? undefined : '後端推理伺服器對未知欄位嚴格；升級 Codex 後可能出現相容問題',
      };
    },
  },
];

// ==================================================================== 其他客戶端

const others = [
  {
    id: 'claude-code.messages',
    client: 'claude-code',
    name: 'POST /v1/messages',
    why: 'Claude Code 走 Anthropic Messages API',
    severity: 'required',
    async run(ctx) {
      const r = await ctx.api('/v1/messages', {
        method: 'POST',
        headers: { 'anthropic-version': '2023-06-01' },
        body: { model: 'agi-bar-default', max_tokens: 32, messages: [{ role: 'user', content: 'ping' }] },
      });
      return { ok: r.status === 200 && r.body?.type === 'message', detail: `HTTP ${r.status}` };
    },
  },
  {
    id: 'claude-code.x-api-key',
    client: 'claude-code',
    name: 'x-api-key 標頭驗證',
    why: 'Anthropic SDK 用 x-api-key 而非 Authorization',
    severity: 'required',
    async run(ctx) {
      const res = await fetch(ctx.base + '/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'agi-bar-default', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
      });
      return { ok: res.status === 200, detail: `HTTP ${res.status}` };
    },
  },
  {
    id: 'app.cors-preflight',
    client: 'app',
    name: '瀏覽器 CORS 預檢',
    why: '自製 Web App 從瀏覽器直接呼叫時需要。預設不放行任何來源，'
      + '要在 config 的 security.allowedOrigins 明確加入',
    severity: 'info',
    async run(ctx) {
      const res = await fetch(ctx.base + CHAT, {
        method: 'OPTIONS',
        headers: { Origin: 'http://example.local:3000', 'Access-Control-Request-Method': 'POST' },
      });
      const allow = res.headers.get('access-control-allow-origin');
      return {
        ok: true,
        detail: allow ? `放行來源 ${allow}` : '未放行任何來源（預設值；自製 Web App 需在設定中加入來源）',
      };
    },
  },
  {
    id: 'deepseek.external-gating',
    client: 'deepseek',
    name: '外部雲端模型的授權閘門',
    why: '規畫書要求未經授權不得把內部 Prompt 送往外部。'
      + '這一項確認外部模型在未啟用時確實不會被路由到',
    severity: 'info',
    async run(ctx) {
      const models = (await ctx.api('/v1/models')).body?.data ?? [];
      const external = models.filter((m) => m.owned_by === 'external');
      return {
        ok: true,
        detail: external.length
          ? `已啟用的外部模型：${external.map((m) => m.id).join(', ')} — 請確認是刻意開啟`
          : '未啟用任何外部模型（符合預設安全政策）',
      };
    },
  },
];

export const PROBES = [...common, ...cursor, ...codex, ...others];

export const CLIENT_LABELS = {
  common: '共通',
  cursor: 'Cursor',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  app: '自製 App',
  deepseek: 'DeepSeek',
};

export function probesFor(client) {
  if (!client || client === 'all') return PROBES;
  return PROBES.filter((p) => p.client === client || p.client === 'common');
}
