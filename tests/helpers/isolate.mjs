/**
 * 測試環境隔離。**必須是測試檔的第一個 import。**
 *
 * 為什麼要獨立成一個模組：ESM 會先把所有 import 的模組求值完，才執行檔案裡的
 * 頂層敘述。所以下面這種寫法是錯的 ——
 *
 *   import { something } from '../server/services/xxx.mjs';   // 先執行
 *   process.env.AGIBAR_DATA_DIR = tmp;                        // 後執行，太遲了
 *
 * core/paths.mjs 在模組載入時就固定資料目錄，上面的順序會讓它讀到真實環境，
 * 測試於是靜靜地跑在**正式資料庫**上。這種錯不會讓測試變紅，只會在某天
 * 弄髒或鎖住正式資料時才被發現。
 *
 * 把設定放進被 import 的模組，就能保證它在任何 server 模組之前執行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agibar-test-'));

process.env.AGIBAR_DATA_DIR = path.join(TMP_DIR, 'data');
process.env.AGIBAR_CONFIG_FILE = path.join(TMP_DIR, 'config.json');
process.env.AGIBAR_NO_BROWSER = '1';

/** 由 config.example.json 產生一份測試用設定。 */
export function writeTestConfig(mutate = () => {}) {
  const cfg = JSON.parse(
    fs.readFileSync(new URL('../../config/config.example.json', import.meta.url), 'utf8')
      .replace(/^\s*\/\/.*$/gm, ''),
  );
  delete cfg.$schema;
  cfg.server.port = 0;                    // 讓 OS 挑一個空閒埠，不會撞到正式服務
  cfg.server.openBrowserOnStart = false;
  cfg.backup.enabled = false;
  cfg.logging.toFile = false;
  cfg.logging.level = 'error';
  cfg.models.healthCheckIntervalMs = 3600000;
  mutate(cfg);
  fs.writeFileSync(process.env.AGIBAR_CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

/**
 * 確認伺服器真的跑在隔離環境裡。
 * 在 before() 呼叫一次，讓「測試誤用正式資料」變成紅燈而不是無聲的災難。
 */
export async function assertIsolated() {
  const { paths } = await import('../../server/core/paths.mjs');
  if (!paths.data.startsWith(TMP_DIR)) {
    throw new Error(
      `測試未隔離：資料目錄是 ${paths.data}，不在暫存目錄內。\n`
      + '請確認 tests/helpers/isolate.mjs 是這個測試檔的第一個 import。',
    );
  }
}

export function cleanupTmp() {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
}
