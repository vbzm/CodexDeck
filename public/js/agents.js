import { itemText, itemTimestamp, renderItemTime } from './activity.js';

export const isAgentItem = (item) => ['subAgentActivity', 'collabAgentToolCall'].includes(item.type);
const operations = { started: '派发任务', interacted: '跟进任务', completed: '任务完成', interrupted: '中断任务',
  spawnAgent: '派发任务', sendInput: '跟进任务', resumeAgent: '恢复任务', wait: '等待结果', closeAgent: '关闭子 agent' };
const statuses = { pending: '准备中', running: '工作中', waiting: '等待审批', completed: '已完成',
  interrupted: '已中断', shutdown: '已关闭', failed: '出错', idle: '待命', unknown: '状态待同步' };
const terminal = new Set(['completed', 'interrupted', 'shutdown', 'failed']);

function eventState(item, id) {
  if (item.type === 'subAgentActivity') {
    return ({ started: 'running', completed: 'completed', interrupted: 'interrupted' })[item.kind];
  }
  const status = item.agentsStates?.[id]?.status;
  return ({ pendingInit: 'pending', running: 'running', completed: 'completed', interrupted: 'interrupted',
    shutdown: 'shutdown', errored: 'failed', notFound: 'failed' })[status];
}

export function collectAgents(turns) {
  const records = new Map();
  for (const turn of [...turns].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))) {
    for (const item of turn.items || []) {
      if (!isAgentItem(item)) continue;
      const ids = item.type === 'subAgentActivity' ? [item.agentThreadId] :
        [...new Set([...(item.receiverThreadIds || []), ...Object.keys(item.agentsStates || {})])];
      if (!ids.filter(Boolean).length) ids.push(null);
      for (const threadId of ids) {
        const id = threadId || 'dispatch:' + turn.id + ':' + item.id;
        let record = records.get(id);
        if (!record) {
          record = { id, threadId, events: [], status: 'unknown', prompt: '', model: null, effort: null, path: '' };
          records.set(id, record);
        }
        record.path = item.agentPath || record.path;
        record.model = item.model || record.model;
        record.effort = item.reasoningEffort || record.effort;
        record.status = eventState(item, id) || record.status;
        if (item.agentsStates?.[id]) record.message = item.agentsStates[id].message || '';
        if (!threadId) record.status = item.status === 'failed' ? 'failed' : 'pending';
        if (item.prompt && !record.prompt) record.prompt = item.prompt;
        record.events.push({ key: item.id, turnId: turn.id, operation: operations[item.kind || item.tool] || '子任务活动',
          prompt: item.prompt || '', failed: item.status === 'failed', pending: item.status === 'inProgress',
          timestamp: itemTimestamp(item) });
      }
    }
  }
  for (const record of records.values()) {
    // 派发调用完成不代表任务完成；用事件版本隔开旧快照和新的派发或跟进。
    record.signature = JSON.stringify([record.events, record.status, record.message]);
  }
  return records;
}

