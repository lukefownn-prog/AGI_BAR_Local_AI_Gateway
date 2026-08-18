# M14 load testing and acceptance

[繁體中文](README.md) ｜ **English** ｜ [日本語](README.ja.md)

> Corresponds to section 14 of the design document ("V1 acceptance criteria") and
> [issue #2](https://github.com/lukefownn-prog/AGI_BAR_Local_AI_Gateway/issues/2).

## Two modes

| Mode | Purpose | GPU needed |
|---|---|---|
| `--self-test` | Verifies **the script itself** is not broken. Embeds a gateway + fake model farm | ✗ |
| Normal | Applies load to a real deployment — this is the **actual M14 acceptance** | ✓ |

Self-test mode runs in CI every time (`tests/loadtest.test.mjs`) so the script is known to work on
acceptance day. A load-test script that is normally never run is the easiest thing to break
between two acceptance rounds.

## Quick start

Confirm the script itself is healthy:

```bash
node tests/load/loadtest.mjs --self-test
```

Apply load to a real deployment:

```bash
node tests/load/loadtest.mjs --url http://192.168.1.100:8787 --admin-pass "your-admin-password" --users 10 --duration 60
```

## Options

| Option | Default | Notes |
|---|---|---|
| `--url` | `http://127.0.0.1:8787` | Gateway address |
| `--admin-user` | `admin` | Administrator account |
| `--admin-pass` | — | Administrator password (used to create test users) |
| `--scenario` | `all` | `all` / `steady` / `burst` / `longrun` / `quota` |
| `--users` | `10` | Virtual users, distributed round-robin across P0/P1/P2/P3 |
| `--duration` | `30` | Seconds for the `steady` scenario |
| `--max-tokens` | `64` | Output cap per request |
| `--prompt-chars` | `400` | Input length |
| `--stream` | off | Use SSE streaming instead |
| `--protocol` | `openai` | `openai` or `anthropic` (tests the Claude Code path) |
| `--json <file>` | — | Write raw data for later analysis |
| `--keep-users` | off | Keep the test users afterwards |

Exit codes: **0** passed, **1** failed, **2** execution error. Safe to wire into a deployment
script.

## The four scenarios

**`steady`** — Closed loop, N virtual users applying continuous pressure. Corresponds to the
acceptance items "10 people send requests simultaneously, the queue behaves and no request is
lost" and "low-priority requests do not starve".

**`burst`** — Open loop, flooding far beyond queue capacity in an instant. Confirms that overload
returns a **clean 429/503/504** rather than crashing, timing out, or silently dropping requests.

**`longrun`** — A single long response. Confirms it is not cut off mid-way by
`server.requestTimeoutMs`.

**`quota`** — Drives RPM, per-request limits and the daily allowance down to tiny values,
confirms they actually hold, then restores them automatically.

## Acceptance criteria

The report lists each one at the end. `✗` must be fixed; `!` is observational only.

| Criterion | Meaning | Fatal |
|---|---|---|
| No requests lost | Every request reached a terminal state | ✓ |
| All requests in request_logs | Every client `X-Request-Id` is findable in the server log | ✓ |
| No unexpected errors | Errors may only be queue/quota related — no 500s, no dropped connections | ✓ |
| Token counts reconcile | Server and client token totals agree within tolerance | ✓ |
| Low priority not starved | P3 completed at least some requests | ✓ |
| Queue drained at the end | Still not drained after polling = a leaked queue slot | ✓ |
| High priority waits less | P0 median wait ≤ P3 | ✗ |
| Low priority worst wait | P3 worst wait within the limit | ✗ |

Performance criteria are deliberately **not fatal** — the numbers differ on every machine, and
"this box is slower" should not fail acceptance.

### Two things that are easy to misjudge

**Queue drainage must be polled, not judged instantly.** The gateway writes the response out
first and only releases the queue slot in `finally` (that order is correct: releasing early would
admit the next request while this one is still being written, causing excess concurrency). So when
the client's fetch completes, the server may still count it as running. The script polls for 8
seconds and only fails if it still has not drained.

**`request_too_large` is an expected error.** The `quota` scenario triggers it deliberately.

## Recommended acceptance procedure

```bash
# 1. Baseline: confirm normal load with 10 users behaves
node tests/load/loadtest.mjs --url http://<AI-host-IP>:8787 --admin-pass "…" \
  --users 10 --duration 120 --json baseline.json

# 2. Streaming: real clients mostly stream, and the latency profile differs
node tests/load/loadtest.mjs --url http://<AI-host-IP>:8787 --admin-pass "…" \
  --users 10 --duration 120 --stream --json stream.json

# 3. Anthropic path (Claude Code)
node tests/load/loadtest.mjs --url http://<AI-host-IP>:8787 --admin-pass "…" \
  --users 6 --duration 60 --protocol anthropic --json anthropic.json

# 4. Full load: approach the design document's 50-user cap
node tests/load/loadtest.mjs --url http://<AI-host-IP>:8787 --admin-pass "…" \
  --users 40 --duration 180 --json full.json
```

Watch all of these during every round:

- **VRAM usage** on the admin dashboard (`queue.maxGlobalConcurrent` set too high causes OOM)
- `nvidia-smi` on the AI host
- Whether any errors appear in `data/logs/agibar-YYYY-MM-DD.log`

Adjust `queue.maxGlobalConcurrent` based on the observed average wait and VRAM headroom, then run
again.

## Failover verification (needs a human)

The script will not stop a model for you. While `steady` is running, manually stop the rank-1
model server. You should observe:

- Requests keep succeeding, without interruption
- Rank 1 turns offline on the admin console's AI Models page
- Failover markers appear on the Logs page
- The `steady` scenario's p95 rises in the report while the success rate holds

## Notes

- Test users are always prefixed `loadtest-` and deleted automatically at the end, including on
  Ctrl+C. If a previous round left any behind, the next run clears them first.
- The 50-user cap is a hard limit. If existing users are already near it, lower `--users`; the
  script computes the remaining headroom first and reports a clear error.
- Test users are given deliberately generous quotas so the load test hits the queue rather than a
  quota — that is what the `quota` scenario is for.
- **Do not run a full-load test against a host in production use.** It will crowd out real users.
