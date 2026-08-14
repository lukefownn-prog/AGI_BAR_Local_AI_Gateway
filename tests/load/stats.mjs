/**
 * 壓測統計與報表輸出。純函式，沒有 IO，方便單元測試。
 */

/**
 * 最近位次法（nearest-rank）百分位數。
 * 刻意不用內插：壓測看的是「有多少比例的請求慢於某個值」，
 * 用實際觀測值比內插出來的虛構數字好解讀。
 */
export function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  if (p <= 0) return sortedValues[0];
  if (p >= 100) return sortedValues[sortedValues.length - 1];
  const rank = Math.ceil((p / 100) * sortedValues.length);
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, rank - 1))];
}

export function summarize(values = []) {
  if (!values.length) {
    return { count: 0, min: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

/** 依欄位分組，回傳 Map。 */
export function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = typeof key === 'function' ? key(r) : r[key];
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

export function fmtMs(ms) {
  const v = Number(ms || 0);
  if (v >= 60000) return (v / 60000).toFixed(1) + 'm';
  if (v >= 1000) return (v / 1000).toFixed(2) + 's';
  return Math.round(v) + 'ms';
}

export function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

export function pad(s, w, right = false) {
  const str = String(s);
  // 中日韓字元在終端機佔兩格，補齊時要算進去
  let width = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    width += (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf)
      || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
      || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6))) ? 2 : 1;
  }
  const padding = ' '.repeat(Math.max(0, w - width));
  return right ? padding + str : str + padding;
}

/** 簡易表格。cols = [{ key, label, width, right }] */
export function table(cols, rows) {
  const lines = [];
  lines.push(cols.map((c) => pad(c.label, c.width, c.right)).join('  '));
  lines.push(cols.map((c) => '─'.repeat(c.width)).join('  '));
  for (const row of rows) {
    lines.push(cols.map((c) => pad(row[c.key] ?? '', c.width, c.right)).join('  '));
  }
  return lines.join('\n');
}

/** 延遲分布長條圖，用來一眼看出是否有長尾。 */
export function histogram(values, { buckets = 10, width = 40 } = {}) {
  if (!values.length) return '（無資料）';
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (max === min) return `全部落在 ${fmtMs(min)}`;

  const size = (max - min) / buckets;
  const counts = new Array(buckets).fill(0);
  for (const v of sorted) {
    counts[Math.min(buckets - 1, Math.floor((v - min) / size))]++;
  }
  const peak = Math.max(...counts);

  return counts.map((n, i) => {
    const lo = min + i * size;
    const hi = lo + size;
    const bar = '█'.repeat(Math.round((n / peak) * width));
    return `  ${pad(fmtMs(lo), 8, true)}–${pad(fmtMs(hi), 8)} ${pad(bar, width)} ${fmtNum(n)}`;
  }).join('\n');
}

/**
 * 驗收判定。回傳 { pass, checks: [{ name, pass, detail, fatal }] }。
 * 只有 fatal 的失敗才會讓整體 pass=false —— 效能觀察值會因機器而異，
 * 不該讓「這台比較慢」變成驗收失敗。
 */
