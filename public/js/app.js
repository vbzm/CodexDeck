import { elements, state, api, isDraft, saveDrafts, showNotice, clearNotice, loadHealth,
  projectForCwd } from './core.js';
import { initSidebar, loadProjects, loadProjectThreads, loadThreads, loadUnread,
  renderThreadList, selectThread } from './sidebar.js';
import { loadOlderTurns, loadSelected, renderHeader, renderMessages, updateComposerAction, updateScrollToBottom, updateTurnStatuses, jumpToPreviousQuestion } from './conversation.js';
import { initSettings, loadModels, selectedTurnOptions } from './settings.js';
import { initProjectDialog } from './project-dialog.js';
import { loadApprovals } from './approvals.js';
import { initGoals, submitGoal, renderGoal } from './goals.js';

window.addEventListener('codexdeck-questions-answered', (event) => {
  if (event.detail?.threadId === state.selectedId) void loadSelected({ force: true });
  void loadThreads(true);
});

const APP_READY_EVENT = 'codexdeck-app-ready';

function openGatewaySettings() {
  window.location.assign('codexdeck-app://switch-gateway');
}

function initAppBridge() {
  const enable = () => {
    if (!window.__codexDeckAppReady || !elements.gatewaySwitch ||
        elements.gatewaySwitch.dataset.ready === '1') return;
    elements.gatewaySwitch.hidden = false;
    elements.gatewaySwitch.dataset.ready = '1';
    elements.gatewaySwitch.addEventListener('click', openGatewaySettings);
  };
  window.addEventListener(APP_READY_EVENT, enable);
  enable();
}

function syncNativeStatusBar(theme) {
  // HBuilderX App 的状态栏由原生层绘制，网页主题变化时同步颜色和文字亮度。
  const navigator = window.plus?.navigator;
  if (!navigator) return;
  try {
    const dark = theme === 'dark';
    navigator.setStatusBarBackground(dark ? '#191a1b' : '#f7f7f5');
    navigator.setStatusBarStyle(dark ? 'light' : 'dark');
  } catch {
    // 普通浏览器或受限 WebView 没有状态栏 API 时不影响网页使用。
  }
}

window.addEventListener('plusready', () =>
  syncNativeStatusBar(document.documentElement.dataset.theme), { once: true });

function initMobileViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const mobile = window.matchMedia('(max-width: 700px)');
  const style = document.documentElement.style;
  const input = elements.messageInput;
  const ios = /iP(?:hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) input.addEventListener('touchend', (event) => {
    if (!mobile.matches || input.disabled || event.changedTouches.length !== 1 || event.touches.length) return;
    const focused = document.activeElement === input;
    const keyboardClosed = viewport.height >= document.documentElement.clientHeight - 2;
    if (focused && !keyboardClosed) return;
    // iPhone 点按的默认聚焦会先上滚整页；在同一次触摸里主动聚焦，要求浏览器保留页面位置。
    // 键盘已打开时让原生事件继续处理光标定位、长按和文字选择。
    event.preventDefault();
    if (focused) input.blur();
    input.focus({ preventScroll: true });
  }, { passive: false });
  const update = () => {
    if (!mobile.matches) {
      style.removeProperty('--mobile-height');
      return;
    }
    if (Math.abs(viewport.scale - 1) > 0.01) return;
    const height = viewport.height + 'px';
    if (style.getPropertyValue('--mobile-height') !== height) {
      const box = elements.messages;
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
      const previousScroll = box.scrollTop;
      // iPhone 键盘只缩小可见视口，100dvh 仍是整屏高度；先收缩页面，避免系统把整页上滚。
      style.setProperty('--mobile-height', height);
      box.scrollTop = nearBottom ? box.scrollHeight : previousScroll;
      updateScrollToBottom();
    }
    // 真机仍可能保留聚焦产生的整页滚动；只归零外层页面，不补偿 offsetTop 或移动标题。
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  window.addEventListener('scroll', update);
  window.addEventListener(APP_READY_EVENT, update);
  mobile.addEventListener('change', update);
  update();
}

initMobileViewport();
initSidebar();
initSettings();
initProjectDialog();
initAppBridge();
initGoals({ selectThread, updateComposerAction, refresh() {
  void loadSelected();
  void loadThreads(true);
  for (const id of state.expandedProjects) void loadProjectThreads(id);
} });

