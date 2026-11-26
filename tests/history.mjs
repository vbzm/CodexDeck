import assert from 'node:assert/strict';
import { readItemPage, readTurnPage } from '../src/history.mjs';

const calls = [];
const wrapped = { async request(method, params) {
  calls.push({ method, params });
  return { data: [
    { turnId: 'turn', item: { id: 'last', type: 'agentMessage', startedAtMs: 1 }, startedAtMs: 300, completedAtMs: 350 },
    { turnId: 'foreign', item: { id: 'wrong' } },
    { turnId: 'turn', item: { id: 'first', type: 'commandExecution' }, startedAtMs: 100, completedAtMs: 0 },
  ], nextCursor: 'older-items' };
} };
assert.deepEqual(await readItemPage(wrapped, { threadId: 'thread', turnId: 'turn' }), {
  items: [{ id: 'first', type: 'commandExecution', startedAtMs: 100, completedAtMs: 0 },
    { id: 'last', type: 'agentMessage', startedAtMs: 300, completedAtMs: 350 }], nextCursor: 'older-items',
});
assert.deepEqual(calls[0], { method: 'thread/items/list', params: {
  threadId: 'thread', turnId: 'turn', cursor: null, limit: 100, sortDirection: 'desc',
} });

const legacy = { async request(_method, params) {
  assert.equal(params.cursor, 'older-items');
  return { data: [{ id: 'second', type: 'reasoning', startedAtMs: 200 }, { id: 'first', type: 'userMessage' }] };
} };
assert.deepEqual(await readItemPage(legacy, { threadId: 'thread', turnId: 'turn', cursor: 'older-items' }), {
  items: [{ id: 'first', type: 'userMessage' }, { id: 'second', type: 'reasoning', startedAtMs: 200 }], nextCursor: null,
});
await assert.rejects(readItemPage({ request: async () => ({ data: [], nextCursor: 'same' }) },
  { threadId: 'thread', turnId: 'turn', cursor: 'same' }), /分页游标未向前推进/);

const limits = [];
const oversize = { async request(_method, params) {
  limits.push(params.limit);
  if (params.limit > 12) throw new Error('decoded message length too large');
  return { data: [{ id: 'small', type: 'agentMessage' }], nextCursor: null };
} };
assert.equal((await readItemPage(oversize, { threadId: 'thread', turnId: 'turn' })).items[0].id, 'small');
assert.deepEqual(limits, [100, 50, 25, 12]);
const terminalLimits = [];
await assert.rejects(readItemPage({ async request(_method, params) {
  terminalLimits.push(params.limit);
  throw new Error('decoded message length too large');
} }, { threadId: 'thread', turnId: 'huge' }), /单条过程内容过大/);
assert.deepEqual(terminalLimits, [100, 50, 25, 12, 6, 3, 1]);
const disconnected = new Error('Desktop 连接中断');
await assert.rejects(readItemPage({ request: async () => { throw disconnected; } },
  { threadId: 'thread', turnId: 'turn' }), (error) => error === disconnected);

const opening = { id: 'opening', type: 'userMessage', startedAtMs: 10, content: [] };
const final = { id: 'final', type: 'agentMessage', phase: 'final_answer', text: '摘要中的旧回复', startedAtMs: 500 };
const turnCalls = [];
const summary = { data: [
  { id: 'partial', status: 'completed', items: [opening, final], itemsView: 'summary' },
  { id: 'complete', status: 'completed', items: [opening, final], itemsView: 'summary' },
  { id: 'broken', status: 'completed', items: [opening, final], itemsView: 'summary' },
], nextCursor: 'older-turns', backwardsCursor: 'newer-turns' };
const summaryBefore = structuredClone(summary);
const historyBridge = { async request(method, params) {
  turnCalls.push({ method, params });
  if (method === 'thread/turns/list') return summary;
  if (params.turnId === 'broken') throw new Error('工具记录暂时不可用');
  if (params.turnId === 'complete') return { data: [{ item: { id: 'only', type: 'agentMessage' }, turnId: 'complete' }], nextCursor: null };
  return { data: [
    { item: { ...final, text: '条目页里的最新回复' }, turnId: 'partial' },
    { item: { id: 'middle', type: 'commandExecution', startedAtMs: 100 }, turnId: 'partial' },
  ], nextCursor: 'older-process' };
} };
const page = await readTurnPage(historyBridge, { threadId: 'thread', limit: 3, cursor: 'page-cursor' });
assert.deepEqual(turnCalls[0], { method: 'thread/turns/list', params: {
  threadId: 'thread', limit: 3, cursor: 'page-cursor', itemsView: 'summary', sortDirection: 'desc',
} });
assert.equal(page.nextCursor, 'older-turns');
assert.equal(page.backwardsCursor, 'newer-turns');
assert.deepEqual(page.data[0].items.map((item) => item.id), ['opening', 'middle', 'final']);
assert.equal(page.data[0].items[2].text, '条目页里的最新回复');
assert.equal(page.data[0].itemsCursor, 'older-process');
assert.equal(page.data[0].itemsStartId, 'middle');
assert.equal(page.data[0].itemsView, 'summary');
assert.deepEqual(page.data[1].items, [{ id: 'only', type: 'agentMessage' }]);
assert.equal(page.data[1].itemsView, 'full');
assert.equal(page.data[1].itemsCursor, null);
assert.equal(page.data[1].itemsStartId, 'only');
assert.deepEqual(page.data[2].items, [opening, final]);
assert.equal(page.data[2].itemsView, 'summary');
assert.equal(page.data[2].itemsCursor, null);
assert.equal(page.data[2].itemsStartId, null);
assert.match(page.data[2].itemsError, /读取回合过程失败：工具记录暂时不可用/);
assert.deepEqual(summary, summaryBefore);

