import { imagesForItem, renderImage } from './images.js';
import { renderFileChangeTitle, renderFileDiff } from './file-diff.js';

const clockFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const dateTimeFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23' });

export function itemTimestamp({ startedAtMs, completedAtMs }) {
  if (Number.isFinite(startedAtMs) && startedAtMs > 0) return startedAtMs;
  return Number.isFinite(completedAtMs) && completedAtMs > 0 ? completedAtMs : null;
}

export function renderItemTime(timestamp, fallbackAtMs = null) {
  const date = new Date(timestamp ?? fallbackAtMs ?? NaN);
  const valid = Number.isFinite(date.getTime());
  const clock = document.createElement(valid ? 'time' : 'span');
  clock.className = 'item-time';
  if (valid) {
    const approximate = timestamp === null;
    clock.dateTime = date.toISOString();
    clock.textContent = (approximate ? '约 ' : '') + clockFormat.format(date);
    clock.title = (approximate ? '回合结束时间 · ' : '') + dateTimeFormat.format(date);
  } else {
    clock.textContent = '未记录';
    clock.title = '该条目未记录时间';
  }
  return clock;
}

export function itemText(item) {
  if (item.type === 'userMessage') {
    const text = (item.content || []).map((part) => part.text || (part.type === 'image' ? '[图片]' : '')).join('\n');
    const start = '<send_user_message_question_reply>';
    const end = '</send_user_message_question_reply>';
    const value = text.trim();
    // Desktop 用结构化用户消息关联异步答案，历史里显示易读内容而非内部协议。
    if (value.startsWith(start) && value.endsWith(end)) {
      try {
        const parsed = JSON.parse(value.slice(start.length, -end.length));
        const answers = Array.isArray(parsed) ? parsed : [parsed];
        if (answers.length && answers.every((answer) => typeof answer?.question === 'string' && typeof answer.answer === 'string')) {
          return answers.map((answer) => answer.question + '\n\n回答：' + answer.answer).join('\n\n');
        }
      } catch { /* 不符合提问回复格式的消息照常显示。 */ }
    }
    return text;
  }
  if (item.type === 'agentMessage') return item.text || (item.questions || []).map((question) =>
    question.title + (question.options?.length ? '\n' + question.options.map((option, index) => (index + 1) + '. ' + option).join('\n') : '')).join('\n\n');
  return JSON.stringify(item, null, 2);
}

export function compactionState(item, turnStatus) {
  if (item.completed === false || item.status === 'inProgress') {
    return item.interrupted || ['interrupted', 'failed'].includes(turnStatus) ? 'interrupted' : 'inProgress';
  }
  return 'completed';
}

export function compactionText(status, source, startedAtMs, now = Date.now()) {
  if (status === 'inProgress') return Number.isFinite(startedAtMs) && now - startedAtMs >= 10000 ?
    '正在压缩上下文 · 可能需要几分钟' : '正在压缩上下文';
  if (status === 'interrupted') return '压缩已中断';
  return source === 'manual' ? '上下文已压缩' : '上下文已自动压缩';
}

export function renderCompaction(item, turnStatus) {
  const row = document.createElement('div');
  row.className = 'compaction-divider';
  const status = compactionState(item, turnStatus);
  row.classList.toggle('is-compacting', status === 'inProgress');
  const label = document.createElement('span');
  label.className = 'compaction-label';
  label.dataset.status = status;
  label.dataset.source = item.source || 'automatic';
  if (Number.isFinite(item.startedAtMs)) label.dataset.startedAtMs = item.startedAtMs;
  label.textContent = compactionText(status, item.source, item.startedAtMs);
  row.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3v5h14V3M5 21v-5h14v5M8 11l4 3 4-3"/></svg>';
  row.append(label, renderItemTime(itemTimestamp(item)));
  return row;
}

export function updateCompactionLabels(root) {
  for (const label of root.querySelectorAll('.compaction-label[data-status="inProgress"]')) {
    const startedAtMs = label.dataset.startedAtMs ? Number(label.dataset.startedAtMs) : null;
    label.textContent = compactionText('inProgress', label.dataset.source, startedAtMs);
  }
}

