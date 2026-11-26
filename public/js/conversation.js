import { elements, state, markdown, api, isDraft, threadName, threadLocation, projectForCwd, showNotice, clearNotice } from './core.js';
import { itemText, itemTimestamp, renderActivity, renderCompaction, renderItemTime, updateCompactionLabels } from './activity.js';
import { renderSettings, syncSelectionFromThread, loadPermissionMode } from './settings.js';
import { renderGoal } from './goals.js';
import { isAgentItem, collectAgents, agentView, renderAgentGroup } from './agents.js';
import { loadQuestions, renderQuestions } from './questions.js';
import { imagesForItem, renderImage, renderImages } from './images.js';

let selectedLoad = null;
let syncFeedback = null;
const loadingItemPages = new Map();
let olderLoad = null;
let questionNavigation = null;
const renderedItems = new WeakMap();

function updateChildren(parent, children) {
  // 保留位置未变的节点，避免清空消息时图片高度塌缩、浏览器截断 scrollTop。
  let next = parent.firstChild;
  for (const child of children) {
    if (child === next) next = next.nextSibling;
    else parent.insertBefore(child, next);
  }
  while (next) {
    const removed = next;
    next = next.nextSibling;
    removed.remove();
  }
}

function mergeItems(earlier, newer) {
  const merged = new Map(earlier.map((item) => [item.id, item]));
  for (const item of newer) {
    const previous = merged.get(item.id);
    merged.set(item.id, { ...previous, ...item,
      startedAtMs: item.startedAtMs ?? previous?.startedAtMs,
      completedAtMs: item.completedAtMs ?? previous?.completedAtMs });
  }
  const items = [...merged.values()];
  const opening = items.find((item) => item.type === 'userMessage');
  const final = items.findLast((item) => item.type === 'agentMessage' && item.phase === 'final_answer') ??
    items.findLast((item) => item.type === 'agentMessage');
  // 摘要可能不带时间；保留过程页的时间，并把首句、最后回复放在正确位置。
  const time = (item) => Number.isFinite(item.startedAtMs) ? item.startedAtMs :
    item === opening ? -Infinity : item === final ? Infinity : 0;
  return items.sort((a, b) => time(a) - time(b));
}

function storeTurn(turn) {
  const previous = state.turns.get(turn.id);
  if (previous && turn.itemsView === 'summary') {
    // 新页与已读过程衔接时，保留用户手动加载的旧内容和游标。
    const contiguous = turn.itemsDeferred || (!previous.itemsDeferred && turn.itemsStartId &&
      previous.items?.some((item) => item.id === turn.itemsStartId));
    turn = { ...turn, items: mergeItems(previous.items || [], turn.items || []),
      ...(contiguous ? { itemsCursor: previous.itemsCursor, itemsView: previous.itemsView,
        itemsDeferred: previous.itemsDeferred, itemsStartId: previous.itemsStartId,
        ...(turn.itemsDeferred ? { itemsError: previous.itemsError } : {}) } : {}) };
  }
  state.turns.set(turn.id, turn);
}

