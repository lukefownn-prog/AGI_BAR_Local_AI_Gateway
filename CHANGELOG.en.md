# Changelog

[繁體中文](CHANGELOG.md) ｜ **English** ｜ [日本語](CHANGELOG.ja.md)

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### To do

- M11: hands-on click-through verification of each client (the API layer already passes fully,
  issue #1)
- M14: acceptance on a real GPU host and across multiple LAN machines (the script is complete,
  issue #2)

---

## [2.0.0] - 2026-08-16

The first public release. The licence changed from proprietary to MIT.

**Breaking change:** the entire controlled-browsing feature (web search / URL fetch) was removed, including the `/v1/tools/*` and `/api/internet` endpoints. Existing databases need no manual migration.

### Added

**Log retention now applies to database records too (`server/services/retention.mjs`)**

`logging.retentionDays` used to prune only the log files under `data/logs/`, while
`usage_logs` / `request_logs` / `audit_logs` grew forever — even though the settings page said
"log retention: 30 days", which an administrator would reasonably read as covering both. That
sentence is now true of the database as well.

- Purges once at startup, then every 24 hours. **Purging at startup matters**: this system gets
  moved between venues and shut down between them, so a resident schedule alone would never come
  around if uptime is short.
- The purge runs **before** the startup backup — the other order would capture data that is about
  to be deleted.
- Setting `retentionDays` to 0 or a negative number means keep forever and delete nothing (the
  only safety valve).
- Only the three log tables are touched; users, API keys, models, routes and settings are never
  affected.
- All three tables have a `ts` index, so deletion uses the index rather than a full scan.
- The settings page now explains the scope and shows the last purge time, in all three languages.
- 7 new tests (boundaries, safety valve, default fallback, tables that must not be touched).

**Web UI localisation with a language switcher**

The admin console, sign-in page and web chat all gained a language dropdown supporting
**Traditional Chinese / English / Japanese**.

- New `web/assets/i18n.js` — dictionary, `t()` lookup, `{variable}` interpolation, language
  detection and change events. Zero dependencies, no build step, consistent with the rest of the
  project.
- On first visit the language is guessed from the browser (`ja` / `zh` / `en`); once chosen it is
  stored in localStorage and reused across reloads and pages, with `<html lang>` kept in sync.
- Static HTML is marked up with `data-i18n` / `data-i18n-html` / `data-i18n-placeholder` /
  `data-i18n-title`; dynamically rendered content goes through `t()`.
- Switching language does not reload the page: the console re-runs the current page's render
  function, and the chat page swaps only interface text — **the conversation is preserved**.
- Covers all interface text, including table headers, dialogs, toasts, confirmation messages,
  status and priority labels, weekday names, and the entire "How to add a model" guide.
- Number formatting (`toLocaleString`) and weekday separators follow the language.

**Anthropic Messages API compatible endpoints (M16, issue #1)**

Claude Code speaks the Anthropic format while local models almost universally speak OpenAI. The
previous approach was a bolt-on compatibility proxy; translation is now built into the gateway —
a proxy loses a layer of attribution in usage statistics and adds another component to operate.

- `POST /v1/messages`, with `stream: true` support
- `POST /v1/messages/count_tokens`
- `GET /v1/models` returns an Anthropic-format list when the `anthropic-version` header is present
- Errors use the `{"type":"error","error":{...}}` shape, with types mapped from the HTTP status
- Authentication accepts both `x-api-key` (the Anthropic convention) and `Authorization: Bearer`
- Tolerates `/v1/v1/messages` caused by an `ANTHROPIC_BASE_URL` that wrongly includes `/v1`

Translation covers: the top-level `system` parameter ↔ system message, content blocks ↔
string/part arrays, `image` block ↔ `image_url`, `tool_use` ↔ `tool_calls`, `tool_result` ↔
`role: "tool"`, `input_schema` ↔ `function.parameters`, `stop_reason` ↔ `finish_reason`, and the
complete Anthropic SSE event state machine (`message_start` → `content_block_start` →
`content_block_delta` (`text_delta` / `input_json_delta`) → `content_block_stop` →
`message_delta` → `message_stop`).

**Both protocols share one pipeline and one quota.** `/v1/messages` and `/v1/chat/completions`
both go through `gateway.admit()`; authentication, time windows, token limits, queue priority,
failover and logging are identical, with no bypass.

- Tests grew from 47 to 86 (23 new translation unit tests + 16 end-to-end tests)

**Load-test and acceptance script (M14, issue #2)**

`tests/load/loadtest.mjs`, with four scenarios:

- `steady` — closed loop, N users applying continuous pressure; verifies queueing, priority
  ordering and anti-starvation
- `burst` — open loop flooding the queue; verifies that overload returns a clean 429/503/504
  rather than crashing
- `longrun` — a single long response; verifies it is not cut off by `requestTimeoutMs`
- `quota` — verifies RPM, per-request limits and daily allowances actually hold, restoring
  settings afterwards

Acceptance is graded as fatal or observational. Performance figures (p50/p95) are deliberately not
fatal — the numbers differ on every machine, and "this box is slower" should not fail acceptance.

- New `X-Request-Id` response header. Clients can reconcile it line by line against
  `request_logs`, which is the only trustworthy way to verify "no requests were lost" — and it is
  useful for tracing complaints too.
- `--self-test` mode embeds a gateway and a fake model farm, needing no GPU. CI runs a mini load
  test every time, so this rarely-executed script does not rot between acceptance runs.
- Test users are always prefixed `loadtest-` and cleaned up automatically, including on Ctrl+C.

**Client compatibility script (M11, issue #1)**

`tests/integration/client-compat.mjs`. Cursor and Codex are GUI/CLI tools that cannot be clicked
automatically, but the **shape of the requests they actually send** can be verified — endpoints,
headers, parameter combinations, streaming format, tool-call message sequences. After running
them, the script prints ready-to-paste configuration plus the remaining manual checklist.

Probing found two real problems:

- **Codex needs `wire_api = "chat"`.** Newer Codex CLI versions default to the OpenAI Responses
  API (`POST /v1/responses`), which AGI BAR does not have. Without this line it cannot connect,
  and the error message does not say why. The generated `codex-config.toml` includes it.
- **A `tokensPerRequest` default of 8192 is too small.** IDE-style clients push whole files into
  the prompt, easily tens of thousands of tokens; 8192 lets small tests pass while real usage
  throws 413s constantly. Raised to 32768, aligned with the example primary model's
  `contextWindow`.

**Admin interface access isolation (M17)**

By default only the AI host itself can open the console; LAN users see only `/v1` and the web chat.

- `/app.html`, `/api/*` and console-only JS return **404** to the LAN (a 403 admits "there is
  something here"; a 404 makes the console look nonexistent)
- The LAN hitting the root path is redirected to `/chat.html` rather than a dead end
- `/api/health` stays open for monitoring and deployment scripts
- New `security.adminAccess` (`loopback` / `lan`) and `security.adminAllowedCidrs`

The decision is based on the **peer address of the TCP connection**, not `X-Forwarded-For` — the
latter is a request header anyone can set, and using it for access control is the same as having
none. One test specifically confirms that a forged `X-Forwarded-For` does not affect the
authorisation decision.

The startup banner now lists "admin interface (local only)" and "addresses for users" separately.

**Local models can be added from the console (M18)**

Adding a model used to mean hand-editing `config/config.json` and restarting — which violates §4
of the design document ("an ordinary web-shop back office, not an engineer's server console").

The AI Models page gained **＋ Add model**: enter an endpoint → discover → tick → add, effective
immediately with no restart.

- `POST /api/models/discover` lists the models installed at an endpoint
- `GET /api/models/presets` provides default endpoints for Ollama / LM Studio / llama.cpp / vLLM
- `POST /api/models`, `DELETE /api/models/:id`
- Model IDs are derived from the upstream name (`hf.co/Qwen/Qwen3-8B-GGUF:Q5_0` →
  `hf-co-qwen-qwen3-8b-gguf-q5-0`) and can be edited
- New models are added to the default route automatically — a model not in the route exists but is
  never chosen by any request
- Removal also clears it from the config file, the default route and every user's route

Changes are written back to `config.json` and re-synced; the config file remains the single source
of truth. Writing only to the database would be overwritten on the next restart.

Verified against a real Ollama: discovered two models, added them, health check online, an actual
conversation succeeded.

### Fixed

**Drag-selecting text inside a dialog field closed the dialog**

In the "Add user" dialog, holding the mouse inside a token field, dragging outwards to select the
number and releasing outside the dialog closed the whole thing, losing every field already filled
in. Deleting character by character with the keyboard did not — because no mouse was involved,
which is why it looked like "sometimes it closes, sometimes it does not".

The cause: `modal()` only checked whether the `click` event's `target` was the backdrop. But a
`click` event's target is the **nearest common ancestor of the mousedown and mouseup targets** —
pressing inside the input and releasing outside the dialog makes that ancestor the backdrop
itself.

- Switched to `pointerdown` + `pointerup`, closing only when both land on the backdrop
- Also fixed a leaked Escape listener: the old code only removed it on the Escape path, so
  closing via ✕ / Cancel / the backdrop left a `keydown` listener on `document` every time
- The console and the web chat share the same `modal()`, so both benefit

**The initial administrator's display name is no longer hard-coded Chinese**

`bootstrapAdmin()` used to write `系統管理員` straight into `users.display_name`. That was a
default of ours rather than data the administrator entered, but once in the database the UI could
only show it verbatim — so switching to English or Japanese left exactly that one field in Chinese
(top-right, user list, logs page).

- The initial administrator now gets no pre-filled display name; the UI falls back to the account
  name (`admin`), consistent in all three languages
- Existing databases are normalised at startup: only the row where `role = 'admin'` and the value
  exactly equals the old default string is cleared. Names the administrator entered themselves —
  and every other user's name — are left untouched
- The Name column in the user list now falls back to the account name instead of showing `—`

- `limits.defaultUserLimits.tokensPerRequest` in `config.example.json`: 8192 → 32768
- **Test environment isolation.** `tests/access.test.mjs` statically imported server modules, and
  because ESM evaluates every import before running top-level statements, `core/paths.mjs` fixed
  its paths before `AGIBAR_DATA_DIR` was set — meaning the tests were actually running against the
  **production database**. That never turned the suite red; it would only surface the day it
  dirtied or locked real data. Added `tests/helpers/isolate.mjs` (which must be the first import)
  and `assertIsolated()` so this class of mistake becomes an explicit failure. Verified that the
  production database's mtime does not change after a full test run.

- Tests grew from 86 to 154

### Removed

**The entire controlled-browsing feature (web search / URL fetch)**

The console's Network page, the `/v1/tools/*` endpoints and the related quota field were all
removed. AGI BAR returns to being purely a gateway: authentication, quotas, queueing, routing,
logging.

- Deleted `server/services/websafe.mjs` and `tests/websafe.test.mjs`
- Deleted `POST /v1/tools/web_search` and `POST /v1/tools/url_fetch`
- Deleted `GET/PATCH /api/internet`, `POST /api/internet/test`, `GET /api/logs/web`
- Deleted the "Network & controlled browsing" page and its sidebar entry, the dashboard's
  "Internet status" card, and the "Controlled browsing log" panel on the Logs page
- **The "Internet access" field in the add-user / quota forms is gone**, along with the "Internet"
  column in the API key table
- The config file loses the whole `internet` block and
  `limits.defaultUserLimits.internetAllowed`
- The schema loses `api_key_limits.internet_allowed`, `request_logs.used_internet` and the
  `web_access_logs` table (existing databases need no manual migration — the removed columns all
  have defaults)

**Admin access isolation is retained.** `security.adminAccess` is unchanged — by default only the
AI host can open the console, and LAN users hitting `/app.html` or `/api/*` always get a 404, so
the console looks as though it does not exist. The `ipInCidr` helper this decision needs moved
from `services/websafe.mjs` to `core/net.mjs`, and the corresponding CIDR tests moved into
`tests/net.test.mjs`.

---

## [1.2.0] - 2026-08-07

The first complete implementation, matching the *AGI BAR V1.2 design document — GitHub Workflow
Edition*.

### Added

**Project skeleton (design document 11)**
- Portable directory structure with zero npm dependencies (`node:http` + `node:sqlite` +
  `node:crypto`)
- `啟動 AGI BAR.cmd` / `關閉 AGI BAR.cmd` transparent batch scripts, with a Node version check and
  precise shutdown by PID
- `config/config.json` is generated from `config.example.json` on first launch

**Web admin console (design document 4)**
- Administrator sign-in: scrypt password hashing, HMAC-signed session cookie, login rate limiting
- Dashboard: user count, online users, API requests, tokens today, queue, GPU/VRAM, primary model,
  internet status
- Seven sidebar items: Dashboard / Users / API / AI Models / Network / Logs / Settings
- Web chat page (`/chat.html`) where users connect with their own API key

**Users and API keys (design document 5)**
- User CRUD, capped at 50, with active/paused/disabled states
- API keys `agi-bar-xxxxxxxx`; the plaintext is shown once at creation, and the database stores
  only the SHA-256 hash and an identifying prefix
- Key rotation, pausing and revocation; rotation invalidates the old key immediately

**Quotas and time-based access (design document 5, 6)**
- Four token tiers: per request → hour → day → month, counting input + output
- Valid date range, daily window (crossing midnight supported), allowed weekdays
- RPM sliding window, concurrent request cap
- Over-quota policy: hard rejection, or soft automatic downgrade to the smallest model in the chain

**OpenAI-compatible API (design document 10)**
- `/v1/models`, `/v1/models/:id`, `/v1/chat/completions` (with SSE streaming), `/v1/completions`
- `/v1/me` so clients can query their own allowance
- Ordinary users see only model aliases; real backend model names are never exposed

**Models and routing (design document 7, 8)**
- The model registry syncs from `config.models.catalog`; removal from the config disables rather
  than deletes, preserving history
- Health checks record online/offline, average first-token latency, tokens/s, queue, error rate,
  VRAM
- Per-user model routing chain; automatic failover when rank 1 is offline, congested or fails its
  health check
- Priority queue (P0–P3) with anti-starvation weight boosting so low-priority requests do not
  starve

**Controlled browsing (design document 9)**
- A secure proxy for web search / URL fetch
- Resolves DNS first and judges the **resolved IP** against private ranges, defeating DNS
  rebinding and internal hostname bypasses
- Every redirect is re-validated against the policy
- Blocks `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`,
  `fc00::/7`, `fe80::/10` by default
- Scheme restrictions, Content-Type allowlist, maximum download size and timeout, all recorded in
  `web_access_logs`
- A policy testing tool in the console

*(This feature was removed in [Unreleased] — see above.)*

**Logging and backups (design document 12, 13)**
- `usage_logs` / `request_logs` / `web_access_logs` / `audit_logs`
- Usage reports by user, by date and by model
- Only prompt hashes are recorded by default, never content
- Consistent SQLite `VACUUM INTO` backups, run at startup and on a schedule, with a configurable
  number of copies retained
- Config export excludes the `admin` and `security` sections

**Tests**
- 47 tests: queue priority and anti-starvation, time-based access, SSRF/CIDR protection, and the
  end-to-end pipeline (sign in → create user → issue key → quota → routing → failover → logging)

**GitHub workflow (design document 15, 16)**
- `.gitignore` covers every item in design document 16.1's "must never be uploaded" list
- Issue / PR templates, branch rule documentation
- GitHub Actions: syntax check → unit tests → API tests → security scan → portable structure check
- A release build script producing the ZIP and its SHA-256

### Security
- The console's CSP is limited to `'self'` and references no external resources
- Static file serving is confined to the `web/` directory, preventing path traversal
- A wrong username and a wrong password return identical messages, preventing account enumeration
- External cloud models require explicit `requiresExplicitConsent` authorisation; without it,
  content is not sent
- `PATCH /api/settings` uses an allowlist, so administrator credentials and secrets cannot be
  tampered with through that endpoint

[Unreleased]: https://github.com/lukefownn-prog/AGI_BAR_Local_AI_Gateway/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/lukefownn-prog/AGI_BAR_Local_AI_Gateway/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/lukefownn-prog/AGI_BAR_Local_AI_Gateway/releases/tag/v1.2.0
