/**
 * Anthropic Messages API ↔ OpenAI Chat Completions 雙向轉譯。
 *
 * 存在的理由：Claude Code 走的是 Anthropic 格式，本地模型幾乎都只講 OpenAI 格式。
 * 在 Gateway 內做轉譯，配額、佇列與紀錄才能維持單一歸屬 —— 若改用外部代理，
 * 用量會少一層對應，且多一個要維運的元件。
 *
 * 本檔案刻意只放純函式，不碰 IO，方便單元測試。
 *
 * 兩邊的主要差異：
 *   - system：Anthropic 是頂層參數，OpenAI 是 role='system' 的訊息
 *   - content：Anthropic 是 block 陣列，OpenAI 是字串或 part 陣列
 *   - 工具：Anthropic 的 tool_use / tool_result block ↔ OpenAI 的 tool_calls / role='tool'
 *   - 結束原因：end_turn|max_tokens|tool_use ↔ stop|length|tool_calls
 *   - max_tokens：Anthropic 必填，OpenAI 選填
 */
import crypto from 'node:crypto';

// ---------------------------------------------------------------- 輔助

export function newMessageId() {
  return `msg_${crypto.randomBytes(12).toString('hex')}`;
}

function newToolUseId() {
  return `toolu_${crypto.randomBytes(12).toString('hex')}`;
}

/** 工具參數可能是不完整的 JSON（串流中斷），解析失敗時回空物件而非讓請求爆掉。 */
function safeJsonObject(text) {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** system 可以是字串或 block 陣列。 */
export function systemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.filter((b) => b?.type === 'text').map((b) => b.text).join('\n\n');
  }
  return '';
}

/** tool_result 的 content 可以是字串或 block 陣列，OpenAI 端只接受字串。 */
function toolResultToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b?.type === 'text') return b.text;
        if (b?.type === 'image') return '[image]'; // OpenAI 的 tool 訊息不支援圖片
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : String(content);
}

// ---------------------------------------------------- Anthropic → OpenAI

/**
 * 訊息轉換。
 * 注意 tool_result 必須拆成獨立的 role='tool' 訊息，且要排在同一輪的其他內容之前，
 * 否則 OpenAI 相容端點會認為 tool_calls 沒有被回應。
 */
export function messagesToOpenAI(messages = [], system = null) {
  const out = [];

  const systemText = systemToText(system);
  if (systemText) out.push({ role: 'system', content: systemText });

  for (const m of messages) {
    if (!m) continue;

    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    const blocks = Array.isArray(m.content) ? m.content : [];

    if (m.role === 'user') {
      for (const b of blocks.filter((x) => x?.type === 'tool_result')) {
        out.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: toolResultToText(b.content),
        });
      }

      const parts = [];
      for (const b of blocks) {
        if (b?.type === 'text') {
          parts.push({ type: 'text', text: b.text ?? '' });
        } else if (b?.type === 'image' && b.source?.type === 'base64') {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
          });
        } else if (b?.type === 'image' && b.source?.type === 'url') {
          parts.push({ type: 'image_url', image_url: { url: b.source.url } });
        }
      }
      if (parts.length) {
        // 純文字時降回字串 —— 部分本地推理伺服器不接受 part 陣列
        const allText = parts.every((p) => p.type === 'text');
        out.push({
          role: 'user',
          content: allText ? parts.map((p) => p.text).join('\n') : parts,
        });
      }
      continue;
    }

    // assistant
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
    const toolUses = blocks.filter((b) => b?.type === 'tool_use');
    const msg = { role: 'assistant', content: text || null };
    if (toolUses.length) {
      msg.tool_calls = toolUses.map((t) => ({
        id: t.id ?? newToolUseId(),
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
      }));
    }
    out.push(msg);
  }

  return out;
}

export function toolsToOpenAI(tools = []) {
  return tools
    .filter((t) => t && t.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));
}

export function toolChoiceToOpenAI(choice) {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': return { type: 'function', function: { name: choice.name } };
    default: return undefined;
  }
}

/** 完整的請求轉換。 */
export function requestToOpenAI(body = {}) {
  const req = {
    model: body.model,
    messages: messagesToOpenAI(body.messages, body.system),
  };

  if (body.max_tokens != null) req.max_tokens = body.max_tokens;
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  if (body.stop_sequences?.length) req.stop = body.stop_sequences;

  if (body.tools?.length) {
    req.tools = toolsToOpenAI(body.tools);
    const tc = toolChoiceToOpenAI(body.tool_choice);
    if (tc !== undefined) req.tool_choice = tc;
  }

  return req;
}

// ---------------------------------------------------- OpenAI → Anthropic

export function mapStopReason(finishReason, hasToolCalls = false) {
  if (hasToolCalls) return 'tool_use';
  switch (finishReason) {
    case 'length': return 'max_tokens';
    case 'tool_calls':
    case 'function_call': return 'tool_use';
    case 'stop': return 'end_turn';
    case 'content_filter': return 'end_turn';
    default: return finishReason ? 'end_turn' : null;
  }
}

