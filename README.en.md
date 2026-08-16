# AGI BAR — Local AI Gateway Management System

[繁體中文](README.md) ｜ **English** ｜ [日本語](README.ja.md)

A **local AI gateway management system** driven entirely from the browser. An administrator
starts the service on one AI host; everyone else on the same network can then chat through the
web page, or connect their AI development tools and apps over an **OpenAI-compatible API**.

> Version: **V1.2 — GitHub Workflow Edition**
> Scale: 1 admin + 1–50 users, each with their own API key.

---

## Features

| Capability | What it does |
|---|---|
| Per-person API keys | One `agi-bar-xxxxxxxx` per user; the database stores only the SHA-256 hash |
| Token quotas | Four tiers — per request / hour / day / month — counting input + output |
| Time-based access | Valid date range, daily time window (crossing midnight supported), allowed weekdays |
| Rate control | RPM plus a concurrent-request cap |
| Model routing | Per-user priority order; when rank 1 fails it automatically fails over to the next |
| Priority queue | P0 admin / P1 high / P2 normal / P3 guest, with anti-starvation |
| Admin isolation | The console is loopback-only by default; LAN users always get a 404 |
| Full audit trail | Queue wait, inference time, tokens and failover are recorded for every request |
| Dual protocol | OpenAI `/v1/chat/completions` and Anthropic `/v1/messages` share one quota pipeline |

**Zero npm dependencies.** Everything is built on Node.js built-ins (`node:http` + `node:sqlite`
+ `node:crypto`) — no `node_modules`, no build step. Unzip and run.

---

## Quick start

### Requirements

- Windows 10/11 (other platforms can run `node server/index.mjs` directly)
- Node.js **24 LTS or newer** (`node:sqlite` must be available without a flag), or drop a
  `node.exe` into `runtime/`

### Start it

```bash
node server/index.mjs
```

On Windows, double-click **`啟動 AGI BAR.cmd`** — it checks the Node version, creates the config
file and opens the browser. To stop, double-click **`關閉 AGI BAR.cmd`** (it shuts down by PID, so
it will not kill your other Node processes).

The first launch prints the initial admin credentials (`admin` / `agibar-admin` by default).
**Sign in and change the password on the Settings page immediately.**

| Purpose | Address | Who can reach it |
|---|---|---|
| Web admin console | `http://localhost:8787` | **AI host only** |
| Web chat | `http://<AI-host-IP>:8787/chat.html` | Anyone on the LAN |
| API base URL | `http://<AI-host-IP>:8787/v1` | Anyone on the LAN |

The console is restricted to the local machine by default — LAN users hitting the root path are
redirected to the chat page, while `/app.html` and `/api/*` always return 404, so the console
looks like it does not exist. To open it up, change `security.adminAccess`; see
[docs/安全須知.md](docs/安全須知.md) (Security notes).

---

## Configuring local models

Edit `models.catalog` in `config/config.json` to point at your llama.cpp / Ollama / vLLM (or any
other OpenAI-compatible) endpoint, then restart:

```json
{
  "models": {
    "catalog": [
      {
        "id": "local-primary",
        "displayName": "Primary local model",
        "endpoint": "http://127.0.0.1:8080/v1",
        "model": "qwen2.5-7b-instruct",
        "enabled": true,
        "isLocal": true,
        "vramMb": 8000
      }
    ],
    "defaultRoute": ["local-primary"]
  }
}
```

Enabling/disabling models and running health checks can be done live on the **AI Models** page —
no restart needed.

---

## Connecting external tools

Any OpenAI-compatible client that lets you set a custom base URL and API key will work. Tools
that speak the Anthropic Messages API — Claude Code, for instance — also connect directly: the
gateway has a built-in `/v1/messages` translation layer, so **no external proxy is required**.

