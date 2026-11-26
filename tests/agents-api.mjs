import assert from 'node:assert/strict';
import { createApi } from '../src/api.mjs';

const id = '00000000-0000-4000-8000-000000000001';
const thread = { id, agentNickname: '子任务', status: { type: 'active' }, model: 'test-model' };
const turn = { id: 'turn', status: 'inProgress', items: [{ type: 'agentMessage', id: 'message', text: '正在核对' }] };
const calls = [];
let metadataError = null;
let historyError = null;
let turns = [turn];
const bridge = { async request(method, params) {
  calls.push({ method, params });
  if (method === 'thread/read') {
    if (metadataError) throw metadataError;
    return { thread };
  }
  if (method === 'thread/turns/list') {
    if (historyError) throw historyError;
    return { data: turns, nextCursor: 'older' };
  }
  if (method === 'thread/items/list') return { data: [...turn.items].reverse(), nextCursor: null };
  throw new Error('未预期请求：' + method);
} };
const handleApi = createApi({ bridge, workspace: process.cwd(), token: '', approvalRelay: { count: 0 } });

async function activity() {
  const response = {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  await handleApi({ method: 'GET', headers: {} }, response,
    new URL(`http://localhost/api/threads/${id}/agent-activity`));
  return response;
}

const current = await activity();
assert.equal(current.status, 200);
assert.deepEqual(current.body, { thread, turn: { ...turn, itemsCursor: null, itemsStartId: 'message', itemsView: 'full', itemsDeferred: false }, activityError: null });
assert.deepEqual(calls, [
  { method: 'thread/read', params: { threadId: id, includeTurns: false } },
  { method: 'thread/turns/list', params: { threadId: id, limit: 1, cursor: null, itemsView: 'summary', sortDirection: 'desc' } },
  { method: 'thread/items/list', params: { threadId: id, turnId: 'turn', cursor: null, limit: 100, sortDirection: 'desc' } },
]);

turns = [];
assert.deepEqual((await activity()).body, { thread, turn: null, activityError: null });
historyError = new Error('Thread is not materialized yet; thread/turns/list is unavailable before first user message');
assert.deepEqual((await activity()).body, { thread, turn: null, activityError: null });

historyError = new Error('历史读取超时');
const failedHistory = await activity();
assert.equal(failedHistory.status, 200);
assert.deepEqual(failedHistory.body, { thread, turn: null, activityError: '读取子任务活动失败：历史读取超时' });

metadataError = new Error('子任务不存在');
await assert.rejects(activity(), (error) => error === metadataError);
historyError = null;
await assert.rejects(activity(), (error) => error === metadataError);
console.log('子任务活动读取、空历史与失败隔离校验通过');
