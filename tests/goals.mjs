import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApi } from '../src/api.mjs';
import { createThreadState } from '../src/thread-state.mjs';
import { compactionState, compactionText } from '../public/js/activity.js';

const id = '00000000-0000-4000-8000-000000000001';
const calls = [];
let goal = { threadId: id, objective: '完成目标', status: 'active', tokensUsed: 12, tokenBudget: null,
  timeUsedSeconds: 10, createdAt: 100, updatedAt: 110 };
let turns = [{ id: 'turn', status: 'inProgress' }];
let failGoal = false;
const bridge = { async request(method, params) {
  calls.push({ method, params });
  if (method === 'thread/goal/get') return { goal };
  if (method === 'thread/goal/set') {
    if (failGoal) throw new Error('模拟设置失败');
    goal = { ...goal, ...params, updatedAt: (goal?.updatedAt || 0) + 1 };
    return { goal };
  }
  if (method === 'thread/goal/clear') { goal = null; return { cleared: true }; }
  if (['thread/start', 'thread/read', 'thread/resume'].includes(method)) {
    return { thread: { id, cwd: process.cwd(), status: { type: 'active' } } };
  }
  if (method === 'thread/turns/list') return { data: turns };
  if (method === 'thread/settings/update' || method === 'turn/interrupt') return {};
  if (method === 'model/list') return { data: [{ id: 'test-model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] };
  if (method === 'config/read') return { config: {} };
  throw new Error('未预期请求：' + method);
} };
const threadState = createThreadState(bridge);
const handleApi = createApi({ bridge, workspace: process.cwd(), token: '', approvalRelay: { count: 0 }, threadState });
async function request(method, pathname, body) {
  const input = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  input.method = method;
  input.headers = body === undefined ? {} : { 'content-type': 'application/json' };
  const response = { writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
  await handleApi(input, response, new URL('http://localhost' + pathname));
  return response;
}

const metadata = await request('GET', '/api/threads/' + id);
assert.equal(metadata.body.goal.status, 'active');
assert.equal(metadata.body.goalSupported, true);

calls.length = 0;
await request('POST', '/api/threads/' + id + '/interrupt', {});
assert.deepEqual(calls.map((call) => call.method), ['thread/goal/get', 'thread/goal/set', 'thread/turns/list', 'turn/interrupt']);
assert.equal(goal.status, 'paused', '中断回合前必须暂停目标');

calls.length = 0;
await request('POST', '/api/threads/' + id + '/goal', { status: 'active', model: 'test-model', effort: 'high', permissionMode: 'full' });
const setting = calls.find((call) => call.method === 'thread/settings/update');
assert.equal(setting.params.effort, 'high');
assert.equal(setting.params.sandboxPolicy.type, 'dangerFullAccess');
assert.ok(calls.findIndex((call) => call.method === 'thread/settings/update') < calls.findIndex((call) => call.method === 'thread/goal/set'));

calls.length = 0;
await request('POST', '/api/threads', { goal: '新目标' });
assert.deepEqual(calls.map((call) => call.method), ['thread/start', 'thread/goal/set']);
assert.equal(goal.objective, '新目标');

failGoal = true;
const failed = await request('POST', '/api/threads', { goal: '失败重试' });
assert.equal(failed.body.thread.id, id, '目标设置失败也应保留已创建聊天的 ID');
assert.equal(failed.body.turnError, '模拟设置失败');
failGoal = false;

calls.length = 0;
await assert.rejects(request('POST', '/api/threads/' + id + '/goal', { objective: '  ' }), (e) => e.status === 400);
await assert.rejects(request('POST', '/api/threads/' + id + '/goal', { status: 'complete' }), (e) => e.status === 400);
assert.equal(calls.length, 0, '参数校验失败时不能发送 Desktop 写请求');

goal = { ...goal, status: 'complete' };
threadState.onStatus({ method: 'thread/goal/updated', params: { threadId: id, goal } });
threadState.onStatus({ method: 'thread/goal/cleared', params: { threadId: id } });
goal = null;
const completed = await threadState.read(id);
assert.equal(completed.goal, null);
assert.equal(completed.completedGoal.status, 'complete', '自动清除不能吞掉完成提示');
await request('POST', '/api/threads/' + id + '/goal/clear', {});
threadState.onStatus({ method: 'thread/goal/updated', params: { threadId: id, goal: completed.completedGoal } });
assert.equal((await threadState.read(id)).completedGoal, null);

goal = { threadId: id, objective: '停止调度', status: 'active', updatedAt: 300 };
turns = [];
const stopped = await request('POST', '/api/threads/' + id + '/interrupt', {});
assert.equal(stopped.body.goal.status, 'paused', '回合间隙也必须能停止目标');
goal.status = 'active';
turns = [{ id: 'turn', status: 'inProgress' }];
failGoal = true;
calls.length = 0;
await assert.rejects(request('POST', '/api/threads/' + id + '/interrupt', {}), /当前回合已停止，但暂停目标失败/);
assert.equal(calls.at(-1).method, 'turn/interrupt', '暂停失败也应尝试停止当前回合，并说明目标仍可能继续');
failGoal = false;

let resolveRead;
const raceState = createThreadState({ request: () => new Promise((resolve) => { resolveRead = resolve; }) });
const pending = raceState.read(id);
raceState.onStatus({ method: 'thread/goal/updated', params: { threadId: id, goal: { status: 'paused' } } });
resolveRead({ goal: { status: 'active' } });
assert.equal((await pending).goal.status, 'paused', '旧读取响应不能覆盖新通知');

const unsupported = createThreadState({ request: async () => { throw Object.assign(new Error('方法不可用'), { code: -32601 }); } });
assert.equal((await unsupported.read(id)).goalSupported, false);
const unavailable = createThreadState({ request: async () => { throw new Error('连接断开'); } });
assert.match((await unavailable.read(id)).goalError, /读取目标失败/);

threadState.onStatus({ method: 'item/started', params: { threadId: id, turnId: 'turn', startedAtMs: 1000,
  item: { id: 'compact', type: 'contextCompaction', source: 'manual' } } });
let item = (await threadState.read(id)).compactions[0];
assert.equal(item.completed, false);
assert.equal(compactionState(item, 'inProgress'), 'inProgress');
assert.equal(compactionText('inProgress', 'manual', 1000, 10999), '正在压缩上下文');
assert.equal(compactionText('inProgress', 'manual', 1000, 11000), '正在压缩上下文 · 可能需要几分钟');
threadState.onStatus({ method: 'item/completed', params: { threadId: id, turnId: 'turn', item: { id: 'compact', type: 'contextCompaction' } } });
item = (await threadState.read(id)).compactions[0];
assert.equal(compactionText(compactionState(item, 'completed'), item.source), '上下文已压缩');
assert.equal(compactionText('completed', 'automatic'), '上下文已自动压缩');
assert.equal(compactionState({ type: 'contextCompaction' }, 'completed'), 'completed', '历史记录没有 completed 字段时与 Desktop 一致视为已完成');
threadState.onStatus({ method: 'item/started', params: { threadId: id, turnId: 'turn', item: { id: 'interrupted', type: 'contextCompaction' } } });
threadState.onStatus({ method: 'turn/completed', params: { threadId: id, turn: { id: 'turn', status: 'interrupted' } } });
item = (await threadState.read(id)).compactions.find((item) => item.id === 'interrupted');
assert.equal(compactionText(compactionState(item, 'interrupted')), '压缩已中断');
threadState.onDisconnect();
assert.equal((await threadState.read(id)).compactions.some((item) => item.completed === false), false);
console.log('目标同步、完成快照、停止顺序、设置参数与上下文压缩状态校验通过');
