const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '../..');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('网关页面加载超时');
}

app.whenReady().then(async () => {
  const { createWebviewSetupScript } = await import('../utils/webview-layout.js');
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const gateway = spawn(process.execPath, [path.join(root, 'src/server.mjs')], {
    cwd: root,
    env: { ...process.env, CODEX_GATEWAY_PORT: String(port), CODEX_CDP_PORT: '65535' },
    stdio: 'ignore', windowsHide: true
  });
  const window = new BrowserWindow({
    width: 390, height: 844, show: false,
    webPreferences: { offscreen: true, partition: `codexdeck-layout-${Date.now()}` }
  });
  window.webContents.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1');
  let exitCode = 0;
  try {
    await waitFor(async () => {
      try { return (await fetch(origin)).ok; } catch { return false; }
    });
    await window.loadURL(origin);
    const measure = () => window.webContents.executeJavaScript(`(() => ({
      headerTop: document.querySelector('.conversation-head').getBoundingClientRect().top,
      headerBottom: document.querySelector('.conversation-head').getBoundingClientRect().bottom,
      composerBottom: document.querySelector('.composer').getBoundingClientRect().bottom,
      viewportBottom: innerHeight,
      sidebarPaddingTop: getComputedStyle(document.querySelector('.sidebar')).paddingTop
    }))()`);
    const before = await measure();
    await window.webContents.executeJavaScript(createWebviewSetupScript(47));
    const after = await measure();
    assert.ok(after.headerTop >= before.headerTop + 46, '标题栏必须避开状态栏');
    const headerReduction = Math.round((before.headerBottom - before.headerTop) -
      (after.headerBottom - after.headerTop));
    assert.ok(headerReduction >= 8 && headerReduction <= 10,
      'App 标题栏应只收紧约 8px');
    assert.ok(Math.abs(after.composerBottom - before.composerBottom) <= 1,
      '顶部调整不能改变输入框底部位置');
    assert.ok(Math.abs(after.composerBottom - after.viewportBottom) <= 1,
      '输入框必须保持贴合视口底部');
    assert.equal(after.sidebarPaddingTop, '47px');

    const keyboard = await window.webContents.executeJavaScript(`(async () => {
      const box = document.getElementById('messages');
      const input = document.getElementById('messageInput');
      box.replaceChildren();
      const history = document.createElement('div');
      history.style.height = '5000px';
      box.append(history);
      box.scrollTop = box.scrollHeight;
      input.disabled = false;
      const focus = input.focus.bind(input);
      const focusOptions = [];
      input.focus = (options) => { focusOptions.push(options); focus(options); };
      const tap = () => {
        const event = new Event('touchend', { cancelable: true, bubbles: true });
        Object.defineProperty(event, 'changedTouches', { value: [{}] });
        Object.defineProperty(event, 'touches', { value: [] });
        input.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const openingPrevented = tap();
      let height = visualViewport.height;
      Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => height });
      const read = () => ({
        headerTop: document.querySelector('.conversation-head').getBoundingClientRect().top,
        composerBottom: document.querySelector('.composer').getBoundingClientRect().bottom,
        inputBottom: input.getBoundingClientRect().bottom,
        gap: box.scrollHeight - box.scrollTop - box.clientHeight,
        scroll: box.scrollTop, pageScroll: scrollY,
        documentHeight: document.documentElement.scrollHeight,
        rootHeight: document.documentElement.getBoundingClientRect().height,
        layoutHeight: innerHeight,
        focused: document.activeElement === input
      });
      const resize = (value) => {
        height = value;
        visualViewport.dispatchEvent(new Event('resize'));
        return read();
      };
      // 重放真机记录的动画高度；这里只检查布局，不模拟 WebKit 原生键盘。
      const sequence = [813, 587, 480, 844, 480, 844].map(resize);
      const reopeningPrevented = tap();
      resize(480);
      const editingPrevented = tap();
      box.scrollTop = 1800;
      const readingBefore = box.scrollTop;
      const readingAfter = resize(480).scroll;
      // 制造真实的外层页面滚动，验证滚动恢复，而非只伪造 offsetTop 后检查坐标。
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'visible';
      document.body.style.height = '932px';
      window.scrollTo(0, 452);
      const forcedScroll = scrollY;
      await new Promise((resolve) => setTimeout(resolve, 100));
      const restored = read();
      document.documentElement.style.removeProperty('overflow');
      document.body.style.removeProperty('overflow');
      document.body.style.removeProperty('height');
      resize(844);
      return { sequence, readingBefore, readingAfter, forcedScroll, restored,
        openingPrevented, reopeningPrevented, editingPrevented, focusOptions };
    })()`);
    for (const [index, height] of [813, 587, 480, 844, 480, 844].entries()) {
      const sample = keyboard.sequence[index];
      assert.equal(Math.round(sample.headerTop), 47, '标题必须始终留在安全区下方');
      assert.ok(Math.abs(sample.composerBottom - height) <= 1, '输入区必须跟随可见高度');
      assert.ok(sample.inputBottom <= height, '输入框不能落到键盘区域');
      assert.ok(sample.gap <= 1, '原本位于底部的消息必须继续贴底');
      assert.equal(sample.pageScroll, 0);
      assert.equal(sample.rootHeight, height, '外层布局必须按可见高度收缩');
      assert.ok(sample.documentHeight <= Math.max(height, sample.layoutHeight), '布局不能产生额外的外层滚动范围');
      assert.equal(sample.focused, true, '调整布局不能改变焦点');
    }
    assert.equal(keyboard.readingAfter, keyboard.readingBefore, '阅读历史时不能强制跳到底部');
    assert.equal(keyboard.openingPrevented, true, '唤起键盘时应接管会滚动整页的默认聚焦');
    assert.equal(keyboard.reopeningPrevented, true, '已聚焦但键盘关闭时也应避免默认滚动');
    assert.equal(keyboard.editingPrevented, false, '键盘打开后应保留原生光标定位和文字选择');
    assert.deepEqual(keyboard.focusOptions, [{ preventScroll: true }, { preventScroll: true }]);
    assert.ok(keyboard.forcedScroll > 0, '验证必须实际产生外层页面滚动');
    assert.equal(keyboard.restored.pageScroll, 0, '系统遗留的整页滚动必须恢复');
    assert.equal(Math.round(keyboard.restored.headerTop), 47);
    console.log('手机布局验证通过：安全区、可见高度、消息贴底、历史阅读、真实页面滚动恢复');
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window.destroy();
    gateway.kill();
    app.exit(exitCode);
  }
}).catch((error) => { console.error(error); app.exit(1); });