Step-by-step setup for Cursor, Claude Code, Codex, a DeepSeek fallback and your own apps is in
**[docs/整合設定.md](docs/整合設定.md)** (Integration guide).

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer agi-bar-YOUR-KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"agi-bar-default","messages":[{"role":"user","content":"Hello"}]}'
```

---

## Project layout

```
agi-bar/
├─ 啟動 AGI BAR.cmd     Start script (a plain batch file, not an unsigned EXE)
├─ 關閉 AGI BAR.cmd     Stop script
├─ web/                 Web UI (admin console + web chat, no build step)
├─ server/              Gateway / API / Queue / Router
│  ├─ core/             Config, database, crypto, HTTP, logging
│  ├─ services/         Users, keys, quotas, models, routing, queue, backup
│  └─ routes/           Admin API, OpenAI-compatible API, static files
├─ scripts/             Build and check scripts
├─ config/              config.example.json (config.json is not committed)
├─ docs/                Architecture, deployment, integration, security
├─ tests/               Unit tests + end-to-end tests
├─ models/              GGUF models (not committed)
├─ data/                Database, logs, backups (not committed)
└─ runtime/             Bundled Node / llama.cpp (not committed)
```

---

## Development

```bash
npm test
```

163 tests cover queue priority and anti-starvation, time-based access, admin access isolation,
Anthropic ↔ OpenAI translation, and two end-to-end pipelines
(sign in → create user → issue key → quota → routing → failover → logging).

Load testing and pre-production acceptance:

```bash
npm run loadtest:self                      # verifies the script itself (no GPU needed)
npm run loadtest -- --url http://<IP>:8787 --admin-pass "…" --users 10
```

Client compatibility checks:

```bash
npm run compat:self                        # verifies the script itself
npm run compat -- --url http://<IP>:8787 --key agi-bar-xxxxxxxx
```

See **[tests/load/README.md](tests/load/README.md)** and
**[tests/integration/README.md](tests/integration/README.md)**.

Branching rules, the PR process and release steps are in
**[docs/開發流程.md](docs/開發流程.md)** (Development workflow).

---

## Security notes

- This system is designed for **internal networks**. It has no built-in protection for the public
  internet (no TLS termination, no WAF). Put it behind a reverse proxy with HTTPS before exposing
  it externally.
- `config/config.json`, `data/`, `models/` and `runtime/` are in `.gitignore`, so **API keys,
  passwords, usage logs and model files never enter the repository**.
- External cloud models (such as DeepSeek) are disabled by default. Enabling one means agreeing
  that prompts on that route leave your local network — check it against your organisation's
  policy first.

The full list is in **[docs/安全須知.md](docs/安全須知.md)** (Security notes).

---

## Licence

[MIT License](LICENSE). Free to use, modify, distribute and sell, as long as the copyright notice
is retained.

Operators remain responsible for the network security and access control of their deployment, the
licence compliance of any AI models they connect, and the legality and confidentiality of the data
processed through the system.

---

## Documentation

Detailed documents are currently written in Traditional Chinese. English and Japanese versions of
this README are provided above; the `docs/` folder also carries `.en.md` and `.ja.md` translations:

| Document | 繁體中文 | English | 日本語 |
|---|---|---|---|
| Architecture | [架構.md](docs/架構.md) | [架構.en.md](docs/架構.en.md) | [架構.ja.md](docs/架構.ja.md) |
| Deployment | [部署.md](docs/部署.md) | [部署.en.md](docs/部署.en.md) | [部署.ja.md](docs/部署.ja.md) |
| Integration | [整合設定.md](docs/整合設定.md) | [整合設定.en.md](docs/整合設定.en.md) | [整合設定.ja.md](docs/整合設定.ja.md) |
| Security | [安全須知.md](docs/安全須知.md) | [安全須知.en.md](docs/安全須知.en.md) | [安全須知.ja.md](docs/安全須知.ja.md) |
| Dev workflow | [開發流程.md](docs/開發流程.md) | [開發流程.en.md](docs/開發流程.en.md) | [開發流程.ja.md](docs/開發流程.ja.md) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) | [CHANGELOG.en.md](CHANGELOG.en.md) | [CHANGELOG.ja.md](CHANGELOG.ja.md) |
