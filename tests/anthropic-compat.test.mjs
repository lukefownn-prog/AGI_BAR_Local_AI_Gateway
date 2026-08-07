/** Anthropic ↔ OpenAI 轉譯（規畫書 10，Claude Code 串接）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  messagesToOpenAI, systemToText, toolsToOpenAI, toolChoiceToOpenAI,
  requestToOpenAI, responseToAnthropic, mapStopReason,
  AnthropicStreamTranslator, anthropicErrorType,
} from '../server/services/anthropic-compat.mjs';

// ---------------- system ----------------

test('system 從頂層參數變成 system 訊息', () => {
  const out = messagesToOpenAI([{ role: 'user', content: '你好' }], '你是助理');
  assert.deepEqual(out, [
    { role: 'system', content: '你是助理' },
    { role: 'user', content: '你好' },
  ]);
});

test('system 為 block 陣列時合併成文字', () => {
  assert.equal(systemToText([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]), 'A\n\nB');
  assert.equal(systemToText('直接字串'), '直接字串');
  assert.equal(systemToText(null), '');
});

test('沒有 system 時不插入空的 system 訊息', () => {
  const out = messagesToOpenAI([{ role: 'user', content: 'hi' }], null);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
});

// ---------------- content blocks ----------------

test('文字 block 陣列降回字串', () => {
  const out = messagesToOpenAI([
    { role: 'user', content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] },
  ]);
  assert.equal(out[0].content, '第一段\n第二段');
});

test('圖片 block 轉成 OpenAI 的 image_url', () => {
  const out = messagesToOpenAI([
    {
      role: 'user',
      content: [
        { type: 'text', text: '看圖' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    },
  ]);
  assert.ok(Array.isArray(out[0].content));
  assert.equal(out[0].content[1].type, 'image_url');
  assert.equal(out[0].content[1].image_url.url, 'data:image/png;base64,AAAA');
});

// ---------------- 工具 ----------------

test('assistant 的 tool_use 轉成 OpenAI tool_calls', () => {
  const out = messagesToOpenAI([
    { role: 'user', content: '台北天氣？' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我查一下' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '台北' } },
      ],
    },
  ]);
  const a = out[1];
  assert.equal(a.role, 'assistant');
  assert.equal(a.content, '我查一下');
  assert.equal(a.tool_calls.length, 1);
  assert.equal(a.tool_calls[0].id, 'toolu_1');
  assert.equal(a.tool_calls[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(a.tool_calls[0].function.arguments), { city: '台北' });
});

test('user 的 tool_result 拆成獨立的 role=tool 訊息，且排在其他內容之前', () => {
  const out = messagesToOpenAI([
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: '晴天 30 度' },
        { type: 'text', text: '謝謝' },
      ],
    },
  ]);
  assert.equal(out[0].role, 'tool');
  assert.equal(out[0].tool_call_id, 'toolu_1');
  assert.equal(out[0].content, '晴天 30 度');
  assert.equal(out[1].role, 'user');
  assert.equal(out[1].content, '謝謝');
});

test('tool_result 的 content 為 block 陣列時攤平成文字', () => {
  const out = messagesToOpenAI([
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '結果' }] }] },
  ]);
  assert.equal(out[0].content, '結果');
});

test('工具定義轉換：input_schema → parameters', () => {
  const out = toolsToOpenAI([
    { name: 'get_weather', description: '查天氣', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
  ]);
  assert.equal(out[0].type, 'function');
  assert.equal(out[0].function.name, 'get_weather');
  assert.deepEqual(out[0].function.parameters.properties.city, { type: 'string' });
});

test('tool_choice 對應', () => {
  assert.equal(toolChoiceToOpenAI({ type: 'auto' }), 'auto');
  assert.equal(toolChoiceToOpenAI({ type: 'any' }), 'required');
  assert.equal(toolChoiceToOpenAI({ type: 'none' }), 'none');
  assert.deepEqual(toolChoiceToOpenAI({ type: 'tool', name: 'f' }), { type: 'function', function: { name: 'f' } });
  assert.equal(toolChoiceToOpenAI(undefined), undefined);
});

// ---------------- 請求參數 ----------------

test('請求參數對應', () => {
  const req = requestToOpenAI({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    temperature: 0.5,
    top_p: 0.9,
    stop_sequences: ['END'],
    system: '你是助理',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(req.model, 'claude-sonnet-4-5');
  assert.equal(req.max_tokens, 1024);
  assert.equal(req.temperature, 0.5);
  assert.equal(req.top_p, 0.9);
  assert.deepEqual(req.stop, ['END']);
  assert.equal(req.messages[0].role, 'system');
});

// ---------------- 回應 ----------------

test('回應轉成 Anthropic 格式', () => {
  const out = responseToAnthropic({
    choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  }, { model: 'agi-bar-default', messageId: 'msg_test' });

  assert.equal(out.id, 'msg_test');
  assert.equal(out.type, 'message');
  assert.equal(out.role, 'assistant');
  assert.equal(out.model, 'agi-bar-default');
  assert.deepEqual(out.content, [{ type: 'text', text: '你好' }]);
  assert.equal(out.stop_reason, 'end_turn');
  assert.deepEqual(out.usage, { input_tokens: 11, output_tokens: 7 });
});

test('回應中的 tool_calls 轉成 tool_use block', () => {
  const out = responseToAnthropic({
    choices: [{
      message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  }, { model: 'm' });

  const block = out.content.find((c) => c.type === 'tool_use');
  assert.ok(block);
  assert.equal(block.id, 'call_1');
  assert.equal(block.name, 'f');
  assert.deepEqual(block.input, { a: 1 });
  assert.equal(out.stop_reason, 'tool_use');
});

test('工具參數是壞掉的 JSON 時不讓請求爆掉', () => {
  const out = responseToAnthropic({
    choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{"a":' } }] }, finish_reason: 'tool_calls' }],
  }, { model: 'm' });
  assert.deepEqual(out.content.find((c) => c.type === 'tool_use').input, {});
});

test('content 不得為空陣列', () => {
  const out = responseToAnthropic({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }, { model: 'm' });
  assert.equal(out.content.length, 1);
  assert.equal(out.content[0].type, 'text');
});

test('stop_reason 對應', () => {
  assert.equal(mapStopReason('stop'), 'end_turn');
  assert.equal(mapStopReason('length'), 'max_tokens');
  assert.equal(mapStopReason('tool_calls'), 'tool_use');
  assert.equal(mapStopReason('stop', true), 'tool_use');
  assert.equal(mapStopReason(null), null);
});

// ---------------- 串流 ----------------

function collect() {
  const events = [];
  return { events, emit: (event, data) => events.push({ event, data }) };
}

test('串流事件序列符合 Anthropic 規範', () => {
  const { events, emit } = collect();
  const t = new AnthropicStreamTranslator({ model: 'm', messageId: 'msg_1', emit });

  t.start(10);
  t.push({ choices: [{ delta: { content: '你' } }] });
  t.push({ choices: [{ delta: { content: '好' } }] });
  t.push({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  t.finish({ outputTokens: 2 });

  const names = events.map((e) => e.event);
  assert.deepEqual(names, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);

  assert.equal(events[0].data.message.id, 'msg_1');
  assert.equal(events[0].data.message.usage.input_tokens, 10);
  assert.equal(events[1].data.content_block.type, 'text');
  assert.equal(events[2].data.delta.text, '你');
  assert.equal(events[5].data.delta.stop_reason, 'end_turn');
  assert.equal(events[5].data.usage.output_tokens, 2);
});

test('content_block_start 只發一次', () => {
  const { events, emit } = collect();
  const t = new AnthropicStreamTranslator({ model: 'm', emit });
  t.start();
  for (const ch of ['a', 'b', 'c']) t.push({ choices: [{ delta: { content: ch } }] });
  t.finish();
  assert.equal(events.filter((e) => e.event === 'content_block_start').length, 1);
  assert.equal(events.filter((e) => e.event === 'content_block_delta').length, 3);
});

test('串流中的工具呼叫轉成 input_json_delta', () => {
  const { events, emit } = collect();
  const t = new AnthropicStreamTranslator({ model: 'm', emit });
  t.start();
  t.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{"a"' } }] } }] });
  t.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] });
  t.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  t.finish();

  const start = events.find((e) => e.event === 'content_block_start');
  assert.equal(start.data.content_block.type, 'tool_use');
  assert.equal(start.data.content_block.id, 'call_1');
  assert.equal(start.data.content_block.name, 'f');

  const deltas = events.filter((e) => e.event === 'content_block_delta');
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0].data.delta.type, 'input_json_delta');
  assert.equal(deltas.map((d) => d.data.delta.partial_json).join(''), '{"a":1}');

  assert.equal(events.find((e) => e.event === 'message_delta').data.delta.stop_reason, 'tool_use');
});

test('文字與工具各自佔一個 content block', () => {
  const { events, emit } = collect();
  const t = new AnthropicStreamTranslator({ model: 'm', emit });
  t.start();
  t.push({ choices: [{ delta: { content: '我查一下' } }] });
  t.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] } }] });
  t.finish();

  const starts = events.filter((e) => e.event === 'content_block_start');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].data.index, 0);
  assert.equal(starts[1].data.index, 1);

  const stops = events.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index);
  assert.deepEqual(stops, [0, 1]);
});

test('上游沒送 finish_reason 也要把 block 關乾淨', () => {
  const { events, emit } = collect();
  const t = new AnthropicStreamTranslator({ model: 'm', emit });
  t.start();
  t.push({ choices: [{ delta: { content: 'x' } }] });
  t.finish();
  assert.equal(events.filter((e) => e.event === 'content_block_stop').length, 1);
  assert.equal(events.at(-1).event, 'message_stop');
});

test('完全沒有內容時仍產生完整事件序列', () => {
  const { events, emit } = collect();
  const t = new AnthropicStreamTranslator({ model: 'm', emit });
  t.start();
  t.finish();
  assert.deepEqual(events.map((e) => e.event), ['message_start', 'message_delta', 'message_stop']);
});

// ---------------- 錯誤 ----------------

test('HTTP 狀態碼對應到 Anthropic 錯誤型別', () => {
  assert.equal(anthropicErrorType(401), 'authentication_error');
  assert.equal(anthropicErrorType(403), 'permission_error');
  assert.equal(anthropicErrorType(429), 'rate_limit_error');
  assert.equal(anthropicErrorType(503), 'overloaded_error');
  assert.equal(anthropicErrorType(400), 'invalid_request_error');
  assert.equal(anthropicErrorType(418), 'invalid_request_error');
  assert.equal(anthropicErrorType(507), 'api_error');
});
