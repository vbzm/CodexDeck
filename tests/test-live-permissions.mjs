import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopBridge } from '../src/desktop-bridge.mjs';

const port = process.env.CODEX_GATEWAY_PORT || '8787';
const baseUrl = 'http://127.0.0.1:' + port;
const directory = await fs.mkdtemp(path.join(process.env.CODEXDECK_TEST_PARENT || os.tmpdir(), 'codexdeck-permission-'));
const proof = path.join(directory, 'proof.txt');
const marker = randomUUID();
let threadId = null;
let turnId = null;

async function gateway(route, options = {}) {
  const response = await fetch(baseUrl + route, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '网关请求失败');
  return result;
}

try {
  const text = `只做工作目录写入验证。请使用工具在当前工作目录创建 proof.txt，文件内容严格写成 ${marker}，然后读取文件核对。不要修改其他文件。完成后只回复 CODEXDECK_WRITE_OK。`;
  let created;
  if (process.env.CODEXDECK_TEST_UPGRADE === '1') {
    const bridge = new DesktopBridge();
    try {
      const started = await bridge.request('thread/start', {
        cwd: directory, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only',
      });
      threadId = started.thread.id;
      const first = await bridge.request('turn/start', {
        threadId, input: [{ type: 'text', text: '只回复 READ_ONLY_READY，不使用工具。' }],
      });
      let firstCompleted = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const page = await bridge.request('thread/turns/list', {
          threadId, limit: 1, itemsView: 'notLoaded',
        });
        const turn = page.data?.find((item) => item.id === first.turn.id);
        if (turn?.status === 'completed') { firstCompleted = true; break; }
        if (turn?.status === 'failed') throw new Error('只读准备回合失败');
      }
      assert.ok(firstCompleted, '只读准备回合未在 2 分钟内完成');
    } finally {
      bridge.close();
    }
    const before = await gateway('/api/threads/' + threadId + '/permissions');
    assert.equal(before.sandbox?.type, 'readOnly', '测试聊天应先处于只读状态');
    const sent = await gateway('/api/threads/' + threadId + '/turns', {
      method: 'POST', body: JSON.stringify({ text, permissionMode: 'request' }),
    });
    created = { thread: { id: threadId }, turn: sent.turn };
  } else {
    created = await gateway('/api/threads', {
      method: 'POST', body: JSON.stringify({ cwd: directory, text, permissionMode: 'request' }),
    });
  }
  threadId = created.thread?.id;
  turnId = created.turn?.id;
  assert.ok(threadId && turnId, '网关未创建完整回合：' + (created.turnError || '未知错误'));
  const permission = await gateway('/api/threads/' + threadId + '/permissions');
  assert.equal(permission.sandbox?.type, 'workspaceWrite');
  assert.equal(permission.approvalPolicy, 'on-request');
  console.log('新聊天已获得工作目录写入权限：' + threadId);

  let completed = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const history = await gateway('/api/threads/' + threadId + '/turns?limit=1');
    const turn = history.turns?.find((item) => item.id === turnId);
    if (turn?.status === 'failed') throw new Error('回合失败：' + (turn.error?.message || '未知错误'));
    if (turn?.status !== 'completed') continue;
    assert.equal(await fs.readFile(proof, 'utf8'), marker, 'Agent 未正确写入工作目录');
    completed = true;
    break;
  }
  assert.ok(completed, '回合未在 2 分钟内完成');
  console.log(JSON.stringify({ passed: true, threadId, turnId, workspace: directory, proof }));
} catch (error) {
  if (threadId && turnId) {
    await gateway('/api/threads/' + threadId + '/interrupt', {
      method: 'POST', body: JSON.stringify({ turnId }),
    }).catch(() => {});
  }
  console.error('写入验证失败：' + error.message);
  console.error('测试工作目录：' + directory);
  process.exitCode = 1;
}