elements.olderTurns.addEventListener('click', loadOlderTurns);
elements.messages.addEventListener('scroll', updateScrollToBottom);
elements.previousQuestion.addEventListener('click', () => void jumpToPreviousQuestion());
elements.scrollToBottom.addEventListener('click', () =>
  elements.messages.scrollTo({ top: elements.messages.scrollHeight, behavior: 'smooth' }));
elements.messageInput.addEventListener('input', () => {
  const draft = state.drafts.find((entry) => entry.id === state.selectedId);
  if (draft) {
    draft.text = elements.messageInput.value;
    saveDrafts();
  }
  updateComposerAction();
  renderGoal();
});

async function stopTurn() {
  if (!state.selectedId || isDraft(state.selectedId) || state.stopping) return;
  const id = state.selectedId;
  state.stoppingThreads.add(id);
  state.goalEpoch++;
  renderGoal();
  updateComposerAction();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    await api('/api/threads/' + id + '/interrupt', { method: 'POST', body: '{}', signal: controller.signal });
    clearTimeout(timer);
    if (state.selectedId === id) await loadSelected({ force: true });
    void loadThreads(true);
    if (state.selectedId === id) clearNotice('action');
  } catch (error) {
    if (state.selectedId === id) showNotice(controller.signal.aborted ?
      '停止请求超时，尚未确认是否已停止，请检查当前回合状态后重试。' : '停止失败：' + error.message);
  } finally {
    clearTimeout(timer);
    state.stoppingThreads.delete(id);
    if (state.selectedId === id) state.goalEpoch++;
    renderGoal();
    updateComposerAction();
  }
}

async function sendMessage() {
  const selectedId = state.selectedId;
  const message = elements.messageInput.value.trim();
  if (!selectedId || !message || state.sending) return;
  state.sending = true;
  renderGoal();
  updateComposerAction();
  try {
    const options = selectedTurnOptions();
    let sentThreadId = selectedId;
    let sentCwd = state.selectedThread?.cwd;
    if (isDraft(selectedId)) {
      const draft = state.drafts.find((entry) => entry.id === selectedId);
      if (!draft) throw new Error('新对话草稿已不存在');
      const result = await api(draft.threadId ? '/api/threads/' + draft.threadId + '/turns' : '/api/threads', {
        method: 'POST',
        body: JSON.stringify({ cwd: draft.cwd, text: message, ...options }),
      });
      if (result.thread) {
        draft.threadId = result.thread.id;
        draft.thread = result.thread;
      }
      if (result.turnError || !result.turn?.id) {
        // Desktop 已创建聊天但首条消息尚未发出时，保留草稿和聊天 ID 供原地重试。
        draft.text = message;
        saveDrafts();
        showNotice('首条消息未发送：' + (result.turnError || 'Desktop 未确认回合，请重试'));
        return;
      }
      const thread = result.thread || draft.thread;
      if (!thread?.id) throw new Error('Desktop 未返回新对话 ID');
      // thread/start 的返回值早于首个 turn/start，先用本次选择保持控件显示一致。
      if (options.model) thread.model = options.model;
      if (options.effort) thread.reasoningEffort = options.effort;
      thread.status = { type: 'active' };
      state.drafts = state.drafts.filter((entry) => entry.id !== draft.id);
      saveDrafts();
      state.threads = state.threads.filter((entry) => entry.id !== thread.id);
      state.threads.unshift(thread);
      sentThreadId = thread.id;
      sentCwd = thread.cwd;
      const project = projectForCwd(thread.cwd);
      const record = project && state.projectThreads.get(project.id);
      if (record?.loaded) {
        record.threads = record.threads.filter((entry) => entry.id !== thread.id);
        record.threads.unshift(thread);
      }
      if (state.selectedId === selectedId) {
        await selectThread(thread.id);
        if (state.selectedId === thread.id) {
          state.turns.set(result.turn.id, result.turn);
          elements.messageInput.value = '';
          renderMessages();
        }
      }
    } else {
      const result = await api('/api/threads/' + selectedId + '/turns', {
        method: 'POST',
        body: JSON.stringify({ text: message, ...options }),
      });
      if (state.selectedId === selectedId) {
        elements.messageInput.value = '';
        if (result.turn) state.turns.set(result.turn.id, result.turn);
      }
    }
    if (state.selectedId === sentThreadId) {
      state.permissionDirty = false;
      state.selectedThread.status = { type: 'active' };
      state.selectionDirty = false;
      renderHeader();
      void loadSelected();
    }
    renderThreadList();
    void loadThreads(true);
    const project = projectForCwd(sentCwd);
    if (project && state.expandedProjects.has(project.id)) void loadProjectThreads(project.id);
    clearNotice('action');
  } catch (error) {
    showNotice(error.message);
  } finally {
    state.sending = false;
    renderGoal();
    updateComposerAction();
  }
}

