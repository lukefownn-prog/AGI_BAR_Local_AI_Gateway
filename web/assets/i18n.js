/**
 * 多語系（繁體中文 / English / 日本語）。
 *
 * 零相依、無建置流程，字典直接寫在這個檔案裡。
 * 語言存在 localStorage，切換後由各頁面自行重新渲染（onLangChange）。
 *
 * 用法：
 *   靜態 HTML —— 在元素上加 data-i18n="key"（文字）、data-i18n-html="key"（含標籤）、
 *                data-i18n-placeholder="key"、data-i18n-title="key"，再呼叫 applyI18n()。
 *   動態字串 —— t('key', { name: 'x' })，字串中的 {name} 會被替換。
 */

export const LANGS = [
  { code: 'zh-Hant', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
];

const STORE_KEY = 'agibar_lang';
const FALLBACK = 'zh-Hant';
const LANG_EVENT = 'agibar:langchange';

/** 各語言對應的 Intl locale（數字、日期格式用）。 */
const LOCALES = { 'zh-Hant': 'zh-TW', en: 'en-US', ja: 'ja-JP' };

// ==================== 字典 ====================

const ZH = {
  // ---------- 共用 ----------
  'common.language': '語言',
  'common.cancel': '取消',
  'common.save': '儲存',
  'common.close': '關閉',
  'common.ok': '確定',
  'common.confirmTitle': '請確認',
  'common.delete': '刪除',
  'common.manage': '管理',
  'common.loading': '載入中…',
  'common.copy': '複製',
  'common.copied': '已複製',
  'common.copyFailed': '瀏覽器拒絕存取剪貼簿，請手動選取複製',
  'common.saved': '已儲存',
  'common.deleted': '已刪除',
  'common.removed': '已移除',
  'common.added': '已新增',
  'common.revoked': '已撤銷',
  'common.dash': '—',
  'common.notSet': '（未設定）',
  'common.listSep': '、',
  'common.notLoggedIn': '未登入',
  'common.everyday': '每天',

  'status.active': '啟用',
  'status.paused': '暫停',
  'status.disabled': '停用',
  'status.revoked': '已撤銷',

  'health.online': '線上',
  'health.offline': '離線',
  'health.degraded': '壅塞',
  'health.unknown': '未檢查',

  'priority.admin': 'P0 管理員',
  'priority.high': 'P1 高',
  'priority.normal': 'P2 一般',
  'priority.guest': 'P3 訪客',

  'weekday.0': '日',
  'weekday.1': '一',
  'weekday.2': '二',
  'weekday.3': '三',
  'weekday.4': '四',
  'weekday.5': '五',
  'weekday.6': '六',
  'weekdayLabel.0': '週日',
  'weekdayLabel.1': '週一',
  'weekdayLabel.2': '週二',
  'weekdayLabel.3': '週三',
  'weekdayLabel.4': '週四',
  'weekdayLabel.5': '週五',
  'weekdayLabel.6': '週六',

  'tag.local': '本地',
  'tag.external': '外部',
  'tag.externalCloud': '外部雲端',
  'tag.disabledModel': '已停用',

  'uptime.dh': '{d} 天 {h} 時',
  'uptime.hm': '{h} 時 {m} 分',
  'uptime.m': '{m} 分',

  // ---------- 登入頁 ----------
  'login.pageTitle': 'AGI BAR - 管理員登入',
  'login.subtitle': 'Local AI Gateway Management System',
  'login.username': '管理員帳號',
  'login.password': '密碼',
  'login.submit': '登入',
  'login.note': '本系統僅供內部網路使用。人員請改用 API Key 連接 '
    + '<span class="mono">/v1</span>，或前往 <a href="/chat.html">網頁聊天</a>。',
  'login.failed': '登入失敗',
  'login.netError': '無法連線到伺服器：{msg}',

  // ---------- 管理台外框 ----------
  'app.pageTitle': 'AGI BAR 管理台',
  'app.brandSub': 'Local AI Gateway',
  'app.logout': '登出',
  'app.whoami': '{name}（管理員）',
  'app.chatLink': '網頁聊天 ↗',

  'nav.dashboard': '儀表板',
  'nav.users': '人員',
  'nav.keys': 'API',
  'nav.models': 'AI 模型',
  'nav.internet': '網路',
  'nav.logs': '紀錄',
  'nav.settings': '設定',

  'page.dashboard': '儀表板',
  'page.users': '人員管理',
  'page.keys': 'API Key',
  'page.models': 'AI 模型',
  'page.internet': '網路與安全上網',
  'page.logs': '使用紀錄',
  'page.settings': '系統設定',

  // ---------- 儀表板 ----------
  'dash.users': '人員數',
  'dash.usersHint': '在線 {n} 位（近 5 分鐘）',
  'dash.requests': '今日 API 請求',
  'dash.requestsHint': '失敗 {n} 次',
  'dash.tokens': '今日 Token',
  'dash.tokensHint': 'Input + Output 合計',
  'dash.queue': '目前 Queue',
  'dash.queueUnit': ' 等待 / {running} 執行中',
  'dash.queueHint': '平均等待 {ms}',
  'dash.gpu': 'GPU / VRAM',
  'dash.primaryModel': '目前主要模型',
  'dash.noPrimary': '（無）',
  'dash.noModelSet': '尚未設定模型',
  'dash.internet': 'Internet 狀態',
  'dash.internetOpen': '已開放',
  'dash.internetClosed': '未開放',
  'dash.privateBlocked': '內網位址封鎖中',
  'dash.privateUnblocked': '⚠ 內網封鎖已關閉',
  'dash.uptime': '服務運行時間',
  'dash.memFree': '記憶體剩餘 {n} MB',
  'dash.modelPool': '模型池狀態',
  'dash.healthcheck': '立即健康檢查',
  'dash.healthcheckDone': '健康檢查完成',
  'dash.noModels': '尚未設定任何模型',
  'dash.connInfo': '連線資訊',
  'dash.connNote': '人員可用下列位址連接。API Key 由「人員」頁面個別配發。',
  'dash.webui': 'Web UI',
  'dash.apiBase': 'API Base URL',
  'dash.apiKeyRow': '每位人員自己的 <span class="mono">agi-bar-xxxxxxxx</span>',
  'dash.host': '主機',
  'dash.fwTitle': '手機或其他電腦連不到？',
  'dash.fwDesc': '最常見的原因是 Windows 防火牆沒有放行這個連接埠。'
    + '以<b>系統管理員身分</b>開啟 PowerShell，執行下面這行後再試一次：',
  'dash.fwCopy': '複製指令',
  'dash.fwCopied': '已複製防火牆指令',
  'dash.fwNote': '指令只需執行一次。若你的網路被歸類為「公用網路」，把 '
    + '<span class="mono">-Profile Private</span> 改成 '
    + '<span class="mono">-Profile Private,Public</span>（但公用網路環境不建議開放）。',

  'th.model': '模型',
  'th.source': '來源',
  'th.state': '狀態',
  'th.queue': 'Queue',
  'th.firstToken': '首 Token',
  'th.tokensPerSec': 'Token/s',
  'th.errorRate': '錯誤率',
  'th.lastError': '最後錯誤',

  // ---------- 人員 ----------
  'users.title': '人員清單',
  'users.count': '{n} 位（上限 50）',
  'users.add': '＋ 新增人員',
  'users.limitReached': '人員數已達上限 50 位',
  'users.delConfirm': '確定刪除此人員？其 API Key 與路由設定會一併刪除，使用紀錄則會保留。',
  'users.newTitle': '新增人員',
  'users.createBtn': '建立人員',
  'users.createNote': '建立後會自動配發一把 API Key，明文只顯示一次。',

  'th.account': '帳號',
  'th.name': '姓名',
  'th.role': '角色',
  'th.apiKey': 'API Key',
  'th.tokensToday': '今日 Token',
  'th.lastUsed': '最後使用',
  'role.admin': '管理員',
  'role.user': '人員',

  'form.username': '帳號 *',
  'form.usernamePh': '例如 rd-alice',
  'form.displayName': '姓名',
  'form.email': 'Email',
  'form.status': '狀態',
  'form.note': '備註',
  'form.route': '模型優先順序（Model Route）',
  'form.routeHint': '留空則沿用系統預設路由。',

  'detail.title': '人員：{name}',
  'detail.tokensToday': '今日 Token',
  'detail.tokensMonth': '本月 Token',
  'detail.tokensTotal': '累計 Token',
  'detail.newKey': '＋ 發新 Key',
  'detail.noKeys': '尚無 API Key',
  'detail.saveChanges': '儲存變更',
  'detail.rotateConfirm': '換發後舊 Key 立即失效，使用該 Key 的工具需要重新設定。要繼續嗎？',
  'detail.revokeConfirm': '確定撤銷這把 API Key？',

  'th.ident': '識別',
  'th.keyName': '名稱',
  'th.priority': '優先級',
  'th.perDay': '每日',
  'btn.quota': '配額',
  'btn.rotate': '換發',
  'btn.revoke': '撤銷',

  'key.createdTitle': 'API Key 已建立',
  'key.onceWarn': '此明文 Key <b>只會顯示這一次</b>。關閉後系統僅保留雜湊值，無法再次還原。',
  'key.forUser': '人員：{name}',
  'key.copyBtn': '複製到剪貼簿',
  'key.clientSetup': '客戶端設定：',
  'key.baseUrl': 'Base URL',
  'key.keyIsAbove': 'API Key：上方字串',
  'key.doneBtn': '我已複製，關閉',

  // ---------- 配額表單 ----------
  'lim.perRequest': '單次最大 Token',
  'lim.perHour': '每小時 Token',
  'lim.perDay': '每日 Token',
  'lim.perMonth': '每月 Token',
  'lim.rpm': 'RPM（每分鐘請求）',
  'lim.concurrent': 'Concurrent（同時請求）',
  'lim.priority': '優先級',
  'lim.overQuota': '超額處理',
  'lim.hard': 'Hard — 拒絕請求',
  'lim.soft': 'Soft — 降級小模型',
  'lim.internet': '允許上網',
  'lim.internetDeny': '禁止',
  'lim.internetAllow': '允許 Web Search / Fetch',
  'lim.validFrom': '有效日期（起）',
  'lim.validUntil': '有效日期（迄）',
  'lim.windowStart': '每日可用時段（起）',
  'lim.windowEnd': '每日可用時段（迄）',
  'lim.weekdays': '可使用的星期',
  'lim.dialogTitle': '配額設定：{key}',
  'lim.updated': '配額已更新',

  // ---------- 路由選擇器 ----------
  'route.rank': '順位 {n}',
  'route.remove': '移除',
  'route.empty': '尚未指定，將使用系統預設路由',
  'route.addPlaceholder': '＋ 加入模型…',
  'route.suffixExternal': '（外部）',
  'route.suffixExternalCloud': '（外部雲端）',
  'route.suffixDisabled': '（已停用）',
  'route.primary': '主力',
  'route.backup': '備援 {n}',
  'route.moveOut': '移出',
  'route.defaultEmpty': '預設順序是空的 —— 未設定專屬順序的人員將無法使用任何模型。',
  'route.addToOrder': '＋ 把模型加入順序…',

  // ---------- API Key 總表 ----------
  'keys.allTitle': '所有 API Key',
  'th.prefix': '識別前綴',
  'th.user': '人員',
  'th.tokensPerDay': '每日 Token',
  'th.rpm': 'RPM',
  'th.window': '時段',
  'th.expiry': '到期',
  'th.internet': '上網',
  'keys.noExpiry': '無期限',
  'keys.allow': '允許',
  'keys.deny': '禁止',
  'keys.empty': '尚無 API Key，請先到「人員」頁建立人員',

  // ---------- 連線資訊面板 ----------
  'net.title': '連線資訊',
  'net.subtitle': '給人員的網址',
  'net.redetect': '重新偵測 IP',
  'net.redetectShort': '重新偵測',
  'net.noAddress': '偵測不到任何對外網路位址。這台機器可能沒有連上網路。',
  'net.pick': '要使用哪個位址？這台機器偵測到 {n} 個',
  'net.virtualSuffix': '（虛擬介面，其他裝置多半連不到）',
  'net.virtualWarn': '目前選的是<b>虛擬介面</b>的位址，手機與其他電腦多半連不到。'
    + '若清單中有 Wi-Fi 或乙太網路的位址，請改選那一個。',
  'net.rowChat': '網頁聊天（給人員開）',
  'net.rowChatHint': '手機、平板、其他電腦都用這個。管理台不在這個網址上。',
  'net.rowApi': 'API Base URL',
  'net.rowApiHint': 'Cursor / Codex / 自製 App 填這個（Claude Code 例外，見下方）。',
  'net.rowClaude': 'Claude Code 用',
  'net.rowClaudeHint': 'ANTHROPIC_BASE_URL 不加 /v1，SDK 會自己補。',
  'th.purpose': '用途',
  'th.url': '網址',
  'net.copyAll': '複製整份設定說明',
  'net.openChat': '開啟聊天頁 ↗',
  'net.footer': '主機 {host}　連接埠 {port}　偵測時間 {time}',
  'net.footer2': '換了 Wi-Fi 或網路環境之後 IP 會變，記得回來按「重新偵測 IP」並重新發給人員。',
  'net.copiedX': '已複製{label}',
  'net.sheetLabel': '設定說明',
  'net.sheetTitle': 'AGI BAR 連線資訊',
  'net.sheetChat': '網頁聊天：{url}',
  'net.sheetApi': 'API Base URL：{url}',
  'net.sheetCursor': 'Cursor：Settings → Models → 勾選 Override OpenAI Base URL，填上面的 API Base URL',
  'net.sheetCodex': 'Codex：OPENAI_BASE_URL 設為上面的 API Base URL；~/.codex/config.toml 需加 wire_api = "chat"',
  'net.sheetClaude': 'Claude Code：ANTHROPIC_BASE_URL={url}（不加 /v1）',
  'net.sheetFooter': 'API Key 由管理員個別配發，請勿轉發給他人。',

  // ---------- AI 模型 ----------
  'models.defaultOrder': '預設模型順序',
  'models.defaultOrderHint': '順位 1 就是主力模型',
  'models.saveOrder': '儲存順序',
  'models.orderSaved': '順序已儲存',
  'models.orderDesc': '請求會依這個順序嘗試：順位 1 離線、壅塞或健康檢查失敗時，自動改用順位 2，依此類推。'
    + '個別人員可在「人員 → 管理」中設定專屬順序，未設定者就用這裡的預設。',
  'models.missingKeyWarn': '有模型因為<b>缺少 API 金鑰</b>而離線。外部雲端模型的金鑰必須放在環境變數，'
    + '不會存進設定檔。設定方式見下方模型列的錯誤訊息。',
  'models.applyNote': '新增模型後會立即生效，不需重新啟動。設定會寫回 '
    + '<span class="mono">config/config.json</span>，那裡仍是唯一的設定來源。',
  'models.pool': '模型池',
  'models.add': '＋ 新增模型',
  'models.empty': '尚未新增任何模型。按右上角「＋ 新增模型」開始。',
  'models.removeConfirm': '確定從模型池移除「{id}」？'
    + '該模型會從設定檔與所有人員的路由中刪除，使用紀錄則會保留。',
  'th.endpoint': 'Endpoint',
  'th.context': '上下文',
  'th.vram': 'VRAM',
  'th.enabled': '啟用',
  'btn.enable': '啟用',
  'btn.disable': '停用',
  'btn.remove': '移除',

  // ---------- 新增模型對話框 ----------
  'addm.title': '新增模型',
  'addm.intro': '<b>AGI BAR 不執行推論，也不存放模型檔。</b>'
    + '它把請求轉給 Ollama / LM Studio / llama.cpp 這類推理服務。<br>'
    + '要用新模型，先安裝到那些服務裡（Ollama 是 '
    + '<span class="mono">ollama pull &lt;模型名稱&gt;</span>），再回到這裡探索即可。<br>'
    + '專案的 <span class="mono">models/</span> 資料夾放模型檔<b>沒有作用</b> —— '
    + '那只有在你自行內附 llama.cpp 時才用得到。',
  'addm.desc': '填入本地推理服務的 OpenAI 相容端點，按「探索」列出已安裝的模型。',
  'addm.presets': '常用服務',
  'addm.endpoint': '端點網址',
  'addm.discover': '探索',
  'addm.discovering': '探索中…',
  'addm.needEndpoint': '請先填入端點網址',
  'addm.manual': '手動新增（外部雲端 API，例如 DeepSeek）',
  'addm.manualWarn': '<b>外部雲端模型會把 Prompt 送出本機網路。</b>'
    + '依規畫書原則本地模型優先，外部 API 僅作為明確授權的備援。<br>'
    + '金鑰<b>只能</b>放環境變數，這裡填變數名稱而不是金鑰本身 —— 金鑰不會、也不應該寫進設定檔。',
  'addm.id': '模型代號 *',
  'addm.displayName': '顯示名稱',
  'addm.displayNamePh': 'DeepSeek 雲端備援',
  'addm.endpointReq': '端點網址 *',
  'addm.upstream': '上游模型名稱 *',
  'addm.env': '金鑰環境變數',
  'addm.context': '上下文',
  'addm.source': '來源',
  'addm.sourceCloud': '外部雲端',
  'addm.sourceLocal': '本地',
  'addm.addBtn': '新增',

  'disc.found': '找到 {n} 個模型',
  'disc.alreadyN': '（{n} 個已加入過）',
  'th.upstreamModel': '上游模型名稱',
  'th.displayName': '顯示名稱',
  'th.vramMb': 'VRAM (MB)',
  'disc.already': '已加入',
  'disc.add': '加入',
  'disc.note': '上下文與 VRAM 只影響儀表板顯示與超額降級時的模型選擇，填個大概即可，之後可再調整。'
    + '加入的模型會自動排到預設路由的最後一順位。',
  'disc.addedX': '已新增 {model}',

  // ---------- 新增模型說明 ----------
  'guide.title': '怎麼新增模型',
  'guide.common': '<b>共通觀念：AGI BAR 不執行推論，也不存放模型檔。</b>'
    + '真正跑模型的是下面這些推理服務，AGI BAR 只負責驗證、配額、排隊與路由。<br>'
    + '所以流程一律是<b>兩步</b>：① 把模型裝進推理服務 → ② 回到這一頁註冊它的端點。<br>'
    + '直接把 GGUF 檔丟進專案的 <span class="mono">models/</span> 資料夾<b>不會有任何作用</b>。',
  'guide.footer': '新增完記得到本頁上方的<b>預設模型順序</b>確認主力與備援的排序 —— '
    + '沒有排進順序的模型不會被任何請求選到。',

  'guide.ollama.badge': '最簡單',
  'guide.ollama.s1': '安裝 Ollama 後它會自動在背景執行，預設監聽 <span class="mono">11434</span>。',
  'guide.ollama.s2': '下載模型（在 AI 主機的命令列執行）：',
  'guide.ollama.hf': '也可以直接拉 Hugging Face 上的 GGUF：',
  'guide.ollama.s3': '確認裝好了：<span class="mono">ollama list</span>',
  'guide.ollama.s4': '回到本頁按「＋ 新增模型」→ 點 <b>Ollama</b> → <b>探索</b> → 勾選要用的模型 → <b>加入</b>。',
  'guide.ollama.warn': '<b>第一次呼叫會等很久</b>（實測約 60 秒）—— 那是 Ollama 把模型載進 VRAM 的時間，之後就正常。'
    + '要避免的話，先在主機跑一次 <span class="mono">ollama run &lt;模型&gt;</span> 預熱。',
  'guide.ollama.store': '模型存在 <span class="mono">%USERPROFILE%\\.ollama\\models</span>（可用 '
    + '<span class="mono">OLLAMA_MODELS</span> 環境變數改），以內容定址的 blob 保存，不是可搬動的 GGUF 檔。',

  'guide.lmstudio.badge': '有圖形介面',
  'guide.lmstudio.s1': '在 LM Studio 的 <b>Discover</b> 分頁搜尋並下載模型。',
  'guide.lmstudio.s2': '切到 <b>Developer</b>（舊版是 <b>Local Server</b>）分頁，按 <b>Start Server</b>，'
    + '預設埠 <span class="mono">1234</span>。',
  'guide.lmstudio.s3': '回到本頁按「＋ 新增模型」→ 點 <b>LM Studio</b> → <b>探索</b>。',
  'guide.lmstudio.warn': '<b>沒按 Start Server 就探索不到。</b> LM Studio 的模型下載完並不會自動對外提供 API，'
    + '一定要手動啟動伺服器。另外模型需要載入記憶體才能回應，'
    + '建議在設定中開啟 JIT loading，否則第一次呼叫可能失敗而不是等待。',

  'guide.llamacpp.title': 'llama.cpp server',
  'guide.llamacpp.badge': '最省資源',
  'guide.llamacpp.s1': '下載或自行編譯 llama.cpp 的 <span class="mono">llama-server</span>。',
  'guide.llamacpp.s2': '準備 GGUF 模型檔。<b>這是唯一會用到專案 <span class="mono">models/</span> 資料夾的情況</b>'
    + ' —— 把 GGUF 放在那裡方便管理。',
  'guide.llamacpp.s3': '啟動伺服器（一個行程通常只服務一個模型）：',
  'guide.llamacpp.s4': '回到本頁 →「＋ 新增模型」→ 點 <b>llama.cpp server</b> → <b>探索</b>。',
  'guide.llamacpp.note': '要同時提供多個模型，就開多個行程用不同的埠（8080、8081…），'
    + '每個都在本頁各自新增一次，再到上方「預設模型順序」排出主力與備援。',

  'guide.vllm.badge': '多人高吞吐',
  'guide.vllm.s1': '在有 NVIDIA GPU 的機器上安裝 vLLM（一般是 Linux 環境）。',
  'guide.vllm.s2': '啟動服務：',
  'guide.vllm.s3': '回到本頁 →「＋ 新增模型」→ 點 <b>vLLM</b> → <b>探索</b>。',
  'guide.vllm.info': '<b>若 vLLM 跑在另一台機器</b>，端點要改成那台的位址'
    + '（例如 <span class="mono">http://192.168.1.20:8000/v1</span>），'
    + '不能用 <span class="mono">localhost</span>。同時確認那台的防火牆有放行該埠。',
  'guide.vllm.note': 'vLLM 的批次處理能力較強，人數多時吞吐量明顯優於 Ollama，但啟動較慢且記憶體佔用較高。',

  'guide.cloud.title': '外部雲端 API（DeepSeek 等）',
  'guide.cloud.badge': '需明確授權',
  'guide.cloud.warn': '<b>啟用外部模型等同同意把該路由的 Prompt 送出本機網路。</b>'
    + '規畫書的原則是本地開源模型優先，外部 API 只作為管理員明確授權的備援。請先確認符合公司政策。',
  'guide.cloud.s1': '在 <b>AI 主機</b>設定金鑰環境變數。金鑰不寫進設定檔：',
  'guide.cloud.s2': '<b>完全關閉 AGI BAR 再重新啟動。</b> <span class="mono">setx</span> 只對之後新開的行程生效，'
    + '重新整理網頁沒有用。',
  'guide.cloud.s3': '按「＋ 新增模型」→ 展開最下方的 <b>手動新增（外部雲端 API）</b>，填入：',
  'guide.cloud.s4': '按「立即健康檢查」確認狀態：',
  'guide.cloud.s5': '決定它在路由中的位置。<b>外部模型加入後預設不進路由</b> —— 要不要用是你的明確決定。',
  'guide.cloud.thId': '模型代號',
  'guide.cloud.thEndpoint': '端點網址',
  'guide.cloud.thModel': '上游模型名稱',
  'guide.cloud.thEnv': '金鑰環境變數',
  'guide.cloud.thEnvNote': '填變數名稱，不是金鑰本身',
  'guide.cloud.thSource': '來源',
  'guide.cloud.sourceCloud': '外部雲端',
  'guide.cloud.stOnlineDone': '完成',
  'guide.cloud.stMissingEnv': '缺少環境變數…',
  'guide.cloud.stMissingEnvFix': '服務還沒讀到新的環境變數 → 重啟 AGI BAR',
  'guide.cloud.st401': '金鑰本身無效或已失效',
  'guide.cloud.note': '想讓全體人員在本地模型全掛時才用它：到本頁上方「預設模型順序」把它加到<b>最後一順位</b>。<br>'
    + '只給特定人員：到「人員 → 管理」設定該人員的專屬順序。',

  // ---------- 網路 ----------
  'inet.policy': '受控上網政策',
  'inet.warn': '本地模型不會直接連 Internet。所有外連都必須經過 Gateway 的政策檢查後，'
    + '由 Gateway 擷取文字再送給模型。',
  'inet.sysLevel': '系統層級上網',
  'inet.off': '關閉（建議預設）',
  'inet.on': '開放',
  'inet.blockPrivate': '封鎖內網位址',
  'inet.enabledRec': '啟用（強烈建議）',
  'inet.disabled': '停用',
  'inet.searchEndpoint': '搜尋服務端點（SearXNG 等，留空為停用）',
  'inet.maxResults': '搜尋結果上限',
  'inet.maxBytes': '最大下載大小（bytes）',
  'inet.timeout': '逾時（ms）',
  'inet.maxRedirects': '最大重導向次數',
  'inet.allowlist': '網域允許清單（每行一筆，留空代表不限制）',
  'inet.blocklist': '網域封鎖清單（每行一筆）',
  'inet.cidrs': '封鎖的 IP 範圍（CIDR，每行一筆）',
  'inet.types': '允許的 Content-Type（每行一筆）',
  'inet.save': '儲存政策',
  'inet.saved': '網路政策已儲存',
  'inet.testTitle': '政策測試',
  'inet.testDesc': '在開放給人員之前，先確認某個網址會被放行或封鎖。',
  'inet.testBtn': '測試',
  'inet.testing': '測試中…',
  'inet.allowed': '✓ 放行',
  'inet.blocked': '✕ 已封鎖（{code}）',

  // ---------- 紀錄 ----------
  'logs.tokens14': '近 14 天 Token 用量',
  'logs.noData': '尚無資料',
  'logs.perUser': '每人 Token 用量（近 14 天）',
  'logs.perModel': '各模型使用量',
  'logs.recent': '最近請求',
  'logs.noRequests': '尚無請求紀錄',
  'logs.web': '受控上網紀錄',
  'logs.noWeb': '尚無上網紀錄',
  'logs.success': '成功',
  'logs.pass': '放行',
  'logs.block': '封鎖',
  'th.calls': '呼叫次數',
  'th.input': 'Input',
  'th.output': 'Output',
  'th.total': '合計',
  'th.tokens': 'Token',
  'th.time': '時間',
  'th.servedModel': '使用模型',
  'th.failover': 'Failover',
  'th.wait': '等待',
  'th.inference': '推理',
  'th.result': '結果',
  'th.tool': '工具',
  'th.target': '目標',
  'th.resolvedIp': '解析 IP',

  // ---------- 設定 ----------
  'set.security': '安全',
  'set.changePw': '修改管理員密碼',
  'set.export': '匯出設定（不含祕密）',
  'set.exportNote': 'API Key、密碼與外部憑證不會出現在匯出檔中。',
  'set.queue': 'Priority Queue',
  'set.qConcurrent': '全域同時執行上限',
  'set.qLength': '佇列長度上限',
  'set.qTimeout': '排隊逾時（ms）',
  'set.antiStarvation': 'Anti-starvation',
  'set.boostEvery': '每等待多久提升一級（ms）',
  'set.maxBoost': '最大提升級數',
  'set.saveQueue': '儲存佇列設定',
  'set.queueSaved': '佇列設定已套用',
  'set.enable': '啟用',
  'set.disable': '停用',
  'set.backup': '備份',
  'set.backupNow': '立即備份',
  'set.backupDone': '備份完成',
  'set.noBackup': '尚無備份',
  'th.backupFile': '備份檔',
  'th.size': '大小',
  'th.createdAt': '建立時間',
  'set.sysinfo': '系統資訊',
  'set.port': '服務連接埠',
  'set.maxUsers': '人員上限',
  'set.hcInterval': '健康檢查間隔',
  'set.defaultRoute': '預設模型路由',
  'set.retention': '紀錄保留',
  'set.retentionDays': '{n} 天',
  'set.logPrompts': '記錄 Prompt 內容',
  'set.logHashOnly': '僅記錄 Prompt 雜湊',
  'set.editNote': '更完整的設定請直接編輯 <span class="mono">config/config.json</span> 後重新啟動服務。',

  'pw.title': '修改管理員密碼',
  'pw.warn': '首次啟動使用的預設密碼寫在設定檔中，請務必更換。',
  'pw.new': '新密碼（至少 8 字元）',
  'pw.again': '再次輸入',
  'pw.later': '稍後再說',
  'pw.update': '更新密碼',
  'pw.mismatch': '兩次輸入不一致',
  'pw.tooShort': '密碼至少需 8 個字元',
  'pw.updated': '密碼已更新',

  // ---------- 網頁聊天 ----------
  'chat.pageTitle': 'AGI BAR - 網頁聊天',
  'chat.notConnected': '尚未連線',
  'chat.keyBtn': 'API Key',
  'chat.clearBtn': '清除對話',
  'chat.welcomeTitle': '開始對話',
  'chat.welcomeDesc': '請先按右上角「API Key」輸入管理員配發給你的 Key。<br>'
    + 'Key 只保存在這台瀏覽器，不會送往管理端以外的地方。',
  'chat.placeholder': '輸入訊息…（Enter 送出，Shift+Enter 換行）',
  'chat.send': '送出',
  'chat.cleared': '對話已清除。',
  'chat.keyInvalid': 'API Key 無效',
  'chat.remaining': '今日剩餘 {n} Token',
  'chat.cannotConnect': '無法連線：{msg}',
  'chat.keyTitle': '設定 API Key',
  'chat.keyDesc': '請輸入管理員配發給你的 API Key。Key 只會保存在這台瀏覽器的 localStorage。',
  'chat.keyInfo': '同一把 Key 也可用於 Cursor / Claude Code / Codex 等工具。',
  'chat.connected': '已連線',
  'chat.keyFailed': 'API Key 驗證失敗',
  'chat.avatarUser': '我',
  'chat.avatarAi': 'AI',
  'chat.error': '錯誤：{msg}',
};

const EN = {
  // ---------- Common ----------
  'common.language': 'Language',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.close': 'Close',
  'common.ok': 'OK',
  'common.confirmTitle': 'Please confirm',
  'common.delete': 'Delete',
  'common.manage': 'Manage',
  'common.loading': 'Loading…',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.copyFailed': 'The browser blocked clipboard access. Please select and copy manually.',
  'common.saved': 'Saved',
  'common.deleted': 'Deleted',
  'common.removed': 'Removed',
  'common.added': 'Added',
  'common.revoked': 'Revoked',
  'common.dash': '—',
  'common.notSet': '(not set)',
  'common.listSep': ', ',
  'common.notLoggedIn': 'Not signed in',
  'common.everyday': 'Every day',

  'status.active': 'Active',
  'status.paused': 'Paused',
  'status.disabled': 'Disabled',
  'status.revoked': 'Revoked',

  'health.online': 'Online',
  'health.offline': 'Offline',
  'health.degraded': 'Congested',
  'health.unknown': 'Not checked',

  'priority.admin': 'P0 Admin',
  'priority.high': 'P1 High',
  'priority.normal': 'P2 Normal',
  'priority.guest': 'P3 Guest',

  'weekday.0': 'Sun',
  'weekday.1': 'Mon',
  'weekday.2': 'Tue',
  'weekday.3': 'Wed',
  'weekday.4': 'Thu',
  'weekday.5': 'Fri',
  'weekday.6': 'Sat',
  'weekdayLabel.0': 'Sun',
  'weekdayLabel.1': 'Mon',
  'weekdayLabel.2': 'Tue',
  'weekdayLabel.3': 'Wed',
  'weekdayLabel.4': 'Thu',
  'weekdayLabel.5': 'Fri',
  'weekdayLabel.6': 'Sat',

  'tag.local': 'Local',
  'tag.external': 'External',
  'tag.externalCloud': 'External cloud',
  'tag.disabledModel': 'Disabled',

  'uptime.dh': '{d}d {h}h',
  'uptime.hm': '{h}h {m}m',
  'uptime.m': '{m}m',

  // ---------- Login ----------
  'login.pageTitle': 'AGI BAR - Admin Sign-in',
  'login.subtitle': 'Local AI Gateway Management System',
  'login.username': 'Admin username',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.note': 'This system is for internal network use only. Users should connect to '
    + '<span class="mono">/v1</span> with an API key, or open the <a href="/chat.html">web chat</a>.',
  'login.failed': 'Sign-in failed',
  'login.netError': 'Cannot reach the server: {msg}',

  // ---------- Admin shell ----------
  'app.pageTitle': 'AGI BAR Admin Console',
  'app.brandSub': 'Local AI Gateway',
  'app.logout': 'Sign out',
  'app.whoami': '{name} (Admin)',
  'app.chatLink': 'Web chat ↗',

  'nav.dashboard': 'Dashboard',
  'nav.users': 'Users',
  'nav.keys': 'API',
  'nav.models': 'AI Models',
  'nav.internet': 'Network',
  'nav.logs': 'Logs',
  'nav.settings': 'Settings',

  'page.dashboard': 'Dashboard',
  'page.users': 'User Management',
  'page.keys': 'API Keys',
  'page.models': 'AI Models',
  'page.internet': 'Network & Controlled Browsing',
  'page.logs': 'Usage Logs',
  'page.settings': 'System Settings',

  // ---------- Dashboard ----------
  'dash.users': 'Users',
  'dash.usersHint': '{n} online (last 5 min)',
  'dash.requests': 'API requests today',
  'dash.requestsHint': '{n} failed',
  'dash.tokens': 'Tokens today',
  'dash.tokensHint': 'Input + Output combined',
  'dash.queue': 'Current queue',
  'dash.queueUnit': ' waiting / {running} running',
  'dash.queueHint': 'Average wait {ms}',
  'dash.gpu': 'GPU / VRAM',
  'dash.primaryModel': 'Current primary model',
  'dash.noPrimary': '(none)',
  'dash.noModelSet': 'No model configured yet',
  'dash.internet': 'Internet status',
  'dash.internetOpen': 'Enabled',
  'dash.internetClosed': 'Disabled',
  'dash.privateBlocked': 'Private addresses blocked',
  'dash.privateUnblocked': '⚠ Private-network blocking is off',
  'dash.uptime': 'Service uptime',
  'dash.memFree': '{n} MB memory free',
  'dash.modelPool': 'Model pool status',
  'dash.healthcheck': 'Run health check',
  'dash.healthcheckDone': 'Health check complete',
  'dash.noModels': 'No models configured yet',
  'dash.connInfo': 'Connection info',
  'dash.connNote': 'Users can connect with the addresses below. API keys are issued per person on the Users page.',
  'dash.webui': 'Web UI',
  'dash.apiBase': 'API Base URL',
  'dash.apiKeyRow': 'Each person’s own <span class="mono">agi-bar-xxxxxxxx</span>',
  'dash.host': 'Host',
  'dash.fwTitle': 'Phones or other computers can’t connect?',
  'dash.fwDesc': 'The most common cause is that the Windows firewall is not allowing this port. '
    + 'Open PowerShell <b>as Administrator</b>, run the line below, then try again:',
  'dash.fwCopy': 'Copy command',
  'dash.fwCopied': 'Firewall command copied',
  'dash.fwNote': 'The command only needs to be run once. If your network is classified as “Public”, change '
    + '<span class="mono">-Profile Private</span> to '
    + '<span class="mono">-Profile Private,Public</span> (opening it on a public network is not recommended).',

  'th.model': 'Model',
  'th.source': 'Source',
  'th.state': 'State',
  'th.queue': 'Queue',
  'th.firstToken': 'First token',
  'th.tokensPerSec': 'Token/s',
  'th.errorRate': 'Error rate',
  'th.lastError': 'Last error',

  // ---------- Users ----------
  'users.title': 'User list',
  'users.count': '{n} of 50 max',
  'users.add': '＋ Add user',
  'users.limitReached': 'User count has reached the limit of 50',
  'users.delConfirm': 'Delete this user? Their API keys and route settings are deleted with them; usage logs are kept.',
  'users.newTitle': 'Add user',
  'users.createBtn': 'Create user',
  'users.createNote': 'An API key is issued automatically on creation. The plaintext is shown only once.',

  'th.account': 'Account',
  'th.name': 'Name',
  'th.role': 'Role',
  'th.apiKey': 'API keys',
  'th.tokensToday': 'Tokens today',
  'th.lastUsed': 'Last used',
  'role.admin': 'Admin',
  'role.user': 'User',

  'form.username': 'Account *',
  'form.usernamePh': 'e.g. rd-alice',
  'form.displayName': 'Name',
  'form.email': 'Email',
  'form.status': 'Status',
  'form.note': 'Note',
  'form.route': 'Model priority (model route)',
  'form.routeHint': 'Leave empty to use the system default route.',

  'detail.title': 'User: {name}',
  'detail.tokensToday': 'Tokens today',
  'detail.tokensMonth': 'Tokens this month',
  'detail.tokensTotal': 'Tokens total',
  'detail.newKey': '＋ Issue new key',
  'detail.noKeys': 'No API keys yet',
  'detail.saveChanges': 'Save changes',
  'detail.rotateConfirm': 'After rotation the old key stops working immediately and every tool using it must be '
    + 'reconfigured. Continue?',
  'detail.revokeConfirm': 'Revoke this API key?',

  'th.ident': 'Identifier',
  'th.keyName': 'Name',
  'th.priority': 'Priority',
  'th.perDay': 'Per day',
  'btn.quota': 'Quota',
  'btn.rotate': 'Rotate',
  'btn.revoke': 'Revoke',

  'key.createdTitle': 'API key created',
  'key.onceWarn': 'This plaintext key <b>is shown only once</b>. After closing, only the hash is kept and it '
    + 'cannot be recovered.',
  'key.forUser': 'User: {name}',
  'key.copyBtn': 'Copy to clipboard',
  'key.clientSetup': 'Client setup:',
  'key.baseUrl': 'Base URL',
  'key.keyIsAbove': 'API key: the string above',
  'key.doneBtn': 'Copied — close',

  // ---------- Quota form ----------
  'lim.perRequest': 'Max tokens per request',
  'lim.perHour': 'Tokens per hour',
  'lim.perDay': 'Tokens per day',
  'lim.perMonth': 'Tokens per month',
  'lim.rpm': 'RPM (requests per minute)',
  'lim.concurrent': 'Concurrent requests',
  'lim.priority': 'Priority',
  'lim.overQuota': 'Over-quota policy',
  'lim.hard': 'Hard — reject the request',
  'lim.soft': 'Soft — fall back to a small model',
  'lim.internet': 'Internet access',
  'lim.internetDeny': 'Denied',
  'lim.internetAllow': 'Allow web search / fetch',
  'lim.validFrom': 'Valid from',
  'lim.validUntil': 'Valid until',
  'lim.windowStart': 'Daily window (start)',
  'lim.windowEnd': 'Daily window (end)',
  'lim.weekdays': 'Allowed weekdays',
  'lim.dialogTitle': 'Quota settings: {key}',
  'lim.updated': 'Quota updated',

  // ---------- Route picker ----------
  'route.rank': 'Rank {n}',
  'route.remove': 'Remove',
  'route.empty': 'Not specified — the system default route will be used',
  'route.addPlaceholder': '＋ Add a model…',
  'route.suffixExternal': ' (external)',
  'route.suffixExternalCloud': ' (external cloud)',
  'route.suffixDisabled': ' (disabled)',
  'route.primary': 'Primary',
  'route.backup': 'Backup {n}',
  'route.moveOut': 'Move out',
  'route.defaultEmpty': 'The default order is empty — users without their own order cannot use any model.',
  'route.addToOrder': '＋ Add a model to the order…',

  // ---------- API key table ----------
  'keys.allTitle': 'All API keys',
  'th.prefix': 'Prefix',
  'th.user': 'User',
  'th.tokensPerDay': 'Tokens/day',
  'th.rpm': 'RPM',
  'th.window': 'Window',
  'th.expiry': 'Expiry',
  'th.internet': 'Internet',
  'keys.noExpiry': 'No expiry',
  'keys.allow': 'Allowed',
  'keys.deny': 'Denied',
  'keys.empty': 'No API keys yet — create a user on the Users page first',

  // ---------- Connection panel ----------
  'net.title': 'Connection info',
  'net.subtitle': 'addresses to hand out',
  'net.redetect': 'Re-detect IP',
  'net.redetectShort': 'Re-detect',
  'net.noAddress': 'No outward-facing network address detected. This machine may not be connected to a network.',
  'net.pick': 'Which address should be used? {n} were detected on this machine',
  'net.virtualSuffix': ' (virtual interface — usually unreachable from other devices)',
  'net.virtualWarn': 'The selected address belongs to a <b>virtual interface</b>, which phones and other computers '
    + 'usually cannot reach. If the list contains a Wi-Fi or Ethernet address, pick that one instead.',
  'net.rowChat': 'Web chat (for users)',
  'net.rowChatHint': 'Phones, tablets and other computers all use this. The admin console is not on this address.',
  'net.rowApi': 'API Base URL',
  'net.rowApiHint': 'Use this for Cursor / Codex / your own apps (Claude Code is the exception — see below).',
  'net.rowClaude': 'For Claude Code',
  'net.rowClaudeHint': 'ANTHROPIC_BASE_URL takes no /v1 — the SDK appends it.',
  'th.purpose': 'Purpose',
  'th.url': 'URL',
  'net.copyAll': 'Copy the full setup notes',
  'net.openChat': 'Open chat page ↗',
  'net.footer': 'Host {host}　Port {port}　Detected {time}',
  'net.footer2': 'The IP changes when you switch Wi-Fi or networks — come back, press “Re-detect IP”, and hand the '
    + 'new address out again.',
  'net.copiedX': 'Copied {label}',
  'net.sheetLabel': 'setup notes',
  'net.sheetTitle': 'AGI BAR connection info',
  'net.sheetChat': 'Web chat: {url}',
  'net.sheetApi': 'API Base URL: {url}',
  'net.sheetCursor': 'Cursor: Settings → Models → tick Override OpenAI Base URL, enter the API Base URL above',
  'net.sheetCodex': 'Codex: set OPENAI_BASE_URL to the API Base URL above; ~/.codex/config.toml needs '
    + 'wire_api = "chat"',
  'net.sheetClaude': 'Claude Code: ANTHROPIC_BASE_URL={url} (no /v1)',
  'net.sheetFooter': 'API keys are issued individually by the administrator. Do not forward yours to anyone else.',

  // ---------- Models ----------
  'models.defaultOrder': 'Default model order',
  'models.defaultOrderHint': 'rank 1 is the primary model',
  'models.saveOrder': 'Save order',
  'models.orderSaved': 'Order saved',
  'models.orderDesc': 'Requests try this order: when rank 1 is offline, congested or fails its health check, rank 2 '
    + 'is used automatically, and so on. Individual users can set their own order under Users → Manage; everyone '
    + 'else uses this default.',
  'models.missingKeyWarn': 'A model is offline because it is <b>missing an API key</b>. Keys for external cloud '
    + 'models must live in environment variables and are never stored in the config file. See the error message on '
    + 'the model row below for how to set it.',
  'models.applyNote': 'New models take effect immediately — no restart needed. Settings are written back to '
    + '<span class="mono">config/config.json</span>, which remains the single source of truth.',
  'models.pool': 'Model pool',
  'models.add': '＋ Add model',
  'models.empty': 'No models added yet. Press “＋ Add model” at the top right to start.',
  'models.removeConfirm': 'Remove “{id}” from the model pool? It is deleted from the config file and from every '
    + 'user’s route; usage logs are kept.',
  'th.endpoint': 'Endpoint',
  'th.context': 'Context',
  'th.vram': 'VRAM',
  'th.enabled': 'Enabled',
  'btn.enable': 'Enable',
  'btn.disable': 'Disable',
  'btn.remove': 'Remove',

  // ---------- Add model dialog ----------
  'addm.title': 'Add model',
  'addm.intro': '<b>AGI BAR does not run inference and does not store model files.</b> '
    + 'It forwards requests to inference services such as Ollama / LM Studio / llama.cpp.<br>'
    + 'To use a new model, install it into one of those services first (with Ollama that is '
    + '<span class="mono">ollama pull &lt;model&gt;</span>), then come back here and discover it.<br>'
    + 'Putting model files in the project’s <span class="mono">models/</span> folder <b>does nothing</b> — '
    + 'that folder only matters if you bundle llama.cpp yourself.',
  'addm.desc': 'Enter the OpenAI-compatible endpoint of your local inference service and press “Discover” to list '
    + 'the installed models.',
  'addm.presets': 'Common services',
  'addm.endpoint': 'Endpoint URL',
  'addm.discover': 'Discover',
  'addm.discovering': 'Discovering…',
  'addm.needEndpoint': 'Enter an endpoint URL first',
  'addm.manual': 'Add manually (external cloud API, e.g. DeepSeek)',
  'addm.manualWarn': '<b>External cloud models send prompts outside this machine’s network.</b> '
    + 'By design local models come first and external APIs serve only as an explicitly authorised fallback.<br>'
    + 'Keys <b>must</b> live in environment variables — enter the variable name here, not the key itself. '
    + 'Keys are never written to the config file.',
  'addm.id': 'Model ID *',
  'addm.displayName': 'Display name',
  'addm.displayNamePh': 'DeepSeek cloud fallback',
  'addm.endpointReq': 'Endpoint URL *',
  'addm.upstream': 'Upstream model name *',
  'addm.env': 'Key environment variable',
  'addm.context': 'Context',
  'addm.source': 'Source',
  'addm.sourceCloud': 'External cloud',
  'addm.sourceLocal': 'Local',
  'addm.addBtn': 'Add',

  'disc.found': 'Found {n} model(s)',
  'disc.alreadyN': ' ({n} already added)',
  'th.upstreamModel': 'Upstream model name',
  'th.displayName': 'Display name',
  'th.vramMb': 'VRAM (MB)',
  'disc.already': 'Added',
  'disc.add': 'Add',
  'disc.note': 'Context and VRAM only affect the dashboard display and model choice when downgrading over quota, so '
    + 'a rough figure is fine and can be adjusted later. Added models go to the end of the default route.',
  'disc.addedX': 'Added {model}',

  // ---------- Model guide ----------
  'guide.title': 'How to add a model',
  'guide.common': '<b>Shared concept: AGI BAR does not run inference and does not store model files.</b> '
    + 'The inference services below actually run the models; AGI BAR only handles authentication, quotas, queueing '
    + 'and routing.<br>'
    + 'So the flow is always <b>two steps</b>: ① install the model into an inference service → ② come back to this '
    + 'page and register its endpoint.<br>'
    + 'Dropping a GGUF file into the project’s <span class="mono">models/</span> folder <b>does nothing at all</b>.',
  'guide.footer': 'After adding, check the <b>default model order</b> at the top of this page to confirm the primary '
    + 'and fallback ranking — a model that is not in the order will never be chosen by any request.',

  'guide.ollama.badge': 'Easiest',
  'guide.ollama.s1': 'After installing Ollama it runs in the background automatically, listening on '
    + '<span class="mono">11434</span> by default.',
  'guide.ollama.s2': 'Download a model (run this on the AI host’s command line):',
  'guide.ollama.hf': 'You can also pull a GGUF straight from Hugging Face:',
  'guide.ollama.s3': 'Confirm it is installed: <span class="mono">ollama list</span>',
  'guide.ollama.s4': 'Come back here, press “＋ Add model” → click <b>Ollama</b> → <b>Discover</b> → tick the models '
    + 'you want → <b>Add</b>.',
  'guide.ollama.warn': '<b>The first call takes a long time</b> (around 60 seconds in practice) — that is Ollama '
    + 'loading the model into VRAM; later calls are normal. To avoid it, run '
    + '<span class="mono">ollama run &lt;model&gt;</span> once on the host to warm it up.',
  'guide.ollama.store': 'Models are stored in <span class="mono">%USERPROFILE%\\.ollama\\models</span> (changeable '
    + 'with the <span class="mono">OLLAMA_MODELS</span> environment variable) as content-addressed blobs, not as '
    + 'portable GGUF files.',

  'guide.lmstudio.badge': 'Has a GUI',
  'guide.lmstudio.s1': 'Search for and download a model on LM Studio’s <b>Discover</b> tab.',
  'guide.lmstudio.s2': 'Switch to the <b>Developer</b> tab (<b>Local Server</b> in older versions), press '
    + '<b>Start Server</b>; the default port is <span class="mono">1234</span>.',
  'guide.lmstudio.s3': 'Come back here, press “＋ Add model” → click <b>LM Studio</b> → <b>Discover</b>.',
  'guide.lmstudio.warn': '<b>Without pressing Start Server there is nothing to discover.</b> LM Studio does not '
    + 'expose an API automatically once a model finishes downloading — the server must be started by hand. A model '
    + 'also has to be loaded into memory before it can answer, so enabling JIT loading in the settings is '
    + 'recommended; otherwise the first call may fail instead of waiting.',

  'guide.llamacpp.title': 'llama.cpp server',
  'guide.llamacpp.badge': 'Lightest',
  'guide.llamacpp.s1': 'Download or build llama.cpp’s <span class="mono">llama-server</span>.',
  'guide.llamacpp.s2': 'Prepare a GGUF model file. <b>This is the only case where the project’s '
    + '<span class="mono">models/</span> folder is used</b> — keeping the GGUF there is simply convenient.',
  'guide.llamacpp.s3': 'Start the server (one process usually serves one model):',
  'guide.llamacpp.s4': 'Come back here → “＋ Add model” → click <b>llama.cpp server</b> → <b>Discover</b>.',
  'guide.llamacpp.note': 'To serve several models at once, start several processes on different ports (8080, 8081…), '
    + 'add each one separately on this page, then arrange primary and fallback under “Default model order” above.',

  'guide.vllm.badge': 'High throughput',
  'guide.vllm.s1': 'Install vLLM on a machine with an NVIDIA GPU (usually a Linux environment).',
  'guide.vllm.s2': 'Start the service:',
  'guide.vllm.s3': 'Come back here → “＋ Add model” → click <b>vLLM</b> → <b>Discover</b>.',
  'guide.vllm.info': '<b>If vLLM runs on another machine</b>, the endpoint must point at that machine '
    + '(e.g. <span class="mono">http://192.168.1.20:8000/v1</span>) — <span class="mono">localhost</span> will not '
    + 'work. Also make sure that machine’s firewall allows the port.',
  'guide.vllm.note': 'vLLM batches much better, so throughput clearly beats Ollama with many users, but it starts '
    + 'more slowly and uses more memory.',

  'guide.cloud.title': 'External cloud APIs (DeepSeek and similar)',
  'guide.cloud.badge': 'Needs explicit approval',
  'guide.cloud.warn': '<b>Enabling an external model means agreeing that prompts on that route leave this machine’s '
    + 'network.</b> The design principle is local open-source models first, with external APIs only as a fallback '
    + 'the administrator has explicitly authorised. Please confirm it complies with company policy first.',
  'guide.cloud.s1': 'Set the key environment variable on the <b>AI host</b>. Keys are not written to the config file:',
  'guide.cloud.s2': '<b>Shut AGI BAR down completely and start it again.</b> <span class="mono">setx</span> only '
    + 'affects processes started afterwards — refreshing the page does nothing.',
  'guide.cloud.s3': 'Press “＋ Add model” → expand <b>Add manually (external cloud API)</b> at the bottom and fill in:',
  'guide.cloud.s4': 'Press “Run health check” to confirm the state:',
  'guide.cloud.s5': 'Decide where it sits in the route. <b>External models stay out of the route by default</b> — '
    + 'whether to use one is your explicit decision.',
  'guide.cloud.thId': 'Model ID',
  'guide.cloud.thEndpoint': 'Endpoint URL',
  'guide.cloud.thModel': 'Upstream model name',
  'guide.cloud.thEnv': 'Key environment variable',
  'guide.cloud.thEnvNote': 'the variable name, not the key itself',
  'guide.cloud.thSource': 'Source',
  'guide.cloud.sourceCloud': 'External cloud',
  'guide.cloud.stOnlineDone': 'Done',
  'guide.cloud.stMissingEnv': 'missing environment variable…',
  'guide.cloud.stMissingEnvFix': 'the service has not picked up the new environment variable → restart AGI BAR',
  'guide.cloud.st401': 'the key itself is invalid or expired',
  'guide.cloud.note': 'To let everyone fall back to it only when every local model is down: add it as the '
    + '<b>last rank</b> under “Default model order” above.<br>'
    + 'For specific people only: set that person’s own order under Users → Manage.',

  // ---------- Network ----------
  'inet.policy': 'Controlled browsing policy',
  'inet.warn': 'Local models never reach the Internet directly. Every outbound request must pass the gateway’s '
    + 'policy check; the gateway then fetches the text and passes it to the model.',
  'inet.sysLevel': 'System-level internet access',
  'inet.off': 'Off (recommended default)',
  'inet.on': 'Open',
  'inet.blockPrivate': 'Block private addresses',
  'inet.enabledRec': 'Enabled (strongly recommended)',
  'inet.disabled': 'Disabled',
  'inet.searchEndpoint': 'Search service endpoint (SearXNG etc.; empty disables it)',
  'inet.maxResults': 'Max search results',
  'inet.maxBytes': 'Max download size (bytes)',
  'inet.timeout': 'Timeout (ms)',
  'inet.maxRedirects': 'Max redirects',
  'inet.allowlist': 'Domain allowlist (one per line; empty means no restriction)',
  'inet.blocklist': 'Domain blocklist (one per line)',
  'inet.cidrs': 'Blocked IP ranges (CIDR, one per line)',
  'inet.types': 'Allowed Content-Types (one per line)',
  'inet.save': 'Save policy',
  'inet.saved': 'Network policy saved',
  'inet.testTitle': 'Policy test',
  'inet.testDesc': 'Before opening this up to users, check whether a given URL is allowed or blocked.',
  'inet.testBtn': 'Test',
  'inet.testing': 'Testing…',
  'inet.allowed': '✓ Allowed',
  'inet.blocked': '✕ Blocked ({code})',

  // ---------- Logs ----------
  'logs.tokens14': 'Token usage, last 14 days',
  'logs.noData': 'No data yet',
  'logs.perUser': 'Token usage per user (last 14 days)',
  'logs.perModel': 'Usage per model',
  'logs.recent': 'Recent requests',
  'logs.noRequests': 'No request logs yet',
  'logs.web': 'Controlled browsing log',
  'logs.noWeb': 'No browsing logs yet',
  'logs.success': 'Success',
  'logs.pass': 'Allowed',
  'logs.block': 'Blocked',
  'th.calls': 'Calls',
  'th.input': 'Input',
  'th.output': 'Output',
  'th.total': 'Total',
  'th.tokens': 'Tokens',
  'th.time': 'Time',
  'th.servedModel': 'Model served',
  'th.failover': 'Failover',
  'th.wait': 'Wait',
  'th.inference': 'Inference',
  'th.result': 'Result',
  'th.tool': 'Tool',
  'th.target': 'Target',
  'th.resolvedIp': 'Resolved IP',

  // ---------- Settings ----------
  'set.security': 'Security',
  'set.changePw': 'Change admin password',
  'set.export': 'Export settings (secrets excluded)',
  'set.exportNote': 'API keys, passwords and external credentials never appear in the export file.',
  'set.queue': 'Priority Queue',
  'set.qConcurrent': 'Global concurrency limit',
  'set.qLength': 'Max queue length',
  'set.qTimeout': 'Queue timeout (ms)',
  'set.antiStarvation': 'Anti-starvation',
  'set.boostEvery': 'Boost one level every (ms)',
  'set.maxBoost': 'Max boost levels',
  'set.saveQueue': 'Save queue settings',
  'set.queueSaved': 'Queue settings applied',
  'set.enable': 'Enabled',
  'set.disable': 'Disabled',
  'set.backup': 'Backups',
  'set.backupNow': 'Back up now',
  'set.backupDone': 'Backup complete',
  'set.noBackup': 'No backups yet',
  'th.backupFile': 'Backup file',
  'th.size': 'Size',
  'th.createdAt': 'Created',
  'set.sysinfo': 'System info',
  'set.port': 'Service port',
  'set.maxUsers': 'User limit',
  'set.hcInterval': 'Health check interval',
  'set.defaultRoute': 'Default model route',
  'set.retention': 'Log retention',
  'set.retentionDays': '{n} days',
  'set.logPrompts': 'Prompt content is logged',
  'set.logHashOnly': 'Only prompt hashes are logged',
  'set.editNote': 'For fuller configuration, edit <span class="mono">config/config.json</span> directly and restart '
    + 'the service.',

  'pw.title': 'Change admin password',
  'pw.warn': 'The default password used on first start is written in the config file — please change it.',
  'pw.new': 'New password (at least 8 characters)',
  'pw.again': 'Repeat password',
  'pw.later': 'Later',
  'pw.update': 'Update password',
  'pw.mismatch': 'The two entries do not match',
  'pw.tooShort': 'The password needs at least 8 characters',
  'pw.updated': 'Password updated',

  // ---------- Web chat ----------
  'chat.pageTitle': 'AGI BAR - Web Chat',
  'chat.notConnected': 'Not connected',
  'chat.keyBtn': 'API Key',
  'chat.clearBtn': 'Clear chat',
  'chat.welcomeTitle': 'Start a conversation',
  'chat.welcomeDesc': 'Press “API Key” at the top right and enter the key your administrator gave you.<br>'
    + 'The key is stored only in this browser and is never sent anywhere but the gateway.',
  'chat.placeholder': 'Type a message… (Enter to send, Shift+Enter for a new line)',
  'chat.send': 'Send',
  'chat.cleared': 'Conversation cleared.',
  'chat.keyInvalid': 'Invalid API key',
  'chat.remaining': '{n} tokens left today',
  'chat.cannotConnect': 'Cannot connect: {msg}',
  'chat.keyTitle': 'Set API key',
  'chat.keyDesc': 'Enter the API key your administrator gave you. It is stored only in this browser’s localStorage.',
  'chat.keyInfo': 'The same key also works with Cursor / Claude Code / Codex and similar tools.',
  'chat.connected': 'Connected',
  'chat.keyFailed': 'API key verification failed',
  'chat.avatarUser': 'You',
  'chat.avatarAi': 'AI',
  'chat.error': 'Error: {msg}',
};

const JA = {
  // ---------- 共通 ----------
  'common.language': '言語',
  'common.cancel': 'キャンセル',
  'common.save': '保存',
  'common.close': '閉じる',
  'common.ok': 'OK',
  'common.confirmTitle': '確認してください',
  'common.delete': '削除',
  'common.manage': '管理',
  'common.loading': '読み込み中…',
  'common.copy': 'コピー',
  'common.copied': 'コピーしました',
  'common.copyFailed': 'ブラウザがクリップボードへのアクセスを拒否しました。手動で選択してコピーしてください。',
  'common.saved': '保存しました',
  'common.deleted': '削除しました',
  'common.removed': '削除しました',
  'common.added': '追加しました',
  'common.revoked': '失効しました',
  'common.dash': '—',
  'common.notSet': '（未設定）',
  'common.listSep': '・',
  'common.notLoggedIn': '未ログイン',
  'common.everyday': '毎日',

  'status.active': '有効',
  'status.paused': '一時停止',
  'status.disabled': '無効',
  'status.revoked': '失効済み',

  'health.online': 'オンライン',
  'health.offline': 'オフライン',
  'health.degraded': '混雑',
  'health.unknown': '未確認',

  'priority.admin': 'P0 管理者',
  'priority.high': 'P1 高',
  'priority.normal': 'P2 通常',
  'priority.guest': 'P3 ゲスト',

  'weekday.0': '日',
  'weekday.1': '月',
  'weekday.2': '火',
  'weekday.3': '水',
  'weekday.4': '木',
  'weekday.5': '金',
  'weekday.6': '土',
  'weekdayLabel.0': '日曜',
  'weekdayLabel.1': '月曜',
  'weekdayLabel.2': '火曜',
  'weekdayLabel.3': '水曜',
  'weekdayLabel.4': '木曜',
  'weekdayLabel.5': '金曜',
  'weekdayLabel.6': '土曜',

  'tag.local': 'ローカル',
  'tag.external': '外部',
  'tag.externalCloud': '外部クラウド',
  'tag.disabledModel': '無効',

  'uptime.dh': '{d} 日 {h} 時間',
  'uptime.hm': '{h} 時間 {m} 分',
  'uptime.m': '{m} 分',

  // ---------- ログイン ----------
  'login.pageTitle': 'AGI BAR - 管理者ログイン',
  'login.subtitle': 'Local AI Gateway Management System',
  'login.username': '管理者アカウント',
  'login.password': 'パスワード',
  'login.submit': 'ログイン',
  'login.note': 'このシステムは社内ネットワーク専用です。利用者は API キーで '
    + '<span class="mono">/v1</span> に接続するか、<a href="/chat.html">Web チャット</a>をご利用ください。',
  'login.failed': 'ログインに失敗しました',
  'login.netError': 'サーバーに接続できません：{msg}',

  // ---------- 管理コンソール ----------
  'app.pageTitle': 'AGI BAR 管理コンソール',
  'app.brandSub': 'Local AI Gateway',
  'app.logout': 'ログアウト',
  'app.whoami': '{name}（管理者）',
  'app.chatLink': 'Web チャット ↗',

  'nav.dashboard': 'ダッシュボード',
  'nav.users': 'ユーザー',
  'nav.keys': 'API',
  'nav.models': 'AI モデル',
  'nav.internet': 'ネットワーク',
  'nav.logs': 'ログ',
  'nav.settings': '設定',

  'page.dashboard': 'ダッシュボード',
  'page.users': 'ユーザー管理',
  'page.keys': 'API キー',
  'page.models': 'AI モデル',
  'page.internet': 'ネットワークと制御付き Web アクセス',
  'page.logs': '利用ログ',
  'page.settings': 'システム設定',

  // ---------- ダッシュボード ----------
  'dash.users': 'ユーザー数',
  'dash.usersHint': 'オンライン {n} 名（直近 5 分）',
  'dash.requests': '本日の API リクエスト',
  'dash.requestsHint': '失敗 {n} 件',
  'dash.tokens': '本日のトークン',
  'dash.tokensHint': 'Input + Output 合計',
  'dash.queue': '現在のキュー',
  'dash.queueUnit': ' 待機 / {running} 実行中',
  'dash.queueHint': '平均待ち時間 {ms}',
  'dash.gpu': 'GPU / VRAM',
  'dash.primaryModel': '現在のメインモデル',
  'dash.noPrimary': '（なし）',
  'dash.noModelSet': 'モデル未設定',
  'dash.internet': 'インターネット状態',
  'dash.internetOpen': '開放中',
  'dash.internetClosed': '未開放',
  'dash.privateBlocked': '内部アドレスをブロック中',
  'dash.privateUnblocked': '⚠ 内部ネットワークのブロックが無効です',
  'dash.uptime': 'サービス稼働時間',
  'dash.memFree': 'メモリ空き {n} MB',
  'dash.modelPool': 'モデルプールの状態',
  'dash.healthcheck': 'ヘルスチェック実行',
  'dash.healthcheckDone': 'ヘルスチェックが完了しました',
  'dash.noModels': 'モデルがまだ設定されていません',
  'dash.connInfo': '接続情報',
  'dash.connNote': '利用者は以下のアドレスで接続できます。API キーは「ユーザー」ページで個別に発行します。',
  'dash.webui': 'Web UI',
  'dash.apiBase': 'API Base URL',
  'dash.apiKeyRow': '各利用者専用の <span class="mono">agi-bar-xxxxxxxx</span>',
  'dash.host': 'ホスト',
  'dash.fwTitle': 'スマートフォンや他の PC から繋がらない場合',
  'dash.fwDesc': '最も多い原因は Windows ファイアウォールがこのポートを許可していないことです。'
    + 'PowerShell を<b>管理者として</b>起動し、次の 1 行を実行してから再度お試しください：',
  'dash.fwCopy': 'コマンドをコピー',
  'dash.fwCopied': 'ファイアウォールのコマンドをコピーしました',
  'dash.fwNote': 'コマンドの実行は 1 回だけで十分です。ネットワークが「パブリック」に分類されている場合は '
    + '<span class="mono">-Profile Private</span> を '
    + '<span class="mono">-Profile Private,Public</span> に変更してください'
    + '（ただしパブリックネットワークでの開放は推奨しません）。',

  'th.model': 'モデル',
  'th.source': '種別',
  'th.state': '状態',
  'th.queue': 'キュー',
  'th.firstToken': '初回トークン',
  'th.tokensPerSec': 'Token/s',
  'th.errorRate': 'エラー率',
  'th.lastError': '直近のエラー',

  // ---------- ユーザー ----------
  'users.title': 'ユーザー一覧',
  'users.count': '{n} 名（上限 50）',
  'users.add': '＋ ユーザー追加',
  'users.limitReached': 'ユーザー数が上限の 50 名に達しています',
  'users.delConfirm': 'このユーザーを削除しますか？ API キーとルート設定も併せて削除されます（利用ログは保持されます）。',
  'users.newTitle': 'ユーザー追加',
  'users.createBtn': 'ユーザーを作成',
  'users.createNote': '作成時に API キーが 1 本自動発行されます。平文は一度しか表示されません。',

  'th.account': 'アカウント',
  'th.name': '氏名',
  'th.role': '役割',
  'th.apiKey': 'API キー',
  'th.tokensToday': '本日のトークン',
  'th.lastUsed': '最終利用',
  'role.admin': '管理者',
  'role.user': '利用者',

  'form.username': 'アカウント *',
  'form.usernamePh': '例：rd-alice',
  'form.displayName': '氏名',
  'form.email': 'Email',
  'form.status': '状態',
  'form.note': '備考',
  'form.route': 'モデル優先順位（Model Route）',
  'form.routeHint': '空欄の場合はシステム既定のルートを使用します。',

  'detail.title': 'ユーザー：{name}',
  'detail.tokensToday': '本日のトークン',
  'detail.tokensMonth': '今月のトークン',
  'detail.tokensTotal': '累計トークン',
  'detail.newKey': '＋ 新しいキーを発行',
  'detail.noKeys': 'API キーはまだありません',
  'detail.saveChanges': '変更を保存',
  'detail.rotateConfirm': '再発行すると古いキーは直ちに無効になり、そのキーを使うツールは再設定が必要です。続行しますか？',
  'detail.revokeConfirm': 'この API キーを失効させますか？',

  'th.ident': '識別子',
  'th.keyName': '名称',
  'th.priority': '優先度',
  'th.perDay': '1 日あたり',
  'btn.quota': 'クォータ',
  'btn.rotate': '再発行',
  'btn.revoke': '失効',

  'key.createdTitle': 'API キーを作成しました',
  'key.onceWarn': 'この平文キーは<b>一度しか表示されません</b>。閉じた後はハッシュのみが保存され、復元できません。',
  'key.forUser': '利用者：{name}',
  'key.copyBtn': 'クリップボードにコピー',
  'key.clientSetup': 'クライアント設定：',
  'key.baseUrl': 'Base URL',
  'key.keyIsAbove': 'API キー：上の文字列',
  'key.doneBtn': 'コピーしました、閉じる',

  // ---------- クォータ ----------
  'lim.perRequest': '1 回あたり最大トークン',
  'lim.perHour': '1 時間あたりトークン',
  'lim.perDay': '1 日あたりトークン',
  'lim.perMonth': '1 か月あたりトークン',
  'lim.rpm': 'RPM（毎分リクエスト数）',
  'lim.concurrent': 'Concurrent（同時リクエスト数）',
  'lim.priority': '優先度',
  'lim.overQuota': '超過時の扱い',
  'lim.hard': 'Hard — リクエストを拒否',
  'lim.soft': 'Soft — 小型モデルに降格',
  'lim.internet': 'インターネット利用',
  'lim.internetDeny': '禁止',
  'lim.internetAllow': 'Web Search / Fetch を許可',
  'lim.validFrom': '有効期間（開始）',
  'lim.validUntil': '有効期間（終了）',
  'lim.windowStart': '1 日の利用可能時間（開始）',
  'lim.windowEnd': '1 日の利用可能時間（終了）',
  'lim.weekdays': '利用可能な曜日',
  'lim.dialogTitle': 'クォータ設定：{key}',
  'lim.updated': 'クォータを更新しました',

  // ---------- ルート ----------
  'route.rank': '順位 {n}',
  'route.remove': '削除',
  'route.empty': '未指定のため、システム既定のルートを使用します',
  'route.addPlaceholder': '＋ モデルを追加…',
  'route.suffixExternal': '（外部）',
  'route.suffixExternalCloud': '（外部クラウド）',
  'route.suffixDisabled': '（無効）',
  'route.primary': 'メイン',
  'route.backup': '予備 {n}',
  'route.moveOut': '外す',
  'route.defaultEmpty': '既定の順序が空です —— 専用の順序を設定していない利用者はどのモデルも使えません。',
  'route.addToOrder': '＋ モデルを順序に追加…',

  // ---------- API キー一覧 ----------
  'keys.allTitle': 'すべての API キー',
  'th.prefix': 'プレフィックス',
  'th.user': '利用者',
  'th.tokensPerDay': '1 日あたりトークン',
  'th.rpm': 'RPM',
  'th.window': '時間帯',
  'th.expiry': '期限',
  'th.internet': 'ネット利用',
  'keys.noExpiry': '無期限',
  'keys.allow': '許可',
  'keys.deny': '禁止',
  'keys.empty': 'API キーがまだありません。まず「ユーザー」ページで利用者を作成してください',

  // ---------- 接続情報 ----------
  'net.title': '接続情報',
  'net.subtitle': '利用者に配る URL',
  'net.redetect': 'IP を再検出',
  'net.redetectShort': '再検出',
  'net.noAddress': '外部向けのネットワークアドレスを検出できません。このマシンはネットワークに接続されていない可能性があります。',
  'net.pick': 'どのアドレスを使いますか？ このマシンでは {n} 件検出されました',
  'net.virtualSuffix': '（仮想インターフェース。他の端末からは繋がらないことが多い）',
  'net.virtualWarn': '現在選択されているのは<b>仮想インターフェース</b>のアドレスで、スマートフォンや他の PC からは'
    + '繋がらないことがほとんどです。一覧に Wi-Fi やイーサネットのアドレスがあれば、そちらを選んでください。',
  'net.rowChat': 'Web チャット（利用者用）',
  'net.rowChatHint': 'スマートフォン・タブレット・他の PC はすべてこれを使います。管理コンソールはこの URL にはありません。',
  'net.rowApi': 'API Base URL',
  'net.rowApiHint': 'Cursor / Codex / 自作アプリはこれを設定します（Claude Code は例外。下記参照）。',
  'net.rowClaude': 'Claude Code 用',
  'net.rowClaudeHint': 'ANTHROPIC_BASE_URL に /v1 は付けません。SDK が自動で補います。',
  'th.purpose': '用途',
  'th.url': 'URL',
  'net.copyAll': '設定手順をまとめてコピー',
  'net.openChat': 'チャットページを開く ↗',
  'net.footer': 'ホスト {host}　ポート {port}　検出時刻 {time}',
  'net.footer2': 'Wi-Fi やネットワーク環境を変えると IP も変わります。'
    + 'その場合はこのページで「IP を再検出」を押し、改めて利用者に配布してください。',
  'net.copiedX': '{label}をコピーしました',
  'net.sheetLabel': '設定手順',
  'net.sheetTitle': 'AGI BAR 接続情報',
  'net.sheetChat': 'Web チャット：{url}',
  'net.sheetApi': 'API Base URL：{url}',
  'net.sheetCursor': 'Cursor：Settings → Models → Override OpenAI Base URL にチェックし、上の API Base URL を入力',
  'net.sheetCodex': 'Codex：OPENAI_BASE_URL に上の API Base URL を設定。~/.codex/config.toml に '
    + 'wire_api = "chat" を追加',
  'net.sheetClaude': 'Claude Code：ANTHROPIC_BASE_URL={url}（/v1 は付けない）',
  'net.sheetFooter': 'API キーは管理者が個別に発行します。他人に転送しないでください。',

  // ---------- モデル ----------
  'models.defaultOrder': '既定のモデル順序',
  'models.defaultOrderHint': '順位 1 がメインモデルです',
  'models.saveOrder': '順序を保存',
  'models.orderSaved': '順序を保存しました',
  'models.orderDesc': 'リクエストはこの順で試行します。順位 1 がオフライン・混雑・ヘルスチェック失敗のときは'
    + '自動的に順位 2 に切り替わり、以降も同様です。'
    + '個別の利用者は「ユーザー → 管理」で専用の順序を設定でき、未設定の場合はここの既定が使われます。',
  'models.missingKeyWarn': '<b>API キーが未設定</b>のためオフラインになっているモデルがあります。'
    + '外部クラウドモデルのキーは環境変数に置く必要があり、設定ファイルには保存されません。'
    + '設定方法は下のモデル行のエラーメッセージを参照してください。',
  'models.applyNote': 'モデルを追加すると即時に反映され、再起動は不要です。設定は '
    + '<span class="mono">config/config.json</span> に書き戻され、そこが唯一の設定元であることに変わりはありません。',
  'models.pool': 'モデルプール',
  'models.add': '＋ モデル追加',
  'models.empty': 'モデルがまだ追加されていません。右上の「＋ モデル追加」から始めてください。',
  'models.removeConfirm': '「{id}」をモデルプールから削除しますか？'
    + '設定ファイルと全利用者のルートから削除されます（利用ログは保持されます）。',
  'th.endpoint': 'Endpoint',
  'th.context': 'コンテキスト',
  'th.vram': 'VRAM',
  'th.enabled': '有効化',
  'btn.enable': '有効化',
  'btn.disable': '無効化',
  'btn.remove': '削除',

  // ---------- モデル追加ダイアログ ----------
  'addm.title': 'モデル追加',
  'addm.intro': '<b>AGI BAR は推論を実行せず、モデルファイルも保存しません。</b>'
    + 'リクエストは Ollama / LM Studio / llama.cpp などの推論サービスへ転送されます。<br>'
    + '新しいモデルを使うには、まずそれらのサービスに導入し（Ollama なら '
    + '<span class="mono">ollama pull &lt;モデル名&gt;</span>）、その後ここで探索してください。<br>'
    + 'プロジェクトの <span class="mono">models/</span> フォルダーにモデルファイルを置いても<b>効果はありません</b>。'
    + 'そこを使うのは llama.cpp を自分で同梱する場合だけです。',
  'addm.desc': 'ローカル推論サービスの OpenAI 互換エンドポイントを入力し、「探索」を押すと導入済みモデルが一覧表示されます。',
  'addm.presets': 'よく使うサービス',
  'addm.endpoint': 'エンドポイント URL',
  'addm.discover': '探索',
  'addm.discovering': '探索中…',
  'addm.needEndpoint': '先にエンドポイント URL を入力してください',
  'addm.manual': '手動で追加（外部クラウド API、例：DeepSeek）',
  'addm.manualWarn': '<b>外部クラウドモデルはプロンプトをこのマシンのネットワーク外へ送信します。</b>'
    + '設計方針としてローカルモデルを優先し、外部 API は明示的に承認された予備としてのみ使用します。<br>'
    + 'キーは<b>環境変数にのみ</b>置いてください。ここに入力するのは変数名であり、キーそのものではありません。'
    + 'キーは設定ファイルには書き込まれません。',
  'addm.id': 'モデル ID *',
  'addm.displayName': '表示名',
  'addm.displayNamePh': 'DeepSeek クラウド予備',
  'addm.endpointReq': 'エンドポイント URL *',
  'addm.upstream': '上流モデル名 *',
  'addm.env': 'キーの環境変数',
  'addm.context': 'コンテキスト',
  'addm.source': '種別',
  'addm.sourceCloud': '外部クラウド',
  'addm.sourceLocal': 'ローカル',
  'addm.addBtn': '追加',

  'disc.found': '{n} 個のモデルが見つかりました',
  'disc.alreadyN': '（うち {n} 個は追加済み）',
  'th.upstreamModel': '上流モデル名',
  'th.displayName': '表示名',
  'th.vramMb': 'VRAM (MB)',
  'disc.already': '追加済み',
  'disc.add': '追加',
  'disc.note': 'コンテキストと VRAM はダッシュボード表示とクォータ超過時のモデル選択にのみ影響します。'
    + 'おおよその値で構いませんし、後から調整できます。追加したモデルは既定ルートの最後尾に配置されます。',
  'disc.addedX': '{model} を追加しました',

  // ---------- モデル追加ガイド ----------
  'guide.title': 'モデルの追加方法',
  'guide.common': '<b>共通の考え方：AGI BAR は推論を実行せず、モデルファイルも保存しません。</b>'
    + '実際にモデルを動かすのは以下の推論サービスであり、AGI BAR は認証・クォータ・キューイング・ルーティングのみを担当します。<br>'
    + 'したがって手順は常に<b>2 ステップ</b>です：① 推論サービスにモデルを導入 → ② このページに戻ってエンドポイントを登録。<br>'
    + 'GGUF ファイルをプロジェクトの <span class="mono">models/</span> フォルダーに置いても<b>まったく効果はありません</b>。',
  'guide.footer': '追加後はこのページ上部の<b>既定のモデル順序</b>でメインと予備の並びを確認してください。'
    + '順序に入っていないモデルはどのリクエストからも選ばれません。',

  'guide.ollama.badge': '最も簡単',
  'guide.ollama.s1': 'Ollama をインストールすると自動的にバックグラウンドで動作し、既定では '
    + '<span class="mono">11434</span> を待ち受けます。',
  'guide.ollama.s2': 'モデルをダウンロードします（AI ホストのコマンドラインで実行）：',
  'guide.ollama.hf': 'Hugging Face の GGUF を直接取得することもできます：',
  'guide.ollama.s3': '導入を確認：<span class="mono">ollama list</span>',
  'guide.ollama.s4': 'このページに戻り「＋ モデル追加」→ <b>Ollama</b> → <b>探索</b> → 使うモデルを選択 → <b>追加</b>。',
  'guide.ollama.warn': '<b>初回の呼び出しは非常に時間がかかります</b>（実測で約 60 秒）。'
    + 'これは Ollama がモデルを VRAM に読み込む時間で、以降は通常どおりです。'
    + '避けたい場合は、ホストで <span class="mono">ollama run &lt;モデル&gt;</span> を一度実行して暖機してください。',
  'guide.ollama.store': 'モデルは <span class="mono">%USERPROFILE%\\.ollama\\models</span>（環境変数 '
    + '<span class="mono">OLLAMA_MODELS</span> で変更可）に、内容アドレス指定の blob として保存されます。'
    + '持ち運べる GGUF ファイルではありません。',

  'guide.lmstudio.badge': 'GUI あり',
  'guide.lmstudio.s1': 'LM Studio の <b>Discover</b> タブでモデルを検索してダウンロードします。',
  'guide.lmstudio.s2': '<b>Developer</b> タブ（旧版では <b>Local Server</b>）に切り替え、<b>Start Server</b> を押します。'
    + '既定ポートは <span class="mono">1234</span> です。',
  'guide.lmstudio.s3': 'このページに戻り「＋ モデル追加」→ <b>LM Studio</b> → <b>探索</b>。',
  'guide.lmstudio.warn': '<b>Start Server を押さないと探索できません。</b>'
    + 'LM Studio はモデルのダウンロードが終わっても自動では API を公開しないため、必ず手動でサーバーを起動してください。'
    + 'またモデルは応答するためにメモリへ読み込む必要があるので、設定で JIT loading を有効にすることを推奨します。'
    + '無効のままだと初回呼び出しは待機ではなく失敗する場合があります。',

  'guide.llamacpp.title': 'llama.cpp server',
  'guide.llamacpp.badge': '最も軽量',
  'guide.llamacpp.s1': 'llama.cpp の <span class="mono">llama-server</span> をダウンロードするか自分でビルドします。',
  'guide.llamacpp.s2': 'GGUF モデルファイルを用意します。<b>プロジェクトの '
    + '<span class="mono">models/</span> フォルダーを使うのはこの場合だけです</b> —— 管理しやすいよう GGUF をそこに置きます。',
  'guide.llamacpp.s3': 'サーバーを起動します（1 プロセスにつき通常 1 モデル）：',
  'guide.llamacpp.s4': 'このページに戻り →「＋ モデル追加」→ <b>llama.cpp server</b> → <b>探索</b>。',
  'guide.llamacpp.note': '複数モデルを同時に提供するには、ポートを変えて（8080、8081…）複数プロセスを起動し、'
    + 'それぞれこのページで個別に追加してから、上部の「既定のモデル順序」でメインと予備を並べてください。',

  'guide.vllm.badge': '多人数・高スループット',
  'guide.vllm.s1': 'NVIDIA GPU 搭載マシン（通常は Linux 環境）に vLLM をインストールします。',
  'guide.vllm.s2': 'サービスを起動します：',
  'guide.vllm.s3': 'このページに戻り →「＋ モデル追加」→ <b>vLLM</b> → <b>探索</b>。',
  'guide.vllm.info': '<b>vLLM が別のマシンで動いている場合</b>、エンドポイントはそのマシンのアドレス'
    + '（例：<span class="mono">http://192.168.1.20:8000/v1</span>）にする必要があり、'
    + '<span class="mono">localhost</span> は使えません。'
    + 'そのマシンのファイアウォールが該当ポートを許可しているかも確認してください。',
  'guide.vllm.note': 'vLLM はバッチ処理に強く、人数が多い場合のスループットは Ollama より明らかに優れますが、'
    + '起動が遅くメモリ使用量も多くなります。',

  'guide.cloud.title': '外部クラウド API（DeepSeek など）',
  'guide.cloud.badge': '明示的な承認が必要',
  'guide.cloud.warn': '<b>外部モデルを有効にすることは、そのルートのプロンプトをこのマシンのネットワーク外へ'
    + '送信することに同意するのと同じです。</b>'
    + '方針としてはローカルのオープンソースモデルを優先し、外部 API は管理者が明示的に承認した予備としてのみ使用します。'
    + '社内ポリシーに適合するか先に確認してください。',
  'guide.cloud.s1': '<b>AI ホスト</b>でキーの環境変数を設定します。キーは設定ファイルには書きません：',
  'guide.cloud.s2': '<b>AGI BAR を完全に終了してから再起動してください。</b> <span class="mono">setx</span> は'
    + 'その後に起動したプロセスにのみ有効で、ページの再読み込みでは反映されません。',
  'guide.cloud.s3': '「＋ モデル追加」→ 最下部の <b>手動で追加（外部クラウド API）</b>を開き、次を入力します：',
  'guide.cloud.s4': '「ヘルスチェック実行」を押して状態を確認します：',
  'guide.cloud.s5': 'ルート内の位置を決めます。<b>外部モデルは追加後、既定ではルートに入りません</b> —— '
    + '使うかどうかはあなたの明示的な判断です。',
  'guide.cloud.thId': 'モデル ID',
  'guide.cloud.thEndpoint': 'エンドポイント URL',
  'guide.cloud.thModel': '上流モデル名',
  'guide.cloud.thEnv': 'キーの環境変数',
  'guide.cloud.thEnvNote': '入力するのは変数名であり、キー自体ではありません',
  'guide.cloud.thSource': '種別',
  'guide.cloud.sourceCloud': '外部クラウド',
  'guide.cloud.stOnlineDone': '完了',
  'guide.cloud.stMissingEnv': '環境変数がありません…',
  'guide.cloud.stMissingEnvFix': 'サービスが新しい環境変数をまだ読み込んでいません → AGI BAR を再起動',
  'guide.cloud.st401': 'キー自体が無効、または失効しています',
  'guide.cloud.note': 'ローカルモデルが全滅したときだけ全利用者に使わせたい場合：'
    + 'このページ上部の「既定のモデル順序」で<b>最後の順位</b>に追加します。<br>'
    + '特定の利用者だけに使わせる場合：「ユーザー → 管理」でその利用者専用の順序を設定します。',

  // ---------- ネットワーク ----------
  'inet.policy': '制御付き Web アクセスのポリシー',
  'inet.warn': 'ローカルモデルが直接インターネットに接続することはありません。'
    + 'すべての外部接続は Gateway のポリシー検査を通過したうえで、Gateway がテキストを取得してモデルに渡します。',
  'inet.sysLevel': 'システムレベルのインターネット利用',
  'inet.off': '無効（推奨の既定値）',
  'inet.on': '開放',
  'inet.blockPrivate': '内部アドレスをブロック',
  'inet.enabledRec': '有効（強く推奨）',
  'inet.disabled': '無効',
  'inet.searchEndpoint': '検索サービスのエンドポイント（SearXNG など。空欄で無効）',
  'inet.maxResults': '検索結果の上限',
  'inet.maxBytes': '最大ダウンロードサイズ（bytes）',
  'inet.timeout': 'タイムアウト（ms）',
  'inet.maxRedirects': '最大リダイレクト回数',
  'inet.allowlist': 'ドメイン許可リスト（1 行 1 件。空欄で制限なし）',
  'inet.blocklist': 'ドメイン拒否リスト（1 行 1 件）',
  'inet.cidrs': 'ブロックする IP 範囲（CIDR、1 行 1 件）',
  'inet.types': '許可する Content-Type（1 行 1 件）',
  'inet.save': 'ポリシーを保存',
  'inet.saved': 'ネットワークポリシーを保存しました',
  'inet.testTitle': 'ポリシーテスト',
  'inet.testDesc': '利用者に開放する前に、特定の URL が許可されるかブロックされるかを確認します。',
  'inet.testBtn': 'テスト',
  'inet.testing': 'テスト中…',
  'inet.allowed': '✓ 許可',
  'inet.blocked': '✕ ブロック（{code}）',

  // ---------- ログ ----------
  'logs.tokens14': '直近 14 日間のトークン使用量',
  'logs.noData': 'データがありません',
  'logs.perUser': '利用者別トークン使用量（直近 14 日）',
  'logs.perModel': 'モデル別使用量',
  'logs.recent': '最近のリクエスト',
  'logs.noRequests': 'リクエストログはまだありません',
  'logs.web': '制御付き Web アクセスのログ',
  'logs.noWeb': 'Web アクセスログはまだありません',
  'logs.success': '成功',
  'logs.pass': '許可',
  'logs.block': 'ブロック',
  'th.calls': '呼び出し回数',
  'th.input': 'Input',
  'th.output': 'Output',
  'th.total': '合計',
  'th.tokens': 'トークン',
  'th.time': '時刻',
  'th.servedModel': '使用モデル',
  'th.failover': 'Failover',
  'th.wait': '待機',
  'th.inference': '推論',
  'th.result': '結果',
  'th.tool': 'ツール',
  'th.target': '対象',
  'th.resolvedIp': '解決 IP',

  // ---------- 設定 ----------
  'set.security': 'セキュリティ',
  'set.changePw': '管理者パスワードを変更',
  'set.export': '設定をエクスポート（機密情報は含まない）',
  'set.exportNote': 'API キー・パスワード・外部の資格情報はエクスポートファイルに含まれません。',
  'set.queue': 'Priority Queue',
  'set.qConcurrent': '全体の同時実行上限',
  'set.qLength': 'キュー長の上限',
  'set.qTimeout': 'キューのタイムアウト（ms）',
  'set.antiStarvation': 'Anti-starvation',
  'set.boostEvery': '待機時間ごとに 1 段階昇格（ms）',
  'set.maxBoost': '最大昇格段数',
  'set.saveQueue': 'キュー設定を保存',
  'set.queueSaved': 'キュー設定を適用しました',
  'set.enable': '有効',
  'set.disable': '無効',
  'set.backup': 'バックアップ',
  'set.backupNow': '今すぐバックアップ',
  'set.backupDone': 'バックアップが完了しました',
  'set.noBackup': 'バックアップはまだありません',
  'th.backupFile': 'バックアップファイル',
  'th.size': 'サイズ',
  'th.createdAt': '作成日時',
  'set.sysinfo': 'システム情報',
  'set.port': 'サービスポート',
  'set.maxUsers': 'ユーザー上限',
  'set.hcInterval': 'ヘルスチェック間隔',
  'set.defaultRoute': '既定のモデルルート',
  'set.retention': 'ログ保持期間',
  'set.retentionDays': '{n} 日',
  'set.logPrompts': 'プロンプト本文を記録',
  'set.logHashOnly': 'プロンプトのハッシュのみ記録',
  'set.editNote': 'より詳細な設定は <span class="mono">config/config.json</span> を直接編集し、'
    + 'サービスを再起動してください。',

  'pw.title': '管理者パスワードの変更',
  'pw.warn': '初回起動時の既定パスワードは設定ファイルに記載されています。必ず変更してください。',
  'pw.new': '新しいパスワード（8 文字以上）',
  'pw.again': 'もう一度入力',
  'pw.later': '後で',
  'pw.update': 'パスワードを更新',
  'pw.mismatch': '入力が一致しません',
  'pw.tooShort': 'パスワードは 8 文字以上必要です',
  'pw.updated': 'パスワードを更新しました',

  // ---------- Web チャット ----------
  'chat.pageTitle': 'AGI BAR - Web チャット',
  'chat.notConnected': '未接続',
  'chat.keyBtn': 'API キー',
  'chat.clearBtn': '会話をクリア',
  'chat.welcomeTitle': '会話を始める',
  'chat.welcomeDesc': 'まず右上の「API キー」を押し、管理者から配布されたキーを入力してください。<br>'
    + 'キーはこのブラウザーにのみ保存され、ゲートウェイ以外へ送信されることはありません。',
  'chat.placeholder': 'メッセージを入力…（Enter で送信、Shift+Enter で改行）',
  'chat.send': '送信',
  'chat.cleared': '会話をクリアしました。',
  'chat.keyInvalid': 'API キーが無効です',
  'chat.remaining': '本日の残り {n} トークン',
  'chat.cannotConnect': '接続できません：{msg}',
  'chat.keyTitle': 'API キーの設定',
  'chat.keyDesc': '管理者から配布された API キーを入力してください。'
    + 'キーはこのブラウザーの localStorage にのみ保存されます。',
  'chat.keyInfo': '同じキーは Cursor / Claude Code / Codex などのツールでも使えます。',
  'chat.connected': '接続しました',
  'chat.keyFailed': 'API キーの検証に失敗しました',
  'chat.avatarUser': '私',
  'chat.avatarAi': 'AI',
  'chat.error': 'エラー：{msg}',
};

const DICT = { 'zh-Hant': ZH, en: EN, ja: JA };

// ==================== 執行時 ====================

let current = detect();

/** 沒有存過偏好時，用瀏覽器語言猜一次；猜不到就回落繁中。 */
function detect() {
  const saved = safeGet(STORE_KEY);
  if (saved && DICT[saved]) return saved;

  for (const raw of (navigator.languages?.length ? navigator.languages : [navigator.language || ''])) {
    const tag = String(raw).toLowerCase();
    if (tag.startsWith('ja')) return 'ja';
    if (tag.startsWith('zh')) return 'zh-Hant';
    if (tag.startsWith('en')) return 'en';
  }
  return FALLBACK;
}

function safeGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* 隱私模式下寫入會失敗，忽略即可 */ }
}