function latestWork(turn) {
  const items = turn?.items || [];
  const activity = items.findLast((item) => ['agentMessage', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(item.type));
  if (activity?.type === 'agentMessage') return activity.text || '';
  if (activity?.type === 'commandExecution') return '执行命令：' + (activity.command || activity.commandActions?.[0]?.command || '命令');
  if (activity?.type === 'fileChange') return '处理文件：' + (activity.changes || []).map((change) => change.path).filter(Boolean).join('、');
  if (activity?.type === 'mcpToolCall') return '调用工具：' + (activity.tool || activity.server || 'MCP');
  if (activity?.type === 'dynamicToolCall') return '调用工具：' + [activity.namespace, activity.tool].filter(Boolean).join(' · ');
  return '';
}

export function agentView(record, snapshot) {
  const current = snapshot?.signature === record.signature ? snapshot : null;
  const thread = current?.thread;
  const turn = current?.turn;
  let status = record.status;
  if (thread?.status?.type === 'active') {
    status = thread.status.activeFlags?.includes('waitingOnApproval') ? 'waiting' : 'running';
  } else if (['shutdown', 'interrupted'].includes(record.status)) status = record.status;
  else if (thread?.status?.type === 'systemError' || turn?.status === 'failed') status = 'failed';
  else if (turn?.status === 'interrupted') status = 'interrupted';
  else if (turn?.status === 'completed') status = 'completed';
  else if (thread?.status?.type === 'idle' && !['completed', 'interrupted', 'shutdown', 'failed'].includes(status)) status = 'idle';
  const source = thread?.source?.subAgent?.thread_spawn;
  const path = record.path || source?.agent_path || '';
  const nickname = thread?.agentNickname || source?.agent_nickname || '';
  const name = path.split('/').filter(Boolean).at(-1) || nickname || '子 agent';
  const task = record.prompt || itemText(turn?.items?.find((item) => item.type === 'userMessage') || { type: 'userMessage' });
  const error = current?.error || current?.activityError || '';
  const failure = status === 'failed' ? turn?.error?.message || '' : '';
  const progress = latestWork(turn) || turn?.error?.message || record.message || '';
  return { id: record.id, name, nickname, path, status, label: statuses[status], task, progress, error, failure,
    model: thread?.model || record.model, effort: thread?.reasoningEffort || record.effort,
    needsRefresh: Boolean(record.threadId) && (!current || Boolean(error) || !terminal.has(status)) };
}

function textNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

export function renderAgentGroup(records, snapshots, turnId, openKeys) {
  const group = document.createElement('div');
  group.className = 'agent-group';
  group.setAttribute('aria-label', '子 agent 任务');
  group.append(textNode('div', 'agent-heading', '子任务 · ' + records.length + ' 个子 agent'));
  for (const record of records) {
    const view = agentView(record, snapshots.get(record.id));
    const card = document.createElement('details');
    card.className = 'agent-card';
    card.dataset.agentId = record.id;
    card.dataset.detailKey = turnId + ':agent:' + record.id;
    card.open = openKeys.has(card.dataset.detailKey);
    const summary = document.createElement('summary');
    summary.append(textNode('span', 'agent-name', view.name), textNode('span', 'agent-status', view.label));
    summary.querySelector('.agent-status').dataset.status = view.status;
    summary.append(textNode('span', 'agent-preview', view.progress || view.task || (view.error ? '读取进展失败，正在重试' : '正在同步任务进展…')));
    card.append(summary);
    const body = document.createElement('div');
    body.className = 'agent-body';
    const meta = [view.nickname, view.path, view.model, view.effort ? '思考等级：' + view.effort : ''].filter(Boolean).join(' · ');
    if (meta) body.append(textNode('div', 'agent-meta', meta));
    if (view.task) {
      body.append(textNode('div', 'agent-section-label', '任务内容'), textNode('p', 'agent-text', view.task));
    }
    if (view.progress) {
      body.append(textNode('div', 'agent-section-label', view.status === 'completed' ? '完成结果' : '最新进展'),
        textNode('p', 'agent-text agent-output', view.progress));
    }
    if (view.error) body.append(textNode('p', 'agent-error', '进展同步失败，稍后自动重试：' + view.error));
    if (view.failure) body.append(textNode('p', 'agent-error', '任务失败：' + view.failure));
    body.append(textNode('div', 'agent-section-label', '派发与跟进记录'));
    const events = document.createElement('ol');
    events.className = 'agent-events';
    for (const event of record.events.filter((entry) => entry.turnId === turnId)) {
      const row = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'agent-event-meta';
      meta.append(textNode('span', '', event.operation + (event.failed ? ' · 操作失败' : event.pending ? ' · 正在处理' : '')),
        renderItemTime(event.timestamp));
      row.append(meta);
      if (event.prompt) row.append(textNode('p', 'agent-text', event.prompt));
      events.append(row);
    }
    body.append(events);
    card.append(body);
    group.append(card);
  }
  return group;
}
