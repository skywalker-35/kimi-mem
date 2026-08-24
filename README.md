# kimi-mem

> **English** | [中文](./README.zh-CN.md)

Persistent memory plugin for [Kimi Code](https://www.kimi.com/) CLI — a full port of [opencode-mem](https://github.com/tickernelz/opencode-mem)'s memory capabilities to Kimi Code.

It automatically captures a summary of every coding session into a local vector database, then injects relevant past memories and your learned **user profile** into the context of the next session — so your AI coding agent remembers what you did, how you work, and what you prefer, across sessions and projects.

## Features

- **Automatic capture**: when a session (or turn) ends, an LLM distills the work into a single memory stored in a local vector store (with tool-call context, automatic retry on failure, and `private`-marker filtering)
- **Automatic injection**: on the first message of a session, semantically searches relevant past memories + recent project memories, and injects them into context together with your **user profile**
- **Per-session injection switch**: `/kimi-mem:inject off|on|status` toggles injection for the current session (persisted per session, survives resume; capture is not affected)
- **User profile learning**: every 10 prompts, an LLM summarizes your preferences / habits / workflows into an evolving profile
- **Web UI**: browse / search / edit memories, timeline, and user profile (default `http://127.0.0.1:5757`)
- **MCP server**: 9 `memory_*` tools (search / add / list / export / import / migrate …) so the agent can actively store and recall memories
- **Windows toast notifications** when a capture completes
- **Shared storage with opencode-mem**: memories live in `~/.opencode-mem/data` — fully interoperable with OpenCode + opencode-mem

## Architecture

```
Kimi Code
  │ hooks: UserPromptSubmit → plugin/hooks/inject.mjs   (inject memories + profile)
  │ hooks: Stop / SessionEnd → plugin/hooks/capture.mjs (POST to sidecar)
  │ MCP: plugin/mcp-server.mjs                          (memory_* tools)
  ▼
daemon (bun process, custom integration layer)
  ├─ daemon/start.mjs            Web UI + HTTP API (:5757) + capture sidecar (:5758)
  ├─ daemon/capture-core.mjs     capture core: read session transcript → LLM distill → vector store
  ├─ daemon/profile-learning.mjs user profile learning
  └─ daemon/opencode-mem/        vendored upstream (only 1 patched file, see PATCHES.md)
       └─ local Turso/libSQL vector store + Web UI (storage & retrieval engine)
```

kimi-mem is a **thin wrapper** around upstream opencode-mem (zero vendor changes except 5 Windows compatibility patches, see `daemon/opencode-mem/PATCHES.md`); the host integration layer (hooks / capture / MCP / profile scheduling) is implemented from scratch for Kimi Code.

## Requirements

- Windows (only platform verified so far)
- [Kimi Code](https://www.kimi.com/) CLI
- [Bun](https://bun.sh/) (required to run the daemon)
- Node.js 18+ (runs the hooks and MCP server)
- Git (resolves the project tag and the user-profile userId)
- An OpenAI Chat-compatible LLM endpoint (for memory distillation and profile learning — e.g. Volcano Engine Ark, DeepSeek, MiniMax)

## Installation

### Option 1: Release zip (recommended, one command)

In Kimi Code:

```
/plugins install https://github.com/skywalker-35/kimi-mem/releases/latest/download/kimi-mem.zip
```

Then:

1. Set the API key environment variable (matching `apiKeyEnv` in the config, default `OPENAI_API_KEY`), e.g. PowerShell:
   `[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "your-key", "User")`
2. Create the user-level config `~/.kimi-mem/kimi-mem.config.json` with your OpenAI-compatible endpoint and model:
   ```json
   {
     "capture": {
       "apiUrl": "https://api.deepseek.com",
       "apiKeyEnv": "OPENAI_API_KEY",
       "model": "deepseek-v4-flash"
     }
   }
   ```
3. Run `/new` or `/reload` to activate the plugin

Any OpenAI Chat-compatible provider works. Quick reference:

| Provider | `apiUrl` | Example `model` |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-v4-flash` / `deepseek-v4-pro` |
| OpenAI | `https://api.openai.com/v1` | `gpt-5.3-instant`, etc. |
| Volcano Engine Ark | `https://ark.cn-beijing.volces.com/api/v3` | your endpoint ID (`ep-xxxx`) |
| MiniMax | `https://api.minimaxi.com/v1` | `MiniMax-M3`, etc. |

> Model names change over time — check your provider's docs (e.g. DeepSeek's legacy `deepseek-chat` was retired in July 2026). Distillation is a light workload, so a cheap fast model is ideal.

On the first capture, vendor runtime dependencies are installed automatically in the background via `bun install` (about 1-2 minutes); afterwards the daemon starts itself. Visit `http://127.0.0.1:5757` to confirm the Web UI.

### Option 2: Clone the source (developers)

```bash
# 1. Clone and build the vendor (opencode-mem storage engine + Web UI)
git clone https://github.com/skywalker-35/kimi-mem.git
cd kimi-mem/daemon/opencode-mem
bun install
bun x tsc
cd web && bun install && bun run build   # Web UI output goes to ../dist/web

# 2. Configure (either):
#    a. Edit plugin/kimi-mem.config.json: capture.model, apiUrl, apiKeyEnv
#    b. Or use the user-level config ~/.kimi-mem/kimi-mem.config.json (recommended; local secrets stay out of git):
#       { "daemonHome": "<clone-path>/daemon", "capture": { "model": "..." } }
#       ※ daemonHome is required here: local installs copy the plugin into a managed
#         directory, where repo-layout auto-detection no longer works

# 3. Set the API key environment variable (matching apiKeyEnv, default OPENAI_API_KEY)
#    PowerShell: [Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "your-key", "User")
```

Then in Kimi Code:

```
/plugins install <clone-path>/plugin
/new        # or /reload to activate
```

> The user profile feature uses your git email as the user identity: having `git config user.email` set in any project repo (repo-level is fine) is enough.

## Configuration (plugin/kimi-mem.config.json)

| Key | Description | Default |
|---|---|---|
| `port` | Web UI / API port (capture sidecar = port+1) | `5757` |
| `daemonHome` | daemon code directory (containing `start.mjs`) | `daemon/` inside the plugin root (zip layout) or sibling of `plugin/` (repo layout) |
| `bunPath` | bun executable path (alternative: `KIMI_MEM_BUN` env var) | auto-detect |
| `inject.enabled` / `maxResults` / `minPromptLength` | injection switch / max injected memories / skip retrieval below this prompt length | `true` / `5` / `8` |
| `capture.enabled` | auto-capture switch | `true` |
| `capture.minIntervalSec` | minimum interval between two captures of the same session | `120` |
| `capture.provider` / `apiUrl` / `apiKeyEnv` / `model` | distillation LLM (OpenAI Chat-compatible) | OpenAI official endpoint + `OPENAI_API_KEY` |
| `capture.extraParams` | extra request params (e.g. `reasoning_effort`) | — |
| `capture.notify` | Windows toast on capture completion | `true` |
| `profile.enabled` / `analysisInterval` | profile learning switch / prompts per learning cycle | `true` / `10` |

The daemon also reuses opencode-mem's config file `~/.config/opencode/opencode-mem.jsonc` (storage path etc.).

**User-level overrides**: `~/.kimi-mem/kimi-mem.config.json` (optional) is deep-merged over the plugin-directory config — ideal for local secrets (`daemonHome`, `bunPath`, `capture.model`) so the in-repo config can stay a pristine template. Merge order: built-in defaults < plugin-directory config < user-level config.

## Data & Privacy

- All memories are stored locally in `~/.opencode-mem/data` (Turso/libSQL vector store), **shared with opencode-mem** — if you also use OpenCode + opencode-mem, memories interoperate both ways
- The only outbound traffic: session summaries sent to **your own configured** LLM endpoint during capture / profile learning
- Logs live in `~/.kimi-mem/` (debug.log / profile-debug.log / cursors.json …)

## Relationship with opencode-mem (data sharing & coexistence)

If you already use OpenCode with opencode-mem:

- **Fully shared database**: kimi-mem deliberately reuses opencode-mem's default storage (`~/.opencode-mem/data`), config file (`~/.config/opencode/opencode-mem.jsonc`), project-tag algorithm, and auth token. Memories from both tools land in the same shard for the same project — captured in OpenCode, injectable in Kimi Code, and vice versa. Your history is visible immediately after installing kimi-mem, zero migration
- **Independent processes**: each daemon runs its own port (opencode-mem 4747, kimi-mem 5757 by default); either can run alone or both together
- **Concurrent captures**: both daemons write to the same local SQLite/libSQL file. In theory there is momentary lock contention, but in practice: ① each side only captures its own tool's sessions, never duplicate content; ② writes are short transactions, collisions are extremely unlikely; ③ SQLite commits are atomic — no corruption possible, and kimi-mem retries failed captures automatically. Long-term dual-daemon coexistence verified
- **Version consistency**: shared storage means both sides should track similar upstream versions. If a future opencode-mem release changes the storage format or tag algorithm, wait for a matching kimi-mem update before mixing (vendor version: see `daemon/opencode-mem/package.json`, currently based on upstream `eda6583`)

## FAQ

- **Changes under `plugin/` don't take effect**: Kimi Code copies plugins into a managed directory (`$KIMI_CODE_HOME/plugins/managed/kimi-mem/`) — sync your edits there; changes under `daemon/` require a daemon restart
- **No memories captured**: check `~/.kimi-mem/debug.log`; make sure the daemon is running (visit :5757) and the API key env var is set (and the terminal restarted afterwards)
- **Web UI profile page shows "No profile found"**: profiles are keyed by git email — run `git config user.email you@example.com` in your project repo first

## Credits & License

- Storage engine, vector search, Web UI, and profile management come from [tickernelz/opencode-mem](https://github.com/tickernelz/opencode-mem) (MIT), vendored in `daemon/opencode-mem/` — patch list: `daemon/opencode-mem/PATCHES.md`
- kimi-mem's own code is released under [MIT](./LICENSE)

Development notes & pitfalls (for maintainers): [docs/dev-notes.md](./docs/dev-notes.md) · Release process: [CONTRIBUTING.md](./CONTRIBUTING.md)

---

*Keywords: Kimi Code plugin, persistent memory, AI agent memory, cross-session memory, semantic vector search, local-first, MCP server, user profile learning, opencode-mem port, coding agent context, Turso / libSQL*