async function loadTurnItems(turn) {
  const id = state.selectedId;
  const turns = state.turns;
  const before = turns.get(turn.id);
  if (loadingItemPages.get(turn.id)?.turns === turns) return;
  const cursor = turn.itemsCursor;
  const request = { turns, controller: new AbortController() };
  loadingItemPages.set(turn.id, request);
  renderMessages();
  const timer = setTimeout(() => request.controller.abort(), 30000);
  try {
    const result = await api('/api/threads/' + id + '/turns/' + turn.id + '/items' +
      (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { signal: request.controller.signal });
    if (id !== state.selectedId || turns !== state.turns) return;
    const current = turns.get(turn.id);
    const nextCursor = current.itemsCursor === cursor ? result.nextCursor : current.itemsCursor;
    const items = current === before ? mergeItems(current.items || [], result.items) : mergeItems(result.items, current.items || []);
    turns.set(turn.id, { ...current, items,
      itemsCursor: nextCursor, itemsDeferred: false, itemsStartId: result.items[0]?.id ?? current.itemsStartId,
      itemsError: null, itemsView: nextCursor ? 'summary' : 'full' });
  } catch (error) {
    if (id === state.selectedId && turns === state.turns) turns.set(turn.id, { ...turns.get(turn.id),
      itemsError: error.name === 'AbortError' ? '读取过程超时，请重试' : error.message });
  } finally {
    clearTimeout(timer);
    if (loadingItemPages.get(turn.id) === request) loadingItemPages.delete(turn.id);
    if (id === state.selectedId && turns === state.turns) {
      state.initialHistory = false;
      renderMessages();
    }
  }
}

function turnHistoryControl(turn) {
  if (!turn.itemsDeferred && !turn.itemsCursor && !turn.itemsError) return null;
  const toolbar = document.createElement('div');
  toolbar.className = 'turn-history';
  const button = document.createElement('button');
  button.className = 'text-button';
  button.type = 'button';
  const loading = loadingItemPages.get(turn.id)?.turns === state.turns;
  button.disabled = loading;
  button.textContent = loading ? '正在加载过程…' : turn.itemsError ? '重试读取过程' :
    turn.itemsDeferred ? '查看本回合过程' : '加载本回合更早的过程';
  button.addEventListener('click', () => void loadTurnItems(turn));
  toolbar.append(button);
  if (turn.itemsError) {
    const error = document.createElement('p');
    error.className = 'agent-error';
    error.textContent = turn.itemsError;
    toolbar.append(error);
  }
  return toolbar;
}

function renderSyncFeedback() {
  const visible = syncFeedback?.id === state.selectedId && !isDraft(state.selectedId);
  let banner = document.getElementById('conversationSync');
  if (!banner && !visible) return;
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'conversationSync';
    banner.className = 'conversation-sync';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    elements.messages.parentElement.before(banner);
  }
  banner.hidden = !visible;
  if (!visible) return;
  const failed = syncFeedback.failed === true;
  banner.classList.toggle('is-error', failed);
  banner.setAttribute('aria-busy', String(!failed));
  banner.replaceChildren();
  if (!failed) {
    const spinner = document.createElement('span');
    spinner.className = 'feedback-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    banner.append(spinner);
  }
  const label = document.createElement('span');
  label.textContent = syncFeedback.message;
  banner.append(label);
  if (failed) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'text-button';
    retry.textContent = '重试';
    retry.addEventListener('click', () => void loadSelected({ force: true, feedback: true }));
    banner.append(retry);
  }
}

function statusText(status) {
  if (status?.activeFlags?.includes('waitingOnUserInput')) return '等待回答';
  if (status?.activeFlags?.includes('waitingOnApproval')) return '等待审批';
  if (status?.type === 'active') return '正在运行';
  if (status?.type === 'idle') return '空闲';
  if (status?.type === 'systemError') return '运行出错';
  if (status?.type === 'notLoaded') return '未加载';
  return status?.type || '状态未知';
}

export function renderHeader() {
  const thread = state.selectedThread;
  const project = projectForCwd(thread?.cwd);
  elements.threadContext.textContent = project?.name || (thread ? threadLocation(thread) : 'CODEX DESKTOP');
  elements.threadTitle.textContent = thread ? threadName(thread) : '选择一个对话';
  elements.threadMeta.textContent = thread ? ((isDraft(thread.id) ? '未发送' : statusText(thread.status)) + ' · ' + (thread.cwd || thread.id)) : '与正在运行的 Codex Desktop 同步';
  renderSettings();
  renderGoal();
  updateComposerAction();
  updateScrollToBottom();
  renderSyncFeedback();
  renderQuestions();
}

export function updateScrollToBottom() {
  const box = elements.messages;
  const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
  elements.scrollToBottom.hidden = !state.selectedId || gap <= 140;
  const navigating = questionNavigation?.turns === state.turns;
  elements.previousQuestion.hidden = !state.selectedId || isDraft(state.selectedId) || (gap <= 140 && !navigating);
  elements.previousQuestion.disabled = navigating;
  elements.previousQuestion.setAttribute('aria-busy', String(navigating));
  elements.previousQuestion.querySelector('span').textContent = navigating ? '正在加载提问…' : '上一次提问';
  elements.olderTurns.disabled = olderLoad?.turns === state.turns;
  const mode = state.selectedThread?.status?.type === 'active' ? 'running' : 'idle';
  if (elements.scrollToBottom.dataset.mode === mode) return;
  elements.scrollToBottom.dataset.mode = mode;
  elements.scrollToBottom.setAttribute('aria-label', mode === 'running' ? '滚动到底部查看进行中的输出' : '滚动到底部');
  elements.scrollToBottom.innerHTML = mode === 'running' ?
    '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>' :
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14m-6-6 6 6 6-6"/></svg>';
}

