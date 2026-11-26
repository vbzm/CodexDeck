const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, nativeImage } = require('electron');

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP deck.test 127.0.0.1');
app.commandLine.appendSwitch('no-proxy-server');
const root = path.resolve(__dirname, '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, message = '等待图片更新超时') {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(30);
  }
  throw new Error(message);
}

app.whenReady().then(async () => {
  const bitmap = Buffer.alloc(320 * 640 * 4, 255);
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    bitmap[offset] = 180;
    bitmap[offset + 1] = 140;
    bitmap[offset + 2] = 90;
  }
  const png = nativeImage.createFromBitmap(bitmap, { width: 320, height: 640 }).toPNG();
  const calls = [];
  const pending = new Map();
  const deferred = new Set();
  const failureNames = new Set(['missing', 'missing-markdown']);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://deck.test');
    if (url.pathname === '/api/images') {
      const name = url.searchParams.get('path');
      calls.push({ name, host: request.headers.host, authorization: request.headers.authorization });
      const send = () => {
        if (failureNames.has(name)) {
          response.writeHead(404, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: '图片文件不存在' }));
        } else {
          response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
          response.end(png);
        }
      };
      if (deferred.has(name)) pending.set(name, send);
      else send();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      response.setHeader('Content-Type', 'application/json');
      response.end('{}');
      return;
    }
    let file;
    let type;
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; base-uri 'none'" });
      response.end(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
        .replace('<script src="/js/app.js" type="module"></script>', ''));
      return;
    }
    if (url.pathname === '/vendor/markdown-it.min.js') {
      file = path.join(root, 'node_modules/markdown-it/dist/markdown-it.min.js');
      type = 'text/javascript';
    } else if (/^\/(?:js|css|assets)\/[\w.-]+$/.test(url.pathname) || url.pathname === '/style.css') {
      file = path.join(root, 'public', url.pathname.slice(1));
      type = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'image/png';
    }
    if (!file || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': type });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://deck.test:' + server.address().port;
  const window = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'images-ui-' + process.pid } });
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  let exitCode = 0;
  try {
    await window.loadURL(origin);
    await evaluate(`(async () => {
      sessionStorage.setItem('gatewayToken', 'ui-image-token');
      const { state } = await import('/js/core.js');
      const conversation = await import('/js/conversation.js');
      const thread = { id: '00000000-0000-4000-8000-000000000001', name: '图片消息验证',
        cwd: 'C:/Project', updatedAt: 1, status: { type: 'idle' } };
      const flow = window.__images = { state, ...conversation, thread,
        imageUrl: (name) => '/api/images?path=' + encodeURIComponent(name) + '&signature=fixture' };
      flow.setItems = (items) => {
        state.selectedId = thread.id;
        state.selectedThread = thread;
        state.turns = new Map([['turn-image', { id: 'turn-image', status: 'completed', startedAt: 1, completedAt: 2,
          items: [{ id: 'question', type: 'userMessage', content: [{ type: 'text', text: '请查看图片。' }] }, ...items] }]]);
        state.compactions = [];
        state.agentActivity = new Map();
        state.historyInitialized = true;
        state.historyLoading = false;
        state.initialHistory = true;
        state.olderCursor = null;
        flow.renderHeader();
        flow.renderMessages();
      };
      flow.longText = Array.from({ length: 50 }, (_, index) => '第 ' + index + ' 段：保留阅读位置的正文。').join('\\n\\n');
      flow.loaded = () => [...document.querySelectorAll('#messages img')].filter((image) => !image.hidden && image.complete && image.naturalWidth > 0).length;
      flow.gap = () => { const box = document.getElementById('messages'); return box.scrollHeight - box.scrollTop - box.clientHeight; };
      flow.setItems([
        { id: 'view', type: 'imageView', path: 'file:///C:/Project/view.png', imageUrl: flow.imageUrl('view') },
        { id: 'markdown', type: 'agentMessage', phase: 'final_answer', text: '本地图片：![空格图片](</C:/Project/output/image one.png>)',
          imageSources: { '/C:/Project/output/image%20one.png': flow.imageUrl('markdown') } },
      ]);
    })()`);
    await waitFor(() => evaluate('__images.loaded() === 2'), 'imageView 与本地 Markdown 图片应正常显示');
    assert.deepEqual(calls.map((call) => call.name).sort(), ['markdown', 'view']);
    assert.ok(calls.every((call) => call.host === new URL(origin).host), '图片应通过当前 FRP 地址的同源网关请求');
    assert.ok(calls.every((call) => call.authorization === 'Bearer ui-image-token'), '图片请求应携带访问令牌');
    assert.equal(await evaluate("[...document.querySelectorAll('#messages img')].some(image => /^(file:|[A-Z]:)/i.test(image.getAttribute('src') || ''))"), false,
      '远程浏览器不得直接请求本机路径');

    // 轮询时保持正在阅读的图片节点，不能让隐藏重建造成高度塌缩和错误跟随底部。
    const callsBeforePolling = calls.length;
    await evaluate(`(() => {
      const flow = __images;
      flow.state.selectedThread = { ...flow.thread, status: { type: 'active' } };
      flow.pollTurn = structuredClone(flow.state.turns.get('turn-image'));
      flow.pollTurn.status = 'inProgress';
      flow.pollTurn.completedAt = null;
      flow.pollTurn.itemsView = 'full';
      flow.pollTurn.itemsDeferred = false;
      flow.pollTurn.items.push({ id: 'poll-progress', type: 'agentMessage', phase: 'commentary',
        text: '继续检查图片后的工作。' });
      const fetch = window.fetch.bind(window);
      window.fetch = (input, options) => {
        const url = new URL(input, location.href);
        const json = body => Promise.resolve(new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json' } }));
        if (url.pathname === '/api/threads/' + flow.thread.id) return json({ thread: flow.state.selectedThread, compactions: [] });
        if (url.pathname.endsWith('/turns')) return json({ turns: [flow.pollTurn], nextCursor: null });
        if (url.pathname.endsWith('/questions')) return json({ requests: [] });
        return fetch(input, options);
      };
      flow.pollImages = [...document.querySelectorAll('#messages img')];
      const box = document.getElementById('messages');
      box.scrollTop += flow.pollImages[0].getBoundingClientRect().top - box.getBoundingClientRect().top + 200;
      flow.updateScrollToBottom();
      flow.pollImageTop = flow.pollImages[0].getBoundingClientRect().top;
      flow.pollImageScroll = box.scrollTop;
      flow.pollImageCheck = () => {
        const images = [...document.querySelectorAll('#messages img')];
        return { retained: images.every((image, index) => image === flow.pollImages[index]),
          visible: images.every(image => !image.hidden && image.complete && image.naturalWidth > 0),
          top: images[0].getBoundingClientRect().top,
          scroll: box.scrollTop, gap: flow.gap() };
      };
    })()`);
    const firstPoll = await evaluate(`(async () => {
      await __images.loadSelected();
      return __images.pollImageCheck();
    })()`);
    assert.equal(firstPoll.retained, true, '后台新增进度时应复用已加载的 imageView 与 Markdown 图片节点：' + JSON.stringify(firstPoll));
    assert.equal(firstPoll.visible, true, '图片不能在轮询后重新变为隐藏加载状态');
    assert.ok(Math.abs(firstPoll.top - await evaluate('__images.pollImageTop')) <= 2,
      '停在图片中部时，新增进度不能移动图片的可见位置：' + JSON.stringify(firstPoll));
    for (let poll = 0; poll < 4; poll++) {
      const result = await evaluate(`(async () => {
        if (${poll} > 1) __images.pollTurn.items.push({ id: 'poll-tool-' + ${poll}, type: 'commandExecution',
          command: 'Get-Date', status: 'inProgress', startedAtMs: 10000 + ${poll} });
        await __images.loadSelected();
        return __images.pollImageCheck();
      })()`);
      assert.equal(result.retained && result.visible, true, '不变轮询与新增工具都不能重建、隐藏已显示图片：' + JSON.stringify(result));
      assert.ok(Math.abs(result.top - await evaluate('__images.pollImageTop')) <= 2,
        '连续轮询必须保持图片阅读位置：' + JSON.stringify(result));
      assert.ok(result.gap > 100, '阅读图片时不得被强制拉到对话底部');
    }
    assert.equal(calls.length, callsBeforePolling, '轮询复用图片，不应重新下载相同图片');
    await evaluate(`(async () => {
      const box = document.getElementById('messages');
      box.scrollTop = box.scrollHeight;
      __images.pollTurn.items.push({ id: 'poll-final-progress', type: 'agentMessage', phase: 'commentary',
        text: __images.longText });
      await __images.loadSelected();
    })()`);
    const pollingBottom = await evaluate(`(() => {
      const box = document.getElementById('messages');
      return { gap: __images.gap(), scroll: box.scrollTop, height: box.scrollHeight, client: box.clientHeight,
        progressVisible: box.textContent.includes('第 49 段'), selected: __images.state.selectedThread.status.type };
    })()`);
    assert.ok(pollingBottom.gap <= 2, '用户停在底部时，轮询新增消息仍应跟随最新内容：' + JSON.stringify(pollingBottom));
    await evaluate(`(async () => {
      const flow = __images;
      flow.pollTurn.items.push({ id: 'poll-image-tail', type: 'agentMessage', phase: 'commentary', text: flow.longText });
      await flow.loadSelected();
      const box = document.getElementById('messages');
      const image = flow.pollImages[1];
      box.scrollTop += image.getBoundingClientRect().top - box.getBoundingClientRect().top + 200;
      flow.markdownImageTop = image.getBoundingClientRect().top;
      flow.pollTurn.items.find(item => item.id === 'markdown').text += '\\n\\n图片后补充一段新的说明，原图保持不变。';
      await flow.loadSelected();
    })()`);
    const changedMarkdown = await evaluate(`(() => {
      const images = [...document.querySelectorAll('#messages img')];
      return { retained: images[1] === __images.pollImages[1], visible: !images[1].hidden,
        top: images[1].getBoundingClientRect().top, before: __images.markdownImageTop,
        updated: document.getElementById('messages').textContent.includes('图片后补充一段新的说明') };
    })()`);
    assert.equal(changedMarkdown.retained && changedMarkdown.visible && changedMarkdown.updated, true,
      '同一 Markdown 回复追加文字时应更新正文并保留其中已加载图片：' + JSON.stringify(changedMarkdown));
    assert.ok(Math.abs(changedMarkdown.top - changedMarkdown.before) <= 2,
      '同一回复追加文字也应保持图片区域阅读位置：' + JSON.stringify(changedMarkdown));
    await evaluate(`(() => {
      const flow = __images;
      flow.setItems([{ id: 'tool-image', type: 'mcpToolCall', server: 'images', tool: 'view', arguments: {}, status: 'completed',
        result: { content: [{ type: 'image', mimeType: 'image/png', data: ${JSON.stringify(png.toString('base64'))} }, { type: 'text', text: '图片工具输出' }] } }]);
    })()`);
    assert.equal(await evaluate("document.querySelectorAll('#messages img').length"), 0, '折叠工具不得创建图片');
    await evaluate("document.querySelector('.activity-group').open = true");
    await waitFor(() => evaluate("!!document.querySelector('.activity-entry')"));
    assert.equal(await evaluate("document.querySelectorAll('#messages img').length"), 0, '仅展开工具分组仍不得创建图片');
    await evaluate("document.querySelector('.activity-entry').open = true");
    await waitFor(() => evaluate('__images.loaded() === 1'), '展开工具详情后应显示内联图片');
    assert.equal(await evaluate("document.querySelector('.activity-entry pre').textContent.includes('图片工具输出')"), true);
    await evaluate(`(() => {
      __images.openToolImage = document.querySelector('.activity-entry img');
      const turn = __images.state.turns.get('turn-image');
      turn.items.find(item => item.id === 'tool-image').status = 'inProgress';
      turn.items.push({ id: 'next-tool', type: 'commandExecution', command: 'Get-Date', status: 'inProgress' });
      __images.renderMessages();
    })()`);
    const changedTool = await evaluate(`(() => {
      const image = document.querySelector('.activity-entry img');
      return { retained: image === __images.openToolImage, visible: !!image && !image.hidden,
        groupOpen: document.querySelector('.activity-group').open, detailOpen: document.querySelector('.activity-entry').open };
    })()`);
    assert.deepEqual(changedTool, { retained: true, visible: true, groupOpen: true, detailOpen: true },
      '展开工具中的图片在状态或后续工具更新时也应保留节点与展开状态');

    await evaluate(`(() => {
      const flow = __images;
      flow.setItems([
        { id: 'missing', type: 'imageView', path: 'C:/Project/missing.png', imageUrl: flow.imageUrl('missing') },
        { id: 'missing-markdown', type: 'agentMessage', text: '![稍后恢复的图片](</C:/Project/missing-markdown.png>)',
          imageSources: { '/C:/Project/missing-markdown.png': flow.imageUrl('missing-markdown') } },
      ]);
      flow.failedTurns = flow.state.turns;
      flow.failedItems = [...flow.state.turns.get('turn-image').items];
    })()`);
    await waitFor(() => evaluate("[...document.querySelectorAll('.image-status')].filter(node => /图片.*(失败|不存在|无法)/.test(node.textContent)).length === 2"),
      '图片失败时应显示中文提示');
    failureNames.delete('missing');
    failureNames.delete('missing-markdown');
    await evaluate('__images.renderMessages()');
    await waitFor(() => evaluate('__images.loaded() === 2'), '原路径恢复后，刷新相同图片消息应能重新读取成功');
    assert.equal(await evaluate(`__images.state.turns === __images.failedTurns &&
      __images.state.turns.get('turn-image').items.every((item, index) => item === __images.failedItems[index])`), true,
      '图片失败恢复不得依赖替换聊天容器或消息对象');
    assert.equal(await evaluate("[...document.querySelectorAll('.image-status')].some(node => !node.hidden && /失败/.test(node.textContent))"), false,
      '相同 imageView 与 Markdown 图片恢复后应移除失败提示');

    deferred.add('bottom');
    await evaluate("__images.setItems([{ id: 'long', type: 'agentMessage', text: __images.longText }, { id: 'bottom', type: 'imageView', imageUrl: __images.imageUrl('bottom'), path: 'C:/Project/bottom.png' }])");
    await waitFor(() => Promise.resolve(pending.has('bottom')));
    assert.ok(await evaluate('__images.gap() <= 2'), '最新消息首次渲染后应位于底部');
    pending.get('bottom')();
    pending.delete('bottom');
    await waitFor(() => evaluate('__images.loaded() === 1 && __images.gap() <= 2'), '异步图片撑高后仍应保持底部');

    deferred.add('reading');
    await evaluate("__images.setItems([{ id: 'reading', type: 'imageView', imageUrl: __images.imageUrl('reading'), path: 'C:/Project/reading.png' }, { id: 'long-reading', type: 'agentMessage', text: __images.longText }])");
    await waitFor(() => Promise.resolve(pending.has('reading')));
    const before = await evaluate(`(() => {
      const box = document.getElementById('messages'); box.scrollTop = 400;
      __images.updateScrollToBottom();
      const anchor = [...box.querySelectorAll('p')].find((item) => item.getBoundingClientRect().top >= box.getBoundingClientRect().top);
      __images.readingAnchor = anchor;
      return { top: anchor.getBoundingClientRect().top, scroll: box.scrollTop,
        items: [...box.querySelectorAll('.item')].map(item => ({ id: item.dataset.itemId, top: item.getBoundingClientRect().top, bottom: item.getBoundingClientRect().bottom })) };
    })()`);
    pending.get('reading')();
    pending.delete('reading');
    await waitFor(() => evaluate('__images.loaded() === 1'));
    await pause(80);
    const after = await evaluate(`(() => {
      const box = document.getElementById('messages');
      return { top: __images.readingAnchor.getBoundingClientRect().top, scroll: box.scrollTop,
        items: [...box.querySelectorAll('.item')].map(item => ({ id: item.dataset.itemId, top: item.getBoundingClientRect().top, bottom: item.getBoundingClientRect().bottom })) };
    })()`);
    assert.ok(Math.abs(after.top - before.top) <= 2, '阅读历史时，图片异步加载不能挤走可见正文：' + JSON.stringify({ before, after }));

    deferred.add('inline-reading');
    await evaluate(`(() => {
      const flow = __images;
      flow.setItems([{ id: 'inline-reading', type: 'agentMessage', phase: 'final_answer',
        text: '![正文上方的图片](</C:/Project/inline.png>)\\n\\n' + flow.longText,
        imageSources: { '/C:/Project/inline.png': flow.imageUrl('inline-reading') } }]);
    })()`);
    await waitFor(() => Promise.resolve(pending.has('inline-reading')));
    const inlineBefore = await evaluate(`(() => {
      const box = document.getElementById('messages'); box.scrollTop = 400;
      const anchor = [...box.querySelectorAll('.item-body > p')].find((item) => item.getBoundingClientRect().top >= box.getBoundingClientRect().top);
      __images.inlineAnchor = anchor;
      return anchor.getBoundingClientRect().top;
    })()`);
    pending.get('inline-reading')();
    pending.delete('inline-reading');
    await waitFor(() => evaluate('__images.loaded() === 1'));
    await pause(80);
    const inlineAfter = await evaluate('__images.inlineAnchor.getBoundingClientRect().top');
    assert.ok(Math.abs(inlineAfter - inlineBefore) <= 2, '同一长回复内，图片展开不能挤走已在阅读的正文：' + JSON.stringify({ inlineBefore, inlineAfter }));

    const screenshots = path.join(root, 'work/images-qa');
    fs.mkdirSync(screenshots, { recursive: true });
    await evaluate("__images.setItems([{ id: 'view-mobile', type: 'imageView', imageUrl: __images.imageUrl('view-mobile'), path: 'C:/Project/view-mobile.png' }, { id: 'answer-mobile', type: 'agentMessage', phase: 'final_answer', text: '图片已通过网关加载。' }])");
    await waitFor(() => evaluate('__images.loaded() === 1'));
    await pause(80);
    fs.writeFileSync(path.join(screenshots, 'desktop.png'), (await window.webContents.capturePage()).toPNG());
    window.setContentSize(390, 844);
    await pause(250);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, '手机布局不能横向溢出');
    assert.equal(await evaluate("[...document.querySelectorAll('#messages img')].every(image => image.getBoundingClientRect().right <= document.getElementById('messages').getBoundingClientRect().right + 1)"), true,
      '手机图片不得溢出消息容器');
    fs.writeFileSync(path.join(screenshots, 'mobile.png'), (await window.webContents.capturePage()).toPNG());
    console.log('图片界面验证通过：FRP 同源与鉴权、本地路径、轮询复用与图片阅读位置、正文和工具图片更新、底部跟随、延迟加载、失败提示及手机布局');
  } catch (error) { console.error(error); exitCode = 1; }
  finally {
    for (const send of pending.values()) send();
    window.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    app.exit(exitCode);
  }
}).catch((error) => { console.error(error); app.exit(1); });
