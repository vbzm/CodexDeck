import { elements, state, api, isDraft, saveDrafts, showNotice, clearNotice, threadName, threadLocation, projectForCwd, findThread } from './core.js';
import { renderHeader, renderMessages, loadSelected, updateComposerAction } from './conversation.js';
import { loadPermissionMode, syncSelectionFromThread } from './settings.js';

function isPendingThread(thread) {
  return state.drafts.some((draft) => draft.threadId === thread.id);
}

function discardDraft(id) {
  const draft = state.drafts.find((entry) => entry.id === id);
  if (!draft) return;
  if (draft.text?.trim() && !window.confirm('丢弃这条尚未发送的消息？')) return;
  state.drafts = state.drafts.filter((entry) => entry.id !== id);
  saveDrafts();
  if (state.selectedId === id) void selectThread(null);
  else {
    renderThreadList();
    renderProjects();
  }
}

function threadRow(thread, nested = false) {
  const entry = document.createElement('div');
  entry.className = 'thread-entry';
  if (!nested) entry.setAttribute('role', 'listitem');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'thread-row' + (nested ? ' nested' : '');
  button.classList.toggle('selected', thread.id === state.selectedId);
  button.title = threadName(thread);
  const name = document.createElement('strong');
  const title = document.createElement('span');
  title.className = 'thread-name';
  title.textContent = threadName(thread);
  name.append(title);
  if (thread.status?.type === 'active') {
    const waiting = thread.status.activeFlags?.includes('waitingOnApproval') ||
      state.approvals.some((approval) => approval.threadId === thread.id);
    const spinner = document.createElement('span');
    spinner.className = 'running-spinner' + (waiting ? ' awaiting-approval' : '');
    spinner.setAttribute('aria-label', waiting ? '等待审批' : '进行中');
    spinner.title = waiting ? '等待审批' : '进行中';
    name.append(spinner);
  } else if (state.unread.has(thread.id)) {
    const unread = document.createElement('span');
    unread.className = 'unread-dot';
    unread.setAttribute('aria-label', '未读');
    name.append(unread);
  }
  const meta = document.createElement('small');
  meta.append(isDraft(thread.id) ? '未发送 · ' + threadLocation(thread) : threadLocation(thread));
  button.append(name, meta);
  button.addEventListener('click', () => selectThread(thread.id));
  entry.append(button);
  if (isDraft(thread.id)) {
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'thread-action';
    discard.textContent = '×';
    discard.setAttribute('aria-label', '丢弃新对话');
    discard.title = '丢弃新对话';
    discard.addEventListener('click', () => discardDraft(thread.id));
    entry.append(discard);
  }
  return entry;
}

export function renderThreadList() {
  const byId = new Map(state.threads.map((thread) => [thread.id, thread]));
  for (const record of state.projectThreads.values()) {
    for (const thread of record.threads) if (!byId.has(thread.id)) byId.set(thread.id, thread);
  }
  if (state.selectedThread && !isDraft(state.selectedThread.id)) byId.set(state.selectedThread.id, state.selectedThread);
  const active = [...byId.values()].filter((thread) => !isPendingThread(thread) && thread.status?.type === 'active')
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  elements.activeList.replaceChildren();
  elements.activeCount.textContent = active.length ? String(active.length) : '';
  for (const thread of active) elements.activeList.append(threadRow(thread));
  if (!active.length) {
    const empty = document.createElement('p');
    empty.className = 'project-empty';
    empty.textContent = '暂无进行中的对话';
    elements.activeList.append(empty);
  }

  elements.threadList.replaceChildren();
  const recent = state.threads.filter((thread) => !isPendingThread(thread) && thread.status?.type !== 'active');
  const visibleDrafts = state.drafts.filter((draft) => !draft.hidden);
  if (!recent.length && !visibleDrafts.length) {
    const empty = document.createElement('p');
    empty.className = 'project-empty';
    empty.textContent = '暂无最近对话';
    elements.threadList.append(empty);
  }
  for (const thread of [...visibleDrafts, ...recent.slice(0, state.visibleRecent)]) {
    elements.threadList.append(threadRow(thread));
  }
  const hasHidden = state.visibleRecent < recent.length;
  elements.moreThreads.hidden = !hasHidden && !state.threadCursor;
  elements.moreThreads.textContent = hasHidden ? '显示更多对话' : '加载更早的对话';
}

