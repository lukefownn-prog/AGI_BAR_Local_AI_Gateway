/**
 * 模擬一台 OpenAI-compatible 的本地模型主機，讓測試不需要真的跑 llama.cpp。
 * 支援 /models（健康檢查）與 /chat/completions（含 SSE）。
 */
import http from 'node:http';

export async function startMockModel({ name = 'mock-model', failWith = null, delayMs = 0 } = {}) {
  const state = { calls: 0, lastBody: null, failWith, delayMs };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');

    if (url.pathname.endsWith('/models')) {
      if (state.failWith) { res.writeHead(state.failWith).end('down'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: name, object: 'model' }] }));
    }

    if (url.pathname.endsWith('/chat/completions')) {
      state.calls++;
      const chunks = [];
      for await (const c of req) chunks.push(c);
      state.lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');

      if (state.failWith) { res.writeHead(state.failWith).end('upstream down'); return; }
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));

      const reply = `來自 ${name} 的回覆`;

      if (state.lastBody.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const ch of [...reply]) {
          res.write(`data: ${JSON.stringify({
            id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: name,
            choices: [{ index: 0, delta: { content: ch }, finish_reason: null }],
          })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: name,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion', created: 0, model: name,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }));
    }

    res.writeHead(404).end('not found');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  return {
    port,
    endpoint: `http://127.0.0.1:${port}/v1`,
    state,
    setFailure: (code) => { state.failWith = code; },
    close: () => new Promise((r) => server.close(r)),
  };
}
