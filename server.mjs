#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const VERSION = '0.2.2';
const dshBin = process.env.DSH_BIN || 'dsh';
const codexBin = process.env.CODEX_BIN || 'codex';
const mailboxDir = resolve(process.env.DSH_CODEX_MAILBOX_DIR || join(homedir(), '.dsh-codex-bridge'));
const messagesDir = join(mailboxDir, 'messages');
const tasksDir = join(mailboxDir, 'tasks');
const timeoutMs = integerEnv('DSH_BRIDGE_TIMEOUT_MS', 900_000);
const chatTimeoutMs = integerEnv('DSH_CODEX_CHAT_TIMEOUT_MS', 900_000);
const kinds = ['question', 'blocker', 'milestone', 'result', 'reply'];
const idSchema = z.string().trim().min(1).max(128).regex(/^[\w.:-]+$/u);
const activeDshChildren = new Set();

function stopActiveDshChildren() {
  for (const child of activeDshChildren) child.kill();
}

process.on('exit', stopActiveDshChildren);
process.once('SIGTERM', () => {
  stopActiveDshChildren();
  process.exit(143);
});
process.once('SIGINT', () => {
  stopActiveDshChildren();
  process.exit(130);
});

function integerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < 1000 || value > 3_600_000) {
    throw new Error(`${name} must be between 1000 and 3600000`);
  }
  return value;
}

function messageLimit(value = '20') {
  const limit = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be between 1 and 100');
  }
  return limit;
}

function recordPath(directory, id) {
  return join(directory, `${encodeURIComponent(id)}.json`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readTask(taskId) {
  try {
    return await readJson(recordPath(tasksDir, taskId));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Unknown taskId: ${taskId}`);
    throw error;
  }
}

async function updateTask(taskId, patch) {
  const task = await readTask(taskId);
  const updated = { ...task, ...patch, updatedAt: new Date().toISOString() };
  await atomicWrite(recordPath(tasksDir, taskId), updated);
  return updated;
}

function sameText(left, right) {
  const normalize = (value) => value.trim().replace(/\s+/gu, ' ').toLowerCase();
  return normalize(left) === normalize(right);
}

async function createMessage(input) {
  const message = {
    id: randomUUID(),
    rootTaskId: idSchema.parse(input.rootTaskId),
    taskId: idSchema.parse(input.taskId),
    parentTaskId: input.parentTaskId ? idSchema.parse(input.parentTaskId) : null,
    sender: z.enum(['codex', 'dsh']).parse(input.sender),
    recipient: z.enum(['codex', 'dsh']).parse(input.recipient),
    kind: z.enum(kinds).parse(input.kind),
    body: z.string().trim().min(1).max(100_000).parse(input.body),
    progress: input.progress ? z.string().trim().max(100_000).parse(input.progress) || null : null,
    evidence: input.evidence ? z.string().trim().max(100_000).parse(input.evidence) || null : null,
    workspace: input.workspace ? resolve(input.workspace) : null,
    createdAt: new Date().toISOString(),
    replyTo: input.replyTo ? z.string().uuid().parse(input.replyTo) : null,
    readAt: null,
  };

  if (message.sender === 'dsh') {
    const task = await readTask(message.taskId);
    if (task.owner !== 'dsh') throw new Error(`Task ${message.taskId} is not owned by DSH`);
    if (task.rootTaskId !== message.rootTaskId) throw new Error('rootTaskId does not match the task ledger');
    if (message.recipient !== 'codex') throw new Error('DSH messages must be addressed to Codex');
    if (sameText(message.body, task.objective)) {
      throw new Error('DSH must not return the assigned subtask unchanged');
    }
    if (message.kind !== 'blocker' && !message.progress && !message.evidence) {
      throw new Error('DSH messages must include progress or evidence unless kind is blocker');
    }
  }

  await atomicWrite(recordPath(messagesDir, message.id), message);
  return message;
}

async function listMessages({ recipient, taskId, unreadOnly = true, markRead = false, limit = 20 }) {
  await mkdir(messagesDir, { recursive: true, mode: 0o700 });
  // ponytail: linear scan is enough for a local mailbox; add an index only if volume proves it necessary.
  const files = (await readdir(messagesDir)).filter((name) => name.endsWith('.json'));
  const records = await Promise.all(files.map((name) => readJson(join(messagesDir, name))));
  const selected = records
    .filter((message) => message.recipient === recipient)
    .filter((message) => !taskId || message.taskId === taskId)
    .filter((message) => !unreadOnly || !message.readAt)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, limit);

  if (markRead) {
    const readAt = new Date().toISOString();
    await Promise.all(selected.map((message) =>
      atomicWrite(recordPath(messagesDir, message.id), { ...message, readAt }),
    ));
  }
  return selected;
}

async function validWorkspace(workspace) {
  const cwd = resolve(workspace || process.cwd());
  if (!(await stat(cwd)).isDirectory()) throw new Error(`${cwd} is not a directory`);
  return cwd;
}

function runDsh(prompt, { cwd, signal }) {
  return new Promise((accept, reject) => {
    const child = execFile(dshBin, ['--profile', 'headless', prompt], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      signal,
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}`,
      },
    }, (error, stdout, stderr) => {
      activeDshChildren.delete(child);
      if (error) {
        error.stdout ||= stdout;
        error.stderr ||= stderr;
        reject(error);
      } else {
        accept({ stdout, stderr });
      }
    });
    activeDshChildren.add(child);
  });
}