export function updateComposerAction() {
  const goalIntent = /^\/goal(?:\s|$)/.test(elements.messageInput.value.trim());
  const active = state.selectedThread?.status?.type === 'active' && !goalIntent;
  const stopping = state.stopping;
  const label = stopping ? '正在停止…' : active ? '停止当前回合' : goalIntent ? '设置目标' : '发送消息';
  elements.sendMessage.classList.toggle('is-stop', active);
  elements.sendMessage.classList.toggle('is-stopping', stopping);
  elements.sendMessage.setAttribute('aria-busy', String(stopping));
  elements.sendMessage.setAttribute('aria-label', label);
  elements.sendMessage.title = label;
  elements.sendMessage.innerHTML = stopping ? '<span class="feedback-spinner" aria-hidden="true"></span>' : active ?
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>' :
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>';
  elements.sendMessage.disabled = !state.selectedId || state.sending || state.stopping || state.goalBusy ||
    (!active && !elements.messageInput.value.trim());
  let actionStatus = document.getElementById('composerActionStatus');
  if (!actionStatus && stopping) {
    actionStatus = document.createElement('p');
    actionStatus.id = 'composerActionStatus';
    actionStatus.className = 'composer-action-status';
    actionStatus.setAttribute('role', 'status');
    elements.composer.prepend(actionStatus);
  }
  if (actionStatus) {
    actionStatus.hidden = !stopping;
    actionStatus.textContent = stopping ? '正在停止当前回合…' : '';
  }
}

async function copyMessage(text, button) {
  try {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        // 局域网的非安全上下文或旧 Safari 可能拒绝 Clipboard API，继续使用浏览器复制命令。
      }
    }
    if (!copied) {
      const field = document.createElement('textarea');
      field.value = text;
      field.readOnly = true;
      field.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.append(field);
      try {
        field.select();
        if (!document.execCommand('copy')) throw new Error('复制失败');
      } finally {
        field.remove();
      }
    }
    button.title = '已复制';
  } catch {
    showNotice('复制失败，请手动选择文本');
  }
}

function appendMessageLabel(card, text) {
  const label = document.createElement('span');
  label.className = 'item-label';
  label.textContent = text;
  if (card.classList.contains('assistant')) {
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.append(label);
    card.append(meta);
  } else card.append(label);
}

function updateMessageTime(card, timestamp, fallbackAtMs = null) {
  const previous = renderedItems.get(card);
  if (previous?.timestamp === timestamp && previous?.fallbackAtMs === fallbackAtMs) return;
  const meta = card.querySelector('.message-meta');
  const previousClock = meta.querySelector('.item-time');
  const clock = renderItemTime(timestamp, fallbackAtMs);
  if (previousClock) previousClock.replaceWith(clock);
  else meta.append(clock);
}

export function elapsedText(startedAt, now = Date.now()) {
  if (!Number.isFinite(startedAt)) return '已处理';
  const seconds = Math.max(0, Math.floor(now / 1000 - startedAt));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remaining = seconds % 60;
  return '已处理 ' + (hours ? hours + '小时' : '') +
    String(minutes).padStart(2, '0') + '分' + String(remaining).padStart(2, '0') + '秒';
}

export function updateTurnStatuses() {
  updateCompactionLabels(elements.messages);
  for (const status of elements.messages.querySelectorAll('.turn-status[data-turn-id]')) {
    const turn = state.turns.get(status.dataset.turnId);
    if (!turn) continue;
    const items = turn.items || [];
    const latestErrorIndex = items.findLastIndex((item) => item.type === 'error');
    const retryInHistory = latestErrorIndex >= 0 && items[latestErrorIndex].willRetry === true &&
      !items.slice(latestErrorIndex + 1).some((item) => item.type !== 'error');
    if (turn.status === 'failed') {
      status.textContent = '回合失败：' + (turn.error?.message || '请检查 Desktop 的错误详情');
    } else if (state.retryingTurns.has(turn.id) || retryInHistory) {
      status.textContent = '连接出错，正在重连… ' + elapsedText(turn.startedAt);
    } else if (state.desktopConnected === false) {
      status.textContent = '桌面连接中断，正在重连… ' + elapsedText(turn.startedAt);
    } else {
      status.textContent = elapsedText(turn.startedAt);
    }
  }
}