export function renderProjects() {
  elements.projectList.replaceChildren();
  elements.projectCount.textContent = state.projects.length ? String(state.projects.length) : '';
  if (!state.projects.length) {
    const empty = document.createElement('p');
    empty.className = 'project-empty';
    empty.textContent = '暂无已保存的项目';
    elements.projectList.append(empty);
  }
  for (const project of state.projects) {
    const expanded = state.expandedProjects.has(project.id);
    const record = state.projectThreads.get(project.id);
    const group = document.createElement('div');
    group.className = 'project-group';
    const head = document.createElement('div');
    head.className = 'project-head';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'project-toggle';
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.title = (project.roots || []).map((root) => root.path).join('\n');
    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.setAttribute('aria-hidden', 'true');
    const icon = document.createElement('span');
    icon.className = 'project-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3.5 6.5h6l2 2H20a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7.5a1 1 0 0 1 .5-1Z"/></svg>';
    const name = document.createElement('span');
    name.className = 'project-name';
    name.textContent = project.name || '未命名项目';
    toggle.append(chevron, icon, name);
    toggle.addEventListener('click', () => toggleProject(project.id));
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'project-create';
    create.textContent = '+';
    create.setAttribute('aria-label', '在 ' + name.textContent + ' 中新建对话');
    create.title = '在此项目中新建对话';
    create.disabled = !project.roots?.[0]?.path;
    create.addEventListener('click', () => startNewThread(project.roots[0].path));
    head.append(toggle, create);
    group.append(head);
    if (expanded) {
      const list = document.createElement('div');
      list.className = 'project-threads';
      const byId = new Map((record?.threads || []).filter((thread) => !isPendingThread(thread))
        .map((thread) => [thread.id, thread]));
      for (const draft of state.drafts) {
        if (!draft.hidden && projectForCwd(draft.cwd)?.id === project.id) byId.set(draft.id, draft);
      }
      if (state.selectedThread && !isDraft(state.selectedThread.id) &&
          projectForCwd(state.selectedThread.cwd)?.id === project.id) {
        byId.set(state.selectedThread.id, state.selectedThread);
      }
      const threads = [...byId.values()].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      const visibleThreads = threads.slice(0, record?.visibleCount ?? 12);
      // 从“最近”打开的旧对话仍需在项目中可见，但不展开它之前的全部历史。
      const selected = byId.get(state.selectedId);
      if (selected && !visibleThreads.includes(selected)) visibleThreads.push(selected);
      for (const thread of visibleThreads) list.append(threadRow(thread, true));
      if (!record?.loaded || !threads.length) {
        const hint = document.createElement('p');
        hint.className = 'project-empty';
        hint.textContent = record?.loaded ? '这个项目还没有对话' : '正在读取对话…';
        list.append(hint);
      }
      const hasHidden = visibleThreads.length < threads.length;
      if (record?.loaded && (hasHidden || [...record.cursors.values()].some(Boolean))) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'more-button';
        more.disabled = record.loading;
        more.textContent = record.loading ? '正在读取对话…' : hasHidden ? '显示更多对话' : '加载更早的对话';
        more.addEventListener('click', () => {
          if (hasHidden) {
            record.visibleCount = (record.visibleCount ?? 12) + 20;
            renderProjects();
          } else void loadProjectThreads(project.id, false);
        });
        list.append(more);
      }
      group.append(list);
    }
    elements.projectList.append(group);
  }
}