// 摘要直接返回，首屏不请求可能很慢或失败的工具过程。
const summaryCalls = [];
const fastPage = await readTurnPage({ async request(method, params) {
  summaryCalls.push({ method, params });
  assert.equal(method, 'thread/turns/list');
  return summary;
} }, { threadId: 'thread', limit: 3, cursor: 'page-cursor', itemsView: 'summary' });
assert.equal(summaryCalls.length, 1);
assert.deepEqual(summaryCalls[0], turnCalls[0]);
assert.deepEqual(fastPage, { ...summary, data: summary.data.map((turn) => ({
  ...turn, itemsView: 'summary', itemsDeferred: true, itemsCursor: null, itemsStartId: null,
})) });
assert.deepEqual(summary, summaryBefore);
assert.ok(page.data.every((turn) => turn.itemsDeferred === false));

// 未标时间的首句、最终回复仍留在过程两端；同一时间的不同条目不能互相覆盖。
const untimed = await readTurnPage({ async request(method) {
  return method === 'thread/turns/list' ? { data: [{ id: 'turn', items: [
    { id: 'u', type: 'userMessage' }, { id: 'a', type: 'agentMessage', text: '最终回复' },
  ] }] } : { data: [{ id: 'c2', type: 'reasoning', startedAtMs: 100 },
    { id: 'c1', type: 'commandExecution', startedAtMs: 100 }], nextCursor: 'older' };
} }, { threadId: 'thread', limit: 1 });
assert.deepEqual(untimed.data[0].items.map((item) => item.id), ['u', 'c1', 'c2', 'a']);

// 四个 worker 并行处理，但结果继续采用原始回合顺序。
let active = 0;
let peak = 0;
const releases = [];
const concurrentBridge = { async request(method, params) {
  if (method === 'thread/turns/list') return { data: Array.from({ length: 7 }, (_, index) => ({ id: String(index), items: [] })) };
  active++;
  peak = Math.max(peak, active);
  await new Promise((resolve) => releases.push(resolve));
  active--;
  return { data: [{ id: params.turnId, type: 'agentMessage' }], nextCursor: null };
} };
const concurrentPage = readTurnPage(concurrentBridge, { threadId: 'thread', limit: 7 });
await new Promise(setImmediate);
assert.equal(active, 4);
for (let batch = 0; batch < 2; batch++) {
  releases.splice(0).forEach((resolve) => resolve());
  await new Promise(setImmediate);
}
assert.equal(peak, 4);
assert.deepEqual((await concurrentPage).data.map((turn) => turn.id), ['0', '1', '2', '3', '4', '5', '6']);

let emptyCalls = 0;
assert.deepEqual(await readTurnPage({ async request() { emptyCalls++; return { data: [], nextCursor: null }; } },
  { threadId: 'thread', limit: 5 }), { data: [], nextCursor: null });
assert.equal(emptyCalls, 1);
await assert.rejects(readTurnPage({ request: async () => { throw disconnected; } },
  { threadId: 'thread', limit: 5 }), (error) => error === disconnected);

console.log('首屏摘要直返、过程分页、内容过大重试、局部失败隔离与并发上限校验通过');