export function renderMessages() {
  const box = elements.messages;
  const nearBottom = state.initialHistory || box.scrollHeight - box.scrollTop - box.clientHeight < 100;
  const previousScroll = box.scrollTop;
  const anchor = [...box.querySelectorAll('.item[data-item-id]')].find((item) =>
    item.getBoundingClientRect().bottom > box.getBoundingClientRect().top);
  const anchorTurnId = anchor?.closest('.turn')?.dataset.turnId;
  const anchorTop = anchor?.getBoundingClientRect().top;
  const visibleImage = [...box.querySelectorAll('.message-image')].find((image) => {
    const bounds = image.getBoundingClientRect();
    const viewport = box.getBoundingClientRect();
    return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
  });
  const imageTop = visibleImage?.getBoundingClientRect().top;
  const openKeys = new Set([...box.querySelectorAll('details[open][data-detail-key]')].map((detail) => detail.dataset.detailKey));
  const content = [];
  const previousTurns = new Map([...box.children].filter((node) => node.dataset.turnId)
    .map((node) => [node.dataset.turnId, node]));
  const visibleTurns = new Map(state.turns);
  for (const item of state.compactions) {
    if (item.turnId && !item.completed && !item.interrupted && !visibleTurns.has(item.turnId)) {
      visibleTurns.set(item.turnId, { id: item.turnId, status: 'inProgress', startedAt: item.startedAtMs / 1000, items: [] });
    }
  }
  const turns = [...visibleTurns.values()].map((turn) => {
    const updates = new Map(state.compactions.filter((item) => item.turnId === turn.id).map((item) => [item.id, item]));
    const items = (turn.items || []).map((item) => {
      const update = updates.get(item.id);
      updates.delete(item.id);
      return item.type === 'contextCompaction' && update ? { ...item, ...update } : item;
    });
    // 摘要和过程分页可能不含旧压缩项；按事件时间插回原位置，不能一直追加到最新回复后。
    for (const update of [...updates.values()].sort((a, b) => (a.startedAtMs || 0) - (b.startedAtMs || 0))) {
      const next = items.findIndex((item) => item.type !== 'userMessage' && (
        (Number.isFinite(item.startedAtMs) && Number.isFinite(update.startedAtMs) && item.startedAtMs > update.startedAtMs) ||
        (item.type === 'agentMessage' && item.phase === 'final_answer' && !Number.isFinite(item.startedAtMs))));
      items.splice(next < 0 ? items.length : next, 0, update);
    }
    return { ...turn, items };
  }).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const agents = collectAgents(turns);
  if (!turns.length) {
    const loading = state.historyLoading && !isDraft(state.selectedId);
    const unavailable = state.selectedId && !isDraft(state.selectedId) && !state.historyInitialized;
    const empty = document.createElement('div');
    empty.className = 'empty-state' + (loading ? ' conversation-loading' : '');
    if (loading) empty.setAttribute('role', 'status');
    const symbol = document.createElement('span');
    symbol.className = loading ? 'conversation-spinner' : 'empty-symbol';
    symbol.setAttribute('aria-hidden', 'true');
    const title = document.createElement('h2');
    title.textContent = loading ? '正在加载对话…' : unavailable ? '对话暂时无法加载' :
      state.selectedId ? '开始这个对话' : '选择一个对话';
    const description = document.createElement('p');
    description.textContent = loading ? '正在读取消息记录，长对话可能需要几秒。' :
      unavailable ? '请稍后重试，或切换到其他对话。' :
      isDraft(state.selectedId) ? '发送第一条消息时才会在 Codex Desktop 中创建这个对话。' :
      state.selectedId ? '在下方输入消息，内容会同步到桌面。' : '从左侧项目或最近对话中选择，也可以新建对话。';
    empty.append(symbol, title, description);
    content.push(empty);
  }
  for (const turn of turns) {
    const section = previousTurns.get(turn.id) || document.createElement('section');
    section.className = 'turn';
    section.dataset.turnId = turn.id;
    const children = [];
    const previousItems = new Map([...section.querySelectorAll('.item[data-item-id]')]
      .map((node) => [node.dataset.itemId, node]));
    const historyControl = turnHistoryControl(turn);
    const items = turn.items || [];
    let agentsRendered = false;
    let lastAnswerIndex = -1;
    for (let index = items.length - 1; index >= 0; index--) {
      if (items[index].type === 'agentMessage' && itemText(items[index])) {
        lastAnswerIndex = index;
        break;
      }
    }
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (item.type === 'contextCompaction') {
        children.push(renderCompaction(item, turn.status));
        continue;
      }
      if (isAgentItem(item)) {
        if (!agentsRendered) {
          const tasks = [...agents.values()].filter((record) => record.events.some((event) => event.turnId === turn.id));
          children.push(renderAgentGroup(tasks, state.agentActivity, turn.id, openKeys));
          agentsRendered = true;
        }
        continue;
      }
      if (['imageView', 'ImageView', 'localImage', 'local_image'].includes(item.type)) {
        const timestamp = itemTimestamp(item);
        let card = item.id && previousItems.get(item.id);
        if (!card || renderedItems.get(card)?.imageUrl !== item.imageUrl || card.querySelector('.message-image[data-failed]')) {
          card = document.createElement('div');
          card.className = 'item assistant';
          card.dataset.itemId = item.id;
          appendMessageLabel(card, 'Codex · 图片');
          card.append(renderImage(item.imageUrl, 'Codex 图片'));
        }
        updateMessageTime(card, timestamp);
        renderedItems.set(card, { imageUrl: item.imageUrl, timestamp, fallbackAtMs: null });
        children.push(card);
        continue;
      }
      if (item.type !== 'userMessage' && item.type !== 'agentMessage') {
        const group = [];
        const firstIndex = index;
        while (index < items.length && !isAgentItem(items[index]) && !['userMessage', 'agentMessage', 'contextCompaction', 'imageView', 'ImageView', 'localImage', 'local_image'].includes(items[index].type)) {
          group.push(items[index]);
          index++;
        }
        const previousActivity = [...section.children].find((node) => node.dataset.detailKey === `${turn.id}:activity:${firstIndex}`);
        const activity = renderActivity(group, turn.id, firstIndex, openKeys, previousActivity);
        if (activity) children.push(activity);
        index--;
        continue;
      }
      const text = itemText(item);
      const images = imagesForItem(item);
      if (!text && !images.length) continue;
      const kind = item.type === 'userMessage' ? 'user' : 'assistant';
      const isFinal = item.phase === 'final_answer' ||
        (item.phase == null && turn.status === 'completed' && index === lastAnswerIndex);
      const labelText = kind === 'user' ? '你' : isFinal ? 'Codex' : 'Codex · 进度';
      const timestamp = kind === 'assistant' ? itemTimestamp(item) : null;
      // 旧摘要没有条目时间时，只有最终回复可以用回合结束时间标作估计值。
      const fallbackAtMs = kind === 'assistant' && timestamp === null && isFinal &&
        Number.isFinite(turn.completedAt) && turn.completedAt > 0 ? turn.completedAt * 1000 : null;
      const sources = JSON.stringify(item.imageSources || {});
      let card = item.id && previousItems.get(item.id);
      const previous = card && renderedItems.get(card);
      const reusable = previous?.kind === kind && previous.text === text && previous.sources === sources &&
        previous.images.length === images.length && previous.images.every((source, position) => source === images[position]) &&
        !card.querySelector('.message-image[data-failed]');
      if (!reusable) {
        const previousCard = card;
        card = document.createElement('div');
        card.className = 'item ' + kind;
        card.dataset.itemId = item.id;
        appendMessageLabel(card, labelText);
        const body = document.createElement('div');
        body.className = 'item-body markdown-body';
        body.innerHTML = markdown.render(text);
        renderImages(body, item.imageSources, previousCard);
        for (const source of images) body.append(renderImage(source, '图片', previousCard));
        card.append(body);
      }
      const label = card.querySelector('.item-label');
      if (label.textContent !== labelText) label.textContent = labelText;
      if (kind === 'assistant') {
        card.classList.toggle('is-progress', !isFinal);
        updateMessageTime(card, timestamp, fallbackAtMs);
      }
      const canCopy = kind === 'assistant' && index === lastAnswerIndex;
      const existingFooter = card.querySelector('.message-footer');
      if (!canCopy) existingFooter?.remove();
      else if (!existingFooter) {
        const footer = document.createElement('div');
        footer.className = 'message-footer';
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'message-copy';
        copy.title = '复制回复';
        copy.setAttribute('aria-label', '复制回复');
        copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
        copy.addEventListener('click', () => void copyMessage(text, copy));
        footer.append(copy);
        card.querySelector('.item-time').before(footer);
      }
      renderedItems.set(card, { kind, text, sources, images, timestamp, fallbackAtMs });
      children.push(card);
    }
    if (historyControl) {
      const question = children.findIndex((node) => node.matches('.item.user'));
      children.splice(question + 1, 0, historyControl);
    }
    if (turn.status === 'inProgress' || turn.status === 'failed') {
      const status = document.createElement('p');
      status.className = 'turn-status' + (turn.status === 'failed' ? ' failed' : '');
      status.dataset.turnId = turn.id;
      children.push(status);
    }
    updateChildren(section, children);
    content.push(section);
  }
  updateChildren(box, content);
  elements.olderTurns.hidden = !state.olderCursor;
  updateTurnStatuses();
  if (nearBottom) box.scrollTop = box.scrollHeight;
  else {
    const retained = box.contains(visibleImage) ? visibleImage : anchor && [...box.querySelectorAll('.item[data-item-id]')].find((item) =>
      item.dataset.itemId === anchor.dataset.itemId && item.closest('.turn').dataset.turnId === anchorTurnId);
    // 前插历史或补充过程时，按可见消息的位置补偿，避免正在阅读的内容突然跳走。
    if (retained) {
      const offset = retained.getBoundingClientRect().top - (retained === visibleImage ? imageTop : anchorTop);
      box.scrollTop += offset;
    } else box.scrollTop = previousScroll;
  }
  if (!state.historyLoading) state.initialHistory = false;
  updateScrollToBottom();
}

