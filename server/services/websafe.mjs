/**
 * 受控上網：Web Search / URL Fetch（規畫書 9）。
 *
 * 原則：不讓 LLM 直接連 Internet。所有外連先經過本模組的網路政策檢查，
 * 再由 Gateway 擷取必要文字送給本地模型。
 *
 * 防護重點：
 *  - 先 DNS 解析，對「解析後的 IP」判斷內網範圍（避免 DNS rebinding / 內網主機名繞過）
 *  - 每次重導向都重新驗證（避免 302 跳回內網）
 *  - 限制 scheme、Content-Type、下載大小與逾時
 *  - 全程寫入 web_access_logs
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { run } from '../core/db.mjs';
import { HttpError } from '../core/http.mjs';
import { log } from '../core/logger.mjs';

// ---------------- CIDR 判斷 ----------------

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8 >>> 0) + Number(o), 0) >>> 0;
}

function inIpv4Cidr(ip, cidr) {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw ?? 32);
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function expandIpv6(ip) {
  const clean = ip.split('%')[0];
  const [head, tail = ''] = clean.split('::');
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - h.length - t.length;
  const parts = [...h, ...Array(clean.includes('::') ? Math.max(0, missing) : 0).fill('0'), ...t];
  return parts.map((p) => parseInt(p || '0', 16));
}

function inIpv6Cidr(ip, cidr) {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw ?? 128);
  const a = expandIpv6(ip);
  const b = expandIpv6(base);
  if (a.length !== 8 || b.length !== 8) return false;
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = take === 0 ? 0 : (0xffff << (16 - take)) & 0xffff;
    if ((a[i] & mask) !== (b[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

export function ipInCidr(ip, cidr) {
  const v6 = cidr.includes(':');
  const ipIsV6 = net.isIPv6(ip);
  if (v6 !== ipIsV6) {
    // ::ffff:10.0.0.1 這類對映位址要還原成 IPv4 再比對
    if (ipIsV6 && !v6 && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.test(ip)) {
      return inIpv4Cidr(RegExp.$1, cidr);
    }
    return false;
  }
  return v6 ? inIpv6Cidr(ip, cidr) : inIpv4Cidr(ip, cidr);
}

export function isBlockedIp(ip, blockedCidrs = []) {
  if (!ip) return true;
  for (const cidr of blockedCidrs) {
    try { if (ipInCidr(ip, cidr)) return cidr; } catch { /* 設定錯誤不應放行 */ }
  }
  return false;
}

function hostMatches(host, pattern) {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
  return h === p;
}

// ---------------- 政策檢查 ----------------

