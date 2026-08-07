/**
 * 迷你 HTTP 工具：路由、JSON 解析、回應輔助、SSE。
 * 無框架相依，維持 Portable 零安裝。
 */

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/** OpenAI 相容錯誤格式，讓 Cursor / Codex 等客戶端能正確顯示訊息。 */
export function openaiError(res, status, code, message, type = 'invalid_request_error') {
  json(res, status, { error: { message, type, code, param: null } });
}

export async function readJsonBody(req, maxBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'payload_too_large', '請求內容過大');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'JSON 格式錯誤');
  }
}

export function clientIp(req, trustProxy = false) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '';
}

export function bearerToken(req) {
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  // 部分客戶端使用 x-api-key
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  return null;
}

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge != null) bits.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.secure) bits.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  res.setHeader('Set-Cookie', [...list, bits.join('; ')]);
}

/** 極簡路由表：支援 /a/:id 形式的參數。 */
export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' + pattern.replace(/:[A-Za-z_]\w*/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$',
    );
    this.routes.push({ method, regex, keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    let pathExists = false;
    for (const r of this.routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      pathExists = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return pathExists ? { methodNotAllowed: true } : null;
  }
}

// ---------- SSE（/v1/chat/completions stream=true）----------

export function sseStart(res, headers = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...headers,
  });
  res.flushHeaders?.();
}

export function sseSend(res, data) {
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

export function sseDone(res) {
  res.write('data: [DONE]\n\n');
  res.end();
}
