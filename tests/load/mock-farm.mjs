/**
 * 模擬本地模型主機農場。
 *
 * 存在的理由：壓測腳本本身也會有 bug。若只能在有 GPU 的機器上跑，
 * 腳本會在兩次驗收之間爛掉而沒人發現。這裡提供行為接近真實推理伺服器的
 * 假模型 —— 有排隊上限、逐 token 吐字、首 token 延遲 —— 讓腳本能在
 * CI 與開發機上持續被驗證。
 */
import http from 'node:http';

const LOREM = '這是一段用於壓力測試的模擬回覆內容，會依設定的 token 數逐字輸出，'
  + '以模擬真實本地模型的串流行為與時間分布。';

/**
 * @param {object} opts
 *   name            模型名稱
 *   firstTokenMs    首 token 延遲
 *   msPerToken      每個 token 的間隔
 *   maxConcurrent   同時處理上限，超過即回 503（模擬推理伺服器排隊滿載）
 *   jitter          延遲抖動比例 0-1
 *   failRate        隨機失敗機率 0-1
 */
export async function startMockModelServer(opts = {}) {
  const cfg = {
    name: 'mock',
    firstTokenMs: 120,
    msPerToken: 8,
    maxConcurrent: 4,
    jitter: 0.3,
    failRate: 0,
    ...opts,
  };

  const state = { active: 0, peakActive: 0, total: 0, rejected: 0, failed: 0 };
  const jitter = (ms) => ms * (1 + (Math.random() * 2 - 1) * cfg.jitter);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');

    if (url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: cfg.name, object: 'model' }] }));
    }

    if (!url.pathname.endsWith('/chat/completions')) {
      return res.writeHead(404).end('not found');
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* 保持空物件 */ }

    if (state.active >= cfg.maxConcurrent) {
      state.rejected++;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'model busy' } }));
    }
    if (cfg.failRate && Math.random() < cfg.failRate) {
      state.failed++;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'simulated failure' } }));
    }

    state.active++;
    state.total++;
    state.peakActive = Math.max(state.peakActive, state.active);

    // 客戶端中斷時要停止吐字，否則假模型會拖住整台機器
    let aborted = false;
    req.on('aborted', () => { aborted = true; });
    res.on('close', () => { aborted = true; });

    try {
      const want = Math.max(1, Math.min(Number(body.max_tokens) || 64, 4096));
      const text = LOREM.repeat(Math.ceil(want / LOREM.length) + 1).slice(0, want);
      const promptTokens = JSON.stringify(body.messages ?? []).length / 4 | 0;

      await sleep(jitter(cfg.firstTokenMs));
      if (aborted) return;

      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        for (const ch of text) {
          if (aborted) break;
          res.write(`data: ${JSON.stringify({
            id: 'chatcmpl-load', object: 'chat.completion.chunk', model: cfg.name,
            choices: [{ index: 0, delta: { content: ch }, finish_reason: null }],
          })}\n\n`);
          if (cfg.msPerToken) await sleep(cfg.msPerToken);
        }
        if (!aborted) {
          res.write(`data: ${JSON.stringify({
            id: 'chatcmpl-load', object: 'chat.completion.chunk', model: cfg.name,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: promptTokens, completion_tokens: text.length, total_tokens: promptTokens + text.length },
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      }

      if (cfg.msPerToken) await sleep(jitter(cfg.msPerToken * text.length));
      if (aborted) return;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-load', object: 'chat.completion', created: 0, model: cfg.name,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: text.length, total_tokens: promptTokens + text.length },
      }));
    } finally {
      state.active--;
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  return {
    name: cfg.name,
    port,
    endpoint: `http://127.0.0.1:${port}/v1`,
    state,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** 起一整組模型，供 Failover 與多順位測試使用。 */
export async function startFarm(specs = [
  { name: 'load-primary', firstTokenMs: 120, msPerToken: 8, maxConcurrent: 4 },
  { name: 'load-secondary', firstTokenMs: 200, msPerToken: 14, maxConcurrent: 4 },
]) {
  const servers = await Promise.all(specs.map((s) => startMockModelServer(s)));
  return {
    servers,
    catalog: servers.map((s, i) => ({
      id: `load-model-${i + 1}`,
      displayName: `壓測模型 ${i + 1}`,
      provider: 'openai-compatible',
      endpoint: s.endpoint,
      model: s.name,
      enabled: true,
      isLocal: true,
      capabilities: ['chat', 'stream'],
      contextWindow: 8192,
      vramMb: 8000 - i * 2000,
    })),
    closeAll: () => Promise.all(servers.map((s) => s.close())),
  };
}