export async function loadSelected({ force = false, feedback = false } = {}) {
  const id = state.selectedId;
  const turns = state.turns;
  if (!id || isDraft(id)) return;
  if (selectedLoad?.id === id && selectedLoad.turns === turns && !force) return selectedLoad.promise;
  // 前台恢复时取消后台遗留请求，避免旧响应覆盖最新同步结果。
  selectedLoad?.controller.abort();
  const request = { id, turns, controller: new AbortController(), timedOut: false };
  selectedLoad = request;
  state.loadingSelected = true;
  if (feedback) {
    syncFeedback = { id, message: '正在同步最新对话…' };
    renderSyncFeedback();
  }
  const goalEpoch = state.goalEpoch;
  const hadPendingTurn = [...turns.values()].some((turn) => turn.status === 'inProgress');
  const current = () => selectedLoad === request && id === state.selectedId && turns === state.turns;
  const eagerHistory = force || !state.historyInitialized;
  const timer = setTimeout(() => {
    request.timedOut = true;
    request.controller.abort();
  }, 30000);
  request.promise = (async () => {
    const loadHistory = async (limit, summary) => {
      const history = await api('/api/threads/' + id + '/turns?limit=' + limit +
        (summary ? '&itemsView=summary' : ''), { signal: request.controller.signal });
      if (!current()) return;
      // 最近一页与已读历史衔接时保留旧游标；离开期间新增太多回合时，先补中间缺页。
      const oldest = history.turns?.at(-1);
      if (!state.historyInitialized || (summary && oldest && !turns.has(oldest.id))) state.olderCursor = history.nextCursor;
      state.historyInitialized = true;
      for (const turn of history.turns || []) storeTurn(turn);
      state.historyLoading = false;
      renderMessages();
      const latest = turns.get(history.turns?.[0]?.id);
      if (eagerHistory && summary && latest?.status === 'inProgress' && latest.itemsDeferred) void loadTurnItems(latest);
    };
    const loadMetadata = async () => {
      const metadata = await api('/api/threads/' + id, { signal: request.controller.signal });
      if (!current()) return null;
      const active = metadata.thread.status?.type === 'active';
      const previous = state.selectedThread;
      const changed = metadata.thread.updatedAt !== previous?.updatedAt ||
        metadata.thread.status?.type !== previous?.status?.type;
      const pendingTurn = hadPendingTurn || [...turns.values()].some((turn) => turn.status === 'inProgress');
      const agentsPending = [...collectAgents(turns.values()).values()].some((record) => {
        const view = agentView(record, state.agentActivity.get(record.id));
        return view.needsRefresh && !view.error;
      });
      state.selectedThread = metadata.thread;
      state.usage = metadata.usage || null;
      if (goalEpoch === state.goalEpoch) {
        state.goal = metadata.goal || null;
        state.completedGoal = metadata.completedGoal || null;
        state.goalSupported = metadata.goalSupported !== false;
        state.goalError = metadata.goalError || null;
      }
      const compactions = metadata.compactions || [];
      const compactionsChanged = JSON.stringify(compactions) !== JSON.stringify(state.compactions);
      state.compactions = compactions;
      syncSelectionFromThread(metadata.thread);
      renderHeader();
      void loadQuestions({ force });
      if (feedback && syncFeedback?.id === id) {
        syncFeedback.message = '正在加载最新消息…';
        renderSyncFeedback();
      }
      return { active, pendingTurn, agentsPending, fullPage: !active && changed, compactionsChanged };
    };
    try {
      // 提问和最新回复独立于目标、用量等元信息返回，先到的摘要可以立即显示。
      const results = await Promise.allSettled([loadMetadata(), eagerHistory ? loadHistory(5, true) : null]);
      if (!current()) return;
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      const details = results[0].value;
      if (eagerHistory && hadPendingTurn && ![...turns.values()].some((turn) => turn.status === 'inProgress')) {
        await loadHistory(1, false);
      }
      if (!eagerHistory && (details.fullPage || details.active || details.pendingTurn || details.agentsPending)) {
        await loadHistory(details.fullPage ? 5 : 1, details.fullPage);
        // 回合刚结束时仍需核对最后一页过程，避免工具状态停留在“进行中”。
        if (current() && details.fullPage && details.pendingTurn) await loadHistory(1, false);
      }
      if (!current()) return;
      state.historyLoading = false;
      if (syncFeedback?.id === id) syncFeedback = null;
      renderHeader();
      if (details.compactionsChanged) renderMessages();
      void refreshAgentActivity(id);
      clearNotice('selected');
      // 历史恢复后重新读取曾失败的权限，让临时错误随下一次同步自动恢复。
      if (state.permissionLabel === '权限读取失败' && !state.permissionDirty) await loadPermissionMode(id);
    } catch (error) {
      if (current()) {
        state.historyLoading = false;
        renderMessages();
        const message = request.timedOut ? '同步超时，尚未取得最新对话，请重试。' : error.message;
        if (feedback || syncFeedback?.id === id) {
          syncFeedback = { id, failed: true, message: '同步失败：' + message };
          renderSyncFeedback();
        } else if (elements.authPanel.hidden) showNotice(message, 'selected');
      }
    } finally {
      clearTimeout(timer);
      if (selectedLoad === request) {
        selectedLoad = null;
        state.loadingSelected = false;
        if (id !== state.selectedId && state.selectedId) void loadSelected();
      }
    }
  })();
  return request.promise;
}

