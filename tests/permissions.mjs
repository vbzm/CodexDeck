import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApi } from '../src/api.mjs';

const threadId = '00000000-0000-4000-8000-000000000001';
const calls = [];
const bridge = {
  async request(method, params) {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: threadId } };
    if (method === 'turn/start') return { turn: { id: 'test-turn' } };
    if (method === 'thread/resume') return {
      approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' },
    };
    throw new Error('未预期的 Desktop 请求：' + method);
  },
};
const handleApi = createApi({ bridge, workspace: process.cwd(), token: '', approvalRelay: { count: 0 } });

async function request(method, pathname, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  stream.headers = body === undefined ? {} : { 'content-type': 'application/json' };
  const response = {
    writeHead(status) { this.status = status; },
    end(content) { this.body = JSON.parse(content); },
  };
  await handleApi(stream, response, new URL('http://localhost' + pathname));
  return response;
}

for (const [mode, approvalPolicy, approvalsReviewer, sandbox, sandboxType] of [
  ['request', 'on-request', 'user', 'workspace-write', 'workspaceWrite'],
  ['auto', 'on-request', 'auto_review', 'workspace-write', 'workspaceWrite'],
  ['full', 'never', 'user', 'danger-full-access', 'dangerFullAccess'],
]) {
  calls.length = 0;
  const created = await request('POST', '/api/threads', { cwd: process.cwd(), text: '测试', permissionMode: mode });
  assert.equal(created.status, 201);
  assert.deepEqual(calls.map((call) => call.method), ['thread/start', 'turn/start']);
  assert.equal(calls[0].params.sandbox, sandbox);
  assert.equal(calls[0].params.approvalPolicy, approvalPolicy);
  assert.equal(calls[0].params.approvalsReviewer, approvalsReviewer);
  assert.deepEqual(calls[1].params.sandboxPolicy, { type: sandboxType });
  assert.equal(calls[1].params.approvalPolicy, approvalPolicy);
  assert.equal(calls[1].params.approvalsReviewer, approvalsReviewer);

  calls.length = 0;
  await request('POST', '/api/threads/' + threadId + '/turns', { text: '继续', permissionMode: mode });
  assert.deepEqual(calls[0].params.sandboxPolicy, { type: sandboxType });
  assert.equal(calls[0].params.approvalPolicy, approvalPolicy);
}

calls.length = 0;
await assert.rejects(request('POST', '/api/threads', { cwd: process.cwd() }),
  (error) => error.status === 400);
assert.equal(calls.length, 0, '缺少首条消息时不能创建空聊天');
await request('POST', '/api/threads', { cwd: process.cwd(), text: '测试' });
assert.equal(calls[0].params.sandbox, 'workspace-write', '新聊天默认可写工作目录');

calls.length = 0;
await request('POST', '/api/threads/' + threadId + '/turns', { text: '沿用原权限' });
assert.equal(Object.hasOwn(calls[0].params, 'sandboxPolicy'), false, '旧客户端未选择权限时应沿用聊天设置');

const current = await request('GET', '/api/threads/' + threadId + '/permissions');
assert.equal(current.status, 200);
assert.equal(current.body.sandbox.type, 'workspaceWrite');

await assert.rejects(request('POST', '/api/threads/' + threadId + '/turns', {
  text: '无效权限', permissionMode: 'invalid',
}), (error) => error.status === 400 && error.message === '权限设置无效');
await assert.rejects(request('POST', '/api/threads', {
  cwd: process.cwd(), text: '测试', permissionMode: null,
}), (error) => error.status === 400 && error.message === '权限设置无效');

console.log('新旧聊天的权限传递与校验通过');