elements.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  if (/^\/goal(?:\s|$)/.test(elements.messageInput.value.trim())) {
    const objective = elements.messageInput.value.trim().slice(5).trim();
    if (objective) void submitGoal(objective, { replace: true });
    else showNotice('请输入目标，例如 /goal 完成网页的目标功能');
  } else if (state.selectedThread?.status?.type === 'active') void stopTurn();
  else void sendMessage();
});
elements.messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#191a1b' : '#f7f7f5';
  syncNativeStatusBar(theme);
  localStorage.setItem('codexDeckTheme', theme);
  elements.themeToggle.setAttribute('aria-label', theme === 'dark' ? '切换浅色主题' : '切换深色主题');
}

let savingTheme = false;
let syncingTheme = false;
let themeEpoch = 0;
async function syncTheme() {
  if (savingTheme || syncingTheme) return;
  syncingTheme = true;
  const epoch = themeEpoch;
  try {
    const result = await api('/api/theme');
    if (epoch === themeEpoch && !savingTheme && (result.theme === 'dark' || result.theme === 'light')) {
      applyTheme(result.theme);
    }
  } catch {
    // 网关暂不可用时保持本地主题；连接恢复后继续同步。
  } finally {
    syncingTheme = false;
  }
}

applyTheme(document.documentElement.dataset.theme);
elements.themeToggle.addEventListener('click', async () => {
  if (savingTheme) return;
  const previous = document.documentElement.dataset.theme;
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  themeEpoch++;
  applyTheme(next);
  savingTheme = true;
  try {
    await api('/api/theme', { method: 'POST', body: JSON.stringify({ theme: next }) });
  } catch (error) {
    applyTheme(previous);
    showNotice('主题同步失败：' + error.message);
  } finally {
    savingTheme = false;
  }
});
elements.authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  sessionStorage.setItem('gatewayToken', elements.tokenInput.value);
  elements.tokenInput.value = '';
  elements.authPanel.hidden = true;
  await Promise.all([loadHealth(), loadModels(), loadProjects(), loadThreads(true), loadUnread(), loadApprovals()]);
});

if (isDraft(state.selectedId) && state.drafts.some((draft) => draft.id === state.selectedId)) {
  void selectThread(state.selectedId);
}
void loadHealth();
void loadModels();
void loadProjects();
void loadThreads(true);
void loadUnread();
void loadApprovals();
void syncTheme();
setInterval(loadHealth, 5000);
setInterval(() => loadThreads(true), 12000);
setInterval(() => loadUnread(), 12000);
setInterval(() => {
  for (const id of state.expandedProjects) void loadProjectThreads(id);
}, 12000);
setInterval(loadSelected, 2500);
setInterval(loadApprovals, 2000);
setInterval(syncTheme, 2000);
setInterval(updateTurnStatuses, 1000);
setInterval(renderGoal, 1000);
let lastResume = 0;
function refreshAfterResume(event) {
  if ((document.hidden && event?.type !== 'codexdeck-app-resume') || Date.now() - lastResume < 500) return;
  lastResume = Date.now();
  // 先显示当前对话的同步状态，再并行刷新其它页面信息。
  void loadSelected({ force: true, feedback: true });
  void loadHealth();
  void loadModels();
  void loadProjects();
  void loadThreads(true);
  void loadUnread();
  for (const id of state.expandedProjects) void loadProjectThreads(id);
  void loadApprovals();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshAfterResume();
});
// App-PLUS 的原生恢复事件覆盖部分不会触发 visibilitychange 的 WebView。
document.addEventListener('resume', refreshAfterResume);
window.addEventListener('codexdeck-app-resume', refreshAfterResume);
window.addEventListener('pageshow', (event) => {
  if (event.persisted) refreshAfterResume();
});
