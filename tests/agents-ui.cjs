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
  throw new Error('等待子 agent 界面更新超时');
}

app.whenReady().then(async () => {
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const gateway = spawn(process.execPath, [path.join(root, 'src/server.mjs')], {
    cwd: root, env: { ...process.env, CODEX_GATEWAY_PORT: String(port), CODEX_CDP_PORT: '65535' },
    stdio: 'ignore', windowsHide: true,
  });
  const window = new BrowserWindow({ show: false, width: 1100, height: 1000,
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'agents-ui-' + process.pid } });
  let exitCode = 0;
  const evaluate = async (code) => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { console.error('界面脚本失败：' + code.slice(0, 120)); throw error; }
  };
  const errors = [];
  window.webContents.on('console-message', (event) => {
    if (/Uncaught|Failed to fetch dynamically imported/.test(event.message)) errors.push(event.message);
    if (event.level === 'error') console.error('网页错误：' + event.message);
  });
  const settled = () => waitFor(() => evaluate("import('/js/core.js').then(({state})=>!state.agentActivityLoading && !state.loadingSelected)"));
  try {
    await waitFor(async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
    await window.loadURL(origin);
    await evaluate(`(async () => {
      const id = '00000000-0000-4000-8000-000000000101';
      const other = '00000000-0000-4000-8000-000000000102';
      const modern = '00000000-0000-4000-8000-000000000103';
      const legacy = '00000000-0000-4000-8000-000000000104';
      const cwd = ${JSON.stringify(root)};
      const thread = { id, cwd, name: '目标与子任务进展', model: 'test-model', reasoningEffort: 'high', status: { type: 'idle' }, updatedAt: 1 };
      const second = { ...thread, id: other, name: '另一个对话' };
      const task = '检查进行中目标的显示与手机布局，确认已完成目标收起。';
      const turn = { id: 'parent-turn', status: 'completed', startedAt: Date.now() / 1000 - 30, items: [
        { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '完善子 agent 的派发、工作进展和完成结果显示。' }] },
        { id: 'modern-start', type: 'subAgentActivity', agentThreadId: modern, agentPath: '/root/界面检查', kind: 'started', model: 'test-model', reasoningEffort: 'high', startedAtMs: 15000 },
        { id: 'legacy-start', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: [legacy], agentsStates: { [legacy]: { status: 'running' } }, status: 'completed', prompt: '检查子任务查询接口和错误重试。' },
        { id: 'modern-followup', type: 'subAgentActivity', agentThreadId: modern, kind: 'interacted' },
        { id: 'legacy-followup', type: 'collabAgentToolCall', tool: 'sendInput', receiverThreadIds: [legacy], agentsStates: { [legacy]: { status: 'running' } }, status: 'completed', prompt: '补充验证空历史和暂时读取失败。' },
        { id: 'answer', type: 'agentMessage', text: '界面和接口检查已分别派发，可在子任务卡片查看进展。' },
      ] };
      const child = (childId, nickname, text) => ({
        thread: { ...thread, id: childId, agentNickname: nickname, status: { type: 'active' } },
        turn: { id: childId + '-turn', status: 'inProgress', startedAt: Date.now() / 1000 - 20, items: [
          { id: 'child-user', type: 'userMessage', content: [{ type: 'text', text: childId === modern ? task : '执行派发的检查任务' }] },
          { id: 'child-progress', type: 'agentMessage', text },
        ] }, activityError: null,
      });
      const fixture = window.__agentsTest = { id, other, modern, legacy, task, threads: [thread, second], turn,
        snapshots: { [modern]: child(modern, 'Juniper', '已确认目标收起逻辑，正在验证 320px 手机布局。'),
          [legacy]: child(legacy, '接口检查', '接口正常返回任务信息，正在覆盖错误重试。') },
        requests: [], fail: null, deferNext: null, release: null, historyReads: 0 };
      const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      window.fetch = async (input, options = {}) => {
        const url = new URL(input, location.href), method = options.method || 'GET';
        if (url.pathname === '/api/health') return json({ connected: true, workspace: cwd });
        if (url.pathname === '/api/theme') return json({ theme: document.documentElement.dataset.theme || 'dark' });
        if (url.pathname === '/api/models') return json({ models: [{ id: 'test-model', displayName: '测试模型', supportedReasoningEfforts: ['high'], defaultReasoningEffort: 'high' }], defaults: { model: 'test-model', effort: 'high' } });
        if (url.pathname === '/api/projects') return json({ projects: [] });
        if (url.pathname === '/api/unread') return json({ ids: [] });
        if (url.pathname === '/api/approvals') return json({ approvals: [], retries: [] });
        if (url.pathname === '/api/threads' && method === 'GET') return json({ threads: fixture.threads, nextCursor: null });
        const parts = url.pathname.split('/');
        if (parts[1] === 'api' && parts[2] === 'threads') {
          const selectedId = parts[3], action = parts.slice(4).join('/');
          if (action === 'permissions') return json({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' } });
          if (action === 'read') return json({ read: true });
          if (action === 'turns') {
            fixture.historyReads++;
            return json({ turns: selectedId === id ? [fixture.turn] : [], nextCursor: null });
          }
          if (action === 'agent-activity') {
            fixture.requests.push(selectedId);
            if (fixture.fail === selectedId) return json({ error: '模拟子任务暂时无法读取' }, 503);
            const snapshot = JSON.stringify(fixture.snapshots[selectedId]);
            if (fixture.deferNext === selectedId) {
              fixture.deferNext = null;
              return new Promise((resolve) => { fixture.release = () => resolve(new Response(snapshot, { headers: { 'Content-Type': 'application/json' } })); });
            }
            return new Response(snapshot, { headers: { 'Content-Type': 'application/json' } });
          }
          if (!action) return json({ thread: fixture.threads.find((entry) => entry.id === selectedId), goal: null,
            completedGoal: null, usage: null, goalSupported: true, compactions: [] });
        }
        throw new Error('未预期的测试接口：' + url.pathname);
      };
      const { loadModels } = await import('/js/settings.js');
      const { state, loadHealth } = await import('/js/core.js');
      const { selectThread } = await import('/js/sidebar.js');
      state.threads = fixture.threads;
      await loadModels(); await loadHealth(); await selectThread(id);
      window.agentCard = (id) => document.querySelector('.agent-card[data-agent-id="' + id + '"]');
    })()`);
    await settled();
    assert.equal(await evaluate("document.querySelectorAll('.agent-group').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('.agent-card').length"), 2, '两种子 agent 协议应在同一任务区显示');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.agent-name')].map((node)=>node.textContent)"), ['界面检查', '接口检查']);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.agent-status')].map((node)=>node.textContent)"), ['工作中', '工作中']);
    assert.equal(await evaluate("document.querySelectorAll('.activity-group').length"), 0, '子任务不能再退回通用工具折叠区');
    assert.equal(await evaluate("agentCard(__agentsTest.modern).open"), false);
    await evaluate("agentCard(__agentsTest.modern).querySelector('summary').click()");
    assert.equal(await evaluate("agentCard(__agentsTest.modern).open"), true);
    assert.equal(await evaluate("agentCard(__agentsTest.modern).querySelector('.agent-body > .agent-text').textContent"), await evaluate('__agentsTest.task'));
    assert.match(await evaluate("agentCard(__agentsTest.modern).querySelector('.agent-meta').textContent"), /Juniper/, '任务名应优先显示，昵称保留在展开信息');
    assert.match(await evaluate("agentCard(__agentsTest.modern).querySelector('.agent-output').textContent"), /正在验证 320px/);
    assert.deepEqual(await evaluate("[...agentCard(__agentsTest.modern).querySelectorAll('.agent-event-meta > span:first-child')].map((node)=>node.textContent)"), ['派发任务', '跟进任务']);
    assert.deepEqual(await evaluate("[...agentCard(__agentsTest.legacy).querySelectorAll('.agent-event-meta > span:first-child')].map((node)=>node.textContent)"), ['派发任务', '跟进任务']);
    assert.equal(await evaluate("agentCard(__agentsTest.modern).querySelector('.agent-events time').dateTime"), new Date(15000).toISOString());
    assert.equal(await evaluate("agentCard(__agentsTest.legacy).querySelector('.agent-body > .agent-text').textContent"), '检查子任务查询接口和错误重试。');
    assert.match(await evaluate("agentCard(__agentsTest.legacy).querySelector('.agent-events').textContent"), /补充验证空历史和暂时读取失败/);

    // 新协议可能不暴露派发正文，子回合也可能还没有首条消息；保留任务名和派发记录。
    await evaluate(`(async () => {
      const snapshot=__agentsTest.snapshots[__agentsTest.modern];
      __agentsTest.modernUser=snapshot.turn.items.find((item)=>item.type==='userMessage');
      snapshot.turn.items=snapshot.turn.items.filter((item)=>item.type!=='userMessage');
      snapshot.turn.items.at(-1).text='';
      await (await import('/js/conversation.js')).refreshAgentActivity();
    })()`);
    assert.equal(await evaluate("agentCard(__agentsTest.modern).querySelector('.agent-name').textContent"), '界面检查');
    assert.match(await evaluate("agentCard(__agentsTest.modern).querySelector('.agent-preview').textContent"), /正在同步任务进展/);
    assert.equal(await evaluate("agentCard(__agentsTest.modern).querySelector('.agent-body > .agent-text')===null"), true, '没有正文时不能伪造任务内容');
    assert.equal(await evaluate("agentCard(__agentsTest.modern).querySelectorAll('.agent-events li').length"), 2);

    const previousHistoryReads = await evaluate('__agentsTest.historyReads');
    await evaluate(`(async () => {
      const fixture=__agentsTest;
      fixture.snapshots[fixture.modern].turn.items.unshift(fixture.modernUser);
      fixture.snapshots[fixture.modern].turn.items.at(-1).text='手机布局检查通过，正在核对浅色主题。';
      const completed=fixture.snapshots[fixture.legacy];
      completed.thread.status={type:'idle'};completed.turn.status='completed';
      completed.turn.items.at(-1).text='接口与错误重试验证通过，共覆盖 6 个场景。';
      await (await import('/js/conversation.js')).loadSelected();
    })()`);
    await settled();
    assert.equal(await evaluate("import('/js/core.js').then(({state})=>state.selectedThread.status.type)"), 'idle');
    assert.ok(await evaluate('__agentsTest.historyReads') > previousHistoryReads, '主聊天空闲时仍应刷新子任务相关历史');
    assert.match(await evaluate("agentCard(__agentsTest.modern).querySelector('.agent-preview').textContent"), /正在核对浅色主题/);
    assert.equal(await evaluate("agentCard(__agentsTest.modern).open"), true, '刷新不能折叠用户展开的任务');
    assert.equal(await evaluate("agentCard(__agentsTest.legacy).querySelector('.agent-status').textContent"), '已完成');
    await evaluate("agentCard(__agentsTest.legacy).querySelector('summary').click()");
    assert.match(await evaluate("agentCard(__agentsTest.legacy).querySelector('.agent-body').textContent"), /完成结果.*接口与错误重试验证通过/s);

    await evaluate(`(async () => {
      __agentsTest.fail=__agentsTest.modern;
      await (await import('/js/conversation.js')).refreshAgentActivity();
    })()`);
    assert.match(await evaluate("agentCard(__agentsTest.modern).querySelector('.agent-error').textContent"), /稍后自动重试.*模拟子任务暂时无法读取/);
    assert.match(await evaluate("agentCard(__agentsTest.modern).querySelector('.agent-output').textContent"), /正在核对浅色主题/, '读取失败应保留最近一次成功进展');
    const failedReads = await evaluate('__agentsTest.requests.length');
    await evaluate("import('/js/conversation.js').then(({refreshAgentActivity})=>refreshAgentActivity())");
    assert.equal(await evaluate('__agentsTest.requests.length'), failedReads, '失败后应降低重试频率');
    await evaluate(`(async () => {
      __agentsTest.fail=null;
      __agentsTest.snapshots[__agentsTest.modern].activityError='历史尚未就绪';
      __agentsTest.savedTurn=__agentsTest.snapshots[__agentsTest.modern].turn;
      __agentsTest.snapshots[__agentsTest.modern].turn=null;
      (await import('/js/core.js')).state.agentActivity.get(__agentsTest.modern).checkedAt=0;
      await (await import('/js/conversation.js')).refreshAgentActivity();
    })()`);
    assert.match(await evaluate("agentCard(__agentsTest.modern).querySelector('.agent-error').textContent"), /历史尚未就绪/);
    assert.match(await evaluate("agentCard(__agentsTest.modern).querySelector('.agent-output').textContent"), /正在核对浅色主题/, '历史读取失败也要保留已知进展');
    await evaluate(`(async () => {
      __agentsTest.snapshots[__agentsTest.modern].activityError=null;
      __agentsTest.snapshots[__agentsTest.modern].turn=__agentsTest.savedTurn;
      __agentsTest.snapshots[__agentsTest.modern].turn.items.at(-1).text='已恢复同步，继续验证聊天切换。';
      (await import('/js/core.js')).state.agentActivity.get(__agentsTest.modern).checkedAt=0;
      await (await import('/js/conversation.js')).refreshAgentActivity();
    })()`);
    assert.equal(await evaluate("agentCard(__agentsTest.modern).querySelector('.agent-error')===null"), true);
    assert.match(await evaluate("agentCard(__agentsTest.modern).querySelector('.agent-output').textContent"), /已恢复同步/);
    assert.equal(await evaluate("agentCard(__agentsTest.modern).open"), true);

    // 故意把旧请求留在 A，经过 B 再回到 A，检验会话 ID 相同但缓存已更换的情况。
    await evaluate(`(async () => {
      await (await import('/js/conversation.js')).refreshAgentActivity();
      __agentsTest.snapshots[__agentsTest.modern].turn.items.at(-1).text='不应残留的旧响应';
      __agentsTest.deferNext=__agentsTest.modern;
      window.__pendingAgentRead=(await import('/js/conversation.js')).refreshAgentActivity();
    })()`);
    await waitFor(() => evaluate('!!__agentsTest.release'));
    await evaluate("import('/js/sidebar.js').then(({selectThread})=>selectThread(__agentsTest.other))");
    assert.equal(await evaluate("document.querySelectorAll('.agent-card').length"), 0, '切到其他聊天应清除旧子任务卡片');
    assert.equal(await evaluate("import('/js/core.js').then(({state})=>state.agentActivity.size)"), 0);
    await evaluate(`(async () => {
      __agentsTest.snapshots[__agentsTest.modern].turn.items.at(-1).text='切回聊天后获得的新进展';
      await (await import('/js/sidebar.js')).selectThread(__agentsTest.id);
    })()`);
    await settled();
    assert.match(await evaluate("agentCard(__agentsTest.modern).querySelector('.agent-output').textContent"), /切回聊天后获得的新进展/);
    await evaluate('(async()=>{__agentsTest.release();await window.__pendingAgentRead})()');
    assert.match(await evaluate("agentCard(__agentsTest.modern).querySelector('.agent-output').textContent"), /切回聊天后获得的新进展/);
    assert.equal(await evaluate("document.getElementById('messages').textContent.includes('不应残留的旧响应')"), false);
    assert.equal(await evaluate("import('/js/core.js').then(({state})=>state.agentActivityLoading)"), false);

    await evaluate(`(async () => {
      const snapshot=__agentsTest.snapshots[__agentsTest.modern];
      snapshot.turn.items.at(-1).text='深浅主题和手机布局验证通过。长文件路径也能完整换行：'+'layout_verification_'.repeat(6)+'.js';
      await (await import('/js/conversation.js')).refreshAgentActivity();
      agentCard(__agentsTest.modern).open=true;
      agentCard(__agentsTest.legacy).open=false;
      document.getElementById('messages').scrollTop=0;
      document.getElementById('notice').hidden=true;
      document.documentElement.dataset.theme='dark';
    })()`);
    const screenshots = path.join(root, 'Docs', '截图');
    fs.mkdirSync(screenshots, { recursive: true });
    await pause(150);
    fs.writeFileSync(path.join(screenshots, 'qa-agents.png'), (await window.capturePage()).toPNG());
    await evaluate("document.documentElement.dataset.theme='light'");
    await pause(100);
    fs.writeFileSync(path.join(screenshots, 'qa-agents-light.png'), (await window.capturePage()).toPNG());
    for (const width of [375, 320]) {
      window.setContentSize(width, 900);
      await pause(120);
      await evaluate("document.getElementById('messages').scrollTop=0");
      const layout = await evaluate(`(() => ({
        overflow:document.documentElement.scrollWidth>innerWidth,
        rects:[...document.querySelectorAll('.agent-group,.agent-card,.agent-card > summary,.agent-card[open] .agent-body')].map((node)=>{
          const rect=node.getBoundingClientRect();return {className:node.className,left:rect.left,right:rect.right,overflow:node.scrollWidth>node.clientWidth+1};
        }),
      }))()`);
      assert.equal(layout.overflow, false, width + 'px 手机页面不应横向溢出');
      for (const rect of layout.rects) {
        assert.ok(rect.left >= 0 && rect.right <= width, '手机任务卡片超出屏幕：' + JSON.stringify(rect));
        assert.equal(rect.overflow, false, '手机任务内容不应横向溢出：' + JSON.stringify(rect));
      }
      if (width === 375) {
        fs.writeFileSync(path.join(screenshots, 'qa-agents-mobile-light.png'), (await window.capturePage()).toPNG());
        await evaluate("document.documentElement.dataset.theme='dark'");
        await pause(100);
        fs.writeFileSync(path.join(screenshots, 'qa-agents-mobile.png'), (await window.capturePage()).toPNG());
      }
    }
    assert.deepEqual(errors, []);
    console.log('子 agent 界面验证通过：两种派发协议、任务与进展、完成结果、主聊天空闲刷新、展开保留、失败恢复、A→B→A 旧响应隔离、深浅主题与 320/375px 手机布局');
  } catch (error) { console.error(error); exitCode = 1; }
  finally { window.destroy(); gateway.kill(); app.exit(exitCode); }
}).catch((error) => { console.error(error); app.exit(1); });
