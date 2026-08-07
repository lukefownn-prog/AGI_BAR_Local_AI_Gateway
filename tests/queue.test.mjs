/** Priority Queue 與 anti-starvation（規畫書 8）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PriorityQueue } from '../server/services/queue.mjs';

test('高優先請求先於低優先執行', async () => {
  const q = new PriorityQueue({ maxGlobalConcurrent: 1, antiStarvation: { enabled: false } });
  const order = [];

  const first = await q.acquire({ priority: 'normal' }); // 立即取得唯一名額

  const pending = [
    q.acquire({ priority: 'guest' }).then((s) => { order.push('guest'); s.release(); }),
    q.acquire({ priority: 'admin' }).then((s) => { order.push('admin'); s.release(); }),
    q.acquire({ priority: 'high' }).then((s) => { order.push('high'); s.release(); }),
  ];

  first.release();
  await Promise.all(pending);

  assert.deepEqual(order, ['admin', 'high', 'guest']);
});

test('anti-starvation 讓等待過久的低優先請求提升權重', () => {
  const q = new PriorityQueue({
    priorityWeights: { admin: 0, high: 1, normal: 2, guest: 3 },
    antiStarvation: { enabled: true, boostEveryMs: 1000, maxBoost: 3 },
  });
  const now = Date.now();

  const freshHigh = { priority: 'high', enqueuedAt: now };
  const oldGuest = { priority: 'guest', enqueuedAt: now - 3000 };

  assert.equal(q.effectiveWeight(freshHigh, now), 1);
  assert.equal(q.effectiveWeight(oldGuest, now), 0); // 3 - min(3, 3) = 0，已超前
});

test('提升幅度不超過 maxBoost', () => {
  const q = new PriorityQueue({ antiStarvation: { enabled: true, boostEveryMs: 1000, maxBoost: 2 } });
  const now = Date.now();
  const ancient = { priority: 'guest', enqueuedAt: now - 999999 };
  assert.equal(q.effectiveWeight(ancient, now), 3 - 2);
});

test('同權重維持先進先出', async () => {
  const q = new PriorityQueue({ maxGlobalConcurrent: 1, antiStarvation: { enabled: false } });
  const order = [];
  const held = await q.acquire({ priority: 'normal' });

  const p1 = q.acquire({ priority: 'normal', label: 'a' }).then((s) => { order.push('a'); s.release(); });
  await new Promise((r) => setTimeout(r, 5));
  const p2 = q.acquire({ priority: 'normal', label: 'b' }).then((s) => { order.push('b'); s.release(); });

  held.release();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['a', 'b']);
});

test('佇列滿載時拒絕新請求', async () => {
  const q = new PriorityQueue({ maxGlobalConcurrent: 1, maxQueueLength: 1 });
  const held = await q.acquire({ priority: 'normal' });
  const queued = q.acquire({ priority: 'normal' });

  assert.throws(() => q.acquire({ priority: 'normal' }), /忙碌/);

  held.release();
  (await queued).release();
});

test('排隊逾時會回傳 504', async () => {
  const q = new PriorityQueue({ maxGlobalConcurrent: 1, queueTimeoutMs: 50 });
  const held = await q.acquire({ priority: 'normal' });
  await assert.rejects(q.acquire({ priority: 'normal' }), (err) => err.status === 504);
  held.release();
});

test('客戶端中斷會立即離開佇列', async () => {
  const q = new PriorityQueue({ maxGlobalConcurrent: 1 });
  const held = await q.acquire({ priority: 'normal' });
  const ac = new AbortController();
  const p = q.acquire({ priority: 'normal', signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (err) => err.status === 499);
  assert.equal(q.depth, 0);
  held.release();
});
