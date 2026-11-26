const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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

async function waitFor(check, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error('等待网页状态更新超时');
}

app.whenReady().then(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codexdeck-web-'));
  const themeFile = path.join(directory, 'theme.txt');
  fs.writeFileSync(themeFile, 'dark');
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const gateway = spawn(process.execPath, [path.join(root, 'src/server.mjs')], {
    cwd: root,
    env: { ...process.env, CODEX_GATEWAY_PORT: String(port), CODEX_CDP_PORT: '65535',
      CODEX_GATEWAY_THEME_FILE: themeFile },
    stdio: 'ignore', windowsHide: true,
  });
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  let exitCode = 0;
  try {
    await waitFor(async () => {
      try { return (await fetch(origin + '/')).ok; } catch { return false; }
    });
    const html = await (await fetch(origin + '/')).text();
    assert.match(html, /<html lang="zh-CN" data-theme="dark">/);
    await window.loadURL(origin);
    assert.equal(await window.webContents.executeJavaScript('document.documentElement.dataset.theme'), 'dark');
    assert.equal(await window.webContents.executeJavaScript(
      'document.querySelector(\'meta[name="theme-color"]\').content'), '#191a1b');

    await fetch(origin + '/api/theme', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'light' }) });
    await waitFor(() => window.webContents.executeJavaScript(
      'document.documentElement.dataset.theme === "light"'));
    await window.webContents.executeJavaScript("document.getElementById('themeToggle').click()");
    await waitFor(async () => (await (await fetch(origin + '/api/theme')).json()).theme === 'dark');

    const projects = await window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      const { renderProjects, loadProjectThreads } = await import('/js/sidebar.js');
      const cwd = 'D:/Test';
      const threads = Array.from({ length: 50 }, (_, i) => ({ id: 'project-' + i,
        name: '项目对话 ' + i, cwd, updatedAt: 100 - i, status: { type: 'idle' } }));
      state.projects = [{ id: 'one', name: '项目一', roots: [{ path: cwd }] },
        { id: 'two', name: '项目二', roots: [{ path: 'D:/Other' }] }];
      state.drafts = [];
      state.selectedId = null;
      state.selectedThread = null;
      state.expandedProjects = new Set(['one', 'two']);
      const record = { threads, cursors: new Map([[cwd, 'next']]), loaded: true, loading: false };
      state.projectThreads = new Map([['one', record], ['two', {
        threads: threads.slice(0, 5).map((thread) => ({ ...thread, cwd: 'D:/Other' })),
        cursors: new Map(), loaded: true, loading: false }]]);
      const groups = () => [...document.querySelectorAll('.project-group')];
      const count = () => groups().map((group) => group.querySelectorAll('.thread-row').length);
      const more = () => groups()[0].querySelector('.more-button');
      renderProjects();
      const initial = count();
      more().click();
      const expanded = count();
      more().click();
      const cached = count();
      const loadLabel = more().textContent;
      const realFetch = window.fetch;
      let release;
      let calls = 0;
      window.fetch = () => {
        calls++;
        return new Promise((resolve) => { release = resolve; });
      };
      try {
        more().click();
        const loading = more().disabled;
        more().click();
        release(new Response(JSON.stringify({ threads: [{ id: 'older', name: '更早对话',
          cwd, updatedAt: 0 }], nextCursor: null }), { status: 200 }));
        while (record.loading) await new Promise((resolve) => setTimeout(resolve, 10));
        const paged = count();
        const exhausted = !more();
        window.fetch = async () => new Response(JSON.stringify({ threads, nextCursor: null }), { status: 200 });
        await loadProjectThreads('one');
        const refreshed = count();
        record.visibleCount = 12;
        state.selectedId = threads[45].id;
        state.selectedThread = threads[45];
        renderProjects();
        const selected = { count: count()[0], visible: !!groups()[0].querySelector('.selected') };
        groups()[0].querySelector('.project-toggle').click();
        const collapsed = !groups()[0].querySelector('.project-threads');
        groups()[0].querySelector('.project-toggle').click();
        const reopened = count()[0];
        record.visibleCount = 50;
        record.cursors.set(cwd, 'retry');
        renderProjects();
        window.fetch = async () => new Response(JSON.stringify({ error: '模拟读取失败' }), { status: 503 });
        await loadProjectThreads('one', false);
        const failed = { count: count()[0], visibleCount: record.visibleCount, retry: !more().disabled };
        return { initial, expanded, cached, loadLabel, loading, calls, paged, exhausted,
          refreshed, selected, collapsed, reopened, failed };
      } finally {
        window.fetch = realFetch;
      }
    })()`);
    assert.deepEqual(projects, {
      initial: [12, 5], expanded: [32, 5], cached: [50, 5], loadLabel: '加载更早的对话',
      loading: true, calls: 1, paged: [51, 5], exhausted: true, refreshed: [50, 5],
      selected: { count: 13, visible: true }, collapsed: true, reopened: 13,
      failed: { count: 50, visibleCount: 50, retry: true },
    }, '项目对话应分批展开，保留当前选择，支持分页和失败重试');

    const result = await window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      const { renderThreadList } = await import('/js/sidebar.js');
      const { loadApprovals } = await import('/js/approvals.js');
      const { renderMessages, updateTurnStatuses } = await import('/js/conversation.js');
      const id = '00000000-0000-4000-8000-000000000001';
      state.selectedId = id;
      state.selectedThread = { id, name: '测试审批', cwd: 'D:\\\\Test',
        status: { type: 'active', activeFlags: ['waitingOnApproval'] } };
      state.threads = [state.selectedThread];
      renderThreadList();
      await loadApprovals();
      const approval = !!document.querySelector('#activeList .awaiting-approval') &&
        !document.getElementById('approvalSection').hidden &&
        document.getElementById('approvalList').textContent.includes('Codex Desktop');
      state.desktopConnected = true;
      state.turns = new Map([['turn', { id: 'turn', status: 'inProgress',
        startedAt: Math.floor(Date.now() / 1000) - 61, items: [] }]]);
      renderMessages();
      const elapsed = document.querySelector('.turn-status').textContent;
      state.retryingTurns.set('turn', {});
      updateTurnStatuses();
      const retry = document.querySelector('.turn-status').textContent;
      state.retryingTurns.clear();
      state.turns.get('turn').items = [{ type: 'error', willRetry: true }];
      updateTurnStatuses();
      const historyRetry = document.querySelector('.turn-status').textContent;
      state.turns.get('turn').items.push({ type: 'agentMessage', text: '已恢复' });
      updateTurnStatuses();
      const resumed = document.querySelector('.turn-status').textContent;
      return { approval, elapsed, retry, historyRetry, resumed };
    })()`);
    assert.equal(result.approval, true);
    assert.match(result.elapsed, /^已处理 01分0[1-3]秒$/);
    assert.match(result.retry, /^连接出错，正在重连…/);
    assert.match(result.historyRetry, /^连接出错，正在重连…/);
    assert.match(result.resumed, /^已处理 /);
    if (process.env.CODEXDECK_WEB_SCREENSHOT) {
      const screenshot = await window.capturePage();
      fs.writeFileSync(process.env.CODEXDECK_WEB_SCREENSHOT, screenshot.toPNG());
      console.log('网页截图：' + process.env.CODEXDECK_WEB_SCREENSHOT);
    }
    console.log('网页界面验证通过：项目分批展开与分页重试、首屏深色、主题同步、审批指引与重连状态');
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window.destroy();
    gateway.kill();
    fs.rmSync(directory, { recursive: true, force: true });
    app.exit(exitCode);
  }
}).catch((error) => { console.error(error); app.exit(1); });
