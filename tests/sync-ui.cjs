const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const root = path.resolve(__dirname, '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(40);
  }
  throw new Error('等待同步或停止反馈超时');
}

app.whenReady().then(async () => {
  const portServer = net.createServer();
  await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const gateway = spawn(process.execPath, [path.join(root, 'src/server.mjs')], {
    cwd: root, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODEX_GATEWAY_PORT: String(port), CODEX_CDP_PORT: '65535' },
  });
  const window = new BrowserWindow({ show: false, width: 390, height: 800,
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'sync-ui-' + process.pid } });
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  let exitCode = 0;
  try {
    await waitFor(async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
    await window.loadURL(origin);
    await evaluate(`(async () => {
      for (let id = 1; id < 100; id++) clearInterval(id);
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      const { state } = await import('/js/core.js');
      const { renderHeader, renderMessages, loadSelected } = await import('/js/conversation.js');
      const id = '00000000-0000-4000-8000-000000000001';
      const other = '00000000-0000-4000-8000-000000000002';
      const thread = { id, name: '同步反馈', cwd: ${JSON.stringify(root)}, updatedAt: 1, status: { type: 'idle' } };
      const second = { ...thread, id: other, name: '另一个对话' };
      const turn = { id: 'turn', status: 'completed', startedAt: 1,
        items: [{ id: 'answer', type: 'agentMessage', text: '离开前的消息' }] };
      const flow = window.__sync = { state, loadSelected, renderHeader, renderMessages, thread, second, turn,
        deferTurns: true, failMetadata: false, deferMetadata: false, interruptCalls: 0, turnsCalls: [] };
      const json = (body, status = 200) => new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' } });
      window.fetch = async (input, options = {}) => {
        const url = new URL(input, location.href);
        if (url.pathname === '/api/threads/' + id) {
          if (flow.waitForAbort) return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('请求已取消', 'AbortError')), { once: true });
          });
          if (flow.failMetadata) return json({ error: '网关暂时无法连接 Desktop' }, 503);
          if (flow.deferMetadata) {
            flow.deferMetadata = false;
            return new Promise((resolve) => { flow.releaseMetadata = () => resolve(json({ thread: { ...thread, name: '过期响应' } })); });
          }
          return json({ thread });
        }
        if (url.pathname === '/api/threads/' + other) return json({ thread: second });
        if (url.pathname.endsWith('/turns')) {
          flow.turnsCalls.push(url.search);
          if (flow.deferTurns) return new Promise((resolve) => {
            flow.releaseTurns = () => {
              flow.deferTurns = false;
              turn.items[0].text = '离开期间的最新消息';
              resolve(json({ turns: [turn], nextCursor: null }));
            };
          });
          return json({ turns: [turn], nextCursor: null });
        }
        if (url.pathname.endsWith('/items')) {
          flow.itemCalls = (flow.itemCalls || 0) + 1;
          if (flow.failItems) return json({ error: '模拟过程读取失败' }, 503);
          if (flow.deferItems) return new Promise((resolve) => { flow.releaseItems = () => {
            flow.deferItems = false;
            resolve(json({ items: flow.itemPage, nextCursor: flow.itemCursor }));
          }; });
          return json({ items: flow.itemPage, nextCursor: flow.itemCursor });
        }
        if (url.pathname.endsWith('/interrupt')) {
          flow.interruptCalls++;
          if (flow.waitForStopAbort) return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('请求已取消', 'AbortError')), { once: true });
          });
          return new Promise((resolve) => { flow.releaseStop = (failed = false) => {
            if (!failed) { thread.status = { type: 'idle' }; turn.status = 'interrupted'; }
            resolve(json(failed ? { error: '模拟停止失败' } : { interrupted: true }, failed ? 503 : 200));
          }; });
        }
        if (url.pathname === '/api/threads') return json({ threads: [thread, second], nextCursor: null });
        if (url.pathname === '/api/models') return json({ models: [], defaults: {} });
        if (url.pathname === '/api/projects') return json({ projects: [] });
        if (url.pathname === '/api/unread') return json({ ids: [] });
        if (url.pathname === '/api/approvals') return json({ approvals: [], retries: [] });
        if (url.pathname.endsWith('/questions')) return json({ requests: flow.questions || [] });
        if (url.pathname === '/api/health') return json({ connected: true, workspace: thread.cwd });
        return json({});
      };
      state.selectedId = id;
      state.selectedThread = thread;
      state.turns = new Map([[turn.id, structuredClone(turn)]]);
      state.historyInitialized = true;
      state.historyLoading = false;
      document.getElementById('notice').hidden = true;
      renderHeader(); renderMessages();
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    await waitFor(() => evaluate('!!window.__sync.releaseTurns'));
    const loading = await evaluate(`(() => {
      const banner = document.getElementById('conversationSync');
      const box = banner.getBoundingClientRect();
      return { visible: !banner.hidden, spinner: !!banner.querySelector('.feedback-spinner'),
        text: banner.textContent, oldMessages: document.getElementById('messages').textContent.includes('离开前的消息'),
        inViewport: box.left >= 0 && box.right <= innerWidth, query: window.__sync.turnsCalls.at(-1) };
    })()`);
    assert.equal(loading.visible, true);
    assert.equal(loading.spinner, true);
    assert.match(loading.text, /正在加载最新消息/);
    assert.equal(loading.oldMessages, true);
    assert.equal(loading.inViewport, true);
    assert.equal(loading.query, '?limit=5&itemsView=summary', '前台恢复应主动核对历史摘要，不依赖更新时间变化');
    window.webContents.invalidate();
    await pause(120);
    fs.writeFileSync(path.join(root, 'Docs', '截图', 'qa-sync-mobile.png'),
      (await window.webContents.capturePage()).toPNG());
    await evaluate('window.__sync.releaseTurns()');
    await waitFor(() => evaluate("document.getElementById('conversationSync').hidden && document.getElementById('messages').textContent.includes('离开期间的最新消息')"));

    await evaluate(`(async () => {
      const flow = window.__sync;
      flow.deferMetadata = true;
      flow.staleLoad = flow.loadSelected({ feedback: true });
      await Promise.resolve();
      await flow.loadSelected({ force: true, feedback: true });
      flow.releaseMetadata();
      await flow.staleLoad;
      if (flow.state.selectedThread.name === '过期响应') throw new Error('旧同步响应覆盖了最新会话');
      flow.failMetadata = true;
      await flow.loadSelected({ force: true, feedback: true });
    })()`);
    assert.match(await evaluate("document.getElementById('conversationSync').textContent"), /同步失败.*重试/);
    await evaluate("window.__sync.failMetadata = false; document.querySelector('#conversationSync button').click()");
    await waitFor(() => evaluate("document.getElementById('conversationSync').hidden"));
    await evaluate(`(async () => {
      const flow = window.__sync;
      const originalTimeout = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) => {
        if (delay === 30000) flow.expireSync = callback;
        return originalTimeout(callback, delay, ...args);
      };
      try {
        flow.waitForAbort = true;
        const pending = flow.loadSelected({ force: true, feedback: true });
        flow.expireSync();
        await pending;
      } finally {
        flow.waitForAbort = false;
        window.setTimeout = originalTimeout;
      }
    })()`);
    assert.match(await evaluate("document.getElementById('conversationSync').textContent"), /同步超时.*重试/);
    await evaluate("document.querySelector('#conversationSync button').click()");
    await waitFor(() => evaluate("document.getElementById('conversationSync').hidden"));

    await pause(550);
    await evaluate(`(() => {
      const flow = window.__sync;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      flow.deferTurns = true;
      flow.releaseTurns = null;
      window.dispatchEvent(new Event('codexdeck-app-resume'));
    })()`);
    await waitFor(() => evaluate('!!window.__sync.releaseTurns'));
    assert.equal(await evaluate("!document.getElementById('conversationSync').hidden"), true,
      '原生切回通知应在 WebView 尚未更新可见性时触发同步');
    await evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); window.__sync.releaseTurns()");
    await waitFor(() => evaluate("document.getElementById('conversationSync').hidden"));

    await evaluate(`(() => {
      const flow = window.__sync;
      flow.thread.status = { type: 'active' };
      flow.state.selectedThread = flow.thread;
      flow.renderHeader();
      document.getElementById('notice').hidden = true;
      document.getElementById('composer').requestSubmit();
      document.getElementById('composer').requestSubmit();
    })()`);
    await waitFor(() => evaluate('!!window.__sync.releaseStop'));
    const stopping = await evaluate(`(() => ({ count: window.__sync.interruptCalls,
      disabled: document.getElementById('sendMessage').disabled,
      spinner: !!document.querySelector('#sendMessage.is-stopping .feedback-spinner'),
      label: document.getElementById('composerActionStatus').textContent }))()`);
    assert.deepEqual(stopping, { count: 1, disabled: true, spinner: true, label: '正在停止当前回合…' });
    window.webContents.invalidate();
    await pause(120);
    fs.writeFileSync(path.join(root, 'Docs', '截图', 'qa-stop-mobile.png'),
      (await window.webContents.capturePage()).toPNG());
    await evaluate(`(() => {
      const flow = window.__sync;
      flow.state.selectedId = flow.second.id;
      flow.state.selectedThread = flow.second;
      flow.renderHeader();
      document.getElementById('notice').hidden = true;
      flow.releaseStop(true);
    })()`);
    await waitFor(() => evaluate('window.__sync.state.stoppingThreads.size === 0'));
    assert.equal(await evaluate("document.getElementById('composerActionStatus').hidden && !document.getElementById('sendMessage').classList.contains('is-stopping') && document.getElementById('notice').hidden"), true,
      '上一对话停止失败不能污染已切换的对话');
    await evaluate(`(() => {
      const flow = window.__sync;
      flow.state.selectedId = flow.thread.id;
      flow.state.selectedThread = flow.thread;
      flow.renderHeader();
      document.getElementById('composer').requestSubmit();
      flow.releaseStop(true);
    })()`);
    await waitFor(() => evaluate('window.__sync.state.stoppingThreads.size === 0'));
    assert.match(await evaluate("document.getElementById('notice').textContent"), /停止失败.*模拟停止失败/);
    assert.equal(await evaluate("document.getElementById('sendMessage').disabled"), false);
    await evaluate("document.getElementById('composer').requestSubmit(); window.__sync.releaseStop()");
    await waitFor(() => evaluate("!window.__sync.state.stopping && document.getElementById('composerActionStatus').hidden && !document.getElementById('sendMessage').classList.contains('is-stop')"));

    await evaluate(`(async () => {
      const flow = window.__sync;
      const originalTimeout = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) => {
        if (delay === 30000) flow.expireStop = callback;
        return originalTimeout(callback, delay, ...args);
      };
      try {
        flow.thread.status = { type: 'active' };
        flow.state.selectedThread = flow.thread;
        flow.renderHeader();
        flow.waitForStopAbort = true;
        document.getElementById('composer').requestSubmit();
        flow.expireStop();
      } finally {
        window.setTimeout = originalTimeout;
      }
    })()`);
    await waitFor(() => evaluate('!window.__sync.state.stopping'));
    assert.match(await evaluate("document.getElementById('notice').textContent"), /停止请求超时.*尚未确认是否已停止/);
    assert.equal(await evaluate("document.getElementById('sendMessage').disabled"), false);

    await evaluate(`(async () => {
      const flow = window.__sync;
      flow.questions = [{ key: 'integrated-layout', kind: 'async', threadId: flow.thread.id, turnId: flow.turn.id,
        questions: [{ id: 'layout', header: '界面布局', question: '你希望长问题和选项在手机中怎样展示？', isOther: true,
          options: [{ label: '保持现有布局并支持手机操作 (Recommended)', description: '较长的选项会自动换行，输入区保持可见。' }] }] }];
      document.getElementById('notice').hidden = true;
      await flow.loadSelected({ force: true });
    })()`);
    await waitFor(() => evaluate("!document.getElementById('questionSection').hidden"));
    for (const width of [320, 375]) {
      window.setContentSize(width, 800);
      await pause(80);
      const layout = await evaluate(`(() => {
        const panel = document.getElementById('questionSection').getBoundingClientRect();
        const composer = document.getElementById('composer').getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth > innerWidth,
          panelVisible: panel.width > 0 && panel.left >= 0 && panel.right <= innerWidth,
          composerVisible: composer.top >= panel.bottom - 1 && composer.bottom <= innerHeight + 1 };
      })()`);
      assert.deepEqual(layout, { overflow: false, panelVisible: true, composerVisible: true }, width + 'px 完整页面应同时容纳提问面板与输入区');
    }
    window.webContents.invalidate();
    await pause(100);
    fs.writeFileSync(path.join(root, 'Docs', '截图', 'qa-questions-mobile.png'),
      (await window.webContents.capturePage()).toPNG());

    await evaluate(`(async () => {
      const flow = window.__sync;
      flow.questions = [];
      Object.assign(flow.turn, { itemsView: 'summary', itemsCursor: 'older-1', itemsStartId: 'recent', items: [
        { id: 'opening', type: 'userMessage', startedAtMs: 10, content: [{ type: 'text', text: '长回合的首条消息' }] },
        { id: 'recent', type: 'agentMessage', startedAtMs: 30, text: '最近的处理进展' }
      ] });
      flow.state.turns = new Map();
      await flow.loadSelected({ force: true });
      flow.deferItems = true;
      flow.itemPage = [{ id: 'middle', type: 'agentMessage', startedAtMs: 20, text: '分页加载的旧进展' }];
      flow.itemCursor = 'older-2';
      document.querySelector('.turn-history button').click();
      document.querySelector('.turn-history button').click();
    })()`);
    await waitFor(() => evaluate('!!window.__sync.releaseItems'));
    assert.equal(await evaluate('window.__sync.itemCalls'), 1, '过程分页不能重复提交');
    assert.equal(await evaluate("document.querySelector('.turn-history button').disabled"), true);
    await evaluate('window.__sync.releaseItems()');
    await waitFor(() => evaluate("document.getElementById('messages').textContent.includes('分页加载的旧进展')"));
    await evaluate('window.__sync.loadSelected({ force: true })');
    assert.equal(await evaluate("window.__sync.state.turns.get('turn').itemsCursor"), 'older-2', '轮询不能重置手动加载的过程游标');
    assert.equal(await evaluate("document.getElementById('messages').textContent.includes('分页加载的旧进展')"), true);
    await evaluate("window.__sync.failItems = true; document.querySelector('.turn-history button').click()");
    await waitFor(() => evaluate("document.querySelector('.turn-history').textContent.includes('模拟过程读取失败')"));
    await evaluate(`(() => {
      const flow = window.__sync;
      flow.failItems = false;
      flow.itemPage = [{ id: 'oldest', type: 'agentMessage', startedAtMs: 15, text: '更早的处理过程' }];
      flow.itemCursor = null;
      document.querySelector('.turn-history button').click();
    })()`);
    await waitFor(() => evaluate("!document.querySelector('.turn-history')"));
    await evaluate('window.__sync.loadSelected({ force: true })');
    assert.equal(await evaluate("!document.querySelector('.turn-history') && document.getElementById('messages').textContent.includes('更早的处理过程')"), true,
      '过程读完后，轮询不能丢失已读内容或重新显示旧游标');

    await evaluate(`(() => {
      const flow = window.__sync;
      flow.state.turns = new Map([[flow.turn.id, structuredClone(flow.turn)]]);
      flow.renderMessages();
      flow.deferItems = true;
      flow.releaseItems = null;
      document.querySelector('.turn-history button').click();
    })()`);
    await waitFor(() => evaluate('!!window.__sync.releaseItems'));
    await evaluate(`(() => {
      const flow = window.__sync;
      flow.state.selectedId = flow.second.id;
      flow.state.turns = new Map();
      flow.state.selectedId = flow.thread.id;
      flow.state.turns = new Map([[flow.turn.id, structuredClone(flow.turn)]]);
      flow.itemPage = [{ id: 'stale', type: 'agentMessage', text: '不应出现的旧响应' }];
      flow.releaseItems();
    })()`);
    await pause(80);
    assert.equal(await evaluate("window.__sync.state.turns.get('turn').items.some(item => item.id === 'stale')"), false,
      'A→B→A 后，旧过程请求不能写入新的历史容器');
    console.log('同步与停止界面验证通过：恢复前台加载提示、旧消息保留、过期响应隔离、失败重试、手机布局、停止防重与跨会话隔离');
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window.destroy();
    gateway.kill();
    app.exit(exitCode);
  }
}).catch((error) => { console.error(error); app.exit(1); });
