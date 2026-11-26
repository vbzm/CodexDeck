const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const root = path.resolve(__dirname, '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitFor(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await check()) return; await pause(50); }
  throw new Error('等待目标界面更新超时');
}

app.whenReady().then(async () => {
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const gateway = spawn(process.execPath, [path.join(root, 'src/server.mjs')], {
    cwd: root, env: { ...process.env, CODEX_GATEWAY_PORT: String(port), CODEX_CDP_PORT: '65535' },
    stdio: 'ignore', windowsHide: true,
  });
  const window = new BrowserWindow({ show: false, width: 1100, height: 850,
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'goal-ui-' + process.pid } });
  let exitCode = 0;
  const evaluate = async (code) => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { console.error('界面脚本失败：' + code.slice(0,120)); throw error; }
  };
  const errors = [];
  window.webContents.on('console-message', (event) => {
    if (/Uncaught|Failed to fetch dynamically imported/.test(event.message)) errors.push(event.message);
    if (event.level === 'error') console.error('网页错误：' + event.message);
  });
  try {
    await waitFor(async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
    await window.loadURL(origin);
    await evaluate(`(async () => {
      const id = '00000000-0000-4000-8000-000000000001';
      const other = '00000000-0000-4000-8000-000000000002';
      const created = '00000000-0000-4000-8000-000000000003';
      const cwd = ${JSON.stringify(root)};
      const thread = { id, cwd, name: '目标与上下文压缩', model: 'test-model', reasoningEffort: 'high', status: { type: 'active' }, updatedAt: 1 };
      const second = { ...thread, id: other, name: '另一个对话', status: { type: 'idle' } };
      const turn = { id: 'turn', status: 'inProgress', startedAt: Date.now() / 1000 - 30, items: [
        { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '完成网页目标状态与上下文压缩显示' }] },
        { id: 'manual', type: 'contextCompaction', source: 'manual', completed: true },
        { id: 'auto', type: 'contextCompaction', completed: true },
        { id: 'current', type: 'contextCompaction', completed: false, startedAtMs: Date.now() },
        { id: 'answer', type: 'agentMessage', text: '目标状态正在同步，上下文压缩进度会在这里显示。' },
      ] };
      const goal = { threadId: id, objective: '完成网页的目标状态同步、暂停恢复，以及上下文压缩提示', status: 'paused', tokenBudget: 100000,
        tokensUsed: 12400, timeUsedSeconds: 90, updatedAt: Date.now() / 1000 };
      const fixture = window.__goalTest = { id, other, created, threads: [thread, second], turn, goal, completedGoal: null,
        calls: [], confirm: true, createCalls: 0, clearCalls: 0, failCreate: false, failChange: false, failClear: false, deferred: null, deferMetadata: false,
        deferGoal: false, deferredGoal: null };
      window.confirm = () => fixture.confirm;
      const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      window.fetch = async (input, options = {}) => {
        const url = new URL(input, location.href), method = options.method || 'GET';
        if (url.pathname === '/api/health') return json({ connected: true, workspace: cwd });
        if (url.pathname === '/api/theme') return json({ theme: document.documentElement.dataset.theme || 'dark' });
        if (url.pathname === '/api/models') return json({ models: [{ id: 'test-model', displayName: '测试模型', supportedReasoningEfforts: ['high'], defaultReasoningEffort: 'high' }], defaults: { model: 'test-model', effort: 'high' } });
        if (url.pathname === '/api/projects') return json({ projects: [] });
        if (url.pathname === '/api/unread') return json({ ids: [] });
        if (url.pathname === '/api/approvals') return json({ approvals: [], retries: [] });
        if (url.pathname === '/api/threads' && method === 'GET') return json({ threads: fixture.threads });
        if (url.pathname === '/api/threads' && method === 'POST') {
          fixture.createCalls++;
          const body = JSON.parse(options.body), createdThread = { ...second, id: created, name: '新目标对话' };
          fixture.threads.push(createdThread);
          if (fixture.failCreate) return json({ thread: createdThread, turnError: '模拟目标设置失败' }, 201);
          fixture.goal = { ...goal, threadId: created, objective: body.goal, status: 'active' };
          return json({ thread: createdThread, goal: fixture.goal }, 201);
        }
        const parts = url.pathname.split('/');
        const match = parts[1] === 'api' && parts[2] === 'threads' ? [null, parts[3], parts.slice(4).join('/')] : null;
        if (match) {
          const selected = fixture.threads.find((entry) => entry.id === match[1]), action = match[2];
          if (action === 'permissions') return json({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' } });
          if (action === 'read') return json({ read: true });
          if (action === 'turns') return json({ turns: match[1] === id ? [fixture.turn] : [], nextCursor: null });
          if (action === 'goal' && method === 'POST') {
            const body = JSON.parse(options.body);
            fixture.calls.push(body);
            if (fixture.failChange) return json({ error: '模拟目标更新失败' }, 503);
            fixture.goal = { ...goal, ...fixture.goal, threadId: match[1], ...body, status: body.status || 'active' };
            if (fixture.deferGoal) {
              fixture.deferGoal = false;
              return new Promise((resolve) => { fixture.deferredGoal = () => resolve(json({ goal: fixture.goal })); });
            }
            return json({ goal: fixture.goal });
          }
          if (action === 'goal/clear') {
            fixture.clearCalls++;
            if (fixture.failClear) return json({ error: '模拟目标清除失败' }, 503);
            fixture.goal = null; fixture.completedGoal = null; return json({ cleared: true });
          }
          if (action === 'interrupt') { fixture.goal.status = 'paused'; fixture.turn.status = 'interrupted'; selected.status = { type: 'idle' }; return json({ interrupted: true }); }
          if (!action) {
            const result = { thread: selected, goal: fixture.goal?.threadId === match[1] ? fixture.goal : null,
              completedGoal: fixture.completedGoal, usage: null, goalSupported: true, compactions: [] };
            if (fixture.deferMetadata) {
              fixture.deferMetadata = false;
              const snapshot = JSON.stringify(result);
              return new Promise((resolve) => { fixture.deferred = () => resolve(new Response(snapshot, { headers: { 'Content-Type': 'application/json' } })); });
            }
            return json(result);
          }
        }
        throw new Error('未预期的测试接口：' + url.pathname);
      };
      const { loadModels } = await import('/js/settings.js');
      const { state, loadHealth } = await import('/js/core.js');
      const { selectThread } = await import('/js/sidebar.js');
      state.threads = fixture.threads;
      await loadModels(); await loadHealth(); await selectThread(id);
    })()`);
    assert.equal(await evaluate("document.getElementById('goalStatus').textContent"), '已暂停的目标');
    assert.equal(await evaluate("document.getElementById('goalBar').hidden"), true, '暂停目标不应常驻输入区');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.compaction-label')].map(e => e.textContent)"),
      ['上下文已压缩', '上下文已自动压缩', '正在压缩上下文']);
    assert.equal(await evaluate("document.querySelectorAll('.activity-group').length"), 0);

    await evaluate("document.getElementById('goalTrigger').click()");
    assert.equal(await evaluate("document.getElementById('goalSave').textContent"), '保存并恢复');
    assert.equal(await evaluate("document.getElementById('goalDialogClear').hidden"), false);
    assert.equal(await evaluate("document.getElementById('goalObjective').value"), '完成网页的目标状态同步、暂停恢复，以及上下文压缩提示');
    await evaluate("document.getElementById('goalForm').requestSubmit()");
    await waitFor(() => evaluate("document.getElementById('goalStatus').textContent === '进行中的目标'"));
    assert.equal(await evaluate("document.getElementById('goalBar').hidden"), false);
    assert.equal(await evaluate("document.getElementById('goalDialogClear').hidden"), true, '进行中目标沿用目标栏的清除入口');
    await waitFor(() => evaluate("!document.getElementById('goalDialog').open"));
    await evaluate("document.getElementById('goalEdit').click();document.getElementById('goalObjective').value='编辑后的可衡量目标';document.getElementById('goalObjective').dispatchEvent(new Event('input'));document.getElementById('goalForm').requestSubmit()");
    await waitFor(() => evaluate("!document.getElementById('goalDialog').open && __goalTest.goal.objective === '编辑后的可衡量目标'"));

    await evaluate("__goalTest.failChange=true; document.getElementById('goalToggle').click()");
    await waitFor(() => evaluate("document.getElementById('notice').textContent.includes('模拟目标更新失败')"));
    assert.equal(await evaluate("document.getElementById('goalStatus').textContent"), '进行中的目标');
    await evaluate("__goalTest.failChange=false;document.getElementById('messageInput').value='/goal 新目标';document.getElementById('messageInput').dispatchEvent(new Event('input'))");
    assert.equal(await evaluate("document.getElementById('sendMessage').getAttribute('aria-label')"), '设置目标');
    await evaluate("__goalTest.deferGoal=true;document.getElementById('composer').requestSubmit()");
    await waitFor(() => evaluate('!!__goalTest.deferredGoal'));
    await evaluate("document.getElementById('messageInput').value='/goal 请求期间新输入的目标';document.getElementById('messageInput').dispatchEvent(new Event('input'));__goalTest.deferredGoal()");
    await waitFor(() => evaluate("!document.getElementById('goalTrigger').disabled"));
    assert.equal(await evaluate("document.getElementById('messageInput').value"), '/goal 请求期间新输入的目标', '设置目标不能清空请求期间新输入的文字');

    await evaluate("document.getElementById('messageInput').value='';document.getElementById('messageInput').dispatchEvent(new Event('input'));document.getElementById('sendMessage').click()");
    await waitFor(() => evaluate("document.getElementById('goalStatus').textContent === '已暂停的目标'"));
    assert.equal(await evaluate("document.getElementById('goalBar').hidden"), true);
    await evaluate(`(async () => {
      __goalTest.completedGoal={...__goalTest.goal,status:'complete'};__goalTest.goal=null;
      await (await import('/js/conversation.js')).loadSelected();
    })()`);
    assert.equal(await evaluate("document.getElementById('goalBar').hidden"), true, '完成快照不应占用输入区');
    await evaluate("document.getElementById('goalTrigger').click()");
    assert.equal(await evaluate("document.getElementById('goalObjective').value"), '', '新目标不能预填已完成目标');
    assert.equal(await evaluate("document.getElementById('goalDialogTitle').textContent"), '目标');
    assert.equal(await evaluate("document.getElementById('goalDialogClear').hidden"), true, '已完成目标不提供清除入口');
    await evaluate("document.getElementById('goalCancel').click()");
    await evaluate(`(async () => {
      __goalTest.goal={...__goalTest.completedGoal,status:'complete'};
      await (await import('/js/conversation.js')).loadSelected();
      document.getElementById('goalTrigger').click();
    })()`);
    assert.equal(await evaluate("document.getElementById('goalBar').hidden"), true, '直接读取到完成目标时也应收起');
    assert.equal(await evaluate("document.getElementById('goalObjective').value"), '');
    await evaluate("document.getElementById('goalCancel').click()");

    await evaluate(`(async () => {
      __goalTest.goal={threadId:__goalTest.id,objective:'暂停后待清除的目标',status:'paused'};__goalTest.completedGoal=null;
      await (await import('/js/conversation.js')).loadSelected();
      document.getElementById('goalTrigger').click();
    })()`);
    assert.equal(await evaluate("document.getElementById('goalDialogClear').hidden"), false);
    await evaluate("__goalTest.confirm=false;document.getElementById('goalDialogClear').click()");
    assert.equal(await evaluate("document.getElementById('goalDialog').open"), true, '取消清除时编辑框应保持打开');
    assert.equal(await evaluate('__goalTest.clearCalls'), 0, '取消确认不能发送清除请求');
    assert.equal(await evaluate('__goalTest.goal.objective'), '暂停后待清除的目标');
    await evaluate("__goalTest.confirm=true;__goalTest.failClear=true;document.getElementById('goalDialogClear').click()");
    await waitFor(() => evaluate("document.getElementById('goalDialogError').textContent.includes('模拟目标清除失败')"));
    assert.equal(await evaluate("document.getElementById('goalDialog').open"), true, '清除失败时应留在编辑框重试');
    assert.equal(await evaluate('__goalTest.goal.objective'), '暂停后待清除的目标');
    await evaluate("__goalTest.failClear=false;document.getElementById('goalDialogClear').click()");
    await waitFor(() => evaluate("!document.getElementById('goalDialog').open && __goalTest.goal===null"));
    assert.equal(await evaluate("import('/js/core.js').then(({state})=>state.goal===null)"), true, '清除成功后同步当前目标');
    assert.equal(await evaluate("document.getElementById('goalBar').hidden"), true);

    await evaluate(`(async () => {
      __goalTest.goal={threadId:__goalTest.id,objective:'旧目标',status:'paused'};
      await (await import('/js/conversation.js')).loadSelected();
      __goalTest.deferMetadata=true;
      window.__pendingGoalRead=(await import('/js/conversation.js')).loadSelected();
    })()`);
    await waitFor(() => evaluate('!!__goalTest.deferred'));
    await evaluate("document.getElementById('goalTrigger').click();document.getElementById('goalForm').requestSubmit()");
    await waitFor(() => evaluate("document.getElementById('goalStatus').textContent === '进行中的目标'"));
    await evaluate('(async()=>{__goalTest.deferred();await window.__pendingGoalRead})()');
    assert.equal(await evaluate("document.getElementById('goalStatus').textContent"), '进行中的目标', '旧请求不应覆盖操作结果');
    await waitFor(() => evaluate("!document.getElementById('goalDialog').open"));

    await evaluate("__goalTest.confirm=false;document.getElementById('goalClear').click()");
    assert.equal(await evaluate("document.getElementById('goalBar').hidden"), false);
    await evaluate("__goalTest.confirm=true;document.getElementById('goalClear').click()");
    await waitFor(() => evaluate("document.getElementById('goalBar').hidden"));

    await evaluate(`(async () => {
      const { selectThread, startNewThread }=await import('/js/sidebar.js');
      await selectThread(__goalTest.other);
      if(!document.getElementById('goalBar').hidden)throw Error('切换聊天残留旧目标');
      await startNewThread(${JSON.stringify(root)});
      __goalTest.failCreate=true;
      document.getElementById('goalTrigger').click();document.getElementById('goalObjective').value='新对话目标';
      document.getElementById('goalObjective').dispatchEvent(new Event('input'));document.getElementById('goalForm').requestSubmit();
    })()`);
    await waitFor(() => evaluate("document.getElementById('goalDialogError').textContent.includes('模拟目标设置失败')"));
    await evaluate("__goalTest.failCreate=false;document.getElementById('goalForm').requestSubmit()");
    await waitFor(() => evaluate("!document.getElementById('goalDialog').open && document.getElementById('goalObjectiveSummary').textContent === '新对话目标'"));
    assert.equal(await evaluate('__goalTest.createCalls'), 1, '重试目标不能重复创建聊天');

    await evaluate(`(async () => {
      __goalTest.goal={...__goalTest.goal,threadId:__goalTest.id,status:'active',tokenBudget:100000,tokensUsed:12400,objective:'完成网页目标状态同步、暂停与恢复、设置与编辑，以及上下文正在压缩和已经压缩的提示'};
      __goalTest.turn.status='inProgress';__goalTest.threads[0].status={type:'active'};
      __goalTest.turn.items.find(e=>e.id==='current').startedAtMs=Date.now()-11000;
      await (await import('/js/sidebar.js')).selectThread(__goalTest.id);
      document.documentElement.dataset.theme='dark';
    })()`);
    assert.match(await evaluate("document.querySelector('.compaction-label[data-status=\"inProgress\"]').textContent"), /可能需要几分钟/);
    const screenshots = path.join(root, 'Docs', '截图');
    await pause(150);
    fs.writeFileSync(path.join(screenshots, 'qa-goal-desktop.png'), (await window.capturePage()).toPNG());
    for (const width of [375, 320]) {
      window.setContentSize(width, 812);
      await pause(120);
      const layout = await evaluate(`(() => {
        const ids=['goalBar','goalClear','goalToggle','goalEdit','goalTrigger','sendMessage'];
        return {overflow:document.documentElement.scrollWidth>innerWidth,rects:ids.map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,left:r.left,right:r.right}})};
      })()`);
      assert.equal(layout.overflow, false, '手机页面不应横向溢出');
      for (const rect of layout.rects) assert.ok(rect.left >= 0 && rect.right <= width, '手机控件超出屏幕：' + JSON.stringify(rect));
      if (width === 375) fs.writeFileSync(path.join(screenshots, 'qa-goal-mobile.png'), (await window.capturePage()).toPNG());
    }
    assert.deepEqual(errors, []);
    console.log('目标界面验证通过：仅进行中目标常驻、编辑恢复、暂停目标清除确认与失败重试、停止、完成收起、旧响应竞态、压缩提示与 320/375px 手机布局');
  } catch (error) { console.error(error); exitCode = 1; }
  finally { window.destroy(); gateway.kill(); app.exit(exitCode); }
}).catch((error) => { console.error(error); app.exit(1); });
