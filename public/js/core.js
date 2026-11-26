import { configureMarkdownImages } from './images.js';

export const elements = Object.fromEntries([
  'connection', 'menuButton', 'sidebar', 'sidebarBackdrop', 'threadList', 'activeList',
  'closeSidebar', 'projectList', 'projectCount', 'activeCount', 'threadContext',
  'refreshThreads', 'recentNewThread', 'sidebarResizer', 'moreThreads', 'newThread', 'threadTitle', 'threadMeta', 'notice',
  'olderTurns', 'messages', 'scrollToBottom', 'previousQuestion', 'approvalSection', 'approvalList', 'composer', 'messageInput',
  'sendMessage', 'addButton', 'permissionTrigger', 'permissionPopover', 'permissionLabel',
  'authPanel', 'authForm', 'tokenInput', 'newProject', 'projectDialog',
  'projectForm', 'projectName', 'projectPath', 'projectError', 'cancelProject',
  'createProject', 'themeToggle', 'browseProject', 'directoryDialog', 'directoryList',
  'directoryCurrent', 'directoryUp', 'directorySelect', 'directoryCancel', 'directoryError',
  'activeToggle', 'projectToggle', 'recentToggle', 'activeContent', 'projectContent',
  'recentContent', 'settingsTrigger', 'settingsPopover', 'modelLabel', 'effortLabel',
  'settingsMain', 'modelChoice', 'modelMenu', 'modelBack', 'effortSlider', 'effortValue', 'effortTicks',
  'resetSettings', 'contextButton', 'contextRing', 'contextPercent', 'contextUsage',
  'gatewaySwitch',
  'goalBar', 'goalSummary', 'goalStatus', 'goalObjectiveSummary', 'goalUsage', 'goalToggle',
  'goalClear', 'goalEdit', 'goalTrigger', 'goalError', 'goalDialog', 'goalForm',
  'goalDialogTitle', 'goalObjective', 'goalSave', 'goalCancel', 'goalDialogClear', 'goalDialogError',
].map((id) => [id, document.getElementById(id)]));

let savedDrafts = [];
try {
  const parsed = JSON.parse(sessionStorage.getItem('codexDeckDrafts') || '[]');
  if (Array.isArray(parsed)) savedDrafts = parsed.filter((draft) =>
    typeof draft.id === 'string' && draft.id.startsWith('draft-') && typeof draft.cwd === 'string' &&
    (draft.hidden === true || (typeof draft.text === 'string' && draft.text.trim())));
} catch {
  sessionStorage.removeItem('codexDeckDrafts');
}

let savedPermissionMode = null;
try { savedPermissionMode = globalThis.localStorage?.getItem('codexDeckNewPermissionMode'); } catch { /* 使用默认权限。 */ }
const newPermissionMode = ['request', 'auto', 'full'].includes(savedPermissionMode) ? savedPermissionMode : 'request';

export const state = {
  threads: [],
  drafts: savedDrafts,
  threadCursor: null,
  visibleRecent: 12,
  projects: [],
  projectThreads: new Map(),
  expandedProjects: new Set(),
  collapsedSections: new Set(),
  unread: new Set(),
  selectedId: sessionStorage.getItem('selectedThreadId'),
  selectedThread: null,
  usage: null,
  goal: null,
  completedGoal: null,
  goalSupported: null,
  goalError: null,
  goalBusy: false,
  goalEpoch: 0,
  compactions: [],
  turns: new Map(),
  agentActivity: new Map(),
  agentActivityLoading: false,
  olderCursor: null,
  historyInitialized: false,
  historyLoading: false,
  loadingSelected: false,
  loadingThreads: false,
  loadingProjects: false,
  sending: false,
  stoppingThreads: new Set(),
  get stopping() { return this.stoppingThreads.has(this.selectedId); },
  initialHistory: true,
  noticeSource: null,
  desktopConnected: null,
  approvals: [],
  retryingTurns: new Map(),
  workspace: null,
  preferredCwd: null,
  models: [],
  defaults: { model: null, effort: null },
  selection: { model: null, effort: null, isDefault: false },
  selectionDirty: false,
  newPermissionMode,
  permissionMode: newPermissionMode,
  permissionLabel: null,
  permissionDirty: false,
  permissionEpoch: 0,
};

export const markdown = window.markdownit({ html: false, linkify: true, breaks: true });
configureMarkdownImages(markdown);
const defaultLinkOpen = markdown.renderer.rules.link_open ||
  ((tokens, index, options, env, self) => self.renderToken(tokens, index, options, env, self));
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, index, options, env, self);
};

export function isDraft(id) {
  return id?.startsWith('draft-');
}

export function saveDrafts() {
  sessionStorage.setItem('codexDeckDrafts', JSON.stringify(state.drafts));
}

export function showNotice(message, source = 'action') {
  state.noticeSource = source;
  elements.notice.textContent = message;
  elements.notice.hidden = false;
}

export function clearNotice(source = null) {
  if (source && state.noticeSource !== source) return;
  state.noticeSource = null;
  elements.notice.hidden = true;
  elements.notice.textContent = '';
}

function showAuth() {
  elements.authPanel.hidden = false;
  elements.tokenInput.focus();
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = sessionStorage.getItem('gatewayToken');
  if (token) headers.Authorization = 'Bearer ' + token;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { ...options, headers, cache: 'no-store' });
  let result = {};
  try {
    result = await response.json();
  } catch {
    throw new Error('网关返回了无效响应');
  }
  if (response.status === 401) showAuth();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}

export async function loadHealth() {
  try {
    const result = await api('/api/health');
    state.workspace = result.workspace || null;
    state.desktopConnected = Boolean(result.connected);
    elements.connection.classList.toggle('offline', !result.connected);
    elements.connection.textContent = result.connected ? '桌面已连接' : '桌面未连接';
    clearNotice('health');
  } catch (error) {
    state.desktopConnected = false;
    elements.connection.classList.add('offline');
    elements.connection.textContent = '桌面未连接';
    if (elements.authPanel.hidden) showNotice(error.message, 'health');
  }
}

export function threadName(thread) {
  return thread.name || thread.preview || (isDraft(thread.id) ? '新对话' : '未命名聊天');
}

function normalizedCwd(value) {
  return String(value || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
}

export function projectForCwd(cwd) {
  const target = normalizedCwd(cwd);
  let match = null;
  let longest = 0;
  for (const project of state.projects) {
    for (const root of project.roots || []) {
      const rootPath = normalizedCwd(root.path);
      if (rootPath.length > longest && (target === rootPath || target.startsWith(rootPath + '\\'))) {
        match = project;
        longest = rootPath.length;
      }
    }
  }
  return match;
}

export function threadLocation(thread) {
  return (thread.cwd || '').split(/[\\/]/).filter(Boolean).slice(-1)[0] || '本机';
}

export function findThread(id) {
  const draft = state.drafts.find((entry) => entry.id === id);
  if (draft) return draft;
  const recent = state.threads.find((thread) => thread.id === id);
  if (recent) return recent;
  for (const record of state.projectThreads.values()) {
    const thread = record.threads.find((entry) => entry.id === id);
    if (thread) return thread;
  }
  return null;
}
