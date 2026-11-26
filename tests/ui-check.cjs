const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const baseUrl = 'http://127.0.0.1:' + (process.env.CODEX_GATEWAY_PORT || 8787);
const screenshots = path.resolve(process.env.CODEXDECK_SCREENSHOTS || path.join(__dirname, '../Docs/截图'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(window, expression, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await pause(150);
  }
  throw new Error('页面加载超时：' + expression);
}

async function capture(window, name) {
  window.webContents.invalidate();
  await pause(120);
  const image = await window.webContents.capturePage();
  assert.ok(!image.isEmpty(), '截图为空：' + name);
  fs.mkdirSync(screenshots, { recursive: true });
  fs.writeFileSync(path.join(screenshots, name), image.toPNG());
}

async function run() {
  let stage = '页面加载';
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: { offscreen: true, partition: 'codexdeck-ui-check' },
  });
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') console.error('页面错误：' + details.message.slice(0, 240));
  });
  try {
    await window.loadURL(baseUrl);
    await waitFor(window, "!document.getElementById('settingsTrigger').disabled && document.querySelectorAll('#projectList .project-group').length > 0");

    stage = '基础布局';
    const base = await window.webContents.executeJavaScript(`(() => {
      const ids = ['activeToggle', 'projectToggle', 'recentToggle'];
      const headings = ids.map((id) => document.getElementById(id));
      return {
        order: headings.every((node, index) => index === 0 || headings[index - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING),
        noWorkspace: !document.getElementById('newCwd'),
        noHeaderStop: !document.getElementById('stopTurn'),
      };
    })()`);
    assert.deepEqual(base, { order: true, noWorkspace: true, noHeaderStop: true });

    stage = '折叠交互';
    const folded = await window.webContents.executeJavaScript(`(() => {
      for (const [buttonId, contentId] of [['activeToggle', 'activeContent'], ['projectToggle', 'projectContent'], ['recentToggle', 'recentContent']]) {
        const button = document.getElementById(buttonId);
        const content = document.getElementById(contentId);
        button.click();
        if (!content.hidden || button.getAttribute('aria-expanded') !== 'false') return false;
        button.click();
        if (content.hidden || button.getAttribute('aria-expanded') !== 'true') return false;
      }
      return true;
    })()`);
    assert.equal(folded, true, '侧边栏折叠状态不一致');

    stage = '思考滑块与上下文';
    const settings = await window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      const { renderSettings } = await import('/js/settings.js');
      document.getElementById('settingsTrigger').click();
      const popover = document.getElementById('settingsPopover');
      const slider = document.getElementById('effortSlider');
      const firstOpen = !popover.hidden && !slider.disabled;
      state.usage = { lastInputTokens: 145000, modelContextWindow: 258000 };
      renderSettings();
      const context = {
        percent: document.getElementById('contextPercent').textContent,
        usage: document.getElementById('contextUsage').textContent,
        ring: document.getElementById('contextRing').style.getPropertyValue('--context-percent'),
      };
      return { firstOpen, context };
    })()`);
    assert.equal(settings.firstOpen, true, '思考滑块未显示');
    assert.deepEqual(settings.context, {
      percent: '56% 已用',
      usage: '已用 145k 标记，共 258k',
      ring: '56%',
    });
    await pause(150);
    const popoverStable = await window.webContents.executeJavaScript(`(() => {
      const popover = document.getElementById('settingsPopover');
      const rect = popover.getBoundingClientRect();
      return { hidden: popover.hidden, display: getComputedStyle(popover).display,
        height: rect.height, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
    })()`);
    assert.ok(!popoverStable.hidden && popoverStable.display !== 'none' && popoverStable.height > 0 &&
      popoverStable.top >= 0 && popoverStable.bottom <= 800 &&
      popoverStable.left >= 0 && popoverStable.right <= 1280,
      '思考弹层打开后意外关闭');
    await capture(window, '新界面-思考滑块.png');

    stage = '模型菜单';
    const model = await window.webContents.executeJavaScript(`(async () => {
      document.getElementById('modelChoice').click();
      const menu = document.getElementById('modelMenu');
      const count = menu.querySelectorAll('.model-option').length;
      const choice = [...menu.querySelectorAll('.model-option')].find((button) => button.textContent.includes('6 Luna'));
      choice?.click();
      const slider = document.getElementById('effortSlider');
      slider.value = '0';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      const { state } = await import('/js/core.js');
      const { selectedTurnOptions } = await import('/js/settings.js');
      return { count, choice: state.selection.model, effort: state.selection.effort,
        menuClosed: menu.hidden, popoverOpen: !document.getElementById('settingsPopover').hidden,
        label: document.getElementById('modelLabel').textContent, options: selectedTurnOptions() };
    })()`);
    assert.ok(model.count >= 2, '模型菜单为空');
    assert.deepEqual({ choice: model.choice, effort: model.effort, menuClosed: model.menuClosed,
      popoverOpen: model.popoverOpen, label: model.label, options: {
        model: model.options.model, effort: model.options.effort } },
    { choice: 'gpt-6-luna', effort: 'low', menuClosed: true, popoverOpen: true,
      label: '6 Luna', options: { model: 'gpt-6-luna', effort: 'low' } });
    stage = '权限菜单';
    const permissionMenu = await window.webContents.executeJavaScript(`(() => {
      document.getElementById('settingsPopover').hidden = true;
      document.getElementById('permissionTrigger').click();
      const popover = document.getElementById('permissionPopover');
      const rect = popover.getBoundingClientRect();
      const options = [...popover.querySelectorAll('.permission-option')];
      return { labels: options.map((option) => option.querySelector('strong').textContent),
        bounded: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 };
    })()`);
    assert.deepEqual(permissionMenu, { labels: ['请求批准', '帮我批准', '完全访问权限'], bounded: true });
    await capture(window, '新界面-权限选择.png');
    const permissions = await window.webContents.executeJavaScript(`(async () => {
      const { selectedTurnOptions } = await import('/js/settings.js');
      const popover = document.getElementById('permissionPopover');
      [...popover.querySelectorAll('.permission-option')]
        .find((option) => option.dataset.permissionMode === 'full').click();
      document.getElementById('settingsTrigger').click();
      return {
        selected: selectedTurnOptions().permissionMode,
        closed: popover.hidden && document.getElementById('permissionTrigger').getAttribute('aria-expanded') === 'false' };
    })()`);
    assert.deepEqual(permissions, { selected: 'full', closed: true });
    const menuVisible = await window.webContents.executeJavaScript(`(() => {
      document.getElementById('modelChoice').click();
      const menu = document.getElementById('modelMenu');
      return !menu.hidden && getComputedStyle(menu).display !== 'none' && menu.getBoundingClientRect().height > 0;
    })()`);
    assert.equal(menuVisible, true, '切换模型后无法再次打开模型菜单');
    await capture(window, '新界面-模型菜单.png');
    await window.webContents.executeJavaScript("document.documentElement.dataset.theme = 'dark'");
    const scrollbars = await window.webContents.executeJavaScript(`(() => {
      return [document.querySelector('.sidebar-scroll'), document.getElementById('messages')]
        .map((element) => {
          const style = getComputedStyle(element, '::-webkit-scrollbar-thumb');
          return { radius: style.borderRadius, color: style.backgroundColor };
        });
    })()`);
    assert.ok(scrollbars.every((bar) => bar.radius === '999px' && bar.color !== 'rgba(0, 0, 0, 0)'),
      '深色滚动条未使用圆角样式');
    await capture(window, '新界面-深色模型菜单.png');
    await window.webContents.executeJavaScript(`(() => {
      document.documentElement.dataset.theme = 'light';
      document.getElementById('settingsPopover').hidden = true;
    })()`);

    stage = '上下文悬停提示';
    const contextPoint = await window.webContents.executeJavaScript(`(() => {
      const rect = document.getElementById('contextButton').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...contextPoint });
    await pause(120);
    const contextTooltip = await window.webContents.executeJavaScript(`(() => {
      const tooltip = document.querySelector('.context-tooltip');
      return { display: getComputedStyle(tooltip).display, text: tooltip.textContent };
    })()`);
    assert.equal(contextTooltip.display, 'flex', '上下文悬停提示未显示');
    assert.ok(contextTooltip.text.includes('56% 已用') && contextTooltip.text.includes('145k'), '上下文提示内容不正确');
    await capture(window, '新界面-上下文悬停.png');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 800, y: 300 });

    stage = '打开新建项目';
    const projectOpen = await window.webContents.executeJavaScript("document.getElementById('newProject').click(); document.getElementById('projectDialog').open");
    assert.equal(projectOpen, true, '新建项目窗口未打开');
    stage = '打开电脑目录';
    const directoryOpen = await window.webContents.executeJavaScript("document.getElementById('browseProject').click(); document.getElementById('directoryDialog').open");
    assert.equal(directoryOpen, true, '电脑目录窗口未打开');
    stage = '电脑目录窗口';
    await waitFor(window, "document.querySelectorAll('#directoryList .directory-entry').length > 0");
    const drives = await window.webContents.executeJavaScript("[...document.querySelectorAll('#directoryList .directory-entry')].map(button => button.title)");
    assert.ok(drives.some((drive) => /^[A-Z]:\\$/i.test(drive)), '未列出电脑磁盘');
    await capture(window, '新界面-电脑目录.png');
    const chosen = await window.webContents.executeJavaScript(`(() => {
      const drive = document.querySelector('#directoryList .directory-entry');
      const selectedPath = drive.title;
      drive.click();
      return selectedPath;
    })()`);
    await waitFor(window, "document.getElementById('directoryCurrent').textContent !== '正在读取…'");
    const selected = await window.webContents.executeJavaScript(`(() => {
      document.getElementById('directorySelect').click();
      const value = document.getElementById('projectPath').value;
      document.getElementById('cancelProject').click();
      return value;
    })()`);
    assert.equal(selected, chosen, '所选电脑目录未填入项目表单');

    stage = '发送停止与未读点';
    const stopAndUnread = await window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      const { updateComposerAction } = await import('/js/conversation.js');
      const { renderThreadList } = await import('/js/sidebar.js');
      const old = { id: state.selectedId, thread: state.selectedThread, threads: state.threads, unread: state.unread };
      const id = '00000000-0000-4000-8000-000000000001';
      state.selectedId = id;
      state.selectedThread = { id, name: '测试进行中', status: { type: 'active' }, cwd: 'D:' };
      updateComposerAction();
      const stop = document.getElementById('sendMessage').getAttribute('aria-label') === '停止当前回合';
      state.selectedThread = { id, name: '测试未读', status: { type: 'idle' }, cwd: 'D:' };
      state.threads = [state.selectedThread];
      state.unread = new Set([id]);
      renderThreadList();
      const unread = !!document.querySelector('#threadList .unread-dot');
      state.selectedThread.status = { type: 'active' };
      state.threads = [state.selectedThread];
      renderThreadList();
      const spinner = !!document.querySelector('#activeList .running-spinner');
      state.selectedId = old.id;
      state.selectedThread = old.thread;
      state.threads = old.threads;
      state.unread = old.unread;
      renderThreadList();
      updateComposerAction();
      return { stop, unread, spinner };
    })()`);
    assert.deepEqual(stopAndUnread, { stop: true, unread: true, spinner: true });

    stage = '新建默认目录草稿';
    const draft = await window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      document.getElementById('recentNewThread').click();
      return { id: state.selectedId, cwd: state.selectedThread?.cwd, workspace: state.workspace };
    })()`);
    assert.ok(draft.id?.startsWith('draft-') && draft.cwd === draft.workspace,
      '最近区域未在默认工作目录新建草稿');

    stage = '侧边栏宽度边界';
    const width = await window.webContents.executeJavaScript(`(() => {
      const resizer = document.getElementById('sidebarResizer');
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      const max = document.getElementById('sidebar').getBoundingClientRect().width;
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      const min = document.getElementById('sidebar').getBoundingClientRect().width;
      return { min, max };
    })()`);
    assert.deepEqual(width, { min: 220, max: 420 }, '侧边栏最小或最大宽度错误');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 220, y: 300 });
    window.webContents.sendInputEvent({ type: 'mouseDown', x: 220, y: 300, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 350, y: 300 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: 350, y: 300, button: 'left', clickCount: 1 });
    const draggedWidth = await window.webContents.executeJavaScript("document.getElementById('sidebar').getBoundingClientRect().width");
    assert.ok(Math.abs(draggedWidth - 350) <= 1, '侧边栏拖拽未改变宽度');

    const spacingThreadId = process.env.CODEXDECK_SPACING_THREAD_ID;
    if (spacingThreadId) {
      stage = '回复与执行事件间距';
      await window.webContents.executeJavaScript(`(async () => {
        const { selectThread } = await import('/js/sidebar.js');
        await selectThread(${JSON.stringify(spacingThreadId)});
      })()`);
      await waitFor(window, "document.querySelectorAll('#messages .item.assistant + .activity-group').length > 0");
      const gaps = await window.webContents.executeJavaScript(`(() => {
        return [...document.querySelectorAll('#messages .item.assistant + .activity-group')].map((activity) => {
          const answer = activity.previousElementSibling.getBoundingClientRect();
          const event = activity.getBoundingClientRect();
          const next = activity.nextElementSibling?.classList.contains('assistant') ?
            activity.nextElementSibling.getBoundingClientRect() : null;
          return { before: event.top - answer.bottom, after: next && next.top - event.bottom };
        });
      })()`);
      assert.ok(gaps.length > 0 && gaps.every((gap) => gap.before >= 0 && gap.before <= 22 &&
        (gap.after === null || gap.after >= 0 && gap.after <= 22)),
      '回复与执行事件之间仍有过大空白：' + JSON.stringify(gaps));
      await capture(window, '新界面-消息事件间距.png');
    }

    stage = '手机侧栏';
    window.setContentSize(390, 844);
    await pause(150);
    const mobile = await window.webContents.executeJavaScript(`(() => {
      const menu = document.getElementById('menuButton');
      const visible = getComputedStyle(menu).display !== 'none';
      menu.click();
      return { visible, sidebarOpen: document.getElementById('sidebar').classList.contains('open'),
        backdrop: !document.getElementById('sidebarBackdrop').hidden,
        width: document.documentElement.clientWidth };
    })()`);
    assert.equal(mobile.visible && mobile.sidebarOpen && mobile.backdrop, true, '手机侧边栏未正确打开');
    assert.ok(mobile.width <= 700, '窄屏断点未生效');
    await pause(240);
    const sidebarBounds = await window.webContents.executeJavaScript(`(() => {
      const rect = document.getElementById('sidebar').getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: document.documentElement.clientWidth };
    })()`);
    assert.ok(sidebarBounds.left >= -1 && sidebarBounds.right <= sidebarBounds.width,
      '手机侧栏展开后超出屏幕');
    await capture(window, '新界面-手机侧栏.png');
    const mobileComposer = await window.webContents.executeJavaScript(`(async () => {
      const { state } = await import('/js/core.js');
      const { updateComposerAction } = await import('/js/conversation.js');
      document.getElementById('sidebarBackdrop').click();
      const rect = document.getElementById('composer').getBoundingClientRect();
      const button = document.getElementById('sendMessage').getBoundingClientRect();
      const icon = document.querySelector('#sendMessage svg').getBoundingClientRect();
      const oldThread = state.selectedThread;
      state.selectedThread = { status: { type: 'active' } };
      updateComposerAction();
      const stopIcon = document.querySelector('#sendMessage svg').getBoundingClientRect();
      state.selectedThread = oldThread;
      updateComposerAction();
      return { closed: !document.getElementById('sidebar').classList.contains('open'),
        left: rect.left, right: rect.right, scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        fontSize: getComputedStyle(document.getElementById('messageInput')).fontSize,
        iconOffset: Math.abs((button.left + button.right) / 2 - (icon.left + icon.right) / 2),
        stopOffset: Math.abs((button.left + button.right) / 2 - (stopIcon.left + stopIcon.right) / 2) };
    })()`);
    assert.ok(mobileComposer.closed && mobileComposer.left >= 0 &&
      mobileComposer.right <= mobileComposer.clientWidth &&
      mobileComposer.scrollWidth <= mobileComposer.clientWidth, '手机输入区溢出或侧栏无法关闭');
    assert.equal(mobileComposer.fontSize, '16px', '手机输入框字号可能触发 Safari 自动放大');
    assert.ok(mobileComposer.iconOffset <= .5 && mobileComposer.stopOffset <= .5,
      '手机发送或停止图标未居中');
    stage = '手机权限菜单';
    const mobilePermissions = await window.webContents.executeJavaScript(`(() => {
      document.getElementById('permissionTrigger').click();
      const rect = document.getElementById('permissionPopover').getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, width: document.documentElement.clientWidth };
    })()`);
    assert.ok(mobilePermissions.left >= 0 && mobilePermissions.right <= mobilePermissions.width &&
      mobilePermissions.top >= 0, '手机权限菜单超出屏幕');
    await capture(window, '新界面-手机权限菜单.png');
    await window.webContents.executeJavaScript("document.getElementById('permissionTrigger').click()");

    const longThreadId = process.env.CODEXDECK_LONG_THREAD_ID;
    if (longThreadId) {
      stage = '长会话与滚动按钮';
      window.setContentSize(1280, 800);
      const longThread = await window.webContents.executeJavaScript(`(async () => {
        const { selectThread } = await import('/js/sidebar.js');
        const { state } = await import('/js/core.js');
        await selectThread(${JSON.stringify(longThreadId)});
        return { turns: state.turns.size, older: !!state.olderCursor,
          copies: document.querySelectorAll('.message-copy').length,
          times: [...document.querySelectorAll('.message-meta .item-time')].map((node) => node.textContent) };
      })()`);
      assert.ok(longThread.turns > 0 && longThread.older && longThread.copies > 0 &&
        longThread.times.some((time) => /^(?:约 )?\d{2}:\d{2}:\d{2}$/.test(time)), '长会话或回复时间未加载');
      const answerPoint = await window.webContents.executeJavaScript(`(() => {
        const card = [...document.querySelectorAll('.item.assistant')].at(-1);
        const rect = card.getBoundingClientRect();
        return { x: Math.round(rect.left + 20), y: Math.round(rect.bottom - 12) };
      })()`);
      window.webContents.sendInputEvent({ type: 'mouseMove', ...answerPoint });
      await pause(180);
      const footerOpacity = await window.webContents.executeJavaScript(`(() => {
        const footer = [...document.querySelectorAll('.message-footer')].at(-1);
        return Number(getComputedStyle(footer).opacity);
      })()`);
      assert.ok(footerOpacity > .9, '回复复制按钮未在悬停时显示');
      await capture(window, '长会话-最后回复.png');
      const scrollState = await window.webContents.executeJavaScript(`(async () => {
        const { state, elements } = await import('/js/core.js');
        const { renderHeader, updateScrollToBottom } = await import('/js/conversation.js');
        elements.messages.scrollTop = 0;
        updateScrollToBottom();
        const idle = !elements.scrollToBottom.hidden && elements.scrollToBottom.dataset.mode === 'idle';
        const previous = state.selectedThread.status;
        state.selectedThread.status = { type: 'active' };
        renderHeader();
        const running = !elements.scrollToBottom.hidden && elements.scrollToBottom.dataset.mode === 'running' &&
          elements.scrollToBottom.querySelectorAll('.typing-dot').length === 3;
        state.selectedThread.status = previous;
        renderHeader();
        return { idle, running };
      })()`);
      assert.deepEqual(scrollState, { idle: true, running: true }, '滚动按钮状态错误');
      await capture(window, '长会话-滚动按钮.png');
    }
    console.log(JSON.stringify({ passed: true, models: model.count - 1, drives: drives.length,
      mobileWidth: mobile.width, screenshots: (longThreadId ? 10 : 8) + (spacingThreadId ? 1 : 0) }));
  } catch (error) {
    throw new Error(stage + '：' + error.message);
  } finally {
    window.destroy();
  }
}

app.whenReady().then(run).then(() => app.quit()).catch((error) => {
  console.error('UI 验证失败：' + error.message);
  app.exit(1);
});
