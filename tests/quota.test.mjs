/** 時間權限與 Token 估算（規畫書 5 / 6）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTimeWindow, estimateTokens, estimateMessagesTokens } from '../server/services/quota.mjs';

const base = {
  validFrom: null, validUntil: null,
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  dailyWindowStart: '00:00', dailyWindowEnd: '23:59',
};

/** 建立指定本地時間，避開時區換算造成的測試不穩定。 */
function at(y, m, d, hh, mm) { return new Date(y, m - 1, d, hh, mm, 0); }

test('時段內放行', () => {
  assert.doesNotThrow(() =>
    checkTimeWindow({ ...base, dailyWindowStart: '08:00', dailyWindowEnd: '22:00' }, at(2026, 8, 5, 10, 0)));
});

test('時段外拒絕', () => {
  assert.throws(
    () => checkTimeWindow({ ...base, dailyWindowStart: '08:00', dailyWindowEnd: '22:00' }, at(2026, 8, 5, 23, 30)),
    (err) => err.code === 'outside_time_window');
});

test('跨午夜時段（22:00-06:00）正確處理', () => {
  const night = { ...base, dailyWindowStart: '22:00', dailyWindowEnd: '06:00' };
  assert.doesNotThrow(() => checkTimeWindow(night, at(2026, 8, 5, 23, 0)));
  assert.doesNotThrow(() => checkTimeWindow(night, at(2026, 8, 5, 2, 0)));
  assert.throws(() => checkTimeWindow(night, at(2026, 8, 5, 12, 0)));
});

test('只允許工作日時，週末被拒絕', () => {
  const weekdaysOnly = { ...base, weekdays: [1, 2, 3, 4, 5] };
  assert.doesNotThrow(() => checkTimeWindow(weekdaysOnly, at(2026, 8, 5, 10, 0)));  // 週三
  assert.throws(() => checkTimeWindow(weekdaysOnly, at(2026, 8, 8, 10, 0)),          // 週六
    (err) => err.code === 'weekday_not_allowed');
});

test('尚未生效與已到期', () => {
  assert.throws(() => checkTimeWindow({ ...base, validFrom: '2026-09-01' }, at(2026, 8, 5, 10, 0)),
    (err) => err.code === 'not_yet_valid');
  assert.throws(() => checkTimeWindow({ ...base, validUntil: '2026-07-31' }, at(2026, 8, 5, 10, 0)),
    (err) => err.code === 'expired');
  assert.doesNotThrow(() =>
    checkTimeWindow({ ...base, validFrom: '2026-01-01', validUntil: '2026-12-31' }, at(2026, 8, 5, 10, 0)));
});

test('有效期的起訖當天皆算在內', () => {
  assert.doesNotThrow(() =>
    checkTimeWindow({ ...base, validFrom: '2026-08-05', validUntil: '2026-08-05' }, at(2026, 8, 5, 10, 0)));
});

test('Token 估算：中文較密、英文較鬆', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('你好世界') >= 4);
  assert.ok(estimateTokens('hello world this is a test') < 12);
});

test('訊息陣列的估算含角色成本', () => {
  const n = estimateMessagesTokens([
    { role: 'system', content: '你是助理' },
    { role: 'user', content: 'hello' },
  ]);
  assert.ok(n > 8);
});

test('多模態訊息只計文字部分', () => {
  const n = estimateMessagesTokens([
    { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'x' } }] },
  ]);
  assert.ok(n > 0);
});