function appServerPrompt(message) {
  return `[DSH initiated collaboration]\nRoot task: ${message.rootTaskId}\nAssigned DSH subtask: ${message.taskId}\nMessage kind: ${message.kind}\nProgress: ${message.progress || '(none)'}\nEvidence: ${message.evidence || '(none)'}\n\n${message.body}\n\nCodex is the lead coordinator and final decision-maker. This subtask is already owned by DSH: do not delegate it back to DSH. Respond to the supplied progress, evidence, question, result, or blocker; integrate or decide the next step.`;
}

async function runCodexChat({ threadId, message, cwd }) {
  const child = spawn(codexBin, ['app-server'], {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0;
  let answer = '';
  let stderr = '';
  let acceptCompleted;
  let rejectCompleted;
  const completed = new Promise((accept, reject) => {
    acceptCompleted = accept;
    rejectCompleted = reject;
  });

  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-64_000);
  });
  child.on('error', (error) => {
    for (const { reject } of pending.values()) reject(error);
    rejectCompleted(error);
  });
  child.on('close', (code) => {
    const error = new Error(`Codex app-server exited before completion (code ${code})`);
    for (const { reject } of pending.values()) reject(error);
    rejectCompleted(error);
  });
  lines.on('line', (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.id !== undefined && pending.has(event.id)) {
      const { resolve: accept, reject } = pending.get(event.id);
      pending.delete(event.id);
      if (event.error) reject(new Error(event.error.message));
      else accept(event.result);
    }
    if (event.method === 'item/agentMessage/delta') answer += event.params?.delta || '';
    if (event.method === 'turn/completed') acceptCompleted(event.params.turn);
  });

  const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
  const request = (method, params = {}) => {
    const id = nextId++;
    send({ method, id, params });
    return new Promise((accept, reject) => pending.set(id, { resolve: accept, reject }));
  };
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Codex chat timed out after ${chatTimeoutMs}ms`)), chatTimeoutMs);
  });

  try {
    await Promise.race([
      (async () => {
        await request('initialize', {
          clientInfo: { name: 'dsh_codex_bridge', title: 'DSH Codex Bridge', version: VERSION },
        });
        send({ method: 'initialized', params: {} });
        const started = threadId
          ? await request('thread/resume', { threadId, cwd, approvalPolicy: 'never', sandbox: 'workspace-write' })
          : await request('thread/start', {
              cwd,
              approvalPolicy: 'never',
              sandbox: 'workspace-write',
              serviceName: 'dsh_codex_bridge',
            });
        threadId = started.thread.id;
        await request('thread/name/set', { threadId, name: `DSH collaboration: ${message.taskId}` });
        await request('turn/start', {
          threadId,
          input: [{ type: 'text', text: appServerPrompt(message) }],
        });
        const turn = await completed;
        if (turn.status !== 'completed') throw new Error(`Codex turn ended with ${turn.status}`);
      })(),
      timeout,
    ]);
    return { threadId, answer: answer.trim() || '(Codex returned no text)' };
  } catch (error) {
    throw new Error(`${error.message}${stderr.trim() ? `\n${stderr.trim()}` : ''}`);
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
    lines.close();
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2).replaceAll('-', '_');
    if (['mark_read', 'all'].includes(name)) options[name] = true;
    else {
      if (rest[index + 1] === undefined) throw new Error(`Missing value for ${token}`);
      options[name] = rest[++index];
    }
  }
  return { command, options };
}

function dshMessageInput(options) {
  return {
    rootTaskId: options.root_task_id,
    taskId: options.task_id,
    parentTaskId: options.parent_task_id,
    sender: 'dsh',
    recipient: 'codex',
    kind: options.kind,
    body: options.body,
    progress: options.progress,
    evidence: options.evidence,
    workspace: options.workspace,
    replyTo: options.reply_to,
  };
}

function usage() {
  return `dsh-codex-mail ${VERSION}\n\nCommands:\n  send   --task-id ID --root-task-id ID --kind KIND --body TEXT [--progress TEXT] [--evidence TEXT]\n  inbox  [--task-id ID] [--mark-read] [--all]\n  status --task-id ID\n  chat   --task-id ID --root-task-id ID --kind KIND --body TEXT [--progress TEXT] [--evidence TEXT] [--workspace DIR] [--thread-id ID]\n\nDSH messages require progress or evidence unless kind=blocker. Assigned tasks cannot be returned unchanged.`;
}

async function cliMain(argv) {
  const { command, options } = parseArgs(argv);
  if (!command || command === 'help' || command === '--help') {
    console.log(usage());
    return;
  }
  if (command === 'send') {
    console.log(JSON.stringify(await createMessage(dshMessageInput(options)), null, 2));
    return;
  }
  if (command === 'inbox') {
    const messages = await listMessages({
      recipient: 'dsh',
      taskId: options.task_id,
      unreadOnly: !options.all,
      markRead: Boolean(options.mark_read),
      limit: messageLimit(options.limit),
    });
    console.log(JSON.stringify(messages, null, 2));
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify(await readTask(idSchema.parse(options.task_id)), null, 2));
    return;
  }
  if (command === 'chat') {
    const message = await createMessage(dshMessageInput(options));
    const task = await readTask(message.taskId);
    const cwd = await validWorkspace(options.workspace || message.workspace || task.workspace);
    const result = await runCodexChat({
      threadId: options.thread_id || task.codexThreadId,
      message,
      cwd,
    });
    await updateTask(message.taskId, { codexThreadId: result.threadId });
    const reply = await createMessage({
      rootTaskId: message.rootTaskId,
      taskId: message.taskId,
      parentTaskId: message.parentTaskId,
      sender: 'codex',
      recipient: 'dsh',
      kind: 'reply',
      body: result.answer,
      workspace: cwd,
      replyTo: message.id,
    });
    console.log(JSON.stringify({ threadId: result.threadId, reply }, null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

function taskPrompt({ task, rootTaskId, taskId, parentTaskId, workspace }) {
  return `[DSH-Codex Bridge assignment]\nrootTaskId=${rootTaskId}\ntaskId=${taskId}\nparentTaskId=${parentTaskId || '(none)'}\nworkspace=${workspace}\n\nExecute this assigned subtask yourself. Do not return or re-delegate the same subtask unchanged. You may proactively contact Codex only with progress, evidence, a result, a concrete question backed by progress/evidence, or an explicit blocker. Use:\n  dsh-codex-mail send --root-task-id ${rootTaskId} --task-id ${taskId} --kind milestone --body "..." --progress "..." --evidence "..."\nOr start/continue a real Codex task with the same fields using:\n  dsh-codex-mail chat --root-task-id ${rootTaskId} --task-id ${taskId} --kind question --body "..." --progress "..." --evidence "..." --workspace ${JSON.stringify(workspace)}\nRead Codex mailbox replies with:\n  dsh-codex-mail inbox --task-id ${taskId} --mark-read\n\nAssigned subtask:\n${task}`;
}

const server = new McpServer({ name: 'deepseek-harness-bridge', version: VERSION });

server.registerTool(
  'delegate_to_deepseek',
  {
    title: 'Delegate to DeepSeek Harness',
    description: 'Delegate a bounded auxiliary subtask to DeepSeek Harness. Codex remains the lead and DSH must execute its assigned subtask rather than return it unchanged. DSH may send evidence-backed progress or proactively start a Codex task. Codex reports the delegation afterward.',
    inputSchema: {
      task: z.string().trim().min(1).max(16_000),
      workspace: z.string().trim().min(1).optional(),
      rootTaskId: idSchema.optional(),
      taskId: idSchema.optional(),
      parentTaskId: idSchema.optional(),
    },
    annotations: { openWorldHint: true },
  },
  async ({ task, workspace, rootTaskId, taskId, parentTaskId }, { signal }) => {
    let cwd;
    try {
      cwd = await validWorkspace(workspace);
      taskId ||= randomUUID();
      rootTaskId ||= taskId;
      const now = new Date().toISOString();
      const record = {
        rootTaskId,
        taskId,
        parentTaskId: parentTaskId || null,
        owner: 'dsh',
        status: 'assigned',
        objective: task,
        workspace: cwd,
        createdAt: now,
        updatedAt: now,
        codexThreadId: null,
      };
      await mkdir(tasksDir, { recursive: true, mode: 0o700 });
      await writeFile(recordPath(tasksDir, taskId), `${JSON.stringify(record, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      await updateTask(taskId, { status: 'running' });
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }

    try {
      const prompt = taskPrompt({ task, rootTaskId, taskId, parentTaskId, workspace: cwd });
      const { stdout, stderr } = await runDsh(prompt, { cwd, signal });
      await updateTask(taskId, { status: 'completed', completedAt: new Date().toISOString() });
      const answer = stdout.trim() || stderr.trim() || '(DeepSeek Harness returned no text)';
      return {
        content: [{ type: 'text', text: `rootTaskId=${rootTaskId}\ntaskId=${taskId}\n\n${answer}` }],
      };
    } catch (error) {
      await updateTask(taskId, { status: 'failed', error: error.message }).catch(() => {});
      const detail = [error.message, error.stdout, error.stderr].filter(Boolean).join('\n').trim();
      return {
        isError: true,
        content: [{ type: 'text', text: `DeepSeek Harness failed (taskId=${taskId}):\n${detail}` }],
      };
    }
  },
);

