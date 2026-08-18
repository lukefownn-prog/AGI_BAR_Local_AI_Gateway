/**
 * 版本號的唯一來源：package.json。
 *
 * 先前 `server/index.mjs` 與 `package.json` 各寫一次版本號，發版要改兩個地方。
 * 漏改不會有任何錯誤訊息 —— 只是啟動橫幅、`/api/health` 與資料庫裡的版本各說各話，
 * 而這種不一致通常要到有人回報「我裝的到底是哪一版」時才會被發現。
 *
 * `scripts/build-portable.mjs` 早就是這樣讀的，這裡只是讓執行期跟它對齊。
 * package.json 本來就是 Portable ZIP 的必要檔案（見 scripts/check-portable.mjs），
 * 讀它不增加任何相依。
 */
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

export const VERSION = pkg.version;
