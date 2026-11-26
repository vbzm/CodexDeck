import { elements, state, api, isDraft, saveDrafts, showNotice, clearNotice } from './core.js';
import { selectedTurnOptions } from './settings.js';

const labels = { active: '进行中的目标', paused: '已暂停的目标', blocked: '目标已停滞',
  usageLimited: '目标使用受限', budgetLimited: '目标受限', complete: '已达成目标' };
const resumable = new Set(['paused', 'blocked', 'usageLimited']);
const number = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
let callbacks;
let editorThreadId = null;

export function goalUsage(goal, now = Date.now()) {
  if (goal.tokenBudget != null && ['active', 'budgetLimited'].includes(goal.status)) {
    return number.format(goal.tokensUsed || 0) + ' / ' + number.format(goal.tokenBudget);
  }
  const seconds = Math.max(0, Math.floor((goal.timeUsedSeconds || 0) +
    (goal.status === 'active' && Number.isFinite(goal.updatedAt) ? now / 1000 - goal.updatedAt : 0)));
  const hours = Math.floor(seconds / 3600);
  return (hours ? hours + '小时' : '') + Math.floor(seconds % 3600 / 60) + '分' + seconds % 60 + '秒';
}

export function renderGoal() {
  const goal = state.goal?.status === 'complete' ? null : state.goal;
  // 输入区只常驻进行中的目标；已暂停目标仍可从目标按钮进入编辑并恢复。
  elements.goalBar.hidden = goal?.status !== 'active';
  elements.goalError.hidden = !state.goalError;
  elements.goalError.textContent = state.goalError || '';
  const disabled = !state.selectedId || state.goalBusy || state.sending || state.stopping || state.goalSupported === false;
  elements.goalTrigger.disabled = disabled;
  elements.goalTrigger.title = state.goalSupported === false ? '当前 Desktop 不支持目标' :
    goal ? '编辑目标（' + (labels[goal.status] || '目标') + '）' : '设置目标（/goal）';
  for (const button of [elements.goalSummary, elements.goalClear, elements.goalEdit, elements.goalToggle, elements.goalDialogClear]) button.disabled = disabled;
  elements.goalDialogClear.hidden = !goal || goal.status === 'active';
  elements.goalObjective.disabled = state.goalBusy;
  elements.goalSave.disabled = state.goalBusy || !elements.goalObjective.value.trim();
  elements.goalSave.textContent = goal && goal.status !== 'active' ? '保存并恢复' : '保存';
  elements.goalCancel.disabled = state.goalBusy;
  if (elements.goalDialog.open && editorThreadId !== state.selectedId) elements.goalDialog.close();
  if (!goal) return;
  elements.goalStatus.textContent = labels[goal.status] || '目标';
  elements.goalObjectiveSummary.textContent = goal.objective;
  elements.goalSummary.title = goal.objective;
  elements.goalUsage.textContent = goalUsage(goal);
  const pause = goal.status === 'active';
  elements.goalToggle.hidden = !pause && !resumable.has(goal.status);
  const label = pause ? '暂停目标' : '恢复目标';
  if (elements.goalToggle.getAttribute('aria-label') !== label || !elements.goalToggle.firstChild) {
    elements.goalToggle.title = label;
    elements.goalToggle.setAttribute('aria-label', label);
    elements.goalToggle.innerHTML = pause ?
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>' :
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>';
  }
}

function openEditor() {
  if (!state.selectedId || state.goalBusy || state.goalSupported === false) return;
  editorThreadId = state.selectedId;
  const goal = state.goal?.status === 'complete' ? null : state.goal;
  elements.goalDialogTitle.textContent = goal ? '编辑目标' : '目标';
  elements.goalObjective.value = goal?.objective || '';
  elements.goalDialogError.hidden = true;
  renderGoal();
  elements.goalDialog.showModal();
  elements.goalObjective.focus();
}