server.registerTool(
  'list_deepseek_messages',
  {
    title: 'List DeepSeek messages',
    description: 'List progress, evidence, results, questions, or blockers sent by DSH to Codex.',
    inputSchema: {
      taskId: idSchema.optional(),
      unreadOnly: z.boolean().default(true),
      markRead: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(20),
    },
  },
  async ({ taskId, unreadOnly, markRead, limit }) => ({
    content: [{
      type: 'text',
      text: JSON.stringify(
        await listMessages({ recipient: 'codex', taskId, unreadOnly, markRead, limit }),
        null,
        2,
      ),
    }],
  }),
);

server.registerTool(
  'reply_to_deepseek',
  {
    title: 'Reply to DeepSeek',
    description: 'Reply through the persistent mailbox to a message previously sent by DSH.',
    inputSchema: {
      messageId: z.string().uuid(),
      body: z.string().trim().min(1).max(100_000),
    },
  },
  async ({ messageId, body }) => {
    try {
      const original = await readJson(recordPath(messagesDir, messageId));
      if (original.sender !== 'dsh' || original.recipient !== 'codex') {
        throw new Error('messageId is not a DSH-to-Codex message');
      }
      const reply = await createMessage({
        rootTaskId: original.rootTaskId,
        taskId: original.taskId,
        parentTaskId: original.parentTaskId,
        sender: 'codex',
        recipient: 'dsh',
        kind: 'reply',
        body,
        workspace: original.workspace,
        replyTo: original.id,
      });
      return { content: [{ type: 'text', text: JSON.stringify(reply, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  },
);

server.registerTool(
  'get_bridge_task_status',
  {
    title: 'Get bridge task status',
    description: 'Read ownership, state, workspace, and Codex thread linkage for a delegated task.',
    inputSchema: { taskId: idSchema },
  },
  async ({ taskId }) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await readTask(taskId), null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  },
);

if (process.argv.length > 2) {
  try {
    await cliMain(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const closeServer = transport.onclose;
  transport.onclose = () => {
    stopActiveDshChildren();
    closeServer?.();
  };
}
