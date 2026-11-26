import assert from 'node:assert/strict';
import { createApi } from '../src/api.mjs';

const calls = [];
const bridge = {
  request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/items/list') return { data: [{ id: params.turnId + '-item', type: 'agentMessage' }], nextCursor: null };
    return { data: Array.from({ length: params.limit }, (_, index) => ({ id: String(index) })), nextCursor: 'older' };
  },
};
const handleApi = createApi({ bridge, workspace: process.cwd(), token: '', approvalRelay: { count: 0 } });
const id = '00000000-0000-4000-8000-000000000001';

async function page(query) {
  const response = {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  await handleApi({ method: 'GET', headers: {} }, response,
    new URL(`http://localhost/api/threads/${id}/turns${query}`));
  return response;
}

const capped = await page('?limit=20');
assert.equal(capped.status, 200);
assert.equal(capped.body.turns.length, 5);
assert.equal(capped.body.nextCursor, 'older');
assert.deepEqual(calls[0], { method: 'thread/turns/list', params: { threadId: id, limit: 5, cursor: null, itemsView: 'summary', sortDirection: 'desc' } });

const latest = await page('?limit=1&cursor=next');
assert.equal(latest.body.turns.length, 1);
assert.deepEqual(calls.filter((call) => call.method === 'thread/turns/list')[1].params,
  { threadId: id, limit: 1, itemsView: 'summary', cursor: 'next', sortDirection: 'desc' });

const beforeSummary = calls.length;
const summary = await page('?limit=5&cursor=summary-next&itemsView=summary');
assert.equal(summary.status, 200);
assert.equal(summary.body.turns.length, 5);
assert.equal(summary.body.nextCursor, 'older');
assert.deepEqual(calls.slice(beforeSummary), [{ method: 'thread/turns/list', params: {
  threadId: id, limit: 5, cursor: 'summary-next', itemsView: 'summary', sortDirection: 'desc',
} }]);
assert.ok(summary.body.turns.every((turn) => turn.itemsDeferred === true &&
  turn.itemsView === 'summary' && turn.itemsCursor === null && turn.itemsStartId === null));

// 未选择摘要的请求继续读取条目，兼容轮询和原有调用方。
const beforeFull = calls.length;
await page('?limit=1&itemsView=full');
assert.deepEqual(calls.slice(beforeFull).map((call) => call.method), ['thread/turns/list', 'thread/items/list']);

const itemResponse = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
await handleApi({ method: 'GET', headers: {} }, itemResponse,
  new URL(`http://localhost/api/threads/${id}/turns/${id}/items?cursor=older-process`));
assert.equal(itemResponse.status, 200);
assert.deepEqual(itemResponse.body.items.map((item) => item.id), [id + '-item']);
assert.deepEqual(calls.at(-1).params, { threadId: id, turnId: id, cursor: 'older-process', limit: 100, sortDirection: 'desc' });
console.log('长会话分页上限、摘要直返与游标校验通过');
