# M11 client compatibility verification

[繁體中文](README.md) ｜ **English** ｜ [日本語](README.ja.md)

> Corresponds to section 10 of the design document and
> [issue #1](https://github.com/lukefownn-prog/AGI_BAR_Local_AI_Gateway/issues/1).

## What this script can and cannot do

Cursor and Codex are GUI / CLI tools — **they cannot be clicked automatically**.

What *can* be verified automatically is the **shape of the requests they actually send** —
endpoints, headers, parameter combinations, streaming format, tool-call message sequences. The
script sends all of them, finding the sticking points before you start configuring anything, then
prints ready-to-paste configuration plus the remaining manual checklist.

Actually opening Cursor and pressing Verify still needs a human.

## Usage

```bash
node tests/integration/client-compat.mjs --self-test          # verify the script itself
node tests/integration/client-compat.mjs --url http://192.168.1.100:8787 --key agi-bar-xxxxxxxx
node tests/integration/client-compat.mjs --url http://… --admin-pass "password" --client codex
```

Without an existing key, use `--admin-pass`: the script creates a `compat-probe` user and deletes
it when finished. It deliberately keeps the config file's **default quotas** (only widening the
time window) so the "large context" probe reflects the limits a real user would actually hit.

| Option | Notes |
|---|---|
| `--url` | Gateway address |
| `--key` | Probe with an existing API key |
| `--admin-pass` | Create a probe user automatically when you have no key |
| `--client` | `all` / `cursor` / `codex` / `claude-code` / `app` / `deepseek` |
| `--emit <dir>` | Generate configuration files (config.toml, env.sh, env.ps1, smoke.sh) |
| `--show-secrets` | Show the full API key in generated config (**masked by default**) |
| `--json <file>` | Write raw results |

Exit codes: 0 passed / 1 a required check failed / 2 execution error.

## Two known traps

The script flags both directly; here is why they exist.

### Codex: `wire_api = "chat"` is mandatory

Newer Codex CLI versions **default to the OpenAI Responses API** (`POST /v1/responses`), while
AGI BAR only offers `/v1/chat/completions`. Without this line it cannot connect, and the error
message usually does not tell you why.

```toml
# ~/.codex/config.toml
model = "agi-bar-default"
model_provider = "agibar"

[model_providers.agibar]
name = "AGI BAR"
base_url = "http://192.168.1.100:8787/v1"
env_key = "OPENAI_API_KEY"
wire_api = "chat"        # ← the key line
```

The `codex-config.toml` produced by `--emit` already includes it.

### The per-request token limit must be large enough

IDE-style clients push entire files into the prompt, easily tens of thousands of tokens. With
`tokensPerRequest` at 8192, **small test requests all pass while real usage throws 413s
constantly** — a problem only visible with a large payload, which is why the probe deliberately
uses a realistic ~10,000-token size.

The config default has been raised to 32768, aligned with the example primary model's
`contextWindow`. Check both when you change models.

## Base URL differences

The three clients differ, and this is the most common slip:

| Client | Environment variable | Append `/v1`? |
|---|---|---|
| Cursor | Override OpenAI Base URL | **Yes** |
| Codex | `OPENAI_BASE_URL` | **Yes** |
| Claude Code | `ANTHROPIC_BASE_URL` | **No** (the SDK adds `/v1/messages` itself) |

Adding `/v1` for Claude Code produces `/v1/v1/messages`. The gateway accepts both paths, but the
correct form omits it.

## Probe coverage

**Common** — Bearer authentication, invalid key rejection, `/v1/models` structure, error format,
`X-Request-Id`

**Cursor** — the Verify probe request, arbitrary model-name routing (a leftover `gpt-4o` in the
list must still work), streaming, `stream_options.include_usage`, sampling parameter pass-through,
large context, current `/v1/embeddings` status

**Codex** — model list, `/v1/responses` detection, the `wire_api="chat"` path, tool definitions,
**tool result feedback** (the `role=tool` message on the agent's second turn — if this fails,
Codex stalls right after its first tool call), streaming, tolerance of unknown parameters

**Claude Code** — `/v1/messages`, the `x-api-key` header

**Your own apps** — current CORS preflight behaviour

**DeepSeek** — the authorisation gate on external cloud models (confirming it is not enabled by
accident)

## Manual steps

Listed at the end of the report. In summary:

- **Cursor**: press Verify → open Chat and send a message → confirm the request appears on the
  console's Logs page. Note that tab completion and parts of Composer go to Cursor's own servers
  and never reach AGI BAR.
- **Codex**: write `~/.codex/config.toml` → set `OPENAI_API_KEY` → run a simple task.
- **Claude Code**: set the three `ANTHROPIC_` environment variables → run `claude`. Agent features
  depend on whether the backend model supports tool calling.

## CI protection

`tests/client-compat.test.mjs` runs on every CI pass, for the same reason as the load-test script:
it is normally never executed, making it the easiest thing to break between two acceptance rounds.

One test deliberately asserts that **`/v1/responses` is still unimplemented** — the day it is
implemented, that test fails and reminds you to remove the "you must set wire_api" guidance.

## Notes

- **One process can host only one `--self-test` environment.** `core/paths.mjs` fixes the data
  directory at module load and `core/config.mjs` caches the config, so a second run reuses the
  first (already closed) environment. Run separate processes for multiple scenarios.
- Generated config files mask the API key by default. Files produced with `--show-secrets` contain
  the full key — **do not commit them**.
