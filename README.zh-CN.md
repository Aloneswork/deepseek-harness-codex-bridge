# DeepSeek Harness ↔ Codex 双向协作桥

简体中文 | [English](README.md)

这是一个非官方、本地运行的 MCP 桥，让 Codex 和 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 在同一项任务上分工协作。

Codex 负责主导、拆解和验收；它可以把边界清楚的子任务交给 DeepSeek Harness（DSH），接收进度与证据，通过持久消息盒子回复，再决定是否采用结果。DSH 运行时也能主动新建或继续一个真实的 Codex 任务。桥会阻止循环甩锅：接到子任务的 Agent 必须实际执行，不能把原任务原样退回。

不需要数据库服务或常驻守护进程，消息只保存在本机 JSON 文件中。

## 安装

需要：

- macOS 或 Linux
- Node.js `>=22.19.0`
- 已安装并配置 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- Codex CLI；只有 DSH 主动联系 Codex 时才需要 `codex app-server`

如未安装 DSH，先执行下面两行，并在 Web 界面中配置模型：

```sh
npm install --global @deepseek-ai/dsh
dsh web
```

安装桥并注册到 Codex：

```sh
npm install --global https://github.com/Aloneswork/deepseek-harness-codex-bridge/releases/download/v0.2.2/deepseek-harness-mcp-bridge-0.2.2.tgz
codex mcp add deepseek_harness -- deepseek-harness-mcp
```

建议在 `~/.codex/config.toml` 中使用：

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

只有用户已经授权无需逐次确认调用 DSH 时，才应自动批准这些 MCP 工具。自动批准不包含删除、公开发布、付费服务、凭据或敏感数据传输等额外权限。

## 验证

注册 MCP 后新开一个 Codex 任务，让 Codex 委派一个无害测试，例如“返回圆周率前 10 位”。Codex 应通过 `delegate_to_deepseek` 收到 DSH 结果，并向用户说明 DSH 做了什么。

如需从源码测试：

```sh
git clone https://github.com/Aloneswork/deepseek-harness-codex-bridge.git
cd deepseek-harness-codex-bridge
npm install
npm test
```

## 给你自带 Agent 的一句话安装提示词

> 请从 https://github.com/Aloneswork/deepseek-harness-codex-bridge 安装并配置 Codex ↔ DeepSeek Harness MCP 双向协作桥；先检查 Node.js、Codex、DSH 和现有配置，保留并备份原配置，安装后做双向消息测试，最后报告所有修改文件、调用链和测试结果。

## 安装后有什么

- `deepseek-harness-mcp`：供 Codex 或其他 MCP 客户端使用的 stdio MCP 服务。
- `dsh-codex-mail`：DSH 可通过 Bash 调用的消息盒子和主动聊天命令。

MCP 提供四个工具：

- `delegate_to_deepseek`：新建 DSH 子任务并以 headless 模式执行。
- `list_deepseek_messages`：读取 DSH 的进度、证据、问题、阻塞和结果。
- `reply_to_deepseek`：写入 DSH 可读取的持久回复。
- `get_bridge_task_status`：查看任务归属、状态、工作区和关联的 Codex 任务。

DSH 在每个委派提示中都会收到 `rootTaskId` 和 `taskId`。它可以在终端发送进度：

```sh
dsh-codex-mail send \
  --root-task-id ROOT_ID \
  --task-id TASK_ID \
  --kind milestone \
  --body "解析器检查完成" \
  --progress "100%" \
  --evidence "测试样例通过"
```

DSH 运行时也可以主动联系 Codex：

```sh
dsh-codex-mail chat \
  --root-task-id ROOT_ID \
  --task-id TASK_ID \
  --kind question \
  --body "解析器是否保留这个回退逻辑？" \
  --progress "全部样例已通过" \
  --evidence "已附测试输出" \
  --workspace /absolute/project/path
```

同一 `taskId` 第一次调用 `chat` 会新建并命名 Codex 任务，后续调用继续该任务。这是运行中的主动发起，不是永远在线：DSH 进程停止后，必须由外部调度重新启动，才能再次发消息。

## 存储和边界

- 消息和任务记录默认保存在 `~/.dsh-codex-bridge/`，文件权限仅限本机用户。
- 不要提交或分享消息盒子，其中可能包含项目提示和回复。
- MCP 客户端超时应不短于 `DSH_BRIDGE_TIMEOUT_MS`，默认值为 `900000`。
- 委派提示最多 16,000 字符；大输入应放进工作区文件，再把文件路径交给 DSH。
- 可选变量：`DSH_BIN`、`CODEX_BIN`、`DSH_CODEX_MAILBOX_DIR`、`DSH_BRIDGE_TIMEOUT_MS`、`DSH_CODEX_CHAT_TIMEOUT_MS`。

## 建议协作规则

```md
- Codex 负责问题定义、任务拆解、协调、决策、集成、验证和最终答复。
- 只有用户已授权时，Codex 才可免逐次确认调用 DSH。
- DSH 必须执行收到的子任务，不能把它原样退回或再次转交。
- DSH 只能用进度、证据、结果、有进展支撑的问题或明确阻塞联系 Codex。
- 避免同时修改同一文件；委派不会扩大用户授权。
- 每次调用 DSH 后，都要报告委派内容、DSH 的返回或修改，以及 Codex 的采纳、修改或否决。
```

MIT 许可证。本项目与 DeepSeek、OpenAI 均无隶属或官方认可关系。