/** 對單一 URL 做完整政策檢查，回傳解析後的 IP。不通過就丟 HttpError。 */
export async function assertUrlAllowed(rawUrl, fetchPolicy) {
  let url;
  try { url = new URL(rawUrl); } catch {
    throw new HttpError(400, 'invalid_url', '網址格式不正確');
  }

  const scheme = url.protocol.replace(':', '');
  if (!(fetchPolicy.allowedSchemes ?? ['http', 'https']).includes(scheme)) {
    throw new HttpError(403, 'scheme_blocked', `不允許的協定：${scheme}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  for (const pattern of fetchPolicy.domainBlocklist ?? []) {
    if (hostMatches(host, pattern)) {
      throw new HttpError(403, 'domain_blocked', `網域在封鎖清單中：${host}`);
    }
  }
  const allowlist = fetchPolicy.domainAllowlist ?? [];
  if (allowlist.length && !allowlist.some((p) => hostMatches(host, p))) {
    throw new HttpError(403, 'domain_not_allowlisted', `網域不在允許清單中：${host}`);
  }

  // 解析成 IP 後再判斷內網（字面 IP 也走同一條路徑）
  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      const records = await dns.lookup(host, { all: true, verbatim: true });
      addresses = records.map((r) => r.address);
    } catch {
      throw new HttpError(502, 'dns_failed', `無法解析網域：${host}`);
    }
  }
  if (!addresses.length) throw new HttpError(502, 'dns_failed', `無法解析網域：${host}`);

  if (fetchPolicy.blockPrivateNetworks !== false) {
    for (const ip of addresses) {
      const hit = isBlockedIp(ip, fetchPolicy.blockedCidrs ?? []);
      if (hit) {
        throw new HttpError(403, 'private_network_blocked',
          `目標指向內網位址（${ip} 命中 ${hit}），已依安全政策封鎖`);
      }
    }
  }

  return { url, ip: addresses[0], addresses };
}

function logWeb({ userId, requestId, tool, target, ip, allowed, reason, bytes = 0, statusCode = 0 }) {
  run(
    `INSERT INTO web_access_logs (user_id, request_id, tool, target, resolved_ip, allowed, reason, bytes, status_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId ?? null, requestId || '', tool, String(target).slice(0, 500), ip || '', allowed ? 1 : 0,
     String(reason || '').slice(0, 300), bytes, statusCode],
  );
}

// ---------------- URL Fetch ----------------

/** 擷取網頁並回傳純文字摘要。手動跟隨重導向，每一跳都重新做政策檢查。 */
export async function urlFetch(rawUrl, config, ctx = {}) {
  const policy = config.internet?.fetch ?? {};
  if (config.internet?.enabled === false) {
    logWeb({ ...ctx, tool: 'url_fetch', target: rawUrl, allowed: false, reason: '系統層級已關閉上網' });
    throw new HttpError(403, 'internet_disabled', '系統目前未開放上網功能');
  }

  const maxRedirects = policy.maxRedirects ?? 3;
  let current = rawUrl;
  let lastIp = '';

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let checked;
    try {
      checked = await assertUrlAllowed(current, policy);
    } catch (err) {
      logWeb({ ...ctx, tool: 'url_fetch', target: current, allowed: false, reason: err.message });
      throw err;
    }
    lastIp = checked.ip;

    const res = await fetch(checked.url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'AGI-BAR/1.2 (+local-ai-gateway)', Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(policy.timeoutMs ?? 10000),
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), checked.url).toString();
      continue; // 下一圈重新驗證
    }

    if (!res.ok) {
      logWeb({ ...ctx, tool: 'url_fetch', target: current, ip: lastIp, allowed: true, reason: `HTTP ${res.status}`, statusCode: res.status });
      throw new HttpError(502, 'fetch_failed', `目標網站回應 HTTP ${res.status}`);
    }

    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const allowedTypes = policy.allowedContentTypes ?? [];
    if (allowedTypes.length && !allowedTypes.includes(contentType)) {
      logWeb({ ...ctx, tool: 'url_fetch', target: current, ip: lastIp, allowed: false, reason: `Content-Type 不允許：${contentType}`, statusCode: res.status });
      throw new HttpError(415, 'content_type_blocked', `不允許的內容類型：${contentType || '未知'}`);
    }

    const maxBytes = policy.maxBytes ?? 2097152;
    const buf = await readLimited(res, maxBytes);
    const text = buf.toString('utf8');
    const extracted = contentType === 'text/html' ? htmlToText(text) : text;

    logWeb({ ...ctx, tool: 'url_fetch', target: current, ip: lastIp, allowed: true, reason: 'ok', bytes: buf.length, statusCode: res.status });
    log.info('受控擷取完成', { url: current, bytes: buf.length, contentType });

    return {
      url: current,
      finalIp: lastIp,
      contentType,
      bytes: buf.length,
      truncated: buf.length >= maxBytes,
      text: extracted.slice(0, 200000),
    };
  }

  logWeb({ ...ctx, tool: 'url_fetch', target: current, ip: lastIp, allowed: false, reason: '重導向次數過多' });
  throw new HttpError(502, 'too_many_redirects', '重導向次數過多');
}

async function readLimited(res, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    const b = Buffer.from(chunk);
    if (size + b.length > maxBytes) {
      chunks.push(b.subarray(0, maxBytes - size));
      size = maxBytes;
      break;
    }
    chunks.push(b);
    size += b.length;
  }
  return Buffer.concat(chunks, size);
}

/** 極簡 HTML → 文字，避免把腳本與樣式送進模型。 */
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------- Web Search ----------------

/**
 * 搜尋。V1 僅支援管理員自行設定的 OpenAI-compatible / SearXNG 端點；
 * 未設定時明確回報未啟用，不做任何隱性外連。
 */
export async function webSearch(query, config, ctx = {}) {
  const inet = config.internet ?? {};
  if (!inet.enabled) {
    logWeb({ ...ctx, tool: 'web_search', target: query, allowed: false, reason: '系統層級已關閉上網' });
    throw new HttpError(403, 'internet_disabled', '系統目前未開放上網功能');
  }
  if (!inet.searchEndpoint || inet.searchProvider === 'none') {
    throw new HttpError(501, 'search_not_configured', '尚未設定搜尋服務端點（設定 → 網路）');
  }

  const policy = inet.fetch ?? {};
  const url = new URL(inet.searchEndpoint);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  try {
    await assertUrlAllowed(url.toString(), { ...policy, domainAllowlist: [] });
  } catch (err) {
    logWeb({ ...ctx, tool: 'web_search', target: query, allowed: false, reason: err.message });
    throw err;
  }

  const apiKey = inet.searchApiKeyEnv ? process.env[inet.searchApiKeyEnv] : null;
  const res = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(policy.timeoutMs ?? 10000),
  });
  if (!res.ok) {
    logWeb({ ...ctx, tool: 'web_search', target: query, allowed: true, reason: `HTTP ${res.status}`, statusCode: res.status });
    throw new HttpError(502, 'search_failed', `搜尋服務回應 HTTP ${res.status}`);
  }

  const data = await res.json();
  const raw = data.results || data.items || data.data || [];
  const results = raw.slice(0, inet.maxResults ?? 5).map((r) => ({
    title: r.title || r.name || '',
    url: r.url || r.link || '',
    snippet: (r.content || r.snippet || r.description || '').slice(0, 500),
  }));

  logWeb({ ...ctx, tool: 'web_search', target: query, allowed: true, reason: `${results.length} 筆`, statusCode: 200 });
  return { query, results };
}