export function evaluate(result, thresholds = {}) {
  const checks = [];
  const add = (name, pass, detail, fatal = true) => checks.push({ name, pass, detail, fatal });

  const { requests, accounting, queueSamples } = result;
  const total = requests.length;
  const ok = requests.filter((r) => r.status === 200);
  const errors = requests.filter((r) => r.status !== 200);

  // ---- 無請求遺失：每一筆都要有明確結果 ----
  const unresolved = requests.filter((r) => r.status == null);
  add('無請求遺失', unresolved.length === 0,
    unresolved.length ? `${unresolved.length} 筆請求沒有終局狀態` : `${total} 筆全部有結果`);

  // ---- 伺服器端紀錄與客戶端對帳 ----
  if (accounting?.serverLogged != null) {
    const missing = accounting.clientRequestIds.filter((id) => !accounting.serverRequestIds.has(id));
    add('請求皆寫入 request_logs', missing.length === 0,
      missing.length ? `${missing.length} 筆未出現在伺服器紀錄` : `${accounting.clientRequestIds.length} 筆全部對上`);
  }

  // ---- 錯誤只能是預期內的類型 ----
  // 這些是 Gateway 在過載或超額時「應該」回的，壓測本來就會打出來（quota 情境更是刻意觸發）。
  // 出現清單以外的錯誤才代表有問題 —— 例如 500、連線被拒、上游全掛。
  const EXPECTED_ERRORS = new Set([
    'queue_full', 'queue_timeout',              // 佇列過載
    'rate_limit_exceeded', 'concurrency_limit', // 速率與併發
    'quota_exceeded', 'request_too_large',      // Token 配額
  ]);
  const unexpected = errors.filter((r) => !EXPECTED_ERRORS.has(r.errorCode));
  add('無非預期錯誤', unexpected.length === 0,
    unexpected.length
      ? `${unexpected.length} 筆：${[...new Set(unexpected.map((r) => `${r.status} ${r.errorCode}`))].join(', ')}`
      : `${errors.length} 筆錯誤全為配額/佇列類（預期內）`);

  // ---- Token 帳目 ----
  if (accounting?.tokenDrift != null) {
    const tolerance = thresholds.tokenDriftPct ?? 2;
    const pass = Math.abs(accounting.tokenDriftPct) <= tolerance;
    add('Token 計量相符', pass,
      `伺服器 ${fmtNum(accounting.serverTokens)} vs 客戶端 ${fmtNum(accounting.clientTokens)}`
      + `（差 ${accounting.tokenDriftPct.toFixed(2)}%，容許 ${tolerance}%）`);
  }

  // ---- 優先權排序 ----
  if (result.byPriority && Object.keys(result.byPriority).length > 1) {
    const p0 = result.byPriority.admin?.wait?.p50;
    const p3 = result.byPriority.guest?.wait?.p50;
    if (p0 != null && p3 != null) {
      add('高優先權等待較短', p0 <= p3,
        `P0 中位等待 ${fmtMs(p0)} vs P3 ${fmtMs(p3)}`, false);
    }
  }

  // ---- anti-starvation：低優先權必須有完成的請求 ----
  const guest = requests.filter((r) => r.priority === 'guest');
  if (guest.length) {
    const guestOk = guest.filter((r) => r.status === 200);
    add('低優先權未被餓死', guestOk.length > 0,
      `P3 完成 ${guestOk.length}/${guest.length} 筆`);

    const maxWait = Math.max(0, ...guestOk.map((r) => r.queueWaitMs ?? 0));
    const cap = thresholds.maxGuestWaitMs ?? 60000;
    add('低優先權最久等待在容許範圍', maxWait <= cap,
      `P3 最久等待 ${fmtMs(maxWait)}（上限 ${fmtMs(cap)}）`, false);
  }

  // ---- 佇列未失控 ----
  if (queueSamples?.length) {
    const maxDepth = Math.max(...queueSamples.map((s) => s.waiting));
    const cap = thresholds.maxQueueDepth ?? Infinity;
    add('佇列深度未超限', maxDepth <= cap, `尖峰等待 ${maxDepth} 筆`, cap !== Infinity);

    // 收尾時佇列必須排空。Gateway 是先回應、才在 finally 釋放名額，
    // 所以要輪詢等待而不是立刻判定（見 loadtest.mjs 的 waitForDrain）。
    // 等過還是排不空，就是真的有名額沒被釋放。
    const tail = queueSamples.at(-1);
    add('結束時佇列已排空', tail.waiting === 0 && tail.running === 0,
      tail.waiting === 0 && tail.running === 0
        ? '等待 0 / 執行中 0'
        : `等待 ${tail.waiting} / 執行中 ${tail.running}（逾時仍未排空，疑似名額洩漏）`);
  }

  // ---- 成功率 ----
  const successRate = total ? (ok.length / total) * 100 : 0;
  const minRate = thresholds.minSuccessRatePct ?? 0;
  add('成功率達標', successRate >= minRate,
    `${successRate.toFixed(1)}%（門檻 ${minRate}%）`, minRate > 0);

  return { pass: checks.every((c) => c.pass || !c.fatal), checks };
}
