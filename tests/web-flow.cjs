const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error('等待网页状态更新超时');
}

app.whenReady().then(async () => {
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const gateway = spawn(process.execPath, [path.join(root, 'src/server.mjs')], {
    cwd: root,
    env: { ...process.env, CODEX_GATEWAY_PORT: String(port), CODEX_CDP_PORT: '65535' },
    stdio: 'ignore', windowsHide: true,
  });
  const window = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { offscreen: true, partition: 'codexdeck-web-flow-' + Date.now() },
  });
  let exitCode = 0;
  try {
    await waitFor(async () => {
      try { return (await fetch(origin + '/')).ok; } catch { return false; }
    });
    await window.loadURL(origin);
    await waitFor(() => window.webContents.executeJavaScript(
      "document.getElementById('newThread') && document.getElementById('messageInput')"));

    await window.webContents.executeJavaScript(`(() => {
      const cwd = ${JSON.stringify(root)};
      const existingId = '00000000-0000-4000-8000-000000000011';
      const createdId = '00000000-0000-4000-8000-000000000022';
      const directId = '00000000-0000-4000-8000-000000000033';
      const existing = { id: existingId, name: '已有对话', cwd, status: { type: 'idle' }, updatedAt: 1 };
      const created = { id: createdId, name: '首条消息', cwd, status: { type: 'active' }, updatedAt: 2 };
      const direct = { id: directId, name: '直接发送', cwd, status: { type: 'active' }, updatedAt: 3 };
      const turn = { id: 'turn-created', status: 'inProgress', startedAt: Date.now() / 1000,
        items: [{ type: 'userMessage', text: '第一条消息' }] };
      const directTurn = { id: 'turn-direct', status: 'inProgress', startedAt: Date.now() / 1000,
        items: [{ type: 'userMessage', text: '直接发送' }] };
      const flow = window.__flow = { cwd, existingId, createdId, directId, existing, created, direct, turn,
        createCalls: 0, retryCalls: 0, sent: false, directSent: false, failFirst: true,
        deferTurns: true, deferPermission: false, existingPermission: 'full', approval: null, decision: null };
      const realFetch = window.fetch.bind(window);
      const json = (data, status = 200) => new Response(JSON.stringify(data),
        { status, headers: { 'Content-Type': 'application/json' } });
      window.fetch = async (input, options = {}) => {
        const url = new URL(input, location.href);
        const method = options.method || 'GET';
        if (url.pathname === '/api/threads' && method === 'GET') {
          return json({ threads: [existing, ...(flow.sent ? [created] : []),
            ...(flow.directSent ? [direct] : [])], nextCursor: null });
        }
        if (url.pathname === '/api/threads' && method === 'POST') {
          flow.createCalls++;
          flow.createBody = JSON.parse(options.body);
          if (flow.failFirst) return json({ thread: created, turn: null, turnError: '模拟发送失败' }, 201);
          flow.directSent = true;
          return json({ thread: direct, turn: directTurn }, 201);
        }
        if (url.pathname === '/api/threads/' + createdId + '/turns' && method === 'POST') {
          flow.retryCalls++;
          flow.retryBody = JSON.parse(options.body);
          flow.sent = true;
          return json({ turn }, 201);
        }
        if (url.pathname === '/api/threads/' + existingId && method === 'GET') {
          return json({ thread: existing, usage: null });
        }
        if (url.pathname === '/api/threads/' + createdId && method === 'GET') {
          return json({ thread: created, usage: null });
        }
        if (url.pathname === '/api/threads/' + directId && method === 'GET') {
          return json({ thread: direct, usage: null });
        }
        if (url.pathname === '/api/threads/' + existingId + '/permissions') {
          if (flow.failPermission) return json({ error: '模拟会话元数据暂未写入' }, 503);
          const response = flow.existingPermission === 'full' ?
            json({ approvalPolicy: 'never', approvalsReviewer: 'user',
              sandbox: { type: 'dangerFullAccess' } }) :
            json({ approvalPolicy: 'on-request', approvalsReviewer: 'user',
              sandbox: { type: 'readOnly' } });
          if (flow.deferPermission) return new Promise((resolve) => {
            flow.releasePermission = () => { flow.deferPermission = false; resolve(response); };
          });
          return response;
        }
        if (url.pathname === '/api/threads/' + createdId + '/permissions' ||
            url.pathname === '/api/threads/' + directId + '/permissions') {
          return json({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
            sandbox: { type: 'workspaceWrite' } });
        }
        if (url.pathname === '/api/threads/' + existingId + '/turns') {
          if (flow.deferTurns) return new Promise((resolve) => {
            flow.releaseTurns = () => {
              flow.deferTurns = false;
              resolve(json({ turns: [{ id: 'turn-existing', status: 'completed', startedAt: 1,
                items: [{ type: 'agentMessage', text: '历史内容已加载' }] }], nextCursor: null }));
            };
          });
          return json({ turns: [], nextCursor: null });
        }
        if (url.pathname === '/api/threads/' + createdId + '/turns') {
          return json({ turns: [turn], nextCursor: null });
        }
        if (url.pathname === '/api/threads/' + directId + '/turns') {
          return json({ turns: [directTurn], nextCursor: null });
        }
        if (url.pathname === '/api/approvals') {
          return json({ approvals: flow.approval ? [flow.approval] : [], retries: [] });
        }
        if (url.pathname.startsWith('/api/approvals/') && method === 'POST') {
          flow.decision = JSON.parse(options.body).decision;
          flow.approval = null;
          return json({ answered: true });
        }
        return realFetch(input, options);
      };
    })()`);

    const drafts = await window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      const { startNewThread, renderProjects } = await import('/js/sidebar.js');
      state.workspace = window.__flow.cwd;
      state.projects = [{ id: 'test-project', name: '测试项目', roots: [{ path: window.__flow.cwd }] }];
      renderProjects();
      await startNewThread(window.__flow.cwd);
      const firstId = state.selectedId;
      await startNewThread(window.__flow.cwd);
      await startNewThread(window.__flow.cwd);
      return { sameDraft: state.selectedId === firstId, count: state.drafts.filter((draft) => draft.hidden).length,
        inRecent: [...document.querySelectorAll('#threadList .thread-row')]
          .some((row) => row.title === '新对话'),
        inProject: [...document.querySelectorAll('#projectList .thread-row')]
          .some((row) => row.title === '新对话') };
    })()`);
    assert.deepEqual(drafts, { sameDraft: true, count: 1, inRecent: false, inProject: false });

    const loading = await window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      const { renderThreadList, selectThread } = await import('/js/sidebar.js');
      const { selectedTurnOptions } = await import('/js/settings.js');
      document.querySelector('[data-permission-mode="auto"]').click();
      state.threads = [window.__flow.existing];
      renderThreadList();
      window.__flow.selection = selectThread(window.__flow.existingId);
      return { spinner: !!document.querySelector('#messages .conversation-spinner'),
        loadingText: document.getElementById('messages').textContent.includes('正在加载对话'),
        sentPermission: selectedTurnOptions().permissionMode,
        remembered: localStorage.getItem('codexDeckNewPermissionMode') };
    })()`);
    assert.deepEqual(loading, { spinner: true, loadingText: true,
      sentPermission: undefined, remembered: 'auto' });
    await waitFor(() => window.webContents.executeJavaScript(
      "document.getElementById('permissionLabel').textContent === '完全访问权限' && !!window.__flow.releaseTurns"));
    const duringLoad = await window.webContents.executeJavaScript(
      "!!document.querySelector('#messages .conversation-spinner')");
    assert.equal(duringLoad, true, '权限读取结束前后都应保持历史加载提示');
    window.webContents.invalidate();
    await pause(120);
    fs.writeFileSync(path.join(root, 'Docs', '截图', 'qa-conversation-loading.png'),
      (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript('window.__flow.releaseTurns()');
    await waitFor(() => window.webContents.executeJavaScript(
      "document.getElementById('messages').textContent.includes('历史内容已加载')"));
    const readOnly = await window.webContents.executeJavaScript(`(async () => {
      window.__flow.existingPermission = 'readOnly';
      const { loadPermissionMode, selectedTurnOptions } = await import('/js/settings.js');
      await loadPermissionMode(window.__flow.existingId);
      return { label: document.getElementById('permissionLabel').textContent,
        sentPermission: selectedTurnOptions().permissionMode };
    })()`);
    assert.deepEqual(readOnly, { label: '只读权限', sentPermission: undefined });

    const permissionRecovery = await window.webContents.executeJavaScript(`(async () => {
      const { state, showNotice, clearNotice } = await import('/js/core.js');
      const { loadPermissionMode } = await import('/js/settings.js');
      const { loadSelected } = await import('/js/conversation.js');
      window.__flow.failPermission = true;
      await loadPermissionMode(window.__flow.existingId);
      const failed = state.permissionLabel === '权限读取失败' &&
        !document.getElementById('notice').hidden;
      window.__flow.failPermission = false;
      await loadSelected({ force: true });
      const recovered = document.getElementById('notice').hidden &&
        document.getElementById('permissionLabel').textContent === '只读权限';
      showNotice('保留发送失败提示', 'action');
      await loadPermissionMode(window.__flow.existingId);
      const keptAction = !document.getElementById('notice').hidden &&
        document.getElementById('notice').textContent === '保留发送失败提示';
      clearNotice('action');
      return { failed, recovered, keptAction };
    })()`);
    assert.deepEqual(permissionRecovery, { failed: true, recovered: true, keptAction: true },
      '权限读取失败应在后续同步时恢复，只清除自身的错误提示');

    const stalePermission = await window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      const { loadPermissionMode } = await import('/js/settings.js');
      window.__flow.deferPermission = true;
      const pending = loadPermissionMode(window.__flow.existingId);
      document.querySelector('[data-permission-mode="auto"]').click();
      state.permissionDirty = false;
      window.__flow.releasePermission();
      await pending;
      return { mode: state.permissionMode, label: document.getElementById('permissionLabel').textContent };
    })()`);
    assert.deepEqual(stalePermission, { mode: 'auto', label: '帮我批准' });

    const restoredDraft = await window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      const { startNewThread } = await import('/js/sidebar.js');
      const { loadPermissionMode } = await import('/js/settings.js');
      window.__flow.failPermission = true;
      await loadPermissionMode(window.__flow.existingId);
      window.__flow.failPermission = false;
      await startNewThread(window.__flow.cwd);
      return { mode: state.permissionMode, label: document.getElementById('permissionLabel').textContent,
        noticeHidden: document.getElementById('notice').hidden };
    })()`);
    assert.deepEqual(restoredDraft, { mode: 'auto', label: '帮我批准', noticeHidden: true },
      '切换到新草稿不应保留上一个对话的权限错误');

    await window.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('messageInput');
      input.value = '第一条消息';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('composer').requestSubmit();
    })()`);
    await waitFor(() => window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      return !state.sending && state.drafts[0]?.threadId === window.__flow.createdId;
    })()`));
    const failedSend = await window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      return { draft: state.drafts.some((item) => item.id === state.selectedId),
        sidebar: [...document.querySelectorAll('.thread-row')]
          .some((row) => row.title === window.__flow.created.name),
        message: document.getElementById('messageInput').value,
        createCalls: window.__flow.createCalls };
    })()`);
    assert.deepEqual(failedSend, { draft: true, sidebar: false,
      message: '第一条消息', createCalls: 1 });

    await window.webContents.executeJavaScript("document.getElementById('composer').requestSubmit()");
    await waitFor(() => window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      return !state.sending && state.selectedId === window.__flow.createdId;
    })()`));
    const sent = await window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      return { drafts: state.drafts.length, retryCalls: window.__flow.retryCalls,
        mode: window.__flow.retryBody.permissionMode,
        sidebar: [...document.querySelectorAll('.thread-row')]
          .some((row) => row.title === window.__flow.created.name) };
    })()`);
    assert.deepEqual(sent, { drafts: 0, retryCalls: 1, mode: 'auto', sidebar: true });

    const approval = await window.webContents.executeJavaScript(`(async () => {
      window.__flow.approval = { key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        method: 'item/commandExecution/requestApproval', threadId: window.__flow.createdId,
        cwd: window.__flow.cwd, reason: '需要读取项目配置', command: 'type package.json',
        availableDecisions: ['accept', 'decline', 'cancel'] };
      const { loadApprovals } = await import('/js/approvals.js');
      await loadApprovals();
      const card = document.querySelector('.approval-card');
      return { title: card.querySelector('h3').textContent,
        context: card.querySelector('.approval-card-context').textContent,
        command: card.querySelector('pre').textContent,
        buttons: [...card.querySelectorAll('button')].map((button) => button.textContent),
        visible: !document.getElementById('approvalSection').hidden,
        width: card.getBoundingClientRect().width };
    })()`);
    assert.equal(approval.title, '命令执行请求');
    assert.match(approval.context, /^当前对话/);
    assert.equal(approval.command, 'type package.json');
    assert.deepEqual(approval.buttons, ['允许一次', '拒绝', '取消回合']);
    assert.equal(approval.visible, true);
    assert.ok(approval.width > 400);

    const screenshots = path.join(root, 'Docs', '截图');
    window.webContents.invalidate();
    await pause(120);
    fs.writeFileSync(path.join(screenshots, 'qa-approval-updated.png'),
      (await window.webContents.capturePage()).toPNG());
    window.setSize(390, 800);
    await pause(120);
    const mobile = await window.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('.approval-card').getBoundingClientRect();
      return card.left >= 0 && card.right <= innerWidth &&
        [...document.querySelectorAll('.approval-card button')]
          .every((button) => button.getBoundingClientRect().right <= innerWidth);
    })()`);
    assert.equal(mobile, true, '移动端审批卡片或按钮超出视口');
    window.webContents.invalidate();
    await pause(120);
    fs.writeFileSync(path.join(screenshots, 'qa-approval-mobile-updated.png'),
      (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(
      "document.querySelector('.approval-card .primary-button').click()");
    await waitFor(() => window.webContents.executeJavaScript(
      "window.__flow.decision === 'accept' && document.getElementById('approvalSection').hidden"));

    const directSend = await window.webContents.executeJavaScript(`(async () => {
      window.__flow.failFirst = false;
      const { startNewThread } = await import('/js/sidebar.js');
      await startNewThread(window.__flow.cwd);
      const input = document.getElementById('messageInput');
      input.value = '直接发送';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('composer').requestSubmit();
      return true;
    })()`);
    assert.equal(directSend, true);
    await waitFor(() => window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      return !state.sending && state.selectedId === window.__flow.directId;
    })()`));
    const directVisible = await window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      return state.drafts.length === 0 && window.__flow.directSent &&
        [...document.querySelectorAll('.thread-row')]
          .some((row) => row.title === window.__flow.direct.name);
    })()`);
    assert.equal(directVisible, true, '首次发送成功后应出现在侧栏');

    window.webContents.reload();
    await waitFor(() => window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      return state.workspace && document.getElementById('newThread');
    })()`));
    const remembered = await window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      const { startNewThread } = await import('/js/sidebar.js');
      await startNewThread();
      return { preferred: state.newPermissionMode, selected: state.permissionMode,
        visibleDraft: [...document.querySelectorAll('.thread-row')].some((row) => row.title === '新对话') };
    })()`);
    assert.deepEqual(remembered, { preferred: 'auto', selected: 'auto', visibleDraft: false });
    console.log('网页流程验证通过：单草稿、历史加载、权限继承、发送失败重试、直接发送、审批布局与刷新记忆');
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window.destroy();
    gateway.kill();
    app.exit(exitCode);
  }
}).catch((error) => { console.error(error); app.exit(1); });