/** 非串流回應轉換。 */
export function responseToAnthropic(data, { model, messageId } = {}) {
  const choice = data?.choices?.[0] ?? {};
  const msg = choice.message ?? {};

  const content = [];
  if (typeof msg.content === 'string' && msg.content) {
    content.push({ type: 'text', text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const p of msg.content) {
      if (p?.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
    }
  }

  for (const tc of msg.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: tc.id ?? newToolUseId(),
      name: tc.function?.name ?? '',
      input: safeJsonObject(tc.function?.arguments),
    });
  }

  // Anthropic 的 content 不得為空陣列
  if (!content.length) content.push({ type: 'text', text: '' });

  return {
    id: messageId ?? newMessageId(),
    type: 'message',
    role: 'assistant',
    model: model ?? data?.model ?? '',
    content,
    stop_reason: mapStopReason(choice.finish_reason, !!msg.tool_calls?.length),
    stop_sequence: null,
    usage: {
      input_tokens: data?.usage?.prompt_tokens ?? 0,
      output_tokens: data?.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------- 串流狀態機

/**
 * 把 OpenAI 的 SSE chunk 串流翻譯成 Anthropic 的事件序列。
 *
 * Anthropic 的事件是有狀態的：必須先 message_start，每個 content block 要有
 * 成對的 content_block_start / content_block_stop，最後才 message_delta + message_stop。
 * OpenAI 的 chunk 沒有這些界線，因此要在這裡自己維護。
 *
 * 用法：
 *   const t = new AnthropicStreamTranslator({ model, messageId, emit });
 *   t.start(inputTokens);
 *   for (const chunk of openaiChunks) t.push(chunk);
 *   t.finish();
 */
export class AnthropicStreamTranslator {
  constructor({ model, messageId, emit, inputTokens = 0 }) {
    this.model = model;
    this.messageId = messageId ?? newMessageId();
    this.emit = emit;
    this.inputTokens = inputTokens;

    this.started = false;
    this.nextIndex = 0;
    this.textIndex = null;          // 文字 block 的 index（只會有一個）
    this.toolBlocks = new Map();    // OpenAI tool_call index -> { index, id, name }
    this.openBlocks = new Set();    // 尚未 content_block_stop 的 index
    this.text = '';
    this.finishReason = null;
    this.usage = null;
    this.sawToolCall = false;
  }

  start(inputTokens = this.inputTokens) {
    if (this.started) return;
    this.started = true;
    this.inputTokens = inputTokens;
    this.emit('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    });
  }

  /** 餵入一個已解析的 OpenAI chunk 物件。 */
  push(chunk) {
    if (!this.started) this.start();

    if (chunk?.usage) this.usage = chunk.usage;

    const choice = chunk?.choices?.[0];
    if (!choice) return;

    const delta = choice.delta ?? {};

    if (typeof delta.content === 'string' && delta.content) {
      if (this.textIndex === null) {
        this.textIndex = this.nextIndex++;
        this.openBlocks.add(this.textIndex);
        this.emit('content_block_start', {
          type: 'content_block_start',
          index: this.textIndex,
          content_block: { type: 'text', text: '' },
        });
      }
      this.text += delta.content;
      this.emit('content_block_delta', {
        type: 'content_block_delta',
        index: this.textIndex,
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    for (const tc of delta.tool_calls ?? []) {
      this.sawToolCall = true;
      const key = tc.index ?? 0;
      let block = this.toolBlocks.get(key);

      if (!block) {
        block = { index: this.nextIndex++, id: tc.id ?? newToolUseId(), name: tc.function?.name ?? '' };
        this.toolBlocks.set(key, block);
        this.openBlocks.add(block.index);
        this.emit('content_block_start', {
          type: 'content_block_start',
          index: block.index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        });
      }

      const args = tc.function?.arguments;
      if (args) {
        this.emit('content_block_delta', {
          type: 'content_block_delta',
          index: block.index,
          delta: { type: 'input_json_delta', partial_json: args },
        });
      }
    }

    if (choice.finish_reason) this.finishReason = choice.finish_reason;
  }

  /** 收尾。即使上游沒送 finish_reason 也要把 block 關乾淨，否則客戶端會一直等。 */
  finish({ outputTokens } = {}) {
    if (!this.started) this.start();

    for (const index of [...this.openBlocks].sort((a, b) => a - b)) {
      this.emit('content_block_stop', { type: 'content_block_stop', index });
    }
    this.openBlocks.clear();

    this.emit('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: mapStopReason(this.finishReason, this.sawToolCall),
        stop_sequence: null,
      },
      usage: {
        output_tokens: outputTokens ?? this.usage?.completion_tokens ?? 0,
      },
    });

    this.emit('message_stop', { type: 'message_stop' });
  }

  /** 串流中途失敗：Anthropic 客戶端認得的錯誤事件。 */
  fail(type, message) {
    this.emit('error', { type: 'error', error: { type, message } });
  }
}

// ------------------------------------------------------------ 錯誤對應

const STATUS_TO_ANTHROPIC_ERROR = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  502: 'api_error',
  503: 'overloaded_error',
  504: 'overloaded_error',
  529: 'overloaded_error',
};

export function anthropicErrorType(status) {
  return STATUS_TO_ANTHROPIC_ERROR[status] ?? (status >= 500 ? 'api_error' : 'invalid_request_error');
}
