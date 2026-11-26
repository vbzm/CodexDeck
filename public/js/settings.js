import { api, elements, state, isDraft, saveDrafts, showNotice, clearNotice } from './core.js';

const effortOrder = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const effortNames = { low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: '极致' };
const permissionNames = { request: '请求批准', auto: '帮我批准', full: '完全访问权限' };

function modelById(id) {
  return state.models.find((model) => model.id === id);
}

function shortModel(id) {
  const name = modelById(id)?.displayName || id || '模型 —';
  return name.replace(/^GPT-/i, '').replace(/-/g, ' ');
}

function supportedEfforts(model) {
  return [...(model?.supportedReasoningEfforts || [])]
    .sort((a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b));
}

export function syncSelectionFromThread(thread, force = false) {
  if (state.selectionDirty && !force) return;
  const modelId = thread && !isDraft(thread.id) ? thread.model || state.defaults.model : state.defaults.model;
  const model = modelById(modelId);
  const supported = supportedEfforts(model);
  const wanted = thread && !isDraft(thread.id) ? thread.reasoningEffort : state.defaults.effort;
  const effort = supported.includes(wanted) ? wanted :
    (supported.includes(model?.defaultReasoningEffort) ? model.defaultReasoningEffort : supported[0]);
  state.selection = { model: modelId, effort, isDefault: false };
  if (force) state.selectionDirty = false;
  renderSettings();
}

export async function loadModels() {
  try {
    const result = await api('/api/models');
    state.models = result.models || [];
    state.defaults = result.defaults || { model: null, effort: null };
    syncSelectionFromThread(state.selectedThread);
  } catch (error) {
    if (elements.authPanel.hidden) showNotice(error.message, 'models');
  }
}

export function selectedTurnOptions() {
  const { model, effort } = state.selection;
  return { ...(model && effort ? { model, effort } : {}),
    ...((isDraft(state.selectedId) || state.permissionDirty) && state.permissionMode ?
      { permissionMode: state.permissionMode } : {}) };
}

export async function loadPermissionMode(threadId) {
  const epoch = state.permissionEpoch;
  try {
    const current = await api('/api/threads/' + threadId + '/permissions');
    if (threadId !== state.selectedId || epoch !== state.permissionEpoch || state.permissionDirty) return;
    const sandbox = current.sandbox?.type;
    const full = sandbox === 'dangerFullAccess' && current.approvalPolicy === 'never';
    const auto = sandbox === 'workspaceWrite' && current.approvalPolicy === 'on-request' &&
      current.approvalsReviewer === 'auto_review';
    const request = sandbox === 'workspaceWrite' && current.approvalPolicy === 'on-request' &&
      current.approvalsReviewer === 'user';
    state.permissionMode = full ? 'full' : auto ? 'auto' : request ? 'request' : null;
    state.permissionLabel = state.permissionMode ? null :
      sandbox === 'readOnly' ? '只读权限' : '自定义权限';
    renderPermission();
    clearNotice('permissions');
  } catch (error) {
    if (threadId === state.selectedId && epoch === state.permissionEpoch && !state.permissionDirty) {
      state.permissionLabel = '权限读取失败';
      renderPermission();
      if (elements.authPanel.hidden) showNotice(error.message, 'permissions');
    }
  }
}

function renderPermission() {
  const mode = state.permissionMode;
  elements.permissionLabel.textContent = permissionNames[mode] || state.permissionLabel || '读取权限…';
  elements.permissionTrigger.dataset.mode = mode || 'other';
  elements.permissionTrigger.title = mode ? '选择权限设置' :
    '当前权限来自 Codex Desktop；选择新权限后将在下次发送时应用';
  for (const option of elements.permissionPopover.querySelectorAll('.permission-option')) {
    option.setAttribute('aria-checked', String(option.dataset.permissionMode === mode));
  }
}

function renderModelMenu() {
  elements.modelMenu.replaceChildren(elements.modelBack);
  const options = [{ id: null, displayName: '默认', hint: '当前 Desktop 默认模型' }, ...state.models];
  for (const model of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'model-option';
    const name = document.createElement('strong');
    name.textContent = model.id ? shortModel(model.id) : '默认';
    const hint = document.createElement('small');
    hint.textContent = model.hint || '';
    const check = document.createElement('span');
    check.className = 'model-check';
    check.textContent = (model.id === state.selection.model && !state.selection.isDefault) ||
      (!model.id && state.selection.isDefault) ? '✓' : '';
    button.append(name, hint, check);
    button.addEventListener('click', () => {
      const nextId = model.id || state.defaults.model;
      const next = modelById(nextId);
      const supported = supportedEfforts(next);
      const effort = supported.includes(state.selection.effort) ? state.selection.effort :
        (supported.includes(next?.defaultReasoningEffort) ? next.defaultReasoningEffort : supported[0]);
      state.selection = { model: nextId, effort, isDefault: !model.id };
      state.selectionDirty = true;
      elements.modelMenu.hidden = true;
      elements.settingsMain.hidden = false;
      renderSettings();
    });
    elements.modelMenu.append(button);
  }
}

