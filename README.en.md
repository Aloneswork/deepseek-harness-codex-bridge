# DeepSeek Harness ↔ Codex Bridge

[简体中文](README.md) | English

An unofficial, local MCP bridge that lets Codex and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) work on the same job.

Codex stays in charge. It can send a bounded subtask to DeepSeek Harness (DSH), receive progress and evidence, reply through a persistent mailbox, and verify the final result. DSH can also start or continue a real Codex task while DSH is running. The bridge blocks circular hand-offs: an agent must do its assigned subtask instead of returning it unchanged.

No database server or resident daemon is required. Mailbox data stays in local JSON files.

## Install

Requirements:

- macOS or Linux
- Node.js `>=22.19.0`
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), installed and configured
- Codex CLI with `codex app-server` (required only for proactive DSH → Codex chats)

Install DSH first if needed, then configure a model in its Web UI:

```sh
npm install --global @deepseek-ai/dsh
dsh web
```

Install the bridge and register it in Codex:

```sh
npm install --global https://github.com/Aloneswork/deepseek-harness-codex-bridge/releases/download/v0.2.2/deepseek-harness-mcp-bridge-0.2.2.tgz
codex mcp add deepseek_harness -- deepseek-harness-mcp
```

Recommended Codex MCP settings in `~/.codex/config.toml`:

```toml
[mcp_servers.deepseek_harness]
tool_timeout_sec = 900
enabled_tools = [
  "delegate_to_deepseek",
  "list_deepseek_messages",
  "reply_to_deepseek",
  "get_bridge_task_status",
]
default_tools_approval_mode = "approve"
```

Automatic approval is appropriate only when the user has already authorized DSH calls without confirmation. It never grants permission for destructive actions, publishing, paid services, credentials, or sensitive-data transfer.

## Verify

Start a new Codex task after registering the MCP, then ask Codex to delegate a harmless test such as “return the first 10 digits of pi.” Codex should receive the DSH result through `delegate_to_deepseek` and report what DSH did.

To test from source:

```sh
git clone https://github.com/Aloneswork/deepseek-harness-codex-bridge.git
cd deepseek-harness-codex-bridge
npm install
npm test
```

## One-line prompt for your agent

> Install and configure the Codex ↔ DeepSeek Harness MCP bridge from https://github.com/Aloneswork/deepseek-harness-codex-bridge; inspect Node.js, Codex, DSH, and existing configs first, preserve and back up current settings, run the bidirectional messaging smoke test, then report every changed file, call path, and test result.

## What is installed

- `deepseek-harness-mcp`: stdio MCP server used by Codex or another MCP client.
- `dsh-codex-mail`: mailbox and proactive-chat CLI available to DSH through Bash.

The MCP server exposes:

- `delegate_to_deepseek`: create a DSH-owned task and run it headlessly.
- `list_deepseek_messages`: read DSH progress, evidence, questions, blockers, and results.
- `reply_to_deepseek`: write a persistent reply that DSH can read.
- `get_bridge_task_status`: inspect ownership, state, workspace, and linked Codex task.

DSH receives `rootTaskId` and `taskId` in every delegated prompt. It can send progress from its shell:

```sh
dsh-codex-mail send \
  --root-task-id ROOT_ID \
  --task-id TASK_ID \
  --kind milestone \
  --body "Parser inspection completed" \
  --progress "100%" \
  --evidence "fixture passed"
```

It can proactively contact Codex while DSH is executing:

```sh
dsh-codex-mail chat \
  --root-task-id ROOT_ID \
  --task-id TASK_ID \
  --kind question \
  --body "Should the parser keep this fallback?" \
  --progress "All fixtures pass" \
  --evidence "test output attached" \
  --workspace /absolute/project/path
```

The first `chat` call creates and names a Codex task. Later calls with the same `taskId` continue that task. This is active initiation, not an always-running agent: after DSH stops, an external scheduler must start it again before it can send another message.

## Storage and limits

- Messages and task records default to `~/.dsh-codex-bridge/` and use local-only file permissions.
- Do not commit or share the mailbox; prompts and replies may contain project data.
- The MCP client timeout should be at least `DSH_BRIDGE_TIMEOUT_MS` (default `900000`).
- Delegated prompts are limited to 16,000 characters. Put large inputs in workspace files and delegate by path.
- Optional variables: `DSH_BIN`, `CODEX_BIN`, `DSH_CODEX_MAILBOX_DIR`, `DSH_BRIDGE_TIMEOUT_MS`, and `DSH_CODEX_CHAT_TIMEOUT_MS`.

## Recommended collaboration rule

```md
- Codex owns framing, decomposition, coordination, decisions, integration, verification, and the final answer.
- Codex may call DSH without asking first only when the user has authorized that workflow.
- DSH must execute an assigned subtask and must not return or re-delegate it unchanged.
- DSH may contact Codex only with progress, evidence, a result, a progress-backed question, or an explicit blocker.
- Avoid simultaneous edits to the same files. Delegation never expands the user's authorization.
- After every DSH call, report what was delegated, what DSH returned or changed, and what Codex accepted, changed, or rejected.
```

MIT licensed. Not affiliated with or endorsed by DeepSeek or OpenAI.