export async function refreshAgentActivity(id = state.selectedId) {
  if (!id || id !== state.selectedId || state.agentActivityLoading) return;
  const snapshots = state.agentActivity;
  // 完成后低频核对，后续从 Desktop 恢复的子任务也能继续更新。
  const records = [...collectAgents(state.turns.values()).values()].filter((record) => {
    const snapshot = snapshots.get(record.id);
    const view = agentView(record, snapshot);
    const due = Date.now() - (snapshot?.checkedAt || 0) >= 12000;
    return record.threadId && (due || (view.needsRefresh && !view.error));
  });
  if (!records.length) return;
  state.agentActivityLoading = true;
  let changed = false;
  try {
    // 限制同时读取数，避免多个子任务的完整工具输出挤占主聊天刷新。
    for (let offset = 0; offset < records.length; offset += 4) {
      const batch = records.slice(offset, offset + 4);
      const results = await Promise.allSettled(batch.map((record) => api('/api/threads/' + record.id + '/agent-activity')));
      if (id !== state.selectedId || snapshots !== state.agentActivity) return;
      results.forEach((result, index) => {
        const record = batch[index];
        const previous = snapshots.get(record.id);
        const snapshot = result.status === 'fulfilled' ? { ...result.value, signature: record.signature } :
          { ...(previous?.signature === record.signature ? previous : {}), signature: record.signature, error: result.reason.message };
        if (snapshot.activityError && !snapshot.turn && previous?.signature === record.signature) snapshot.turn = previous.turn;
        if (JSON.stringify(previous && { ...previous, checkedAt: undefined }) !== JSON.stringify({ ...snapshot, checkedAt: undefined })) changed = true;
        snapshots.set(record.id, { ...snapshot, checkedAt: Date.now() });
      });
    }
  } finally {
    // 切换聊天时会替换 Map；旧请求不得把状态或展开内容带进新聊天。
    if (id === state.selectedId && snapshots === state.agentActivity) {
      state.agentActivityLoading = false;
      if (changed) renderMessages();
    }
  }
}