export async function loadProjects() {
  if (state.loadingProjects) return;
  state.loadingProjects = true;
  try {
    const result = await api('/api/projects');
    state.projects = (result.projects || []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    renderProjects();
    clearNotice('projects');
  } catch (error) {
    if (elements.authPanel.hidden) showNotice(error.message, 'projects');
  } finally {
    state.loadingProjects = false;
  }
}

export async function loadProjectThreads(projectId, reset = true) {
  const project = state.projects.find((entry) => entry.id === projectId);
  if (!project) return;
  const record = state.projectThreads.get(projectId) || { threads: [], cursors: new Map(), loaded: false, loading: false, visibleCount: 12 };
  if (record.loading) return;
  record.loading = true;
  state.projectThreads.set(projectId, record);
  renderProjects();
  const roots = (project.roots || []).map((root) => root.path).filter(Boolean);
  const requested = reset ? roots : roots.filter((cwd) => record.cursors.get(cwd));
  try {
    const pages = await Promise.all(requested.map(async (cwd) => {
      const query = new URLSearchParams({ limit: '50', cwd });
      if (!reset) query.set('cursor', record.cursors.get(cwd));
      return [cwd, await api('/api/threads?' + query)];
    }));
    const byId = new Map((reset ? [] : record.threads).map((thread) => [thread.id, thread]));
    if (reset) record.cursors = new Map();
    for (const [cwd, page] of pages) {
      for (const thread of page.threads) byId.set(thread.id, thread);
      record.cursors.set(cwd, page.nextCursor);
    }
    record.threads = [...byId.values()];
    record.loaded = true;
    if (!reset) record.visibleCount = (record.visibleCount ?? 12) + 20;
    renderThreadList();
    clearNotice('projects');
  } catch (error) {
    showNotice(error.message, 'projects');
  } finally {
    record.loading = false;
    renderProjects();
  }
}

function toggleProject(projectId) {
  if (state.expandedProjects.has(projectId)) state.expandedProjects.delete(projectId);
  else {
    state.expandedProjects.add(projectId);
    if (!state.projectThreads.get(projectId)?.loaded) void loadProjectThreads(projectId);
  }
  renderProjects();
}

export async function loadThreads(reset = true) {
  if (state.loadingThreads) return;
  state.loadingThreads = true;
  try {
    const query = new URLSearchParams({ limit: '50' });
    if (!reset && state.threadCursor) query.set('cursor', state.threadCursor);
    const result = await api('/api/threads?' + query);
    const byId = new Map((reset ? [] : state.threads).map((thread) => [thread.id, thread]));
    for (const thread of result.threads) byId.set(thread.id, thread);
    if (state.selectedThread && !isDraft(state.selectedId) && !byId.has(state.selectedId)) byId.set(state.selectedId, state.selectedThread);
    state.threads = [...byId.values()].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    state.threadCursor = result.nextCursor;
    renderThreadList();
    if (state.selectedId && !state.selectedThread) {
      const draft = state.drafts.find((entry) => entry.id === state.selectedId);
      if (draft) {
        await selectThread(draft.id);
        return;
      }
      const remembered = state.threads.find((thread) => thread.id === state.selectedId);
      if (remembered) await selectThread(remembered.id);
      else {
        try {
          const { thread } = await api('/api/threads/' + state.selectedId);
          state.threads.unshift(thread);
          await selectThread(thread.id);
        } catch {
          state.selectedId = null;
          sessionStorage.removeItem('selectedThreadId');
          renderThreadList();
        }
      }
    }
    clearNotice('threads');
  } catch (error) {
    if (elements.authPanel.hidden) showNotice(error.message, 'threads');
  } finally {
    state.loadingThreads = false;
  }
}

export function closeSidebar() {
  elements.sidebar.classList.remove('open');
  elements.sidebarBackdrop.hidden = true;
}

export async function selectThread(id) {
  const changed = state.selectedId !== id;
  const unloaded = !state.selectedThread;
  const previous = state.drafts.find((draft) => draft.id === state.selectedId);
  if (previous && previous.id !== id) {
    previous.text = elements.messageInput.value;
    saveDrafts();
  }
  if (state.selectedId !== id || !state.selectedThread) {
    state.turns = new Map();
    state.agentActivity = new Map();
    state.agentActivityLoading = false;
    state.usage = null;
    state.goal = null;
    state.completedGoal = null;
    state.goalError = null;
    state.goalEpoch++;
    state.compactions = [];
    state.olderCursor = null;
    state.historyInitialized = false;
    state.initialHistory = true;
    state.historyLoading = Boolean(id && !isDraft(id));
  }
  state.selectedId = id;
  state.selectedThread = id ? findThread(id) : null;
  if (changed || !state.selection.model) syncSelectionFromThread(state.selectedThread, true);
  if (changed || unloaded) {
    clearNotice('permissions');
    state.permissionEpoch++;
    state.permissionDirty = false;
    state.permissionMode = isDraft(id) ?
      (state.selectedThread?.permissionMode || state.newPermissionMode) : null;
    state.permissionLabel = id && !isDraft(id) ? '读取权限…' : null;
  }
  if (id) sessionStorage.setItem('selectedThreadId', id);
  else sessionStorage.removeItem('selectedThreadId');
  renderThreadList();
  renderProjects();
  closeSidebar();
  elements.messageInput.disabled = !id;
  elements.messageInput.value = isDraft(id) ? (state.selectedThread?.text || '') : '';
  renderHeader();
  renderMessages();
  const project = projectForCwd(state.selectedThread?.cwd);
  if (project && !state.expandedProjects.has(project.id)) {
    state.expandedProjects.add(project.id);
    renderProjects();
    if (!state.projectThreads.get(project.id)?.loaded) void loadProjectThreads(project.id);
  }
  if (id && !isDraft(id)) await Promise.all([loadSelected(), loadPermissionMode(id)]);
  if (id && state.unread.has(id)) void markThreadRead(id);
}

async function markThreadRead(id) {
  state.unread.delete(id);
  renderThreadList();
  renderProjects();
  try {
    await api('/api/threads/' + id + '/read', { method: 'POST', body: '{}' });
  } catch (error) {
    state.unread.add(id);
    renderThreadList();
    renderProjects();
    showNotice(error.message, 'unread');
  }
}

export async function loadUnread() {
  try {
    const result = await api('/api/unread');
    state.unread = new Set(result.ids || []);
    renderThreadList();
    renderProjects();
    if (state.selectedId && state.unread.has(state.selectedId)) void markThreadRead(state.selectedId);
    clearNotice('unread');
  } catch (error) {
    if (elements.authPanel.hidden) showNotice(error.message, 'unread');
  }
}

export async function startNewThread(cwd) {
  const pending = state.drafts.find((draft) => draft.hidden);
  const targetCwd = cwd || state.selectedThread?.cwd || state.preferredCwd || state.workspace || pending?.cwd;
  if (!targetCwd) {
    showNotice('尚未取得默认工作目录');
    return;
  }
  if (pending) {
    if (!pending.text?.trim() && !pending.threadId) {
      pending.cwd = targetCwd;
      saveDrafts();
    }
    await selectThread(pending.id);
    elements.messageInput.focus({ preventScroll: true });
    if (pending.cwd !== targetCwd) showNotice('已有未发送的新对话；请先发送，或清空输入后再切换工作目录');
    else clearNotice('action');
    return;
  }
  // 未发送的新对话仅保存在输入区；连续点击新建会返回同一个草稿。
  const random = crypto.getRandomValues(new Uint32Array(2));
  const draft = { id: 'draft-' + Array.from(random, (part) => part.toString(16).padStart(8, '0')).join(''),
    cwd: targetCwd, text: '', permissionMode: state.newPermissionMode, hidden: true, createdAt: Date.now() };
  state.drafts.unshift(draft);
  saveDrafts();
  await selectThread(draft.id);
  elements.messageInput.focus({ preventScroll: true });
  clearNotice('action');
}

function setSection(name, collapsed) {
  const ids = { active: ['activeToggle', 'activeContent'], project: ['projectToggle', 'projectContent'],
    recent: ['recentToggle', 'recentContent'] };
  const [button, content] = ids[name].map((id) => elements[id]);
  content.hidden = collapsed;
  button.setAttribute('aria-expanded', String(!collapsed));
  if (collapsed) state.collapsedSections.add(name);
  else state.collapsedSections.delete(name);
  localStorage.setItem('codexDeckCollapsedSections', JSON.stringify([...state.collapsedSections]));
}

function initSidebarResize() {
  const resizer = elements.sidebarResizer;
  const app = elements.sidebar.parentElement;
  let preferredWidth = Number(localStorage.getItem('codexDeckSidebarWidth')) || 280;
  let dragging = null;
  const applyWidth = (value, persist = false) => {
    if (window.innerWidth <= 700) return;
    const max = Math.min(420, Math.max(220, window.innerWidth - 360));
    const width = Math.max(220, Math.min(max, value));
    app.style.setProperty('--sidebar-width', width + 'px');
    resizer.setAttribute('aria-valuemax', String(max));
    resizer.setAttribute('aria-valuenow', String(width));
    if (persist) {
      preferredWidth = width;
      localStorage.setItem('codexDeckSidebarWidth', String(width));
    }
  };
  applyWidth(preferredWidth);
  window.addEventListener('resize', () => applyWidth(preferredWidth));
  resizer.addEventListener('pointerdown', (event) => {
    if (window.innerWidth <= 700) return;
    dragging = event.pointerId;
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add('dragging');
    document.body.classList.add('sidebar-resizing');
    event.preventDefault();
  });
  resizer.addEventListener('pointermove', (event) => {
    if (dragging === event.pointerId) applyWidth(event.clientX, true);
  });
  const endDrag = () => {
    dragging = null;
    resizer.classList.remove('dragging');
    document.body.classList.remove('sidebar-resizing');
  };
  resizer.addEventListener('pointerup', endDrag);
  resizer.addEventListener('pointercancel', endDrag);
  resizer.addEventListener('lostpointercapture', endDrag);
  resizer.addEventListener('keydown', (event) => {
    const current = Number(resizer.getAttribute('aria-valuenow'));
    const next = event.key === 'ArrowLeft' ? current - 10 : event.key === 'ArrowRight' ? current + 10 :
      event.key === 'Home' ? 220 : event.key === 'End' ? 420 : null;
    if (next === null) return;
    applyWidth(next, true);
    event.preventDefault();
  });
}

export function initSidebar() {
  initSidebarResize();
  try {
    state.collapsedSections = new Set(JSON.parse(localStorage.getItem('codexDeckCollapsedSections') || '[]'));
  } catch {
    state.collapsedSections = new Set();
  }
  for (const name of ['active', 'project', 'recent']) {
    setSection(name, state.collapsedSections.has(name));
    elements[name + 'Toggle'].addEventListener('click', () =>
      setSection(name, !state.collapsedSections.has(name)));
  }
  elements.menuButton.addEventListener('click', () => {
    elements.sidebar.classList.add('open');
    elements.sidebarBackdrop.hidden = false;
  });
  elements.sidebarBackdrop.addEventListener('click', closeSidebar);
  elements.closeSidebar.addEventListener('click', closeSidebar);
  elements.refreshThreads.addEventListener('click', () => {
    void loadThreads(true);
    void loadProjects();
    void loadUnread();
    for (const id of state.expandedProjects) void loadProjectThreads(id);
  });
  elements.moreThreads.addEventListener('click', () => {
    const recentCount = state.threads.filter((thread) => thread.status?.type !== 'active').length;
    if (state.visibleRecent < recentCount) {
      state.visibleRecent += 20;
      renderThreadList();
    } else if (state.threadCursor) void loadThreads(false);
  });
  elements.newThread.addEventListener('click', () => startNewThread());
  elements.recentNewThread.addEventListener('click', () => {
    if (!state.workspace) return showNotice('尚未取得默认工作目录');
    void startNewThread(state.workspace);
  });
}