function formatTokens(count) {
  return count >= 1000 ? Math.round(count / 1000) + 'k' : String(count);
}

export function renderSettings() {
  renderPermission();
  const { model, effort } = state.selection;
  const supported = supportedEfforts(modelById(model));
  const index = Math.max(0, supported.indexOf(effort));
  elements.modelLabel.textContent = state.selection.isDefault ? '默认' : shortModel(model);
  elements.effortLabel.textContent = effortNames[effort] || '思考 —';
  elements.modelChoice.textContent = (state.selection.isDefault ? '默认' : shortModel(model)) + ' ›';
  elements.effortValue.textContent = effortNames[effort] || '—';
  elements.effortSlider.max = String(Math.max(0, supported.length - 1));
  elements.effortSlider.value = String(index);
  elements.effortSlider.disabled = supported.length < 2;
  elements.effortSlider.style.setProperty('--effort-progress',
    supported.length > 1 ? `${index / (supported.length - 1) * 100}%` : '0%');
  elements.effortTicks.replaceChildren(...supported.map((name) => {
    const tick = document.createElement('span');
    tick.title = effortNames[name] || name;
    return tick;
  }));
  renderModelMenu();
  elements.settingsTrigger.disabled = !state.models.length;

  const used = state.usage?.lastInputTokens;
  const limit = state.usage?.modelContextWindow;
  const known = Number.isFinite(used) && Number.isFinite(limit) && limit > 0;
  const percent = known ? Math.max(0, Math.min(100, Math.round(used / limit * 100))) : 0;
  elements.contextRing.style.setProperty('--context-percent', percent + '%');
  elements.contextPercent.textContent = known ? percent + '% 已用' : '暂无用量';
  elements.contextUsage.textContent = known ?
    `已用 ${formatTokens(used)} 标记，共 ${formatTokens(limit)}` : '发送消息后显示上下文用量';
  elements.contextButton.setAttribute('aria-label', known ?
    `背景信息窗口：${percent}% 已用，已用 ${formatTokens(used)} 标记，共 ${formatTokens(limit)}` :
    '背景信息窗口：暂无用量');
}

export function initSettings() {
  elements.permissionTrigger.addEventListener('click', () => {
    elements.permissionPopover.hidden = !elements.permissionPopover.hidden;
    elements.permissionTrigger.setAttribute('aria-expanded', String(!elements.permissionPopover.hidden));
    elements.settingsPopover.hidden = true;
  });
  for (const option of elements.permissionPopover.querySelectorAll('.permission-option')) {
    option.addEventListener('click', () => {
      state.permissionMode = option.dataset.permissionMode;
      state.permissionLabel = null;
      state.permissionDirty = true;
      state.permissionEpoch++;
      state.newPermissionMode = state.permissionMode;
      localStorage.setItem('codexDeckNewPermissionMode', state.permissionMode);
      const draft = state.drafts.find((entry) => entry.id === state.selectedId);
      if (draft) {
        draft.permissionMode = state.permissionMode;
        saveDrafts();
      }
      renderPermission();
      elements.permissionPopover.hidden = true;
      elements.permissionTrigger.setAttribute('aria-expanded', 'false');
      elements.permissionTrigger.focus();
    });
  }
  elements.settingsTrigger.addEventListener('click', () => {
    elements.settingsPopover.hidden = !elements.settingsPopover.hidden;
    elements.settingsMain.hidden = false;
    elements.modelMenu.hidden = true;
    elements.permissionPopover.hidden = true;
    elements.permissionTrigger.setAttribute('aria-expanded', 'false');
    renderSettings();
  });
  elements.modelChoice.addEventListener('click', () => {
    elements.settingsMain.hidden = true;
    elements.modelMenu.hidden = false;
  });
  elements.modelBack.addEventListener('click', () => {
    elements.modelMenu.hidden = true;
    elements.settingsMain.hidden = false;
  });
  elements.effortSlider.addEventListener('input', () => {
    const supported = supportedEfforts(modelById(state.selection.model));
    state.selection.effort = supported[Number(elements.effortSlider.value)] || supported[0];
    state.selection.isDefault = false;
    state.selectionDirty = true;
    renderSettings();
  });
  elements.resetSettings.addEventListener('click', () => {
    syncSelectionFromThread(state.selectedThread, true);
  });
  document.addEventListener('click', (event) => {
    // 选择模型会重建按钮节点；用原始事件路径判断，避免把这次点击误认成弹层外点击。
    const path = event.composedPath();
    if (!path.includes(elements.settingsPopover) && !path.includes(elements.settingsTrigger)) {
      elements.settingsPopover.hidden = true;
    }
    if (!path.includes(elements.permissionPopover) && !path.includes(elements.permissionTrigger)) {
      elements.permissionPopover.hidden = true;
      elements.permissionTrigger.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      elements.settingsPopover.hidden = true;
      elements.permissionPopover.hidden = true;
      elements.permissionTrigger.setAttribute('aria-expanded', 'false');
    }
  });
}
