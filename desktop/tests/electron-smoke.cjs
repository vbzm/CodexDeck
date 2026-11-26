const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const root = path.resolve(__dirname, '../..');
const settings = {
  gatewayHost: '127.0.0.1', gatewayPort: 8787, cdpPort: 49397,
  workspace: 'C:\\Projects\\CodexDeck', startAllOnOpen: false, startAtLogin: false,
};
const state = {
  desktop: { state: 'ready', detail: 'Desktop 已运行，CDP 可连接' },
  gateway: { state: 'running', detail: '由启动器管理', connected: true, managed: true },
  busy: false, checkedAt: '21:00:00', settings, hasToken: false, canStartAtLogin: true,
  theme: 'light',
};
let saved = null;
let savedTheme = null;

for (const [channel, handler] of Object.entries({
  'launcher:snapshot': () => state,
  'launcher:logs': () => [{ time: '21:00:00', source: 'launcher', level: 'info', message: '控制台已启动' }],
  'launcher:refresh': () => state,
  'launcher:save-settings': (_event, input) => { saved = input; return state; },
  'launcher:set-theme': (_event, theme) => { savedTheme = theme; state.theme = theme; return theme; },
})) ipcMain.handle(channel, handler);

app.whenReady().then(async () => {
  let exitCode = 0;
  const window = new BrowserWindow({
    width: 820, height: 580, show: false,
    webPreferences: {
      preload: path.join(root, 'desktop/dist/preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  try {
    await window.loadFile(path.join(root, 'desktop/ui/index.html'));
    const result = await window.webContents.executeJavaScript(`({
      title: document.getElementById('heroTitle').textContent,
      logo: getComputedStyle(document.querySelector('.brand-mark')).backgroundImage,
      overflow: getComputedStyle(document.getElementById('overview')).overflowY,
      height: document.querySelector('.frame').getBoundingClientRect().height,
      workspace: document.getElementById('workspace').value,
      errors: document.getElementById('toast').hidden,
    })`);
    assert.equal(result.title, '服务已就绪');
    assert.match(result.logo, /codex-logo-dark\.png/);
    assert.equal(result.overflow, 'auto');
    assert.ok(result.height > 500 && result.height <= 580);
    assert.equal(result.workspace, settings.workspace);
    assert.equal(result.errors, true);

    await window.webContents.executeJavaScript(`
      document.querySelector('[data-view="settings"]').click();
      document.getElementById('gatewayPort').value = '8877';
      document.getElementById('settingsForm').requestSubmit();
    `);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(saved.settings.gatewayPort, 8877);
    assert.equal(saved.tokenMode, 'keep');

    const overviewVisible = await window.webContents.executeJavaScript(`new Promise((resolve) => {
      document.querySelector('[data-view="overview"]').click();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(
        !document.getElementById('overview').hidden && document.getElementById('settings').hidden
      )));
    })`);
    assert.equal(overviewVisible, true);
    await window.webContents.executeJavaScript("document.getElementById('themeButton').click()");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(savedTheme, 'dark');
    assert.equal(await window.webContents.executeJavaScript('document.documentElement.dataset.theme'), 'dark');
    state.theme = 'light';
    window.webContents.send('launcher:state', state);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await window.webContents.executeJavaScript('document.documentElement.dataset.theme'), 'light');
    const screenshot = await window.capturePage();
    const destination = process.env.CODEXDECK_DESKTOP_SCREENSHOT ||
      path.join(root, 'desktop/screenshots/qa-launcher.png');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, screenshot.toPNG());
    console.log('Electron 界面验证通过：图标、滚动、状态与设置交互；截图：' + destination);
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window.destroy();
    app.exit(exitCode);
  }
}).catch((error) => { console.error(error); app.exit(1); });