export function getLang() { return current; }

export function locale() { return LOCALES[current] ?? 'zh-TW'; }

export function setLang(code) {
  if (!DICT[code] || code === current) return;
  current = code;
  safeSet(STORE_KEY, code);
  document.documentElement.lang = code;
  window.dispatchEvent(new CustomEvent(LANG_EVENT, { detail: { lang: code } }));
}

/** 取翻譯字串。vars 中的鍵會替換字串裡的 {key}。 */
export function t(key, vars) {
  const s = DICT[current]?.[key] ?? DICT[FALLBACK][key] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

export function onLangChange(fn) {
  window.addEventListener(LANG_EVENT, fn);
}

/**
 * 套用靜態 HTML 中的翻譯標記。
 * data-i18n（純文字）／data-i18n-html（含標籤）／data-i18n-placeholder／data-i18n-title
 */
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  root.querySelectorAll('[data-i18n-html]').forEach((n) => { n.innerHTML = t(n.dataset.i18nHtml); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((n) => {
    n.setAttribute('placeholder', t(n.dataset.i18nPlaceholder));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((n) => {
    const text = t(n.dataset.i18nTitle);
    if (n.tagName === 'TITLE') n.textContent = text; else n.setAttribute('title', text);
  });
  const titleKey = document.documentElement.dataset.i18nDocTitle;
  if (titleKey && root === document) document.title = t(titleKey);
}

/**
 * 把頁面上的 <select data-lang-select> 填好選項並接上事件。
 * 語言選單刻意做成獨立元件，三個頁面都能直接放。
 */
export function mountLangSelects(root = document) {
  root.querySelectorAll('select[data-lang-select]').forEach((sel) => {
    sel.innerHTML = LANGS.map((l) =>
      `<option value="${l.code}"${l.code === current ? ' selected' : ''}>${l.label}</option>`).join('');
    sel.setAttribute('aria-label', t('common.language'));
    sel.title = t('common.language');
    if (sel._i18nBound) return;
    sel._i18nBound = true;
    sel.addEventListener('change', (e) => setLang(e.target.value));
  });
}

/** 頁面初始化：設定 <html lang>、掛上語言選單、套用靜態翻譯。 */
export function initI18n({ docTitleKey } = {}) {
  document.documentElement.lang = current;
  if (docTitleKey) document.documentElement.dataset.i18nDocTitle = docTitleKey;
  applyI18n();
  mountLangSelects();
  onLangChange(() => { applyI18n(); mountLangSelects(); });
}