const DETAIL_LIMIT = 100000;
const expandedEntries = new Map();

function detailText(value) {
  let remaining = DETAIL_LIMIT;
  let nodes = 1000;
  let truncated = false;
  const seen = new Set();
  const preview = (entry, depth = 0, key = '', parent = null) => {
    if (--nodes < 0) { truncated = true; return '[其余内容已省略]'; }
    if (typeof entry === 'string') {
      if ((key === 'base64' || ((key === 'data' || key === 'image_url' || key === 'url') &&
          (entry.startsWith('data:') || /^(image|audio|base64)/i.test(parent?.type || parent?.mimeType || '')))) && entry.length > 256) {
        return '[图片或音频数据已省略]';
      }
      const length = Math.max(0, Math.min(remaining, DETAIL_LIMIT));
      remaining -= Math.min(entry.length, length);
      if (entry.length <= length) return entry;
      truncated = true;
      return entry.slice(0, length) + '…';
    }
    if (!entry || typeof entry !== 'object') return entry;
    if (remaining <= 0 || depth >= 8) { truncated = true; return '[内容过长，已省略]'; }
    if (seen.has(entry)) return '[重复引用已省略]';
    seen.add(entry);
    const result = Array.isArray(entry) ? [] : {};
    // 先缩小对象，再格式化 JSON；不能先序列化完整图片和工具输出再截断。
    for (const property in entry) {
      if (!Object.hasOwn(entry, property)) continue;
      if (remaining <= 0 || nodes <= 0) {
        truncated = true;
        if (Array.isArray(result)) result.push('[其余内容已省略]');
        else Object.defineProperty(result, '其余内容', { value: '[已省略]', enumerable: true });
        break;
      }
      const child = preview(entry[property], depth + 1, property, entry);
      const displayKey = property.slice(0, 200);
      remaining -= displayKey.length;
      if (displayKey !== property) truncated = true;
      Object.defineProperty(result, displayKey, { value: child, enumerable: true, configurable: true, writable: true });
    }
    return result;
  };
  const text = typeof value === 'string' ? preview(value) : JSON.stringify(preview(value), null, 2) || '';
  if (text.length > DETAIL_LIMIT) truncated = true;
  return text.slice(0, DETAIL_LIMIT) + (truncated ? '\n…输出过长，已截断；完整内容请在 Codex Desktop 中查看。' : '');
}

function toolEntries(items) {
  const entries = [];
  for (const item of items) {
    const timestamp = itemTimestamp(item);
    if (item.type === 'fileChange') {
      for (const [index, change] of (item.changes || []).entries()) {
        entries.push({ key: item.id + ':' + index, type: 'file', timestamp, change });
      }
      continue;
    }
    if (item.type === 'commandExecution') {
      const command = item.commandActions?.[0]?.command || item.command || '命令';
      entries.push({ key: item.id, type: 'command', timestamp, title: () => command.slice(0, 1000).replace(/\s+/g, ' ').trim().slice(0, 150),
        detail: () => detailText({ command, output: item.aggregatedOutput || item.output?.text || item.output, status: item.status || '未知' }) });
      continue;
    }
    if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
      let result;
      entries.push({ key: item.id, type: 'tool', timestamp, title: () => `${item.namespace || item.server || 'MCP'} · ${item.tool || '工具'}`,
        images: () => imagesForItem({ type: item.type, result, contentItems: result }),
        detail: () => {
          result = item.result ?? item.contentItems;
          return detailText({ arguments: item.arguments, result, status: item.status });
        } });
      continue;
    }
    if (item.type === 'reasoning') {
      if (item.summary?.some((part) => typeof part === 'string' ? part : part.text)) entries.push({ key: item.id, type: 'reasoning', timestamp, title: () => '思考摘要',
        detail: () => detailText(item.summary) });
      continue;
    }
    entries.push({ key: item.id, type: 'other', timestamp, title: () => item.type || '其他活动', detail: () => detailText(item) });
  }
  return entries;
}

