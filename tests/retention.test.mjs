/**
 * 紀錄保留期清理（規畫書 12）。
 *
 * 這段錯了的方向有兩個，而且都很難察覺：
 *  - 刪太少 → 資料庫無限成長，只在某天備份變慢時才被發現
 *  - 刪太多 → 稽核紀錄被吃掉，等到要查的時候才知道，且無法復原
 * 所以邊界（剛好 retentionDays 內／外）與「不該被碰的資料表」都釘死在這裡。
 */
import './helpers/isolate.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { run, get, all, closeDb } from '../server/core/db.mjs';
import { purgeOldLogs, lastPurgeAt } from '../server/services/retention.mjs';

const cfg = (retentionDays) => ({ logging: { retentionDays } });

let seedUserId;

/** 直接指定 ts，才能穩定測試邊界，不必等真的過 30 天。 */
function seedLog(table, daysAgo) {
  const cols = { usage_logs: 'user_id', request_logs: 'request_id', audit_logs: 'action' };
  const val = { usage_logs: seedUserId, request_logs: `req-${daysAgo}`, audit_logs: 'test.action' };
  run(
    `INSERT INTO ${table} (ts, ${cols[table]}) VALUES (datetime('now', ?), ?)`,
    [`-${daysAgo} days`, val[table]],
  );
}

const countIn = (table) => get(`SELECT COUNT(*) AS n FROM ${table}`).n;

before(() => {
  // usage_logs.user_id 有外鍵，schema 也開了 PRAGMA foreign_keys —— 得先有人員
  run("INSERT INTO users (username, role) VALUES ('retention-seed', 'user')");
  seedUserId = get("SELECT id FROM users WHERE username = 'retention-seed'").id;

  for (const table of ['usage_logs', 'request_logs', 'audit_logs']) {
    run(`DELETE FROM ${table}`);
    seedLog(table, 40);   // 逾期
    seedLog(table, 31);   // 逾期（剛好超過一天）
    seedLog(table, 29);   // 保留（剛好在期限內）
    seedLog(table, 0);    // 保留（今天）
  }
});

after(() => closeDb());

test('三張紀錄表都會清掉超過保留期的列', () => {
  const r = purgeOldLogs(cfg(30));
  assert.equal(r.days, 30);
  assert.equal(r.total, 6, '三張表各刪 2 列');
  for (const table of ['usage_logs', 'request_logs', 'audit_logs']) {
    assert.equal(r.deleted[table], 2, `${table} 應刪 2 列`);
    assert.equal(countIn(table), 2, `${table} 應留 2 列`);
  }
});

test('保留期內的紀錄不會被誤刪', () => {
  // 上一項已清過，再跑一次不該再刪到任何東西
  const r = purgeOldLogs(cfg(30));
  assert.equal(r.total, 0);
  for (const table of ['usage_logs', 'request_logs', 'audit_logs']) {
    assert.equal(countIn(table), 2);
  }
});

test('retentionDays 為 0 或負數時視為永久保留，不刪任何資料', () => {
  run("INSERT INTO audit_logs (ts, action) VALUES (datetime('now', '-999 days'), 'ancient')");
  const before999 = countIn('audit_logs');

  assert.equal(purgeOldLogs(cfg(0)), null);
  assert.equal(purgeOldLogs(cfg(-1)), null);
  assert.equal(purgeOldLogs({ logging: {} }) === null, false, '未設定時要套用預設 30 天');

  // 0 / -1 那兩次都沒刪，只有最後一次預設值把 999 天前的清掉
  assert.equal(countIn('audit_logs'), before999 - 1);
});

test('設定值缺漏時退回預設 30 天，而不是不清理', () => {
  run("INSERT INTO usage_logs (ts, user_id) VALUES (datetime('now', '-60 days'), ?)", [seedUserId]);
  const r = purgeOldLogs({});
  assert.equal(r.days, 30);
  assert.equal(r.deleted.usage_logs, 1);
});

test('人員與 API Key 不在清理範圍內', () => {
  run("INSERT INTO users (username, role, created_at) VALUES ('old-user', 'user', datetime('now', '-500 days'))");
  const userId = get("SELECT id FROM users WHERE username = 'old-user'").id;
  run(`INSERT INTO api_keys (user_id, key_hash, key_prefix, last4, name, created_at)
       VALUES (?, 'h', 'agi-bar-', '0001', 'k', datetime('now', '-500 days'))`, [userId]);

  purgeOldLogs(cfg(30));

  assert.ok(get("SELECT id FROM users WHERE username = 'old-user'"), '人員不該被清理');
  assert.equal(all('SELECT id FROM api_keys WHERE user_id = ?', [userId]).length, 1, 'API Key 不該被清理');
});

test('清理後會記下執行時間', () => {
  purgeOldLogs(cfg(30));
  const ts = lastPurgeAt();
  assert.ok(ts, '應寫入 retention.lastRunAt');
  assert.ok(Date.now() - new Date(ts).getTime() < 60000, '時間應是剛才');
});
