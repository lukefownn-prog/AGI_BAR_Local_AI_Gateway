/**
 * Priority Queue + anti-starvation（規畫書 8）。
 *
 * P0 Admin / P1 High / P2 Normal / P3 Guest。
 * 等待過久的低優先請求會逐步提升有效權重，避免永遠排不到。
 */
import { HttpError } from '../core/http.mjs';
import { log } from '../core/logger.mjs';

const DEFAULT_WEIGHTS = { admin: 0, high: 1, normal: 2, guest: 3 };

let seq = 0;

export class PriorityQueue {
  constructor(config = {}) {
    this.configure(config);
    this.waiting = [];
    this.running = 0;
    this.stats = { admitted: 0, rejected: 0, timedOut: 0, totalWaitMs: 0, completed: 0 };
  }

  configure(queueConfig = {}) {
    this.maxConcurrent = queueConfig.maxGlobalConcurrent ?? 4;
    this.maxQueueLength = queueConfig.maxQueueLength ?? 200;
    this.queueTimeoutMs = queueConfig.queueTimeoutMs ?? 120000;
    this.weights = { ...DEFAULT_WEIGHTS, ...(queueConfig.priorityWeights || {}) };
    const anti = queueConfig.antiStarvation || {};
    this.antiEnabled = anti.enabled !== false;
    this.boostEveryMs = anti.boostEveryMs ?? 10000;
    this.maxBoost = anti.maxBoost ?? 3;
  }

  /** 有效權重：基礎權重減去等待帶來的提升，數字越小越先執行。 */
  effectiveWeight(item, now = Date.now()) {
    const base = this.weights[item.priority] ?? 2;
    if (!this.antiEnabled) return base;
    const boost = Math.min(this.maxBoost, Math.floor((now - item.enqueuedAt) / this.boostEveryMs));
    return base - boost;
  }

  get depth() { return this.waiting.length; }
  get active() { return this.running; }

  snapshot() {
    const now = Date.now();
    const byPriority = {};
    for (const it of this.waiting) byPriority[it.priority] = (byPriority[it.priority] || 0) + 1;
    return {
      running: this.running,
      waiting: this.waiting.length,
      maxConcurrent: this.maxConcurrent,
      byPriority,
      oldestWaitMs: this.waiting.length ? now - Math.min(...this.waiting.map((i) => i.enqueuedAt)) : 0,
      avgWaitMs: this.stats.completed ? Math.round(this.stats.totalWaitMs / this.stats.completed) : 0,
      ...this.stats,
    };
  }

  /**
   * 取得執行權。回傳 { waitMs, release() }。
   * 佇列已滿丟 503；等待逾時丟 504。
   */
  acquire({ priority = 'normal', signal = null, label = '' } = {}) {
    if (this.waiting.length >= this.maxQueueLength) {
      this.stats.rejected++;
      throw new HttpError(503, 'queue_full', '伺服器忙碌中，請稍後再試');
    }

    return new Promise((resolve, reject) => {
      const item = {
        id: ++seq,
        priority,
        label,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        timer: null,
        signal,
        onAbort: null,
      };

      // 刻意不 unref()：這個 timer 是唯一會讓等待中的請求脫困的機制，
      // unref 之後在沒有其他 handle 的情境（例如測試）會永遠不觸發。
      // 生命週期上限就是 queueTimeoutMs，且離開佇列時一定會被 clearTimeout。
      item.timer = setTimeout(() => {
        this.#remove(item);
        this.stats.timedOut++;
        reject(new HttpError(504, 'queue_timeout', '排隊等待逾時，請稍後再試'));
      }, this.queueTimeoutMs);

      if (signal) {
        item.onAbort = () => {
          this.#remove(item);
          reject(new HttpError(499, 'client_closed', '客戶端已中斷連線'));
        };
        if (signal.aborted) return item.onAbort();
        signal.addEventListener('abort', item.onAbort, { once: true });
      }

      this.waiting.push(item);
      this.#pump();
    });
  }

  #remove(item) {
    const i = this.waiting.indexOf(item);
    if (i >= 0) this.waiting.splice(i, 1);
    this.#cleanup(item);
  }

  #cleanup(item) {
    if (item.timer) clearTimeout(item.timer);
    if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort);
    item.timer = null;
    item.onAbort = null;
  }

  #pump() {
    while (this.running < this.maxConcurrent && this.waiting.length) {
      const now = Date.now();
      // 取有效權重最小者；同權重先進先出
      let best = 0;
      for (let i = 1; i < this.waiting.length; i++) {
        const a = this.effectiveWeight(this.waiting[i], now);
        const b = this.effectiveWeight(this.waiting[best], now);
        if (a < b || (a === b && this.waiting[i].enqueuedAt < this.waiting[best].enqueuedAt)) best = i;
      }
      const item = this.waiting.splice(best, 1)[0];
      this.#cleanup(item);

      const waitMs = now - item.enqueuedAt;
      this.running++;
      this.stats.admitted++;
      this.stats.totalWaitMs += waitMs;
      this.stats.completed++;
      if (waitMs > 5000) log.warn('請求等待時間偏長', { waitMs, priority: item.priority, label: item.label });

      let released = false;
      item.resolve({
        waitMs,
        release: () => {
          if (released) return;
          released = true;
          this.running = Math.max(0, this.running - 1);
          this.#pump();
        },
      });
    }
  }

  /** 關機時讓所有等待中的請求立即失敗，避免卡住。 */
  drain() {
    while (this.waiting.length) {
      const item = this.waiting.pop();
      this.#cleanup(item);
      item.reject(new HttpError(503, 'shutting_down', '服務正在關閉'));
    }
  }
}

export const queue = new PriorityQueue();
