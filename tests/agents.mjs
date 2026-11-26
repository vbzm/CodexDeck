import assert from 'node:assert/strict';
import { collectAgents, agentView } from '../public/js/agents.js';

const modern = { type: 'subAgentActivity', id: 'start', kind: 'started', agentThreadId: 'child-a',
  agentPath: '/root/check_ui', model: 'test-model', reasoningEffort: 'high', startedAtMs: 1000, completedAtMs: 1000 };
const legacy = { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', status: 'completed',
  receiverThreadIds: ['child-b'], prompt: '检查接口并报告结果', agentsStates: { 'child-b': { status: 'running', message: null } } };
const first = { id: 'turn-1', startedAt: 1, items: [modern, legacy] };
const records = collectAgents([first]);
assert.equal(records.size, 2);
const a = records.get('child-a');
const b = records.get('child-b');
assert.equal(agentView(a).status, 'running', 'started 的 completedAtMs 不是任务完成时间');
assert.equal(agentView(b).status, 'running', '派发动作 completed 不代表子任务完成');
assert.equal(agentView(b).task, legacy.prompt);

const snapshot = { signature: a.signature, thread: { agentNickname: '界面检查', status: { type: 'active' },
  model: 'actual-model', reasoningEffort: 'xhigh' }, turn: { status: 'inProgress', items: [
    { type: 'userMessage', content: [{ type: 'text', text: '检查手机界面' }] },
    { type: 'agentMessage', text: '已读完界面，开始检查' },
    { type: 'commandExecution', command: 'node check.mjs' },
  ] } };
let view = agentView(a, snapshot);
assert.equal(view.name, 'check_ui');
assert.equal(view.nickname, '界面检查');
assert.equal(view.task, '检查手机界面');
assert.equal(view.model, 'actual-model');
assert.match(view.progress, /node check.mjs/, '新工具活动应取代更早的进度文字');
snapshot.turn.items.push({ type: 'dynamicToolCall', namespace: 'test', tool: 'inspect' });
assert.equal(agentView(a, snapshot).progress, '调用工具：test · inspect');
assert.equal(view.needsRefresh, true);

snapshot.thread.status.activeFlags = ['waitingOnApproval'];
assert.equal(agentView(a, snapshot).label, '等待审批');
snapshot.thread.status = { type: 'idle' };
snapshot.turn = { status: 'completed', items: [{ type: 'agentMessage', text: '全部检查通过' }] };
view = agentView(a, snapshot);
assert.equal(view.status, 'completed');
assert.equal(view.progress, '全部检查通过');
assert.equal(view.needsRefresh, false);
snapshot.activityError = '读取最新回合失败';
assert.equal(agentView(a, snapshot).needsRefresh, true, '部分读取失败仍要自动重试');
delete snapshot.activityError;
snapshot.turn.status = 'interrupted';
assert.equal(agentView(a, snapshot).status, 'interrupted');
snapshot.turn.status = 'failed';
assert.equal(agentView(a, snapshot).status, 'failed');
snapshot.turn = null;
assert.equal(agentView(a, snapshot).status, 'idle');
assert.equal(agentView(a, snapshot).needsRefresh, true, '待命的子任务可能尚未开始首回合');
snapshot.turn = { status: 'completed', items: [] };
assert.equal(agentView({ ...a, status: 'shutdown' }, snapshot).status, 'shutdown', '关闭事件不能被旧完成回合覆盖');
assert.equal(agentView({ ...a, status: 'interrupted' }, snapshot).status, 'interrupted', '中断事件不能被旧完成回合覆盖');
snapshot.thread.status = { type: 'active' };
assert.equal(agentView({ ...a, status: 'shutdown' }, snapshot).status, 'running', '明确恢复运行应覆盖旧终态');

const followup = { id: 'turn-2', startedAt: 2, items: [
  { ...modern, id: 'finish', kind: 'completed' },
  { ...modern, id: 'followup', kind: 'interacted', model: null, reasoningEffort: null },
  { ...legacy, id: 'input', tool: 'sendInput', prompt: '继续验证边界', agentsStates: { 'child-b': { status: 'running' } } },
] };
const updated = collectAgents([followup, first]);
const newA = updated.get('child-a');
assert.equal(newA.status, 'completed', '普通跟进事件不能凭空推断任务正在运行');
assert.equal(newA.model, 'test-model', 'null 字段不能擦掉已知模型');
assert.deepEqual(newA.events.map((event) => event.operation), ['派发任务', '任务完成', '跟进任务']);
assert.equal(updated.get('child-b').prompt, legacy.prompt, '首条任务与后续跟进应保留各自内容');
assert.equal(updated.get('child-b').events.at(-1).prompt, '继续验证边界');
assert.equal(agentView(newA, snapshot).needsRefresh, true, '新事件必须重新读取，不能复用旧快照');

const failure = collectAgents([{ id: 'failed-turn', items: [{ ...legacy, id: 'failure', status: 'failed',
  receiverThreadIds: [], agentsStates: {} }] }]).values().next().value;
assert.equal(agentView(failure).status, 'failed', '未获得子聊天 ID 的派发失败也要显示');
assert.equal(agentView(failure).needsRefresh, false, '不能为未创建的子任务发送无效读取请求');
assert.equal(failure.events[0].failed, true);
console.log('子 agent 新旧记录、当前状态、跟进版本与派发失败校验通过');