export async function submitGoal(objective, { replace = false, fromDialog = false } = {}) {
  const id = state.selectedId;
  const text = objective.trim();
  if (!id || !text || state.goalBusy || state.sending || state.stopping) return false;
  if (replace && state.goal && state.goal.objective !== text &&
      !window.confirm('替换当前目标吗？这会保留聊天，但会用输入框中的文本替换已保存的目标。')) return false;
  const options = selectedTurnOptions();
  const pendingMessage = elements.messageInput.value;
  const draft = isDraft(id) ? state.drafts.find((entry) => entry.id === id) : null;
  if (isDraft(id) && !draft) return false;
  state.goalBusy = true;
  state.goalEpoch++;
  renderGoal();
  callbacks.updateComposerAction();
  let targetId = id;
  try {
    const result = await api(draft && !draft.threadId ? '/api/threads' :
      '/api/threads/' + (draft?.threadId || id) + '/goal', {
      method: 'POST', body: JSON.stringify(draft && !draft.threadId ?
        { cwd: draft.cwd, goal: text, ...options } : { objective: text, ...options }),
    });
    if (draft && result.thread) {
      draft.threadId = result.thread.id;
      draft.thread = result.thread;
      saveDrafts();
    }
    if (result.turnError || !result.goal) throw new Error(result.turnError || 'Desktop 未确认目标，请重试');
    if (draft) {
      const thread = result.thread || draft.thread;
      const nextMessage = state.selectedId === id ? elements.messageInput.value : null;
      targetId = thread.id;
      state.drafts = state.drafts.filter((entry) => entry.id !== id);
      saveDrafts();
      state.threads = [thread, ...state.threads.filter((entry) => entry.id !== thread.id)];
      if (state.selectedId === id) {
        await callbacks.selectThread(thread.id);
        if (state.selectedId === thread.id && nextMessage !== null &&
            (nextMessage !== pendingMessage || !/^\/goal(?:\s|$)/.test(nextMessage.trim()))) elements.messageInput.value = nextMessage;
      }
    }
    if (state.selectedId === targetId) {
      state.goal = result.goal;
      state.completedGoal = null;
      state.goalError = null;
      state.permissionDirty = false;
      state.selectionDirty = false;
      // 只清除本次已提交的命令，保留请求等待期间新输入的文字。
      if (elements.messageInput.value === pendingMessage && /^\/goal(?:\s|$)/.test(pendingMessage.trim())) elements.messageInput.value = '';
      if (fromDialog && elements.goalDialog.open) elements.goalDialog.close();
      clearNotice('action');
    }
    return true;
  } catch (error) {
    if (state.selectedId === id) {
      if (fromDialog) {
        elements.goalDialogError.textContent = error.message;
        elements.goalDialogError.hidden = false;
      } else showNotice('设置目标失败：' + error.message);
    }
    return false;
  } finally {
    state.goalBusy = false;
    state.goalEpoch++;
    renderGoal();
    callbacks.updateComposerAction();
    callbacks.refresh();
  }
}

async function changeGoal(clear = false) {
  const id = state.selectedId;
  if (!id || state.goalBusy || !state.goal || state.goal.status === 'complete') return;
  if (clear && !window.confirm('清除目标吗？聊天记录会保留。')) return;
  const fromDialog = clear && elements.goalDialog.open && editorThreadId === id;
  if (fromDialog) elements.goalDialogError.hidden = true;
  const status = state.goal?.status === 'active' ? 'paused' : 'active';
  state.goalBusy = true;
  state.goalEpoch++;
  renderGoal();
  callbacks.updateComposerAction();
  try {
    const result = await api('/api/threads/' + id + '/goal' + (clear ? '/clear' : ''), {
      method: 'POST', body: JSON.stringify(clear ? {} :
        { status, ...(status === 'active' ? selectedTurnOptions() : {}) }),
    });
    if (state.selectedId === id) {
      state.goal = clear ? null : result.goal;
      state.completedGoal = null;
      state.goalError = null;
      if (fromDialog && elements.goalDialog.open) elements.goalDialog.close();
      clearNotice('action');
    }
  } catch (error) {
    if (state.selectedId === id) {
      if (fromDialog) {
        elements.goalDialogError.textContent = error.message;
        elements.goalDialogError.hidden = false;
      } else showNotice(error.message);
    }
  } finally {
    state.goalBusy = false;
    state.goalEpoch++;
    renderGoal();
    callbacks.updateComposerAction();
    callbacks.refresh();
  }
}

export function initGoals(actions) {
  callbacks = actions;
  for (const button of [elements.goalTrigger, elements.goalSummary, elements.goalEdit]) button.addEventListener('click', openEditor);
  elements.goalClear.addEventListener('click', () => void changeGoal(true));
  elements.goalDialogClear.addEventListener('click', () => void changeGoal(true));
  elements.goalToggle.addEventListener('click', () => void changeGoal());
  elements.goalCancel.addEventListener('click', () => elements.goalDialog.close());
  elements.goalDialog.addEventListener('cancel', (event) => { if (state.goalBusy) event.preventDefault(); });
  elements.goalObjective.addEventListener('input', renderGoal);
  elements.goalForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (editorThreadId === state.selectedId) void submitGoal(elements.goalObjective.value, { fromDialog: true });
  });
}