export async function loadOlderTurns() {
  if (!state.selectedId || !state.olderCursor) return false;
  const id = state.selectedId;
  const turns = state.turns;
  if (olderLoad?.turns === turns) return olderLoad.promise;
  olderLoad?.controller.abort();
  const cursor = state.olderCursor;
  const request = { turns, controller: new AbortController() };
  olderLoad = request;
  const current = () => id === state.selectedId && turns === state.turns;
  const timer = setTimeout(() => request.controller.abort(), 30000);
  updateScrollToBottom();
  request.promise = (async () => {
    try {
      const result = await api('/api/threads/' + id + '/turns?limit=5&itemsView=summary&cursor=' + encodeURIComponent(cursor),
        { signal: request.controller.signal });
      if (!current()) return false;
      if (result.nextCursor != null && result.nextCursor === cursor) throw new Error('读取历史失败：分页游标未向前推进，请重试');
      for (const turn of result.turns) storeTurn(turn);
      if (state.olderCursor === cursor) state.olderCursor = result.nextCursor;
      state.initialHistory = false;
      renderMessages();
      clearNotice('history');
      return true;
    } catch (error) {
      if (current()) showNotice(error.name === 'AbortError' ? '读取历史超时，请重试' : error.message, 'history');
      return false;
    } finally {
      clearTimeout(timer);
      if (olderLoad === request) olderLoad = null;
      if (current()) updateScrollToBottom();
    }
  })();
  return request.promise;
}

