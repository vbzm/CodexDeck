const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const root = path.resolve(__dirname, '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, message = '等待长对话界面更新超时') {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(40);
  }
  throw new Error(message);
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
  const window = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'history-ui-' + process.pid } });
  const startupRequests = new Set();
  window.webContents.session.webRequest.onBeforeRequest({ urls: [origin + '/api/*'] }, (details, callback) => {
    startupRequests.add(details.id);
    callback({});
  });
  window.webContents.session.webRequest.onCompleted({ urls: [origin + '/api/*'] }, (details) => startupRequests.delete(details.id));
  window.webContents.session.webRequest.onErrorOccurred({ urls: [origin + '/api/*'] }, (details) => startupRequests.delete(details.id));
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  const atQuestion = (number) => evaluate(`(() => {
    const item = document.querySelector('.item.user[data-item-id="question-${number}"]');
    const box = document.getElementById('messages');
    return !!item && Math.abs(item.getBoundingClientRect().top - box.getBoundingClientRect().top) <= 40;
  })()`);
  let exitCode = 0;
  try {
    await waitFor(async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
    await window.loadURL(origin);
    // 等初始化的真实请求结束，再装模拟接口；迟到的错误提示会改变滚动容器高度。
    await waitFor(() => Promise.resolve(startupRequests.size === 0));
    await evaluate(`(async () => {
      for (let id = 1; id < 1000; id++) clearInterval(id);
      const { state } = await import('/js/core.js');
      const conversation = await import('/js/conversation.js');
      const thread = { id: '00000000-0000-4000-8000-000000000001', name: '长对话加载与连续跳转',
        cwd: ${JSON.stringify(root)}, updatedAt: 1, status: { type: 'idle' } };
      const other = { ...thread, id: '00000000-0000-4000-8000-000000000002', name: '切换后的对话' };
      const makeTurn = (number, question = true) => ({ id: 'turn-' + number, status: 'completed',
        startedAt: number, completedAt: number + 0.5, itemsView: 'summary', itemsDeferred: true,
        itemsCursor: null, itemsStartId: null,
        items: [
          ...(question ? [{ id: 'question-' + number, type: 'userMessage', startedAtMs: number * 1000,
            content: [{ type: 'text', text: '第 ' + number + ' 次提问：请检查这一轮的结果。' }] }] : []),
          { id: 'answer-' + number, type: 'agentMessage', phase: 'final_answer', startedAtMs: number * 1000 + 100,
            text: '第 ' + number + ' 轮的最新回复。\\n\\n' + Array.from({ length: 32 }, (_, index) =>
              '回复段落 ' + (index + 1) + '：用于验证长消息阅读和提问定位。').join('\\n\\n') },
        ] });
      const flow = window.__history = { state, ...conversation, thread, other, makeTurn,
        deferMetadata: true, turnsCalls: [], itemCalls: [], pages: new Map(),
        latest: { turns: [makeTurn(10), makeTurn(9)], nextCursor: 'older-8' } };
      flow.setHistory = (turns, cursor = null, selected = thread) => {
        state.selectedId = selected.id;
        state.selectedThread = selected;
        state.turns = new Map(turns.map((turn) => [turn.id, structuredClone(turn)]));
        state.olderCursor = cursor;
        state.historyInitialized = true;
        state.historyLoading = false;
        state.initialHistory = true;
        state.compactions = [];
        state.agentActivity = new Map();
        state.agentActivityLoading = false;
        document.getElementById('notice').hidden = true;
        flow.renderHeader();
        flow.renderMessages();
      };
      flow.scrollIntoReply = (number) => {
        const question = document.querySelector('.item.user[data-item-id="question-' + number + '"]');
        const box = document.getElementById('messages');
        box.scrollTop += question.getBoundingClientRect().top - box.getBoundingClientRect().top + 250;
        flow.updateScrollToBottom();
      };
      const json = (body, status = 200) => new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' } });
      window.fetch = async (input, options = {}) => {
        const url = new URL(input, location.href);
        if (url.pathname === '/api/threads/' + thread.id || url.pathname === '/api/threads/' + other.id) {
          const selected = url.pathname.endsWith(other.id) ? other : thread;
          if (flow.deferMetadata) return new Promise((resolve) => {
            flow.releaseMetadata = () => { flow.deferMetadata = false; resolve(json({ thread: selected })); };
          });
          return json({ thread: selected });
        }
        if (url.pathname.endsWith('/turns')) {
          const cursor = url.searchParams.get('cursor');
          flow.turnsCalls.push({ cursor, itemsView: url.searchParams.get('itemsView'), limit: url.searchParams.get('limit') });
          if (!cursor && url.searchParams.get('itemsView') !== 'summary' && flow.fullPage) {
            if (flow.deferFull) return new Promise((resolve) => {
              flow.releaseFull = () => { flow.deferFull = false; resolve(json(flow.fullPage)); };
            });
            return json(flow.fullPage);
          }
          if (!cursor) return json(flow.latest);
          if (flow.failOlder) return json({ error: '模拟历史读取失败，请重试' }, 503);
          if (flow.deferOlder) return new Promise((resolve) => {
            flow.releaseOlder = () => { flow.deferOlder = false; resolve(json(flow.pages.get(cursor))); };
          });
          return json(flow.pages.get(cursor) || { turns: [], nextCursor: null });
        }
        if (url.pathname.endsWith('/items')) {
          flow.itemCalls.push({ path: url.pathname, cursor: url.searchParams.get('cursor') });
          if (flow.deferItems) return new Promise((resolve) => {
            flow.releaseItems = () => { flow.deferItems = false; resolve(json(flow.itemPage)); };
          });
          return json(flow.itemPage || { items: [], nextCursor: null });
        }
        if (url.pathname === '/api/health') return json({ connected: true, workspace: thread.cwd });
        if (url.pathname === '/api/threads') return json({ threads: [thread, other], nextCursor: null });
        if (url.pathname === '/api/models') return json({ models: [], defaults: {} });
        if (url.pathname === '/api/projects') return json({ projects: [] });
        if (url.pathname === '/api/unread') return json({ ids: [] });
        if (url.pathname === '/api/approvals') return json({ approvals: [], retries: [] });
        if (url.pathname.endsWith('/questions')) return json({ requests: [] });
        return json({});
      };
      state.selectedId = thread.id;
      state.selectedThread = thread;
      state.turns = new Map();
      state.historyInitialized = false;
      state.historyLoading = true;
      state.initialHistory = true;
      state.olderCursor = null;
      flow.renderHeader(); flow.renderMessages();
      flow.initialLoad = flow.loadSelected();
    })()`);

    // 用未释放的元信息请求证明首屏消息没有被慢请求挡住。
    await waitFor(() => evaluate("document.getElementById('messages').textContent.includes('第 10 轮的最新回复')"),
      '元信息尚未返回时，应先显示最新消息摘要');
    assert.equal(await evaluate('window.__history.deferMetadata'), true);
    assert.deepEqual(await evaluate('window.__history.turnsCalls[0]'),
      { cursor: null, itemsView: 'summary', limit: '5' });
    assert.equal(await evaluate('window.__history.itemCalls.length'), 0, '首屏完成回合无需读取工具过程');
    assert.equal(await evaluate(`(() => [...document.querySelectorAll('.turn')].every(turn => {
      const question = turn.querySelector('.item.user');
      const control = turn.querySelector('.turn-history');
      return question.nextElementSibling === control && control.nextElementSibling.matches('.item.assistant');
    }))()`), true, '查看过程入口应在对应提问下方、回复上方');
    const initialScroll = await evaluate(`(() => {
      const box = document.getElementById('messages');
      return { gap: box.scrollHeight - box.scrollTop - box.clientHeight,
        scrollHeight: box.scrollHeight, scrollTop: box.scrollTop, clientHeight: box.clientHeight,
        notice: document.getElementById('notice').hidden ? null : document.getElementById('notice').textContent };
    })()`);
    assert.ok(initialScroll.gap <= 2, '最新摘要显示后应停留在底部：' + JSON.stringify(initialScroll));
    assert.equal(await evaluate("document.getElementById('previousQuestion').hidden"), true);
    await evaluate('window.__history.releaseMetadata(); window.__history.initialLoad');

    await evaluate(`(() => {
      const flow = window.__history;
      const turn = flow.makeTurn(10);
      flow.itemPage = { items: [turn.items[0], { id: 'tool-10', type: 'commandExecution',
        command: 'Get-Date', status: 'completed', startedAtMs: 10050, aggregatedOutput: '工具过程已读取' }, turn.items[1]], nextCursor: null };
      document.querySelectorAll('.turn-history button')[1].click();
    })()`);
    await waitFor(() => evaluate("window.__history.state.turns.get('turn-10').items.some(item => item.id === 'tool-10')"));
    assert.equal(await evaluate('window.__history.itemCalls[0].cursor'), null, '摘要的过程按钮应从第一页读取');
    await evaluate('window.__history.loadSelected({ force: true })');
    assert.equal(await evaluate("window.__history.state.turns.get('turn-10').items.some(item => item.id === 'tool-10')"), true,
      '重新同步摘要不能丢失已加载过程');
    assert.equal(await evaluate('window.__history.itemCalls.length'), 1);

    // 摘要没有条目时间；过程页必须提供较新的同 ID 内容，后续摘要仍保留已读时间。
    await evaluate(`(() => {
      const flow = window.__history;
      flow.savedLatest = flow.latest;
      const summary = flow.makeTurn(11);
      summary.items.forEach((item) => { delete item.startedAtMs; });
      summary.items[1].text = '较旧摘要';
      flow.summaryWithoutTimes = summary;
      flow.setHistory([summary]);
      flow.itemPage = { items: [
        { ...summary.items[0], startedAtMs: 11000 },
        { id: 'tool-11', type: 'commandExecution', command: 'Get-Date', status: 'completed',
          startedAtMs: 11050, aggregatedOutput: '顺序检查工具输出' },
        { ...summary.items[1], startedAtMs: 11100, completedAtMs: 11200, text: '工具页最新回复' },
      ], nextCursor: null };
      flow.deferItems = true;
      document.querySelector('.turn-history button').click();
    })()`);
    await waitFor(() => evaluate('!!window.__history.releaseItems'));
    assert.equal(await evaluate(`document.querySelector('.item.user').nextElementSibling === document.querySelector('.turn-history') &&
      document.querySelector('.turn-history button').disabled`), true, '加载过程时入口应保留在提问下方');
    assert.equal(await evaluate("document.querySelector('.item.assistant').textContent.includes('较旧摘要')"), true);
    assert.match(await evaluate("document.querySelector('.item.assistant .item-time').textContent"), /^约 \d{2}:\d{2}:\d{2}$/);
    await evaluate('window.__history.releaseItems()');
    await waitFor(() => evaluate("window.__history.state.turns.get('turn-11').itemsView === 'full'"));
    const mergedProcess = await evaluate(`(() => {
      const turn = window.__history.state.turns.get('turn-11');
      const answer = turn.items.find(item => item.id === 'answer-11');
      const user = document.querySelector('.item.user');
      const tool = document.querySelector('.activity-group');
      const final = document.querySelector('.item.assistant');
      return { ids: turn.items.map(item => item.id), startedAtMs: answer.startedAtMs,
        completedAtMs: answer.completedAtMs, text: answer.text,
        domOrder: !!tool && !!(user.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          !!(tool.compareDocumentPosition(final) & Node.DOCUMENT_POSITION_FOLLOWING) };
    })()`);
    assert.deepEqual(mergedProcess, { ids: ['question-11', 'tool-11', 'answer-11'], startedAtMs: 11100,
      completedAtMs: 11200, text: '工具页最新回复', domOrder: true }, '过程页应覆盖旧摘要并保持用户→工具→最终回复顺序');
    await evaluate(`(() => {
      const flow = window.__history;
      const refreshed = structuredClone(flow.summaryWithoutTimes);
      refreshed.items[1].text = '重新同步的最新摘要';
      flow.latest = { turns: [refreshed], nextCursor: null };
      return flow.loadSelected({ force: true });
    })()`);
    const mergedSummary = await evaluate(`(() => {
      const turn = window.__history.state.turns.get('turn-11');
      const answer = turn.items.find(item => item.id === 'answer-11');
      const tool = document.querySelector('.activity-group');
      const final = document.querySelector('.item.assistant');
      return { ids: turn.items.map(item => item.id), startedAtMs: answer.startedAtMs,
        completedAtMs: answer.completedAtMs, text: answer.text, itemsCursor: turn.itemsCursor,
        itemsView: turn.itemsView, deferred: turn.itemsDeferred,
        domOrder: !!tool && !!(tool.compareDocumentPosition(final) & Node.DOCUMENT_POSITION_FOLLOWING) };
    })()`);
    assert.deepEqual(mergedSummary, { ids: ['question-11', 'tool-11', 'answer-11'], startedAtMs: 11100,
      completedAtMs: 11200, text: '重新同步的最新摘要', itemsCursor: null, itemsView: 'full', deferred: false,
      domOrder: true }, '无时间的新摘要只能更新内容，不能清除过程时间、工具和已读游标');
    assert.equal(await evaluate("document.querySelector('.item.assistant time').dateTime"), new Date(11100).toISOString());

    // 恢复时先显示已完成摘要，再核对刚结束回合，更新离开前仍在运行的工具状态。
    await evaluate(`(() => {
      const flow = window.__history;
      const summary = flow.makeTurn(12);
      summary.items[1].text = '恢复后先显示的已完成摘要';
      const opening = summary.items[0];
      const localTool = { id: 'tool-12', type: 'commandExecution', command: 'Get-Date', status: 'inProgress',
        startedAtMs: 12050, aggregatedOutput: '离开前工具仍在运行' };
      const local = { ...structuredClone(summary), status: 'inProgress', completedAt: null,
        itemsView: 'full', itemsDeferred: false, items: [opening, localTool,
          { ...summary.items[1], text: '离开前的运行中回复' }] };
      flow.setHistory([local], null, { ...flow.thread, updatedAt: 0, status: { type: 'active' } });
      flow.latest = { turns: [summary], nextCursor: null };
      flow.fullPage = { turns: [{ ...structuredClone(summary), itemsView: 'full', itemsDeferred: false,
        items: [opening, { ...localTool, status: 'completed', completedAtMs: 12100,
          aggregatedOutput: '恢复后工具已完成' }, summary.items[1]] }], nextCursor: null };
      flow.deferMetadata = true;
      flow.releaseMetadata = null;
      flow.deferFull = true;
      flow.releaseFull = null;
      flow.restoreStart = flow.turnsCalls.length;
      flow.restoreLoad = flow.loadSelected({ force: true, feedback: true });
    })()`);
    await waitFor(() => evaluate("document.getElementById('messages').textContent.includes('恢复后先显示的已完成摘要')"),
      '恢复后的摘要应先于元信息和完整过程显示');
    assert.equal(await evaluate('window.__history.deferMetadata'), true);
    assert.equal(await evaluate("window.__history.state.turns.get('turn-12').status"), 'completed');
    await evaluate('window.__history.releaseMetadata()');
    await waitFor(() => evaluate('!!window.__history.releaseFull'), '本地仍有运行过程时，恢复后应补读最新一轮的完整页');
    assert.equal(await evaluate("document.getElementById('messages').textContent.includes('恢复后先显示的已完成摘要')"), true,
      '完整过程尚未返回也应保留最新摘要');
    assert.deepEqual(await evaluate('window.__history.turnsCalls.slice(window.__history.restoreStart)'),
      [{ cursor: null, itemsView: 'summary', limit: '5' }, { cursor: null, itemsView: null, limit: '1' }],
      '恢复只需先读最近摘要，再补齐最新一轮过程');
    await evaluate('window.__history.releaseFull(); window.__history.restoreLoad');
    assert.deepEqual(await evaluate(`(() => {
      const turn = window.__history.state.turns.get('turn-12');
      const tool = turn.items.find(item => item.id === 'tool-12');
      return { turn: turn.status, tool: tool.status, output: tool.aggregatedOutput };
    })()`), { turn: 'completed', tool: 'completed', output: '恢复后工具已完成' },
      '完成摘要不能让旧工具状态永久停在进行中');
    await evaluate(`(() => {
      const flow = window.__history;
      flow.latest = flow.savedLatest;
      flow.fullPage = null;
    })()`);

    // 最新一页与已读历史相连时保留深层游标，完全断开时必须补上中间缺失的回合。
    await evaluate(`(() => {
      const flow = window.__history;
      flow.setHistory([flow.makeTurn(10), flow.makeTurn(9)], 'deep-old');
      flow.latest = { turns: [flow.makeTurn(10), flow.makeTurn(9)], nextCursor: 'latest-old' };
      return flow.loadSelected({ force: true });
    })()`);
    assert.equal(await evaluate('window.__history.state.olderCursor'), 'deep-old',
      '强制同步相连的最新页，不能重置已经向前加载的深层游标');
    await evaluate(`(() => {
      const flow = window.__history;
      flow.latest = { turns: [flow.makeTurn(20), flow.makeTurn(19)], nextCursor: 'gap-18' };
      return flow.loadSelected({ force: true });
    })()`);
    assert.equal(await evaluate('window.__history.state.olderCursor'), 'gap-18',
      '新增最新页与本地历史无交集时，应从新页游标补齐中间缺页');
    assert.equal(await evaluate("window.__history.state.turns.has('turn-10') && window.__history.state.turns.has('turn-9')"), true,
      '补齐中间缺页时仍应保留先前加载的旧回合');
    await evaluate('window.__history.latest = window.__history.savedLatest');

    // 尚未读过程的摘要不能用空游标覆盖完整读取返回的真实过程分页游标。
    await evaluate(`(() => {
      const flow = window.__history;
      flow.thread.status = { type: 'active' };
      const summary = flow.makeTurn(10);
      flow.setHistory([summary]);
      const final = summary.items[1];
      flow.fullPage = { turns: [{ ...summary, items: [final], itemsView: 'summary', itemsDeferred: false,
        itemsStartId: final.id, itemsCursor: 'older-process' }], nextCursor: null };
      return flow.loadSelected();
    })()`);
    assert.deepEqual(await evaluate(`(() => {
      const turn = window.__history.state.turns.get('turn-10');
      return { cursor: turn.itemsCursor, deferred: turn.itemsDeferred,
        opening: turn.items.some(item => item.id === 'question-10') };
    })()`), { cursor: 'older-process', deferred: false, opening: true },
      '尚未读取过程时应采纳真实过程游标，同时保留摘要首条提问');
    await evaluate(`(() => {
      const flow = window.__history;
      flow.thread.status = { type: 'idle' };
      flow.fullPage = null;
    })()`);

    await evaluate(`(() => {
      const flow = window.__history;
      flow.setHistory([flow.makeTurn(9), flow.makeTurn(10)], 'older-8');
      flow.pages.set('older-8', { turns: [flow.makeTurn(8, false)], nextCursor: 'older-7' });
      flow.pages.set('older-7', { turns: [flow.makeTurn(7), flow.makeTurn(6)], nextCursor: null });
      flow.scrollIntoReply(10);
    })()`);
    assert.equal(await evaluate("document.getElementById('previousQuestion').hidden"), false);
    await evaluate("document.getElementById('previousQuestion').click()");
    await waitFor(() => atQuestion(10));
    await evaluate("document.getElementById('previousQuestion').click()");
    await waitFor(() => atQuestion(9), '第二次点击应跳到再上一次提问');
    const callsBeforePaging = await evaluate('window.__history.turnsCalls.length');
    await evaluate("document.getElementById('previousQuestion').click()");
    await waitFor(() => atQuestion(7), '提问未加载时，应自动跨过无提问的历史页');
    assert.deepEqual(await evaluate(`window.__history.turnsCalls.slice(${callsBeforePaging}).map(call =>
      ({ cursor: call.cursor, itemsView: call.itemsView }))`),
    [{ cursor: 'older-8', itemsView: 'summary' }, { cursor: 'older-7', itemsView: 'summary' }]);
    assert.equal(await evaluate("document.querySelectorAll('.item.user[data-item-id=\"question-9\"]').length"), 1);
    await evaluate("document.getElementById('previousQuestion').click()");
    await waitFor(() => atQuestion(6));
    const exhaustedCalls = await evaluate('window.__history.turnsCalls.length');
    await evaluate('window.__history.jumpToPreviousQuestion()');
    assert.equal(await evaluate('window.__history.turnsCalls.length'), exhaustedCalls, '到最早提问后不应继续请求');

    // 摘要省略压缩条目时，状态事件仍须显示在最终回复之前。
    const summaryCompaction = await evaluate(`(() => {
      const flow = window.__history;
      const turn = flow.makeTurn(12);
      turn.items.forEach(item => { delete item.startedAtMs; });
      flow.setHistory([turn]);
      flow.state.compactions = [{ id: 'compact-12', turnId: turn.id, type: 'contextCompaction',
        startedAtMs: 12050, completed: true }];
      flow.renderMessages();
      flow.compactionOrder = () => [...document.querySelector('.turn').children].flatMap(node =>
        node.classList.contains('compaction-divider') ? ['compaction'] :
        node.classList.contains('activity-group') ? ['activity'] :
        node.matches('.item[data-item-id]') ? [node.dataset.itemId] : []);
      return flow.compactionOrder();
    })()`);
    assert.deepEqual(summaryCompaction, ['question-12', 'compaction', 'answer-12'],
      '无条目时间的摘要也应把已完成压缩提示放在终答前');

    const fullCompaction = await evaluate(`(() => {
      const flow = window.__history;
      const turn = flow.makeTurn(12);
      turn.itemsView = 'full'; turn.itemsDeferred = false;
      turn.items.splice(1, 0,
        { id: 'tool-12', type: 'commandExecution', command: 'Get-Date', status: 'completed', startedAtMs: 12020 },
        { id: 'compact-12', type: 'contextCompaction', startedAtMs: 12050, completed: false });
      flow.setHistory([turn]);
      flow.state.compactions = [{ id: 'compact-12', turnId: turn.id, type: 'contextCompaction',
        startedAtMs: 12050, completed: true }];
      flow.renderMessages();
      return { order: flow.compactionOrder(), count: document.querySelectorAll('.compaction-divider').length,
        status: document.querySelector('.compaction-label').dataset.status };
    })()`);
    assert.deepEqual(fullCompaction, { order: ['question-12', 'activity', 'compaction', 'answer-12'], count: 1, status: 'completed' },
      '完整历史已有同 ID 压缩条目时只更新状态，保留原位置且不重复显示');

    const activeCompaction = await evaluate(`(() => {
      const flow = window.__history;
      const turn = flow.makeTurn(13);
      turn.status = 'inProgress'; turn.completedAt = null;
      turn.items = [turn.items[0], { id: 'progress-13', type: 'agentMessage', phase: 'commentary',
        startedAtMs: 13020, text: '正在处理本轮工作。' }];
      flow.setHistory([turn]);
      flow.state.compactions = [{ id: 'compact-13', turnId: turn.id, type: 'contextCompaction',
        startedAtMs: 13050, completed: false }];
      flow.renderMessages();
      const running = flow.compactionOrder();
      flow.state.compactions[0].completed = true;
      flow.state.turns.get(turn.id).status = 'completed';
      flow.state.turns.get(turn.id).items.push({ id: 'answer-13', type: 'agentMessage', phase: 'final_answer', text: '本轮处理完成。' });
      flow.renderMessages();
      return { running, completed: flow.compactionOrder(), count: document.querySelectorAll('.compaction-divider').length };
    })()`);
    assert.deepEqual(activeCompaction, { running: ['question-13', 'progress-13', 'compaction'],
      completed: ['question-13', 'progress-13', 'compaction', 'answer-13'], count: 1 },
      '运行中压缩可显示在当前末尾，最终回复到达后仍应处于终答之前');

    const resumedCompaction = await evaluate(`(() => {
      const flow = window.__history;
      const turn = flow.makeTurn(14);
      turn.status = 'inProgress'; turn.completedAt = null;
      const diff = ['@@ -1 +1,2 @@', '-const label = "old";', '+const label = "new";',
        '+' + 'long-line-'.repeat(60)].join('\\n');
      turn.items = [
        { ...turn.items[0], startedAtMs: 14010 },
        { id: 'tool-14', type: 'commandExecution', command: 'node ' + 'long-command-'.repeat(16), status: 'completed', startedAtMs: 30000 },
        { id: 'file-14', type: 'fileChange', changes: [{ path: 'public/' + 'long-file-'.repeat(16) + '.js', diff }], startedAtMs: 45000 },
        { id: 'progress-14', type: 'agentMessage', phase: 'commentary', startedAtMs: 60000, text: '压缩后继续处理。' },
      ];
      flow.setHistory([turn]);
      flow.state.compactions = [{ id: 'compact-14', turnId: turn.id, type: 'contextCompaction',
        startedAtMs: 14020, completed: true }];
      flow.renderMessages();
      return flow.compactionOrder();
    })()`);
    assert.deepEqual(resumedCompaction, ['question-14', 'compaction', 'activity', 'progress-14'],
      '尾页未包含已完成压缩条目时，应按事件时间插入后续工具和进度之前');
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.compaction-divider time, .item.assistant time')]
      .map(clock => clock.dateTime)`), [14020, 60000].map((ms) => new Date(ms).toISOString()),
      '进度和压缩提示都显示各自的条目时间');
    assert.match(await evaluate("document.querySelector('.item.assistant .item-time').textContent"), /^\d{2}:\d{2}:\d{2}$/);

    const previousTheme = await evaluate('document.documentElement.getAttribute("data-theme")');
    await evaluate("document.querySelector('.activity-group > summary').click()");
    await waitFor(() => evaluate("document.querySelectorAll('.activity-entry').length === 2"));
    await evaluate("document.querySelector('.activity-entry[data-kind=file] > summary').click()");
    await waitFor(() => evaluate("!!document.querySelector('.file-diff-table')"));
    for (const [width, theme] of [[1100, 'light'], [320, 'dark']]) {
      window.setContentSize(width, 800);
      await waitFor(() => evaluate(`Math.abs(innerWidth - ${width}) <= 2`), '测试窗口未切换至 ' + width + 'px');
      const activities = await evaluate(`(() => {
        document.documentElement.dataset.theme = '${theme}';
        return [...document.querySelectorAll('.activity-entry')].map(row => {
          const name = row.querySelector('.activity-title').getBoundingClientRect();
          const time = row.querySelector('time').getBoundingClientRect();
          return { color: getComputedStyle(row).borderInlineStartColor,
            fits: name.right <= time.left && time.width > 0 && time.right <= row.getBoundingClientRect().right &&
              row.getBoundingClientRect().right <= innerWidth };
        });
      })()`);
      assert.ok(activities.every((row) => row.fits), width + 'px 工具标题不能遮挡时间或超出屏幕');
      assert.notEqual(activities[0].color, activities[1].color, theme + ' 主题的命令和文件应有不同强调色');
      const diff = await evaluate(`(() => {
        const scroll = document.querySelector('.file-diff-scroll');
        const added = scroll.querySelector('tr[data-kind="added"]');
        const removed = scroll.querySelector('tr[data-kind="removed"]');
        return { fits: scroll.scrollWidth <= scroll.clientWidth + 1 &&
          scroll.getBoundingClientRect().right <= innerWidth,
          wraps: added.nextElementSibling.offsetHeight > added.offsetHeight,
          colors: [added, removed].map(row => getComputedStyle(row).backgroundColor) };
      })()`);
      assert.ok(diff.fits && diff.wraps, width + 'px 下长行应自动换行且不撑宽差异视图');
      assert.notEqual(diff.colors[0], diff.colors[1], theme + ' 主题的新增与删除行应有不同底色');
    }
    window.setContentSize(1100, 800);
    await evaluate(previousTheme === null ? 'document.documentElement.removeAttribute("data-theme")' :
      'document.documentElement.dataset.theme = ' + JSON.stringify(previousTheme));

    const historyControlPositions = await evaluate(`(() => {
      const flow = window.__history;
      return [
        { itemsDeferred: false, itemsCursor: 'older-process' },
        { itemsDeferred: false, itemsError: '模拟过程读取失败' },
      ].map(fields => {
        const turn = { ...flow.makeTurn(15), ...fields };
        turn.items.splice(1, 0, { id: 'follow-up', type: 'userMessage', content: [{ type: 'text', text: '补充说明' }] });
        flow.setHistory([turn]);
        const section = document.querySelector('.turn');
        return { count: section.querySelectorAll('.turn-history').length,
          afterOpening: section.querySelector('.item.user').nextElementSibling === section.querySelector('.turn-history'),
          label: section.querySelector('.turn-history button').textContent };
      });
    })()`);
    assert.deepEqual(historyControlPositions, [
      { count: 1, afterOpening: true, label: '加载本回合更早的过程' },
      { count: 1, afterOpening: true, label: '重试读取过程' },
    ], '继续分页和失败重试共用首条提问下方的唯一入口');

    // 失败保留游标，随后一次点击可以继续完成同一次跳转。
    await evaluate(`(() => {
      const flow = window.__history;
      flow.setHistory([flow.makeTurn(10)], 'retry');
      flow.pages.set('retry', { turns: [flow.makeTurn(9)], nextCursor: null });
      document.getElementById('messages').scrollTop = 0;
      flow.updateScrollToBottom();
      flow.failOlder = true;
      document.getElementById('previousQuestion').click();
    })()`);
    await waitFor(() => evaluate("!document.getElementById('notice').hidden && document.getElementById('notice').textContent.includes('模拟历史读取失败')"));
    assert.equal(await evaluate('window.__history.state.olderCursor'), 'retry');
    assert.equal(await evaluate("document.getElementById('previousQuestion').disabled"), false);
    await evaluate("window.__history.failOlder = false; document.getElementById('previousQuestion').click()");
    await waitFor(() => atQuestion(9));

    // 双击不重复取页；A→B→A 重新建立历史容器后也不能写入旧响应。
    await evaluate(`(() => {
      const flow = window.__history;
      flow.setHistory([flow.makeTurn(10)], 'race');
      flow.pages.set('race', { turns: [flow.makeTurn(1)], nextCursor: null });
      document.getElementById('messages').scrollTop = 0;
      flow.updateScrollToBottom();
      flow.deferOlder = true;
      document.getElementById('previousQuestion').click();
      document.getElementById('previousQuestion').click();
    })()`);
    await waitFor(() => evaluate('!!window.__history.releaseOlder'));
    assert.equal(await evaluate("window.__history.turnsCalls.filter(call => call.cursor === 'race').length"), 1);
    assert.equal(await evaluate("document.getElementById('previousQuestion').disabled"), true);
    await evaluate(`(() => {
      const flow = window.__history;
      flow.setHistory([flow.makeTurn(4)], null, flow.other);
      flow.setHistory([flow.makeTurn(10)], null);
      flow.releaseOlder();
    })()`);
    await pause(100);
    assert.equal(await evaluate("window.__history.state.turns.has('turn-1')"), false, '旧历史请求不能污染重开的同一对话');
    assert.equal(await evaluate("document.getElementById('notice').hidden"), true);

    // 重复游标必须中止，避免自动跳转陷入无限分页。
    await evaluate(`(() => {
      const flow = window.__history;
      flow.setHistory([flow.makeTurn(10)], 'stuck');
      flow.pages.set('stuck', { turns: [], nextCursor: 'stuck' });
      document.getElementById('messages').scrollTop = 0;
      flow.updateScrollToBottom();
      document.getElementById('previousQuestion').click();
    })()`);
    await waitFor(() => evaluate("!document.getElementById('notice').hidden"));
    assert.equal(await evaluate("window.__history.turnsCalls.filter(call => call.cursor === 'stuck').length"), 1,
      '游标不推进时只能请求一次');
    assert.equal(await evaluate("document.getElementById('previousQuestion').disabled"), false);

    const screenshotDirectory = path.join(root, 'work', 'history-qa');
    fs.mkdirSync(screenshotDirectory, { recursive: true });
    for (const [width, name] of [[1100, 'desktop'], [390, 'mobile']]) {
      window.setContentSize(width, 800);
      await pause(100);
      await evaluate(`(() => {
        const flow = window.__history;
        flow.setHistory([flow.makeTurn(9), flow.makeTurn(10)], 'older-8');
        flow.scrollIntoReply(10);
      })()`);
      const layout = await evaluate(`(() => {
        const previous = document.getElementById('previousQuestion');
        const bottom = document.getElementById('scrollToBottom');
        const a = previous.getBoundingClientRect();
        const b = bottom.getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth > innerWidth,
          previousVisible: !previous.hidden && a.left >= 0 && a.right <= innerWidth && a.bottom <= innerHeight,
          bottomVisible: !bottom.hidden && b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight,
          overlap: a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top };
      })()`);
      assert.deepEqual(layout, { overflow: false, previousVisible: true, bottomVisible: true, overlap: false }, width + 'px 导航按钮布局');
      window.webContents.invalidate();
      await pause(100);
      fs.writeFileSync(path.join(screenshotDirectory, name + '.png'), (await window.webContents.capturePage()).toPNG());
    }
    await evaluate(`(() => {
      const box = document.getElementById('messages');
      box.scrollTop = box.scrollHeight;
      window.__history.updateScrollToBottom();
    })()`);
    assert.equal(await evaluate("document.getElementById('previousQuestion').hidden && document.getElementById('scrollToBottom').hidden"), true);
    console.log('长对话界面验证通过：摘要先显示、过程按需读取、压缩提示顺序、连续提问跳转、自动分页、失败重试、重复请求保护、切换隔离、桌面与手机布局');
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window.destroy();
    gateway.kill();
    app.exit(exitCode);
  }
}).catch((error) => { console.error(error); app.exit(1); });