const activityLabels = { file: '文件', command: '命令', tool: '工具', reasoning: '思考', other: '其他' };

function activityBadge(type, text) {
  const badge = document.createElement('span');
  badge.className = 'activity-kind';
  badge.dataset.kind = type;
  badge.textContent = text;
  return badge;
}

export function renderActivity(items, turnId, firstIndex, openKeys, previous = null) {
  const entries = toolEntries(items);
  if (!entries.length) return null;
  const counts = { file: 0, command: 0, tool: 0, reasoning: 0, other: 0 };
  for (const entry of entries) counts[entry.type]++;
  const summaries = {
    file: `编辑了 ${counts.file} 个文件`,
    command: `运行了 ${counts.command} 条命令`,
    tool: `调用了 ${counts.tool} 个工具`,
    reasoning: '思考摘要',
    other: `${counts.other} 项其他活动`,
  };
  const group = document.createElement('details');
  group.className = 'activity-group';
  group.dataset.detailKey = `${turnId}:activity:${firstIndex}`;
  group.open = openKeys.has(group.dataset.detailKey);
  const heading = document.createElement('summary');
  const overview = document.createElement('span');
  overview.className = 'activity-overview';
  for (const [type, count] of Object.entries(counts)) {
    if (count) overview.append(activityBadge(type, summaries[type]));
  }
  heading.append(overview);
  group.append(heading);
  const retained = expandedEntries.get(group.dataset.detailKey) || new Set();
  if (group.open) retained.clear();
  for (const [index, entry] of entries.entries()) {
    const key = `${turnId}:item:${entry.key || firstIndex + index}`;
    if (openKeys.has(key)) retained.add(key);
  }
  if (retained.size) expandedEntries.set(group.dataset.detailKey, retained);
  let list = null;
  const populate = () => {
    if (!group.open || list) return;
    list = document.createElement('div');
    list.className = 'activity-list';
    for (const [index, entry] of entries.entries()) {
      const detail = document.createElement('details');
      detail.className = 'activity-entry';
      detail.dataset.kind = entry.type;
      detail.dataset.detailKey = `${turnId}:item:${entry.key || firstIndex + index}`;
      detail.open = openKeys.has(detail.dataset.detailKey) || retained.has(detail.dataset.detailKey);
      const summary = document.createElement('summary');
      const title = entry.change ? renderFileChangeTitle(entry.change) :
        document.createElement(entry.type === 'command' ? 'code' : 'span');
      if (!entry.change) {
        title.className = 'activity-title';
        title.textContent = entry.title();
        title.title = title.textContent;
      }
      summary.append(activityBadge(entry.type, activityLabels[entry.type]), title, renderItemTime(entry.timestamp));
      detail.append(summary);
      let populated = false;
      const populateDetail = () => {
        if (!detail.open || !group.open || populated) return;
        populated = true;
        if (entry.change) {
          const selector = '[data-detail-key="' + CSS.escape(detail.dataset.detailKey) + '"] > .file-diff';
          detail.append(renderFileDiff(entry.change, previous?.querySelector(selector)));
          return;
        }
        const body = document.createElement('pre');
        body.textContent = entry.detail();
        detail.append(body);
        for (const source of entry.images?.() || []) detail.append(renderImage(source, '工具返回的图片', previous));
      };
      detail.addEventListener('toggle', () => {
        if (detail.open) retained.add(detail.dataset.detailKey);
        else retained.delete(detail.dataset.detailKey);
        if (retained.size) expandedEntries.set(group.dataset.detailKey, retained);
        else expandedEntries.delete(group.dataset.detailKey);
        populateDetail();
      });
      populateDetail();
      list.append(detail);
    }
    group.append(list);
  };
  group.addEventListener('toggle', populate);
  populate();
  // 首次构建已转移展开的差异和图片，后续事件不再引用旧分组。
  previous = null;
  return group;
}