export async function jumpToPreviousQuestion() {
  const id = state.selectedId;
  const turns = state.turns;
  if (!id || isDraft(id) || questionNavigation?.turns === turns) return;
  const request = { turns };
  questionNavigation = request;
  const current = () => id === state.selectedId && turns === state.turns;
  const visited = new Set();
  updateScrollToBottom();
  try {
    while (current()) {
      const box = elements.messages;
      const top = box.getBoundingClientRect().top;
      const questions = [...box.querySelectorAll('.item.user[data-item-id]')];
      // 已对齐的提问留在顶部 12px；再次点击只查找其前面的提问。
      const target = questions.findLast((item) => item.getBoundingClientRect().top < top + 2);
      if (target) {
        state.initialHistory = false;
        box.scrollTo({ top: box.scrollTop + target.getBoundingClientRect().top - top - 12, behavior: 'instant' });
        clearNotice('history');
        return;
      }
      const cursor = state.olderCursor;
      if (!cursor) {
        showNotice('已经到达最早的提问', 'history');
        return;
      }
      if (visited.has(cursor)) {
        showNotice('读取历史失败：分页游标重复，请重试', 'history');
        return;
      }
      visited.add(cursor);
      if (!await loadOlderTurns()) return;
    }
  } finally {
    if (questionNavigation === request) questionNavigation = null;
    if (current()) updateScrollToBottom();
  }
}
