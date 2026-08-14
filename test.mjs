import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const mailbox = await mkdtemp(join(tmpdir(), 'dsh-codex-bridge-'));
const fakeCodex = join(mailbox, 'fake-codex.mjs');
const slowDsh = join(mailbox, 'slow-dsh.mjs');
const slowDshPid = join(mailbox, 'slow-dsh.pid');

async function waitUntil(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((accept) => setTimeout(accept, 20));
  }
  throw new Error('condition timed out');
}

await writeFile(fakeCodex, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
  if (request.method === 'initialize') reply({ userAgent: 'fake' });
  if (request.method === 'thread/start') reply({ thread: { id: 'thread-from-dsh' } });
  if (request.method === 'thread/resume') reply({ thread: { id: request.params.threadId } });
  if (request.method === 'thread/name/set') reply({});
  if (request.method === 'turn/start') {
    reply({ turn: { id: 'turn-1', status: 'inProgress', items: [] } });
    process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'CODEX_REPLY' } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed', items: [] } } }) + '\\n');
  }
}
`);
await chmod(fakeCodex, 0o755);
await writeFile(slowDsh, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.SLOW_DSH_PID, String(process.pid));
setInterval(() => {}, 1000);
`);
await chmod(slowDsh, 0o755);

const env = {
  ...process.env,
  CODEX_BIN: fakeCodex,
  DSH_BIN: '/bin/echo',
  DSH_CODEX_MAILBOX_DIR: mailbox,
};
const client = new Client({ name: 'bridge-test', version: '0.2.2' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [`${here}/server.mjs`],
  cwd: here,
  env,
});

await client.connect(transport);
try {
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(({ name }) => name), [
    'delegate_to_deepseek',
    'list_deepseek_messages',
    'reply_to_deepseek',
    'get_bridge_task_status',
  ]);

  const delegated = await client.callTool({
    name: 'delegate_to_deepseek',
    arguments: {
      task: 'Inspect the parser and report evidence',
      workspace: here,
      rootTaskId: 'root-1',
      taskId: 'task-1',
    },
  });
  assert.equal(delegated.isError, undefined);
  assert.match(delegated.content[0].text, /taskId=task-1/);
  assert.match(delegated.content[0].text, /Do not return or re-delegate/);

  const status = await client.callTool({
    name: 'get_bridge_task_status',
    arguments: { taskId: 'task-1' },
  });
  assert.equal(JSON.parse(status.content[0].text).status, 'completed');

  await assert.rejects(
    run(process.execPath, [
      `${here}/server.mjs`, 'send', '--root-task-id', 'root-1', '--task-id', 'task-1',
      '--kind', 'question', '--body', 'What next?',
    ], { env }),
    /progress or evidence/,
  );
  await assert.rejects(
    run(process.execPath, [
      `${here}/server.mjs`, 'send', '--root-task-id', 'root-1', '--task-id', 'task-1',
      '--kind', 'milestone', '--body', 'Inspect the parser and report evidence', '--progress', 'started',
    ], { env }),
    /must not return the assigned subtask unchanged/,
  );

  const sent = await run(process.execPath, [
    `${here}/server.mjs`, 'send', '--root-task-id', 'root-1', '--task-id', 'task-1',
    '--kind', 'milestone', '--body', 'Parser inspection completed', '--progress', '100%',
    '--evidence', 'test fixture passed',
  ], { env });
  const messageId = JSON.parse(sent.stdout).id;

  const listed = await client.callTool({
    name: 'list_deepseek_messages',
    arguments: { taskId: 'task-1', markRead: true },
  });
  assert.equal(JSON.parse(listed.content[0].text)[0].id, messageId);
  const nowEmpty = await client.callTool({
    name: 'list_deepseek_messages',
    arguments: { taskId: 'task-1' },
  });
  assert.deepEqual(JSON.parse(nowEmpty.content[0].text), []);

  const replied = await client.callTool({
    name: 'reply_to_deepseek',
    arguments: { messageId, body: 'Accepted; continue with the edge case.' },
  });
  assert.equal(JSON.parse(replied.content[0].text).recipient, 'dsh');
  const inbox = await run(process.execPath, [
    `${here}/server.mjs`, 'inbox', '--task-id', 'task-1', '--mark-read',
  ], { env });
  assert.match(inbox.stdout, /Accepted; continue/);

  const chat = await run(process.execPath, [
    `${here}/server.mjs`, 'chat', '--root-task-id', 'root-1', '--task-id', 'task-1',
    '--kind', 'question', '--body', 'Should I keep the current parser?', '--progress', 'All cases inspected',
    '--evidence', 'fixture passed', '--workspace', here,
  ], { env });
  const chatResult = JSON.parse(chat.stdout);
  assert.equal(chatResult.threadId, 'thread-from-dsh');
  assert.equal(chatResult.reply.body, 'CODEX_REPLY');

  const resumed = await run(process.execPath, [
    `${here}/server.mjs`, 'chat', '--root-task-id', 'root-1', '--task-id', 'task-1',
    '--kind', 'milestone', '--body', 'Continue the existing Codex chat', '--progress', 'First turn done',
    '--workspace', here,
  ], { env });
  assert.equal(JSON.parse(resumed.stdout).threadId, 'thread-from-dsh');

  const linked = await client.callTool({
    name: 'get_bridge_task_status',
    arguments: { taskId: 'task-1' },
  });
  const linkedTask = JSON.parse(linked.content[0].text);
  assert.equal(linkedTask.codexThreadId, 'thread-from-dsh');
  assert.equal(linkedTask.status, 'completed');
} finally {
  await client.close();
}

const cleanupClient = new Client({ name: 'bridge-cleanup-test', version: '0.2.2' });
const cleanupTransport = new StdioClientTransport({
  command: process.execPath,
  args: [`${here}/server.mjs`],
  cwd: here,
  env: { ...env, DSH_BIN: slowDsh, SLOW_DSH_PID: slowDshPid },
});
await cleanupClient.connect(cleanupTransport);
const abandonedCall = cleanupClient.callTool({
  name: 'delegate_to_deepseek',
  arguments: {
    task: 'Wait until the MCP client disconnects',
    workspace: here,
    rootTaskId: 'root-cleanup',
    taskId: 'task-cleanup',
  },
}, undefined, { timeout: 5000 }).catch((error) => error);
await waitUntil(async () => readFile(slowDshPid, 'utf8').then(() => true, () => false));
const abandonedPid = Number.parseInt(await readFile(slowDshPid, 'utf8'), 10);
await cleanupClient.close();
await abandonedCall;
await waitUntil(() => {
  try {
    process.kill(abandonedPid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
});

await rm(mailbox, { recursive: true, force: true });

console.log('bridge protocol, mailbox, loop guard, proactive chat, and child cleanup tests: ok');
