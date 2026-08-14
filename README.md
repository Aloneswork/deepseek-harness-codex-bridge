# DeepSeek Harness ↔ Codex Bridge

An unofficial community project for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and Codex. It is not affiliated with or endorsed by DeepSeek or OpenAI.

A local, bidirectional collaboration bridge with no database or daemon:

- Codex delegates bounded subtasks to DeepSeek Harness (DSH) through MCP.
- DSH and Codex exchange persistent JSON mailbox messages.
- While DSH is running, it can proactively create or continue a real Codex task through `codex app-server`.
- A task ledger records ownership, status, workspace, and the linked Codex thread.
- DSH cannot return the assigned subtask unchanged; non-blocker messages must include progress or evidence.

Codex remains the lead: it splits large work, coordinates dependencies, verifies the result, and makes the final decision. An assigned DSH subtask stays with DSH unless it reports material progress/evidence or a concrete blocker.

## Requirements

- macOS or Linux (Windows npm `.cmd` shim behavior is not yet verified)
- Node.js `>=22.19.0`
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), installed and configured
- Codex CLI with `codex app-server` for proactive DSH → Codex chats

```sh
npm install --global @deepseek-ai/dsh
dsh web
```

Configure a model in the DSH Web UI before using the bridge.

## Install

```sh
npm install --global https://github.com/Aloneswork/deepseek-harness-codex-bridge/releases/download/v0.2.2/deepseek-harness-mcp-bridge-0.2.2.tgz
codex mcp add deepseek_harness -- deepseek-harness-mcp
```

The package installs two commands:

- `deepseek-harness-mcp`: stdio MCP server for Codex or another MCP client.
- `dsh-codex-mail`: mailbox and proactive-chat CLI available to DSH through Bash.

Recommended Codex MCP settings:

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

Only use automatic MCP approval after the user has authorized calls without confirmation. This does not expand authorization for destructive, external, paid, publishing, credential, or sensitive-data actions.

The MCP client's tool-call timeout must be at least as long as `DSH_BRIDGE_TIMEOUT_MS`. A shorter client timeout can abandon an in-flight DSH process; the bridge now terminates tracked DSH children when its MCP process exits, but matching timeouts remains the clean path.

## MCP tools

- `delegate_to_deepseek`: creates a DSH-owned task and runs it headlessly.
- `list_deepseek_messages`: reads DSH progress, evidence, results, questions, and blockers.
- `reply_to_deepseek`: writes a persistent reply that DSH can read.
- `get_bridge_task_status`: reads task ownership, state, workspace, and linked Codex thread.

## DSH mailbox CLI

DSH receives `rootTaskId` and `taskId` in every delegated prompt.

```sh
dsh-codex-mail send \
  --root-task-id ROOT_ID \
  --task-id TASK_ID \
  --kind milestone \
  --body "Parser inspection completed" \
  --progress "100%" \
  --evidence "fixture passed"

dsh-codex-mail inbox --task-id TASK_ID --mark-read
dsh-codex-mail status --task-id TASK_ID
```

Allowed kinds are `question`, `blocker`, `milestone`, `result`, and `reply`. A `blocker` is itself an explicit blocking report; every other DSH message needs `--progress` or `--evidence`.

## Proactive DSH → Codex chat

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

The first call creates and names a Codex task. Later calls for the same `taskId` resume its stored Codex thread. The Codex answer is both printed to DSH and stored in DSH's inbox.

This is active initiation, not a resident autonomous process: DSH can start a Codex task while DSH is executing. No agent can initiate after its process has stopped unless an external scheduler starts it again.

## Storage and environment

Messages and task records default to `~/.dsh-codex-bridge/`; message files are written atomically with local-only file permissions. No API keys are copied into the package or mailbox. Do not commit or share the mailbox because delegated prompts and agent replies may contain project data.

Optional environment variables:

- `DSH_BIN`: DSH executable; default `dsh`
- `CODEX_BIN`: Codex executable; default `codex`
- `DSH_CODEX_MAILBOX_DIR`: shared mailbox directory
- `DSH_BRIDGE_TIMEOUT_MS`: DSH timeout, default `900000`
- `DSH_CODEX_CHAT_TIMEOUT_MS`: proactive Codex turn timeout, default `900000`

Delegated task prompts are capped at 16,000 characters so they fit conservative process argument limits. Put large inputs in workspace files and delegate by path.

## Collaboration policy

Recommended global `~/.codex/AGENTS.md` policy:

```md
- Codex is the primary agent and owns task framing, decomposition, coordination, decisions, integration, verification, and the final answer.
- Codex may call DSH without asking first when the user has authorized that workflow.
- DSH must execute an assigned subtask; it must not return or re-delegate the same subtask unchanged.
- DSH may contact Codex only with progress, evidence, a result, a progress-backed question, or an explicit blocker.
- Avoid simultaneous edits to the same files. DSH delegation never expands the user's authorization.
- After each DSH call, report what was delegated, what DSH returned or changed, and what Codex accepted, changed, or rejected.
```

## 中文速用

1. 安装并在 `dsh web` 中配置 DeepSeek Harness。
2. 从 GitHub Release 全局安装本包：`npm install -g https://github.com/Aloneswork/deepseek-harness-codex-bridge/releases/download/v0.2.2/deepseek-harness-mcp-bridge-0.2.2.tgz`。
3. 注册 MCP：`codex mcp add deepseek_harness -- deepseek-harness-mcp`。
4. Codex 用 MCP 委派与收发消息；DSH 用 `dsh-codex-mail` 发信、收信、查状态或主动创建 Codex 任务。
5. Codex 负责大任务拆解、协调、验收和最终决策；DSH 接到子任务后必须实做，不能原样推回。

The bridge is MIT licensed. See `LICENSE`.
